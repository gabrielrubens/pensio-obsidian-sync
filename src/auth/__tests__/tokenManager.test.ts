/**
 * TokenManager tests — the auth lifecycle rules from the 2026-07 token-death
 * audit:
 *
 * - refresh is lazy (no background timer)
 * - tokens are NEVER wiped on refresh failure; transient errors retry with
 *   backoff, server-confirmed dead sessions flip the persistent
 *   authInvalidated state
 * - 400s carrying reauth_required / token_not_valid markers count as
 *   auth-invalid; anything else is transient
 * - getAccessToken never returns a stale token after a failed refresh
 */

import { requestUrl } from 'obsidian';
import { RefreshError, TokenData, TokenManager } from '../tokenManager';

const mockRequestUrl = requestUrl as jest.Mock;

/** A structurally valid JWT whose exp claim is `expiresInMs` from now. */
function makeJwt(expiresInMs: number): string {
    const payload = Buffer.from(
        JSON.stringify({ exp: Math.floor((Date.now() + expiresInMs) / 1000) })
    ).toString('base64url');
    return `header.${payload}.signature`;
}

const FRESH_ACCESS = () => makeJwt(30 * 60 * 1000);   // 30 min out
const EXPIRING_ACCESS = () => makeJwt(60 * 1000);      // inside the 2-min buffer
const REFRESH_TOKEN = 'refresh-token-value';

function refreshSuccess(withNewRefresh = false) {
    return {
        status: 200,
        json: {
            access: FRESH_ACCESS(),
            ...(withNewRefresh ? { refresh: 'rotated-refresh-token' } : {}),
        },
    };
}

async function expectRefreshError(
    promise: Promise<unknown>,
    reason: 'auth-invalid' | 'transient'
): Promise<RefreshError> {
    let caught: unknown = null;
    try {
        await promise;
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(RefreshError);
    expect((caught as RefreshError).reason).toBe(reason);
    return caught as RefreshError;
}

describe('TokenManager', () => {
    let manager: TokenManager;
    let persisted: Array<TokenData | null>;
    let authInvalidations: number;

    beforeEach(async () => {
        mockRequestUrl.mockReset();
        persisted = [];
        authInvalidations = 0;
        // Zero retry delays keep the backoff paths fast in tests.
        manager = new TokenManager('https://pensio.app', 'obsidian-test-device', [0, 0]);
        manager.setOnTokensChanged(async (tokens) => {
            persisted.push(tokens);
        });
        manager.setOnAuthInvalidated(() => {
            authInvalidations++;
        });
    });

    describe('getAccessToken', () => {
        it('returns the current token without any refresh when far from expiry', async () => {
            const access = FRESH_ACCESS();
            await manager.initialize(access, REFRESH_TOKEN);

            expect(await manager.getAccessToken()).toBe(access);
            expect(mockRequestUrl).not.toHaveBeenCalled();
        });

        it('refreshes lazily inside the expiry buffer and persists the result', async () => {
            await manager.initialize(EXPIRING_ACCESS(), REFRESH_TOKEN);
            mockRequestUrl.mockResolvedValueOnce(refreshSuccess());

            const token = await manager.getAccessToken();

            expect(mockRequestUrl).toHaveBeenCalledTimes(1);
            const call = mockRequestUrl.mock.calls[0][0];
            expect(call.url).toBe('https://pensio.app/api/v1/auth/refresh/');
            expect(JSON.parse(call.body)).toEqual({
                refresh: REFRESH_TOKEN,
                device_id: 'obsidian-test-device',
            });
            expect(persisted).toHaveLength(1);
            expect(persisted[0]?.accessToken).toBe(token);
        });

        it('throws (never returns a stale token) when the refresh fails', async () => {
            await manager.initialize(EXPIRING_ACCESS(), REFRESH_TOKEN);
            mockRequestUrl.mockResolvedValue({ status: 503, json: {} });

            await expectRefreshError(manager.getAccessToken(), 'transient');
        });

        it('throws auth-invalid immediately once the session is dead', async () => {
            await manager.initialize(EXPIRING_ACCESS(), REFRESH_TOKEN);
            mockRequestUrl.mockResolvedValue({ status: 401, json: {} });
            await expectRefreshError(manager.refreshToken(), 'auth-invalid');
            mockRequestUrl.mockClear();

            await expectRefreshError(manager.getAccessToken(), 'auth-invalid');
            expect(mockRequestUrl).not.toHaveBeenCalled();
        });
    });

    describe('sliding reissue', () => {
        it('keeps the current refresh token when the server does not send a new one', async () => {
            await manager.initialize(EXPIRING_ACCESS(), REFRESH_TOKEN);
            mockRequestUrl.mockResolvedValueOnce(refreshSuccess(false));

            const tokens = await manager.refreshToken();

            expect(tokens.refreshToken).toBe(REFRESH_TOKEN);
        });

        it('adopts and persists a reissued refresh token', async () => {
            await manager.initialize(EXPIRING_ACCESS(), REFRESH_TOKEN);
            mockRequestUrl.mockResolvedValueOnce(refreshSuccess(true));

            const tokens = await manager.refreshToken();

            expect(tokens.refreshToken).toBe('rotated-refresh-token');
            expect(persisted[0]?.refreshToken).toBe('rotated-refresh-token');
        });
    });

    describe('auth-invalid classification', () => {
        it.each([
            ['401', { status: 401, json: {} }],
            ['400 + reauth_required code', {
                status: 400,
                json: { error: { code: 'reauth_required', message: 'Re-pair.' } },
            }],
            ['400 + bare token_not_valid code', {
                status: 400,
                json: { code: 'token_not_valid', detail: 'Token is invalid' },
            }],
            ['400 + blacklisted wording', {
                status: 400,
                json: { refresh: ['Token is blacklisted'] },
            }],
        ])('%s marks the session dead without wiping tokens', async (_label, response) => {
            await manager.initialize(EXPIRING_ACCESS(), REFRESH_TOKEN);
            mockRequestUrl.mockResolvedValue(response);

            await expectRefreshError(manager.refreshToken(), 'auth-invalid');

            expect(manager.isAuthInvalidated()).toBe(true);
            expect(authInvalidations).toBe(1);
            // The no-wipe rule: tokens stay for diagnostics/re-pair; the
            // persistence callback must never receive null here.
            expect(manager.hasTokens()).toBe(true);
            expect(persisted).not.toContain(null);
        });

        it('treats an unrelated 400 as transient, not auth-invalid', async () => {
            await manager.initialize(EXPIRING_ACCESS(), REFRESH_TOKEN);
            mockRequestUrl.mockResolvedValue({
                status: 400,
                json: { error: { code: 'validation_error', message: 'device_id required' } },
            });

            await expectRefreshError(manager.refreshToken(), 'transient');

            expect(manager.isAuthInvalidated()).toBe(false);
            expect(authInvalidations).toBe(0);
            expect(manager.hasTokens()).toBe(true);
        });

        it('fires onAuthInvalidated only once', async () => {
            await manager.initialize(EXPIRING_ACCESS(), REFRESH_TOKEN);
            mockRequestUrl.mockResolvedValue({ status: 401, json: {} });

            await expectRefreshError(manager.refreshToken(), 'auth-invalid');
            await expectRefreshError(manager.refreshToken(), 'auth-invalid');

            expect(authInvalidations).toBe(1);
        });
    });

    describe('transient failures and retry', () => {
        it('retries network errors with backoff and eventually succeeds', async () => {
            await manager.initialize(EXPIRING_ACCESS(), REFRESH_TOKEN);
            mockRequestUrl
                .mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'))
                .mockResolvedValueOnce(refreshSuccess());

            const tokens = await manager.refreshToken();

            expect(tokens.accessToken).toBeTruthy();
            expect(mockRequestUrl).toHaveBeenCalledTimes(2);
        });

        it('retries 5xx responses (deploy window) and eventually succeeds', async () => {
            await manager.initialize(EXPIRING_ACCESS(), REFRESH_TOKEN);
            mockRequestUrl
                .mockResolvedValueOnce({ status: 502, json: {} })
                .mockResolvedValueOnce(refreshSuccess());

            await manager.refreshToken();

            expect(mockRequestUrl).toHaveBeenCalledTimes(2);
        });

        it('gives up after all attempts with a transient error, keeping tokens', async () => {
            await manager.initialize(EXPIRING_ACCESS(), REFRESH_TOKEN);
            mockRequestUrl.mockRejectedValue(new Error('offline'));

            await expectRefreshError(manager.refreshToken(), 'transient');

            expect(mockRequestUrl).toHaveBeenCalledTimes(3); // 1 + 2 retries
            expect(manager.isAuthInvalidated()).toBe(false);
            expect(manager.hasTokens()).toBe(true);
            expect(persisted).toHaveLength(0);
        });

        it('allows a later refresh to succeed after a transient failure', async () => {
            await manager.initialize(EXPIRING_ACCESS(), REFRESH_TOKEN);
            mockRequestUrl.mockRejectedValue(new Error('offline'));
            await expectRefreshError(manager.refreshToken(), 'transient');

            mockRequestUrl.mockReset();
            mockRequestUrl.mockResolvedValueOnce(refreshSuccess());

            const tokens = await manager.refreshToken();
            expect(tokens.accessToken).toBeTruthy();
        });
    });

    describe('concurrency', () => {
        it('deduplicates concurrent refresh calls into one request', async () => {
            await manager.initialize(EXPIRING_ACCESS(), REFRESH_TOKEN);
            mockRequestUrl.mockResolvedValue(refreshSuccess());

            const [a, b] = await Promise.all([
                manager.refreshToken(),
                manager.refreshToken(),
            ]);

            expect(mockRequestUrl).toHaveBeenCalledTimes(1);
            expect(a.accessToken).toBe(b.accessToken);
        });
    });

    describe('handleUnauthorized', () => {
        it('returns fresh tokens after a successful refresh', async () => {
            await manager.initialize(FRESH_ACCESS(), REFRESH_TOKEN);
            mockRequestUrl.mockResolvedValueOnce(refreshSuccess());

            const tokens = await manager.handleUnauthorized();

            expect(tokens?.accessToken).toBeTruthy();
        });

        it('returns null on failure without wiping tokens', async () => {
            await manager.initialize(FRESH_ACCESS(), REFRESH_TOKEN);
            mockRequestUrl.mockResolvedValue({ status: 503, json: {} });

            const tokens = await manager.handleUnauthorized();

            expect(tokens).toBeNull();
            expect(manager.hasTokens()).toBe(true);
            expect(persisted).not.toContain(null);
        });

        it('returns null immediately when the session is already dead', async () => {
            await manager.initialize(FRESH_ACCESS(), REFRESH_TOKEN);
            mockRequestUrl.mockResolvedValue({ status: 401, json: {} });
            await expectRefreshError(manager.refreshToken(), 'auth-invalid');
            mockRequestUrl.mockClear();

            expect(await manager.handleUnauthorized()).toBeNull();
            expect(mockRequestUrl).not.toHaveBeenCalled();
        });
    });

    describe('explicit logout and re-pair', () => {
        it('clearTokens wipes tokens and notifies persistence with null', async () => {
            await manager.initialize(FRESH_ACCESS(), REFRESH_TOKEN);

            await manager.clearTokens();

            expect(manager.hasTokens()).toBe(false);
            expect(persisted).toEqual([null]);
        });

        it('initialize resets a dead session (re-pair path)', async () => {
            await manager.initialize(EXPIRING_ACCESS(), REFRESH_TOKEN);
            mockRequestUrl.mockResolvedValue({ status: 401, json: {} });
            await expectRefreshError(manager.refreshToken(), 'auth-invalid');
            expect(manager.isAuthInvalidated()).toBe(true);

            await manager.initialize(FRESH_ACCESS(), 'new-refresh-token');

            expect(manager.isAuthInvalidated()).toBe(false);
            expect(await manager.getAccessToken()).toBeTruthy();
        });
    });
});
