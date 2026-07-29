/**
 * Maps a vault folder for syncing.
 * All entries default to daily_journal; use frontmatter type: to override per-file.
 */
export interface JournalFolderMapping {
    folder: string;
}

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
    apiUrl: 'https://pensio.app',
    deviceId: '',
    autoSync: true,
    journalFolders: [
        { folder: 'Journal' },
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

/**
 * Response from POST /api/v1/auth/pair/ — a fresh per-device token family
 * in exchange for a one-time setup code.
 */
export interface PairResponse {
    access: string;
    refresh: string;
    device_id: string;
    device_name: string;
}

export interface SyncStatusResponse {
    last_sync: string | null;
    total_entries: number;
    /** Optional: absent on Pensio servers older than v0.61.0. */
    processing_status?: ProcessingStatus;
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
    frontmatter: Record<string, unknown>;
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
    metadata: Record<string, unknown>;
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
    frontmatter: Record<string, unknown>;
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
    metadata: Record<string, unknown>;
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
 * Emotion-analysis quota status, as reported by the bulk-sync endpoint.
 *
 * Free accounts have a daily cap; Pro is unlimited and reports
 * `daily_limit: 0` / `remaining_today: -1`.
 */
export interface ProcessingStatus {
    /** Entries analyzed today. */
    processed_today: number;
    /** Daily cap. 0 means unlimited (Pro). */
    daily_limit: number;
    /** Entries left in today's quota. -1 means unlimited (Pro). */
    remaining_today: number;
    /** Entries synced but not yet analyzed. */
    pending: number;
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
    /**
     * Optional: omitted by Pensio servers older than v0.5.3 and by
     * self-hosted instances that have not updated. Treat absence as
     * "unknown", never as "unlimited".
     */
    processing_status?: ProcessingStatus;
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
    /**
     * UTC day (YYYY-MM-DD) the quota notice was last shown, so the reminder
     * survives plugin reloads instead of firing again on every startup.
     * Absent on state written before this field existed.
     */
    lastQuotaNoticeDay?: string | null;
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
        // Stable machine code (unified error contract — docs/admin/api-errors.md).
        // Optional: older backends omit it; the plugin reads `error.message`.
        code?: string;
        type?: string;
        status_code?: number;
        fields?: Record<string, string[]>;
    };
    detail?: string;  // Django REST framework error detail
}
