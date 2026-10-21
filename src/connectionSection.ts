import {
    ButtonComponent, ConfirmationModal, ExtraButtonComponent, Setting, SettingDefinition, SettingDefinitionItem, setIcon,
} from 'obsidian';
import { serverUrl } from './apiUrl';
import PensioPlugin from './main';
import { NOTICE_MS, notify, notifyFailure } from './notices';
import { QuotaRow } from './quotaRow';
import { CARD_SEARCH_ALIASES, CardAction, cardSearchName, cardView, CardView, ConnectionState } from './statusCard';

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
 *   vault is syncing, and the button (or two) that state needs;
 * - the setup code right under it, while there is no working connection;
 * - an Account group at the end of the tab, once connected: the analysis
 *   quota, Open Pensio, Manage devices, Connect again, and Disconnect, which
 *   asks first;
 * - Test connection, which the tab puts under Advanced beside the tokens.
 *
 * ⭐ Every state but a verified connection shows the way to connect:
 * Connect to Pensio (one click and an approval in the browser,
 * src/auth/oneClick.ts), and the typed setup code beneath it for an install
 * whose browser cannot hand back to Obsidian.
 *
 * ⭐ Which account the tokens belong to is checked by one shared check,
 * `plugin.accountCheck` (src/accountCheck.ts). The card starts it for tokens
 * nobody has checked, and shows what it is doing; it never checks by itself.
 *
 * ⛔ OBSIDIAN REUSES A ROW ON A REDRAW (read from Obsidian 1.14.4 during the
 * 2026-10-20 review, and copied into src/__mocks__/obsidian.ts): it runs the
 * cleanup `render` returned, empties only the control area, and calls
 * `render` again on the SAME row. So anything a render adds elsewhere in the
 * row must go in its cleanup, or it piles up. In 0.7.0 the card's brand line
 * and icon did, one more of each per redraw (Gabriel's screenshots, review F1).
 *
 * ⭐ A sync that ends while the tab is open repaints the card in place:
 * redrawing the tab would take the cursor out of a folder field mid-word. A
 * change of connection state redraws the tab (settings.ts follows it), and so
 * does a change of the card's buttons. ⛔ Nothing here fetches while the
 * definitions are built (Obsidian builds them again for search indexing).
 */
export class ConnectionSection {
    /** Connect to Pensio was pressed: when, and for which tokens. */
    private waitingSince: number | null = null;
    private waitingFor: string | null = null;
    private syncing = false;
    /** What the card added outside the row's own parts, taken away on every redraw. */
    private cardParts: HTMLElement[] = [];
    /** The card's one subscription to the sync status. */
    private stopCard: (() => void) | null = null;
    /** Repaints the card drawn last, in place. */
    private repaintCard: (() => void) | null = null;
    private redrawQueued = false;
    /** A setup code being typed, kept across redraws (review F19). */
    private setupCode = '';
    private readonly quota: QuotaRow;

    constructor(private readonly plugin: PensioPlugin, private readonly redraw: () => void) {
        this.quota = new QuotaRow(plugin, () => this.queueRedraw());
    }

    private apiUrl(): string {
        return serverUrl(this.plugin.settings.apiUrl);
    }

    state(): ConnectionState {
        const hasBothTokens = this.plugin.getAccessToken() && this.plugin.getRefreshToken();
        if (!hasBothTokens) return 'disconnected';
        // Session dead (server-confirmed) — reconnect without data loss
        if (this.plugin.apiClient.isAuthInvalidated()) return 'reconnect';
        return this.plugin.accountGuard.getAccount() ? 'connected' : 'unverified';
    }

    /** One redraw for any number of changes in the same moment. */
    private queueRedraw(): void {
        if (this.redrawQueued) return;
        this.redrawQueued = true;
        queueMicrotask(() => {
            this.redrawQueued = false;
            this.redraw();
        });
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
            this.quota.definition(apiUrl),
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

    private renderCard(setting: Setting, builtFor: ConnectionState): () => void {
        // What a previous render of this row added: Obsidian keeps it (see above).
        this.dropCardParts();
        const state = this.state();
        // Definitions built for another state (the tab was closed when it
        // changed): draw what is true now, and let the tab catch up.
        if (state !== builtFor) this.queueRedraw();

        setting.setClass('pensio-status-card');
        const top = this.renderBrand(setting);
        const icon = setting.settingEl.createDiv({ cls: 'pensio-card-icon' });
        setting.settingEl.insertBefore(icon, setting.infoEl);
        this.cardParts = [top, icon];

        if (state === 'unverified' && this.plugin.accountCheck?.unchecked()) {
            void this.plugin.accountCheck.run();
        }
        if (state === 'connected') this.quota.refreshIfStale();

        const view = this.view(state);
        const drawn = view.actions.join();
        const buttons: { action: CardAction; button: ButtonComponent }[] = [];
        view.actions.forEach((action, index) => {
            setting.addButton(button => {
                buttons.push({ action, button });
                this.actionButton(button, action, index === 0);
            });
        });

        const paint = () => this.paintCard(setting, icon, this.view(state), buttons);
        paint();
        this.repaintCard = paint;
        this.stopCard?.();
        this.stopCard = this.plugin.syncStatus?.onChange(() => {
            // A new state is the tab's to redraw (settings.ts follows it).
            if (this.state() !== state) return;
            if (this.view(state).actions.join() !== drawn) this.queueRedraw();
            else paint();
        }) ?? null;

        return () => {
            this.stopCard?.();
            this.stopCard = null;
            this.repaintCard = null;
            this.dropCardParts();
        };
    }

    private dropCardParts(): void {
        for (const part of this.cardParts) part.detach();
        this.cardParts = [];
    }

    private renderBrand(setting: Setting): HTMLElement {
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
        return top;
    }

    private view(state: ConnectionState): CardView {
        const check = this.plugin.accountCheck;
        return cardView({
            state,
            email: this.plugin.accountGuard.getAccount()?.email ?? null,
            tracked: this.plugin.syncEngine.getTrackedFileCount(),
            lastSync: this.plugin.syncEngine.getLastSyncTime(),
            problem: this.plugin.syncStatus?.getProblem() ?? null,
            checking: check?.checking ?? false,
            checkProblem: check?.problem ?? null,
            unchecked: check?.unchecked(),
            now: Date.now(),
        });
    }

    private paintCard(
        setting: Setting, iconEl: HTMLElement, view: CardView,
        buttons: { action: CardAction; button: ButtonComponent }[],
    ): void {
        for (const tone of TONES) setting.settingEl.toggleClass(`pensio-tone-${tone}`, tone === view.tone);
        iconEl.empty();
        setIcon(iconEl, view.icon);
        iconEl.toggleClass('pensio-spin', view.icon === 'refresh-cw');
        setting.setName(view.title);
        const desc = setting.descEl;
        desc.empty();
        if (view.detail) desc.appendText(view.detail);
        if (view.signUp) {
            desc.appendText(`${view.detail ? ' ' : ''}No account? `);
            const signUp = desc.createEl('a', { text: 'Create one free', href: `${this.apiUrl()}/register/` });
            signUp.setAttr('target', '_blank');
        }
        // Drawn from state, so a redraw during a sync cannot leave it stuck (review F29).
        for (const { action, button } of buttons) {
            if (action === 'sync') button.setButtonText(this.syncing ? 'Syncing…' : 'Sync now').setDisabled(this.syncing);
        }
    }

    private actionButton(button: ButtonComponent, action: CardAction, primary: boolean): void {
        switch (action) {
            case 'connect':
                this.connectButton(button, primary);
                return;
            case 'check':
                button.setButtonText('Try again').onClick(() => { void this.plugin.accountCheck.run(); });
                if (primary) button.setCta();
                return;
            case 'sync':
                button.onClick(async () => {
                    this.syncing = true;
                    this.repaintCard?.();
                    try {
                        // Says how it ended itself; the card repaints from syncStatus.
                        await this.plugin.syncNow();
                    } finally {
                        this.syncing = false;
                        this.repaintCard?.();
                    }
                });
                return;
        }
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
                notifyFailure('Opening Pensio', error, this.plugin.failureContext(), 'connection');
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

        setting
            .addText(text => {
                text
                    .setPlaceholder('XXXX-XXXX')
                    .setValue(this.setupCode)
                    .onChange((value) => {
                        this.setupCode = value.trim();
                    });
            })
            .addButton(button => {
                button
                    .setButtonText('Use code')
                    .onClick(async () => {
                        const code = this.setupCode;
                        if (!code) {
                            notify('Type the setup code first. Connect Obsidian on the web gives you one.');
                            return;
                        }
                        try {
                            button.setDisabled(true);
                            button.setButtonText('Connecting…');

                            const deviceId = await this.plugin.ensureDeviceId();
                            const result = await this.plugin.apiClient.pair(
                                code, deviceId, this.plugin.deviceName(), this.plugin.previousRefresh()
                            );
                            this.setupCode = '';
                            await this.plugin.adoptConnection(result);
                        } catch (error) {
                            notifyFailure('Connecting with the code', error, {
                                ...this.plugin.failureContext(),
                                whenRefused: 'A code works once, for 5 minutes. Get a new one from Connect Obsidian.',
                            }, 'connection');
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
     * Test connection, under Advanced beside the manual token fields it
     * checks. A 401 the refresh cannot cure turns the tab to Session expired:
     * she asked, so a dead answer is believed (the card's own check does not,
     * review F22).
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
                                            NOTICE_MS.failure, 'connection',
                                        );
                                        this.redraw();
                                        return;
                                    }
                                    notifyFailure('The connection test', failure ?? new Error('Could not check the account'), context, 'connection');
                                    button.setButtonText('Failed');
                                    return;
                                }

                                const status = await this.plugin.apiClient.getSyncStatus();
                                const email = this.plugin.accountGuard.getAccount()?.email;
                                notify(`Connected${email ? ` as ${email}` : ''}. ${status.total_entries} entries on Pensio.`, NOTICE_MS.info, 'connection');
                                button.setButtonText('Connected ✓');

                                // Refresh to show the connected card
                                window.setTimeout(() => this.redraw(), 1500);
                            } catch (error) {
                                notifyFailure('The connection test', error, context, 'connection');
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
