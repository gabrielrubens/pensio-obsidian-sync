/**
 * A note too large to sync is a line about that note, never a vault that is
 * "not syncing" (plugin 0.7.3, review CRIT-4).
 *
 * ⛔ The bug: a note over 1 MB was skipped with "File too large", and that line
 * made every sync a failure. The time of the last sync never moved and the
 * card said *Not syncing*, although every other note synced. Gabriel's
 * `pensio-prod-demo` vault holds a 1.1 MB note, so it said so for good.
 *
 * ⭐ Now: the sync works, the card says *Connected* with "1 note is too large
 * to sync: Long note", the note is not read again until she edits it, and the
 * line goes once the note is gone or small enough.
 *
 * Sabotage-checked (2026-10-21), each alone then restored:
 * - runSync pushing a too-large note into `errors` again (the 0.7.2 rule) →
 *   all four "a note too large to sync" tests RED, and "a note moved while
 *   too large" too: the sync throws, so the card says Not syncing and the
 *   last sync time stays null;
 * - cardView not passing the line on (`...notes` dropped from Connected) →
 *   "leaves the vault Connected" RED;
 * - paintCard not drawing `view.warning` → "leaves the vault Connected" RED;
 * - runSync without the `tooLarge.unchanged` check → "is not read again" and
 *   "survives a reload" RED;
 * - TooLargeNotes.finish keeping what the sync did not see → "is forgotten"
 *   RED;
 * - getState without `tooLarge` → "survives a reload" RED;
 * - syncNow's notice without the too-large line → "Sync now says" RED.
 * After the rebase onto 0.7.2 (2026-10-21):
 * - processRenames leaving the history at the new path (no moveNotSent, the
 *   rule before 0.7.3) → "keeps its entry's path in the history" RED.
 */
import { Notice, Setting } from 'obsidian';
import { AccountCheck } from '../../accountCheck';
import PensioPlugin from '../../main';
import { PensioSettingTab } from '../../settings';
import { SyncStatus } from '../../syncStatus';
import { BulkSyncItem, PensioSettings } from '../../types';
import { SyncEngine } from '../engine';
import { FakeFile, fakeVault, folderTree } from './fakeVault';

const NoticeMock = Notice as unknown as jest.Mock;

const KB = 1024;
const LONG = 'Journal/Long note.md';
/** Gabriel's demo vault's note: 1.1 MB, sent twice it is over Pensio's limit. */
const longNote = () => '# A long note\n\n' + 'Hoje caminhei à beira do rio.\n'.repeat(Math.ceil(1.1 * 1024 * KB / 30));

function setup(files: FakeFile[] = [{ path: 'Journal/a.md' }, { path: LONG, stat: { mtime: 1, ctime: 1, size: 0 } }]) {
    let local = files;
    const settings: PensioSettings = {
        apiUrl: 'https://pensio.app', deviceId: 'test', autoSync: true,
        journalFolders: [{ folder: 'Journal' }], peopleFolder: 'People',
        enableMirrorDelete: false, debugMode: false,
    };
    const vault = fakeVault(() => local);
    let longText = longNote();
    (vault.read as jest.Mock).mockImplementation(async (file: { path: string }) =>
        (file.path === LONG ? longText : '# A day\n\nA walk by the river.'));
    const sent: string[] = [];
    const api = {
        isAuthInvalidated: () => false,
        bulkSync: jest.fn(async (entries: BulkSyncItem[], people: BulkSyncItem[]) => {
            sent.push(...[...entries, ...people].map(i => i.file_path));
            const part = { created: entries.length, updated: 0, deleted: 0, skipped: 0, errors: [] };
            return { entries: part, people: { ...part, created: people.length }, total_time_ms: 0 };
        }),
        getSyncStatus: jest.fn(async () => ({ total_entries: 1 })),
    };
    const engine = new SyncEngine({ vault } as never, settings, api as never);
    const reads = (path: string) => (vault.read as jest.Mock).mock.calls.filter(([f]) => (f as { path: string }).path === path).length;
    return {
        engine, sent, reads,
        setFiles: (next: FakeFile[]) => { local = next; },
        setLongText: (text: string) => { longText = text; },
    };
}

// ---------------------------------------------------------------------------
// The settings tab, drawn the way Obsidian draws it, over a real engine.
// ---------------------------------------------------------------------------

type FakeNode = { textContent: string; find: (cls: string) => FakeNode[] };
type FakeSetting = { name: string; desc: string; classes: string[]; settingEl: FakeNode; descEl: FakeNode };
const card = (): FakeSetting => {
    const found = (Setting as unknown as { rendered: FakeSetting[] }).rendered.find(s => s.classes.includes('pensio-status-card'));
    if (!found) throw new Error('no status card');
    return found;
};

/** She opens the settings of a connected vault whose engine is `engine`. */
function openSettings(engine: SyncEngine) {
    const failureContext = () => ({ apiUrl: 'https://pensio.app', retries: true });
    const plugin = {
        app: {},
        manifest: { version: '0.7.3' },
        settings: { apiUrl: 'https://pensio.app', journalFolders: [], peopleFolder: '', autoSync: true },
        getAccessToken: () => 'access',
        getRefreshToken: () => 'refresh',
        previousRefresh: () => 'refresh',
        accountGuard: { getAccount: () => ({ email: 'her@example.com' }) },
        apiClient: { isAuthInvalidated: () => false, getSyncStatus: jest.fn(async () => ({ total_entries: 0 })) },
        syncEngine: engine,
        syncStatus: new SyncStatus({
            statusBar: () => null, isAuthInvalidated: () => false,
            trackedCount: () => engine.getTrackedFileCount(), failureContext,
            tooLarge: () => engine.getTooLargeNotes(),
        }),
        accountCheck: null as unknown as AccountCheck,
        register: jest.fn(),
        failureContext,
        verifyAccountBeforeSync: jest.fn(async () => true),
        startOneClickConnect: jest.fn(async () => undefined),
        syncNow: jest.fn(async () => undefined),
        logout: jest.fn(async () => undefined),
    };
    plugin.accountCheck = new AccountCheck(async () => true, failureContext, () => plugin.syncStatus.changed());
    const tab = new PensioSettingTab({} as never, plugin as unknown as PensioPlugin);
    tab.update();
    (tab as unknown as { open: () => void }).open();
    return plugin;
}

/** An automatic sync, reported the way main.ts reports one. */
async function autoSync(engine: SyncEngine, status: SyncStatus): Promise<void> {
    try {
        await engine.syncAll();
    } catch (error) {
        status.failed(error, { asked: false });
    }
}

describe('a note too large to sync', () => {
    it('leaves the vault Connected, with a line naming the note', async () => {
        const { engine, sent } = setup();
        const plugin = openSettings(engine);
        engine.onSyncSucceeded = contacted => plugin.syncStatus.synced(contacted);

        await autoSync(engine, plugin.syncStatus);

        expect(sent).toEqual(['Journal/a.md']);                 // never sent
        expect(engine.getLastSyncTime()).not.toBeNull();        // the sync counts
        expect(card().name).toBe('Connected');
        expect(card().descEl.find('pensio-card-warning').map(n => n.textContent))
            .toEqual(['1 note is too large to sync: Long note']);
    });

    it('is not read again until it changes, and is forgotten once it is gone', async () => {
        const { engine, reads, setFiles, setLongText } = setup();
        await engine.syncAll();
        await engine.syncAll();
        expect(reads(LONG)).toBe(1);                            // remembered by path and time

        // She edits it, and it is still too large: read again, still listed.
        setFiles([{ path: 'Journal/a.md' }, { path: LONG, stat: { mtime: 2, ctime: 1, size: 0 } }]);
        await engine.syncAll();
        expect(reads(LONG)).toBe(2);
        expect(engine.getTooLargeNotes()).toEqual([LONG]);

        // She splits it: small enough now, so it syncs and the line goes.
        setLongText('# A long note\n\nThe first part.');
        setFiles([{ path: 'Journal/a.md' }, { path: LONG, stat: { mtime: 3, ctime: 1, size: 0 } }]);
        const result = await engine.syncAll();
        expect(result.tooLarge).toEqual([]);
        expect(engine.getTrackedFileCount()).toBe(2);
    });

    it('is forgotten when the note is deleted', async () => {
        const { engine, setFiles } = setup();
        await engine.syncAll();
        expect(engine.getTooLargeNotes()).toEqual([LONG]);

        setFiles([{ path: 'Journal/a.md' }]);
        await engine.syncAll();

        expect(engine.getTooLargeNotes()).toEqual([]);
    });

    it('survives a reload without being read again', async () => {
        const first = setup();
        await first.engine.syncAll();

        const second = setup();
        second.engine.restoreState(first.engine.getState());
        expect(second.engine.getTooLargeNotes()).toEqual([LONG]);
        await second.engine.syncAll(true);                      // even a full sync

        expect(second.reads(LONG)).toBe(0);
        expect(second.engine.getTooLargeNotes()).toEqual([LONG]);
    });
});

describe('a note moved while too large to sync', () => {
    it('keeps its entry’s path in the history, where Pensio still has it', async () => {
        // 0.7.2: the history names the path Pensio has, which is how mirror
        // delete finds an entry. The move is not sent (the note is too large
        // to send), so the entry is still at the old path.
        let local: FakeFile[] = [{ path: 'Journal/a.md', stat: { mtime: 1, ctime: 1, size: 0 } }];
        const vault = {
            ...fakeVault(() => local),
            getAbstractFileByPath: (path: string) =>
                folderTree(local).get('Journal')?.children.find(c => c.path === path) ?? null,
        };
        (vault.read as jest.Mock).mockImplementation(async (file: { path: string }) =>
            (file.path === 'Journal/b.md' ? longNote() : '# A day\n\nA walk by the river.'));
        const items: string[] = [];
        const api = {
            isAuthInvalidated: () => false,
            bulkSync: jest.fn(async (entries: BulkSyncItem[]) => {
                items.push(...entries.map(i => `${i.action} ${i.file_path}${i.new_file_path ? ` → ${i.new_file_path}` : ''}`));
                const part = { created: entries.length, updated: 0, deleted: 0, skipped: 0, errors: [] };
                return { entries: part, people: { ...part, created: 0 }, total_time_ms: 0, capabilities: { rename: true } };
            }),
            getSyncStatus: jest.fn(async () => ({ total_entries: 1 })),
        };
        const settings: PensioSettings = {
            apiUrl: 'https://pensio.app', deviceId: 'test', autoSync: true,
            journalFolders: [{ folder: 'Journal' }], peopleFolder: 'People',
            enableMirrorDelete: false, debugMode: false,
        };
        const engine = new SyncEngine({ vault } as never, settings, api as never);
        engine.startWatching();
        await engine.syncAll();
        items.length = 0;

        // She renames it and, the same minute, pastes a long text into it.
        local = [{ path: 'Journal/b.md', stat: { mtime: 2, ctime: 1, size: 0 } }];
        const onRename = (vault.on as jest.Mock).mock.calls.find(([event]) => event === 'rename')?.[1] as
            (file: unknown, oldPath: string) => void;
        onRename(folderTree(local).get('Journal')?.children[0], 'Journal/a.md');
        engine.stopWatching();                                  // no debounced sync of its own
        await engine.syncAll();

        expect(items).toEqual([]);                              // nothing sent: no move, no create
        expect(Object.keys(engine.getState().files)).toEqual(['Journal/a.md']);
        expect(engine.getTooLargeNotes()).toEqual(['Journal/b.md']);
    });
});

describe('Sync now', () => {
    function plugin(tooLarge: string[]) {
        const p = new (PensioPlugin as unknown as new () => PensioPlugin)();
        const internals = p as unknown as Record<string, unknown>;
        internals._accessToken = 'access';
        internals._refreshToken = 'refresh';
        internals.apiClient = { isAuthInvalidated: () => false };
        internals.syncStatus = new SyncStatus({
            statusBar: () => null, isAuthInvalidated: () => false, trackedCount: () => 3,
            failureContext: () => ({ apiUrl: 'https://pensio.app', retries: false }),
        });
        internals.verifyAccountBeforeSync = async () => true;
        internals.syncEngine = {
            markDirty: jest.fn(),
            syncAll: jest.fn(async () => ({ synced: 2, skipped: 1, errors: 0, total: 3, contacted: true, tooLarge })),
        };
        return p;
    }

    beforeEach(() => NoticeMock.mockClear());

    it('says which note is too large to sync', async () => {
        await plugin([LONG]).syncNow();

        expect(NoticeMock.mock.calls.map(call => call[0] as string)).toContain(
            'Pensio: Sync done. 2 synced, 1 unchanged. 1 note is too large to sync: Long note.',
        );
    });

    it('says nothing about it when every note fits', async () => {
        await plugin([]).syncNow();

        expect(NoticeMock.mock.calls.map(call => call[0] as string)).toContain('Pensio: Sync done. 2 synced, 1 unchanged.');
    });
});
