import { Plugin, TFile } from 'obsidian';
import { serverUrl } from './apiUrl';
import { ApiClient } from './api/client';
import { AccountCheck } from './accountCheck';
import { AccountGuard } from './auth/accountGuard';
import { tokenUserId } from './auth/identity';
import { CALLBACK_ACTION, OneClickConnect } from './auth/oneClick';
import { debugLog, setDebugMode } from './logger';
import { clearNotice, explainFailure, FailureContext, NOTICE_MS, notify, notifyFailure } from './notices';
import { PensioSettingTab } from './settings';
import { SyncEngine } from './sync/engine';
import { quotaDayKey, quotaNoticeMessage, quotaSummaryLine, shouldNotifyQuota } from './sync/quotaNotice';
import { SyncStatus } from './syncStatus';
import { DEFAULT_SETTINGS, JournalFolderMapping, PensioSettings, ProcessingStatus, SyncStateData } from './types';

/** Pre-0.3.0 folder mappings carried extra per-folder fields. */
interface LegacyFolderMapping extends JournalFolderMapping {
    entryType?: string;
    label?: string;
}

/**
 * Shape of the plugin's persisted data.json. Settings fields plus the sync
 * state and two legacy plaintext-token keys migrated to SecretStorage.
 */
interface PersistedData extends Partial<PensioSettings> {
    _syncState?: SyncStateData | null;
    apiToken?: string;
    refreshToken?: string;
}

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
    /** In-memory token values (persisted in SecretStorage, never in data.json) */
    private _accessToken: string = '';
    private _refreshToken: string = '';
    /**
     * The refresh token of a connection whose token fields were emptied by
     * hand: sent as previous_refresh on the next connect, so that connection
     * ends on Pensio instead of staying listed in Connected apps.
     */
    private replacedRefresh: string = '';

    private static readonly SECRET_ACCESS_TOKEN = 'pensio-access-token';
    private static readonly SECRET_REFRESH_TOKEN = 'pensio-refresh-token';

    async onload() {
        // Load settings
        await this.loadSettings();
        setDebugMode(this.settings.debugMode);

        // Every install owns a stable device id — the refresh and pair
        // endpoints require one (per-device revocation), and older versions
        // never generated it, which made every refresh fail validation.
        await this.ensureDeviceId();

        // Load tokens from SecretStorage (encrypted at rest)
        await this.loadTokens();

        // What the sync is doing, for the status bar, the notices and the
        // status card. Built first: the callbacks below report to it.
        this.syncStatus = this.createSyncStatus();
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

        // Surface the free-tier analysis quota. Auto-sync is on by default and
        // silent, so without this a first import of a large vault finishes
        // with no indication that analysis will take weeks.
        this.syncEngine.onProcessingStatus = (status) => this.handleProcessingStatus(status);

        // An automatic sync reports how it ended; one she asked for is
        // reported by syncNow.
        this.syncEngine.onSyncFailed = (error) => this.syncStatus.failed(error, { asked: false });
        this.syncEngine.onSyncSucceeded = (contacted) => this.onSyncReachedPensio(contacted);
        // A problem on screen, or an account nobody has checked, makes a sync
        // with nothing to send ask Pensio anyway (review F26).
        this.syncEngine.needsContact = () =>
            this.syncStatus.getProblem() !== null || this.accountGuard.getAccount() === null;

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

        // One-click connect: the browser hands the code back at
        // obsidian://pensio-connect (src/auth/oneClick.ts). The exchange sends
        // the refresh token this vault holds, so the connection it replaces ends.
        this.oneClick = new OneClickConnect(
            (code, verifier, deviceId) =>
                this.apiClient.connectWithCode(code, verifier, deviceId, this.previousRefresh()),
            {
                // This device only, never synced: a reload, an update or a
                // second press must not orphan an approval (review F24).
                store: {
                    load: () => this.app.loadLocalStorage('pensio-one-click') as unknown,
                    save: (value: unknown) => this.app.saveLocalStorage('pensio-one-click', value),
                },
            },
        );
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

    /** A sync ended with nothing failing; `contacted`: Pensio answered it. */
    private onSyncReachedPensio(contacted: boolean): void {
        if (!contacted) return;
        this.syncStatus.recovered();
        // Pensio answers again: an account nobody could check gets checked now.
        if (!this.accountGuard.getAccount()) void this.accountCheck.run();
    }

    onunload() {
        this.syncEngine.stopWatching();
        // Flush the current tokens one last time — SecretStorage write timing
        // is opaque, and a quit right after a refresh must not lose the
        // rotated token (that lockout is discovered days later).
        void this.saveTokens();
    }

    async loadSettings() {
        const rawData = ((await this.loadData()) ?? {}) as PersistedData;

        // Extract sync state before merging with settings defaults
        this._syncState = rawData._syncState ?? null;
        const settingsData: PersistedData = { ...rawData };
        delete settingsData._syncState;

        // Migrate legacy plaintext tokens → SecretStorage (one-time)
        if (settingsData.apiToken || settingsData.refreshToken) {
            debugLog('Migrating plaintext tokens to SecretStorage');
            this._accessToken = settingsData.apiToken || '';
            this._refreshToken = settingsData.refreshToken || '';
            delete settingsData.apiToken;
            delete settingsData.refreshToken;
            // Save tokens to SecretStorage and clean data.json in background
            // (loadTokens below will prefer these in-memory values)
            window.setTimeout(() => {
                void (async () => {
                    await this.saveTokens();
                    await this.saveData({ ...this.settings, _syncState: this._syncState });
                })();
            }, 0);
        }

        this.settings = Object.assign({}, DEFAULT_SETTINGS, settingsData);

        // Migrate old folder mappings that had entryType/label fields (pre-0.3.0)
        const folders = this.settings.journalFolders as LegacyFolderMapping[];
        if (folders?.length > 0 && folders[0].entryType !== undefined) {
            this.settings.journalFolders = folders.map(
                (m): JournalFolderMapping => ({ folder: m.folder })
            );
        }
    }

    /**
     * Make sure this install has a stable device id, generating and
     * persisting one if missing. Returns the id.
     */
    async ensureDeviceId(): Promise<string> {
        if (!this.settings.deviceId) {
            const bytes = new Uint8Array(8);
            crypto.getRandomValues(bytes);
            const suffix = Array.from(bytes)
                .map((b: number) => b.toString(16).padStart(2, '0'))
                .join('');
            this.settings.deviceId = `obsidian-${suffix}`;
            const dataToSave: Record<string, unknown> = { ...this.settings };
            if (this._syncState) {
                dataToSave._syncState = this._syncState;
            }
            await this.saveData(dataToSave);
            debugLog('Generated device id', this.settings.deviceId);
        }
        return this.settings.deviceId;
    }

    async saveSettings() {
        // Preserve sync state when saving settings
        const dataToSave: Record<string, unknown> = { ...this.settings };
        if (this._syncState) {
            dataToSave._syncState = this._syncState;
        }
        await this.saveData(dataToSave);
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
        // Manual sync command
        this.addCommand({
            id: 'sync-now',
            name: 'Sync now',
            callback: () => this.syncNow()
        });


        // Force sync all files (ignore change detection)
        this.addCommand({
            id: 'force-sync-all',
            name: 'Force sync all files',
            callback: () => this.syncNow({ force: true })
        });

        // Sync current file
        this.addCommand({
            id: 'sync-current-file',
            name: 'Sync current file',
            callback: async () => {
                const file = this.app.workspace.getActiveFile();
                if (!file) {
                    notify('Open a note first, then sync it.');
                    return;
                }
                if (!file.path.endsWith('.md')) {
                    notify('Only Markdown notes sync to Pensio.');
                    return;
                }
                await this.syncNow({ file });
            }
        });

        // Check sync status
        this.addCommand({
            id: 'check-sync-status',
            name: 'Check sync status',
            callback: async () => {
                try {
                    const status = await this.apiClient.getSyncStatus();
                    const account = this.accountGuard.getAccount();
                    const accountLine = account ? `Account: ${account.email}\n` : '';
                    const trackedFiles = this.syncEngine.getTrackedFileCount();
                    // Prefer the value this call just fetched; fall back to
                    // the last sync's reading on older servers.
                    const quotaLine = quotaSummaryLine(
                        status.processing_status ?? this.syncEngine.getLastProcessingStatus()
                    );
                    notify(
                        'sync status\n' +
                        `${accountLine}` +
                        `Server entries: ${status.total_entries}\n` +
                        `Local tracked files: ${trackedFiles}` +
                        (quotaLine ? `\n${quotaLine}` : '')
                    );
                } catch (error) {
                    notifyFailure('Checking the sync status', error, this.failureContext(), 'connection');
                    console.error('Status error:', error);
                }
            }
        });

        // Disconnect. The id stays 'logout' so a hotkey bound to it keeps working.
        this.addCommand({
            id: 'logout',
            name: 'Disconnect from Pensio',
            callback: async () => {
                await this.logout();
            }
        });
    }

    /**
     * A sync she asked for: a command, or *Sync now* on the status card. It
     * always says how it ended, and a failure stays on screen until she
     * dismisses it (SyncStatus).
     */
    async syncNow(options: { force?: boolean; file?: TFile } = {}): Promise<void> {
        // ⛔ Before 0.7.1 a sync with nothing connected did nothing visible.
        if (!this._accessToken || !this._refreshToken) {
            notify('This vault isn’t connected. Open the plugin’s settings and press Connect to Pensio.', NOTICE_MS.failure);
            return;
        }
        if (this.apiClient.isAuthInvalidated()) {
            notify('The connection to Pensio has stopped. Open the plugin’s settings and press Connect to Pensio.', NOTICE_MS.failure);
            return;
        }
        this.syncStatus.syncing();
        try {
            const verified = await this.verifyAccountBeforeSync({
                onError: (error) => this.syncStatus.failed(error, { asked: true }),
            });
            if (!verified) {
                this.syncStatus.idle();
                return;
            }
            if (options.file) this.syncEngine.markDirty(options.file.path);
            const result = await this.syncEngine.syncAll(options.force ?? false, { asked: true });
            this.syncStatus.succeeded(`${result.synced} synced`);
            if (options.file) {
                notify(result.synced > 0 ? `${options.file.name} synced.` : `${options.file.name} was already up to date.`);
            } else {
                notify(`${options.force ? 'Full sync' : 'Sync'} done. ${result.synced} synced, ${result.skipped} unchanged.`);
            }
        } catch (error) {
            this.syncStatus.failed(error, { asked: true });
            console.error('Sync error:', error);
        }
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

    private createSyncStatus(): SyncStatus {
        return new SyncStatus({
            statusBar: () => this.statusBarItem ?? null,
            isAuthInvalidated: () => this.apiClient?.isAuthInvalidated() ?? false,
            trackedCount: () => this.syncEngine?.getTrackedFileCount() ?? 0,
            failureContext: () => this.syncFailureContext(),
        });
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
        // ⭐ The notice says what happened (review F35): 0.7.0 said Pensio
        // "could not be reached" when it was reached and refused, and when
        // nothing was ever asked.
        let outcome: 'stopped' | 'already-ended' | 'nothing' | { failed: unknown } = 'nothing';
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
        this.replacedRefresh = '';
        this.accountCheck?.reset();
        await this.saveSettings();
        this.syncStatus?.reset();
        clearNotice('connection');
        if (outcome === 'stopped') {
            notify('Disconnected. This vault no longer syncs.');
        } else if (outcome === 'already-ended') {
            notify('Disconnected. This connection had already ended on Pensio.');
        } else if (outcome === 'nothing') {
            notify('Disconnected. There was no connection to stop.');
        } else {
            const { reason } = explainFailure(outcome.failed, this.failureContext());
            notify(
                `Disconnected here, but Pensio didn’t stop the connection there. ${reason} ` +
                'Stop it on the web too: Settings \u2192 Connected apps.',
                NOTICE_MS.failure,
            );
        }
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
        const deviceId = await this.ensureDeviceId();
        const url = await this.oneClick.start(
            this.settings.apiUrl, deviceId, this.deviceName(), this.app.vault.getName()
        );
        window.open(url);
        notify('Approve this vault in your browser, then come back here.', 10000, 'connection');
    }

    /** obsidian://pensio-connect landed. */
    private async finishOneClickConnect(params: Record<string, string | undefined>): Promise<void> {
        try {
            const outcome = await this.oneClick.handleCallback(params);
            switch (outcome.kind) {
                case 'connected':
                    await this.adoptConnection(outcome.result);
                    return;
                case 'cancelled':
                    notify('Connecting was cancelled in the browser. Nothing changed here.', NOTICE_MS.info, 'connection');
                    return;
                case 'expired':
                    notify('That request expired. Press Connect to Pensio in the settings again.', NOTICE_MS.failure, 'connection');
                    return;
                case 'already-used':
                    notify('That approval was already used. This vault is connected.', NOTICE_MS.info, 'connection');
                    return;
                case 'not-ours':
                    notify(
                        'Pensio couldn’t match this approval to a Connect request in this vault. ' +
                        'Press Connect to Pensio again, and approve in the newest browser tab.',
                        NOTICE_MS.failure, 'connection',
                    );
                    return;
            }
        } catch (error) {
            notifyFailure('Connecting', error, this.failureContext(), 'connection');
            console.error('One-click connect failed:', error);
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

    /**
     * Tell the user, at most once a day, that the free daily analysis cap is
     * spent and roughly how long the backlog will take.
     *
     * Deliberately once per quota day: sync runs on a five-minute timer, and
     * "you are still over quota" is an unchanging state, not news. Repeating
     * it every tick is the same mistake the server-side throttle event made.
     */
    private handleProcessingStatus(status: ProcessingStatus): void {
        const day = quotaDayKey();
        if (!shouldNotifyQuota(status, this.syncEngine.getLastQuotaNoticeDay())) {
            return;
        }

        this.syncEngine.markQuotaNoticeShown(day);

        const notice = notify(quotaNoticeMessage(status), 20000);
        // messageEl is absent under the test mock — optional chaining keeps the
        // message itself working even if the click target is unavailable.
        const apiUrl = serverUrl(this.settings.apiUrl);
        (notice as { messageEl?: HTMLElement })?.messageEl?.addEventListener('click', () => {
            window.open(`${apiUrl}/pricing/`);
        });
    }

    // ========================================================================
    // Account Safety
    // ========================================================================

    /**
     * Verify account identity before any sync operation.
     * Returns true if safe to proceed, false if sync should be aborted.
     *
     * On account switch: clears sync state, stamps new userId, persists.
     * On first connection: stamps userId, persists.
     */
    async verifyAccountBeforeSync(options: {
        reconnectOn401?: boolean;
        /** Report a failure here instead of in a notice. */
        onError?: (error: unknown) => void;
    } = {}): Promise<boolean> {
        // Skip verification if not authenticated
        if (!this._accessToken || !this._refreshToken) {
            return false;
        }
        if (this.apiClient.isAuthInvalidated()) {
            return false;
        }

        const result = await this.accountGuard.verify(
            this.apiClient,
            this._syncState,
        );

        switch (result.status) {
            case 'ok':
                return true;

            case 'first-connection':
                // Stamp userId on sync state for future verification
                this.syncEngine.setUserId(result.account.id);
                await this.saveSyncState(this.syncEngine.getState());
                return true;

            case 'account-switched':
                // Clear everything and start fresh for the new account
                this.syncEngine.clearState();
                this.syncEngine.setUserId(result.account.id);
                await this.saveSyncState(this.syncEngine.getState());
                return true;

            case 'error':
                // Only when the person asked (Test connection): a 401 the
                // refresh could not cure means this connection is gone, so
                // show the reconnect state instead of a bare failure.
                if (result.unauthorized && options.reconnectOn401) {
                    this.apiClient.markAuthInvalidated();
                    return false;
                }
                // Block sync on error — fail safe, not fail open
                {
                    const error = result.error ?? new Error(result.message);
                    if (options.onError) options.onError(error);
                    else notifyFailure('Sync', error, this.failureContext());
                }
                return false;
        }
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
     * Load tokens from Obsidian's SecretStorage (encrypted at rest).
     * Called once during onload, after loadSettings (which may migrate legacy tokens).
     */
    private async loadTokens(): Promise<void> {
        // If migration already populated in-memory tokens, skip SecretStorage read
        if (this._accessToken && this._refreshToken) return;

        try {
            this._accessToken = this.app.secretStorage.getSecret(PensioPlugin.SECRET_ACCESS_TOKEN) || '';
            this._refreshToken = this.app.secretStorage.getSecret(PensioPlugin.SECRET_REFRESH_TOKEN) || '';
        } catch (error) {
            console.error('Failed to load tokens from SecretStorage:', error);
        }
    }

    /**
     * Save current in-memory tokens to SecretStorage, verified by read-back.
     * Also called by the onTokensChanged callback after refresh. Losing this
     * write used to brick the pairing (the server no longer blacklists the
     * predecessor, so a lost write is recoverable — but still verify).
     */
    async saveTokens(): Promise<void> {
        const write = () => {
            this.app.secretStorage.setSecret(PensioPlugin.SECRET_ACCESS_TOKEN, this._accessToken);
            this.app.secretStorage.setSecret(PensioPlugin.SECRET_REFRESH_TOKEN, this._refreshToken);
        };
        const verified = () =>
            (this.app.secretStorage.getSecret(PensioPlugin.SECRET_ACCESS_TOKEN) || '') === this._accessToken &&
            (this.app.secretStorage.getSecret(PensioPlugin.SECRET_REFRESH_TOKEN) || '') === this._refreshToken;

        try {
            write();
            if (!verified()) {
                debugLog('SecretStorage read-back mismatch — retrying token save');
                write();
                if (!verified()) {
                    console.error('Pensio: token save could not be verified — tokens may not survive a restart');
                }
            }
        } catch (error) {
            console.error('Failed to save tokens to SecretStorage:', error);
        }
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
     * Save sync state alongside settings in data.json.
     * Called by the SyncEngine after successful sync operations.
     */
    private async saveSyncState(state: SyncStateData): Promise<void> {
        this._syncState = state;
        const dataToSave: Record<string, unknown> = { ...this.settings };
        dataToSave._syncState = state;
        await this.saveData(dataToSave);
    }
}
