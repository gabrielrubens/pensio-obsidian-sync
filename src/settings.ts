import { App, FuzzySuggestModal, normalizePath, PluginSettingTab, Setting, TFolder } from 'obsidian';
import { ConnectionSection } from './connectionSection';
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
    private connection: ConnectionSection;

    constructor(app: App, plugin: PensioPlugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.connection = new ConnectionSection(plugin, () => this.display());
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        // --- Pensio branding ---
        this.renderBranding(containerEl);

        // --- Connection ---
        new Setting(containerEl).setName('Connection').setHeading();

        this.connection.render(containerEl);

        // --- Sync folders ---
        new Setting(containerEl).setName('Sync folders').setHeading();

        containerEl.createEl('p', {
            cls: 'setting-item-description pensio-folder-desc',
            text: 'Add folders containing journal files. All .md files sync as Daily Journal entries. Use frontmatter "type:" to override per file.',
        });

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
                        this.plugin.settings.peopleFolder = normalizePath(value.trim());
                        await this.plugin.saveSettings();
                    });
            })
            .addButton(button => button
                .setButtonText('Browse')
                .onClick(() => {
                    new FolderSuggestModal(this.app, (folder) => {
                        void (async () => {
                            this.plugin.settings.peopleFolder = folder.path;
                            await this.plugin.saveSettings();
                            this.display();
                        })();
                    }).open();
                }));

        new Setting(containerEl)
            .setName('Auto-sync')
            .setDesc('Automatically sync when files change and run periodic sync every 5 minutes')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoSync)
                .onChange(async (value) => {
                    this.plugin.settings.autoSync = value;
                    await this.plugin.saveSettings();
                }));

        // --- Links ---
        new Setting(containerEl).setName('Links').setHeading();

        new Setting(containerEl)
            .setName('Documentation')
            .setDesc('Setup guide, features, and troubleshooting')
            .addButton(button => button
                .setButtonText('Open docs')
                .onClick(() => {
                    window.open('https://pensio.app/features/obsidian-sync/');
                }));

        new Setting(containerEl)
            .setName('Report an issue')
            .setDesc('Found a bug or have a suggestion?')
            .addButton(button => button
                .setButtonText('Open GitHub')
                .onClick(() => {
                    window.open('https://github.com/gabrielrubens/pensio-obsidian-sync/issues');
                }));

        // --- Advanced ---
        new Setting(containerEl).setName('Advanced').setHeading();

        new Setting(containerEl)
            .setName('Server URL')
            .setDesc('For development or testing only')
            .addText(text => text
                .setPlaceholder('https://pensio.app')
                .setValue(this.plugin.settings.apiUrl)
                .onChange(async (value) => {
                    this.plugin.settings.apiUrl = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Mirror delete')
            .setDesc(
                'Delete server entries that no longer exist in your vault. ' +
                'Only affects entries created by this plugin — web-created entries are never touched. Use with caution.'
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

        // Manual token entry — for self-hosters who prefer pasting JWTs over
        // the setup-code pairing. The normal path is the Setup code above.
        new Setting(containerEl)
            .setName('Access token')
            .setDesc('Manual token entry (advanced) — prefer the setup code')
            .addText(text => {
                text
                    .setPlaceholder('Access token')
                    .setValue(this.plugin.getAccessToken())
                    .onChange(async (value) => {
                        await this.plugin.setTokens(value.trim(), this.plugin.getRefreshToken());
                    });
                text.inputEl.type = 'password';
            });

        new Setting(containerEl)
            .setName('Refresh token')
            .setDesc('Both tokens are required when entered manually')
            .addText(text => {
                text
                    .setPlaceholder('Refresh token')
                    .setValue(this.plugin.getRefreshToken())
                    .onChange(async (value) => {
                        await this.plugin.setTokens(this.plugin.getAccessToken(), value.trim());
                    });
                text.inputEl.type = 'password';
            });

        this.connection.renderTestButton(containerEl);
    }

    /**
     * Render the Pensio branding block at the top of settings.
     */
    private renderBranding(containerEl: HTMLElement): void {
        const brandingEl = containerEl.createDiv({ cls: 'pensio-branding' });

        const titleRow = brandingEl.createDiv({ cls: 'pensio-branding-title' });
        titleRow.createSpan({ text: '✦ ', cls: 'pensio-branding-icon' });
        titleRow.createSpan({ text: 'Pensio', cls: 'pensio-branding-name' });
        titleRow.createSpan({ text: 'Beta', cls: 'pensio-beta-badge' });

        brandingEl.createEl('p', {
            cls: 'pensio-branding-tagline',
            text: 'AI-powered journaling \u2014 emotion tracking, insights, relationship mapping, and an AI advisor that knows your entire journal.',
        });

        const learnMore = brandingEl.createEl('a', {
            text: 'Learn more at pensio.app',
            href: 'https://pensio.app',
            cls: 'pensio-branding-link',
        });
        learnMore.setAttr('target', '_blank');
    }

    /**
     * Render a single journal folder mapping row.
     * Shows: [folder text + browse] [remove button]
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
                        this.plugin.settings.journalFolders[index].folder = normalizePath(value.trim());
                        await this.plugin.saveSettings();
                    });
            })
            .addButton(button => button
                .setButtonText('Browse')
                .onClick(() => {
                    new FolderSuggestModal(this.app, (folder) => {
                        void (async () => {
                            this.plugin.settings.journalFolders[index].folder = folder.path;
                            await this.plugin.saveSettings();
                            this.display();
                        })();
                    }).open();
                }));

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

}
