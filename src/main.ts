import { Notice, Plugin, setIcon } from 'obsidian';
import { ApiClient } from './api/client';
import { AccountGuard } from './auth/accountGuard';
import { CALLBACK_ACTION, OneClickConnect } from './auth/oneClick';
import { errorMessage } from './errors';
import { debugLog, setDebugMode } from './logger';
import { PensioSettingTab } from './settings';
import { SyncEngine } from './sync/engine';
import { quotaDayKey, quotaNoticeMessage, quotaSummaryLine, shouldNotifyQuota } from './sync/quotaNotice';
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

type StatusBarState = 'idle' | 'syncing' | 'error' | 'success' | 'reconnect';

export default class PensioPlugin extends Plugin {
    settings: PensioSettings;
    apiClient: ApiClient;
    syncEngine: SyncEngine;
    accountGuard: AccountGuard;
    oneClick: OneClickConnect;
    statusBarItem: HTMLElement;
    private settingTab: PensioSettingTab | null = null;
    private _syncState: SyncStateData | null = null;
    /** In-memory token values (persisted in SecretStorage, never in data.json) */
    private _accessToken: string = '';
    private _refreshToken: string = '';
    /** Tracks the token values that were last used, to detect manual changes */
    private _previousTokenFingerprint: string = '';

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
            this.updateStatusBar('reconnect');
            new Notice('Pensio: session expired. Open Settings → Pensio Journaling Sync to reconnect.');
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

        // Snapshot current tokens for change detection
        this._previousTokenFingerprint = this.tokenFingerprint();

        // Add status bar item
        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar('idle');

        // Add settings tab
        this.settingTab = new PensioSettingTab(this.app, this);
        this.addSettingTab(this.settingTab);

        // One-click connect: the browser hands the code back at
        // obsidian://pensio-connect (src/auth/oneClick.ts). The exchange sends
        // the refresh token this vault holds, so the connection it replaces ends.
        this.oneClick = new OneClickConnect((code, verifier, deviceId) =>
            this.apiClient.connectWithCode(code, verifier, deviceId, this._refreshToken));
        this.registerObsidianProtocolHandler(CALLBACK_ACTION, (params) => {
            void this.finishOneClickConnect(params);
        });

        // Register commands
        this.registerCommands();

        // Start file watcher + initial sync if configured
        if (this.settings.autoSync && this.settings.apiUrl && this._accessToken) {
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

        // Detect token change — clear sync state to prevent cross-account data
        const currentFingerprint = this.tokenFingerprint();
        if (this._previousTokenFingerprint &&
            currentFingerprint &&
            currentFingerprint !== this._previousTokenFingerprint) {
            await this.handleTokenChange();
        }
        this._previousTokenFingerprint = currentFingerprint;

        // Restart watcher + auto-sync if enabled
        this.syncEngine.stopWatching();
        if (this.settings.autoSync && this.settings.apiUrl && this._accessToken) {
            this.syncEngine.startWatching();
            this.syncEngine.startAutoSync();
        }
    }

    registerCommands() {
        // Manual sync command
        this.addCommand({
            id: 'sync-now',
            name: 'Sync now',
            callback: async () => {
                this.updateStatusBar('syncing');
                try {
                    if (!await this.verifyAccountBeforeSync()) {
                        this.updateStatusBar('idle');
                        return;
                    }
                    const result = await this.syncEngine.syncAll(false);
                    this.updateStatusBar('success', `${result.synced} synced`);
                    new Notice(`Sync done: ${result.synced} synced, ${result.skipped} unchanged, ${result.total} total files`);
                } catch (error) {
                    this.updateStatusBar('error');
                    new Notice(`Sync failed: ${errorMessage(error)}`);
                    console.error('Sync error:', error);
                }
            }
        });

        // Force sync all files (ignore change detection)
        this.addCommand({
            id: 'force-sync-all',
            name: 'Force sync all files',
            callback: async () => {
                this.updateStatusBar('syncing');
                try {
                    if (!await this.verifyAccountBeforeSync()) {
                        this.updateStatusBar('idle');
                        return;
                    }
                    const result = await this.syncEngine.syncAll(true);
                    this.updateStatusBar('success', `${result.synced} synced`);
                    new Notice(`Force sync done: ${result.synced} synced, ${result.skipped} unchanged, ${result.total} total files`);
                } catch (error) {
                    this.updateStatusBar('error');
                    new Notice(`Sync failed: ${errorMessage(error)}`);
                    console.error('Sync error:', error);
                }
            }
        });

        // Sync current file
        this.addCommand({
            id: 'sync-current-file',
            name: 'Sync current file',
            callback: async () => {
                const file = this.app.workspace.getActiveFile();
                if (!file) {
                    new Notice('No active file');
                    return;
                }

                if (!file.path.endsWith('.md')) {
                    new Notice('Current file is not a Markdown file');
                    return;
                }

                this.updateStatusBar('syncing');
                try {
                    if (!await this.verifyAccountBeforeSync()) {
                        this.updateStatusBar('idle');
                        return;
                    }
                    this.syncEngine.markDirty(file.path);
                    const result = await this.syncEngine.syncAll(false);
                    this.updateStatusBar('success', `${file.name} synced`);
                    new Notice(`File sync done: ${result.synced} synced`);
                } catch (error) {
                    this.updateStatusBar('error');
                    new Notice(`Sync failed: ${errorMessage(error)}`);
                    console.error('Sync error:', error);
                }
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
                    new Notice(
                        `${accountLine}` +
                        `Server entries: ${status.total_entries}\n` +
                        `Local tracked files: ${trackedFiles}` +
                        (quotaLine ? `\n${quotaLine}` : '')
                    );
                } catch (error) {
                    new Notice(`Failed to get status: ${errorMessage(error)}`);
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
     * Disconnect: stop this vault's connection on Pensio, then clear tokens,
     * sync state, and account cache here. Called by both the command and the
     * settings tab.
     *
     * The server stop comes first and never blocks the local one: offline, a
     * dead session or an older server still forget the tokens here, and the
     * connection is then stoppable from Connected apps on the web.
     */
    async logout(): Promise<void> {
        let stopped = false;
        if (this._accessToken && this._refreshToken && !this.apiClient.isAuthInvalidated()) {
            try {
                await this.apiClient.disconnect();
                stopped = true;
            } catch (error) {
                debugLog('Disconnect on the server failed; forgetting locally', error);
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
        await this.saveSettings();
        this.updateStatusBar('idle');
        new Notice(stopped
            ? 'Disconnected \u2014 this vault no longer syncs to Pensio'
            : 'Disconnected here \u2014 stop the connection in Pensio \u2192 Settings \u2192 Connected apps too');
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
        new Notice('Pensio: approve this vault in your browser, then come back here.', 10000);
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
                    new Notice('Pensio: connecting was cancelled');
                    return;
                case 'expired':
                    new Notice('Pensio: that request expired \u2014 press Connect in the settings again');
                    return;
                case 'not-ours':
                    new Notice('Pensio: that link was not started from this vault \u2014 press Connect in the settings');
                    return;
            }
        } catch (error) {
            new Notice(`Pensio: connecting failed \u2014 ${errorMessage(error)}`);
            console.error('One-click connect failed:', error);
        }
    }

    /**
     * Take a fresh token family from either door (a setup code or one click),
     * verify the account, and say so.
     *
     * ⭐ Sync state is kept: reconnecting after an expired or stopped
     * connection must not re-upload the vault. A different account is still
     * caught, by the account guard, which clears the sync state itself.
     */
    async adoptConnection(result: { access: string; refresh: string }): Promise<void> {
        await this.setTokens(result.access, result.refresh, { keepSyncState: true });

        const verified = await this.verifyAccountBeforeSync();
        const account = this.accountGuard.getAccount();
        if (verified && account) {
            new Notice(`Connected as ${account.email}`);
        } else {
            new Notice('Connected \u2014 verifying account on first sync');
        }
        this.settingTab?.update();
    }

    updateStatusBar(status: StatusBarState, detail?: string) {
        switch (status) {
            case 'idle': {
                // A dead session takes priority over the idle display — the
                // reconnect hint must stay visible, not be reset by the
                // success/error timeouts below.
                if (this.apiClient?.isAuthInvalidated()) {
                    this.setStatusBar('cloud-off', 'Reconnect Pensio');
                    break;
                }
                const tracked = this.syncEngine.getTrackedFileCount();
                this.setStatusBar('cloud', tracked > 0 ? `${tracked} synced` : 'Pensio');
                break;
            }
            case 'syncing':
                this.setStatusBar('refresh-cw', 'Syncing...');
                break;
            case 'success':
                this.setStatusBar('check', detail ?? 'Synced');
                window.setTimeout(() => this.updateStatusBar('idle'), 3000);
                break;
            case 'error':
                this.setStatusBar('alert-triangle', 'Sync error');
                window.setTimeout(() => this.updateStatusBar('idle'), 5000);
                break;
            case 'reconnect':
                this.setStatusBar('cloud-off', 'Reconnect Pensio');
                break;
        }
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

        const notice = new Notice(quotaNoticeMessage(status), 20000);
        // noticeEl is absent under the test mock — optional chaining keeps the
        // message itself working even if the click target is unavailable.
        const apiUrl = this.settings.apiUrl;
        (notice as { noticeEl?: HTMLElement })?.noticeEl?.addEventListener('click', () => {
            window.open(`${apiUrl}/pricing/`);
        });
    }

    private setStatusBar(icon: string, text: string): void {
        this.statusBarItem.empty();
        const iconEl = this.statusBarItem.createSpan({ cls: 'pensio-status-icon' });
        setIcon(iconEl, icon);
        this.statusBarItem.createSpan({ text, cls: 'pensio-status-text' });
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
    async verifyAccountBeforeSync(options: { reconnectOn401?: boolean } = {}): Promise<boolean> {
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
                new Notice(`Pensio: Cannot verify account — sync blocked. ${result.message}`);
                return false;
        }
    }

    /**
     * Handle token change detected in saveSettings().
     * Clears sync state preemptively — the account guard will
     * re-verify on next sync.
     */
    private async handleTokenChange(): Promise<void> {
        debugLog('Token change detected — clearing sync state');
        this.syncEngine.clearState();
        this.accountGuard.clearAccount();
        this._syncState = null;
    }

    /**
     * Compute a fingerprint of the current tokens for change detection.
     * Uses first 16 chars of each token so we detect changes without
     * storing full tokens again.
     */
    private tokenFingerprint(): string {
        const access = this._accessToken || '';
        const refresh = this._refreshToken || '';
        if (!access && !refresh) return '';
        return `${access.substring(0, 16)}:${refresh.substring(0, 16)}`;
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
     * Set tokens from external source (e.g. settings tab paste).
     * Persists to SecretStorage and initializes the API client.
     */
    async setTokens(
        accessToken: string,
        refreshToken: string,
        options: { keepSyncState?: boolean } = {}
    ): Promise<void> {
        this._accessToken = accessToken;
        this._refreshToken = refreshToken;
        await this.saveTokens();
        if (accessToken && refreshToken) {
            await this.apiClient.initializeTokens(accessToken, refreshToken);
        }
        // Detect change for account guard
        const currentFingerprint = this.tokenFingerprint();
        if (this._previousTokenFingerprint &&
            currentFingerprint &&
            currentFingerprint !== this._previousTokenFingerprint) {
            // A pairing keeps the sync state when it names whose it is: the
            // account guard compares that id on the next verify and clears it
            // on a switch. A hand-pasted token, or a state with no owner, is
            // cleared as before.
            if (options.keepSyncState && this._syncState?.userId) {
                this.accountGuard.clearAccount();
            } else {
                await this.handleTokenChange();
            }
        }
        this._previousTokenFingerprint = currentFingerprint;
        // Restart sync if appropriate
        this.syncEngine.stopWatching();
        if (this.settings.autoSync && this.settings.apiUrl && this._accessToken) {
            this.syncEngine.startWatching();
            this.syncEngine.startAutoSync();
        }
        // Re-pairing resets a dead session — clear the reconnect hint.
        this.updateStatusBar('idle');
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
