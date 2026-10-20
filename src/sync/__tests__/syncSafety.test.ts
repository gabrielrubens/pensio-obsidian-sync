/**
 * A sync deletes nothing it cannot see clearly, asks Pensio for as little as
 * it can, and counts only what Pensio answered (plugin 0.7.1).
 *
 * ⛔ What the 2026-10-20 review found in 0.7.0, each reproduced:
 * - F10: with Mirror delete on, clearing a journal folder field for 5 s
 *   deleted that folder's entries on Pensio, and the notes were never sent
 *   again (their tracking said they were synced). Every settings save also
 *   armed another full sync that nothing cancelled.
 * - F9: mirror delete paged through the whole account on every sync — on
 *   every edit pause and every 5 minutes — spending the account's hourly
 *   request budget that the connection check also needs.
 * - F26: a sync that sent nothing counted as a success, cleared a problem on
 *   screen and said "synced just now" without Pensio being asked anything.
 * - F33: Sync now pressed during an automatic sync said "0 synced, 0
 *   unchanged" at once.
 *
 * Sabotage-checked (2026-10-20), each alone then restored:
 * - mirrorAllowed without the folder-change guard → "clearing a folder field" RED;
 * - mirrorDelete without removeFileTracking → "a restored note is sent again" RED;
 * - mirrorAllowed without the lost-folder guard → "a folder that held notes" RED;
 * - mirrorAllowed without the hourly gate → "at most hourly" RED;
 * - startAutoSync not keeping its timer (so stopWatching cannot clear it) →
 *   "stopping cancels the startup sync" RED;
 * - runSync passing contacted=true always → "a sync that sends nothing" RED;
 * - syncAll without the in-flight join → "a second sync joins" RED;
 * - the chunk loops without `halted` → "the first chunk that fails" RED.
 */
import { EntryResponse, PensioSettings } from '../../types';
import { SyncEngine } from '../engine';
import { FakeFile, fakeVault } from './fakeVault';

jest.mock('obsidian');

const entry = (id: string, file_path: string): EntryResponse => ({
    id, title: '', content_html: '', content_plain: '', entry_date: '2026-10-20', entry_type: 'daily_journal',
    source: 'obsidian_plugin', file_path, file_hash: '', frontmatter: {}, primary_emotion: '',
    file_modified_at: '2026-10-20T00:00:00Z', api_last_modified: null,
    created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z', people: [],
});

const ok = {
    entries: { created: 1, updated: 0, deleted: 0, skipped: 0, errors: [] },
    people: { created: 0, updated: 0, deleted: 0, skipped: 0, errors: [] },
    total_time_ms: 0,
};

function setup(folders = ['Diary'], files: FakeFile[] = [{ path: 'Diary/2026-10-20.md' }]) {
    let local = files;
    const settings: PensioSettings = {
        apiUrl: 'https://pensio.app', deviceId: 'test', autoSync: true,
        journalFolders: folders.map(folder => ({ folder })), peopleFolder: 'People',
        enableMirrorDelete: true, debugMode: false,
    };
    const vault = fakeVault(() => local);
    (vault.read as jest.Mock).mockImplementation(async (file: { path: string }) => `# ${file.path}\n\nA walk by the river.`);
    const api = {
        isAuthInvalidated: () => false,
        bulkSync: jest.fn().mockResolvedValue(ok),
        listEntries: jest.fn().mockResolvedValue([] as EntryResponse[]),
        listPeople: jest.fn().mockResolvedValue([]),
        deleteEntry: jest.fn().mockResolvedValue(undefined),
        deletePerson: jest.fn().mockResolvedValue(undefined),
        getSyncStatus: jest.fn().mockResolvedValue({ total_entries: 1 }),
    };
    const engine = new SyncEngine({ vault } as never, settings, api as never);
    return { engine, settings, api, setFiles: (next: FakeFile[]) => { local = next; } };
}

/**
 * Let real I/O finish (hashing a note uses crypto.subtle) until `done`, or
 * give up after a long while. ⛔ Not a fixed number of turns: CI's runner is
 * slower, and a fixed count that was enough here timed out there.
 */
async function settleUntil(done: () => boolean, turns = 500): Promise<void> {
    for (let i = 0; i < turns && !done(); i++) await new Promise(resolve => setImmediate(resolve));
}

const sentPaths = (api: { bulkSync: jest.Mock }): string[] =>
    api.bulkSync.mock.calls.flatMap(([entries, people]: [{ file_path: string }[], { file_path: string }[]]) =>
        [...entries, ...people].map(item => item.file_path));

describe('mirror delete', () => {
    it('does not delete a folder’s entries while its folder field is being cleared or retyped', async () => {
        // Two folders, so the sync still sees notes (from Diary) while Travel's
        // field is empty: only the folder-change guard stands in the way.
        const { engine, settings, api } = setup(['Diary', 'Travel'], [{ path: 'Diary/a.md' }, { path: 'Travel/t.md' }]);
        await engine.syncAll(false, { asked: true });
        api.listEntries.mockResolvedValue([entry('ea', 'Diary/a.md'), entry('et', 'Travel/t.md')]);

        settings.journalFolders[1].folder = '';          // cleared, about to be retyped
        await engine.syncAll(false, { asked: true });
        settings.journalFolders[1].folder = 'Tra';       // half typed
        await engine.syncAll(false, { asked: true });

        expect(api.deleteEntry).not.toHaveBeenCalled();
    });

    it('sends a note again when it comes back after mirror delete removed its entry', async () => {
        const { engine, api, setFiles } = setup(['Diary'], [{ path: 'Diary/a.md' }, { path: 'Diary/b.md' }]);
        await engine.syncAll(false, { asked: true });

        // b.md deleted while Obsidian was closed: mirror delete removes its entry.
        setFiles([{ path: 'Diary/a.md' }]);
        api.listEntries.mockResolvedValue([entry('ea', 'Diary/a.md'), entry('eb', 'Diary/b.md')]);
        await engine.syncAll(false, { asked: true });
        expect(api.deleteEntry).toHaveBeenCalledWith('eb');

        // It comes back, unchanged.
        setFiles([{ path: 'Diary/a.md' }, { path: 'Diary/b.md' }]);
        api.bulkSync.mockClear();
        await engine.syncAll(false, { asked: true });

        expect(sentPaths(api)).toEqual(['Diary/b.md']);
    });

    it('deletes nothing when a folder that held synced notes is gone (renamed, or mistyped)', async () => {
        const { engine, api, setFiles } = setup(['Diary', 'Travel'], [{ path: 'Diary/a.md' }, { path: 'Travel/t.md' }]);
        await engine.syncAll(false, { asked: true });

        setFiles([{ path: 'Diary/a.md' }]); // Travel/ renamed in the vault
        api.listEntries.mockResolvedValue([entry('ea', 'Diary/a.md'), entry('et', 'Travel/t.md')]);
        await engine.syncAll(false, { asked: true });

        expect(api.deleteEntry).not.toHaveBeenCalled();
    });

    it('runs at most hourly by itself, and at once when she asks', async () => {
        const { engine, api } = setup();
        await engine.syncAll();          // automatic: lists the account once
        await engine.syncAll();          // automatic, a minute later: not again
        expect(api.listEntries).toHaveBeenCalledTimes(1);

        await engine.syncAll(false, { asked: true });
        expect(api.listEntries).toHaveBeenCalledTimes(2);
    });
});

describe('the automatic sync', () => {
    it('stopping cancels the startup sync, so a burst of restarts syncs once', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        const flush = () => settleUntil(() => false, 100);
        try {
            const { engine } = setup();
            const syncs = jest.fn();
            engine.onSyncSucceeded = syncs;

            // Five settings saves a second apart, as typing a folder path does:
            // each one restarts the automatic sync.
            for (let i = 0; i < 5; i++) {
                engine.stopWatching();
                engine.startWatching();
                engine.startAutoSync();
                await jest.advanceTimersByTimeAsync(1000);
                await flush();
            }
            await jest.advanceTimersByTimeAsync(6000);
            await settleUntil(() => syncs.mock.calls.length > 0);
            await flush();
            expect(syncs).toHaveBeenCalledTimes(1);   // one sync, 5 s after the last save

            engine.startAutoSync();
            engine.stopWatching();                    // stopped before its 5 s
            await jest.advanceTimersByTimeAsync(6000);
            await flush();
            expect(syncs).toHaveBeenCalledTimes(1);
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('a sync', () => {
    it('that sends nothing has not reached Pensio, unless it asks', async () => {
        const { engine, api } = setup();
        const succeeded = jest.fn();
        engine.onSyncSucceeded = succeeded;
        await engine.syncAll(false, { asked: true });
        const afterUpload = engine.getLastSyncTime();
        expect(succeeded).toHaveBeenLastCalledWith(true);

        api.listEntries.mockClear();
        const quiet = await engine.syncAll();    // nothing changed, mirror not due
        expect(quiet.contacted).toBe(false);
        expect(succeeded).toHaveBeenLastCalledWith(false);
        expect(engine.getLastSyncTime()).toBe(afterUpload);

        engine.needsContact = () => true;        // a problem is on screen
        const probed = await engine.syncAll();
        expect(api.getSyncStatus).toHaveBeenCalledTimes(1);
        expect(probed.contacted).toBe(true);
        expect(succeeded).toHaveBeenLastCalledWith(true);
    });

    it('stops at the first chunk that fails outright, instead of sending every other', async () => {
        const many = Array.from({ length: 160 }, (_, i) => ({ path: `Diary/${String(i).padStart(3, '0')}.md` }));
        const { engine, api } = setup(['Diary'], many);
        api.bulkSync.mockRejectedValue(Object.assign(new Error('Rate limit exceeded.'), { status: 429 }));

        await expect(engine.syncAll(false, { asked: true })).rejects.toThrow('Rate limit');

        expect(api.bulkSync).toHaveBeenCalledTimes(1);   // not 4: 160 notes, 50 a chunk
        expect(api.listEntries).not.toHaveBeenCalled();
    });

    it('started while another runs joins it, and gets its real result', async () => {
        const { engine, api } = setup();
        let release: () => void = () => undefined;
        api.bulkSync.mockImplementation(() => new Promise(resolve => { release = () => resolve(ok); }));

        const automatic = engine.syncAll();
        const pressed = engine.syncAll(false, { asked: true });
        // The upload is under way (and held) before it is let go.
        await settleUntil(() => api.bulkSync.mock.calls.length > 0);
        release();

        const [a, b] = await Promise.all([automatic, pressed]);
        expect(b).toBe(a);
        expect(b.synced).toBe(1);
        expect(api.bulkSync).toHaveBeenCalledTimes(1);
    });
});
