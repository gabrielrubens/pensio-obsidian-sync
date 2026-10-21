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
    /** The note's raw file (markdown); the server renders it. */
    content_html: string;
    /**
     * The same raw file again. Left out for a server that said
     * `capabilities.content_once`, which fills it from `content_html`
     * (`sync/serverCapabilities.ts`).
     */
    content_plain?: string;
    entry_date: string | null;
    entry_type: string;
    file_path: string;  // Always set for plugin-synced entries
    frontmatter: Record<string, unknown>;
    file_modified_at: string;
}

export interface CreatePersonRequest {
    name: string;
    // ⛔ No `aliases`. The backend parses `aliases:` from the note's frontmatter;
    // a payload that carries the field at all can only overwrite what is stored,
    // and the hardcoded `[]` this used to send did exactly that to aliases set in
    // the web UI. Read them back from PersonResponse, never send them.
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
    action: 'create' | 'update' | 'delete' | 'rename';
    /** The note's path — for a rename, where it WAS. */
    file_path: string;
    /** Rename only: where the note is now. */
    new_file_path?: string;
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
        /** Optional: absent on servers that cannot move a row. */
        renamed?: number;
        skipped: number;
        errors: Array<{ file_path: string; error: string }>;
    };
    people: {
        created: number;
        updated: number;
        deleted: number;
        /** Optional: absent on servers that cannot move a row. */
        renamed?: number;
        skipped: number;
        errors: Array<{ file_path: string; error: string }>;
    };
    total_time_ms: number;
    /**
     * What this server can do beyond create/update/delete. Optional: absent on
     * servers older than the rename support. ⚠️ Absence is the signal that a
     * rename must fall back to delete + create — never an error message, which
     * is translated (`engine.ts::processRenames`).
     */
    capabilities?: Capabilities;
    /**
     * Optional: omitted by Pensio servers older than v0.5.3 and by
     * self-hosted instances that have not updated. Treat absence as
     * "unknown", never as "unlimited".
     */
    processing_status?: ProcessingStatus;
}

/** What a bulk answer says the server can do beyond create, update and delete. */
export interface Capabilities {
    /** It moves a renamed note's row (`engine.ts::processRenames`). */
    rename?: boolean;
    /**
     * It fills `content_plain` from `content_html`, so a note's text may go
     * once (`sync/serverCapabilities.ts`). Absent on servers that do not.
     */
    content_once?: boolean;
}

/** The last bulk answer's capabilities, and the Server URL that gave them. */
export interface CapabilitiesState {
    server: string;
    capabilities: Capabilities;
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
    /**
     * Notes too large to sync, by path, with the modification time they had
     * when found (plugin 0.7.3, `sync/tooLarge.ts`), so a reload neither reads
     * them again nor loses the card's line about them. Absent on state written
     * before this field existed.
     */
    tooLarge?: Record<string, { mtime: number; bytes: number; textOnce?: boolean }>;
    /**
     * What the server last said it can do (`sync/serverCapabilities.ts`), so
     * a reload does not send a long note's text twice again. Absent on state
     * written before this field existed, and until a server first answers.
     */
    capabilities?: CapabilitiesState;
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
