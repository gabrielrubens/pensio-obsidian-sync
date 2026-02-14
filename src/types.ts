/**
 * Plugin settings interface
 */
export interface PensioSettings {
    apiUrl: string;
    apiToken: string;
    refreshToken: string; // Store refresh token for auto-renewal
    deviceId: string;
    autoSync: boolean;
    syncInterval: number; // minutes
    journalFolder: string; // folder for journal entries
    promptFolder: string; // folder for prompts
    peopleFolder: string; // folder for people notes
    excludePatterns: string[]; // glob patterns to exclude
    maxEntrySizeMB: number;
    conflictResolution: 'server-wins' | 'local-wins' | 'ask';
}

/**
 * Default plugin settings
 */
export const DEFAULT_SETTINGS: PensioSettings = {
    apiUrl: '',
    apiToken: '',
    refreshToken: '',
    deviceId: '',
    autoSync: false,
    syncInterval: 5,
    journalFolder: 'Journal',
    promptFolder: 'Prompts',
    peopleFolder: 'People',
    excludePatterns: ['.obsidian/**', '.trash/**'],
    maxEntrySizeMB: 5,
    conflictResolution: 'server-wins'
};

/**
 * API response types
 */

export interface TokenResponse {
    access: string;
    refresh: string;
    device_id: string;
    device_name: string;
}

export interface SyncStatusResponse {
    last_sync: string | null;
    total_entries: number;
    pending_changes: number;
    conflict_count: number;
}

export interface EntryResponse {
    id: string;
    title: string;
    content_html: string;
    content_plain: string;
    entry_date: string | null;
    entry_type: string;
    source: string;
    file_path: string;
    file_hash: string;
    frontmatter: Record<string, any>;
    primary_emotion: string;
    file_modified_at: string;
    api_last_modified: string | null;
    created_at: string;
    updated_at: string;
    people: PersonResponse[];
}

export interface PersonResponse {
    id: string;
    name: string;
    aliases: string[];
    person_note_path: string;
    relationship: string;
    birthday: string | null;
    tags: string[];
    from_locations: string[];
    lived_in: string[];
    metadata: Record<string, any>;
    source: string;
    created_at: string;
    updated_at: string;
}

export interface PromptResponse {
    id: string;
    title: string;
    content: string;
    content_html: string;
    description: string;
    source: string;
    file_path: string;
    file_hash: string;
    created_at: string;
    updated_at: string;
    usage_count: number;
}

export interface CreateEntryRequest {
    title: string;
    content_html: string;
    content_plain: string;
    entry_date: string | null;
    entry_type: string;
    file_path: string;
    frontmatter: Record<string, any>;
    file_modified_at: string;
}

export interface CreatePromptRequest {
    title: string;
    content: string;
    content_html: string;
    description: string;
    file_path: string;
}

export interface CreatePersonRequest {
    name: string;
    aliases: string[];
    person_note_path: string;
    relationship: string;
    birthday: string | null;
    tags: string[];
    from_locations: string[];
    lived_in: string[];
    metadata: Record<string, any>;
}

export interface UpdateEntryRequest extends CreateEntryRequest {
    // Same as create, file_hash is read-only
}

/**
 * Sync queue item
 */
export interface SyncQueueItem {
    filePath: string;
    action: 'create' | 'update' | 'delete';
    timestamp: number;
    retryCount: number;
}

/**
 * Error types
 */
export interface ApiError {
    error?: {
        message: string;
        type: string;
        status_code: number;
        fields?: Record<string, string[]>;
    };
    detail?: string;  // Django REST framework error detail
}
