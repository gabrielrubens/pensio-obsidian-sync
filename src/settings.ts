import { App, FuzzySuggestModal, Notice, PluginSettingTab, Setting, TFolder } from 'obsidian';
import PensioPlugin from './main';
import { ENTRY_TYPES } from './types';

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

        // Journal folders (multi-folder with entry type mapping)
        const journalDesc = containerEl.createEl('p', {
            cls: 'setting-item-description',
            text: 'Map vault folders to Pensio entry types. Each .md file in a folder becomes a journal entry of the mapped type. Frontmatter "type:" overrides the folder mapping.',
        });
        journalDesc.style.marginBottom = '8px';

        // Render each existing mapping
        for (let i = 0; i < this.plugin.settings.journalFolders.length; i++) {
            this.renderFolderMapping(containerEl, i);
        }

        // Add folder button
        new Setting(containerEl)
            .addButton(button => button
                .setButtonText('+ Add journal folder')
                .onClick(async () => {
                    this.plugin.settings.journalFolders.push({
                        folder: '',
                        entryType: 'daily_journal',
                        label: 'Daily Journal',
                    });
                    await this.plugin.saveSettings();
                    this.display();
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
     * Render a single journal folder mapping row.
     * Shows: [folder text + browse] [entry type dropdown] [remove button]
     */
    private renderFolderMapping(containerEl: HTMLElement, index: number): void {
        const mapping = this.plugin.settings.journalFolders[index];

        const setting = new Setting(containerEl)
            .setName(`Folder ${index + 1}`)
            .addText(text => {
                text
                    .setPlaceholder('Folder path')
                    .setValue(mapping.folder)
                    .onChange(async (value) => {
                        this.plugin.settings.journalFolders[index].folder = value.trim();
                        await this.plugin.saveSettings();
                    });
            })
            .addButton(button => button
                .setButtonText('Browse')
                .onClick(() => {
                    new FolderSuggestModal(this.app, async (folder) => {
                        this.plugin.settings.journalFolders[index].folder = folder.path;
                        await this.plugin.saveSettings();
                        this.display();
                    }).open();
                }))
            .addDropdown(dropdown => {
                for (const type of ENTRY_TYPES) {
                    dropdown.addOption(type.value, type.label);
                }
                dropdown.setValue(mapping.entryType);
                dropdown.onChange(async (value) => {
                    this.plugin.settings.journalFolders[index].entryType = value;
                    const matched = ENTRY_TYPES.find(t => t.value === value);
                    this.plugin.settings.journalFolders[index].label = matched?.label || value;
                    await this.plugin.saveSettings();
                });
            });

        // Only show remove button if there's more than one folder
        if (this.plugin.settings.journalFolders.length > 1) {
            setting.addButton(button => button
                .setButtonText('Remove')
                .setWarning()
                .onClick(async () => {
                    this.plugin.settings.journalFolders.splice(index, 1);
                    await this.plugin.saveSettings();
                    this.display();
                }));
        }
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
            .setDesc('Verify your credentials work')
            .addButton(button => {
                button
                    .setButtonText('Test')
                    .onClick(async () => {
                        if (!this.plugin.settings.apiToken || !this.plugin.settings.refreshToken) {
                            new Notice('Please paste both tokens above first');
                            return;
                        }
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
