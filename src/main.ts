import { Notice, Plugin } from 'obsidian';
import { ApiClient } from './api/client';
import { setDebugMode } from './logger';
import { PensioSettingTab } from './settings';
import { SyncEngine } from './sync/engine';
import { DEFAULT_SETTINGS, PensioSettings } from './types';

export default class PensioPlugin extends Plugin {
    settings: PensioSettings;
    apiClient: ApiClient;
    syncEngine: SyncEngine;
    statusBarItem: HTMLElement;

    async onload() {
        // Load settings
        await this.loadSettings();
        setDebugMode(this.settings.debugMode);

        // Initialize API client
        this.apiClient = new ApiClient(this.settings);

        // Initialize sync engine
        this.syncEngine = new SyncEngine(this.app, this.settings, this.apiClient);

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
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

        // Migrate legacy journalFolder → journalFolders (pre-v0.1.4)
        if (this.settings.journalFolder && (!this.settings.journalFolders || this.settings.journalFolders.length === 0)) {
            this.settings.journalFolders = [
                { folder: this.settings.journalFolder, entryType: 'daily_journal', label: 'Daily Journal' },
            ];
            this.settings.journalFolder = '';
            await this.saveData(this.settings);
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
        setDebugMode(this.settings.debugMode);

        // Update API client with new settings
        this.apiClient.updateSettings(this.settings);

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
                    new Notice(
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
                await this.saveSettings();
                new Notice('API token cleared');
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
}
