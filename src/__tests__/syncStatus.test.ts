/**
 * A sync that fails says so: once when it happened by itself, every time she
 * asked, and in the status bar until a sync works again.
 *
 * ⛔ The bug: an AUTOMATIC sync (on startup, on a change, every five minutes)
 * that failed went to the console and nowhere else, so a vault could stop
 * syncing for days with nothing on screen; and a sync she asked for showed a
 * notice too short to read, in the engine's words.
 *
 * Sabotage-checked (2026-10-20), each alone then restored:
 * - SyncStatus.failed telling on every automatic failure (no first-of-streak)
 *   → "says so once" RED;
 * - offline no longer exempt → "tells only the status bar" RED;
 * - recovered() (synced(true) since 0.7.3) not hiding the notice → "takes
 *   the notice away" RED;
 * - the periodic sync's catch not calling onSyncFailed → "an automatic sync
 *   reports" RED;
 * - syncAll throwing a plain Error instead of SyncFailure → "end to end" RED;
 * - emit() walking the live listener Set → "hears the next change" RED.
 *
 * Re-checked on 0.7.1 (2026-10-20): the busy kind drawn as "sync failed" →
 * "a rate limit reads busy" RED.
 *
 * 0.7.3 (2026-10-21, review CRIT-4), each alone then restored:
 * - synced() emitting only when it cleared a problem (as recovered() did) →
 *   "draws the card again … even one that sent nothing" RED;
 * - explain() without the too-large sentences → "never says nothing is
 *   waiting" RED.
 * - "an automatic sync reports how it ended" now gives up in real time, not
 *   after 200 turns (it failed on CI, run 39581404184). Reproduced: with the
 *   note's read slowed by 400 turns, the 200-turn wait goes RED ("expected 1
 *   call, received 0") and the real-time one passes. Re-checked: the periodic
 *   sync's catch not calling onSyncFailed → that test RED.
 *
 * ⚠️ That last one was found by sabotage, not review: making the status card
 * redraw the tab on every change ran Node out of memory, because the redrawn
 * card subscribed while the Set was being walked and was called in the same
 * walk, redrew, subscribed again, and so on.
 */
import { Notice } from 'obsidian';
import { RefreshError } from '../auth/tokenManager';
import { HttpError, SyncFailure } from '../errors';
import { SyncEngine } from '../sync/engine';
import { fakeVault } from '../sync/__tests__/fakeVault';
import { SyncStatus } from '../syncStatus';
import { PensioSettings } from '../types';

const NoticeMock = Notice as unknown as jest.Mock;
const shown = (): string[] => NoticeMock.mock.calls.map(call => call[0] as string);
const lastNotice = (): { hide: jest.Mock } => NoticeMock.mock.results[NoticeMock.mock.results.length - 1].value as { hide: jest.Mock };

/** A status bar that keeps the words drawn on it. */
function statusBar() {
    const bar = {
        words: [] as string[],
        empty: () => { bar.words = []; },
        createSpan: (options: { text?: string }) => {
            if (options?.text) bar.words.push(options.text);
            return {};
        },
    };
    return bar;
}

function makeStatus(state = { invalid: false }, tooLarge: string[] = []) {
    const bar = statusBar();
    const status = new SyncStatus({
        statusBar: () => bar as unknown as HTMLElement,
        isAuthInvalidated: () => state.invalid,
        trackedCount: () => 412,
        failureContext: () => ({ apiUrl: 'https://pensio.app', retries: true }),
        tooLarge: () => tooLarge,
    });
    return { status, bar, state };
}

const offline = () => new Error('net::ERR_INTERNET_DISCONNECTED');
const serverDown = () => new HttpError('Bad gateway', 502);

beforeEach(() => NoticeMock.mockClear());

describe('the sync status', () => {
    it('says so once when an automatic sync fails, and the status bar keeps saying it', () => {
        const { status, bar } = makeStatus();

        status.failed(serverDown(), { asked: false });
        status.failed(serverDown(), { asked: false });
        status.failed(serverDown(), { asked: false });

        expect(shown()).toEqual([
            'Pensio: Sync failed. Pensio’s server had a problem (error 502). Nothing was lost. The plugin tries again every 5 minutes.',
        ]);
        expect(NoticeMock.mock.calls[0][1]).toBe(0);
        expect(bar.words).toEqual(['Pensio sync failed']);
    });

    it('a rate limit reads busy in the status bar, not failed', () => {
        const { status, bar } = makeStatus();

        status.failed(new HttpError('Rate limit exceeded', 429), { asked: false });

        expect(bar.words).toEqual(['Pensio busy']);
        expect(shown()[0]).toBe(
            'Pensio: Sync failed. Pensio is limiting requests for now. Nothing is lost. The plugin tries again every 5 minutes.'
        );
    });

    it('takes the notice away when a sync works again', () => {
        const { status, bar } = makeStatus();
        status.failed(serverDown(), { asked: false });
        const notice = lastNotice();

        status.synced(true);

        expect(notice.hide).toHaveBeenCalled();
        expect(status.getProblem()).toBeNull();
        expect(bar.words).toEqual(['412 synced']);
    });

    it('tells only the status bar when an automatic sync cannot reach Pensio', () => {
        const { status, bar } = makeStatus();

        status.failed(offline(), { asked: false });

        expect(shown()).toEqual([]);
        expect(bar.words).toEqual(['Pensio offline']);
        expect(status.getProblem()?.explanation.kind).toBe('offline');
    });

    it('always says how a sync she asked for failed, replacing the last notice', () => {
        const { status } = makeStatus();

        status.failed(offline(), { asked: true });
        const first = lastNotice();
        status.failed(offline(), { asked: true });

        expect(shown()).toHaveLength(2);
        expect(shown()[0]).toBe(
            'Pensio: Sync failed. Couldn’t reach Pensio. Check your internet connection. The plugin tries again every 5 minutes.'
        );
        expect(first.hide).toHaveBeenCalled();
    });

    it('tells about a stopped connection once, not again for the sync that met it', () => {
        const { status, bar, state } = makeStatus();
        state.invalid = true;

        status.connectionStopped();
        status.failed(new RefreshError('auth-invalid', 'expired'), { asked: false });

        expect(shown()).toHaveLength(1);
        expect(shown()[0]).toContain('press Connect to Pensio');
        expect(bar.words).toEqual(['Reconnect Pensio']);
    });

    it('says what is wrong again when the status bar is pressed', () => {
        const { status } = makeStatus();
        status.failed(offline(), { asked: false });

        status.explain();

        expect(shown()).toEqual([
            'Pensio: Sync failed. Couldn’t reach Pensio. Check your internet connection. The plugin tries again every 5 minutes.',
        ]);
        expect(NoticeMock.mock.calls[0][1]).toBe(0);
    });

    it('tells its listeners about every change, until they stop listening', () => {
        const { status } = makeStatus();
        const heard = jest.fn();
        const stop = status.onChange(heard);

        status.failed(offline(), { asked: false });
        status.synced(true);
        stop();
        status.failed(offline(), { asked: false });

        expect(heard).toHaveBeenCalledTimes(2);
    });

    it('a listener added while a change is told hears the next change, not this one', () => {
        // What a redrawn settings tab does: the old card stops listening and
        // the new one starts, from inside the listener.
        const { status } = makeStatus();
        const newcomer = jest.fn();
        const stop = status.onChange(() => {
            stop();
            status.onChange(newcomer);
        });

        status.failed(offline(), { asked: false });
        expect(newcomer).not.toHaveBeenCalled();

        status.synced(true);
        expect(newcomer).toHaveBeenCalledTimes(1);
    });

    it('draws the card again after a sync that worked, even one that sent nothing (0.7.3)', () => {
        // A note found too large by a sync with nothing to send: the card's
        // line about it comes from that sync.
        const { status } = makeStatus();
        const heard = jest.fn();
        status.onChange(heard);

        status.synced(false);

        expect(heard).toHaveBeenCalledTimes(1);
    });

    it('never says nothing is waiting while a note is too large to sync (0.7.3)', () => {
        const { status } = makeStatus({ invalid: false }, ['Journal/Long note.md']);

        status.explain();

        expect(shown()).toEqual([
            'Pensio: 412 notes synced. 1 note is too large to sync: Long note. Split it into smaller notes to sync it.',
        ]);
    });
});

describe('the sync engine', () => {
    const settings: PensioSettings = {
        apiUrl: 'https://pensio.app',
        deviceId: 'test',
        autoSync: true,
        journalFolders: [{ folder: 'Journal' }],
        peopleFolder: 'People',
        enableMirrorDelete: false,
        debugMode: false,
    };

    function engineWhoseUploadFails(error: unknown) {
        const vault = fakeVault(() => [{ path: 'Journal/2026-10-20.md' }]);
        (vault.read as jest.Mock).mockResolvedValue('# Today\n\nA walk by the river.');
        const api = {
            isAuthInvalidated: () => false,
            bulkSync: jest.fn().mockRejectedValue(error),
        };
        return new SyncEngine({ vault } as never, settings, api as never);
    }

    it('end to end: keeps the request that failed, so the notice can say why', async () => {
        const engine = engineWhoseUploadFails(offline());
        const { status } = makeStatus();

        const thrown = await engine.syncAll(false).catch((error: unknown) => error);
        status.failed(thrown, { asked: true });

        expect(thrown).toBeInstanceOf(SyncFailure);
        expect(shown()).toEqual([
            'Pensio: Sync failed. Couldn’t reach Pensio. Check your internet connection. The plugin tries again every 5 minutes.',
        ]);
    });

    it('an automatic sync reports how it ended', async () => {
        // setImmediate stays real: hashing a note finishes on real I/O, which
        // fake timers do not wait for, so each sync is waited for by hand.
        // ⛔ Not a number of turns that happens to be enough here: 200 was,
        // locally, and on CI's slower runner the startup sync was still
        // running when the five-minute one came due, which then skipped (a
        // sync already in progress), so the test saw one failure, not two
        // (#1522, run 39581404184). A sync waits on real I/O, so the give-up
        // point is in real time (`performance` stays real for it). It returns
        // the moment `done` holds; it is not a sleep.
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'performance'] });
        const until = async (done: () => boolean) => {
            const start = performance.now();
            while (!done() && performance.now() - start < 2000) await new Promise(resolve => setImmediate(resolve));
        };
        try {
            const engine = engineWhoseUploadFails(serverDown());
            const failed = jest.fn();
            engine.onSyncFailed = failed;

            engine.startWatching();
            engine.startAutoSync();
            await jest.advanceTimersByTimeAsync(6000);
            await until(() => failed.mock.calls.length === 1);
            expect(failed).toHaveBeenCalledTimes(1);    // the startup sync ended first
            await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
            await until(() => failed.mock.calls.length === 2);

            // The startup sync, then the five-minute one.
            expect(failed).toHaveBeenCalledTimes(2);
            expect(failed.mock.calls[0][0]).toBeInstanceOf(SyncFailure);
            engine.stopWatching();
        } finally {
            jest.useRealTimers();
        }
    });
});
