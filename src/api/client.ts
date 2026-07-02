import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { RefreshError, TokenManager } from '../auth/tokenManager';
import { debugLog } from '../logger';
import {
    ApiError,
    BulkSyncItem,
    BulkSyncResponse,
    CurrentUserResponse,
    EntryResponse,
    PairResponse,
    PensioSettings,
    PersonResponse,
    SyncStatusResponse,
} from '../types';

/**
 * API client for Pensio REST API.
 * All syncing goes through bulkSync(). Individual CRUD kept only for
 * mirror-delete (listEntries/listPeople + deleteEntry/deletePerson).
 */
export class ApiClient {
    private settings: PensioSettings;
    private tokenManager: TokenManager;

    constructor(settings: PensioSettings) {
        this.settings = settings;
        this.tokenManager = new TokenManager(settings.apiUrl, settings.deviceId);
    }

    /**
     * Initialize token manager with tokens loaded from SecretStorage.
     * Called by main.ts after loading tokens.
     */
    async initializeTokens(accessToken: string, refreshToken: string): Promise<void> {
        await this.tokenManager.initialize(accessToken, refreshToken);
    }

    updateSettings(settings: PensioSettings): void {
        this.settings = settings;
        this.tokenManager.updateApiUrl(settings.apiUrl);
        this.tokenManager.updateDeviceId(settings.deviceId);
    }

    // ========================================================================
    // Core HTTP
    // ========================================================================

    private async request<T>(
        method: string,
        endpoint: string,
        body?: any,
        retryCount = 0
    ): Promise<T> {
        if (this.tokenManager.isAuthInvalidated()) {
            throw new RefreshError(
                'auth-invalid',
                'Pensio session expired — reconnect in the plugin settings'
            );
        }

        // Normalize: fallback to default if empty, strip www. to avoid Cloudflare 301 redirect
        const baseUrl = (this.settings.apiUrl || 'https://pensio.app').replace('://www.', '://');
        const url = `${baseUrl}${endpoint}`;

        const options: RequestUrlParam = {
            url,
            method,
            headers: {
                'Content-Type': 'application/json',
            },
        };

        const accessToken = await this.tokenManager.getAccessToken();
        if (accessToken && options.headers) {
            options.headers['Authorization'] = `Bearer ${accessToken}`;
        }

        if (body) {
            options.body = JSON.stringify(body);
        }

        try {
            const response: RequestUrlResponse = await requestUrl(options);

            if (response.status === 204 || !response.text) {
                return {} as T;
            }

            return response.json as T;
        } catch (error) {
            // Handle redirect-induced 405: some HTTP clients (including Obsidian's
            // requestUrl) downgrade POST→GET on 301/302 redirects. If we get 405,
            // retry once with method preserved.
            if (error.status === 405 && method === 'POST' && retryCount < 1) {
                debugLog('Got 405 on POST (likely redirect downgraded to GET), retrying...');
                return this.request<T>(method, endpoint, body, retryCount + 1);
            }

            if (error.status === 401 && retryCount < 1) {
                debugLog('Got 401, attempting token refresh and retry...');
                const newTokens = await this.tokenManager.handleUnauthorized();

                if (newTokens) {
                    return this.request<T>(method, endpoint, body, retryCount + 1);
                }
                if (this.tokenManager.isAuthInvalidated()) {
                    throw new RefreshError(
                        'auth-invalid',
                        'Pensio session expired — reconnect in the plugin settings'
                    );
                }
            }

            if (error.status && error.json) {
                const apiError = error.json as ApiError;
                const errorMessage = apiError.error?.message || apiError.detail || 'API request failed';
                const customError: any = new Error(errorMessage);
                customError.status = error.status;
                throw customError;
            }
            throw error;
        }
    }

    private async fetchAllPages<T>(endpoint: string): Promise<T[]> {
        const allResults: T[] = [];
        let nextUrl: string | null = endpoint;

        while (nextUrl) {
            const response: {
                count: number;
                next: string | null;
                previous: string | null;
                results: T[];
            } = await this.request<{
                count: number;
                next: string | null;
                previous: string | null;
                results: T[];
            }>('GET', nextUrl);

            allResults.push(...response.results);

            if (response.next) {
                try {
                    const parsedUrl: URL = new URL(response.next);
                    nextUrl = parsedUrl.pathname + parsedUrl.search;
                } catch {
                    nextUrl = response.next;
                }
            } else {
                nextUrl = null;
            }
        }

        return allResults;
    }

    // ========================================================================
    // Auth
    // ========================================================================

    async fetchCurrentUser(): Promise<CurrentUserResponse> {
        return await this.request<CurrentUserResponse>('GET', '/api/v1/auth/me/');
    }

    /**
     * Exchange a one-time setup code (minted on the Pensio token page) for a
     * fresh per-device token family. Unauthenticated by design — the code is
     * the credential — so it bypasses request()/getAccessToken().
     */
    async pair(
        code: string,
        deviceId: string,
        deviceName: string
    ): Promise<PairResponse> {
        const baseUrl = (this.settings.apiUrl || 'https://pensio.app').replace('://www.', '://');
        const response = await requestUrl({
            url: `${baseUrl}/api/v1/auth/pair/`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code,
                device_id: deviceId,
                device_name: deviceName,
            }),
            throw: false,
        });

        if (response.status >= 200 && response.status < 300) {
            return response.json as PairResponse;
        }

        let message = 'Pairing failed — check the code and try again';
        try {
            const apiError = response.json as ApiError;
            message = apiError.error?.fields?.code?.[0]
                || apiError.error?.message
                || apiError.detail
                || message;
        } catch {
            // non-JSON error body — keep the generic message
        }
        const err: any = new Error(message);
        err.status = response.status;
        throw err;
    }

    // ========================================================================
    // Sync
    // ========================================================================

    async getSyncStatus(): Promise<SyncStatusResponse> {
        return await this.request<SyncStatusResponse>('GET', '/api/v1/entries/sync_status/');
    }

    async bulkSync(
        entries: BulkSyncItem[] = [],
        people: BulkSyncItem[] = []
    ): Promise<BulkSyncResponse> {
        return await this.request<BulkSyncResponse>(
            'POST',
            '/api/v1/sync/bulk/',
            { entries, people }
        );
    }

    // ========================================================================
    // Entries (list + delete only — used by mirror-delete)
    // ========================================================================

    async listEntries(): Promise<EntryResponse[]> {
        return await this.fetchAllPages<EntryResponse>('/api/v1/entries/');
    }

    async deleteEntry(id: string): Promise<void> {
        await this.request<void>('DELETE', `/api/v1/entries/${id}/`);
    }

    // ========================================================================
    // People (list + delete only — used by mirror-delete)
    // ========================================================================

    async listPeople(): Promise<PersonResponse[]> {
        return await this.fetchAllPages<PersonResponse>('/api/v1/people/');
    }

    async deletePerson(id: string): Promise<void> {
        await this.request<void>('DELETE', `/api/v1/people/${id}/`);
    }

    // ========================================================================
    // Token management
    // ========================================================================

    getTokenManager(): TokenManager {
        return this.tokenManager;
    }

    async refreshToken(): Promise<void> {
        await this.tokenManager.refreshToken();
    }

    async logout(): Promise<void> {
        await this.tokenManager.clearTokens();
    }

    async isAuthenticated(): Promise<boolean> {
        return this.tokenManager.hasTokens() && !(await this.tokenManager.isTokenExpired());
    }

    isAuthInvalidated(): boolean {
        return this.tokenManager.isAuthInvalidated();
    }
}
