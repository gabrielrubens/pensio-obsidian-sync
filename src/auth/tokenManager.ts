import { Notice, requestUrl } from 'obsidian';
import { debugLog } from '../logger';

export interface TokenData {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

/**
 * Callback invoked whenever tokens change (refresh, login, logout).
 * Implementor persists the new tokens to data.json.
 */
export type OnTokensChanged = (tokens: TokenData | null) => Promise<void>;

/**
 * Manages JWT token lifecycle: auto-refresh, 401 handling, expiry tracking.
 *
 * Tokens are held in memory only. Persistence is handled by the caller
 * via the onTokensChanged callback (which saves to data.json).
 */
export class TokenManager {
    private apiUrl: string;
    private deviceId: string;
    private accessToken: string | null = null;
    private refreshTokenValue: string | null = null;
    private expiresAt: number = 0;
    private refreshPromise: Promise<TokenData> | null = null;
    private refreshTimer: NodeJS.Timeout | null = null;
    private authInvalidated = false;
    private onTokensChanged: OnTokensChanged | null = null;

    constructor(apiUrl: string, deviceId: string = '') {
        this.apiUrl = apiUrl;
        this.deviceId = deviceId;
    }

    /**
     * Set callback for token persistence. Must be called before initialize().
     */
    setOnTokensChanged(callback: OnTokensChanged): void {
        this.onTokensChanged = callback;
    }

    async initialize(accessToken: string, refreshToken: string): Promise<void> {
        this.accessToken = accessToken;
        this.refreshTokenValue = refreshToken;
        this.expiresAt = Date.now() + (24 * 60 * 60 * 1000);
        this.authInvalidated = false;
        this.scheduleRefresh(this.expiresAt);
    }

    async getAccessToken(): Promise<string | null> {
        if (this.authInvalidated) return null;
        if (!this.accessToken) return null;

        // Refresh if expiring within 1 hour
        const oneHour = 60 * 60 * 1000;
        if (this.expiresAt - Date.now() < oneHour) {
            debugLog('Token expiring soon, refreshing...');
            try {
                const newTokens = await this.refreshToken();
                return newTokens.accessToken;
            } catch (error) {
                console.error('Failed to refresh token:', error);
                return this.accessToken;
            }
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
            throw new Error('Authentication was invalidated — please log in again');
        }
        if (!this.refreshTokenValue) {
            throw new Error('No refresh token available');
        }

        try {
            const response = await requestUrl({
                url: `${this.apiUrl}/api/v1/auth/refresh/`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    refresh: this.refreshTokenValue,
                    device_id: this.deviceId,
                })
            });

            const data: { access: string; refresh?: string } = response.json;

            const expiresAt = Date.now() + (24 * 60 * 60 * 1000);
            const newTokens: TokenData = {
                accessToken: data.access,
                refreshToken: data.refresh || this.refreshTokenValue,
                expiresAt
            };

            this.accessToken = newTokens.accessToken;
            this.refreshTokenValue = newTokens.refreshToken;
            this.expiresAt = expiresAt;
            this.scheduleRefresh(expiresAt);

            // Notify caller to persist new tokens
            if (this.onTokensChanged) {
                await this.onTokensChanged(newTokens);
            }

            debugLog('Token refreshed successfully');
            return newTokens;
        } catch (error) {
            console.error('Token refresh failed:', error);

            if (error.status === 401) {
                this.authInvalidated = true;
                await this.clearTokens();
                new Notice('Session expired. Please log in again in Pensio settings.');
            }

            throw new Error('Failed to refresh authentication token');
        }
    }

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
            if (!this.authInvalidated) {
                this.authInvalidated = true;
                await this.clearTokens();
            }
            return null;
        }
    }

    private scheduleRefresh(expiresAt: number): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }

        const oneHour = 60 * 60 * 1000;
        const delay = expiresAt - oneHour - Date.now();

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
            debugLog('Token expired or expiring very soon, refreshing immediately');
            this.refreshToken().catch(error => {
                console.error('Immediate refresh failed:', error);
            });
        }
    }

    cancelRefreshTimer(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    async clearTokens(): Promise<void> {
        this.cancelRefreshTimer();
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
