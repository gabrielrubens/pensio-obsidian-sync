/**
 * Maps a vault folder to a Pensio entry type.
 * Each mapping tells the sync engine: "files in this folder are this type."
 */
export interface JournalFolderMapping {
    folder: string;
    entryType: string;  // matches JournalEntry.EntryType on backend
    label: string;      // human-readable label shown in settings
}

/**
 * Available entry types (mirrors backend JournalEntry.EntryType)
 */
export const ENTRY_TYPES: { value: string; label: string }[] = [
    { value: 'daily_journal', label: 'Daily Journal' },
    { value: 'prompted_journal', label: 'Prompted Journal' },
    { value: 'deep_dive', label: 'Deep Dive' },
    { value: 'meeting_note', label: 'Meeting Note' },
    { value: 'other', label: 'Other' },
];

/**
 * Plugin settings interface
 */
export interface PensioSettings {
    apiUrl: string;
    deviceId: string;
    autoSync: boolean;
    journalFolders: JournalFolderMapping[]; // folder-to-type mappings
    peopleFolder: string; // folder for people notes
    enableMirrorDelete: boolean; // delete server entries not found locally
    debugMode: boolean; // enable verbose console logging
}

/**
 * Default plugin settings
 */
export const DEFAULT_SETTINGS: PensioSettings = {
    apiUrl: 'https://www.pensio.app',
    deviceId: '',
    autoSync: true,
    journalFolders: [
        { folder: 'Journal', entryType: 'daily_journal', label: 'Daily Journal' },
    ],
    peopleFolder: 'People',
    enableMirrorDelete: false,
    debugMode: false
};

/**
 * API response types
 */

/**
 * Response from GET /api/v1/auth/me/
 * Used for account-switch detection.
 */
export interface CurrentUserResponse {
    id: string;
    email: string;
    username: string;
}

export interface SyncStatusResponse {
    last_sync: string | null;
    total_entries: number;
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
        skipped: number;
        errors: Array<{ file_path: string; error: string }>;
    };
    people: {
        created: number;
        updated: number;
        deleted: number;
        skipped: number;
        errors: Array<{ file_path: string; error: string }>;
    };
    total_time_ms: number;
}

/**
 * Persistent sync state — survives plugin reloads.
 * Stored in data.json alongside settings under _syncState key.
 */
export interface SyncStateData {
    /** User ID (UUID) this sync state belongs to. Null for legacy data. */
    userId: string | null;
    /** Timestamp (ms) of last successful full sync */
    lastSyncTime: number | null;
    /** Per-file tracking: path → hash + mtime */
    files: Record<string, SyncedFileInfo>;
}

/**
 * Tracked file info for incremental sync.
 */
export interface SyncedFileInfo {
    /** SHA-256 of raw file content */
    hash: string;
    /** File modification time at last sync (ms since epoch) */
    mtime: number;
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
