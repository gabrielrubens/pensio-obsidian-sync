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
import { CacheManager } from './cache';

/**
 * API client for Journal Wise REST API
 */
export class ApiClient {
    private settings: JournalWiseSettings;
    private accessToken: string;
    private cache: CacheManager;

    constructor(settings: JournalWiseSettings) {
        this.settings = settings;
        this.accessToken = settings.apiToken;
        this.cache = new CacheManager();
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
            // Parse API error response and preserve status code
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

    /**
     * Fetch all pages from a paginated endpoint
     * DRF returns: { count: number, next: string|null, previous: string|null, results: T[] }
     */
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

            // Extract just the path from next URL if it's absolute
            if (response.next) {
                try {
                    const parsedUrl: URL = new URL(response.next);
                    nextUrl = parsedUrl.pathname + parsedUrl.search;
                } catch {
                    // If next is already relative, use it as-is
                    nextUrl = response.next;
                }
            } else {
                nextUrl = null;
            }
        }

        return allResults;
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
     * List all entries (handles pagination automatically)
     */
    async listEntries(): Promise<EntryResponse[]> {
        const cached = this.cache.getAllEntries();
        if (cached) {
            return cached;
        }

        const entries = await this.fetchAllPages<EntryResponse>('/api/v1/entries/');
        this.cache.setAllEntries(entries);
        return entries;
    }

    /**
     * Get single entry by ID
     */
    async getEntry(id: string): Promise<EntryResponse> {
        const cached = this.cache.getEntry(id);
        if (cached) {
            return cached;
        }

        const entry = await this.request<EntryResponse>(
            'GET',
            `/api/v1/entries/${id}/`
        );
        this.cache.setEntry(entry);
        return entry;
    }

    /**
     * Create new entry
     */
    async createEntry(entry: CreateEntryRequest): Promise<EntryResponse> {
        const created = await this.request<EntryResponse>(
            'POST',
            '/api/v1/entries/',
            entry
        );
        this.cache.invalidateEntry(); // Invalidate list cache
        this.cache.setEntry(created); // Cache the new entry
        return created;
    }

    /**
     * Update existing entry
     */
    async updateEntry(id: string, entry: UpdateEntryRequest): Promise<EntryResponse> {
        const updated = await this.request<EntryResponse>(
            'PUT',
            `/api/v1/entries/${id}/`,
            entry
        );
        this.cache.invalidateEntry(id);
        this.cache.setEntry(updated);
        return updated;
    }

    /**
     * Delete entry
     */
    async deleteEntry(id: string): Promise<void> {
        await this.request<void>(
            'DELETE',
            `/api/v1/entries/${id}/`
        );
        this.cache.invalidateEntry(id);
    }

    /**
     * Find entry by file path (efficient - uses query parameter)
     */
    async findEntryByPath(filePath: string): Promise<EntryResponse | null> {
        const cached = this.cache.findEntryByPath(filePath);
        if (cached) {
            return cached;
        }

        const response = await this.request<{ results: EntryResponse[] }>(
            'GET',
            `/api/v1/entries/?file_path=${encodeURIComponent(filePath)}`
        );
        const entry = response.results.length > 0 ? response.results[0] : null;
        if (entry) {
            this.cache.setEntry(entry);
        }
        return entry;
    }

    // ========================================================================
    // Prompt API Methods
    // ========================================================================

    /**
     * List all prompts (handles pagination automatically)
     */
    async listPrompts(): Promise<PromptResponse[]> {
        const cached = this.cache.getAllPrompts();
        if (cached) {
            return cached;
        }

        const prompts = await this.fetchAllPages<PromptResponse>('/api/v1/prompts/');
        this.cache.setAllPrompts(prompts);
        return prompts;
    }

    /**
     * Get single prompt by ID
     */
    async getPrompt(id: string): Promise<PromptResponse> {
        const cached = this.cache.getPrompt(id);
        if (cached) {
            return cached;
        }

        const prompt = await this.request<PromptResponse>(
            'GET',
            `/api/v1/prompts/${id}/`
        );
        this.cache.setPrompt(prompt);
        return prompt;
    }

    /**
     * Create new prompt
     */
    async createPrompt(prompt: CreatePromptRequest): Promise<PromptResponse> {
        const created = await this.request<PromptResponse>(
            'POST',
            '/api/v1/prompts/',
            prompt
        );
        this.cache.invalidatePrompt();
        this.cache.setPrompt(created);
        return created;
    }

    /**
     * Update existing prompt
     */
    async updatePrompt(id: string, prompt: CreatePromptRequest): Promise<PromptResponse> {
        const updated = await this.request<PromptResponse>(
            'PUT',
            `/api/v1/prompts/${id}/`,
            prompt
        );
        this.cache.invalidatePrompt(id);
        this.cache.setPrompt(updated);
        return updated;
    }

    /**
     * Delete prompt
     */
    async deletePrompt(id: string): Promise<void> {
        await this.request<void>(
            'DELETE',
            `/api/v1/prompts/${id}/`
        );
        this.cache.invalidatePrompt(id);
    }

    /**
     * Find prompt by file path (efficient - uses query parameter)
     */
    async findPromptByPath(filePath: string): Promise<PromptResponse | null> {
        const cached = this.cache.findPromptByPath(filePath);
        if (cached) {
            return cached;
        }

        const response = await this.request<{ results: PromptResponse[] }>(
            'GET',
            `/api/v1/prompts/?file_path=${encodeURIComponent(filePath)}`
        );
        const prompt = response.results.length > 0 ? response.results[0] : null;
        if (prompt) {
            this.cache.setPrompt(prompt);
        }
        return prompt;
    }

    // ========================================================================
    // Person API Methods
    // ========================================================================

    /**
     * List all people (handles pagination automatically)
     */
    async listPeople(): Promise<PersonResponse[]> {
        const cached = this.cache.getAllPeople();
        if (cached) {
            return cached;
        }

        const people = await this.fetchAllPages<PersonResponse>('/api/v1/people/');
        this.cache.setAllPeople(people);
        return people;
    }

    /**
     * Get single person by ID
     */
    async getPerson(id: string): Promise<PersonResponse> {
        const cached = this.cache.getPerson(id);
        if (cached) {
            return cached;
        }

        const person = await this.request<PersonResponse>(
            'GET',
            `/api/v1/people/${id}/`
        );
        this.cache.setPerson(person);
        return person;
    }

    /**
     * Create new person
     */
    async createPerson(person: CreatePersonRequest): Promise<PersonResponse> {
        const created = await this.request<PersonResponse>(
            'POST',
            '/api/v1/people/',
            person
        );
        this.cache.invalidatePerson();
        this.cache.setPerson(created);
        return created;
    }

    /**
     * Update existing person
     */
    async updatePerson(id: string, person: CreatePersonRequest): Promise<PersonResponse> {
        const updated = await this.request<PersonResponse>(
            'PUT',
            `/api/v1/people/${id}/`,
            person
        );
        this.cache.invalidatePerson(id);
        this.cache.setPerson(updated);
        return updated;
    }

    /**
     * Delete person
     */
    async deletePerson(id: string): Promise<void> {
        await this.request<void>(
            'DELETE',
            `/api/v1/people/${id}/`
        );
        this.cache.invalidatePerson(id);
    }

    /**
     * Find person by name (efficient - uses query parameter)
     */
    async findPersonByName(name: string): Promise<PersonResponse | null> {
        const cached = this.cache.findPersonByName(name);
        if (cached) {
            return cached;
        }

        const response = await this.request<{ results: PersonResponse[] }>(
            'GET',
            `/api/v1/people/?name=${encodeURIComponent(name)}`
        );
        const person = response.results.length > 0 ? response.results[0] : null;
        if (person) {
            this.cache.setPerson(person);
        }
        return person;
    }

    /**
     * Find person by file path (efficient - uses query parameter)
     */
    async findPersonByPath(filePath: string): Promise<PersonResponse | null> {
        const cached = this.cache.findPersonByPath(filePath);
        if (cached) {
            return cached;
        }

        const response = await this.request<{ results: PersonResponse[] }>(
            'GET',
            `/api/v1/people/?person_note_path=${encodeURIComponent(filePath)}`
        );
        const person = response.results.length > 0 ? response.results[0] : null;
        if (person) {
            this.cache.setPerson(person);
        }
        return person;
    }

    /**
     * Generate unique device ID
     */
    private generateDeviceId(): string {
        return `obsidian-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    }
}
