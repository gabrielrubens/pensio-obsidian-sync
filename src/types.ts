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
    peopleFolder: string; // folder for people notes
    excludePatterns: string[]; // glob patterns to exclude
    maxEntrySizeMB: number;
    conflictResolution: 'server-wins' | 'local-wins' | 'ask';
    enableMirrorDelete: boolean; // delete server entries not found locally
    debugMode: boolean; // enable verbose console logging
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
    peopleFolder: 'People',
    excludePatterns: ['.obsidian/**', '.trash/**'],
    maxEntrySizeMB: 5,
    conflictResolution: 'server-wins',
    enableMirrorDelete: false,
    debugMode: false
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
    file_path: string | null;
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

export interface CreateEntryRequest {
    title: string;
    content_html: string;
    content_plain: string;
    entry_date: string | null;
    entry_type: string;
    file_path: string;  // Always set for plugin-synced entries
    frontmatter: Record<string, any>;
    file_modified_at: string;
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
 * Bulk sync request item
 */
export interface BulkSyncItem {
    action: 'create' | 'update' | 'delete';
    file_path: string;
    data?: CreateEntryRequest | CreatePersonRequest;
}

/**
 * Bulk sync response
 */
export interface BulkSyncResponse {
    entries: {
        created: number;
        updated: number;
        deleted: number;
        errors: Array<{ file_path: string; error: string }>;
    };
    people: {
        created: number;
        updated: number;
        deleted: number;
        errors: Array<{ file_path: string; error: string }>;
    };
    total_time_ms: number;
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
