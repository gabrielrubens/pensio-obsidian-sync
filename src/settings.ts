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

    /**
     * Design "B · Status card" (plugin 0.7.0), top to bottom: the status
     * card; the setup code while there is no working connection; the journal
     * folders; Sync; the account once connected; Advanced, a sub-page.
     * 📐 docs/features/obsidian-plugin.md "The settings screen".
     */
    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            this.connection.cardDefinition(),
            ...this.connection.pairingDefinitions(),
            this.journalFolderList(),
            {
                type: 'group',
                heading: 'Sync',
                items: [
                    {
                        name: 'People folder',
                        desc: 'One note per person. [[Name]] links them to entries.',
                        control: { type: 'folder', key: 'peopleFolder', placeholder: 'People' },
                    },
                    {
                        name: 'Auto-sync',
                        desc: 'On every change, and every 5 minutes.',
                        control: { type: 'toggle', key: 'autoSync' },
                    },
                ],
            },
            ...this.connection.accountDefinitions(),
            this.advancedPage(),
        ];
    }

    /**
     * Advanced, as a sub-page: six settings almost nobody needs, which used to
     * be the longest group on the tab. Settings search still finds each one
     * (Obsidian indexes the items of a declarative page).
     */
    private advancedPage(): SettingDefinitionItem {
        return {
            type: 'page',
            name: 'Advanced',
            desc: 'Server URL, mirror delete, tokens, debug',
            items: [
                {
                    type: 'group',
                    items: [
                        {
                            name: 'Server URL',
                            desc: 'Only for a self-hosted server.',
                            control: { type: 'text', key: 'apiUrl', placeholder: 'https://pensio.app' },
                        },
                        {
                            name: 'Mirror delete',
                            desc: 'Deleting a note deletes its entry. Entries written on the web are safe.',
                            control: { type: 'toggle', key: 'enableMirrorDelete' },
                        },
                        {
                            name: 'Debug mode',
                            desc: 'Logs to the developer console.',
                            control: { type: 'toggle', key: 'debugMode' },
                        },
                        // Manual token entry — for self-hosters who prefer pasting
                        // JWTs over connecting. The normal path is the card's
                        // Connect to Pensio.
                        // ⚠️ Not a `secret` control: that one stores the NAME of a
                        // secret the person picks from Obsidian's keychain, and these
                        // are the token values themselves, kept by the plugin.
                        // ⛔ tests/core/test_the_connection_flow_has_one_door.py reads
                        // this file for `tokenDefinition('Access token'`: the web's
                        // manual-token steps name the field.
                        this.tokenDefinition(
                            'Access token',
                            'For pasting tokens by hand.',
                            () => this.plugin.getAccessToken(),
                            (value) => this.plugin.setTokens(value, this.plugin.getRefreshToken()),
                        ),
                        this.tokenDefinition(
                            'Refresh token',
                            'Paste both, then test.',
                            () => this.plugin.getRefreshToken(),
                            (value) => this.plugin.setTokens(this.plugin.getAccessToken(), value),
                        ),
                        this.connection.testDefinition(),
                    ],
                },
            ],
        };
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
     * The journal folders: every .md file inside one syncs as an entry.
     */
    private journalFolderList(): SettingDefinitionItem {
        return {
            type: 'list',
            heading: 'Journal folders',
            emptyState:
                'Add a folder, and every .md file in it syncs as a Daily Journal entry.',
            // ⭐ No description per folder: the same sentence under every
            // folder was most of the words on the old tab.
            items: this.plugin.settings.journalFolders.map((_, index) => ({
                name: `Folder ${index + 1}`,
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
