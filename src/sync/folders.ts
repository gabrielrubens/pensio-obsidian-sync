import { App, TFile, TFolder } from 'obsidian';
import { PensioSettings } from '../types';

/**
 * Which notes this vault syncs, and as what: the folder rule, in one place.
 *
 * ⭐ A path is synced when it is a `.md` file inside a journal folder or the
 * People folder; a note in the People folder is a person, any other a journal
 * entry. Reads the settings object it was given each time, so a folder changed
 * in the settings applies at once.
 */
export class SyncFolders {
    constructor(private readonly settings: PensioSettings, private readonly app: App) { }

    /** The folder rule, on a path — so a rename's old path can be judged too. */
    isSynced(path: string): boolean {
        if (!path.endsWith('.md')) return false;

        const inJournalFolder = this.settings.journalFolders.some(mapping =>
            mapping.folder.trim().length > 0 &&
            path.startsWith(mapping.folder + '/')
        );
        if (inJournalFolder) return true;

        if (this.settings.peopleFolder.trim().length > 0) {
            if (path.startsWith(this.settings.peopleFolder + '/')) {
                return true;
            }
        }

        return false;
    }

    contentType(filePath: string): string {
        if (this.settings.peopleFolder &&
            filePath.startsWith(this.settings.peopleFolder + '/')) {
            return 'person';
        }

        return 'daily_journal';
    }

    /** The configured folders a sync walks, as set (untrimmed), empty ones left out. */
    roots(): string[] {
        return [
            ...this.settings.journalFolders.map(mapping => mapping.folder),
            this.settings.peopleFolder,
        ].filter(folder => folder.trim().length > 0);
    }

    /**
     * The files to sync: the ones inside the configured folders, and nothing
     * else.
     *
     * ⭐ Walks only those folders instead of listing the whole vault and
     * filtering it: the plugin never needs a path outside them, and the
     * Community plugin review reports a whole-vault listing as access to every
     * file path in the vault. `isSynced` is still the rule — this only stops
     * asking for paths it would refuse.
     *
     * ⛔ Mirror delete removes a server entry whose file is missing from this
     * list, so it must hold every file the old `getMarkdownFiles()` filter
     * held. A folder is looked up by its setting exactly as `isSynced`
     * compares it (untrimmed), and a file in two configured folders (one
     * nested in the other) is listed once. 🧪 `folderScopedReads.test.ts`
     * compares the two on the same vault.
     */
    files(): TFile[] {
        const files: TFile[] = [];
        const seen = new Set<string>();
        const walk = (folder: TFolder): void => {
            for (const child of folder.children) {
                if (child instanceof TFolder) {
                    walk(child);
                } else if (child instanceof TFile && !seen.has(child.path) && this.isSynced(child.path)) {
                    seen.add(child.path);
                    files.push(child);
                }
            }
        };
        for (const root of this.roots()) {
            const folder = this.app.vault.getFolderByPath(root);
            if (folder) walk(folder);
        }
        return files;
    }

    /** Does this configured folder exist in the vault? */
    exists(root: string): boolean {
        return this.app.vault.getFolderByPath(root) !== null;
    }

    /** The folder settings a sync walks, as one comparable value. */
    signature(): string {
        return JSON.stringify([this.settings.journalFolders.map(m => m.folder), this.settings.peopleFolder]);
    }
}
