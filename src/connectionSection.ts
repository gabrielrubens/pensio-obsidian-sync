import {
    ButtonComponent, ConfirmationModal, ExtraButtonComponent, Setting, SettingDefinition, SettingDefinitionItem, setIcon,
} from 'obsidian';
import PensioPlugin from './main';
import { explainFailure, Explanation, NOTICE_MS, notify, notifyFailure } from './notices';
import { CARD_SEARCH_ALIASES, CardAction, cardSearchName, cardView, CardView, ConnectionState } from './statusCard';
import { isThrottled, quotaSummaryLine } from './sync/quotaNotice';

const BRAND = 'Pensio – AI Journaling';
const DOCS_URL = 'https://pensio.app/features/obsidian-sync/';
const ISSUES_URL = 'https://github.com/gabrielrubens/pensio-obsidian-sync/issues';
/** ⛔ Pensio's help pages quote this label in every state: keep it whole. */
const CONNECT = 'Connect to Pensio';
/** How long a pressed Connect waits for the browser: a setup code's life. */
const WAIT_FOR_BROWSER_MS = 5 * 60 * 1000;
const TONES = ['ok', 'warn', 'off', 'pending'] as const;

/**
 * The connection, as setting definitions (Obsidian 1.13's declarative
 * settings API), laid out as design "B · Status card" (plugin 0.7.0):
 *
 * - the status card at the top: the plugin's name and version, whether this
 *   vault is syncing, and the one button that state needs;
 * - the setup code right under it, while there is no working connection;
 * - an Account group at the end of the tab, once connected: the analysis
 *   quota, Open Pensio, Manage devices, Connect again, and Disconnect, which
 *   asks first;
 * - Test connection, which the tab puts under Advanced beside the tokens.
 *
 * ⭐ Every state but a verified connection shows the way to connect:
 * Connect to Pensio (one click and an approval in the browser,
 * src/auth/oneClick.ts), and the typed setup code beneath it for an install
 * whose browser cannot hand back to Obsidian. A connected vault can connect
 * again too: the email that warns a connection is ending asks for exactly that.
 *
 * ⭐ Saved tokens that were never checked are checked by the card itself, once
 * per set of tokens, so nobody has to find Test connection to learn whether
 * they work.
 *
 * ⭐ The state is read when the definitions are built, and a change of state
 * calls `redraw`, the tab's `update()`. A sync that ends while the tab is
 * open only repaints the card in place: redrawing the tab would take the
 * cursor out of a folder field mid-word. ⛔ Nothing here fetches while the
 * definitions are built (Obsidian builds them again for search indexing), so
 * the quota and the token check run in `render`.
 */
export class ConnectionSection {
    /** The saved tokens are being checked now. */
    private checking = false;
    /** The refresh token the card last checked, so it checks each set once. */
    private checkedFor: string | null = null;
    private checkProblem: Explanation | null = null;
    /** Connect to Pensio was pressed: when, and for which tokens. */
    private waitingSince: number | null = null;
    private waitingFor: string | null = null;
    private syncing = false;

    constructor(private readonly plugin: PensioPlugin, private readonly redraw: () => void) {}

    private apiUrl(): string {
        return (this.plugin.settings.apiUrl || 'https://pensio.app').replace(/\/+$/, '');
    }

    state(): ConnectionState {
        const hasBothTokens = this.plugin.getAccessToken() && this.plugin.getRefreshToken();
        if (!hasBothTokens) return 'disconnected';
        // Session dead (server-confirmed) — reconnect without data loss
        if (this.plugin.apiClient.isAuthInvalidated()) return 'reconnect';
        return this.plugin.accountGuard.getAccount() ? 'connected' : 'unverified';
    }

    /** The status card, at the top of the tab. */
    cardDefinition(): SettingDefinition {
        const state = this.state();
        return {
            name: cardSearchName(state),
            aliases: CARD_SEARCH_ALIASES,
            render: (setting) => this.renderCard(setting, state),
        };
    }

    /** Under the card, while there is no working connection: the setup code. */
    pairingDefinitions(): SettingDefinitionItem[] {
        if (this.state() === 'connected') return [];
        return [{ type: 'group', items: [this.setupCodeDefinition()] }];
    }

    /** Connected only, at the end of the tab: the account and the way out. */
    accountDefinitions(): SettingDefinitionItem[] {
        if (this.state() !== 'connected') return [];
        const apiUrl = this.apiUrl();
        const items: SettingDefinition[] = [
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
                desc: 'Your journal on the web',
                action: () => { window.open(`${apiUrl}/dashboard/`); },
            },
            {
                name: 'Manage devices',
                desc: 'See or stop connected devices',
                action: () => { window.open(`${apiUrl}/tokens/`); },
            },
            {
                name: 'Connect again',
                desc: 'Renews this connection. Sync history stays.',
                aliases: ['renew', 'reconnect'],
                render: (setting) => { setting.addButton(button => this.connectButton(button, false)); },
            },
        ];
        // The browser may answer with a setup code instead of an approval.
        if (this.waitingForBrowser()) items.push(this.setupCodeDefinition());
        items.push({
            // Disconnect — stops this vault's connection on Pensio, not just here
            name: 'Disconnect',
            desc: 'Stops syncing here. Your notes stay.',
            render: (setting) => {
                setting.addButton(button => button
                    .setButtonText('Disconnect')
                    .setDestructive()
                    .onClick(() => this.confirmDisconnect()));
            },
        });
        return [{ type: 'group', heading: 'Account', items }];
    }

    // ------------------------------------------------------------------
    // The status card
    // ------------------------------------------------------------------

    private renderCard(setting: Setting, state: ConnectionState): () => void {
        setting.setClass('pensio-status-card');
        this.renderBrand(setting);
        const icon = setting.settingEl.createDiv({ cls: 'pensio-card-icon' });
        setting.settingEl.insertBefore(icon, setting.infoEl);

        if (state === 'unverified' && this.checkedFor !== this.plugin.getRefreshToken()) this.startCheck();

        const action = this.view(state).action;
        if (action) setting.addButton(button => this.actionButton(button, action));

        const paint = () => this.paintCard(setting, icon, this.view(state));
        paint();
        const stop = this.plugin.syncStatus?.onChange(() => {
            if (this.state() === state) paint();
            else this.redraw();
        });
        return () => stop?.();
    }

    private renderBrand(setting: Setting): void {
        const top = setting.settingEl.createDiv({ cls: 'pensio-card-top', prepend: true });
        top.createSpan({ text: '✦', cls: 'pensio-card-spark' });
        top.createSpan({ text: BRAND, cls: 'pensio-card-brand' });
        top.createSpan({ text: `v${this.plugin.manifest?.version ?? ''}`, cls: 'pensio-card-version' });
        top.createSpan({ text: 'Beta', cls: 'pensio-beta-badge' });
        top.createDiv({ cls: 'pensio-card-spacer' });
        new ExtraButtonComponent(top)
            .setIcon('book-open')
            .setTooltip('Documentation')
            .onClick(() => { window.open(DOCS_URL); });
        new ExtraButtonComponent(top)
            .setIcon('bug')
            .setTooltip('Report an issue')
            .onClick(() => { window.open(ISSUES_URL); });
    }

    private view(state: ConnectionState): CardView {
        return cardView({
            state,
            email: this.plugin.accountGuard.getAccount()?.email ?? null,
            tracked: this.plugin.syncEngine.getTrackedFileCount(),
            lastSync: this.plugin.syncEngine.getLastSyncTime(),
            problem: this.plugin.syncStatus?.getProblem() ?? null,
            checking: this.checking,
            checkProblem: this.checkProblem,
            now: Date.now(),
        });
    }

    private paintCard(setting: Setting, iconEl: HTMLElement, view: CardView): void {
        for (const tone of TONES) setting.settingEl.toggleClass(`pensio-tone-${tone}`, tone === view.tone);
        iconEl.empty();
        setIcon(iconEl, view.icon);
        iconEl.toggleClass('pensio-spin', view.tone === 'pending');
        setting.setName(view.title);
        const desc = setting.descEl;
        desc.empty();
        if (view.detail) desc.appendText(view.detail);
        if (view.signUp) {
            desc.appendText(`${view.detail ? ' ' : ''}No account? `);
            const signUp = desc.createEl('a', { text: 'Create one free', href: `${this.apiUrl()}/register/` });
            signUp.setAttr('target', '_blank');
        }
    }

    private actionButton(button: ButtonComponent, action: Exclude<CardAction, null>): void {
        switch (action) {
            case 'connect':
                this.connectButton(button, true);
                return;
            case 'check':
                button.setButtonText('Try again').onClick(() => {
                    this.checkedFor = null;
                    this.checkProblem = null;
                    this.redraw();
                });
                return;
            case 'sync':
                button
                    .setButtonText(this.syncing ? 'Syncing…' : 'Sync now')
                    .setDisabled(this.syncing)
                    .onClick(async () => {
                        this.syncing = true;
                        button.setButtonText('Syncing…').setDisabled(true);
                        try {
                            // Says how it ended itself; the card repaints from syncStatus.
                            await this.plugin.syncNow();
                        } finally {
                            this.syncing = false;
                            button.setButtonText('Sync now').setDisabled(false);
                        }
                    });
                return;
        }
    }

    /** Check saved tokens that were never checked, once per set of tokens. */
    private startCheck(): void {
        this.checkedFor = this.plugin.getRefreshToken();
        this.checking = true;
        this.checkProblem = null;
        void this.plugin.verifyAccountBeforeSync({
            reconnectOn401: true,
            onError: (error) => { this.checkProblem = explainFailure(error, this.plugin.failureContext()); },
        }).catch((error: unknown) => {
            this.checkProblem = explainFailure(error, this.plugin.failureContext());
        }).finally(() => {
            this.checking = false;
            this.redraw();
        });
    }

    // ------------------------------------------------------------------
    // Connecting
    // ------------------------------------------------------------------

    private waitingForBrowser(): boolean {
        return this.waitingSince !== null
            && Date.now() - this.waitingSince < WAIT_FOR_BROWSER_MS
            && this.waitingFor === this.plugin.getRefreshToken();
    }

    /** Connect to Pensio: one click, approved in the browser. */
    private connectButton(button: ButtonComponent, primary: boolean): void {
        button.setButtonText(this.waitingForBrowser() ? 'Waiting for your browser…' : CONNECT);
        if (primary) button.setCta();
        button.onClick(async () => {
            try {
                await this.plugin.startOneClickConnect();
                this.waitingSince = Date.now();
                this.waitingFor = this.plugin.getRefreshToken();
                this.redraw();
            } catch (error) {
                notifyFailure('Opening Pensio', error, this.plugin.failureContext());
                console.error('One-click connect could not start:', error);
            }
        });
    }

    /**
     * The typed setup code: the fallback for an install whose browser cannot
     * hand back to Obsidian (obsidian:// not registered). Ends, like one
     * click, in plugin.adoptConnection, which keeps sync state.
     */
    private setupCodeDefinition(): SettingDefinition {
        return {
            name: 'Setup code',
            aliases: ['pairing code', 'one-time code'],
            render: (setting) => this.renderSetupCode(setting),
        };
    }

    private renderSetupCode(setting: Setting): void {
        const desc = setting.descEl;
        desc.appendText('If the browser can’t return here, get one from ');
        const pairLink = desc.createEl('a', { text: 'Connect Obsidian', href: `${this.apiUrl()}/tokens/pair-obsidian/` });
        pairLink.setAttr('target', '_blank');
        desc.appendText('.');

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
                            notify('Type the setup code first. Connect Obsidian on the web gives you one.');
                            return;
                        }
                        try {
                            button.setDisabled(true);
                            button.setButtonText('Connecting…');

                            const deviceId = await this.plugin.ensureDeviceId();
                            const result = await this.plugin.apiClient.pair(
                                code, deviceId, this.plugin.deviceName(), this.plugin.getRefreshToken()
                            );
                            await this.plugin.adoptConnection(result);
                        } catch (error) {
                            notifyFailure('Connecting with the code', error, {
                                ...this.plugin.failureContext(),
                                whenRefused: 'A code works once, for 5 minutes. Get a new one from Connect Obsidian.',
                            });
                            console.error('Pairing failed:', error);
                            button.setDisabled(false);
                            button.setButtonText('Use code');
                        }
                    });
            });
    }

    // ------------------------------------------------------------------
    // The account
    // ------------------------------------------------------------------

    /** Disconnect stops the connection on Pensio too, so it asks first. */
    private confirmDisconnect(): void {
        new ConfirmationModal(this.plugin.app)
            .setTitle('Disconnect this vault?')
            .setContent('Pensio stops syncing it. Your notes, and your journal on Pensio, stay as they are.')
            .addButton(button => button
                .setButtonText('Disconnect')
                .setDestructive()
                .setCta()
                .onClick(async () => {
                    await this.plugin.logout();
                    this.redraw();
                }))
            .addCancelButton()
            .open();
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
                `${status.daily_limit} entries per day — Pro analyzes them all at once.`
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
     * Test connection, under Advanced beside the manual token fields it
     * checks. A 401 the refresh cannot cure turns the tab to Session expired.
     */
    testDefinition(): SettingDefinition {
        return {
            name: 'Test connection',
            desc: 'Checks the tokens and the account.',
            render: (setting) => {
                setting.addButton(button => {
                    button
                        .setButtonText('Test connection')
                        .onClick(async () => {
                            if (!this.plugin.getAccessToken() || !this.plugin.getRefreshToken()) {
                                notify('Paste both tokens first.');
                                return;
                            }
                            const context = this.plugin.failureContext();
                            let failure: unknown = null;
                            try {
                                button.setDisabled(true);
                                button.setButtonText('Testing…');

                                const verified = await this.plugin.verifyAccountBeforeSync({
                                    reconnectOn401: true,
                                    onError: (error) => { failure = error; },
                                });
                                if (!verified) {
                                    if (this.plugin.apiClient.isAuthInvalidated()) {
                                        // Dead tokens: the card says so and offers the way back.
                                        notify(
                                            'This connection has stopped. Press Connect to Pensio at the top of the settings.',
                                            NOTICE_MS.failure,
                                        );
                                        this.redraw();
                                        return;
                                    }
                                    notifyFailure('The connection test', failure ?? new Error('Could not check the account'), context);
                                    button.setButtonText('Failed');
                                    return;
                                }

                                const status = await this.plugin.apiClient.getSyncStatus();
                                const email = this.plugin.accountGuard.getAccount()?.email;
                                notify(`Connected${email ? ` as ${email}` : ''}. ${status.total_entries} entries on Pensio.`);
                                button.setButtonText('Connected ✓');

                                // Refresh to show the connected card
                                window.setTimeout(() => this.redraw(), 1500);
                            } catch (error) {
                                notifyFailure('The connection test', error, context);
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
