/**
 * Plugin settings interface
 */
export interface JournalWiseSettings {
    apiUrl: string;
    apiToken: string;
    deviceId: string;
    deviceName: string;
    autoSync: boolean;
    syncInterval: number; // minutes
    syncFolders: string[]; // folders to sync (e.g., ["Journal", "People"])
    excludePatterns: string[]; // glob patterns to exclude
    maxEntrySizeMB: number;
    conflictResolution: 'server-wins' | 'local-wins' | 'ask';
}

/**
 * Default plugin settings
 */
export const DEFAULT_SETTINGS: JournalWiseSettings = {
    apiUrl: '',
    apiToken: '',
    deviceId: '',
    deviceName: '',
    autoSync: false,
    syncInterval: 5,
    syncFolders: ['Journal'],
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
    id: number;
    name: string;
    vault_path: string;
    created_at: string;
    updated_at: string;
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
    error: {
        message: string;
        type: string;
        status_code: number;
        fields?: Record<string, string[]>;
    };
}
