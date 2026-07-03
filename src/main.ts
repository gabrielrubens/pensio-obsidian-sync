import { Notice, Plugin, setIcon } from 'obsidian';
import { ApiClient } from './api/client';
import { AccountGuard } from './auth/accountGuard';
import { debugLog, setDebugMode } from './logger';
import { PensioSettingTab } from './settings';
import { SyncEngine } from './sync/engine';
import { DEFAULT_SETTINGS, JournalFolderMapping, PensioSettings, SyncStateData } from './types';

/** Pre-0.3.0 folder mappings carried extra per-folder fields. */
interface LegacyFolderMapping extends JournalFolderMapping {
    entryType?: string;
    label?: string;
}

type StatusBarState = 'idle' | 'syncing' | 'error' | 'success' | 'reconnect';

export default class PensioPlugin extends Plugin {
    settings: PensioSettings;
    apiClient: ApiClient;
    syncEngine: SyncEngine;
    accountGuard: AccountGuard;
    statusBarItem: HTMLElement;
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
            new Notice('Pensio: session expired. Open Settings → Pensio Journaling Sync and enter a new setup code.');
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

        // Snapshot current tokens for change detection
        this._previousTokenFingerprint = this.tokenFingerprint();

        // Add status bar item
        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar('idle');

        // Add settings tab
        this.addSettingTab(new PensioSettingTab(this.app, this));

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
        const rawData = (await this.loadData()) || {};

        // Extract sync state before merging with settings defaults
        this._syncState = rawData._syncState || null;
        const settingsData = { ...rawData };
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
            setTimeout(async () => {
                await this.saveTokens();
                await this.saveData({ ...this.settings, _syncState: this._syncState });
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
            const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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
        const dataToSave: Record<string, any> = { ...this.settings };
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
                    new Notice(`Sync failed: ${error.message}`);
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
                    new Notice(`Sync failed: ${error.message}`);
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
                    new Notice('Current file is not a markdown file');
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
                    new Notice(`Sync failed: ${error.message}`);
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
                    new Notice(
                        `${accountLine}` +
                        `Server entries: ${status.total_entries}\n` +
                        `Local tracked files: ${trackedFiles}`
                    );
                } catch (error) {
                    new Notice(`Failed to get status: ${error.message}`);
                    console.error('Status error:', error);
                }
            }
        });

        // Clear API token
        this.addCommand({
            id: 'logout',
            name: 'Logout (clear API token)',
            callback: async () => {
                await this.logout();
            }
        });
    }

    /**
     * Logout: clear tokens, sync state, and account cache.
     * Called by both the command and the settings tab.
     */
    async logout(): Promise<void> {
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
        new Notice('Logged out \u2014 tokens and sync state cleared');
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
                setTimeout(() => this.updateStatusBar('idle'), 3000);
                break;
            case 'error':
                this.setStatusBar('alert-triangle', 'Sync error');
                setTimeout(() => this.updateStatusBar('idle'), 5000);
                break;
            case 'reconnect':
                this.setStatusBar('cloud-off', 'Reconnect Pensio');
                break;
        }
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
    async verifyAccountBeforeSync(): Promise<boolean> {
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
    async setTokens(accessToken: string, refreshToken: string): Promise<void> {
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
            await this.handleTokenChange();
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
        const dataToSave: Record<string, any> = { ...this.settings };
        dataToSave._syncState = state;
        await this.saveData(dataToSave);
    }
}
