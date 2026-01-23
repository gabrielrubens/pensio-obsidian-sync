import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import JournalWisePlugin from './main';

export class JournalWiseSettingTab extends PluginSettingTab {
    plugin: JournalWisePlugin;

    constructor(app: App, plugin: JournalWisePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        containerEl.createEl('h2', { text: 'Journal Wise Sync Settings' });

        // Connection settings
        containerEl.createEl('h3', { text: 'Connection' });

        new Setting(containerEl)
            .setName('API URL')
            .setDesc('Your Journal Wise server URL (e.g., https://journal.example.com)')
            .addText(text => text
                .setPlaceholder('https://journal.example.com')
                .setValue(this.plugin.settings.apiUrl)
                .onChange(async (value) => {
                    this.plugin.settings.apiUrl = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('API Token')
            .setDesc('Your authentication token (generate in Journal Wise web UI)')
            .addText(text => {
                text
                    .setPlaceholder('Enter your API token')
                    .setValue(this.plugin.settings.apiToken)
                    .onChange(async (value) => {
                        this.plugin.settings.apiToken = value.trim();
                        await this.plugin.saveSettings();
                    });
                text.inputEl.type = 'password';
            });

        new Setting(containerEl)
            .setName('Device name')
            .setDesc('Name for this device (helps identify tokens)')
            .addText(text => text
                .setPlaceholder('My Laptop')
                .setValue(this.plugin.settings.deviceName)
                .onChange(async (value) => {
                    this.plugin.settings.deviceName = value;
                    await this.plugin.saveSettings();
                }));

        // Test connection button
        new Setting(containerEl)
            .setName('Test connection')
            .setDesc('Verify your API credentials')
            .addButton(button => button
                .setButtonText('Test')
                .onClick(async () => {
                    try {
                        button.setDisabled(true);
                        button.setButtonText('Testing...');

                        const status = await this.plugin.apiClient.getSyncStatus();
                        new Notice(`✓ Connected! ${status.total_entries} entries synced`);
                        button.setButtonText('Success');
                    } catch (error) {
                        new Notice(`✗ Connection failed: ${error.message}`);
                        button.setButtonText('Failed');
                        console.error('Connection test failed:', error);
                    } finally {
                        setTimeout(() => {
                            button.setDisabled(false);
                            button.setButtonText('Test');
                        }, 2000);
                    }
                }));

        // Sync settings
        containerEl.createEl('h3', { text: 'Sync Options' });

        new Setting(containerEl)
            .setName('Auto-sync')
            .setDesc('Automatically sync when files change')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSync)
                .onChange(async (value) => {
                    this.plugin.settings.autoSync = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Sync interval')
            .setDesc('How often to sync in minutes (when auto-sync is enabled)')
            .addSlider(slider => slider
                .setLimits(1, 60, 1)
                .setValue(this.plugin.settings.syncInterval)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.syncInterval = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Sync folders')
            .setDesc('Comma-separated folders to sync (e.g., "Journal, People")')
            .addText(text => text
                .setPlaceholder('Journal, People')
                .setValue(this.plugin.settings.syncFolders.join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.syncFolders = value
                        .split(',')
                        .map(f => f.trim())
                        .filter(f => f.length > 0);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Exclude patterns')
            .setDesc('Comma-separated glob patterns to exclude (e.g., ".trash/**, .obsidian/**")')
            .addText(text => text
                .setPlaceholder('.trash/**, .obsidian/**')
                .setValue(this.plugin.settings.excludePatterns.join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.excludePatterns = value
                        .split(',')
                        .map(p => p.trim())
                        .filter(p => p.length > 0);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Conflict resolution')
            .setDesc('How to handle sync conflicts')
            .addDropdown(dropdown => dropdown
                .addOption('server-wins', 'Server wins (always use server version)')
                .addOption('local-wins', 'Local wins (always use local version)')
                .addOption('ask', 'Ask me each time')
                .setValue(this.plugin.settings.conflictResolution)
                .onChange(async (value: 'server-wins' | 'local-wins' | 'ask') => {
                    this.plugin.settings.conflictResolution = value;
                    await this.plugin.saveSettings();
                }));

        // Advanced settings
        containerEl.createEl('h3', { text: 'Advanced' });

        new Setting(containerEl)
            .setName('Max entry size (MB)')
            .setDesc('Maximum size for syncing a single entry')
            .addSlider(slider => slider
                .setLimits(1, 10, 1)
                .setValue(this.plugin.settings.maxEntrySizeMB)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxEntrySizeMB = value;
                    await this.plugin.saveSettings();
                }));

        // Device info (read-only)
        if (this.plugin.settings.deviceId) {
            new Setting(containerEl)
                .setName('Device ID')
                .setDesc('Unique identifier for this device')
                .addText(text => {
                    text.setValue(this.plugin.settings.deviceId);
                    text.inputEl.disabled = true;
                });
        }
    }
}
