import { Notice, Plugin } from 'obsidian';
import { ApiClient } from './api/client';
import { AccountGuard } from './auth/accountGuard';
import { debugLog, setDebugMode } from './logger';
import { PensioSettingTab } from './settings';
import { SyncEngine } from './sync/engine';
import { DEFAULT_SETTINGS, PensioSettings, SyncStateData } from './types';

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

        new Notice('Pensio plugin loaded');
    }

    onunload() {
        this.syncEngine.stopWatching();
        this.apiClient.destroy();
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

        // Migrate legacy journalFolder → journalFolders (pre-v0.1.4)
        if (this.settings.journalFolder && (!this.settings.journalFolders || this.settings.journalFolders.length === 0)) {
            this.settings.journalFolders = [
                { folder: this.settings.journalFolder, entryType: 'daily_journal', label: 'Daily Journal' },
            ];
            this.settings.journalFolder = '';
            await this.saveData({ ...this.settings, _syncState: this._syncState });
        }
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
                new Notice('Starting incremental sync...');
                try {
                    if (!await this.verifyAccountBeforeSync()) return;
                    const result = await this.syncEngine.syncAll(false);
                    new Notice(`Sync done: ${result.synced} synced, ${result.skipped} unchanged, ${result.total} total files`);
                } catch (error) {
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
                new Notice('Starting force sync (all files)...');
                try {
                    if (!await this.verifyAccountBeforeSync()) return;
                    const result = await this.syncEngine.syncAll(true);
                    new Notice(`Force sync done: ${result.synced} synced, ${result.skipped} unchanged, ${result.total} total files`);
                } catch (error) {
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

                new Notice(`Syncing ${file.name}...`);
                try {
                    if (!await this.verifyAccountBeforeSync()) return;
                    this.syncEngine.markDirty(file.path);
                    const result = await this.syncEngine.syncAll(false);
                    new Notice(`File sync done: ${result.synced} synced`);
                } catch (error) {
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
                    new Notice(
                        `${accountLine}` +
                        `Total entries: ${status.total_entries}\n` +
                        `Conflicts: ${status.conflict_count}\n` +
                        `Pending: ${status.pending_changes}`
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
                this._accessToken = '';
                this._refreshToken = '';
                await this.saveTokens();
                this.syncEngine.clearState();
                this.accountGuard.clearAccount();
                this._syncState = null;
                await this.saveSettings();
                new Notice('Logged out — tokens and sync state cleared');
            }
        });
    }

    updateStatusBar(status: 'idle' | 'syncing' | 'error' | 'success') {
        const icons = {
            idle: '☁️',
            syncing: '🔄',
            error: '⚠️',
            success: '✅'
        };

        this.statusBarItem.setText(`${icons[status]} Pensio`);

        // Reset to idle after success/error
        if (status === 'success' || status === 'error') {
            setTimeout(() => this.updateStatusBar('idle'), 3000);
        }
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
     * Save current in-memory tokens to SecretStorage.
     * Also called by the onTokensChanged callback after refresh.
     */
    async saveTokens(): Promise<void> {
        try {
            if (this._accessToken) {
                this.app.secretStorage.setSecret(PensioPlugin.SECRET_ACCESS_TOKEN, this._accessToken);
            } else {
                this.app.secretStorage.setSecret(PensioPlugin.SECRET_ACCESS_TOKEN, '');
            }
            if (this._refreshToken) {
                this.app.secretStorage.setSecret(PensioPlugin.SECRET_REFRESH_TOKEN, this._refreshToken);
            } else {
                this.app.secretStorage.setSecret(PensioPlugin.SECRET_REFRESH_TOKEN, '');
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
