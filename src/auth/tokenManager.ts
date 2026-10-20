import { requestUrl } from 'obsidian';
import { refusal, RefusalDetails } from '../errors';
import { debugLog } from '../logger';

export interface TokenData {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

/**
 * Why a refresh attempt failed.
 * - 'auth-invalid': the server confirmed the refresh token is dead (expired,
 *   revoked, wrong type, account gone). Re-pairing is required.
 * - 'transient': network problem, server error, or rate limit. The tokens are
 *   fine — the next sync retries.
 */
export type RefreshFailureReason = 'auth-invalid' | 'transient';

export class RefreshError extends Error {
    /**
     * @param status the last HTTP status the refresh got, undefined when no
     *   response came back at all (offline). A 429 or a 5xx is not "offline",
     *   and the notice must not say so.
     */
    constructor(
        readonly reason: RefreshFailureReason,
        message: string,
        readonly status?: number,
        readonly details: RefusalDetails = {},
    ) {
        super(message);
        this.name = 'RefreshError';
    }
}

/**
 * Extract expiration timestamp from a JWT access token.
 * Returns milliseconds since epoch, or null if parsing fails.
 */
function parseJwtExpiry(token: string): number | null {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        // Base64url decode the payload
        const payload = JSON.parse(
            atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
        ) as { exp?: unknown };
        if (typeof payload.exp === 'number') {
            return payload.exp * 1000; // Convert seconds to milliseconds
        }
        return null;
    } catch {
        return null;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Callback invoked whenever tokens change (refresh, login, logout).
 * Implementor persists the new tokens to SecretStorage.
 */
export type OnTokensChanged = (tokens: TokenData | null) => Promise<void>;

/**
 * Callback invoked once when the server confirms the session is dead and
 * re-pairing is required. UX (notice, status bar) is the caller's job.
 */
export type OnAuthInvalidated = () => void;

/**
 * Manages the JWT token lifecycle: lazy refresh, 401 handling, expiry tracking.
 *
 * Design rules (see the 2026-07 token-death audit):
 * - Refresh is LAZY only — in getAccessToken() near expiry and on 401. There
 *   is deliberately no background timer: every refresh is a persist event and
 *   idle churn multiplied the chances of a lost write.
 * - Tokens are NEVER wiped on failure. Transient errors retry with backoff;
 *   a server-confirmed dead session flips authInvalidated and keeps the
 *   tokens in place. Wiping is for explicit logout only.
 * - getAccessToken() never hands back a stale token after a failed refresh —
 *   it throws a typed RefreshError instead.
 *
 * Tokens are held in memory only. Persistence is handled by the caller via
 * the onTokensChanged callback.
 */
export class TokenManager {
    private apiUrl: string;
    private deviceId: string;
    private accessToken: string | null = null;
    private refreshTokenValue: string | null = null;
    private expiresAt: number = 0;
    private refreshPromise: Promise<TokenData> | null = null;
    private authInvalidated = false;
    /**
     * Bumped whenever the tokens are replaced (initialize, clearTokens). A
     * refresh that started under an older generation is discarded when it
     * lands: before 0.7.1 a refresh still in flight when a new connection was
     * adopted wrote the old family's tokens over the new ones.
     */
    private generation = 0;
    private onTokensChanged: OnTokensChanged | null = null;
    private onAuthInvalidated: OnAuthInvalidated | null = null;
    /** Waits before retry 2..n of a failed refresh. Injectable for tests. */
    private readonly retryDelaysMs: number[];

    constructor(apiUrl: string, deviceId: string = '', retryDelaysMs: number[] = [1000, 3000]) {
        this.apiUrl = apiUrl;
        this.deviceId = deviceId;
        this.retryDelaysMs = retryDelaysMs;
    }

    /**
     * Set callback for token persistence. Must be called before initialize().
     */
    setOnTokensChanged(callback: OnTokensChanged): void {
        this.onTokensChanged = callback;
    }

    setOnAuthInvalidated(callback: OnAuthInvalidated): void {
        this.onAuthInvalidated = callback;
    }

    async initialize(accessToken: string, refreshToken: string): Promise<void> {
        this.generation++;
        this.refreshPromise = null;
        this.accessToken = accessToken;
        this.refreshTokenValue = refreshToken;
        this.expiresAt = parseJwtExpiry(accessToken) ?? Date.now() + (30 * 60 * 1000);
        this.authInvalidated = false;
    }

    /**
     * The access token to use for the next request, refreshing lazily when it
     * is within the expiry buffer. Throws RefreshError when a needed refresh
     * fails — never returns a token known to be stale.
     */
    async getAccessToken(): Promise<string | null> {
        if (this.authInvalidated) {
            throw new RefreshError(
                'auth-invalid',
                'Pensio session expired — reconnect in the plugin settings'
            );
        }
        if (!this.accessToken) return null;

        // Refresh if less than 2 minutes remaining
        const buffer = 2 * 60 * 1000;
        if (this.expiresAt - Date.now() < buffer) {
            debugLog('Token expiring soon, refreshing...');
            const newTokens = await this.refreshToken();
            return newTokens.accessToken;
        }

        return this.accessToken;
    }

    async refreshToken(): Promise<TokenData> {
        if (this.refreshPromise) return this.refreshPromise;

        this.refreshPromise = this._performRefresh();
        try {
            return await this.refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
    }

    private async _performRefresh(): Promise<TokenData> {
        if (this.authInvalidated) {
            throw new RefreshError(
                'auth-invalid',
                'Pensio session expired — reconnect in the plugin settings'
            );
        }
        if (!this.refreshTokenValue) {
            throw new RefreshError('auth-invalid', 'No refresh token available');
        }

        // Normalize: fallback to default if empty, strip www. to avoid Cloudflare 301 redirect
        const baseUrl = (this.apiUrl || 'https://pensio.app').replace('://www.', '://');
        const generation = this.generation;
        /** What the server last said, so a failed refresh can say why. */
        let last: { status?: number; details: RefusalDetails } = { details: {} };

        for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
            if (attempt > 0) {
                await sleep(this.retryDelaysMs[attempt - 1]);
            }

            let response;
            try {
                response = await requestUrl({
                    url: `${baseUrl}/api/v1/auth/refresh/`,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        refresh: this.refreshTokenValue,
                        device_id: this.deviceId,
                    }),
                    // Get the response object for 4xx/5xx too — the status and
                    // body drive the auth-invalid vs transient classification.
                    throw: false,
                });
            } catch (error) {
                // No HTTP response at all (offline, DNS, TLS) — retryable.
                debugLog(`Token refresh network error (attempt ${attempt + 1}):`, error);
                last = { details: {} };
                continue;
            }

            if (generation !== this.generation) {
                // New tokens arrived while this one was in flight: its answer
                // belongs to the connection they replaced.
                debugLog('Token refresh superseded by new tokens; discarding its result');
                return this.currentTokens();
            }

            if (response.status >= 200 && response.status < 300) {
                const data = response.json as { access: string; refresh?: string };

                const expiresAt = parseJwtExpiry(data.access) ?? Date.now() + (30 * 60 * 1000);
                const newTokens: TokenData = {
                    accessToken: data.access,
                    // Sliding reissue: the server returns a new refresh token
                    // only past ~half of the current one's life — keep ours
                    // otherwise.
                    refreshToken: data.refresh || this.refreshTokenValue,
                    expiresAt
                };

                this.accessToken = newTokens.accessToken;
                this.refreshTokenValue = newTokens.refreshToken;
                this.expiresAt = expiresAt;

                // Notify caller to persist new tokens
                if (this.onTokensChanged) {
                    await this.onTokensChanged(newTokens);
                }

                debugLog('Token refreshed successfully');
                return newTokens;
            }

            if (this.isAuthInvalidResponse(response)) {
                this.markAuthInvalid();
                throw new RefreshError(
                    'auth-invalid',
                    'Pensio session expired — reconnect in the plugin settings'
                );
            }

            // Everything else (5xx during a deploy, an unrecognized 4xx) is
            // transient and retried. A 429 is not retried here: the limit
            // lasts minutes, not the seconds between these attempts.
            debugLog(`Token refresh got HTTP ${response.status} (attempt ${attempt + 1})`);
            last = { status: response.status, details: refusal(response, '').details };
            if (response.status === 429) break;
        }

        throw new RefreshError(
            'transient',
            'Could not refresh Pensio authentication — will retry on the next sync',
            last.status,
            last.details,
        );
    }

    /** The tokens held now, for a refresh whose answer arrived too late. */
    private currentTokens(): TokenData {
        if (this.accessToken && this.refreshTokenValue) {
            return { accessToken: this.accessToken, refreshToken: this.refreshTokenValue, expiresAt: this.expiresAt };
        }
        throw new RefreshError('auth-invalid', 'No refresh token available');
    }

    /**
     * Only a response the server meant as "this token is dead" counts:
     * 401, or a 400 carrying the stable reauth_required code (api/errors.py)
     * or SimpleJWT's token_not_valid/blacklist markers (older self-hosted
     * servers without the error envelope).
     */
    private isAuthInvalidResponse(response: { status: number; json?: unknown }): boolean {
        if (response.status === 401) return true;
        if (response.status !== 400) return false;

        let body: unknown;
        try {
            body = response.json;
        } catch {
            return false; // non-JSON 400 body — not a recognized token error
        }
        const code = (body as { error?: { code?: string }; code?: string })?.error?.code
            ?? (body as { code?: string })?.code;
        if (code === 'reauth_required' || code === 'token_not_valid') return true;

        try {
            const text = JSON.stringify(body ?? {}).toLowerCase();
            return text.includes('token_not_valid')
                || text.includes('blacklisted')
                || text.includes('invalid or expired');
        } catch {
            return false;
        }
    }

    /**
     * Flip to the persistent "reconnect" state. Tokens are intentionally NOT
     * cleared — server-side they are already dead, and wiping is reserved for
     * explicit logout. Re-pairing (initialize) resets the flag.
     */
    private markAuthInvalid(): void {
        if (this.authInvalidated) return;
        this.authInvalidated = true;
        if (this.onAuthInvalidated) {
            this.onAuthInvalidated();
        }
    }

    /**
     * Flip to the reconnect state on the person's say-so (Test connection got
     * a 401 the refresh could not cure). Never called from a background sync:
     * a 401 there can follow a transient refresh failure, and a sync must not
     * strand a connection that the next refresh would have saved.
     */
    invalidate(): void {
        this.markAuthInvalid();
    }

    /**
     * Called by the API client after a request got a 401: try one refresh.
     * Returns the new tokens, or null when the request should not be retried.
     * Never wipes tokens.
     */
    async handleUnauthorized(): Promise<TokenData | null> {
        if (this.authInvalidated) {
            debugLog('Auth already invalidated, skipping refresh attempt');
            return null;
        }

        debugLog('Handling 401 Unauthorized, attempting token refresh...');
        try {
            return await this.refreshToken();
        } catch (error) {
            console.error('Token refresh on 401 failed:', error);
            // ⭐ A refresh that failed for a passing reason (offline, busy, a
            // server error) is rethrown, so the caller says THAT, rather than
            // reporting the 401 as a dead session (review F22).
            if (error instanceof RefreshError && error.reason === 'transient') throw error;
            return null;
        }
    }

    /**
     * Forget tokens — explicit logout only. Never called on refresh failure.
     */
    async clearTokens(): Promise<void> {
        this.generation++;
        this.refreshPromise = null;
        this.accessToken = null;
        this.refreshTokenValue = null;
        this.expiresAt = 0;
        if (this.onTokensChanged) {
            await this.onTokensChanged(null);
        }
    }

    hasTokens(): boolean {
        return !!this.accessToken && !!this.refreshTokenValue;
    }

    async getTokenExpiry(): Promise<Date | null> {
        if (!this.accessToken) return null;
        return new Date(this.expiresAt);
    }

    async isTokenExpired(): Promise<boolean> {
        if (!this.accessToken) return true;
        return this.expiresAt < Date.now();
    }

    isAuthInvalidated(): boolean {
        return this.authInvalidated;
    }

    async getTimeUntilExpiry(): Promise<number> {
        if (!this.accessToken) return 0;
        return Math.max(0, this.expiresAt - Date.now());
    }

    updateApiUrl(apiUrl: string): void {
        this.apiUrl = apiUrl;
    }

    updateDeviceId(deviceId: string): void {
        this.deviceId = deviceId;
    }
}
