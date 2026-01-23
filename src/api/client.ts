import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import {
    ApiError,
    CreateEntryRequest,
    EntryResponse,
    JournalWiseSettings,
    SyncStatusResponse,
    TokenResponse,
    UpdateEntryRequest
} from '../types';

/**
 * API client for Journal Wise REST API
 */
export class ApiClient {
    private settings: JournalWiseSettings;
    private accessToken: string;

    constructor(settings: JournalWiseSettings) {
        this.settings = settings;
        this.accessToken = settings.apiToken;
    }

    /**
     * Update settings (called when user changes settings)
     */
    updateSettings(settings: JournalWiseSettings): void {
        this.settings = settings;
        this.accessToken = settings.apiToken;
    }

    /**
     * Make authenticated API request
     */
    private async request<T>(
        method: string,
        endpoint: string,
        body?: any
    ): Promise<T> {
        const url = `${this.settings.apiUrl}${endpoint}`;

        const options: RequestUrlParam = {
            url,
            method,
            headers: {
                'Content-Type': 'application/json',
            },
        };

        // Add auth header if we have a token
        if (this.accessToken && options.headers) {
            options.headers['Authorization'] = `Bearer ${this.accessToken}`;
        }

        // Add body if provided
        if (body) {
            options.body = JSON.stringify(body);
        }

        try {
            const response: RequestUrlResponse = await requestUrl(options);
            return response.json as T;
        } catch (error) {
            // Parse API error response
            if (error.status && error.json) {
                const apiError = error.json as ApiError;
                throw new Error(apiError.error?.message || 'API request failed');
            }
            throw error;
        }
    }

    /**
     * Authenticate with credentials and get tokens
     */
    async authenticate(email: string, password: string): Promise<TokenResponse> {
        // Generate device ID if not set
        if (!this.settings.deviceId) {
            this.settings.deviceId = this.generateDeviceId();
        }

        const response = await this.request<TokenResponse>(
            'POST',
            '/api/v1/auth/token/',
            {
                email,
                password,
                device_id: this.settings.deviceId,
                device_name: this.settings.deviceName || 'Obsidian',
            }
        );

        // Store access token
        this.accessToken = response.access;

        return response;
    }

    /**
     * Get sync status
     */
    async getSyncStatus(): Promise<SyncStatusResponse> {
        return await this.request<SyncStatusResponse>(
            'GET',
            '/api/v1/entries/sync_status/'
        );
    }

    /**
     * List all entries
     */
    async listEntries(): Promise<EntryResponse[]> {
        const response = await this.request<{ results: EntryResponse[] }>(
            'GET',
            '/api/v1/entries/'
        );
        return response.results;
    }

    /**
     * Get single entry by ID
     */
    async getEntry(id: string): Promise<EntryResponse> {
        return await this.request<EntryResponse>(
            'GET',
            `/api/v1/entries/${id}/`
        );
    }

    /**
     * Create new entry
     */
    async createEntry(entry: CreateEntryRequest): Promise<EntryResponse> {
        return await this.request<EntryResponse>(
            'POST',
            '/api/v1/entries/',
            entry
        );
    }

    /**
     * Update existing entry
     */
    async updateEntry(id: string, entry: UpdateEntryRequest): Promise<EntryResponse> {
        return await this.request<EntryResponse>(
            'PUT',
            `/api/v1/entries/${id}/`,
            entry
        );
    }

    /**
     * Delete entry
     */
    async deleteEntry(id: string): Promise<void> {
        await this.request<void>(
            'DELETE',
            `/api/v1/entries/${id}/`
        );
    }

    /**
     * Find entry by file path
     */
    async findEntryByPath(filePath: string): Promise<EntryResponse | null> {
        const entries = await this.listEntries();
        return entries.find(e => e.file_path === filePath) || null;
    }

    /**
     * Generate unique device ID
     */
    private generateDeviceId(): string {
        return `obsidian-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    }
}
