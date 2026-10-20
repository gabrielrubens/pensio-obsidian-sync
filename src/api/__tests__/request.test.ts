/**
 * A refused request says what the server said.
 *
 * ⛔ Until 0.7.1 an ordinary request let Obsidian's requestUrl throw on a 4xx
 * or 5xx, and that rejection carries the status and the headers but never the
 * body. So every refusal read "Request failed, status 429": the server's own
 * message, its error code, which limit refused it and its Retry-After were all
 * out of reach, and the notice could only guess (review F21). Now the client
 * asks for the response (throw: false) and reads it.
 *
 * Sabotage-checked (2026-10-20), each alone then restored:
 * - request() back on requestUrl's default throw → "carries the server's
 *   message" RED;
 * - refusal() ignoring the Retry-After header → "carries the server's message"
 *   RED;
 * - the 401 refresh-and-retry removed → "a 401 is refreshed" RED.
 */
import { requestUrl } from 'obsidian';
import { HttpError } from '../../errors';
import { DEFAULT_SETTINGS } from '../../types';
import { ApiClient } from '../client';

const mocked = requestUrl as jest.Mock;

/** A token whose exp is far away, so no refresh happens before the request. */
function freshToken(): string {
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, user_id: 'u' })).toString('base64url');
    return `h.${payload}.s`;
}

async function client(): Promise<ApiClient> {
    const c = new ApiClient({ ...DEFAULT_SETTINGS, apiUrl: 'https://pensio.app', deviceId: 'vault-1' });
    await c.initializeTokens(freshToken(), 'refresh');
    return c;
}

describe('a request', () => {
    beforeEach(() => mocked.mockReset());

    it('carries the server’s message, code, scope and Retry-After when it is refused', async () => {
        mocked.mockResolvedValue({
            status: 429,
            headers: { 'retry-after': '1800' },
            text: '{}',
            json: { error: { code: 'rate_limited', message: 'Rate limit exceeded. Please try again later.', scope: 'account' } },
        });

        const error = await (await client()).fetchCurrentUser().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(HttpError);
        expect((error as HttpError).status).toBe(429);
        expect((error as HttpError).message).toBe('Rate limit exceeded. Please try again later.');
        expect((error as HttpError).details).toEqual({ code: 'rate_limited', scope: 'account', retryAfter: 1800 });
        expect(mocked.mock.calls[0][0]).toMatchObject({ throw: false });
    });

    it('rejects with the network’s own error when nothing answered', async () => {
        mocked.mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'));

        await expect((await client()).fetchCurrentUser()).rejects.toThrow('net::ERR_INTERNET_DISCONNECTED');
    });

    it('a 401 is refreshed once and the request retried', async () => {
        mocked
            .mockResolvedValueOnce({ status: 401, text: '{}', json: {} })
            .mockResolvedValueOnce({ status: 200, json: { access: freshToken() } })
            .mockResolvedValueOnce({ status: 200, text: '{"id":"u"}', json: { id: 'u', email: 'her@example.com', username: 'her' } });

        const me = await (await client()).fetchCurrentUser();

        expect(me.email).toBe('her@example.com');
        expect(mocked.mock.calls[1][0].url).toContain('/api/v1/auth/refresh/');
    });
});
