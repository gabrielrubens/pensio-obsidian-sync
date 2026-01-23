import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';
import {
    ApiError,
    CreateEntryRequest,
    CreatePersonRequest,
    CreatePromptRequest,
    EntryResponse,
    JournalWiseSettings,
    PersonResponse,
    PromptResponse,
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

            // Handle empty responses (like DELETE 204 No Content)
            if (response.status === 204 || !response.text) {
                return {} as T;
            }

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
                device_name: 'Obsidian', // Default device name
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

    // ========================================================================
    // Prompt API Methods
    // ========================================================================

    /**
     * List all prompts
     */
    async listPrompts(): Promise<PromptResponse[]> {
        const response = await this.request<{ results: PromptResponse[] }>(
            'GET',
            '/api/v1/prompts/'
        );
        return response.results;
    }

    /**
     * Get single prompt by ID
     */
    async getPrompt(id: string): Promise<PromptResponse> {
        return await this.request<PromptResponse>(
            'GET',
            `/api/v1/prompts/${id}/`
        );
    }

    /**
     * Create new prompt
     */
    async createPrompt(prompt: CreatePromptRequest): Promise<PromptResponse> {
        return await this.request<PromptResponse>(
            'POST',
            '/api/v1/prompts/',
            prompt
        );
    }

    /**
     * Update existing prompt
     */
    async updatePrompt(id: string, prompt: CreatePromptRequest): Promise<PromptResponse> {
        return await this.request<PromptResponse>(
            'PUT',
            `/api/v1/prompts/${id}/`,
            prompt
        );
    }

    /**
     * Delete prompt
     */
    async deletePrompt(id: string): Promise<void> {
        await this.request<void>(
            'DELETE',
            `/api/v1/prompts/${id}/`
        );
    }

    /**
     * Find prompt by file path
     */
    async findPromptByPath(filePath: string): Promise<PromptResponse | null> {
        const prompts = await this.listPrompts();
        return prompts.find(p => p.file_path === filePath) || null;
    }

    // ========================================================================
    // Person API Methods
    // ========================================================================

    /**
     * List all people
     */
    async listPeople(): Promise<PersonResponse[]> {
        const response = await this.request<{ results: PersonResponse[] }>(
            'GET',
            '/api/v1/people/'
        );
        return response.results;
    }

    /**
     * Get single person by ID
     */
    async getPerson(id: string): Promise<PersonResponse> {
        return await this.request<PersonResponse>(
            'GET',
            `/api/v1/people/${id}/`
        );
    }

    /**
     * Create new person
     */
    async createPerson(person: CreatePersonRequest): Promise<PersonResponse> {
        return await this.request<PersonResponse>(
            'POST',
            '/api/v1/people/',
            person
        );
    }

    /**
     * Update existing person
     */
    async updatePerson(id: string, person: CreatePersonRequest): Promise<PersonResponse> {
        return await this.request<PersonResponse>(
            'PUT',
            `/api/v1/people/${id}/`,
            person
        );
    }

    /**
     * Delete person
     */
    async deletePerson(id: string): Promise<void> {
        await this.request<void>(
            'DELETE',
            `/api/v1/people/${id}/`
        );
    }

    /**
     * Find person by name
     */
    async findPersonByName(name: string): Promise<PersonResponse | null> {
        const people = await this.listPeople();
        return people.find(p => p.name === name) || null;
    }

    /**
     * Find person by file path
     */
    async findPersonByPath(filePath: string): Promise<PersonResponse | null> {
        const people = await this.listPeople();
        return people.find(p => p.person_note_path === filePath) || null;
    }

    /**
     * Generate unique device ID
     */
    private generateDeviceId(): string {
        return `obsidian-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    }
}
