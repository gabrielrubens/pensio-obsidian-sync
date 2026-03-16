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
    /** Tracks the token values that were last used, to detect manual changes */
    private _previousTokenFingerprint: string = '';

    async onload() {
        // Load settings
        await this.loadSettings();
        setDebugMode(this.settings.debugMode);

        // Initialize API client
        this.apiClient = new ApiClient(this.settings);

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
        if (this.settings.autoSync && this.settings.apiUrl && this.settings.apiToken) {
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
        if (this.settings.autoSync && this.settings.apiUrl && this.settings.apiToken) {
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
                    await this.syncEngine.syncAll(false);  // Incremental sync
                    new Notice('Sync completed successfully');
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
                    await this.syncEngine.syncAll(true);  // Force sync
                    new Notice('Force sync completed successfully');
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
                    await this.syncEngine.syncFile(file);
                    new Notice('File synced successfully');
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
                this.settings.apiToken = '';
                this.settings.refreshToken = '';
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
        if (!this.settings.apiToken || !this.settings.refreshToken) {
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
        const access = this.settings.apiToken || '';
        const refresh = this.settings.refreshToken || '';
        if (!access && !refresh) return '';
        return `${access.substring(0, 16)}:${refresh.substring(0, 16)}`;
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
