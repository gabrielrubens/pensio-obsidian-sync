import { Plugin, TFile } from 'obsidian';
import { serverUrl } from './apiUrl';
import { ApiClient } from './api/client';
import { AccountCheck } from './accountCheck';
import { AccountGuard } from './auth/accountGuard';
import { tokenUserId } from './auth/identity';
import { CALLBACK_ACTION, OneClickConnect } from './auth/oneClick';
import { VerifyOptions, verifyAccount } from './plugin/accountSafety';
import { debugLog, setDebugMode } from './logger';
import { clearNotice, FailureContext, NOTICE_MS, notify, notifyFailure } from './notices';
import { registerCommands, runSyncNow } from './plugin/commands';
import { DisconnectOutcome, noticeForCallback, noticeForDisconnect } from './plugin/connectNotices';
import { DeviceIO, DeviceStore, LEGACY_SECRET_NAMES, NO_TOKENS } from './plugin/deviceState';
import { parsePersisted, Passthrough, persistable } from './plugin/persisted';
import { readTokens } from './plugin/tokenStore';
import { createOneClick, createSyncStatus, saveOnQuit, wireSyncEngine } from './plugin/wiring';
import { PensioSettingTab } from './settings';
import { SyncEngine } from './sync/engine';
import { SyncStatus } from './syncStatus';
import { PensioSettings, SyncStateData } from './types';

export default class PensioPlugin extends Plugin {
    settings: PensioSettings;
    apiClient: ApiClient;
    syncEngine: SyncEngine;
    accountGuard: AccountGuard;
    oneClick: OneClickConnect;
    statusBarItem: HTMLElement;
    /** Whether this vault is syncing: the status bar, the notices, the status card. */
    syncStatus: SyncStatus;
    /** The one check of which account the tokens belong to (src/accountCheck.ts). */
    accountCheck: AccountCheck;
    private settingTab: PensioSettingTab | null = null;
    private _syncState: SyncStateData | null = null;
    /** This vault's own id, tokens and sync history on this device (plugin/deviceState.ts). */
    private device: DeviceStore;
    /** What data.json keeps for older versions on other devices (plugin/persisted.ts). */
    private passthrough: Passthrough = { deviceId: '', syncState: null };
    /** In-memory token values (persisted in SecretStorage, never in data.json) */
    private _accessToken: string = '';
    private _refreshToken: string = '';
    /**
     * The refresh token of a connection whose token fields were emptied by
     * hand: sent as previous_refresh on the next connect, so that connection
     * ends on Pensio instead of staying listed in Connected apps.
     */
    private replacedRefresh: string = '';

    async onload() {
        const loaded = parsePersisted(await this.loadData());
        this.settings = loaded.settings;
        this.passthrough = loaded.passthrough;
        setDebugMode(this.settings.debugMode);

        // ⭐ The device id, the tokens and the sync history are this vault's
        // on this device, never synced (review CRIT-6, F30, CRIT-2). The
        // first run settles what 0.7 kept in data.json (plugin/deviceState.ts).
        const opened = await DeviceStore.open(this.deviceIO(), this.manifest.dir ?? '', () => ({
            deviceId: loaded.passthrough.deviceId,
            syncState: loaded.passthrough.syncState,
            tokens: loaded.legacyTokens ?? readTokens(this.app.secretStorage, LEGACY_SECRET_NAMES, NO_TOKENS),
            fromSharedNames: !loaded.legacyTokens,
        }));
        this.device = opened.store;
        this.settings.deviceId = opened.store.deviceId;
        this._accessToken = opened.tokens.access;
        this._refreshToken = opened.tokens.refresh;
        this._syncState = opened.syncState;
        // Plaintext tokens a pre-SecretStorage version left in data.json are
        // in SecretStorage now: take them out of the file.
        if (loaded.legacyTokens) await this.saveData(persistable(this.settings, this.passthrough));

        // What the sync is doing, for the status bar, the notices and the
        // status card. Built first: the callbacks below report to it.
        this.syncStatus = createSyncStatus(this);
        this.accountCheck = new AccountCheck(
            (onError) => this.verifyAccountBeforeSync({ onError }),
            () => this.failureContext(),
            () => this.syncStatus.changed(),
        );

        // Initialize API client
        this.apiClient = new ApiClient(this.settings);

        // Initialize with tokens if available
        if (this._accessToken && this._refreshToken) {
            await this.apiClient.initializeTokens(this._accessToken, this._refreshToken);
        }

        // Wire up token persistence: when tokens refresh, save to SecretStorage
        this.apiClient.getTokenManager().setOnTokensChanged(async (tokens) => {
            if (tokens) {
                this._accessToken = tokens.accessToken;
                this._refreshToken = tokens.refreshToken;
            } else {
                this._accessToken = '';
                this._refreshToken = '';
            }
            await this.saveTokens();
        });

        // Dead session (server-confirmed): keep tokens, surface a persistent
        // reconnect state instead of wiping — re-pairing resets it.
        this.apiClient.getTokenManager().setOnAuthInvalidated(() => {
            this.syncStatus.connectionStopped();
        });

        // Initialize account guard
        this.accountGuard = new AccountGuard();

        // Initialize sync engine with state persistence callback
        this.syncEngine = new SyncEngine(
            this.app,
            this.settings,
            this.apiClient,
            async (state: SyncStateData) => this.saveSyncState(state)
        );

        // Restore persisted sync state (survives plugin reloads)
        if (this._syncState) {
            this.syncEngine.restoreState(this._syncState);
        }

        // How the engine reports: the quota, failures, successes (plugin/wiring.ts).
        wireSyncEngine(this);
        saveOnQuit(this);

        // The network came back: if the account was never checked, check it.
        this.registerDomEvent(window, 'online', () => {
            if (this._accessToken && !this.accountGuard.getAccount()) void this.accountCheck.run();
        });

        // Status bar: what the sync is doing. Pressing it says why, in a
        // notice that stays until dismissed.
        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.addClass('mod-clickable');
        this.registerDomEvent(this.statusBarItem, 'click', () => this.syncStatus.explain());
        this.syncStatus.idle();

        // Add settings tab
        this.settingTab = new PensioSettingTab(this.app, this);
        this.addSettingTab(this.settingTab);

        // One-click connect (plugin/wiring.ts, src/auth/oneClick.ts).
        this.oneClick = createOneClick(this);
        this.registerObsidianProtocolHandler(CALLBACK_ACTION, (params) => {
            void this.finishOneClickConnect(params);
        });

        // Register commands
        this.registerCommands();

        // Start file watcher + initial sync if configured
        this.restartAutoSync();
    }

    /**
     * Run the automatic sync when it should run. ⛔ An empty Server URL means
     * Pensio itself (client.ts falls back to it), not "off": 0.7.0 silently
     * stopped auto-sync when the field was cleared, while every notice still
     * promised a retry every 5 minutes (review F34).
     */
    private restartAutoSync(): void {
        this.syncEngine.stopWatching();
        if (this.settings.autoSync && this._accessToken && this._refreshToken) {
            this.syncEngine.startWatching();
            this.syncEngine.startAutoSync();
        }
    }

    onunload() {
        this.syncEngine.stopWatching();
        // Flush the current tokens one last time — SecretStorage write timing
        // is opaque, and a quit right after a refresh must not lose the
        // rotated token (that lockout is discovered days later).
        void this.saveTokens();
    }

    /** Obsidian's storage, as the device store reads and writes it. */
    private deviceIO(): DeviceIO {
        const adapter = this.app.vault.adapter;
        return {
            loadLocal: (key) => this.app.loadLocalStorage(key) as unknown,
            saveLocal: (key, value) => this.app.saveLocalStorage(key, value),
            read: async (path) => (await adapter.exists(path)) ? adapter.read(path) : null,
            write: async (path, text) => {
                const dir = path.slice(0, path.lastIndexOf('/'));
                if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
                await adapter.write(path, text);
            },
            secrets: this.app.secretStorage,
        };
    }

    /**
     * data.json changed on disk: another device changed a setting, and a sync
     * service brought it here. ⛔ Until 0.8.0 the plugin did not listen, and
     * its next sync wrote its own copy back over the change (review CRIT-6).
     * ⭐ Applied to the same settings object, so the sync sees the change as
     * one made here: a folder setting that changed defers mirror delete
     * (sync/deletes.ts::MirrorGate). The device id stays this device's.
     */
    async onExternalSettingsChange(): Promise<void> {
        const loaded = parsePersisted(await this.loadData());
        this.passthrough = loaded.passthrough;
        Object.assign(this.settings, loaded.settings, { deviceId: this.device.deviceId });
        this.applySettings();
        this.settingTab?.update();
    }

    /** Settings changed here: write data.json, which is all it holds now. */
    async saveSettings() {
        await this.saveData(persistable(this.settings, this.passthrough));
        this.applySettings();
    }

    private applySettings(): void {
        setDebugMode(this.settings.debugMode);

        // Update API client with new settings
        this.apiClient.updateSettings(this.settings);

        // ⛔ No token check here: tokens are not settings (they live in
        // SecretStorage), and every change of them goes through setTokens.
        // Restarting cancels the sync the last save scheduled, so a burst of
        // saves (typing a folder path) syncs once, 5 s after the last.
        this.restartAutoSync();
    }

    registerCommands() {
        registerCommands(this);
    }

    /**
     * A sync she asked for: a command, or *Sync now* on the status card. It
     * always says how it ended, and a failure stays on screen until she
     * dismisses it (SyncStatus).
     */
    async syncNow(options: { force?: boolean; file?: TFile } = {}): Promise<void> {
        await runSyncNow(this, options);
    }

    /**
     * What a failure notice needs to word itself, for anything she pressed
     * that nothing will repeat: a connect, a setup code, Test connection, the
     * card's check. ⛔ So it promises no automatic retry.
     */
    failureContext(): FailureContext {
        return { apiUrl: serverUrl(this.settings.apiUrl), retries: false };
    }

    /** The same, for a sync: the automatic sync retries it, when it runs. */
    syncFailureContext(): FailureContext {
        return {
            apiUrl: serverUrl(this.settings.apiUrl),
            retries: this.settings.autoSync && (this.syncEngine?.isAutoSyncing() ?? false),
        };
    }

    /**
     * Disconnect: stop this vault's connection on Pensio, then clear tokens,
     * sync state, and account cache here. Called by both the command and the
     * settings tab.
     *
     * The server stop comes first and never blocks the local one: offline, a
     * dead session or an older server still forget the tokens here, and the
     * connection is then stoppable from Connected apps on the web.
     */
    async logout(): Promise<void> {
        // ⭐ The notice says what happened (review F35; plugin/connectNotices.ts).
        let outcome: DisconnectOutcome = 'nothing';
        if (this._accessToken && this._refreshToken) {
            if (this.apiClient.isAuthInvalidated()) {
                outcome = 'already-ended';
            } else {
                try {
                    await this.apiClient.disconnect();
                    outcome = 'stopped';
                } catch (error) {
                    debugLog('Disconnect on the server failed; forgetting locally', error);
                    outcome = { failed: error };
                }
            }
        }
        this._accessToken = '';
        this._refreshToken = '';
        await this.saveTokens();
        // Also drop the in-memory copies held by the token manager \u2014 the only
        // place tokens are ever wiped is this explicit logout.
        await this.apiClient.logout();
        this.syncEngine.clearState();
        this.accountGuard.clearAccount();
        this._syncState = null;
        await this.device.saveState(null);
        this.replacedRefresh = '';
        this.accountCheck?.reset();
        // Nothing to sync with now: stop the watcher and the timer.
        this.restartAutoSync();
        this.syncStatus?.reset();
        clearNotice('connection');
        noticeForDisconnect(outcome, this.failureContext());
    }

    /**
     * Both token fields were emptied by hand: stop using these tokens here,
     * without ending anything and without forgetting what was synced. The next
     * connect ends the old connection on Pensio (previous_refresh), and keeps
     * the sync history if it is the same account (setTokens). ⛔ 0.7.0 wiped
     * the sync history on the first emptied field, so the reconnect that
     * followed re-uploaded every note (review F5).
     */
    async forgetTokens(): Promise<void> {
        if (this._refreshToken) this.replacedRefresh = this._refreshToken;
        this._accessToken = '';
        this._refreshToken = '';
        await this.saveTokens();
        await this.apiClient.logout();
        this.accountGuard.clearAccount();
        this.accountCheck?.reset();
        this.restartAutoSync();
        this.syncStatus?.reset();
        this.settingTab?.update();
    }

    /** The refresh token a new connection should end: the one held, or one just emptied. */
    previousRefresh(): string {
        return this._refreshToken || this.replacedRefresh;
    }

    // ========================================================================
    // Connecting
    // ========================================================================

    /** What Connected apps on the web calls this vault. */
    deviceName(): string {
        return `Obsidian \u2014 ${this.app.vault.getName()}`;
    }

    /** Connect to Pensio: open the approval page in her browser. */
    async startOneClickConnect(): Promise<void> {
        const url = await this.oneClick.start(
            this.settings.apiUrl, this.settings.deviceId, this.deviceName(), this.app.vault.getName()
        );
        window.open(url);
        notify('Approve this vault in your browser, then come back here.', 10000, 'connection');
    }

    /** obsidian://pensio-connect landed. */
    private async finishOneClickConnect(params: Record<string, string | undefined>): Promise<void> {
        try {
            const outcome = await this.oneClick.handleCallback(params);
            if (outcome.kind === 'connected') {
                await this.adoptConnection(outcome.result);
            } else {
                noticeForCallback(outcome);
            }
        } catch (error) {
            notifyFailure('Connecting', error, this.failureContext(), 'connection');
            console.error('One-click connect failed:', error);
        } finally {
            // ⭐ However it ended, the card stops waiting now (review F32).
            this.settingTab?.update();
        }
    }

    /**
     * Take a fresh token family from either door (a setup code or one click),
     * verify the account, and say so.
     *
     * ⭐ Sync state is kept when it is the same account: reconnecting after an
     * expired or stopped connection must not re-upload the vault. setTokens
     * reads the account from the new token and clears the state on a switch.
     *
     * ⭐ One account check (accountCheck), shared with the status card: 0.7.0
     * ran two in parallel on every connect (review F13).
     */
    async adoptConnection(result: { access: string; refresh: string }): Promise<void> {
        await this.setTokens(result.access, result.refresh);
        this.replacedRefresh = '';

        const verified = await this.accountCheck.run();
        const account = this.accountGuard.getAccount();
        if (verified && account) {
            notify(`Connected as ${account.email}.`, NOTICE_MS.info, 'connection');
        } else {
            // ⛔ Not "the account is checked on the first sync": 0.7.0 said
            // that, and no automatic sync ever ran the check (review F8).
            const reason = this.accountCheck.problem?.reason ?? '';
            notify(
                `Connected, but Pensio couldn’t confirm the account yet. ${reason} ` +
                'The plugin checks again when Pensio next answers.',
                NOTICE_MS.failure, 'connection',
            );
        }
        this.settingTab?.update();
    }

    // ========================================================================
    // Account Safety
    // ========================================================================

    /** Verify account identity before any sync operation (plugin/accountSafety.ts). */
    async verifyAccountBeforeSync(options: VerifyOptions = {}): Promise<boolean> {
        return verifyAccount(this, {
            syncState: () => this._syncState,
            saveSyncState: (state) => this.saveSyncState(state),
        }, options);
    }

    /** Forget what was synced: the next sync checks every note again. */
    private clearSyncHistory(): void {
        debugLog('Clearing sync state');
        this.syncEngine.clearState();
        this.accountGuard.clearAccount();
        this._syncState = null;
    }

    // ========================================================================
    // SecretStorage — encrypted token persistence
    // ========================================================================

    /**
     * Save current in-memory tokens to SecretStorage, verified by read-back.
     * Also called by the onTokensChanged callback after refresh. Losing this
     * write used to brick the pairing (the server no longer blacklists the
     * predecessor, so a lost write is recoverable — but still verify).
     */
    async saveTokens(): Promise<void> {
        this.device.writeTokens({ access: this._accessToken, refresh: this._refreshToken });
    }

    /** Public accessors for tokens (used by settings tab) */
    getAccessToken(): string { return this._accessToken; }
    getRefreshToken(): string { return this._refreshToken; }

    /**
     * Take a new pair of tokens: from a connect, a setup code, or pasted by
     * hand under Advanced. Persists them and initializes the API client.
     *
     * ⭐ The sync history stays when the new tokens are for the account it
     * belongs to, read from the token itself (src/auth/identity.ts): a
     * reconnect must not re-upload the vault. Tokens for another account, or
     * a state that names no owner, start it again; ⛔ that is decided here,
     * before any sync can upload to the wrong account. The cached account is
     * always forgotten: new tokens are unverified until the account check runs.
     */
    async setTokens(accessToken: string, refreshToken: string): Promise<void> {
        this._accessToken = accessToken;
        this._refreshToken = refreshToken;
        await this.saveTokens();
        if (accessToken && refreshToken) {
            await this.apiClient.initializeTokens(accessToken, refreshToken);
        }
        const owner = this._syncState?.userId ?? null;
        const userId = tokenUserId(accessToken);
        if (owner !== null && userId !== owner) {
            if (userId !== null) {
                notify('These tokens are for a different Pensio account, so every note syncs again to it.', 15000);
            }
            this.clearSyncHistory();
        } else if (owner === null && this._syncState) {
            // A history from before sync state named its owner: start it again.
            this.clearSyncHistory();
        }
        this.accountGuard.clearAccount();
        this.accountCheck?.reset();
        this.restartAutoSync();
        // Re-pairing resets a dead session — clear the reconnect hint.
        this.syncStatus?.reset();
    }

    /**
     * Save the sync history, on this device only (plugin/deviceState.ts).
     * Called by the SyncEngine after successful sync operations. ⛔ Never
     * data.json: writing it on every sync is what overwrote a setting changed
     * on another device (review CRIT-6).
     */
    private async saveSyncState(state: SyncStateData): Promise<void> {
        this._syncState = state;
        await this.device.saveState(state);
    }
}
