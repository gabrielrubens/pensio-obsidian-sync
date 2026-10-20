import { App, normalizePath, PluginSettingTab, SettingDefinition, SettingDefinitionItem } from 'obsidian';
import { ConnectionSection } from './connectionSection';
import PensioPlugin from './main';
import { JournalFolderMapping } from './types';

/** The control key of the journal folder at `index`: `journalFolders.<index>`. */
const journalFolderKey = (index: number): string => `journalFolders.${index}`;

function journalFolderIndex(key: string): number | null {
    const match = /^journalFolders\.(\d+)$/.exec(key);
    return match ? Number(match[1]) : null;
}

/** A folder as it is stored: trimmed and normalized, and empty when cleared. */
function cleanFolder(value: unknown): string {
    const trimmed = (typeof value === 'string' ? value : '').trim();
    return trimmed ? normalizePath(trimmed) : '';
}

/**
 * The settings tab, built from setting definitions (Obsidian 1.13's
 * declarative settings API), so every setting is found by Obsidian's settings
 * search.
 *
 * ⛔ Nothing here calls `display()` or `setWarning()`: both are deprecated
 * since 1.13.0, and the Community plugin review reports each one. Re-rendering
 * is `update()`, which builds the definitions again; a destructive button is
 * `setDestructive()`. `minAppVersion` is 1.13.0 for exactly this.
 *
 * ⛔ Every control writes through `setControlValue` below, never the
 * framework's default — see it for why.
 */
export class PensioSettingTab extends PluginSettingTab {
    plugin: PensioPlugin;
    private connection: ConnectionSection;

    constructor(app: App, plugin: PensioPlugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.connection = new ConnectionSection(plugin, () => this.update());
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            this.brandingDefinition(),
            { type: 'group', heading: 'Connection', items: this.connection.definitions() },
            this.journalFolderList(),
            {
                type: 'group',
                items: [
                    {
                        name: 'People folder',
                        desc:
                            'Each .md file becomes a relationship in Pensio. ' +
                            'Use [[Name]] wikilinks in journal entries to connect entries to people automatically.',
                        control: { type: 'folder', key: 'peopleFolder', placeholder: 'People' },
                    },
                    {
                        name: 'Auto-sync',
                        desc: 'Automatically sync when files change and run periodic sync every 5 minutes',
                        control: { type: 'toggle', key: 'autoSync' },
                    },
                ],
            },
            {
                type: 'group',
                heading: 'Links',
                items: [
                    {
                        name: 'Documentation',
                        desc: 'Setup guide, features, and troubleshooting',
                        action: () => {
                            window.open('https://pensio.app/features/obsidian-sync/');
                        },
                    },
                    {
                        name: 'Report an issue',
                        desc: 'Found a bug or have a suggestion?',
                        action: () => {
                            window.open('https://github.com/gabrielrubens/pensio-obsidian-sync/issues');
                        },
                    },
                ],
            },
            {
                type: 'group',
                heading: 'Advanced',
                items: [
                    {
                        name: 'Server URL',
                        desc: 'For development or testing only',
                        control: { type: 'text', key: 'apiUrl', placeholder: 'https://pensio.app' },
                    },
                    {
                        name: 'Mirror delete',
                        desc:
                            'Delete server entries that no longer exist in your vault. ' +
                            'Only affects entries created by this plugin — web-created entries are never touched. Use with caution.',
                        control: { type: 'toggle', key: 'enableMirrorDelete' },
                    },
                    {
                        name: 'Debug mode',
                        desc: 'Enable verbose console logging for troubleshooting',
                        control: { type: 'toggle', key: 'debugMode' },
                    },
                    // Manual token entry — for self-hosters who prefer pasting
                    // JWTs over connecting. The normal path is Connect above.
                    // ⚠️ Not a `secret` control: that one stores the NAME of a
                    // secret the person picks from Obsidian's keychain, and these
                    // are the token values themselves, kept by the plugin.
                    this.tokenDefinition(
                        'Access token',
                        'Manual token entry (advanced) — prefer Connect',
                        () => this.plugin.getAccessToken(),
                        (value) => this.plugin.setTokens(value, this.plugin.getRefreshToken()),
                    ),
                    this.tokenDefinition(
                        'Refresh token',
                        'Both tokens are required when entered manually',
                        () => this.plugin.getRefreshToken(),
                        (value) => this.plugin.setTokens(this.plugin.getAccessToken(), value),
                    ),
                    this.connection.testDefinition(),
                ],
            },
        ];
    }

    getControlValue(key: string): unknown {
        const folder = journalFolderIndex(key);
        if (folder !== null) {
            return this.plugin.settings.journalFolders[folder]?.folder ?? '';
        }
        return (this.plugin.settings as unknown as Record<string, unknown>)[key];
    }

    /**
     * ⛔ Every write goes through `plugin.saveSettings()`. The framework's
     * default writes `saveData(this.plugin.settings)`, which would drop
     * `_syncState` from data.json — so any toggle would forget which files
     * were synced, and the next sync would check the whole vault again — and
     * would skip the rest of `saveSettings()`: a new Server URL would never
     * reach the API client, and switching Auto-sync off would leave the file
     * watcher syncing until Obsidian restarted.
     * 🧪 `settingDefinitions.test.ts` drives the real `saveSettings()`.
     */
    async setControlValue(key: string, value: unknown): Promise<void> {
        const settings = this.plugin.settings;
        const folder = journalFolderIndex(key);
        if (folder !== null) {
            if (!settings.journalFolders[folder]) return;
            settings.journalFolders[folder].folder = cleanFolder(value);
        } else if (key === 'peopleFolder') {
            settings.peopleFolder = cleanFolder(value);
        } else if (key === 'apiUrl') {
            settings.apiUrl = (typeof value === 'string' ? value : '').trim();
        } else if (key === 'autoSync' || key === 'enableMirrorDelete' || key === 'debugMode') {
            settings[key] = value === true;
        } else {
            return;
        }
        await this.plugin.saveSettings();
    }

    /**
     * The Pensio branding row at the top of settings.
     */
    private brandingDefinition(): SettingDefinition {
        return {
            name: 'Pensio',
            desc: 'AI-powered journaling \u2014 emotion tracking, insights, relationship mapping, and an AI advisor that knows your entire journal.',
            searchable: false,
            render: (setting) => {
                setting.setClass('pensio-branding');
                setting.nameEl.prepend(setting.nameEl.createSpan({ text: '✦ ', cls: 'pensio-branding-icon' }));
                setting.nameEl.createSpan({ text: 'Beta', cls: 'pensio-beta-badge' });

                const learnMore = setting.descEl.createEl('a', {
                    text: 'Learn more at pensio.app',
                    href: 'https://pensio.app',
                    cls: 'pensio-branding-link',
                });
                learnMore.setAttr('target', '_blank');
            },
        };
    }

    /**
     * The journal folders: every .md file inside one syncs as an entry.
     */
    private journalFolderList(): SettingDefinitionItem {
        return {
            type: 'list',
            heading: 'Journal folders',
            emptyState:
                'Add a folder, and every .md file in it syncs as a Daily Journal entry.',
            items: this.plugin.settings.journalFolders.map((_, index) => ({
                name: `Folder ${index + 1}`,
                desc: 'All .md files sync as Daily Journal entries. Use frontmatter "type:" to override per file.',
                control: { type: 'folder' as const, key: journalFolderKey(index), placeholder: 'Folder path' },
            })),
            addItem: {
                name: 'Add journal folder',
                action: () => {
                    void this.changeJournalFolders(folders => folders.push({ folder: '' }));
                },
            },
            onDelete: (index) => {
                void this.changeJournalFolders(folders => folders.splice(index, 1));
            },
        };
    }

    /** Add or remove a journal folder, save, and draw the list again. */
    private async changeJournalFolders(
        change: (folders: JournalFolderMapping[]) => void,
    ): Promise<void> {
        change(this.plugin.settings.journalFolders);
        await this.plugin.saveSettings();
        this.update();
    }

    /** A manual token field: masked, saved as it is typed. */
    private tokenDefinition(
        name: string, desc: string, read: () => string, write: (value: string) => Promise<void>,
    ): SettingDefinition {
        return {
            name,
            desc,
            render: (setting) => {
                setting.addText(text => {
                    text
                        .setPlaceholder(name)
                        .setValue(read())
                        .onChange(async (value) => {
                            await write(value.trim());
                        });
                    text.inputEl.type = 'password';
                });
            },
        };
    }
}
