/**
 * Every notice is Pensio's, a failure stays, and it says what went wrong.
 *
 * ⛔ The bug (reported 2026-10-20): a failed sync showed "Sync failed: Sync
 * completed with 1 error(s): Bulk sync chunk: …" for Obsidian's default few
 * seconds. Nothing said it came from Pensio, so it could have been any plugin;
 * it was gone before it could be read; and its words were the sync engine's
 * bookkeeping, so even read in time it said neither what was wrong nor what to
 * do about it.
 *
 * Sabotage-checked (2026-10-20), each alone then restored:
 * - notify() without the "Pensio: " prefix → "says it comes from Pensio" RED;
 * - NOTICE_MS.failure set to 6000 → "stays until dismissed" RED;
 * - a `new Notice(` added to connectionSection.ts → "is made nowhere else" RED;
 * - explainFailure ignoring SyncFailure.underlying → the bulk-sync test RED.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Notice } from 'obsidian';
import { RefreshError } from '../auth/tokenManager';
import { HttpError, SyncFailure } from '../errors';
import { explainFailure, failureMessage, NOTICE_MS, notify, notifyFailure } from '../notices';

const NoticeMock = Notice as unknown as jest.Mock;
const pensio = { apiUrl: 'https://pensio.app', autoSync: true };

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
        notifyFailure('Sync', new HttpError('Bad gateway', 502), pensio);
        const [message, duration] = NoticeMock.mock.calls[0] as [string, number];
        expect(duration).toBe(0);
        expect(message).toMatch(/^Pensio: Sync failed\. /);
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

        const message = failureMessage('Sync', failure, pensio);

        expect(message).toBe(
            'Sync failed. Couldn’t reach Pensio. Check your internet connection. The plugin tries again every 5 minutes.'
        );
        expect(message).not.toMatch(/Bulk sync chunk|error\(s\)|net::/);
    });

    it('names a self-hosted server, and points at the Server URL', () => {
        const explained = explainFailure(new Error('getaddrinfo ENOTFOUND journal.example.org'), {
            apiUrl: 'https://journal.example.org', autoSync: false,
        });
        expect(explained.kind).toBe('offline');
        expect(explained.reason).toBe('Couldn’t reach journal.example.org.');
        expect(explained.next).toBe('Check your internet connection and the Server URL under Advanced.');
    });

    it('says a stopped connection needs Connect to Pensio, and that nothing is lost', () => {
        for (const error of [new RefreshError('auth-invalid', 'expired'), new HttpError('Unauthorized', 401)]) {
            const explained = explainFailure(error, pensio);
            expect(explained.kind).toBe('expired');
            expect(explained.next).toContain('press Connect to Pensio');
            expect(explained.next).toContain('sync history are kept');
        }
    });

    it('says a server error lost nothing, and when it is tried again', () => {
        expect(explainFailure(new HttpError('Bad gateway', 502), pensio)).toEqual({
            kind: 'server',
            reason: 'Pensio’s server had a problem (error 502).',
            next: 'Nothing was lost. The plugin tries again every 5 minutes.',
        });
        expect(explainFailure(new HttpError('Bad gateway', 502), { ...pensio, autoSync: false }).next)
            .toBe('Nothing was lost. Try again in a few minutes.');
    });

    it('says too many requests is temporary', () => {
        const explained = explainFailure(new HttpError('Throttled', 429), pensio);
        expect(explained.kind).toBe('busy');
        expect(explained.next).toBe('The plugin tries again every 5 minutes.');
    });

    it('quotes a refused request, with the caller’s next step', () => {
        const explained = explainFailure(new HttpError('invalid or expired code', 400), {
            ...pensio, whenRefused: 'Get a new one from Connect Obsidian.',
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
            ...pensio, whenRefused: 'Get a new one from Connect Obsidian.',
        });
        expect(explained.next).not.toContain('Connect Obsidian');
    });

    it('counts the notes that could not sync when no request failed', () => {
        const failure = new SyncFailure(['Journal/a.md: File too large (2.40MB)', 'Journal/b.md: File too large (1.10MB)']);
        expect(explainFailure(failure, pensio)).toEqual({
            kind: 'notes',
            reason: '2 notes couldn’t sync. Journal/a.md: File too large (2.40MB).',
            next: 'Everything else synced.',
        });
    });

    it('says something useful about an error it does not know', () => {
        const explained = explainFailure(new Error('weird'), pensio);
        expect(explained.reason).toBe('Weird.');
        expect(explained.next).toContain('Debug mode');
        expect(explainFailure('not even an error', pensio).reason).toBe('Something went wrong.');
    });
});
