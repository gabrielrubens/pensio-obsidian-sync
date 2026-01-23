import { Notice, Plugin } from 'obsidian';
import { ApiClient } from './api/client';
import { JournalWiseSettingTab } from './settings';
import { SyncEngine } from './sync/engine';
import { DEFAULT_SETTINGS, JournalWiseSettings } from './types';

export default class JournalWisePlugin extends Plugin {
    settings: JournalWiseSettings;
    apiClient: ApiClient;
    syncEngine: SyncEngine;
    statusBarItem: HTMLElement;

    async onload() {
        console.log('Loading Journal Wise plugin');

        // Load settings
        await this.loadSettings();

        // Initialize API client
        this.apiClient = new ApiClient(this.settings);

        // Initialize sync engine
        this.syncEngine = new SyncEngine(this.app, this.settings, this.apiClient);

        // Add status bar item
        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar('idle');

        // Add settings tab
        this.addSettingTab(new JournalWiseSettingTab(this.app, this));

        // Register commands
        this.registerCommands();

        // Start file watcher if configured
        if (this.settings.autoSync && this.settings.apiUrl && this.settings.apiToken) {
            this.syncEngine.startWatching();
        }

        new Notice('Journal Wise plugin loaded');
    }

    onunload() {
        console.log('Unloading Journal Wise plugin');
        this.syncEngine.stopWatching();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);

        // Update API client with new settings
        this.apiClient.updateSettings(this.settings);

        // Restart watcher if auto-sync is enabled
        this.syncEngine.stopWatching();
        if (this.settings.autoSync && this.settings.apiUrl && this.settings.apiToken) {
            this.syncEngine.startWatching();
        }
    }

    registerCommands() {
        // Manual sync command
        this.addCommand({
            id: 'sync-now',
            name: 'Sync now',
            callback: async () => {
                new Notice('Starting sync...');
                try {
                    await this.syncEngine.syncAll();
                    new Notice('Sync completed successfully');
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

        this.statusBarItem.setText(`${icons[status]} Journal Wise`);

        // Reset to idle after success/error
        if (status === 'success' || status === 'error') {
            setTimeout(() => this.updateStatusBar('idle'), 3000);
        }
    }
}
