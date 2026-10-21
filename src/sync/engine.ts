import { App, TAbstractFile, TFile, TFolder } from 'obsidian';
import { ApiClient } from '../api/client';
import { RefreshError } from '../auth/tokenManager';
import { SyncFailure } from '../errors';
import { debugLog } from '../logger';
import { BulkSyncItem, BulkSyncResponse, CreateEntryRequest, CreatePersonRequest, PensioSettings, ProcessingStatus, SyncedFileInfo, SyncStateData } from '../types';
import { itemBytes, Section, sendInChunks, tooLargeAlone } from './chunks';
import { computeContentHash } from './hash';
import { deleteItems, goneNotes, MIRROR_CHUNK, mirrorSkip } from './mirror';
import { extractDateFromFilename, ParsedMarkdown, parseMarkdown } from './parser';
import { TooLargeNotes } from './tooLarge';

/**
 * Sync engine — watches vault files and syncs to Pensio via bulk API.
 *
 * Architecture: file watcher marks files as "dirty"; all syncing goes
 * through syncAll() which batches dirty files into bulk API calls.
 * This single code path eliminates dual-path bugs and N+1 queries.
 */
/** What a sync did. `contacted`: Pensio answered at least one of its requests. */
export interface SyncResult {
    synced: number;
    skipped: number;
    errors: number;
    total: number;
    contacted: boolean;
    /** The notes too large to sync, after this sync (`tooLarge.ts`). Not errors. */
    tooLarge: string[];
}

export class SyncEngine {
    private app: App;
    private settings: PensioSettings;
    private apiClient: ApiClient;
    private isWatching = false;
    private isSyncing = false;
    private syncIntervalTimer: number | null = null;
    /**
     * The sync startAutoSync schedules 5 s after it starts. ⛔ Before 0.7.1 it
     * was never kept, so stopWatching could not cancel it: every settings save
     * (each keystroke in a folder or token field) armed one more full sync
     * (review F10).
     */
    private initialSyncTimer: number | null = null;
    /** The folder settings the last successful sync used (see mirrorAllowed). */
    private foldersAtLastSync: string;
    /** The sync running now, so a second caller gets its real result. */
    private current: Promise<SyncResult> | null = null;
    /** A request of this sync reached Pensio and was answered. */
    private contacted = false;
    /**
     * Mirror delete deletes by itself at most this often; Sync now runs it at
     * once. ⛔ Not for what it costs — since 0.7.2 a pass with nothing gone
     * sends nothing — but as a margin. The folder-change guard defers mirror
     * delete for one sync only, so without this a folder field left half
     * typed, or a folder taken off the list for a moment, lost its entries at
     * the next automatic sync, minutes later. 0.7.1 had the gate for the
     * account listing, and 0.7.2 first removed it with the listing (review of
     * 0.7.2, 2026-10-21).
     */
    private readonly MIRROR_INTERVAL_MS = 60 * 60 * 1000;
    private lastMirrorAt = 0;
    /** Notes whose own request is more than Pensio takes (sync/chunks.ts). */
    private tooLarge = new TooLargeNotes();
    private readonly SYNC_INTERVAL_MS = 5 * 60 * 1000;
    private readonly INITIAL_SYNC_DELAY_MS = 5000;
    private readonly STATE_SAVE_DEBOUNCE_MS = 5000;
    private readonly WATCHER_SYNC_DEBOUNCE_MS = 3000;

    // Dirty set: files changed by watcher, pending next syncAll
    private dirtyFiles = new Set<string>();
    private pendingDeletes = new Set<string>();
    /** Moves waiting to be sent: old path → new path. See `onFileRenamed`. */
    private pendingRenames = new Map<string, string>();
    private watcherSyncTimer: number | null = null;

    // Incremental sync tracking (persisted via onSaveState callback)
    private lastSyncTime: number | null = null;
    private syncedFiles: Map<string, SyncedFileInfo> = new Map();
    private stateSaveTimer: number | null = null;
    private userId: string | null = null;

    // Emotion-analysis quota, as last reported by the bulk endpoint. The most
    // recent chunk of a sync wins, so after a big import this holds the state
    // once every entry has landed.
    private lastProcessingStatus: ProcessingStatus | null = null;
    private lastQuotaNoticeDay: string | null = null;

    /**
     * Called after any sync that learned the quota status — including the
     * silent automatic ones. Auto-sync is the path that matters: it is on by
     * default and shows no Notice, so a first import happens entirely without
     * user-visible feedback unless something reports back here.
     */
    onProcessingStatus: ((status: ProcessingStatus) => void) | null = null;

    /**
     * Called when an AUTOMATIC sync (on startup, on a change, every five
     * minutes) fails. ⛔ Before 0.7.0 those failures went to the console and
     * nowhere else: no Notice, no status bar, so a vault could stop syncing
     * for days with nothing on screen. A sync she asked for is reported by
     * whoever asked (`PensioPlugin.syncNow`), so it does not come here.
     */
    onSyncFailed: ((error: unknown) => void) | null = null;

    /**
     * Called after every sync that finished with nothing left failing.
     * `contacted` says whether Pensio answered it: a sync with nothing to send
     * sends nothing, and ⛔ is not proof that the connection works (review F26).
     */
    onSyncSucceeded: ((contacted: boolean) => void) | null = null;

    /**
     * Asked when a sync has nothing to send: true makes it ask Pensio anyway
     * (one GET of the sync status), so a problem on screen clears only once
     * Pensio really answers, and an unchecked account gets checked.
     */
    needsContact: (() => boolean) | null = null;

    // Bind handlers once to preserve reference for cleanup
    private readonly boundOnFileChanged: (file: TAbstractFile) => void;
    private readonly boundOnFileDeleted: (file: TAbstractFile) => void;
    private readonly boundOnFileRenamed: (file: TAbstractFile, oldPath: string) => void;

    constructor(
        app: App,
        settings: PensioSettings,
        apiClient: ApiClient,
        private onSaveState: (state: SyncStateData) => Promise<void> = async () => { }
    ) {
        this.app = app;
        this.settings = settings;
        this.apiClient = apiClient;
        this.foldersAtLastSync = this.folderSettings();

        // Arrow wrappers (not .bind, which the type-checker widens to `any`)
        // keep a stable reference for off() while staying type-safe.
        this.boundOnFileChanged = (file: TAbstractFile) => { this.onFileChanged(file); };
        this.boundOnFileDeleted = (file: TAbstractFile) => { this.onFileDeleted(file); };
        this.boundOnFileRenamed = (file: TAbstractFile, oldPath: string) => { this.onFileRenamed(file, oldPath); };
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    startWatching(): void {
        if (this.isWatching) return;

        debugLog('Starting file watcher for auto-sync');
        this.isWatching = true;

        this.app.vault.on('create', this.boundOnFileChanged);
        this.app.vault.on('modify', this.boundOnFileChanged);
        this.app.vault.on('delete', this.boundOnFileDeleted);
        this.app.vault.on('rename', this.boundOnFileRenamed);
    }

    stopWatching(): void {
        if (!this.isWatching) return;

        debugLog('Stopping file watcher and periodic sync');
        this.isWatching = false;

        if (this.syncIntervalTimer) {
            window.clearInterval(this.syncIntervalTimer);
            this.syncIntervalTimer = null;
        }
        if (this.watcherSyncTimer) {
            window.clearTimeout(this.watcherSyncTimer);
            this.watcherSyncTimer = null;
        }
        if (this.initialSyncTimer) {
            window.clearTimeout(this.initialSyncTimer);
            this.initialSyncTimer = null;
        }
        if (this.stateSaveTimer) {
            window.clearTimeout(this.stateSaveTimer);
            this.stateSaveTimer = null;
            void this.persistState();
        }

        this.app.vault.off('create', this.boundOnFileChanged);
        this.app.vault.off('modify', this.boundOnFileChanged);
        this.app.vault.off('delete', this.boundOnFileDeleted);
        this.app.vault.off('rename', this.boundOnFileRenamed);
    }

    /** The automatic sync is running: a failure will be tried again by itself. */
    isAutoSyncing(): boolean {
        return this.isWatching && this.syncIntervalTimer !== null;
    }

    startAutoSync(): void {
        if (this.initialSyncTimer) window.clearTimeout(this.initialSyncTimer);
        this.initialSyncTimer = window.setTimeout(() => {
            this.initialSyncTimer = null;
            void (async () => {
                if (!this.isWatching) return;
                if (this.apiClient.isAuthInvalidated()) {
                    debugLog('Initial sync skipped — auth invalidated');
                    return;
                }
                debugLog('Running initial sync...');
                try {
                    await this.syncAll(false);
                    debugLog('Initial sync completed');
                } catch (error) {
                    console.error('Initial sync failed:', error);
                    this.onSyncFailed?.(error);
                }
            })();
        }, this.INITIAL_SYNC_DELAY_MS);

        if (this.syncIntervalTimer) {
            window.clearInterval(this.syncIntervalTimer);
        }
        this.syncIntervalTimer = window.setInterval(() => {
            void (async () => {
                if (this.isSyncing) {
                    debugLog('Periodic sync skipped — sync already in progress');
                    return;
                }
                if (this.apiClient.isAuthInvalidated()) {
                    debugLog('Periodic sync skipped — auth invalidated');
                    return;
                }
                debugLog('Running periodic sync...');
                try {
                    await this.syncAll(false);
                } catch (error) {
                    console.error('Periodic sync failed:', error);
                    this.onSyncFailed?.(error);
                }
            })();
        }, this.SYNC_INTERVAL_MS);
    }

    // ========================================================================
    // File watcher — marks dirty, triggers debounced syncAll
    // ========================================================================

    private onFileChanged(file: TAbstractFile): void {
        if (!(file instanceof TFile)) return;
        if (!this.shouldSyncFile(file)) return;

        debugLog('File changed:', file.path);
        this.dirtyFiles.add(file.path);
        this.scheduleSyncFromWatcher();
    }

    private onFileDeleted(file: TAbstractFile): void {
        if (!(file instanceof TFile)) return;
        if (!this.shouldSyncFile(file)) return;

        debugLog('File deleted:', file.path);
        this.dirtyFiles.delete(file.path);
        // A move still waiting to be sent never reached Pensio, so the entry
        // is at the path the note came from: delete that one.
        let path = file.path;
        this.pendingRenames.forEach((to, from) => { if (to === file.path) path = from; });
        if (path !== file.path) {
            this.pendingRenames.delete(path);
            const tracked = this.syncedFiles.get(file.path);
            this.syncedFiles.delete(file.path);
            if (tracked) this.syncedFiles.set(path, tracked);
        }
        // ⭐ The history keeps the path until Pensio has answered the delete
        // (processDeletes). ⛔ It used to drop it here, before anything was
        // sent: a delete that failed (offline, a 429, a 5xx) was then lost,
        // and since 0.7.2 mirror delete, which works from the history, could
        // never find it again (review of 0.7.2, 2026-10-21).
        this.pendingDeletes.add(path);
        this.scheduleSyncFromWatcher();
    }

    /**
     * A note was renamed or moved. ⭐ **THE SAME ENTRY, AT ITS NEW PATH** (decided
     * 2026-10-20). Obsidian fires `rename` — never `create` + `delete` — and this
     * plugin did not listen for it, so a renamed note became a second entry and
     * the first stayed behind. Found by the `pensio-prod-demo` fixture vault.
     *
     * - inside the synced folders, same kind → a move (`processRenames`)
     * - out of the synced folders → nothing is sent. ⛔ Moving is not deleting:
     *   the entry stays (decided 2026-10-20). Mirror delete, if she turned it on,
     *   is what removes entries whose notes left.
     * - into the synced folders, never synced, or changed kind → a new note here
     */
    private onFileRenamed(file: TAbstractFile, oldPath: string): void {
        if (file instanceof TFolder) {
            // A folder moves every note inside it. Whether Obsidian also reports
            // each child does not matter: the file branch ignores a move it has
            // already been told about.
            const walk = (child: TAbstractFile): void => {
                if (child instanceof TFolder) {
                    child.children.forEach(walk);
                } else if (child instanceof TFile) {
                    this.onFileRenamed(child, oldPath + child.path.slice(file.path.length));
                }
            };
            file.children.forEach(walk);
            return;
        }
        if (!(file instanceof TFile)) return;
        if (this.pendingRenames.get(oldPath) === file.path) return;

        const wasIn = this.isSyncedPath(oldPath);
        const isIn = this.isSyncedPath(file.path);
        if (!wasIn && !isIn) return;

        debugLog('File renamed:', oldPath, '→', file.path);
        const tracked = this.syncedFiles.get(oldPath);
        // a → b, then b → c before a sync, is one move from a.
        let origin: string | undefined;
        this.pendingRenames.forEach((to, from) => { if (to === oldPath) origin = from; });
        this.dirtyFiles.delete(oldPath);

        const sameKind = wasIn && isIn &&
            this.detectContentType(oldPath) === this.detectContentType(file.path);
        if (sameKind && (tracked || origin)) {
            this.syncedFiles.delete(oldPath);
            if (origin) this.pendingRenames.delete(origin);
            this.pendingRenames.set(origin ?? oldPath, file.path);
            if (tracked) this.syncedFiles.set(file.path, tracked);
            this.scheduleSyncFromWatcher();
            return;
        }
        // ⭐ Not sent as a move, so its entry stays on Pensio where it was, and
        // the sync history keeps that path: mirror delete removes only what
        // this vault synced (sync/mirror.ts), so a path dropped here would keep
        // its entry for good. A move still waiting to be sent never reached
        // Pensio, so the entry is at the path it came from.
        if (origin) {
            this.pendingRenames.delete(origin);
            this.syncedFiles.delete(oldPath);
            if (tracked) this.syncedFiles.set(origin, tracked);
        }
        if (isIn) this.dirtyFiles.add(file.path);
        this.scheduleSyncFromWatcher();
    }

    /** The bulk payload for a note, as the server's create/update/rename read it. */
    private buildData(
        file: TFile,
        parsed: ParsedMarkdown,
    ): { kind: 'person'; data: CreatePersonRequest } | { kind: 'entry'; data: CreateEntryRequest } {
        const contentType = this.detectContentType(file.path);
        if (contentType === 'person') {
            return {
                kind: 'person',
                data: {
                    // No `aliases` key, deliberately. The backend reads
                    // `aliases:` out of the note's own frontmatter, the
                    // way it already reads relationship and birthday —
                    // and this sent a hardcoded `[]` with every note it
                    // re-sends, which EMPTIED aliases typed in the web
                    // UI on the next sync. The field a note does not
                    // speak for is a field this payload leaves out.
                    name: parsed.title || file.basename,
                    person_note_path: file.path,
                    relationship: '',
                    birthday: null,
                    tags: [],
                    from_locations: [],
                    lived_in: [],
                    metadata: { raw_content: parsed.content },
                },
            };
        }
        const entryDate = parsed.date
            || extractDateFromFilename(file.name)
            || new Date(file.stat.ctime).toISOString().slice(0, 10);
        return {
            kind: 'entry',
            data: {
                title: parsed.title || file.basename,
                content_html: parsed.content,
                content_plain: parsed.content,
                entry_date: entryDate,
                entry_type: parsed.entryType || contentType,
                file_path: file.path,
                frontmatter: {},
                file_modified_at: new Date(file.stat.mtime).toISOString(),
            },
        };
    }

    /**
     * Send the queued moves. ⭐ **AN OLDER SERVER IS KNOWN BY WHAT IT ANSWERS**,
     * never by an error message — those are translated. A server that can move a
     * row says `capabilities.rename` on every bulk answer; one that cannot
     * refuses the item and says nothing, and the note falls back to delete +
     * create (decided 2026-10-20). A server that CAN rename and still refuses
     * gets the note synced where it is now and nothing deleted.
     */
    private async processRenames(): Promise<void> {
        const moves = Array.from(this.pendingRenames.entries());
        this.pendingRenames.clear();

        const entryItems: BulkSyncItem[] = [];
        const peopleItems: BulkSyncItem[] = [];
        const sent = new Map<string, { file: TFile; hash: string }>();

        for (const [from, to] of moves) {
            const file = this.app.vault.getAbstractFileByPath(to);
            if (!(file instanceof TFile)) continue; // moved again or gone before this ran
            try {
                const content = await this.app.vault.read(file);
                const hash = await computeContentHash(content);
                const built = this.buildData(file, parseMarkdown(content));
                const item: BulkSyncItem = { action: 'rename', file_path: from, new_file_path: to, data: built.data };
                if (tooLargeAlone(itemBytes(item))) {
                    this.moveNotSent(from, to); // the loop finds it too large, and says so
                    continue;
                }
                (built.kind === 'person' ? peopleItems : entryItems).push(item);
                sent.set(from, { file, hash });
            } catch (error) {
                console.error(`Failed to prepare rename ${from} → ${to}:`, error);
                this.dirtyFiles.add(to);
            }
        }

        // ⛔ Before 0.7.3 every move went in ONE request: moving a folder of
        // long notes made a body Pensio refuses, and the moves were queued
        // again, to fail the same way every sync (review CRIT-4).
        const send = async (items: BulkSyncItem[], section: Section): Promise<void> => {
            const done = new Set<BulkSyncItem>();
            try {
                await sendInChunks(items, {
                    post: chunk => this.reached(section === 'people'
                        ? this.apiClient.bulkSync([], chunk) : this.apiClient.bulkSync(chunk, [])),
                    answered: (chunk, result) => {
                        chunk.forEach(item => done.add(item));
                        this.renamesAnswered(chunk, result, section, sent);
                    },
                    refused: item => {
                        done.add(item);
                        if (item.new_file_path) this.moveNotSent(item.file_path, item.new_file_path);
                    },
                });
            } catch (error) {
                console.error('Bulk rename failed:', error);
                for (const item of items) {
                    if (!done.has(item) && item.new_file_path) this.pendingRenames.set(item.file_path, item.new_file_path);
                }
            }
        };

        await send(entryItems, 'entries');
        await send(peopleItems, 'people');
    }

    /**
     * A move that will not be sent: the note is too large to sync where it is
     * now (sync/tooLarge.ts). Pensio still has its entry at `from`, so the
     * history says `from` (0.7.2: the history names the path Pensio has, which
     * is what lets mirror delete find it), and the loop finds the note at `to`
     * too large and says so.
     */
    private moveNotSent(from: string, to: string): void {
        const tracked = this.syncedFiles.get(to);
        this.syncedFiles.delete(to);
        if (tracked) this.syncedFiles.set(from, tracked);
        this.dirtyFiles.add(to);
    }

    /** What Pensio did with one request of moves (see processRenames). */
    private renamesAnswered(
        items: BulkSyncItem[], result: BulkSyncResponse, section: Section,
        sent: Map<string, { file: TFile; hash: string }>,
    ): void {
        this.captureProcessingStatus(result.processing_status);
        const refused = new Set(result[section].errors.map((err: { file_path: string }) => err.file_path));
        const canRename = result.capabilities?.rename === true;
        for (const item of items) {
            const info = sent.get(item.file_path);
            if (!info) continue;
            const failed = refused.has(item.file_path) ||
                (item.new_file_path !== undefined && refused.has(item.new_file_path));
            if (!failed) {
                this.updateFileTracking(info.file, info.hash);
                continue;
            }
            this.removeFileTracking(info.file.path);
            this.dirtyFiles.add(info.file.path);
            if (!canRename) {
                this.pendingDeletes.add(item.file_path);
            }
        }
    }

    /**
     * Schedule a syncAll after a short debounce, so rapid edits batch together.
     */
    private scheduleSyncFromWatcher(): void {
        if (this.watcherSyncTimer) {
            window.clearTimeout(this.watcherSyncTimer);
        }
        this.watcherSyncTimer = window.setTimeout(() => {
            void (async () => {
                this.watcherSyncTimer = null;
                if (this.isSyncing) {
                    debugLog('Watcher sync deferred — sync already in progress');
                    return;
                }
                if (this.apiClient.isAuthInvalidated()) {
                    debugLog('Watcher sync skipped — auth invalidated');
                    return;
                }
                try {
                    await this.syncAll(false);
                } catch (error) {
                    console.error('Watcher-triggered sync failed:', error);
                    this.onSyncFailed?.(error);
                }
            })();
        }, this.WATCHER_SYNC_DEBOUNCE_MS);
    }

    /**
     * Mark a file dirty so it's included in the next syncAll.
     * Used by the sync-current-file command.
     */
    markDirty(filePath: string): void {
        this.dirtyFiles.add(filePath);
    }

    // ========================================================================
    // File classification
    // ========================================================================

    shouldSyncFile(file: TFile): boolean {
        return this.isSyncedPath(file.path);
    }

    /** The folder rule, on a path — so a rename's old path can be judged too. */
    private isSyncedPath(path: string): boolean {
        if (!path.endsWith('.md')) return false;

        const inJournalFolder = this.settings.journalFolders.some(mapping =>
            mapping.folder.trim().length > 0 &&
            path.startsWith(mapping.folder + '/')
        );
        if (inJournalFolder) return true;

        if (this.settings.peopleFolder.trim().length > 0) {
            if (path.startsWith(this.settings.peopleFolder + '/')) {
                return true;
            }
        }

        return false;
    }

    /**
     * The files to sync: the ones inside the configured folders, and nothing
     * else.
     *
     * ⭐ Walks only those folders instead of listing the whole vault and
     * filtering it: the plugin never needs a path outside them, and the
     * Community plugin review reports a whole-vault listing as access to every
     * file path in the vault. `shouldSyncFile` is still the rule — this only
     * stops asking for paths it would refuse.
     *
     * ⛔ Mirror delete removes a server entry whose file is missing from this
     * list, so it must hold every file the old `getMarkdownFiles()` filter
     * held. A folder is looked up by its setting exactly as `shouldSyncFile`
     * compares it (untrimmed), and a file in two configured folders (one
     * nested in the other) is listed once. 🧪 `folderScopedReads.test.ts`
     * compares the two on the same vault.
     */
    private filesInSyncFolders(): TFile[] {
        const roots = [
            ...this.settings.journalFolders.map(mapping => mapping.folder),
            this.settings.peopleFolder,
        ].filter(folder => folder.trim().length > 0);

        const files: TFile[] = [];
        const seen = new Set<string>();
        const walk = (folder: TFolder): void => {
            for (const child of folder.children) {
                if (child instanceof TFolder) {
                    walk(child);
                } else if (child instanceof TFile && !seen.has(child.path) && this.shouldSyncFile(child)) {
                    seen.add(child.path);
                    files.push(child);
                }
            }
        };
        for (const root of roots) {
            const folder = this.app.vault.getFolderByPath(root);
            if (folder) walk(folder);
        }
        return files;
    }

    private detectContentType(filePath: string): string {
        if (this.settings.peopleFolder &&
            filePath.startsWith(this.settings.peopleFolder + '/')) {
            return 'person';
        }

        return 'daily_journal';
    }

    // ========================================================================
    // Sync tracking & state persistence
    // ========================================================================

    private updateFileTracking(file: TFile, hash: string): void {
        this.syncedFiles.set(file.path, { mtime: file.stat.mtime, hash });
    }

    private removeFileTracking(filePath: string): void {
        this.syncedFiles.delete(filePath);
    }

    restoreState(state: SyncStateData): void {
        this.userId = state.userId ?? null;
        this.lastSyncTime = state.lastSyncTime;
        this.lastQuotaNoticeDay = state.lastQuotaNoticeDay ?? null;
        // Rebuild the tracking map with explicit types so the entries never
        // widen to `any` under a minimal DOM/ES lib (Object.entries needs
        // ES2017 typings the review bot's checker may not resolve).
        const restored = new Map<string, SyncedFileInfo>();
        for (const path of Object.keys(state.files)) {
            const info: SyncedFileInfo = state.files[path];
            restored.set(path, { mtime: info.mtime, hash: info.hash });
        }
        this.syncedFiles = restored;
        this.tooLarge.restore(state.tooLarge);
        debugLog(
            `Restored sync state: ${this.syncedFiles.size} tracked files, ` +
            `userId=${this.userId || 'none'}, ` +
            `lastSync=${state.lastSyncTime ? new Date(state.lastSyncTime).toISOString() : 'never'}`
        );
    }

    getTrackedFileCount(): number {
        return this.syncedFiles.size;
    }

    /** When the last sync with nothing failing finished (ms), or null. */
    getLastSyncTime(): number | null {
        return this.lastSyncTime;
    }

    /** The notes too large to sync, by path (sync/tooLarge.ts). */
    getTooLargeNotes(): string[] {
        return this.tooLarge.paths();
    }

    getState(): SyncStateData {
        const files: Record<string, SyncedFileInfo> = {};
        for (const [path, info] of this.syncedFiles) {
            files[path] = { hash: info.hash, mtime: info.mtime };
        }
        return {
            userId: this.userId,
            lastSyncTime: this.lastSyncTime,
            files,
            lastQuotaNoticeDay: this.lastQuotaNoticeDay,
            tooLarge: this.tooLarge.toState(),
        };
    }

    clearState(): void {
        debugLog('Clearing sync state (account switch or logout)');
        this.userId = null;
        this.lastSyncTime = null;
        this.syncedFiles.clear();
        this.tooLarge.clear();
        // A different account has a different tier and quota — the previous
        // account's "already told them today" must not silence the new one.
        this.lastProcessingStatus = null;
        this.lastQuotaNoticeDay = null;
    }

    /** Last known emotion-analysis quota, or null if never reported. */
    getLastProcessingStatus(): ProcessingStatus | null {
        return this.lastProcessingStatus;
    }

    /** UTC day the quota notice was last shown, for once-a-day deduping. */
    getLastQuotaNoticeDay(): string | null {
        return this.lastQuotaNoticeDay;
    }

    /** Record that the quota notice was shown today, and persist it. */
    markQuotaNoticeShown(day: string): void {
        this.lastQuotaNoticeDay = day;
        void this.persistState();
    }

    /**
     * Remember the quota reported by one bulk chunk.
     *
     * Absent on older/self-hosted backends — keep the previous value rather
     * than clobbering it with null, so an upgraded server that stops
     * answering mid-sync does not erase what we already knew.
     */
    private captureProcessingStatus(status?: ProcessingStatus): void {
        if (status) {
            this.lastProcessingStatus = status;
        }
    }

    /** Hand the freshest quota reading to whoever is listening. */
    private notifyProcessingStatus(): void {
        if (this.lastProcessingStatus && this.onProcessingStatus) {
            try {
                this.onProcessingStatus(this.lastProcessingStatus);
            } catch (error) {
                console.error('Processing-status handler failed:', error);
            }
        }
    }

    setUserId(userId: string): void {
        this.userId = userId;
    }

    getUserId(): string | null {
        return this.userId;
    }

    private async persistState(): Promise<void> {
        try {
            await this.onSaveState(this.getState());
            debugLog('Sync state persisted:', this.syncedFiles.size, 'files');
        } catch (error) {
            console.error('Failed to persist sync state:', error);
        }
    }

    private debouncedPersistState(): void {
        if (this.stateSaveTimer) {
            window.clearTimeout(this.stateSaveTimer);
        }
        this.stateSaveTimer = window.setTimeout(() => {
            void (async () => {
                await this.persistState();
                this.stateSaveTimer = null;
            })();
        }, this.STATE_SAVE_DEBOUNCE_MS);
    }

    // ========================================================================
    // syncAll — the single sync path
    // ========================================================================

    /**
     * Sync now. `asked` is true when she pressed something (a command, Sync
     * now): only then may mirror delete run before its hour is up.
     *
     * ⭐ A second call while a sync runs gets THAT sync's result. Before 0.7.1
     * it got "0 synced, 0 unchanged" at once, which read as a success and
     * cleared a problem on screen (review F33).
     */
    syncAll(forceSync: boolean = false, options: { asked?: boolean } = {}): Promise<SyncResult> {
        if (this.apiClient.isAuthInvalidated()) {
            return Promise.reject(new RefreshError('auth-invalid', 'Pensio session expired \u2014 reconnect in the plugin settings'));
        }
        if (this.current) {
            debugLog('syncAll joined the sync already in progress');
            return this.current;
        }
        this.current = this.runSync(forceSync, options.asked === true).finally(() => {
            this.current = null;
        });
        return this.current;
    }

    private async runSync(forceSync: boolean, asked: boolean): Promise<SyncResult> {
        this.isSyncing = true;
        this.contacted = false;
        this.tooLarge.begin();

        try {
            debugLog(forceSync
                ? 'Starting force sync (re-checking all files, hash dedup active)'
                : 'Starting incremental sync');

            const syncStartTime = Date.now();

            // Renames first — an older server's fallback queues a delete, which
            // the next step sends, and a create, which the loop below sends.
            if (this.pendingRenames.size > 0) {
                await this.processRenames();
            }

            // Then pending deletes
            if (this.pendingDeletes.size > 0) {
                await this.processDeletes();
            }

            // Collect files to sync
            const filesToSync = this.filesInSyncFolders();
            debugLog(`Found ${filesToSync.length} files to check`);

            const errors: string[] = [];
            // The first request that failed outright, so the notice can say why.
            let underlying: unknown;
            const entryItems: BulkSyncItem[] = [];
            const peopleItems: BulkSyncItem[] = [];
            const trackingDeferred = new Map<string, { file: TFile; hash: string }>();
            let skippedCount = 0;

            for (const file of filesToSync) {
                try {
                    // Incremental mode: skip unchanged files unless dirty
                    if (!forceSync && !this.dirtyFiles.has(file.path)) {
                        const trackedFile = this.syncedFiles.get(file.path);
                        if (trackedFile && file.stat.mtime === trackedFile.mtime) {
                            skippedCount++;
                            continue;
                        }
                    }
                    // Too large when last read, and not edited since: still is.
                    if (this.tooLarge.unchanged(file.path, file.stat.mtime)) continue;

                    const content = await this.app.vault.read(file);
                    const hash = await computeContentHash(content);

                    // Hash-based dedup: skip if content unchanged
                    const tracked = this.syncedFiles.get(file.path);
                    if (tracked && tracked.hash === hash) {
                        skippedCount++;
                        this.syncedFiles.set(file.path, { hash, mtime: file.stat.mtime });
                        continue;
                    }

                    const built = this.buildData(file, parseMarkdown(content));
                    const item: BulkSyncItem = { action: 'create', file_path: file.path, data: built.data };
                    // ⭐ A warning about this note, not a failed sync (review CRIT-4).
                    const bytes = itemBytes(item);
                    if (tooLargeAlone(bytes)) {
                        this.tooLarge.add(file.path, file.stat.mtime, bytes);
                        continue;
                    }
                    (built.kind === 'person' ? peopleItems : entryItems).push(item);

                    trackingDeferred.set(file.path, { file, hash });
                } catch (error) {
                    console.error(`Failed to prepare ${file.path}:`, error);
                    errors.push(`${file.path}: ${(error as Error).message || error}`);
                }
            }

            // Clear dirty set — we've processed all files
            this.dirtyFiles.clear();

            if (skippedCount > 0) {
                debugLog(`Skipped ${skippedCount} unchanged files (hash dedup)`);
            }
            debugLog(`Syncing ${entryItems.length} entries + ${peopleItems.length} people`);

            // ⛔ The first request that fails outright (offline, a 429, a dead
            // session, a server error) ends the sync: every later one would
            // fail the same way, and each one cost a request and a token
            // refresh, about 39 refreshes a run for a 600-note first sync,
            // every 5 minutes, into the very limit that refused it (review F20).
            // ⭐ Requests are sized in bytes, not notes (sync/chunks.ts).
            let halted = false;
            const sections: [Section, BulkSyncItem[]][] = [['entries', entryItems], ['people', peopleItems]];
            for (const [section, items] of sections) {
                if (halted) break;
                try {
                    await sendInChunks(items, {
                        post: chunk => this.reached(section === 'people'
                            ? this.apiClient.bulkSync([], chunk) : this.apiClient.bulkSync(chunk, [])),
                        answered: (chunk, result) => {
                            this.captureProcessingStatus(result.processing_status);
                            debugLog(`Bulk ${section}: ${chunk.length} sent, ` +
                                `${result[section].created} created, ${result[section].updated} updated`);
                            const errorPaths = new Set(result[section].errors.map(err => err.file_path));
                            for (const err of result[section].errors) {
                                const errMsg = typeof err.error === 'object' ? JSON.stringify(err.error) : err.error;
                                errors.push(`${err.file_path}: ${errMsg}`);
                            }
                            for (const item of chunk) {
                                const info = trackingDeferred.get(item.file_path);
                                if (info && !errorPaths.has(item.file_path)) this.updateFileTracking(info.file, info.hash);
                            }
                        },
                        // The server's own limit is lower than the one the
                        // plugin knows: this note is too large there.
                        refused: item => {
                            const info = trackingDeferred.get(item.file_path);
                            trackingDeferred.delete(item.file_path);
                            if (info) this.tooLarge.add(item.file_path, info.file.stat.mtime, itemBytes(item));
                        },
                    });
                } catch (error) {
                    console.error(`Bulk ${section} sync failed:`, error);
                    underlying ??= error;
                    halted = true;
                    errors.push(`Bulk sync chunk: ${(error as Error).message || error}`);
                }
            }
            this.tooLarge.finish();

            // Mirror delete
            if (!halted && this.mirrorAllowed(asked, filesToSync)) {
                try {
                    this.lastMirrorAt = Date.now();
                    await this.mirrorDelete(filesToSync);
                } catch (error) {
                    console.error('Mirror delete failed:', error);
                    underlying ??= error;
                    errors.push(`Mirror delete: ${(error as Error).message || error}`);
                }
            }

            const syncedCount = trackingDeferred.size;
            debugLog('Sync completed');

            // Nothing was sent, and something on screen wants to know whether
            // Pensio answers: ask it, once.
            if (!this.contacted && errors.length === 0 && this.needsContact?.()) {
                await this.reached(this.apiClient.getSyncStatus());
            }

            if (errors.length === 0) {
                this.foldersAtLastSync = this.folderSettings();
                // Only a sync Pensio answered is a sync: "synced just now"
                // must not appear after one that sent nothing.
                if (this.contacted) this.lastSyncTime = syncStartTime;
                debugLog('Sync complete — tracking', this.syncedFiles.size, 'files');
            }

            await this.persistState();

            // Report the quota before any error throw — a sync that failed on
            // a few files still learned whether the account is capped.
            this.notifyProcessingStatus();

            if (errors.length > 0) {
                throw new SyncFailure(errors, underlying);
            }
            this.onSyncSucceeded?.(this.contacted);

            // Return summary for callers that want to show results
            return {
                synced: syncedCount, skipped: skippedCount, errors: errors.length,
                total: filesToSync.length, contacted: this.contacted,
                tooLarge: this.tooLarge.paths(),
            };
        } finally {
            this.isSyncing = false;
        }
    }

    /** Pensio answered this request: the sync has been in touch. */
    private async reached<T>(request: Promise<T>): Promise<T> {
        const answer = await request;
        this.contacted = true;
        return answer;
    }

    /** The folder settings a sync walks, as one comparable value. */
    private folderSettings(): string {
        return JSON.stringify([this.settings.journalFolders.map(m => m.folder), this.settings.peopleFolder]);
    }

    /**
     * Whether this sync may run mirror delete: never when `mirrorSkip` says
     * so, and by itself at most once an hour (`MIRROR_INTERVAL_MS`).
     */
    private mirrorAllowed(asked: boolean, filesToSync: TFile[]): boolean {
        const skip = mirrorSkip({
            enabled: this.settings.enableMirrorDelete,
            seen: filesToSync,
            foldersChanged: this.folderSettings() !== this.foldersAtLastSync,
            roots: [...this.settings.journalFolders.map(m => m.folder), this.settings.peopleFolder]
                .filter(folder => folder.trim().length > 0),
            folderExists: root => this.app.vault.getFolderByPath(root) !== null,
            tracked: [...this.syncedFiles.keys()],
        });
        if (skip && this.settings.enableMirrorDelete) debugLog(`Mirror delete skipped: ${skip}`);
        return skip === null && (asked || Date.now() - this.lastMirrorAt >= this.MIRROR_INTERVAL_MS);
    }

    // ========================================================================
    // Delete handling
    // ========================================================================

    /**
     * Send the deletes of notes deleted while the plugin ran, by path, in
     * both sections (see `deleteItems`), and only then drop each path from
     * the history. A request that fails keeps the rest queued for the next
     * sync, and in the history, where mirror delete can find them too.
     */
    private async processDeletes(): Promise<void> {
        const paths = Array.from(this.pendingDeletes);
        this.pendingDeletes.clear();

        for (let i = 0; i < paths.length; i += MIRROR_CHUNK) {
            const chunk = paths.slice(i, i + MIRROR_CHUNK);
            const items = deleteItems(chunk);
            try {
                const result = await this.reached(this.apiClient.bulkSync(items, items));
                debugLog(`Deleted ${result.entries.deleted} entries, ${result.people.deleted} people`);
                for (const path of chunk) this.removeFileTracking(path);
            } catch (error) {
                console.error('Bulk delete failed:', error);
                for (const path of paths.slice(i)) this.pendingDeletes.add(path);
                return;
            }
        }
    }

    // ========================================================================
    // Mirror delete
    // ========================================================================

    /**
     * Delete the entries of notes this vault synced and no longer sees
     * (sync/mirror.ts). A request that fails stops it and fails the sync;
     * what it did not reach stays in the history and is tried next time.
     */
    private async mirrorDelete(localFiles: TFile[]): Promise<void> {
        const gone = goneNotes(this.syncedFiles.keys(), localFiles);
        for (let i = 0; i < gone.length; i += MIRROR_CHUNK) {
            const paths = gone.slice(i, i + MIRROR_CHUNK);
            const items = deleteItems(paths);
            const result = await this.reached(this.apiClient.bulkSync(items, items));
            debugLog(`Mirror delete: ${result.entries.deleted} entries, ${result.people.deleted} people`);
            // Answered: Pensio has no entry at these paths now, so a note
            // that comes back is sent again.
            for (const path of paths) this.removeFileTracking(path);
        }
    }
}
