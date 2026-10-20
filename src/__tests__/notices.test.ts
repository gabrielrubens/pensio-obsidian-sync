/**
 * Every notice is Pensio's, a failure stays, and it says what went wrong,
 * promising only what will happen.
 *
 * ⛔ The bug (reported 2026-10-20): a failed sync showed "Sync failed: Sync
 * completed with 1 error(s): Bulk sync chunk: …" for Obsidian's default few
 * seconds. Nothing said it came from Pensio, so it could have been any plugin;
 * it was gone before it could be read; and its words were the sync engine's
 * bookkeeping, so even read in time it said neither what was wrong nor what to
 * do about it.
 *
 * ⛔ And in 0.7.0 itself (Gabriel's report, the same evening): every 429 read
 * "Pensio is getting too many requests from this vault … The plugin tries
 * again every 5 minutes", after a Test connection and a Connect too, which
 * nothing retries, and no limit is per vault (review F14). A refresh that got
 * a 429 or a 5xx read "Couldn't reach Pensio. Check your internet connection"
 * (review F20).
 *
 * Sabotage-checked (2026-10-20), each alone then restored:
 * - notify() without the "Pensio: " prefix → "says it comes from Pensio" RED;
 * - NOTICE_MS.failure set to 6000 → "stays until dismissed" RED;
 * - a `new Notice(` added to connectionSection.ts → "is made nowhere else" RED;
 * - explainFailure ignoring SyncFailure.underlying → the bulk-sync test RED.
 * Re-checked on 0.7.1 (2026-10-20), each alone then restored:
 * - the busy next step ignoring `retries` → "promises a retry only when there
 *   is one" RED;
 * - the busy reason ignoring the server's scope → "names the limit" RED;
 * - a refresh with any status read as offline again → "a refresh that got an
 *   answer is not offline" RED;
 * - notify() not hiding the slot's last notice → "replaces its predecessor" RED.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Notice } from 'obsidian';
import { RefreshError } from '../auth/tokenManager';
import { HttpError, SyncFailure } from '../errors';
import { clockTime, explainFailure, failureMessage, NOTICE_MS, notify, notifyFailure } from '../notices';

const NoticeMock = Notice as unknown as jest.Mock;
/** A sync, while the automatic sync runs: it is tried again by itself. */
const retrying = { apiUrl: 'https://pensio.app', retries: true };
/** Something she pressed that nothing repeats. */
const once = { apiUrl: 'https://pensio.app', retries: false };

/** Every .ts file under src/, tests and mocks left out. */
function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name.startsWith('__') ? [] : sourceFiles(full);
        return entry.name.endsWith('.ts') ? [full] : [];
    });
}

describe('a notice', () => {
    beforeEach(() => NoticeMock.mockClear());

    it('says it comes from Pensio', () => {
        notify('Sync done. 3 synced, 409 unchanged.');
        expect(NoticeMock).toHaveBeenCalledWith('Pensio: Sync done. 3 synced, 409 unchanged.', NOTICE_MS.info);
    });

    it('is not prefixed twice', () => {
        notify('Pensio: daily analysis limit reached.');
        expect(NoticeMock.mock.calls[0][0]).toBe('Pensio: daily analysis limit reached.');
    });

    it('stays until dismissed when something failed', () => {
        notifyFailure('Sync', new HttpError('Bad gateway', 502), retrying);
        const [message, duration] = NoticeMock.mock.calls[0] as [string, number];
        expect(duration).toBe(0);
        expect(message).toMatch(/^Pensio: Sync failed\. /);
    });

    it('replaces its predecessor in the same slot instead of stacking under it', () => {
        notifyFailure('Sync', new HttpError('Rate limit exceeded', 429), retrying, 'connection');
        const first = NoticeMock.mock.results[0].value as { hide: jest.Mock };
        notifyFailure('The connection test', new HttpError('Rate limit exceeded', 429), once, 'connection');

        expect(first.hide).toHaveBeenCalled();
        expect(NoticeMock).toHaveBeenCalledTimes(2);
    });

    it('is made nowhere but src/notices.ts', () => {
        const root = path.join(__dirname, '..');
        const elsewhere = sourceFiles(root)
            .filter(file => path.basename(file) !== 'notices.ts')
            .filter(file => /new Notice\(/.test(fs.readFileSync(file, 'utf8')))
            .map(file => path.relative(root, file));
        expect(elsewhere).toEqual([]);
    });
});

describe('a failure, in plain words', () => {
    it('says a sync that lost the network could not reach Pensio, not the engine’s bookkeeping', () => {
        const offline = new Error('net::ERR_INTERNET_DISCONNECTED');
        const failure = new SyncFailure([`Bulk sync chunk: ${offline.message}`], offline);

        const message = failureMessage('Sync', failure, retrying);

        expect(message).toBe(
            'Sync failed. Couldn’t reach Pensio. Check your internet connection. The plugin tries again every 5 minutes.'
        );
        expect(message).not.toMatch(/Bulk sync chunk|error\(s\)|net::/);
    });

    it('names a self-hosted server, and points at the Server URL', () => {
        const explained = explainFailure(new Error('getaddrinfo ENOTFOUND journal.example.org'), {
            apiUrl: 'https://journal.example.org', retries: false,
        });
        expect(explained.kind).toBe('offline');
        expect(explained.reason).toBe('Couldn’t reach journal.example.org.');
        expect(explained.next).toBe('Check your internet connection and the Server URL under Advanced.');
    });

    it('says a stopped connection needs Connect to Pensio, and that nothing is lost', () => {
        for (const error of [new RefreshError('auth-invalid', 'expired'), new HttpError('Unauthorized', 401)]) {
            const explained = explainFailure(error, retrying);
            expect(explained.kind).toBe('expired');
            expect(explained.next).toContain('press Connect to Pensio');
            expect(explained.next).toContain('sync history are kept');
        }
    });

    it('says a server error lost nothing, and when it is tried again', () => {
        expect(explainFailure(new HttpError('Bad gateway', 502), retrying)).toEqual({
            kind: 'server',
            reason: 'Pensio’s server had a problem (error 502).',
            next: 'Nothing was lost. The plugin tries again every 5 minutes.',
        });
        expect(explainFailure(new HttpError('Bad gateway', 502), once).next)
            .toBe('Nothing was lost. Try again in a few minutes.');
    });

    it('promises a retry for a 429 only when there is one, and never blames the vault', () => {
        const limited = new HttpError('Rate limit exceeded. Please try again later.', 429);

        const pressed = explainFailure(limited, once);
        expect(pressed.kind).toBe('busy');
        expect(pressed.reason).toBe('Pensio is limiting requests for now.');
        expect(pressed.next).toBe('Nothing is lost. Try again later: this can last up to an hour.');
        expect(explainFailure(limited, retrying).next).toBe('Nothing is lost. The plugin tries again every 5 minutes.');

        for (const words of [pressed.reason, pressed.next]) expect(words).not.toMatch(/vault|every 5 minutes/);
    });

    it('names the limit and the time it ends, when the server says', () => {
        const now = Date.UTC(2026, 9, 20, 22, 0, 0);
        const account = new HttpError('Rate limit exceeded.', 429, { code: 'rate_limited', scope: 'account', retryAfter: 600 });
        const explained = explainFailure(account, { ...once, now: () => now });

        expect(explained.reason).toBe(
            'Your Pensio account has made more requests this hour than Pensio allows, counting every device and app you connected.'
        );
        expect(explained.next).toBe(`Nothing is lost. Try again after ${clockTime(now + 600_000)}.`);
        expect(explained.retryAt).toBe(now + 600_000);

        const network = new HttpError('Rate limit exceeded.', 429, { scope: 'network' });
        expect(explainFailure(network, once).reason).toBe('There have been too many connection attempts from your network this hour.');
    });

    it('a refresh that got an answer is not offline', () => {
        expect(explainFailure(new RefreshError('transient', 'x', 429), once).kind).toBe('busy');
        expect(explainFailure(new RefreshError('transient', 'x', 503), once).kind).toBe('server');
        expect(explainFailure(new RefreshError('transient', 'x', 400), once)).toMatchObject({
            kind: 'refused', reason: 'Pensio didn’t accept this vault’s sign-in renewal (error 400).',
        });
        // No answer at all: that is offline.
        expect(explainFailure(new RefreshError('transient', 'x'), once).kind).toBe('offline');
    });

    it('quotes a refused request, with the caller’s next step', () => {
        const explained = explainFailure(new HttpError('invalid or expired code', 400), {
            ...once, whenRefused: 'Get a new one from Connect Obsidian.',
        });
        expect(explained).toEqual({
            kind: 'refused',
            reason: 'Invalid or expired code.',
            next: 'Get a new one from Connect Obsidian.',
        });
    });

    it('keeps its own advice when the caller’s is about something else', () => {
        // A setup code typed while offline is not a spent code.
        const explained = explainFailure(new Error('net::ERR_INTERNET_DISCONNECTED'), {
            ...once, whenRefused: 'Get a new one from Connect Obsidian.',
        });
        expect(explained.next).not.toContain('Connect Obsidian');
    });

    it('counts the notes that could not sync when no request failed', () => {
        const failure = new SyncFailure(['Journal/a.md: File too large (2.40MB)', 'Journal/b.md: File too large (1.10MB)']);
        expect(explainFailure(failure, retrying)).toEqual({
            kind: 'notes',
            reason: '2 notes couldn’t sync. Journal/a.md: File too large (2.40MB).',
            next: 'Everything else synced.',
        });
    });

    it('says something useful about an error it does not know, on a phone too', () => {
        const explained = explainFailure(new Error('weird'), retrying);
        expect(explained.reason).toBe('Weird.');
        // A phone has no developer console (review F37).
        expect(explained.next).toContain('bug icon');
        expect(explained.next).not.toContain('console');
        expect(explainFailure('not even an error', retrying).reason).toBe('Something went wrong.');
    });
});
