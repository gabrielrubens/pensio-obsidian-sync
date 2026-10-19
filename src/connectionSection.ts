import { Notice, Setting } from 'obsidian';
import { errorMessage } from './errors';
import PensioPlugin from './main';
import { isThrottled, quotaSummaryLine } from './sync/quotaNotice';

/**
 * The Connection section of the settings tab, in its four states.
 *
 * ⭐ Every state but a verified connection shows the way to connect: Connect
 * to Pensio (one click and an approval in the browser, src/auth/oneClick.ts),
 * and the typed setup code beneath it as the fallback for an install whose
 * browser cannot hand back to Obsidian.
 */
export class ConnectionSection {
    constructor(private readonly plugin: PensioPlugin, private readonly redraw: () => void) {}

    /**
     * Render the connection section with two distinct states:
     * - Disconnected: getting-started guide + token paste fields + test button
     * - Connected: account card with email, action buttons, token management
     */
    render(containerEl: HTMLElement): void {
        const apiUrl = (this.plugin.settings.apiUrl || 'https://pensio.app').replace(/\/+$/, '');
        const hasBothTokens = this.plugin.getAccessToken() && this.plugin.getRefreshToken();
        const account = this.plugin.accountGuard.getAccount();

        if (hasBothTokens && this.plugin.apiClient.isAuthInvalidated()) {
            // ── Session dead (server-confirmed) — reconnect without data loss ──
            this.renderReconnectState(containerEl, apiUrl);
        } else if (hasBothTokens && account) {
            // ── Connected state ──
            this.renderConnectedState(containerEl, apiUrl, account);
        } else if (hasBothTokens) {
            // ── Tokens present but not verified ──
            this.renderUnverifiedState(containerEl, apiUrl);
        } else {
            // ── Disconnected state ──
            this.renderDisconnectedState(containerEl, apiUrl);
        }
    }

    /**
     * Connected: show account info card with quick actions.
     */
    private renderConnectedState(containerEl: HTMLElement, apiUrl: string, account: { email: string }): void {
        // Account info card
        const card = containerEl.createDiv({ cls: 'pensio-account-card' });
        const statusRow = card.createDiv({ cls: 'pensio-account-status' });
        statusRow.createSpan({ text: '\u2713', cls: 'pensio-status-dot pensio-status-connected' });
        statusRow.createSpan({ text: `Connected as ${account.email}`, cls: 'pensio-account-email' });

        // Token expiry info
        const tokenManager = this.plugin.apiClient.getTokenManager();
        void tokenManager.getTokenExpiry().then(expiry => {
            if (expiry) {
                const timeUntilExpiry = expiry.getTime() - Date.now();
                const hoursUntilExpiry = Math.floor(timeUntilExpiry / (1000 * 60 * 60));
                const expiryText = hoursUntilExpiry > 0
                    ? `Token expires in ${hoursUntilExpiry}h \u2014 auto-refreshes`
                    : 'Token expired \u2014 will auto-refresh on next sync';
                card.createEl('p', { text: expiryText, cls: 'pensio-token-status' });
            }
        });

        // Emotion-analysis quota — the free tier analyzes a fixed number of
        // entries per day, so a freshly imported vault drains over weeks.
        // This is the durable answer to "why is nothing happening?"; the
        // once-a-day Notice is the prompt, this is the reference.
        //
        // Fetched fresh rather than read from the sync engine's cache: after
        // the initial import there is nothing left to push, so syncs stop
        // calling the bulk endpoint entirely and the cached reading would
        // stay frozen at import-day numbers for the whole drain.
        const quotaEl = containerEl.createDiv();
        void this.renderQuotaStatus(quotaEl, apiUrl);

        // Quick actions
        new Setting(containerEl)
            .setName('Open Pensio')
            .setDesc('View your journal, insights, and AI chat on the web')
            .addButton(button => button
                .setButtonText('Open web app')
                .onClick(() => {
                    window.open(`${apiUrl}/dashboard/`);
                }));

        new Setting(containerEl)
            .setName('Manage devices')
            .setDesc('Review or revoke connected devices and tokens')
            .addButton(button => button
                .setButtonText('Token page')
                .onClick(() => {
                    window.open(`${apiUrl}/tokens/`);
                }));

        // Disconnect — stops this vault's connection on Pensio, not just here
        new Setting(containerEl)
            .setName('Disconnect')
            .setDesc('Stop this vault\u2019s connection on Pensio and clear its tokens and sync state here. Your notes are not touched.')
            .addButton(button => button
                .setButtonText('Disconnect')
                .setWarning()
                .onClick(async () => {
                    button.setDisabled(true);
                    await this.plugin.logout();
                    this.redraw();
                }));
    }

    /**
     * Emotion-analysis quota line, plus an upgrade prompt when it is spent.
     *
     * Silent on failure: this is supplementary information, and a server that
     * is too old to report the quota (or briefly unreachable) should not put
     * an error in the middle of a working settings page.
     */
    private async renderQuotaStatus(containerEl: HTMLElement, apiUrl: string): Promise<void> {
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

        containerEl.createEl('p', { text: line, cls: 'pensio-token-status' });

        if (status && isThrottled(status)) {
            new Setting(containerEl)
                .setName('Analysis is rate-limited')
                .setDesc(
                    'Your notes are synced and safe. Free accounts analyze ' +
                    `${status.daily_limit} entries per day — Pro analyzes them all at once.`
                )
                .addButton(button => button
                    .setButtonText('Upgrade to Pro')
                    .setCta()
                    .onClick(() => {
                        window.open(`${apiUrl}/pricing/`);
                    }));
        }
    }

    /**
     * Tokens present but not yet verified — test them, or pair afresh.
     *
     * ⛔ This state used to offer only Test connection. Tokens that are dead
     * (revoked on the web, or simply stale) land here after a restart, and
     * with no setup-code field the only way out was clearing the token fields
     * under Advanced, which nobody finds. Every state but a verified
     * connection now shows the way to connect.
     */
    private renderUnverifiedState(containerEl: HTMLElement, apiUrl: string): void {
        const card = containerEl.createDiv({ cls: 'pensio-account-card' });
        const statusRow = card.createDiv({ cls: 'pensio-account-status' });
        statusRow.createSpan({ text: '\u25CB', cls: 'pensio-status-dot pensio-status-pending' });
        statusRow.createSpan({ text: 'Tokens entered \u2014 not yet verified', cls: 'pensio-account-email' });
        card.createEl('p', {
            text: 'Test them, or connect again below if they stopped working.',
            cls: 'pensio-token-status',
        });

        this.renderTestButton(containerEl);
        this.renderPairingSetting(containerEl, apiUrl);
    }

    /**
     * Session dead (server-confirmed): tokens are kept, nothing was deleted —
     * a new setup code reconnects without touching sync state.
     */
    private renderReconnectState(containerEl: HTMLElement, apiUrl: string): void {
        const card = containerEl.createDiv({ cls: 'pensio-account-card' });
        const statusRow = card.createDiv({ cls: 'pensio-account-status' });
        statusRow.createSpan({ text: '\u26A0', cls: 'pensio-status-dot pensio-status-pending' });
        statusRow.createSpan({ text: 'Session expired \u2014 reconnect to resume syncing', cls: 'pensio-account-email' });
        card.createEl('p', {
            text: 'Your notes and sync history are untouched. Press Connect to reconnect.',
            cls: 'pensio-token-status',
        });

        this.renderPairingSetting(containerEl, apiUrl);
    }

    /**
     * Disconnected: an account first, then one click.
     */
    private renderDisconnectedState(containerEl: HTMLElement, apiUrl: string): void {
        const gettingStarted = containerEl.createDiv({ cls: 'pensio-getting-started' });
        const steps = gettingStarted.createEl('p');
        steps.appendText('To connect this plugin you need a Pensio account. ');
        const signupLink = steps.createEl('a', {
            text: 'Create a free one',
            href: `${apiUrl}/register/`,
        });
        signupLink.setAttr('target', '_blank');
        steps.appendText(' if you don\u2019t have one, then press Connect.');

        this.renderPairingSetting(containerEl, apiUrl);
    }

    /**
     * The way to connect, in every state but a verified one: Connect to Pensio
     * (one click, approved in the browser), then the typed setup code as the
     * fallback. Both end in plugin.adoptConnection, which keeps sync state.
     */
    private renderPairingSetting(containerEl: HTMLElement, apiUrl: string): void {
        new Setting(containerEl)
            .setName('Connect to Pensio')
            .setDesc('Opens Pensio in your browser. Approve this vault there, and Obsidian is connected.')
            .addButton(button => {
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

        let code = '';
        const fallback = new Setting(containerEl)
            .setName('Setup code')
            .setDesc('')
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
        // The fallback names where a code comes from: an install whose browser
        // cannot open Obsidian again (obsidian:// not registered) never hears back.
        const desc = fallback.descEl;
        if (desc) {
            desc.appendText('If the browser cannot bring you back to Obsidian: a one-time code from ');
            const pairLink = desc.createEl('a', {
                text: 'Connect Obsidian',
                href: `${apiUrl}/tokens/pair-obsidian/`,
            });
            pairLink.setAttr('target', '_blank');
            desc.appendText(' \u2014 it expires in 5 minutes.');
        }
    }

    /**
     * Render the test connection button (shared between disconnected and unverified states).
     */
    renderTestButton(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName('Test connection')
            .setDesc('Verify your tokens and account identity')
            .addButton(button => {
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
    }
}
