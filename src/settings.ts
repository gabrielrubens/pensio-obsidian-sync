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

        // --- Connection ---
        new Setting(containerEl).setName('Connection').setHeading();

        this.renderConnectionStatus(containerEl);

        // --- Sync folders ---
        new Setting(containerEl).setName('Sync folders').setHeading();

        new Setting(containerEl)
            .setName('Journal folder')
            .setDesc(
                'Each .md file in this folder becomes a journal entry in Pensio. ' +
                'Use frontmatter to control entry type (type: deep_dive) and date (date: 2025-01-15).'
            )
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
                        this.display();
                    }).open();
                }));

        new Setting(containerEl)
            .setName('People folder')
            .setDesc(
                'Each .md file becomes a relationship in Pensio. ' +
                'Use [[Name]] wikilinks in journal entries to connect entries to people automatically.'
            )
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
                        this.display();
                    }).open();
                }));

        new Setting(containerEl)
            .setName('Auto-sync')
            .setDesc('Automatically sync when files change')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSync)
                .onChange(async (value) => {
                    this.plugin.settings.autoSync = value;
                    await this.plugin.saveSettings();
                }));

        // --- Advanced ---
        new Setting(containerEl).setName('Advanced').setHeading();

        new Setting(containerEl)
            .setName('Server URL')
            .setDesc('Only change this if you self-host Pensio')
            .addText(text => text
                .setPlaceholder('https://www.pensio.app')
                .setValue(this.plugin.settings.apiUrl)
                .onChange(async (value) => {
                    this.plugin.settings.apiUrl = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Mirror delete')
            .setDesc(
                'Delete server entries that no longer exist in your vault. ' +
                'Web-created entries are never affected. Use with caution.'
            )
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableMirrorDelete)
                .onChange(async (value) => {
                    this.plugin.settings.enableMirrorDelete = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Debug mode')
            .setDesc('Enable verbose console logging for troubleshooting')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.debugMode)
                .onChange(async (value) => {
                    this.plugin.settings.debugMode = value;
                    await this.plugin.saveSettings();
                }));
    }

    /**
     * Render the connection section: tokens, status, and test button.
     */
    private renderConnectionStatus(containerEl: HTMLElement): void {
        const apiUrl = this.plugin.settings.apiUrl;
        const hasBothTokens = this.plugin.settings.apiToken && this.plugin.settings.refreshToken;

        // Token page link
        if (apiUrl) {
            new Setting(containerEl)
                .setName('Get your tokens')
                .setDesc('Open your Pensio settings page to generate API tokens, then paste them below.')
                .addButton(button => button
                    .setButtonText('Open token page')
                    .setCta()
                    .onClick(() => {
                        const tokenUrl = `${apiUrl.replace(/\/+$/, '')}/settings/#tokens`;
                        window.open(tokenUrl);
                    }));
        }

        // Access token
        new Setting(containerEl)
            .setName('Access token')
            .setDesc('Paste the access token from your Pensio settings page')
            .addText(text => {
                text
                    .setPlaceholder('Enter your access token')
                    .setValue(this.plugin.settings.apiToken)
                    .onChange(async (value) => {
                        this.plugin.settings.apiToken = value.trim();
                        await this.plugin.saveSettings();
                        if (this.plugin.settings.apiToken && this.plugin.settings.refreshToken) {
                            this.plugin.apiClient.updateSettings(this.plugin.settings);
                        }
                    });
                text.inputEl.type = 'password';
            });

        // Refresh token
        new Setting(containerEl)
            .setName('Refresh token')
            .setDesc('Paste the refresh token (valid 90 days). Both tokens are required.')
            .addText(text => {
                text
                    .setPlaceholder('Enter your refresh token')
                    .setValue(this.plugin.settings.refreshToken)
                    .onChange(async (value) => {
                        this.plugin.settings.refreshToken = value.trim();
                        await this.plugin.saveSettings();
                        if (this.plugin.settings.apiToken && this.plugin.settings.refreshToken) {
                            this.plugin.apiClient.updateSettings(this.plugin.settings);
                        }
                    });
                text.inputEl.type = 'password';
            });

        // Token status (only when connected)
        if (hasBothTokens) {
            const tokenManager = this.plugin.apiClient.getTokenManager();

            tokenManager.getTokenExpiry().then(expiry => {
                if (expiry) {
                    const timeUntilExpiry = expiry.getTime() - Date.now();
                    const hoursUntilExpiry = Math.floor(timeUntilExpiry / (1000 * 60 * 60));
                    const expiryText = hoursUntilExpiry > 0
                        ? `Token expires in ${hoursUntilExpiry}h — auto-refreshes`
                        : 'Token expired — will auto-refresh on next sync';

                    new Setting(containerEl)
                        .setName('Status')
                        .setDesc(expiryText);
                }
            });
        }

        // Test connection
        new Setting(containerEl)
            .setName('Test connection')
            .setDesc(hasBothTokens
                ? 'Verify your credentials work'
                : 'Paste both tokens above first')
            .addButton(button => {
                button
                    .setButtonText('Test')
                    .setDisabled(!hasBothTokens)
                    .onClick(async () => {
                        try {
                            button.setDisabled(true);
                            button.setButtonText('Testing...');
                            const status = await this.plugin.apiClient.getSyncStatus();
                            new Notice(`Connected! ${status.total_entries} entries synced`);
                            button.setButtonText('Connected');
                        } catch (error) {
                            new Notice(`Connection failed: ${error.message}`);
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
    }
}
