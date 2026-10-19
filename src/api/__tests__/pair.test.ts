/**
 * Pairing again names the connection it replaces.
 *
 * The plugin sends the refresh token this vault already holds as
 * `previous_refresh`, so the server ends exactly that family. A second machine
 * on a synced vault shares the device id but keeps its own tokens, so it is
 * never the one ended (api/tokens.py::end_the_family_it_replaces).
 *
 * Sabotage-checked (2026-10-18): dropping `previous_refresh` from the body
 * turns the first test red; sending it when empty turns the second red.
 */
import { requestUrl } from 'obsidian';
import { ApiClient } from '../client';
import { DEFAULT_SETTINGS } from '../../types';

const mocked = requestUrl as jest.Mock;

function lastBody(): Record<string, unknown> {
    const call = mocked.mock.calls[mocked.mock.calls.length - 1][0];
    return JSON.parse(call.body);
}

describe('ApiClient.pair', () => {
    beforeEach(() => {
        mocked.mockReset();
        mocked.mockResolvedValue({
            status: 200,
            json: { access: 'a', refresh: 'r', device_id: 'd', device_name: 'n' },
        });
    });

    it('sends the refresh token it holds, so the replaced connection ends', async () => {
        const client = new ApiClient({ ...DEFAULT_SETTINGS, apiUrl: 'https://pensio.app' });
        await client.pair('ABCD-EFGH', 'vault-1', 'Obsidian — Journal', 'old-refresh');

        expect(lastBody()).toEqual({
            code: 'ABCD-EFGH',
            device_id: 'vault-1',
            device_name: 'Obsidian — Journal',
            previous_refresh: 'old-refresh',
        });
    });

    it('sends nothing extra on a first pairing', async () => {
        const client = new ApiClient({ ...DEFAULT_SETTINGS, apiUrl: 'https://pensio.app' });
        await client.pair('ABCD-EFGH', 'vault-1', 'Obsidian — Journal', '');

        expect(lastBody()).not.toHaveProperty('previous_refresh');
    });
});

describe('ApiClient.connectWithCode', () => {
    beforeEach(() => {
        mocked.mockReset();
        mocked.mockResolvedValue({
            status: 200,
            json: { access: 'a', refresh: 'r', device_id: 'd', device_name: 'n' },
        });
    });

    it('posts the code and the verifier, and the token it replaces', async () => {
        const client = new ApiClient({ ...DEFAULT_SETTINGS, apiUrl: 'https://pensio.app' });
        await client.connectWithCode('the-code', 'the-verifier', 'vault-1', 'old-refresh');

        const call = mocked.mock.calls[mocked.mock.calls.length - 1][0];
        expect(call.url).toBe('https://pensio.app/api/v1/auth/connect/');
        expect(call.headers).not.toHaveProperty('Authorization');
        expect(lastBody()).toEqual({
            code: 'the-code',
            verifier: 'the-verifier',
            device_id: 'vault-1',
            previous_refresh: 'old-refresh',
        });
    });

    it('says what the server said when it refuses', async () => {
        mocked.mockResolvedValue({
            status: 400,
            json: { error: { fields: { code: ['This connection request has expired.'] } } },
        });
        const client = new ApiClient({ ...DEFAULT_SETTINGS, apiUrl: 'https://pensio.app' });

        await expect(client.connectWithCode('c', 'v', 'vault-1')).rejects.toThrow(
            'This connection request has expired.'
        );
    });
});
