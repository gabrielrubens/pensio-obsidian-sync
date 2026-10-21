/**
 * Mirror delete removes the entries of notes THIS VAULT synced and no longer
 * has, and nothing else.
 *
 * ⛔ Until 0.7.2 it listed every entry on the account and deleted each
 * Obsidian entry this vault had no note for. A second vault on the same
 * account owns notes this one never had, so mirror delete in either vault
 * deleted the other's entries, and the other vault, which still tracked them
 * as synced, never sent them again (review CRIT-1, 2026-10-20). Gabriel's own
 * Mac had two vaults syncing to production, one with Mirror delete on.
 *
 * Sabotage-checked (2026-10-21), each alone then restored:
 * - goneNotes returning every path on the server instead of the history's
 *   (the old rule, through the fake server's own list) → "another vault" RED;
 * - mirrorDelete without removeFileTracking → "sent again when it comes back"
 *   RED (in syncSafety.test.ts) and "nothing again once it deleted" RED;
 * - mirrorSkip ignoring `enabled` → "off" RED;
 * - deleteItems going to the entries section only → "a person note" RED;
 * - mirrorDelete catching its own failure again → "a refused delete" RED.
 */
import { BulkSyncItem, BulkSyncResponse, PensioSettings } from '../../types';
import { SyncEngine } from '../engine';
import { FakeFile, fakeVault } from './fakeVault';

jest.mock('obsidian');

/**
 * One Pensio account, shared by every vault in a test: a row per path, as
 * the server keys them (user, file_path), each remembering which vault wrote
 * it. A delete removes the row at that path and answers "not found" when
 * there is none, as api/bulk_views.py does.
 *
 * ⭐ It also answers the account-wide list and the delete by id, which the
 * plugin no longer calls, so that a change back to the old rule is caught
 * here rather than failing quietly on a missing method.
 */
function account() {
    const rows = new Map<string, string>();
    const calls: { entries: BulkSyncItem[]; people: BulkSyncItem[] }[] = [];
    const deletedById: string[] = [];
    const answer = (items: BulkSyncItem[], vault: string) => {
        const section = { created: 0, updated: 0, deleted: 0, skipped: 0, errors: [] as { file_path: string; error: string }[] };
        for (const item of items) {
            if (item.action === 'delete') {
                if (rows.delete(item.file_path)) section.deleted++;
                else section.errors.push({ file_path: item.file_path, error: 'Item not found for deletion' });
            } else {
                rows.set(item.new_file_path ?? item.file_path, vault);
                section.created++;
            }
        }
        return section;
    };
    const clientFor = (vault: string) => ({
        isAuthInvalidated: () => false,
        getSyncStatus: jest.fn().mockResolvedValue({ total_entries: rows.size }),
        bulkSync: jest.fn(async (entries: BulkSyncItem[], people: BulkSyncItem[]): Promise<BulkSyncResponse> => {
            calls.push({ entries, people });
            return { entries: answer(entries, vault), people: answer(people, vault), total_time_ms: 0 };
        }),
        listEntries: jest.fn(async () =>
            [...rows.keys()].map(path => ({ id: path, file_path: path, source: 'obsidian_plugin' }))),
        listPeople: jest.fn(async () => []),
        deleteEntry: jest.fn(async (id: string) => { rows.delete(id); deletedById.push(id); }),
        deletePerson: jest.fn(async () => undefined),
    });
    const deletes = (): string[] => [
        ...calls.flatMap(c => c.entries).filter(i => i.action === 'delete').map(i => i.file_path),
        ...deletedById,
    ];
    return { rows, calls, clientFor, deletes };
}

function vault(server: ReturnType<typeof account>, name: string, files: FakeFile[], mirror = true) {
    let local = files;
    const settings: PensioSettings = {
        apiUrl: 'https://pensio.app', deviceId: name, autoSync: false,
        journalFolders: [{ folder: 'Journal' }], peopleFolder: 'People',
        enableMirrorDelete: mirror, debugMode: false,
    };
    const v = fakeVault(() => local);
    (v.read as jest.Mock).mockImplementation(async (file: { path: string }) => `# ${file.path}\n\nWords.`);
    const api = server.clientFor(name);
    const engine = new SyncEngine({ vault: v } as never, settings, api as never);
    return { engine, settings, api, setFiles: (next: FakeFile[]) => { local = next; } };
}

// Every sync here is one she asked for, so the hourly gate (tested in
// syncSafety.test.ts) does not hide what mirror delete would do.
describe('mirror delete', () => {
    it('deletes, by path, the entry of a note this vault synced and no longer has', async () => {
        const server = account();
        const a = vault(server, 'a', [{ path: 'Journal/kept.md' }, { path: 'Journal/gone.md' }]);
        await a.engine.syncAll(false, { asked: true });

        a.setFiles([{ path: 'Journal/kept.md' }]);   // deleted while Obsidian was closed
        await a.engine.syncAll(false, { asked: true });

        expect(server.deletes()).toEqual(['Journal/gone.md']);
        expect([...server.rows.keys()]).toEqual(['Journal/kept.md']);
    });

    it('never deletes what another vault on the same account wrote', async () => {
        const server = account();
        const work = vault(server, 'work', [{ path: 'Journal/meeting.md' }, { path: 'Journal/plan.md' }], false);
        await work.engine.syncAll(false, { asked: true });
        const personal = vault(server, 'personal', [{ path: 'Journal/2026-10-20.md' }]);

        await personal.engine.syncAll(false, { asked: true });
        await personal.engine.syncAll(false, { asked: true });

        expect(server.deletes()).toEqual([]);
        expect([...server.rows.keys()].sort()).toEqual(['Journal/2026-10-20.md', 'Journal/meeting.md', 'Journal/plan.md']);
    });

    it('sends a person note’s delete to the people section too', async () => {
        // Whether a gone path was a person depends on the folder settings it
        // was synced under, so the delete goes to both sections.
        const server = account();
        const a = vault(server, 'a', [{ path: 'Journal/day.md' }, { path: 'People/Ana.md' }, { path: 'People/Bo.md' }]);
        await a.engine.syncAll(false, { asked: true });

        // Bo stays, so the People folder is still there (a folder that is gone
        // stops mirror delete altogether).
        a.setFiles([{ path: 'Journal/day.md' }, { path: 'People/Bo.md' }]);
        await a.engine.syncAll(false, { asked: true });

        const last = server.calls[server.calls.length - 1];
        expect(last.people).toEqual([{ action: 'delete', file_path: 'People/Ana.md' }]);
        expect(server.rows.has('People/Ana.md')).toBe(false);
    });

    it('asks Pensio nothing when no note it synced is gone, and nothing again once it deleted', async () => {
        const server = account();
        const a = vault(server, 'a', [{ path: 'Journal/kept.md' }, { path: 'Journal/gone.md' }]);
        await a.engine.syncAll(false, { asked: true });
        a.setFiles([{ path: 'Journal/kept.md' }]);
        await a.engine.syncAll(false, { asked: true });
        server.calls.length = 0;

        const quiet = await a.engine.syncAll(false, { asked: true });

        expect(server.calls).toEqual([]);
        expect(quiet.contacted).toBe(false);
    });

    it('deletes nothing after the sync history is gone', async () => {
        const server = account();
        const a = vault(server, 'a', [{ path: 'Journal/kept.md' }, { path: 'Journal/gone.md' }]);
        await a.engine.syncAll(false, { asked: true });
        a.engine.clearState();

        a.setFiles([{ path: 'Journal/kept.md' }]);
        await a.engine.syncAll(false, { asked: true });

        expect(server.deletes()).toEqual([]);
    });

    it('is off unless she turned it on', async () => {
        const server = account();
        const a = vault(server, 'a', [{ path: 'Journal/kept.md' }, { path: 'Journal/gone.md' }], false);
        await a.engine.syncAll(false, { asked: true });

        a.setFiles([{ path: 'Journal/kept.md' }]);
        await a.engine.syncAll(false, { asked: true });

        expect(server.deletes()).toEqual([]);
    });

    it('deletes nothing when the sync sees no notes at all', async () => {
        // An empty view of the vault is far likelier a misconfiguration than a
        // vault emptied while Obsidian was closed (review F10).
        const server = account();
        const a = vault(server, 'a', [{ path: 'Journal/a.md' }]);
        await a.engine.syncAll(false, { asked: true });

        a.setFiles([]);
        await a.engine.syncAll(false, { asked: true });

        expect(server.deletes()).toEqual([]);
    });

    it('a refused delete fails the sync and is tried again next time', async () => {
        const server = account();
        const a = vault(server, 'a', [{ path: 'Journal/kept.md' }, { path: 'Journal/gone.md' }]);
        await a.engine.syncAll(false, { asked: true });
        a.setFiles([{ path: 'Journal/kept.md' }]);
        a.api.bulkSync.mockRejectedValueOnce(Object.assign(new Error('Rate limit exceeded.'), { status: 429 }));

        await expect(a.engine.syncAll(false, { asked: true })).rejects.toThrow('Rate limit');
        expect(server.rows.has('Journal/gone.md')).toBe(true);

        await a.engine.syncAll(false, { asked: true });
        expect(server.rows.has('Journal/gone.md')).toBe(false);
    });
});
