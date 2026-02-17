import { debugLog } from '../logger';
/**
 * Token manager for automatic token refresh
 * 
 * Handles:
 * - Auto-refresh tokens before expiration
 * - Retry failed requests with refreshed tokens
 * - Token validation and expiry checking
 */

import { Notice, requestUrl } from 'obsidian';
import { TokenData, TokenStorage } from './tokenStorage';

export class TokenManager {
    private storage: TokenStorage;
    private apiUrl: string;
    private refreshPromise: Promise<TokenData> | null = null;
    private refreshTimer: NodeJS.Timeout | null = null;
    /**
     * True when token refresh has failed with 401 (refresh token invalid).
     * Prevents repeated refresh attempts and Notice spam until the user
     * explicitly re-authenticates.
     */
    private authInvalidated = false;

    constructor(apiUrl: string) {
        this.storage = new TokenStorage();
        this.apiUrl = apiUrl;
    }

    /**
     * Initialize token manager with existing tokens
     */
    async initialize(accessToken: string, refreshToken: string): Promise<void> {
        // Calculate expiry (access tokens are valid for 24 hours)
        const expiresAt = Date.now() + (24 * 60 * 60 * 1000);

        const tokens: TokenData = {
            accessToken,
            refreshToken,
            expiresAt
        };

        // Reset invalidation flag on fresh login
        this.authInvalidated = false;

        await this.storage.storeTokens(tokens);
        this.scheduleRefresh(expiresAt);
    }

    /**
     * Get current access token, refreshing if necessary.
     * Returns null (skips refresh) if auth was previously invalidated.
     */
    async getAccessToken(): Promise<string | null> {
        if (this.authInvalidated) {
            return null;
        }

        const tokens = await this.storage.retrieveTokens();
        if (!tokens) {
            return null;
        }

        // Check if token is expired or will expire soon (within 1 hour)
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;

        if (tokens.expiresAt - now < oneHour) {
            debugLog('Token expiring soon, refreshing...');
            try {
                const newTokens = await this.refreshToken();
                return newTokens.accessToken;
            } catch (error) {
                console.error('Failed to refresh token:', error);
                // Return existing token and let the API call fail with 401
                // This will trigger the refresh in handleUnauthorized
                return tokens.accessToken;
            }
        }

        return tokens.accessToken;
    }

    /**
     * Refresh the access token using the refresh token
     */
    async refreshToken(): Promise<TokenData> {
        // If a refresh is already in progress, wait for it
        if (this.refreshPromise) {
            return this.refreshPromise;
        }

        this.refreshPromise = this._performRefresh();

        try {
            const newTokens = await this.refreshPromise;
            return newTokens;
        } finally {
            this.refreshPromise = null;
        }
    }

    /**
     * Actually perform the token refresh API call
     */
    private async _performRefresh(): Promise<TokenData> {
        // If auth was already invalidated, don't attempt refresh
        if (this.authInvalidated) {
            throw new Error('Authentication was invalidated — please log in again');
        }

        const tokens = await this.storage.retrieveTokens();
        if (!tokens || !tokens.refreshToken) {
            throw new Error('No refresh token available');
        }

        try {
            const response = await requestUrl({
                url: `${this.apiUrl}/api/v1/auth/refresh/`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    refresh: tokens.refreshToken
                })
            });

            const data: { access: string } = response.json;

            // Update stored tokens with new access token
            const expiresAt = Date.now() + (24 * 60 * 60 * 1000);
            const newTokens: TokenData = {
                accessToken: data.access,
                refreshToken: tokens.refreshToken, // Keep same refresh token
                expiresAt
            };

            await this.storage.storeTokens(newTokens);
            this.scheduleRefresh(expiresAt);

            debugLog('Token refreshed successfully');
            return newTokens;
        } catch (error) {
            console.error('Token refresh failed:', error);

            // If refresh fails with 401, invalidate auth (refresh token is dead)
            if (error.status === 401) {
                this.authInvalidated = true;
                await this.clearTokens();
                new Notice('Session expired. Please log in again in Pensio settings.');
            }

            throw new Error('Failed to refresh authentication token');
        }
    }

    /**
     * Handle 401 Unauthorized response by attempting to refresh.
     * Returns null silently if auth was already invalidated (Notice was
     * already shown once by _performRefresh).
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
            // Don't show another Notice — _performRefresh already showed one
            // if the refresh token was invalid (401). Just ensure cleanup.
            if (!this.authInvalidated) {
                this.authInvalidated = true;
                await this.clearTokens();
            }
            return null;
        }
    }

    /**
     * Schedule automatic token refresh before expiration
     */
    private scheduleRefresh(expiresAt: number): void {
        // Clear any existing timer
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }

        // Schedule refresh 1 hour before expiration
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;
        const refreshAt = expiresAt - oneHour;
        const delay = refreshAt - now;

        if (delay > 0) {
            debugLog(`Scheduling token refresh in ${Math.round(delay / 1000 / 60)} minutes`);
            this.refreshTimer = setTimeout(async () => {
                try {
                    debugLog('Auto-refreshing token...');
                    await this.refreshToken();
                    new Notice('Authentication refreshed automatically', 3000);
                } catch (error) {
                    console.error('Auto-refresh failed:', error);
                    new Notice('Failed to refresh authentication. Please check your connection.');
                }
            }, delay);
        } else {
            // Token already expired or will expire very soon, refresh immediately
            debugLog('Token expired or expiring very soon, refreshing immediately');
            this.refreshToken().catch(error => {
                console.error('Immediate refresh failed:', error);
            });
        }
    }

    /**
     * Cancel scheduled refresh timer (for plugin unload)
     */
    cancelRefreshTimer(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    /**
     * Clear all stored tokens and cancel scheduled refresh
     */
    async clearTokens(): Promise<void> {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        await this.storage.clearTokens();
    }

    /**
     * Check if tokens are available
     */
    hasTokens(): boolean {
        return this.storage.hasTokens();
    }

    /**
     * Get token expiration time
     */
    async getTokenExpiry(): Promise<Date | null> {
        const tokens = await this.storage.retrieveTokens();
        if (!tokens) {
            return null;
        }
        return new Date(tokens.expiresAt);
    }

    /**
     * Check if token is expired
     */
    async isTokenExpired(): Promise<boolean> {
        const tokens = await this.storage.retrieveTokens();
        if (!tokens) {
            return true;
        }
        return tokens.expiresAt < Date.now();
    }

    /**
     * Whether authentication has been invalidated (refresh token rejected).
     * When true, all API calls should be skipped until the user logs in again.
     */
    isAuthInvalidated(): boolean {
        return this.authInvalidated;
    }

    /**
     * Get time until token expires (in milliseconds)
     */
    async getTimeUntilExpiry(): Promise<number> {
        const tokens = await this.storage.retrieveTokens();
        if (!tokens) {
            return 0;
        }
        return Math.max(0, tokens.expiresAt - Date.now());
    }

    /**
     * Update API URL (when settings change)
     */
    updateApiUrl(apiUrl: string): void {
        this.apiUrl = apiUrl;
    }

    /**
     * Get storage method info
     */
    getStorageMethod(): string {
        return this.storage.getStorageMethod();
    }
}
