/**
 * A sync never sends Pensio a request larger than it takes (plugin 0.7.3,
 * review CRIT-4).
 *
 * ⛔ The bug: notes went fifty to a request, whatever their size, each note's
 * text twice (`content_html` and `content_plain`). Pensio refuses a body over
 * 2 MiB with an HTML 400 before the sync code runs, so fifty long notes failed
 * on the same request every sync, forever, and nothing behind them synced.
 *
 * ⭐ These run the real engine through the real ApiClient, and measure the
 * request bodies Obsidian's `requestUrl` is handed: the bytes that would go on
 * the wire, not a count of notes. The notes are written the way she writes, in
 * Portuguese with a dash, quotes, an emoji and new lines, each of which weighs
 * more on the wire than it looks.
 *
 * Sabotage-checked (2026-10-21), each alone then restored:
 * - sendInChunks without the byte budget (fifty notes a request, the 0.7.2
 *   rule) → "50 notes of 30 KB", "bytes, not characters" and "a folder of
 *   long notes moved" RED (one request; 3,132,975 bytes for the Japanese
 *   notes). ⚠️ Run those three alone: under this sabotage the halving test
 *   never ends, since nothing makes a refused request smaller;
 * - utf8Bytes counting characters instead of bytes → "bytes, not
 *   characters", "50 notes of 30 KB", "a folder of long notes moved" and "to
 *   the byte" RED. ⚠️ The first version measured the bodies with utf8Bytes
 *   itself and stayed green: the sabotaged function vouched for itself. The
 *   bodies are measured by Node's Buffer.byteLength now;
 * - tooLargeAlone measured against the budget instead of Pensio's limit →
 *   "a request of its own" RED (the note is called too large);
 * - a 413 thrown like any other failure → "halve" and "refuses alone" RED;
 * - the halved budget kept for one request only → "halve" RED;
 * - requestBytes without the commas between notes → "to the byte" RED;
 * - processRenames sending every move in one request again → "a folder of
 *   long notes moved" RED.
 */
import { requestUrl, RequestUrlParam, TFile } from 'obsidian';
import { ApiClient } from '../../api/client';
import { BulkSyncItem, PensioSettings } from '../../types';
import { bulkPayload, CHUNK_BUDGET_BYTES, itemBytes, REQUEST_LIMIT_BYTES, requestBytes } from '../chunks';
import { SyncEngine } from '../engine';
import { FakeFile, fakeVault, folderTree } from './fakeVault';

jest.mock('obsidian');

const KB = 1024;

/** A line of her diary: accents, a dash, quotes, an emoji, a new line. */
const LINE = 'Hoje caminhei à beira do rio — "devagar", sem pressa, e pensei na avó. 🌊\n';

/**
 * What a body weighs on the wire, measured by Node, never by the code under
 * test: a sabotaged `utf8Bytes` must not be able to vouch for itself.
 */
const wireBytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** A note of at least `bytes` UTF-8 bytes, written in `line`s. */
function note(bytes: number, line = LINE): string {
    const head = '# Um dia\n\n';
    return head + line.repeat(Math.ceil((bytes - wireBytes(head)) / wireBytes(line)));
}

interface Sent { entries: { file_path: string; new_file_path?: string }[]; people: { file_path: string }[] }

/**
 * Pensio, as a sync meets it: it answers each bulk request, and refuses a body
 * over `limit` the way it does since 0.7.3, with a JSON 413. A test of what
 * the plugin SENDS takes any size (`Infinity`), so it measures the plugin and
 * not this stand-in's refusals.
 */
function pensio(limit = REQUEST_LIMIT_BYTES) {
    const attempts: number[] = [];
    const accepted: Sent[] = [];
    let refusals = 0;
    (requestUrl as unknown as jest.Mock).mockReset().mockImplementation(async (params: RequestUrlParam) => {
        const body = typeof params.body === 'string' ? params.body : '';
        attempts.push(wireBytes(body));
        if (wireBytes(body) > limit) {
            refusals++;
            return {
                status: 413, headers: {}, text: '{}',
                json: { error: { code: 'payload_too_large', message: 'Too large.', limit_bytes: limit, status_code: 413 } },
            };
        }
        const sent = JSON.parse(body) as Sent;
        accepted.push(sent);
        const part = (n: number) => ({ created: n, updated: 0, deleted: 0, skipped: 0, errors: [] });
        const json = { entries: part(sent.entries.length), people: part(sent.people.length), total_time_ms: 0, capabilities: { rename: true } };
        return { status: 200, headers: {}, text: JSON.stringify(json), json };
    });
    return {
        attempts,
        accepted,
        refusals: () => refusals,
        sentPaths: () => accepted.flatMap(s => [...s.entries, ...s.people].map(i => i.file_path)),
        largest: () => Math.max(...attempts),
    };
}

function setup(files: FakeFile[], contents: (path: string) => string) {
    let local = files;
    const settings: PensioSettings = {
        apiUrl: 'https://pensio.app', deviceId: 'test', autoSync: true,
        journalFolders: [{ folder: 'Journal' }], peopleFolder: 'People',
        enableMirrorDelete: false, debugMode: false,
    };
    const vault = {
        ...fakeVault(() => local),
        getAbstractFileByPath: (path: string) =>
            folderTree(local).get(path.slice(0, path.lastIndexOf('/')))?.children.find(c => c.path === path) ?? null,
    };
    (vault.read as jest.Mock).mockImplementation(async (file: { path: string }) => contents(file.path));
    const engine = new SyncEngine({ vault } as never, settings, new ApiClient(settings));
    return { engine, vault, setFiles: (next: FakeFile[]) => { local = next; } };
}

const fifty = (folder = 'Journal'): FakeFile[] =>
    Array.from({ length: 50 }, (_, i) => ({ path: `${folder}/Day ${String(i + 1).padStart(2, '0')}.md` }));

describe('requestBytes', () => {
    it('is the size of the body ApiClient sends, to the byte', () => {
        const item = (path: string): BulkSyncItem => ({
            action: 'create', file_path: path,
            data: { title: 'Avó', content_html: LINE, content_plain: LINE, entry_date: null, entry_type: 'daily_journal', file_path: path, frontmatter: {}, file_modified_at: '' },
        });
        for (const items of [[], [item('Journal/a.md')], [item('Journal/a.md'), item('Journal/b.md'), item('Journal/ç.md')]]) {
            const sizes = items.map(itemBytes);
            expect(requestBytes(sizes)).toBe(wireBytes(JSON.stringify(bulkPayload(items, []))));
            expect(requestBytes(sizes)).toBe(wireBytes(JSON.stringify(bulkPayload([], items))));
        }
    });
});

describe('a sync’s requests', () => {
    it('carry 50 notes of 30 KB in requests of at most 1.5 MiB, each note once', async () => {
        const server = pensio(Infinity);
        const files = fifty();
        const { engine } = setup(files, () => note(30 * KB));

        const result = await engine.syncAll();

        expect(server.attempts.length).toBeGreaterThan(1);   // they do not fit in one
        expect(server.largest()).toBeLessThanOrEqual(CHUNK_BUDGET_BYTES);
        expect(server.sentPaths().sort()).toEqual(files.map(f => f.path).sort());
        expect(result).toMatchObject({ synced: 50, errors: 0, tooLarge: [] });
    });

    it('are measured in bytes, not characters', async () => {
        // Japanese: three bytes a character. Counted in characters, a request
        // of these weighs three times what was counted.
        const server = pensio(Infinity);
        const { engine } = setup(fifty(), () => note(30 * KB, '今日は川沿いをゆっくり歩いて、祖母のことを考えた。\n'));

        await engine.syncAll();

        expect(server.largest()).toBeLessThanOrEqual(CHUNK_BUDGET_BYTES);
        expect(server.sentPaths()).toHaveLength(50);
    });

    it('send a note bigger than a request’s budget, but under Pensio’s limit, in a request of its own', async () => {
        const server = pensio(Infinity);
        const files = [{ path: 'Journal/a.md' }, { path: 'Journal/Long note.md' }, { path: 'Journal/c.md' }];
        const { engine } = setup(files, path => (path === 'Journal/Long note.md' ? note(850 * KB) : note(2 * KB)));

        const result = await engine.syncAll();

        const alone = server.accepted.find(s => s.entries.some(i => i.file_path === 'Journal/Long note.md'));
        expect(alone?.entries.map(i => i.file_path)).toEqual(['Journal/Long note.md']);
        expect(server.largest()).toBeGreaterThan(CHUNK_BUDGET_BYTES);    // the premise: over the budget …
        expect(server.largest()).toBeLessThanOrEqual(REQUEST_LIMIT_BYTES); // … and under the limit
        expect(result).toMatchObject({ synced: 3, tooLarge: [] });
    });

    it('halve when a server says a request is too large, and keep the smaller size', async () => {
        // A self-hosted server with a limit smaller than Pensio's.
        const server = pensio(600 * KB);
        const { engine } = setup(fifty(), () => note(30 * KB));

        const result = await engine.syncAll();

        expect(server.refusals()).toBe(2);          // 1.5 MiB, then 0.75, then fits
        expect(server.sentPaths()).toHaveLength(50);
        expect(result).toMatchObject({ synced: 50, errors: 0, tooLarge: [] });
    });

    it('call a note a server refuses alone too large, and sync the rest', async () => {
        const server = pensio(300 * KB);
        const files = [{ path: 'Journal/a.md' }, { path: 'Journal/Long note.md' }, { path: 'Journal/c.md' }];
        const { engine } = setup(files, path => (path === 'Journal/Long note.md' ? note(200 * KB) : note(2 * KB)));

        const result = await engine.syncAll();

        expect(server.sentPaths().sort()).toEqual(['Journal/a.md', 'Journal/c.md']);
        expect(result).toMatchObject({ synced: 2, errors: 0, tooLarge: ['Journal/Long note.md'] });
        expect(engine.getLastSyncTime()).not.toBeNull();
    });
});

describe('moves', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    it('of a folder of long notes moved at once go in requests under the budget', async () => {
        const server = pensio(Infinity);
        const before = fifty('Journal/Trip');
        const { engine, vault, setFiles } = setup(before, () => note(30 * KB));
        engine.startWatching();
        await engine.syncAll();
        server.attempts.length = 0;
        server.accepted.length = 0;

        const after = fifty('Journal/Trip to Lisbon');
        setFiles(after);
        const onRename = (vault.on as jest.Mock).mock.calls.find(([event]) => event === 'rename')?.[1] as
            (file: TFile, oldPath: string) => void;
        const tree = folderTree(after).get('Journal/Trip to Lisbon');
        for (const file of tree?.children ?? []) {
            onRename(file as TFile, file.path.replace('Journal/Trip to Lisbon/', 'Journal/Trip/'));
        }
        await engine.syncAll();
        engine.stopWatching();

        const moved = server.accepted.flatMap(s => s.entries).filter(i => i.new_file_path);
        expect(moved).toHaveLength(50);
        expect(server.attempts.length).toBeGreaterThan(1);
        expect(server.largest()).toBeLessThanOrEqual(CHUNK_BUDGET_BYTES);
    });
});
