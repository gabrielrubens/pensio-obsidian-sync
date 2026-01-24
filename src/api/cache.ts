import { EntryResponse, PersonResponse, PromptResponse } from '../types';

interface CacheEntry<T> {
    data: T;
    timestamp: number;
}

/**
 * Cache manager for API responses
 * Reduces redundant API calls by caching responses with TTL
 */
export class CacheManager {
    private static readonly TTL_MS = 5 * 60 * 1000; // 5 minutes

    private peopleCache = new Map<string, CacheEntry<PersonResponse>>();
    private entriesCache = new Map<string, CacheEntry<EntryResponse>>();
    private promptsCache = new Map<string, CacheEntry<PromptResponse>>();

    private allPeopleCache: CacheEntry<PersonResponse[]> | null = null;
    private allEntriesCache: CacheEntry<EntryResponse[]> | null = null;
    private allPromptsCache: CacheEntry<PromptResponse[]> | null = null;

    /**
     * Get cached person by ID
     */
    getPerson(id: string): PersonResponse | null {
        const cached = this.peopleCache.get(id);
        if (cached && !this.isExpired(cached.timestamp)) {
            return cached.data;
        }
        return null;
    }

    /**
     * Cache person
     */
    setPerson(person: PersonResponse): void {
        this.peopleCache.set(person.id, {
            data: person,
            timestamp: Date.now()
        });
    }

    /**
     * Get cached entry by ID
     */
    getEntry(id: string): EntryResponse | null {
        const cached = this.entriesCache.get(id);
        if (cached && !this.isExpired(cached.timestamp)) {
            return cached.data;
        }
        return null;
    }

    /**
     * Cache entry
     */
    setEntry(entry: EntryResponse): void {
        this.entriesCache.set(entry.id, {
            data: entry,
            timestamp: Date.now()
        });
    }

    /**
     * Get cached prompt by ID
     */
    getPrompt(id: string): PromptResponse | null {
        const cached = this.promptsCache.get(id);
        if (cached && !this.isExpired(cached.timestamp)) {
            return cached.data;
        }
        return null;
    }

    /**
     * Cache prompt
     */
    setPrompt(prompt: PromptResponse): void {
        this.promptsCache.set(prompt.id, {
            data: prompt,
            timestamp: Date.now()
        });
    }

    /**
     * Get all cached people
     */
    getAllPeople(): PersonResponse[] | null {
        if (this.allPeopleCache && !this.isExpired(this.allPeopleCache.timestamp)) {
            return this.allPeopleCache.data;
        }
        return null;
    }

    /**
     * Cache all people
     */
    setAllPeople(people: PersonResponse[]): void {
        this.allPeopleCache = {
            data: people,
            timestamp: Date.now()
        };
        // Also cache individually
        people.forEach(person => this.setPerson(person));
    }

    /**
     * Get all cached entries
     */
    getAllEntries(): EntryResponse[] | null {
        if (this.allEntriesCache && !this.isExpired(this.allEntriesCache.timestamp)) {
            return this.allEntriesCache.data;
        }
        return null;
    }

    /**
     * Cache all entries
     */
    setAllEntries(entries: EntryResponse[]): void {
        this.allEntriesCache = {
            data: entries,
            timestamp: Date.now()
        };
        // Also cache individually
        entries.forEach(entry => this.setEntry(entry));
    }

    /**
     * Get all cached prompts
     */
    getAllPrompts(): PromptResponse[] | null {
        if (this.allPromptsCache && !this.isExpired(this.allPromptsCache.timestamp)) {
            return this.allPromptsCache.data;
        }
        return null;
    }

    /**
     * Cache all prompts
     */
    setAllPrompts(prompts: PromptResponse[]): void {
        this.allPromptsCache = {
            data: prompts,
            timestamp: Date.now()
        };
        // Also cache individually
        prompts.forEach(prompt => this.setPrompt(prompt));
    }

    /**
     * Find person in cache by name
     */
    findPersonByName(name: string): PersonResponse | null {
        for (const entry of this.peopleCache.values()) {
            if (!this.isExpired(entry.timestamp) && entry.data.name === name) {
                return entry.data;
            }
        }
        return null;
    }

    /**
     * Find person in cache by path
     */
    findPersonByPath(path: string): PersonResponse | null {
        for (const entry of this.peopleCache.values()) {
            if (!this.isExpired(entry.timestamp) && entry.data.person_note_path === path) {
                return entry.data;
            }
        }
        return null;
    }

    /**
     * Find entry in cache by file path
     */
    findEntryByPath(filePath: string): EntryResponse | null {
        for (const entry of this.entriesCache.values()) {
            if (!this.isExpired(entry.timestamp) && entry.data.file_path === filePath) {
                return entry.data;
            }
        }
        return null;
    }

    /**
     * Find prompt in cache by file path
     */
    findPromptByPath(filePath: string): PromptResponse | null {
        for (const entry of this.promptsCache.values()) {
            if (!this.isExpired(entry.timestamp) && entry.data.file_path === filePath) {
                return entry.data;
            }
        }
        return null;
    }

    /**
     * Invalidate person cache (call after create/update/delete)
     */
    invalidatePerson(id?: string): void {
        if (id) {
            this.peopleCache.delete(id);
        } else {
            this.peopleCache.clear();
        }
        this.allPeopleCache = null;
    }

    /**
     * Invalidate entry cache (call after create/update/delete)
     */
    invalidateEntry(id?: string): void {
        if (id) {
            this.entriesCache.delete(id);
        } else {
            this.entriesCache.clear();
        }
        this.allEntriesCache = null;
    }

    /**
     * Invalidate prompt cache (call after create/update/delete)
     */
    invalidatePrompt(id?: string): void {
        if (id) {
            this.promptsCache.delete(id);
        } else {
            this.promptsCache.clear();
        }
        this.allPromptsCache = null;
    }

    /**
     * Clear all caches
     */
    clearAll(): void {
        this.peopleCache.clear();
        this.entriesCache.clear();
        this.promptsCache.clear();
        this.allPeopleCache = null;
        this.allEntriesCache = null;
        this.allPromptsCache = null;
    }

    /**
     * Check if timestamp is expired
     */
    private isExpired(timestamp: number): boolean {
        return Date.now() - timestamp > CacheManager.TTL_MS;
    }
}
