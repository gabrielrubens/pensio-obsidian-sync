/**
 * A sync reads only the folders it syncs (plugin 0.6.1).
 *
 * ⭐ The engine used to list every markdown file in the vault and filter the
 * list; the Community plugin review reports that as access to every file path
 * in the vault. It now walks the configured folders and nothing else.
 *
 * ⛔ The list it builds is what mirror delete compares this vault's sync
 * history against: a synced file missing from it is an entry deleted on Pensio. So the first test holds
 * the walk to the old filter's exact answer, on a vault built to trip it —
 * a nested configured folder, a folder whose name starts with another's, a
 * non-markdown file, notes at the root and outside every folder.
 *
 * Sabotage-checked (2026-10-19), each alone then restored:
 * - walk only a folder's direct children (no recursion) → the first test RED;
 * - drop the `seen` set → the first test RED (the nested folder's notes twice);
 * - walk the vault root instead of the configured folders → the second test RED.
 */
import { PensioSettings } from '../../types';
import { SyncEngine } from '../engine';
import { FakeFile, fakeVault } from './fakeVault';

jest.mock('obsidian');

const VAULT: FakeFile[] = [
    { path: 'Journal/2026-10-19.md' },
    { path: 'Journal/2024/2024-01-01.md' },
    { path: 'Journal/deep/er/still.md' },
    { path: 'Journal/photo.png' },
    { path: 'Journal/notes.txt' },
    { path: 'Journalist/interview.md' },
    { path: 'People/Emma.md' },
    { path: 'Private/diary.md' },
    { path: 'Inbox.md' },
];

function engineFor(settings: Partial<PensioSettings>) {
    const vault = fakeVault(() => VAULT);
    vault.read.mockResolvedValue('note');
    const apiClient = {
        bulkSync: jest.fn().mockResolvedValue({
            entries: { created: 0, updated: 0, deleted: 0, skipped: 0, errors: [] },
            people: { created: 0, updated: 0, deleted: 0, skipped: 0, errors: [] },
            total_time_ms: 0,
        }),
        isAuthInvalidated: jest.fn().mockReturnValue(false),
        getSyncStatus: jest.fn().mockResolvedValue({ last_sync: null, total_entries: 0 }),
    };
    const full: PensioSettings = {
        apiUrl: 'https://pensio.app',
        deviceId: 'test',
        autoSync: false,
        journalFolders: [{ folder: 'Journal' }],
        peopleFolder: 'People',
        enableMirrorDelete: false,
        debugMode: false,
        ...settings,
    };
    const engine = new SyncEngine({ vault } as never, full, apiClient as never);
    return { engine, vault };
}

/** What the old code listed: every markdown file, through shouldSyncFile. */
function oldFilter(engine: SyncEngine): string[] {
    return VAULT
        .filter(file => file.path.endsWith('.md'))
        .filter(file => engine.shouldSyncFile(file as never))
        .map(file => file.path)
        .sort();
}

const walked = (engine: SyncEngine): string[] =>
    (engine as unknown as { filesInSyncFolders(): { path: string }[] })
        .filesInSyncFolders().map(file => file.path).sort();

describe('which files a sync reads', () => {
    it('lists exactly what the old whole-vault filter listed', () => {
        const nested = engineFor({ journalFolders: [{ folder: 'Journal' }, { folder: 'Journal/2024' }] });
        expect(walked(nested.engine)).toEqual(oldFilter(nested.engine));
        expect(walked(nested.engine)).toEqual([
            'Journal/2024/2024-01-01.md',
            'Journal/2026-10-19.md',
            'Journal/deep/er/still.md',
            'People/Emma.md',
        ]);

        const noPeople = engineFor({ peopleFolder: '' });
        expect(walked(noPeople.engine)).toEqual(oldFilter(noPeople.engine));
    });

    it('never reads a note outside the configured folders', async () => {
        const { engine, vault } = engineFor({});

        await engine.syncAll(true);

        const read = vault.read.mock.calls.map(([file]: [{ path: string }]) => file.path);
        expect(read.sort()).toEqual([
            'Journal/2024/2024-01-01.md',
            'Journal/2026-10-19.md',
            'Journal/deep/er/still.md',
            'People/Emma.md',
        ]);
        const asked = vault.getFolderByPath.mock.calls.map(([path]: [string]) => path);
        expect(asked).not.toContain('/');
        expect(asked.sort()).toEqual(['Journal', 'People']);
    });

    it('syncs nothing, quietly, when a configured folder does not exist', async () => {
        const { engine, vault } = engineFor({ journalFolders: [{ folder: 'Gone' }], peopleFolder: '' });

        const result = await engine.syncAll(true);

        expect(vault.read).not.toHaveBeenCalled();
        expect(result.errors).toBe(0);
    });
});
