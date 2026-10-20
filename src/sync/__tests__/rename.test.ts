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
 */
import { TFile, TFolder } from 'obsidian';
import { BulkSyncItem, BulkSyncResponse, PensioSettings } from '../../types';
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

function setup({ canRename = true, refuse = [] as string[], mirror = false } = {}) {
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
    });
    const api = {
        bulkSync: jest.fn(async (entries: BulkSyncItem[], people: BulkSyncItem[]): Promise<BulkSyncResponse> => {
            calls.push({ entries, people });
            return {
                entries: section(entries), people: section(people), total_time_ms: 0,
                ...(canRename ? { capabilities: { rename: true } } : {}),
            };
        }),
        listEntries: jest.fn(async () => []),
        listPeople: jest.fn(async () => []),
        deleteEntry: jest.fn(async () => undefined),
        deletePerson: jest.fn(async () => undefined),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = new SyncEngine(app as any, settings, api as any);
    engine.startWatching();

    const move = (file: FakeFile, to: string): void => {
        const from = file.path;
        file.path = to;
        file.name = to.split('/').pop() as string;
        file.basename = file.name.replace(/\.md$/, '');
        handlers['rename'](file, from);
    };
    const sent = (): string[] => calls.flatMap(c => [...c.entries, ...c.people]).map(i =>
        `${i.action} ${i.file_path}${i.new_file_path ? ` → ${i.new_file_path}` : ''}`);
    const tracked = (): string[] =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Array.from(((engine as any).syncedFiles as Map<string, unknown>).keys()).sort();

    return { files, engine, api, calls, handlers, move, sent, tracked };
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

describe('Leaving and entering the synced folders', () => {
    it('keeps the entry when a note moves out — moving is not deleting', async () => {
        const env = setup();
        const note = makeFile('Journal/kept.md');
        env.files.push(note);
        await synced(env);

        env.move(note, 'Archive/kept.md');
        await env.engine.syncAll(false);

        expect(env.sent()).toEqual([]);
        expect(env.api.deleteEntry).not.toHaveBeenCalled();
        expect(env.tracked()).toEqual([]);
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
