import { Notice, Setting, SettingDefinition } from 'obsidian';
import { errorMessage } from './errors';
import PensioPlugin from './main';
import { isThrottled, quotaSummaryLine } from './sync/quotaNotice';

type ConnectionState = 'connected' | 'unverified' | 'reconnect' | 'disconnected';

/**
 * The Connection section of the settings tab, in its four states, as setting
 * definitions (Obsidian 1.13's declarative settings API).
 *
 * ⭐ Every state but a verified connection shows the way to connect: Connect
 * to Pensio (one click and an approval in the browser, src/auth/oneClick.ts),
 * and the typed setup code beneath it as the fallback for an install whose
 * browser cannot hand back to Obsidian.
 *
 * ⭐ The state is read when the definitions are built, and each state returns
 * only its own rows. A change of state — connected, disconnected, a 401 from
 * Test connection — calls `redraw`, the tab's `update()`, which builds the
 * definitions again and re-renders. ⛔ Nothing here fetches while the
 * definitions are built: Obsidian builds them once more for search indexing,
 * so the token expiry and the analysis quota are fetched in `render`.
 */
export class ConnectionSection {
    constructor(private readonly plugin: PensioPlugin, private readonly redraw: () => void) {}

    private apiUrl(): string {
        return (this.plugin.settings.apiUrl || 'https://pensio.app').replace(/\/+$/, '');
    }

    private state(): ConnectionState {
        const hasBothTokens = this.plugin.getAccessToken() && this.plugin.getRefreshToken();
        if (!hasBothTokens) return 'disconnected';
        // Session dead (server-confirmed) — reconnect without data loss
        if (this.plugin.apiClient.isAuthInvalidated()) return 'reconnect';
        return this.plugin.accountGuard.getAccount() ? 'connected' : 'unverified';
    }

    /** The rows of the Connection group, for the state the plugin is in now. */
    definitions(): SettingDefinition[] {
        const apiUrl = this.apiUrl();
        switch (this.state()) {
            case 'connected':
                return this.connectedDefinitions(apiUrl);
            case 'unverified':
                // ⛔ This state used to offer only Test connection. Tokens that
                // are dead (revoked on the web, or simply stale) land here after
                // a restart, and with no setup-code field the only way out was
                // clearing the token fields under Advanced, which nobody finds.
                return [
                    this.statusRow(
                        'Not yet verified',
                        'Tokens entered. Test them, or connect again below if they stopped working.',
                        '\u25CB',
                        'pending',
                    ),
                    this.testDefinition(),
                    ...this.pairingDefinitions(apiUrl),
                ];
            case 'reconnect':
                // Tokens are kept, nothing was deleted: connecting again
                // resumes without touching sync state.
                return [
                    this.statusRow(
                        'Session expired',
                        'Your notes and sync history are untouched. Press Connect to resume syncing.',
                        '\u26A0',
                        'pending',
                    ),
                    ...this.pairingDefinitions(apiUrl),
                ];
            case 'disconnected':
                return [this.accountNeededRow(apiUrl), ...this.pairingDefinitions(apiUrl)];
        }
    }

    /**
     * A status line at the top of the section: a coloured mark and what it
     * means. `then` adds to the row once it is drawn.
     */
    private statusRow(
        name: string, desc: string, mark: string, tone: 'connected' | 'pending',
        then?: (setting: Setting) => void,
    ): SettingDefinition {
        return {
            name,
            desc,
            searchable: false,
            render: (setting) => {
                setting.setClass('pensio-status-row');
                setting.nameEl.prepend(setting.nameEl.createSpan({
                    text: mark,
                    cls: `pensio-status-dot pensio-status-${tone}`,
                }));
                then?.(setting);
            },
        };
    }

    /** Disconnected: an account first, then one click. */
    private accountNeededRow(apiUrl: string): SettingDefinition {
        return {
            name: 'Pensio account',
            render: (setting) => {
                const desc = setting.descEl;
                desc.appendText('To connect this plugin you need a Pensio account. ');
                const signupLink = desc.createEl('a', { text: 'Create a free one', href: `${apiUrl}/register/` });
                signupLink.setAttr('target', '_blank');
                desc.appendText(' if you don\u2019t have one, then press Connect.');
            },
        };
    }

    /** Connected: who, until when, the analysis quota, and the way out. */
    private connectedDefinitions(apiUrl: string): SettingDefinition[] {
        const account = this.plugin.accountGuard.getAccount();
        return [
            this.statusRow(`Connected as ${account?.email ?? ''}`, '', '\u2713', 'connected', (setting) => {
                // Token expiry, fetched once the row is drawn
                void this.plugin.apiClient.getTokenManager().getTokenExpiry().then(expiry => {
                    if (!expiry) return;
                    const timeUntilExpiry = expiry.getTime() - Date.now();
                    const hoursUntilExpiry = Math.floor(timeUntilExpiry / (1000 * 60 * 60));
                    setting.setDesc(hoursUntilExpiry > 0
                        ? `Token expires in ${hoursUntilExpiry}h \u2014 auto-refreshes`
                        : 'Token expired \u2014 will auto-refresh on next sync');
                });
            }),
            {
                // Emotion-analysis quota — the free tier analyzes a fixed number
                // of entries per day, so a freshly imported vault drains over
                // weeks. This is the durable answer to "why is nothing
                // happening?"; the once-a-day Notice is the prompt, this is the
                // reference.
                name: 'Emotion analysis',
                render: (setting) => {
                    // Hidden until there is something to say: a server too old
                    // to report the quota, or briefly unreachable, shows nothing.
                    setting.settingEl.hide();
                    void this.renderQuotaStatus(setting, apiUrl);
                },
            },
            {
                name: 'Open Pensio',
                desc: 'View your journal, insights, and AI chat on the web',
                action: () => {
                    window.open(`${apiUrl}/dashboard/`);
                },
            },
            {
                name: 'Manage devices',
                desc: 'Review or revoke connected devices and tokens',
                action: () => {
                    window.open(`${apiUrl}/tokens/`);
                },
            },
            {
                // Disconnect — stops this vault's connection on Pensio, not just here
                name: 'Disconnect',
                desc: 'Stop this vault\u2019s connection on Pensio and clear its tokens and sync state here. Your notes are not touched.',
                render: (setting) => {
                    setting.addButton(button => button
                        .setButtonText('Disconnect')
                        .setDestructive()
                        .onClick(async () => {
                            button.setDisabled(true);
                            await this.plugin.logout();
                            this.redraw();
                        }));
                },
            },
        ];
    }

    /**
     * Emotion-analysis quota line, plus an upgrade prompt when it is spent.
     *
     * Fetched fresh rather than read from the sync engine's cache: after the
     * initial import there is nothing left to push, so syncs stop calling the
     * bulk endpoint entirely and the cached reading would stay frozen at
     * import-day numbers for the whole drain.
     *
     * Silent on failure: this is supplementary information, and a server that
     * is too old to report the quota (or briefly unreachable) should not put
     * an error in the middle of a working settings page.
     */
    private async renderQuotaStatus(setting: Setting, apiUrl: string): Promise<void> {
        let status = this.plugin.syncEngine.getLastProcessingStatus();
        try {
            const fresh = await this.plugin.apiClient.getSyncStatus();
            if (fresh.processing_status) {
                status = fresh.processing_status;
            }
        } catch {
            // Keep whatever the last sync reported, if anything.
        }

        const line = quotaSummaryLine(status);
        if (!line) return;

        if (status && isThrottled(status)) {
            setting.setName('Analysis is rate-limited');
            setting.setDesc(
                `${line} Your notes are synced and safe. Free accounts analyze ` +
                `${status.daily_limit} entries per day \u2014 Pro analyzes them all at once.`
            );
            setting.addButton(button => button
                .setButtonText('Upgrade to Pro')
                .setCta()
                .onClick(() => {
                    window.open(`${apiUrl}/pricing/`);
                }));
        } else {
            setting.setDesc(line);
        }
        setting.settingEl.show();
    }

    /**
     * The way to connect, in every state but a verified one: Connect to Pensio
     * (one click, approved in the browser), then the typed setup code as the
     * fallback. Both end in plugin.adoptConnection, which keeps sync state.
     */
    private pairingDefinitions(apiUrl: string): SettingDefinition[] {
        return [
            {
                name: 'Connect to Pensio',
                desc: 'Opens Pensio in your browser. Approve this vault there, and Obsidian is connected.',
                render: (setting) => {
                    setting.addButton(button => {
                        button
                            .setButtonText('Connect')
                            .setCta()
                            .onClick(async () => {
                                try {
                                    await this.plugin.startOneClickConnect();
                                    button.setButtonText('Waiting for your browser\u2026');
                                } catch (error) {
                                    new Notice(`Could not open Pensio: ${errorMessage(error)}`);
                                    console.error('One-click connect could not start:', error);
                                }
                            });
                    });
                },
            },
            {
                name: 'Setup code',
                aliases: ['pairing code', 'one-time code'],
                render: (setting) => this.renderSetupCode(setting, apiUrl),
            },
        ];
    }

    private renderSetupCode(setting: Setting, apiUrl: string): void {
        // The fallback names where a code comes from: an install whose browser
        // cannot open Obsidian again (obsidian:// not registered) never hears back.
        const desc = setting.descEl;
        desc.appendText('If the browser cannot bring you back to Obsidian: a one-time code from ');
        const pairLink = desc.createEl('a', { text: 'Connect Obsidian', href: `${apiUrl}/tokens/pair-obsidian/` });
        pairLink.setAttr('target', '_blank');
        desc.appendText(' \u2014 it expires in 5 minutes.');

        let code = '';
        setting
            .addText(text => {
                text
                    .setPlaceholder('XXXX-XXXX')
                    .onChange((value) => {
                        code = value.trim();
                    });
            })
            .addButton(button => {
                button
                    .setButtonText('Use code')
                    .onClick(async () => {
                        if (!code) {
                            new Notice('Enter the setup code from the Connect Obsidian page');
                            return;
                        }
                        try {
                            button.setDisabled(true);
                            button.setButtonText('Connecting...');

                            const deviceId = await this.plugin.ensureDeviceId();
                            const result = await this.plugin.apiClient.pair(
                                code, deviceId, this.plugin.deviceName(), this.plugin.getRefreshToken()
                            );
                            await this.plugin.adoptConnection(result);
                        } catch (error) {
                            new Notice(`Pairing failed: ${errorMessage(error)}`);
                            console.error('Pairing failed:', error);
                            button.setDisabled(false);
                            button.setButtonText('Use code');
                        }
                    });
            });
    }

    /**
     * Test connection — in the not-yet-verified state, and always under
     * Advanced, beside the manual token fields it checks.
     */
    testDefinition(): SettingDefinition {
        return {
            name: 'Test connection',
            desc: 'Verify your tokens and account identity',
            render: (setting) => {
                setting.addButton(button => {
                    button
                        .setButtonText('Test connection')
                        .setCta()
                        .onClick(async () => {
                            if (!this.plugin.getAccessToken() || !this.plugin.getRefreshToken()) {
                                new Notice('Please paste both tokens above first');
                                return;
                            }
                            try {
                                button.setDisabled(true);
                                button.setButtonText('Testing...');

                                const verified = await this.plugin.verifyAccountBeforeSync({ reconnectOn401: true });
                                if (!verified) {
                                    if (this.plugin.apiClient.isAuthInvalidated()) {
                                        // Dead tokens: the reconnect state says so
                                        // and offers the way back.
                                        new Notice('This connection has stopped \u2014 reconnect below');
                                        this.redraw();
                                        return;
                                    }
                                    new Notice('Connection failed: could not verify account');
                                    button.setButtonText('Failed');
                                    return;
                                }

                                const status = await this.plugin.apiClient.getSyncStatus();
                                const acct = this.plugin.accountGuard.getAccount();
                                const acctInfo = acct ? ` (${acct.email})` : '';
                                new Notice(`Connected${acctInfo}! ${status.total_entries} entries on server`);
                                button.setButtonText('Connected \u2713');

                                // Refresh to show connected state
                                window.setTimeout(() => this.redraw(), 1500);
                            } catch (error) {
                                new Notice(`Connection failed: ${errorMessage(error)}`);
                                button.setButtonText('Failed');
                                console.error('Connection test failed:', error);
                            } finally {
                                window.setTimeout(() => {
                                    button.setDisabled(false);
                                    button.setButtonText('Test connection');
                                }, 3000);
                            }
                        });
                });
            },
        };
    }
}
