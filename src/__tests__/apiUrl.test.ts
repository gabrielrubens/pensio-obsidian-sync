/**
 * One Server URL, however it was typed.
 *
 * ⛔ Until 0.7.2 'https://pensio.app/' (a trailing slash) opened the right
 * approval page, then posted the approval to '//api/v1/auth/connect/', a 404,
 * and every request and refresh failed the same way with nothing naming the
 * URL (review CRIT-3). Each call site cleaned the setting its own way.
 *
 * Sabotage-checked (2026-10-21), each alone then restored:
 * - serverUrl keeping a trailing slash → "trailing slash" RED and "one slash
 *   before /api" RED;
 * - serverUrl keeping a pasted /api/v1 → "pasted /api" RED;
 * - serverUrl adding no scheme → "without a scheme" RED (2026-10-21, the 0.7.2
 *   review: 'pensio.app' made every request an invalid URL);
 * - the client building its own base again → "one slash before /api" RED;
 * - the token manager building its own base again → "a refresh" RED.
 */
import { requestUrl } from 'obsidian';
import { ApiClient } from '../api/client';
import { serverUrl } from '../apiUrl';
import { OneClickConnect } from '../auth/oneClick';
import { DEFAULT_SETTINGS } from '../types';

const mocked = requestUrl as jest.Mock;

function token(expiresIn: number): string {
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresIn, user_id: 'u' })).toString('base64url');
    return `h.${payload}.s`;
}

const urls = (): string[] => mocked.mock.calls.map(([options]: [{ url: string }]) => options.url);

describe('the Server URL', () => {
    it('loses a trailing slash, a www. and surrounding spaces, and empty is Pensio', () => {
        expect(serverUrl('https://pensio.app/')).toBe('https://pensio.app');
        expect(serverUrl(' https://www.pensio.app// ')).toBe('https://pensio.app');
        expect(serverUrl('')).toBe('https://pensio.app');
        expect(serverUrl(undefined)).toBe('https://pensio.app');
        expect(serverUrl('https://journal.example.org')).toBe('https://journal.example.org');
    });

    it('gets https when it was typed without a scheme', () => {
        expect(serverUrl('pensio.app')).toBe('https://pensio.app');
        expect(serverUrl('journal.example.org/')).toBe('https://journal.example.org');
        expect(serverUrl('localhost:8000')).toBe('https://localhost:8000');
        expect(serverUrl('http://localhost:8000/')).toBe('http://localhost:8000');
    });

    it('loses a pasted /api or /api/v1', () => {
        expect(serverUrl('https://journal.example.org/api/v1/')).toBe('https://journal.example.org');
        expect(serverUrl('https://journal.example.org/api')).toBe('https://journal.example.org');
    });

    describe('typed with a trailing slash', () => {
        const settings = { ...DEFAULT_SETTINGS, apiUrl: 'https://pensio.app/', deviceId: 'vault-1' };
        beforeEach(() => mocked.mockReset());

        it('every request has one slash before /api', async () => {
            mocked.mockResolvedValue({ status: 200, text: '{}', json: { id: 'u', email: 'e', username: 'u', access: token(3600), refresh: 'r' } });
            const client = new ApiClient(settings);
            await client.initializeTokens(token(3600), 'refresh');

            await client.fetchCurrentUser();
            await client.bulkSync([], []);
            await client.connectWithCode('code', 'verifier', 'vault-1').catch(() => undefined);

            expect(urls().length).toBeGreaterThanOrEqual(3);
            for (const url of urls()) expect(url).toMatch(/^https:\/\/pensio\.app\/api\/v1\//);
        });

        it('a refresh has one slash before /api too', async () => {
            mocked.mockResolvedValue({ status: 200, text: '{}', json: { id: 'u', email: 'e', username: 'u', access: token(3600) } });
            const client = new ApiClient(settings);
            await client.initializeTokens(token(-60), 'refresh');   // expired: refreshed first

            await client.fetchCurrentUser();

            expect(urls()[0]).toBe('https://pensio.app/api/v1/auth/refresh/');
        });

        it('the approval page opens on the same server', async () => {
            const connect = new OneClickConnect(async () => { throw new Error('unused'); });
            const url = await connect.start('https://pensio.app/', 'vault-1', 'Mac');
            expect(url.startsWith('https://pensio.app/connect/obsidian/?')).toBe(true);
        });
    });
});
