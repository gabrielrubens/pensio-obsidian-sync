/**
 * A note's text goes once, and only to a server that said it takes it once
 * (plugin 0.7.4, review CRIT-4).
 *
 * ⛔ The bug: each note's text went twice, as `content_html` and
 * `content_plain`, because the server hashed and stored only the second. With
 * Pensio's 2 MiB limit on a request, a note over about 1 MB could not sync:
 * Gabriel's `pensio-prod-demo` vault holds a 1.1 MB note.
 *
 * ⭐ Now a server that fills `content_plain` itself says `content_once`, and
 * only after it said so does a note go without `content_plain`. An older or
 * self-hosted server, or one that has not answered yet, gets both fields.
 * A server that said it and then stops (a rollback) gets every note that
 * went once in that request again, in full.
 *
 * These run the real engine through the real ApiClient against a stand-in
 * Pensio that refuses a body over 2 MiB, and read the bodies `requestUrl` is
 * handed.
 *
 * Sabotage-checked (2026-10-21), each alone then restored, over the whole
 * suite:
 * - `shaped` leaving `content_plain` out whatever the server said → 38 RED,
 *   across the plugin's suites, among them "has not answered yet", "an older server", "the Server URL
 *   that said it", "a different account", and the 1.1 MB note of
 *   `tooLargeNote.test.ts`, which then fits a server that never said so;
 * - `shaped` never leaving it out → 11 RED: "once it said so", "a move",
 *   "a reload", the 1.5 MB notes that should sync, the 2 MB note, read
 *   again on every sync, and the three rollback tests, where nothing went
 *   once;
 * - `askIfOnceFits` never asking → 3 RED: "syncs against a server", "the
 *   only note left", "asked once";
 * - `askIfOnceFits` asking again once the server is known → "asked once"
 *   RED. ⚠️ Green until the long note was edited in it: an unchanged
 *   too-large note is skipped before anything asks;
 * - `post` not passing the answer on → 10 RED;
 * - `known()` not comparing the Server URL → "the Server URL that said it"
 *   RED;
 * - `TooLargeNotes.unchanged` ignoring `textOnce` → 3 RED: "read again once
 *   that server says", "tried again once", "over about 2 MB";
 * - getState without `capabilities` → "a reload" and "a different account"
 *   RED;
 * - a 413 refusal remembered in the shape the server says now, not the one
 *   the note went in (`textOnce()` for `wentOnce(item)`) → "tried again
 *   once" RED: refused with its text twice, it was never sent once;
 * - the loop remembering every too-large note as sent twice → "over about
 *   2 MB" RED: read again every sync.
 *
 * And for a server rolled back below `content_once` (decided 2026-10-21,
 * Gabriel's option B), each alone then restored:
 * - the loop counting a note that went once as synced (no `lostText`
 *   branch) → "every note that went once" and "did not move" RED: Pensio
 *   keeps no text for the new note and the old text for the edited ones;
 * - that branch without the dirty mark → "did not move" RED: a forced sync
 *   found the note, and its time still matches what was tracked;
 * - the rename answer counting a move that went once as synced → "a note
 *   moved" RED: the entry keeps the text it had before the move;
 * - `lostText` finding nothing → all three RED.
 * ⚠️ The rename branch had a dirty mark too, and removing it stayed green:
 * untracking the note is what sends it again there, so it was taken out.
 */
import { requestUrl, RequestUrlParam, TFile } from 'obsidian';
import { ApiClient } from '../../api/client';
import { BulkSyncItem, Capabilities, PensioSettings } from '../../types';
import { REQUEST_LIMIT_BYTES } from '../chunks';
import { SyncEngine } from '../engine';
import { FakeFile, fakeVault, folderTree } from './fakeVault';

jest.mock('obsidian');

const KB = 1024;
const LONG = 'Journal/Long note.md';

/** A line of her diary: accents, a dash, quotes, an emoji, a new line. */
const LINE = 'Hoje caminhei à beira do rio — "devagar", sem pressa, e pensei na avó. 🌊\n';
const wireBytes = (text: string): number => Buffer.byteLength(text, 'utf8');
const note = (bytes: number): string => '# Um dia\n\n' + LINE.repeat(Math.ceil(bytes / wireBytes(LINE)));
/** About 1.5 MB: under Pensio's limit sent once, over it sent twice. */
const longNote = () => note(1500 * KB);

interface Body { entries: BulkSyncItem[]; people: BulkSyncItem[] }

/**
 * Pensio as a sync meets it: it refuses a body over 2 MiB with a JSON 413, and
 * says what it can do in every answer. `says` can change between syncs (an
 * upgrade, or a rollback). It keeps each note's text the way the server does:
 * `content_plain` when sent, `content_html` in its place only while it says
 * `content_once`, and otherwise nothing new: no text for a new note, the old
 * text for one it already has.
 */
function pensio(says: Capabilities, limit = REQUEST_LIMIT_BYTES) {
    const bodies: Body[] = [];
    const texts = new Map<string, string>();
    let refusals = 0;
    const keep = (item: BulkSyncItem) => {
        const path = item.new_file_path ?? item.file_path;
        if (item.new_file_path !== undefined && texts.has(item.file_path)) {
            texts.set(path, texts.get(item.file_path) ?? '');
            texts.delete(item.file_path);
        }
        const data = (item.data ?? {}) as { content_html?: string; content_plain?: string };
        const text = data.content_plain ?? (server.says.content_once ? data.content_html : undefined);
        if (text !== undefined) texts.set(path, text);
        else if (!texts.has(path)) texts.set(path, '');
    };
    const server = {
        says,
        bodies,
        /** The text Pensio holds for the note at this path, as it would read it. */
        stored: (path: string) => texts.get(path),
        refusals: () => refusals,
        /** Every entry it was sent, in order: the probe sends none. */
        entries: () => bodies.flatMap(b => b.entries),
        sent: (path: string) => bodies.flatMap(b => b.entries).filter(i => (i.new_file_path ?? i.file_path) === path),
        largest: () => Math.max(0, ...bodies.map(b => wireBytes(JSON.stringify(b)))),
    };
    (requestUrl as unknown as jest.Mock).mockReset().mockImplementation(async (params: RequestUrlParam) => {
        const body = typeof params.body === 'string' ? params.body : '';
        if (wireBytes(body) > limit) {
            refusals++;
            return {
                status: 413, headers: {}, text: '{}',
                json: { error: { code: 'payload_too_large', message: 'Too large.', limit_bytes: limit, status_code: 413 } },
            };
        }
        const sent = JSON.parse(body) as Body;
        bodies.push(sent);
        sent.entries.forEach(keep);
        const part = (n: number) => ({ created: n, updated: 0, deleted: 0, renamed: 0, skipped: 0, errors: [] });
        const json = {
            entries: part(sent.entries.length), people: part(sent.people.length), total_time_ms: 0,
            capabilities: { ...server.says },
        };
        return { status: 200, headers: {}, text: JSON.stringify(json), json };
    });
    return server;
}

const hasPlain = (item: BulkSyncItem): boolean => item.data !== undefined && 'content_plain' in item.data;

const EDIT = 'E mais uma linha, escrita depois.\n';

function setup(files: FakeFile[]) {
    let local = files;
    const texts = new Map<string, string>();
    const text = (path: string) => texts.get(path) ?? (path === LONG ? longNote() : note(2 * KB));
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
    (vault.read as jest.Mock).mockImplementation(async (file: { path: string }) => text(file.path));
    const engine = new SyncEngine({ vault } as never, settings, new ApiClient(settings));
    const reads = (path: string) => (vault.read as jest.Mock).mock.calls.filter(([f]) => (f as { path: string }).path === path).length;
    return {
        engine, settings, vault, reads,
        setFiles: (next: FakeFile[]) => { local = next; },
        /** What this note holds now. */
        text,
        /** This note holds `text`. */
        write: (path: string, text: string) => { texts.set(path, text); },
        /** She adds a line to this note. */
        edit: (path: string) => {
            texts.set(path, text(path) + EDIT);
            local = local.map(f => (f.path === path ? at(path, (f.stat?.mtime ?? 0) + 1) : f));
        },
    };
}

const at = (path: string, mtime: number): FakeFile => ({ path, stat: { mtime, ctime: 1, size: 0 } });

describe('a note’s text', () => {
    it('goes twice to a server that has not answered yet', async () => {
        const server = pensio({ rename: true, content_once: true });
        const { engine } = setup([at('Journal/a.md', 1), at('Journal/b.md', 1)]);

        await engine.syncAll();

        expect(server.entries()).toHaveLength(2);
        expect(server.entries().every(hasPlain)).toBe(true);
    });

    it('goes once to that server, once it said so', async () => {
        const server = pensio({ rename: true, content_once: true });
        const { engine, edit } = setup([at('Journal/a.md', 1), at('Journal/b.md', 1)]);
        await engine.syncAll();

        edit('Journal/a.md');
        await engine.syncAll();

        const again = server.sent('Journal/a.md')[1];
        expect((again.data as { content_html: string }).content_html.endsWith(EDIT)).toBe(true);
        expect(hasPlain(again)).toBe(false);
    });

    it('always goes twice to an older server, or one that has not updated', async () => {
        const server = pensio({ rename: true });
        const { engine, edit } = setup([at('Journal/a.md', 1)]);
        await engine.syncAll();
        edit('Journal/a.md');
        await engine.syncAll();

        expect(server.sent('Journal/a.md')).toHaveLength(2);
        expect(server.entries().every(hasPlain)).toBe(true);
    });

    it('goes once in a move to that server', async () => {
        jest.useFakeTimers();
        try {
            const server = pensio({ rename: true, content_once: true });
            const { engine, vault, setFiles } = setup([at('Journal/a.md', 1)]);
            engine.startWatching();
            await engine.syncAll();

            setFiles([at('Journal/Renamed.md', 1)]);
            const onRename = (vault.on as jest.Mock).mock.calls.find(([event]) => event === 'rename')?.[1] as
                (file: TFile, oldPath: string) => void;
            const moved = folderTree([at('Journal/Renamed.md', 1)]).get('Journal')?.children[0] as TFile;
            onRename(moved, 'Journal/a.md');
            await engine.syncAll();
            engine.stopWatching();

            const move = server.entries().find(i => i.action === 'rename');
            expect(move?.new_file_path).toBe('Journal/Renamed.md');
            expect(move && hasPlain(move)).toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('a note of about 1.5 MB', () => {
    it('syncs against a server that takes the text once', async () => {
        const server = pensio({ rename: true, content_once: true });
        const { engine } = setup([at('Journal/a.md', 1), at(LONG, 1), at('Journal/c.md', 1)]);

        const result = await engine.syncAll();

        const [long] = server.sent(LONG);
        expect(long && hasPlain(long)).toBe(false);
        expect(long?.data).toMatchObject({ content_html: longNote() });
        expect(server.refusals()).toBe(0);
        expect(server.largest()).toBeGreaterThan(1.5 * 1000 * KB);       // the premise: it is that long …
        expect(server.largest()).toBeLessThanOrEqual(REQUEST_LIMIT_BYTES); // … and it fits
        expect(result).toMatchObject({ synced: 3, errors: 0, tooLarge: [] });
    });

    it('syncs when it is the only note left to sync: the plugin asks the server first', async () => {
        // Gabriel's demo vault on the first sync after the update: every
        // other note was synced long ago, so nothing else would bring an answer.
        const server = pensio({ rename: true, content_once: true });
        const { engine } = setup([at(LONG, 1)]);

        const result = await engine.syncAll();

        expect(server.bodies.map(b => b.entries.length)).toEqual([0, 1]);   // the question, then the note
        expect(hasPlain(server.sent(LONG)[0])).toBe(false);
        expect(result).toMatchObject({ synced: 1, tooLarge: [] });
    });

    it('is too large for an older server, which is asked once and never sent it', async () => {
        const server = pensio({ rename: true });
        const { engine, reads, edit } = setup([at(LONG, 1)]);

        const first = await engine.syncAll();
        const second = await engine.syncAll();
        expect(reads(LONG)).toBe(1);                         // not read again …
        edit(LONG);
        const third = await engine.syncAll();                // … until she edits it

        expect(reads(LONG)).toBe(2);
        expect(server.bodies).toHaveLength(1);              // the one question, never asked again
        expect(server.sent(LONG)).toEqual([]);
        expect(server.refusals()).toBe(0);
        expect([first.tooLarge, second.tooLarge, third.tooLarge]).toEqual([[LONG], [LONG], [LONG]]);
    });

    it('is read again once that server says it takes the text once', async () => {
        const server = pensio({ rename: true });
        const { engine, edit } = setup([at(LONG, 1), at('Journal/a.md', 1)]);
        await engine.syncAll();
        expect(engine.getTooLargeNotes()).toEqual([LONG]);

        server.says = { rename: true, content_once: true };   // Pensio is updated
        edit('Journal/a.md');                                   // and she edits another note
        await engine.syncAll();                                // whose answer says so
        const result = await engine.syncAll();

        expect(hasPlain(server.sent(LONG)[0])).toBe(false);
        expect(result.tooLarge).toEqual([]);
    });
});

describe('a note a smaller server refused', () => {
    it('is tried again once if it went with its text twice and the server then said it takes it once', async () => {
        // A self-hosted server with a 300 KB limit: the first answer of the
        // sync says content_once, after this note was built with its text twice.
        const server = pensio({ rename: true, content_once: true }, 300 * KB);
        const { engine, write } = setup([at('Journal/a.md', 1), at('Journal/Mid.md', 1)]);
        write('Journal/Mid.md', note(200 * KB));

        const first = await engine.syncAll();
        const second = await engine.syncAll();

        expect(first.tooLarge).toEqual(['Journal/Mid.md']);       // refused alone, sent twice
        expect(hasPlain(server.sent('Journal/Mid.md')[0])).toBe(false);
        expect(second.tooLarge).toEqual([]);
    });
});

describe('a note over about 2 MB', () => {
    it('is too large even once, and is not read again until she edits it', async () => {
        const server = pensio({ rename: true, content_once: true });
        const { engine, reads, write } = setup([at('Journal/a.md', 1), at(LONG, 1)]);
        write(LONG, note(2100 * KB));

        const results = [await engine.syncAll(), await engine.syncAll(), await engine.syncAll()];

        expect(results.map(r => r.tooLarge)).toEqual([[LONG], [LONG], [LONG]]);
        // Read once with the text twice (the server had not answered), once
        // more with it once, then left alone.
        expect(reads(LONG)).toBe(2);
        expect(server.sent(LONG)).toEqual([]);
        expect(server.refusals()).toBe(0);
    });
});

describe('a server rolled back below content_once', () => {
    // ⛔ Its answer still says 200: it took the notes that went once, and kept
    // no text for the new one and the old text for the edited ones.
    it('gets every note that went once in that request again, in full, the next sync', async () => {
        const server = pensio({ rename: true, content_once: true });
        const { engine, edit, text, setFiles } = setup([at('Journal/a.md', 1), at('Journal/b.md', 1)]);
        await engine.syncAll();                          // it said content_once

        edit('Journal/a.md');
        edit('Journal/b.md');
        setFiles([at('Journal/a.md', 2), at('Journal/b.md', 2), at('Journal/New.md', 1)]);
        server.says = { rename: true };                  // Pensio is rolled back
        const rolledBack = await engine.syncAll();
        expect(server.stored('Journal/New.md')).toBe(''); // the premise: the text is lost there
        expect(server.stored('Journal/a.md')).not.toBe(text('Journal/a.md'));

        const again = await engine.syncAll();
        const after = await engine.syncAll();

        for (const path of ['Journal/a.md', 'Journal/b.md']) {
            expect(server.sent(path).map(hasPlain)).toEqual([true, false, true]);
            expect(server.stored(path)).toBe(text(path));
        }
        expect(server.sent('Journal/New.md').map(hasPlain)).toEqual([false, true]);
        expect(server.stored('Journal/New.md')).toBe(text('Journal/New.md'));
        expect([rolledBack.synced, again.synced, after.synced]).toEqual([0, 3, 0]);
    });

    it('gets it again even when its modification time did not move', async () => {
        // A forced sync found it changed (a tool that keeps the time): only
        // the dirty mark brings it back, since its time still matches.
        const server = pensio({ rename: true, content_once: true });
        const { engine, write, text } = setup([at('Journal/a.md', 1)]);
        await engine.syncAll();

        write('Journal/a.md', note(2 * KB) + EDIT);
        server.says = { rename: true };
        await engine.syncAll(true);
        await engine.syncAll();

        expect(server.sent('Journal/a.md').map(hasPlain)).toEqual([true, false, true]);
        expect(server.stored('Journal/a.md')).toBe(text('Journal/a.md'));
    });

    it('gets a note moved in that request again, in full, at its new path', async () => {
        jest.useFakeTimers();
        try {
            const server = pensio({ rename: true, content_once: true });
            const { engine, vault, setFiles, write, text } = setup([at('Journal/a.md', 1)]);
            engine.startWatching();
            await engine.syncAll();

            setFiles([at('Journal/Renamed.md', 1)]);
            write('Journal/Renamed.md', note(2 * KB) + EDIT);    // moved and edited
            const onRename = (vault.on as jest.Mock).mock.calls.find(([event]) => event === 'rename')?.[1] as
                (file: TFile, oldPath: string) => void;
            onRename(folderTree([at('Journal/Renamed.md', 1)]).get('Journal')?.children[0] as TFile, 'Journal/a.md');
            server.says = { rename: true };                       // Pensio is rolled back
            await engine.syncAll();
            const after = await engine.syncAll();
            engine.stopWatching();

            expect(server.sent('Journal/Renamed.md').map(i => [i.action, hasPlain(i)])).toEqual([['rename', false], ['create', true]]);
            expect(server.stored('Journal/Renamed.md')).toBe(text('Journal/Renamed.md'));
            expect(server.stored('Journal/a.md')).toBeUndefined();
            expect(after.synced).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('what the server said', () => {
    it('survives a reload', async () => {
        const server = pensio({ rename: true, content_once: true });
        const before = setup([at('Journal/a.md', 1)]);
        await before.engine.syncAll();

        const after = setup([at('Journal/a.md', 1)]);
        after.engine.restoreState(before.engine.getState());
        after.edit('Journal/a.md');
        await after.engine.syncAll();

        expect(hasPlain(server.sent('Journal/a.md')[1])).toBe(false);
    });

    it('counts only for the Server URL that said it', async () => {
        const server = pensio({ rename: true, content_once: true });
        const { engine, settings, edit } = setup([at('Journal/a.md', 1)]);
        await engine.syncAll();

        settings.apiUrl = 'https://journal.example.org';      // her own server now
        edit('Journal/a.md');
        await engine.syncAll();

        expect(hasPlain(server.sent('Journal/a.md')[1])).toBe(true);
    });

    it('is forgotten for a different account', async () => {
        const server = pensio({ rename: true, content_once: true });
        const { engine } = setup([at('Journal/a.md', 1)]);
        await engine.syncAll();

        engine.clearState();
        await engine.syncAll();

        expect(engine.getState().capabilities).toEqual({ server: 'https://pensio.app', capabilities: { rename: true, content_once: true } });
        expect(hasPlain(server.sent('Journal/a.md')[1])).toBe(true);
    });
});
