/**
 * A renamed note is the same entry.
 *
 * ⛔ Obsidian reports a rename or a move with `rename` — never `create` +
 * `delete` — and this plugin did not listen for it. A renamed note became a
 * second entry and the first stayed behind (found 2026-10-19 by the
 * `pensio-prod-demo` fixture vault). Decided 2026-10-20:
 *   - inside the synced folders → the entry moves (same id, reading, links)
 *   - out of the synced folders → the entry stays; moving is not deleting
 *   - an older server that cannot move a row → delete + create, as before
 *
 * ⭐ Since 0.7.2 mirror delete removes only paths in this vault's sync
 * history (sync/mirror.ts), so a note that moves out keeps its old path there:
 * that is where its entry still is, and what mirror delete, if on, removes.
 * Sabotage-checked (2026-10-21), each alone then restored:
 * - onFileRenamed dropping the old path again for a note that leaves →
 *   "keeps the entry" RED and "mirror delete removes it" RED;
 * - the leaving branch keeping the half-way path instead of the origin →
 *   "a move that never reached Pensio" RED;
 * - onFileDeleted deleting the note's last path instead of its origin →
 *   "before the move was sent" RED;
 * - processDeletes sending to the entries section only → "before the move was
 *   sent" RED and "falls back to delete + create" RED.
 *
 * 🧪 Also sabotage-checked 2026-10-21: renames sent before deletes -> RED on
 *   "frees a deleted path before renaming onto it"; a person named by `title:`
 *   again -> RED on "sends the filename as the name, whatever title: says".
 *
 * ⭐ 0.8.0: a move not yet sent survives a restart (*Move lost on restart*),
 * a rename while a note's first request is out becomes a move (*Rename in
 * flight*), and a move onto a taken path deletes the entry it left (*Rename
 * onto a taken path*). Sabotage-checked (2026-10-21), each alone then restored:
 * - getState() without `renames` → "survives a restart" RED;
 * - restoreState() not restoring them → "survives a restart" RED;
 * - the rename hook not saving soon → "is saved within a second" RED;
 * - send.ts tracking the note where it is now (the 0.7 code) → "renamed while
 *   its first request is out" RED;
 * - no `not_moved` branch in renames.ts → "onto a taken path" RED;
 * - saveNow() returning before it saves (2026-10-22) → "is saved at once when
 *   Obsidian quits" RED; `saveWaiting` always false → the same test RED.
 */
import { TFile, TFolder } from 'obsidian';
import { BulkSyncItem, BulkSyncResponse, PensioSettings, SyncStateData } from '../../types';
import { SyncEngine } from '../engine';
import { folderTree } from './fakeVault';

jest.mock('obsidian');

interface FakeFile {
    path: string;
    name: string;
    basename: string;
    extension: string;
    stat: { mtime: number; ctime: number; size: number };
    content: string;
}

function makeFile(path: string, content = '---\ndate: 2026-10-01\n---\nSome words she wrote.'): FakeFile {
    const file = Object.create((TFile as unknown as { prototype: object }).prototype) as FakeFile;
    const name = path.split('/').pop() as string;
    Object.assign(file, {
        path, name, basename: name.replace(/\.md$/, ''), extension: 'md',
        stat: { mtime: 1000, ctime: 1000, size: content.length }, content,
    });
    return file;
}

function makeFolder(path: string, children: unknown[]): { path: string; children: unknown[] } {
    const folder = Object.create((TFolder as unknown as { prototype: object }).prototype) as { path: string; children: unknown[] };
    Object.assign(folder, { path, children });
    return folder;
}

function setup({ canRename = true, refuse = [] as string[], mirror = false, taken = [] as string[] } = {}) {
    const files: FakeFile[] = [];
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const calls: { entries: BulkSyncItem[]; people: BulkSyncItem[] }[] = [];

    const section = (items: BulkSyncItem[]) => ({
        created: 0, updated: 0, deleted: 0, skipped: 0,
        // Only a rename is refused, and the error names whichever path the test
        // gave — an older server names the old one; a server that fell back to
        // creating at the new path and failed names the new one.
        errors: items
            .filter(i => i.action === 'rename' &&
                (refuse.includes(i.file_path) || refuse.includes(i.new_file_path ?? '')))
            .map(i => ({
                file_path: refuse.includes(i.new_file_path ?? '') ? (i.new_file_path as string) : i.file_path,
                error: 'refused',
            })),
        // A move whose new path is taken lands on the row there (api/bulk_views.py).
        not_moved: items.filter(i => i.action === 'rename' && taken.includes(i.file_path)).map(i => i.file_path),
    });
    /** Runs once, while the next request is out. */
    let during: (() => void) | null = null;
    const api = {
        bulkSync: jest.fn(async (entries: BulkSyncItem[], people: BulkSyncItem[]): Promise<BulkSyncResponse> => {
            calls.push({ entries, people });
            const now = during;
            during = null;
            now?.();
            return {
                entries: section(entries), people: section(people), total_time_ms: 0,
                ...(canRename ? { capabilities: { rename: true } } : {}),
            };
        }),
        isAuthInvalidated: jest.fn(() => false),
        getSyncStatus: jest.fn(async () => ({ last_sync: null, total_entries: 0 })),
    };
    const app = {
        vault: {
            // The tree over the files as they stand: a sync walks only the
            // synced folders (0.6.1), and this vault has no whole-vault list.
            getFolderByPath: (p: string) => folderTree(files as never).get(p) ?? null,
            read: async (f: FakeFile) => f.content,
            on: (event: string, fn: (...args: unknown[]) => void) => { handlers[event] = fn; },
            off: jest.fn(),
            getAbstractFileByPath: (p: string) => files.find(f => f.path === p) ?? null,
        },
    };
    const settings: PensioSettings = {
        apiUrl: 'https://pensio.app', deviceId: 'd', autoSync: false,
        journalFolders: [{ folder: 'Journal' }], peopleFolder: 'People',
        enableMirrorDelete: mirror, debugMode: false,
    };
    /** Every sync state the engine saved, as the plugin would keep it. */
    const saved: SyncStateData[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = new SyncEngine(app as any, settings, api as any, async (state) => { saved.push(state); });
    engine.startWatching();
    /** Obsidian quits and starts again: a new engine from the last saved state. */
    const restart = (): SyncEngine => {
        engine.stopWatching();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const again = new SyncEngine(app as any, settings, api as any);
        again.restoreState(saved[saved.length - 1]);
        return again;
    };

    const move = (file: FakeFile, to: string): void => {
        const from = file.path;
        file.path = to;
        file.name = to.split('/').pop() as string;
        file.basename = file.name.replace(/\.md$/, '');
        handlers['rename'](file, from);
    };
    const sent = (): string[] => calls.flatMap(c => [...c.entries, ...c.people]).map(i =>
        `${i.action} ${i.file_path}${i.new_file_path ? ` → ${i.new_file_path}` : ''}`);
    // The sync history's paths, as the engine reports them (sync/history.ts).
    const tracked = (): string[] => engine.trackedPaths();

    const whileTheNextRequestIsOut = (fn: () => void): void => { during = fn; };

    return { files, engine, api, calls, handlers, move, sent, tracked, saved, restart, whileTheNextRequestIsOut };
}

/** Sync once, then forget what was sent, so a test reads only what follows. */
async function synced(env: ReturnType<typeof setup>): Promise<void> {
    await env.engine.syncAll(false);
    env.calls.length = 0;
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

describe('A renamed note is the same entry', () => {
    it('listens for Obsidian\'s rename event', () => {
        const env = setup();
        expect(env.handlers['rename']).toBeDefined();
    });

    it('moves the entry instead of making a second one', async () => {
        const env = setup();
        const note = makeFile('Journal/Old name.md');
        env.files.push(note);
        await synced(env);

        env.move(note, 'Journal/New name.md');
        await env.engine.syncAll(false);

        expect(env.sent()).toEqual(['rename Journal/Old name.md → Journal/New name.md']);
        expect(env.calls[0].entries[0].data).toMatchObject({ file_path: 'Journal/New name.md', title: 'New name' });
        expect(env.tracked()).toEqual(['Journal/New name.md']);
    });

    it('sends nothing more once the move has landed', async () => {
        const env = setup();
        const note = makeFile('Journal/a.md');
        env.files.push(note);
        await synced(env);
        env.move(note, 'Journal/b.md');
        await synced(env);

        await env.engine.syncAll(false);

        expect(env.sent()).toEqual([]);
    });

    it('moves a person note too', async () => {
        const env = setup();
        const person = makeFile('People/Em.md', '---\nrelationship: family\n---\nMy sister.');
        env.files.push(person);
        await synced(env);

        env.move(person, 'People/Emma.md');
        await env.engine.syncAll(false);

        expect(env.sent()).toEqual(['rename People/Em.md → People/Emma.md']);
        expect(env.calls[0].people[0].data).toMatchObject({ person_note_path: 'People/Emma.md', name: 'Emma' });
    });

    it('treats a move of a move as one move', async () => {
        const env = setup();
        const note = makeFile('Journal/a.md');
        env.files.push(note);
        await synced(env);

        env.move(note, 'Journal/b.md');
        env.move(note, 'Journal/c.md');
        await env.engine.syncAll(false);

        expect(env.sent()).toEqual(['rename Journal/a.md → Journal/c.md']);
    });

    it('moves every note in a renamed folder, once each', async () => {
        const env = setup();
        const a = makeFile('Journal/2026/a.md');
        const b = makeFile('Journal/2026/b.md');
        env.files.push(a, b);
        await synced(env);

        a.path = 'Journal/Archive 2026/a.md';
        b.path = 'Journal/Archive 2026/b.md';
        const folder = makeFolder('Journal/Archive 2026', [a, b]);
        env.handlers['rename'](folder, 'Journal/2026');
        env.handlers['rename'](a, 'Journal/2026/a.md'); // reported again per file
        await env.engine.syncAll(false);

        expect(env.sent().sort()).toEqual([
            'rename Journal/2026/a.md → Journal/Archive 2026/a.md',
            'rename Journal/2026/b.md → Journal/Archive 2026/b.md',
        ]);
    });
});

describe('A delete and a rename in the same sync', () => {
    it('frees a deleted path before renaming onto it', async () => {
        // ⛔ Renames went first, so the rename met the old row still on the
        // path, synced onto it, and the delete then removed it — orphaning the
        // renamed note's person ("Ben 3", found 2026-10-21).
        const env = setup();
        const old = makeFile('People/Ben 2.md', '---\nrelationship: coworker\n---\nNotes.');
        const other = makeFile('People/Ben 3.md', '---\nrelationship: coworker\n---\nNotes.');
        env.files.push(old, other);
        await synced(env);

        env.files.splice(env.files.indexOf(old), 1);
        env.handlers['delete'](old);
        env.move(other, 'People/Ben 2.md');
        await env.engine.syncAll(false);

        expect(env.sent()).toEqual([
            // A delete goes to both sections since 0.7.2 (sync/mirror.ts deleteItems).
            'delete People/Ben 2.md',
            'delete People/Ben 2.md',
            'rename People/Ben 3.md → People/Ben 2.md',
        ]);
    });
});

describe('A person is named by their note', () => {
    it('sends the filename as the name, whatever title: says', async () => {
        const env = setup();
        const person = makeFile('People/Ben 2.md', '---\ntitle: Ben 3\nrelationship: coworker\n---\nNotes.');
        env.files.push(person);

        await env.engine.syncAll(false);

        expect(env.calls[0].people[0].data).toMatchObject({ name: 'Ben 2', person_note_path: 'People/Ben 2.md' });
    });
});

describe('Leaving and entering the synced folders', () => {
    it('keeps the entry when a note moves out — moving is not deleting', async () => {
        const env = setup();
        const note = makeFile('Journal/kept.md');
        env.files.push(note);
        await synced(env);

        env.move(note, 'Archive/kept.md');
        await env.engine.syncAll(false);

        expect(env.sent()).toEqual([]);
        // Its entry is still on Pensio at the old path, so the history keeps it.
        expect(env.tracked()).toEqual(['Journal/kept.md']);
    });

    it('with Mirror delete on, removes the entry of a note that moved out', async () => {
        const env = setup({ mirror: true });
        const kept = makeFile('Journal/kept.md');
        const note = makeFile('Journal/leaves.md');
        env.files.push(kept, note);
        await synced(env);

        env.move(note, 'Archive/leaves.md');
        await env.engine.syncAll(false, { asked: true });

        expect(env.sent()).toEqual(['delete Journal/leaves.md', 'delete Journal/leaves.md']);
        expect(env.tracked()).toEqual(['Journal/kept.md']);
    });

    it('a move that never reached Pensio leaves the entry where Pensio has it', async () => {
        // Renamed inside the folders, then moved out, before any sync: the
        // first move was never sent, so the entry is still at the first path.
        const env = setup({ mirror: true });
        const kept = makeFile('Journal/kept.md');
        const note = makeFile('Journal/a.md');
        env.files.push(kept, note);
        await synced(env);

        env.move(note, 'Journal/b.md');
        env.move(note, 'Archive/c.md');
        await env.engine.syncAll(false, { asked: true });

        expect(env.sent()).toEqual(['delete Journal/a.md', 'delete Journal/a.md']);
    });

    it('syncs a note that moves in as a new one', async () => {
        const env = setup();
        const note = makeFile('Archive/arrives.md');
        env.files.push(note);
        await synced(env);

        env.move(note, 'Journal/arrives.md');
        await env.engine.syncAll(false);

        expect(env.sent()).toEqual(['create Journal/arrives.md']);
    });

    it('creates a note renamed before it was ever synced', async () => {
        const env = setup();
        const note = makeFile('Journal/draft.md');
        env.files.push(note);
        env.move(note, 'Journal/final.md');

        await env.engine.syncAll(false);

        expect(env.sent()).toEqual(['create Journal/final.md']);
    });
});

describe('Renamed, then deleted', () => {
    it('before the move was sent: the entry is deleted where Pensio has it', async () => {
        // The move never reached Pensio, so its entry is still at the first
        // path. ⛔ Until 0.7.2's review the delete named the second path, the
        // server answered "not found", and the entry stayed for good.
        const env = setup();
        const note = makeFile('Journal/a.md');
        env.files.push(note);
        await synced(env);

        env.move(note, 'Journal/b.md');
        env.files.splice(env.files.indexOf(note), 1);
        env.handlers['delete'](note);
        await env.engine.syncAll(false);

        expect(env.sent()).toEqual(['delete Journal/a.md', 'delete Journal/a.md']);
        expect(env.tracked()).toEqual([]);
    });
});

describe('A server that cannot, or will not, move it', () => {
    it('falls back to delete + create on an older server', async () => {
        const env = setup({ canRename: false, refuse: ['Journal/old.md'] });
        const note = makeFile('Journal/old.md');
        env.files.push(note);
        await synced(env);

        env.move(note, 'Journal/new.md');
        await env.engine.syncAll(false);

        expect(env.sent()).toEqual([
            'rename Journal/old.md → Journal/new.md',
            // A delete goes to both sections since 0.7.2 (sync/mirror.ts deleteItems).
            'delete Journal/old.md',
            'delete Journal/old.md',
            'create Journal/new.md',
        ]);
    });

    it('never deletes when a server that can rename refuses one', async () => {
        const env = setup({ canRename: true, refuse: ['Journal/old.md'] });
        const note = makeFile('Journal/old.md');
        env.files.push(note);
        await synced(env);

        env.move(note, 'Journal/new.md');
        await env.engine.syncAll(false);

        expect(env.sent()).not.toContain('delete Journal/old.md');
        expect(env.sent()).toContain('create Journal/new.md');
    });

    it('does not count a refusal reported at the new path as a move', async () => {
        const env = setup({ canRename: true, refuse: ['Journal/new.md'] });
        const note = makeFile('Journal/old.md');
        env.files.push(note);
        await synced(env);

        env.move(note, 'Journal/new.md');
        await env.engine.syncAll(false);

        expect(env.sent()).toContain('create Journal/new.md');
    });
});

describe('A move not yet sent survives a restart (0.8.0)', () => {
    it('is saved within a second of the move', async () => {
        const env = setup();
        const note = makeFile('Journal/Old.md');
        env.files.push(note);
        await synced(env);

        env.move(note, 'Journal/New.md');
        jest.advanceTimersByTime(SyncEngine.SAVE_SOON_MS);

        expect(env.saved[env.saved.length - 1].renames).toEqual({ 'Journal/Old.md': 'Journal/New.md' });
    });

    it('is saved at once when Obsidian quits, inside that second', async () => {
        // ⛔ Found by Gabriel's test of 0.8.0 (2026-10-22): a move, then Quit
        // within a second, and nothing was saved. Obsidian does not unload
        // plugins on quit; its `quit` event asks for this (plugin/wiring.ts).
        const env = setup();
        const note = makeFile('Journal/Old.md');
        env.files.push(note);
        await synced(env);
        env.move(note, 'Journal/New.md');
        // What plugin/wiring.ts::saveOnQuit asks before giving Obsidian a task.
        expect(env.engine.saveWaiting).toBe(true);

        await env.engine.saveNow();

        expect(env.saved[env.saved.length - 1].renames).toEqual({ 'Journal/Old.md': 'Journal/New.md' });
        expect(env.engine.saveWaiting).toBe(false);
    });

    it('is sent after Obsidian starts again, as a move', async () => {
        const env = setup();
        const note = makeFile('Journal/Old.md');
        env.files.push(note);
        await synced(env);
        env.move(note, 'Journal/New.md');
        jest.advanceTimersByTime(SyncEngine.SAVE_SOON_MS);

        await env.restart().syncAll(false);

        expect(env.sent()).toEqual(['rename Journal/Old.md → Journal/New.md']);
    });
});

describe('A rename the request did not expect (0.8.0)', () => {
    it('a note renamed while its first request is out keeps its entry, as a move', async () => {
        const env = setup();
        const note = makeFile('Journal/Draft.md');
        env.files.push(note);
        env.whileTheNextRequestIsOut(() => env.move(note, 'Journal/Final.md'));

        await env.engine.syncAll(false);
        env.calls.length = 0;
        await env.engine.syncAll(false);

        expect(env.sent()).toEqual(['rename Journal/Draft.md → Journal/Final.md']);
        expect(env.tracked()).toEqual(['Journal/Final.md']);
    });

    it('a move onto a taken path deletes the entry the note left', async () => {
        const env = setup({ taken: ['Journal/a.md'] });
        const note = makeFile('Journal/a.md');
        env.files.push(note);
        await synced(env);

        env.move(note, 'Journal/b.md');
        await env.engine.syncAll(false);

        // A delete goes to both sections: the path may be a note or a person.
        expect(env.sent()).toEqual(['rename Journal/a.md → Journal/b.md', 'delete Journal/a.md', 'delete Journal/a.md']);
        expect(env.tracked()).toEqual(['Journal/b.md']);
    });
});
