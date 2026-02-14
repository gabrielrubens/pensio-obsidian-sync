import { App, FuzzySuggestModal, Notice, PluginSettingTab, Setting, TFolder } from 'obsidian';
import PensioPlugin from './main';

/**
 * Folder suggest modal for selecting folders
 */
class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
    private onChooseFolderCallback: (folder: TFolder) => void;

    constructor(app: App, onChooseFolder: (folder: TFolder) => void) {
        super(app);
        this.onChooseFolderCallback = onChooseFolder;
    }

    getItems(): TFolder[] {
        const folders: TFolder[] = [];
        const rootFolder = this.app.vault.getRoot();

        const addFolders = (folder: TFolder) => {
            folders.push(folder);
            for (const child of folder.children) {
                if (child instanceof TFolder) {
                    addFolders(child);
                }
            }
        };

        addFolders(rootFolder);
        return folders;
    }

    getItemText(folder: TFolder): string {
        return folder.path || '/';
    }

    onChooseItem(folder: TFolder, evt: MouseEvent | KeyboardEvent): void {
        this.onChooseFolderCallback(folder);
    }
}

export class PensioSettingTab extends PluginSettingTab {
    plugin: PensioPlugin;

    constructor(app: App, plugin: PensioPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        containerEl.createEl('h2', { text: 'Pensio Sync Settings' });

        // Connection settings
        containerEl.createEl('h3', { text: 'Connection' });

        new Setting(containerEl)
            .setName('API URL')
            .setDesc('Your Pensio server URL (e.g., https://journal.example.com)')
            .addText(text => text
                .setPlaceholder('https://journal.example.com')
                .setValue(this.plugin.settings.apiUrl)
                .onChange(async (value) => {
                    this.plugin.settings.apiUrl = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Access Token')
            .setDesc('Your access token (24-hour validity). Get both tokens from: curl -X POST http://localhost:8000/api/v1/auth/token/ with your email/password')
            .addText(text => {
                text
                    .setPlaceholder('Enter your access token')
                    .setValue(this.plugin.settings.apiToken)
                    .onChange(async (value) => {
                        this.plugin.settings.apiToken = value.trim();
                        await this.plugin.saveSettings();
                        // Reinitialize if both tokens are now present
                        if (this.plugin.settings.apiToken && this.plugin.settings.refreshToken) {
                            this.plugin.apiClient.updateSettings(this.plugin.settings);
                        }
                    });
                text.inputEl.type = 'password';
            });

        new Setting(containerEl)
            .setName('Refresh Token')
            .setDesc('Your refresh token (90-day validity). REQUIRED: You must provide BOTH tokens for authentication to work.')
            .addText(text => {
                text
                    .setPlaceholder('Enter your refresh token')
                    .setValue(this.plugin.settings.refreshToken)
                    .onChange(async (value) => {
                        this.plugin.settings.refreshToken = value.trim();
                        await this.plugin.saveSettings();
                        // Reinitialize if both tokens are now present
                        if (this.plugin.settings.apiToken && this.plugin.settings.refreshToken) {
                            this.plugin.apiClient.updateSettings(this.plugin.settings);
                        }
                    });
                text.inputEl.type = 'password';
            });

        // Token status and management
        const tokenManager = this.plugin.apiClient.getTokenManager();

        // Show token storage method
        const storageMethod = tokenManager.getStorageMethod();
        new Setting(containerEl)
            .setName('Token Storage')
            .setDesc(`Current method: ${storageMethod}`)
            .setClass('setting-item-description');

        // Token expiry display
        tokenManager.getTokenExpiry().then(expiry => {
            if (expiry) {
                const timeUntilExpiry = expiry.getTime() - Date.now();
                const hoursUntilExpiry = Math.floor(timeUntilExpiry / (1000 * 60 * 60));
                const expiryText = hoursUntilExpiry > 0
                    ? `Token expires in ${hoursUntilExpiry} hours (${expiry.toLocaleString()})`
                    : 'Token expired';

                new Setting(containerEl)
                    .setName('Token Status')
                    .setDesc(expiryText)
                    .addButton(button => button
                        .setButtonText('Refresh Now')
                        .onClick(async () => {
                            try {
                                button.setDisabled(true);
                                button.setButtonText('Refreshing...');
                                await this.plugin.apiClient.refreshToken();
                                new Notice('✓ Token refreshed successfully');
                                button.setButtonText('Success');
                                // Refresh the settings display
                                setTimeout(() => this.display(), 1000);
                            } catch (error) {
                                new Notice(`✗ Failed to refresh token: ${error.message}`);
                                button.setButtonText('Failed');
                                console.error('Token refresh failed:', error);
                            } finally {
                                setTimeout(() => {
                                    button.setDisabled(false);
                                    button.setButtonText('Refresh Now');
                                }, 2000);
                            }
                        }));
            }
        });

        // Test connection button
        const hasBothTokens = this.plugin.settings.apiToken && this.plugin.settings.refreshToken;
        new Setting(containerEl)
            .setName('Test connection')
            .setDesc(hasBothTokens
                ? 'Verify your API credentials'
                : '⚠️ Please provide both Access Token and Refresh Token first')
            .addButton(button => {
                button
                    .setButtonText('Test')
                    .setDisabled(!hasBothTokens)
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
                    });
            });

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

        // Folder pickers
        containerEl.createEl('h3', { text: 'Sync Folders' });

        new Setting(containerEl)
            .setName('Journal folder')
            .setDesc('Folder containing journal entries')
            .addText(text => {
                text
                    .setPlaceholder('Journal')
                    .setValue(this.plugin.settings.journalFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.journalFolder = value.trim();
                        await this.plugin.saveSettings();
                    });
            })
            .addButton(button => button
                .setButtonText('Browse')
                .onClick(() => {
                    new FolderSuggestModal(this.app, async (folder) => {
                        this.plugin.settings.journalFolder = folder.path;
                        await this.plugin.saveSettings();
                        this.display(); // Refresh settings display
                    }).open();
                }));

        new Setting(containerEl)
            .setName('Prompts folder')
            .setDesc('Folder containing writing prompts')
            .addText(text => {
                text
                    .setPlaceholder('Prompts')
                    .setValue(this.plugin.settings.promptFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.promptFolder = value.trim();
                        await this.plugin.saveSettings();
                    });
            })
            .addButton(button => button
                .setButtonText('Browse')
                .onClick(() => {
                    new FolderSuggestModal(this.app, async (folder) => {
                        this.plugin.settings.promptFolder = folder.path;
                        await this.plugin.saveSettings();
                        this.display(); // Refresh settings display
                    }).open();
                }));

        new Setting(containerEl)
            .setName('People folder')
            .setDesc('Folder containing people notes')
            .addText(text => {
                text
                    .setPlaceholder('People')
                    .setValue(this.plugin.settings.peopleFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.peopleFolder = value.trim();
                        await this.plugin.saveSettings();
                    });
            })
            .addButton(button => button
                .setButtonText('Browse')
                .onClick(() => {
                    new FolderSuggestModal(this.app, async (folder) => {
                        this.plugin.settings.peopleFolder = folder.path;
                        await this.plugin.saveSettings();
                        this.display(); // Refresh settings display
                    }).open();
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
