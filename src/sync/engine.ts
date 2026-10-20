import { App, TAbstractFile, TFile, TFolder } from 'obsidian';
import { ApiClient } from '../api/client';
import { debugLog } from '../logger';
import { BulkSyncItem, CreateEntryRequest, CreatePersonRequest, PensioSettings, ProcessingStatus, SyncedFileInfo, SyncStateData } from '../types';
import { computeContentHash } from './hash';
import { extractDateFromFilename, ParsedMarkdown, parseMarkdown } from './parser';

/**
 * Sync engine — watches vault files and syncs to Pensio via bulk API.
 *
 * Architecture: file watcher marks files as "dirty"; all syncing goes
 * through syncAll() which batches dirty files into bulk API calls.
 * This single code path eliminates dual-path bugs and N+1 queries.
 */
export class SyncEngine {
    private app: App;
    private settings: PensioSettings;
    private apiClient: ApiClient;
    private isWatching = false;
    private isSyncing = false;
    private syncIntervalTimer: number | null = null;
    private readonly MAX_ENTRY_SIZE_MB = 1;
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

    startAutoSync(): void {
        window.setTimeout(() => {
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
        this.removeFileTracking(file.path);
        this.dirtyFiles.delete(file.path);
        this.pendingDeletes.add(file.path);
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
        this.syncedFiles.delete(oldPath);
        this.dirtyFiles.delete(oldPath);

        const sameKind = wasIn && isIn &&
            this.detectContentType(oldPath) === this.detectContentType(file.path);
        if (sameKind && (tracked || origin)) {
            if (origin) this.pendingRenames.delete(origin);
            this.pendingRenames.set(origin ?? oldPath, file.path);
            if (tracked) this.syncedFiles.set(file.path, tracked);
        } else if (isIn) {
            this.dirtyFiles.add(file.path);
        }
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
                if (new Blob([content]).size / (1024 * 1024) > this.MAX_ENTRY_SIZE_MB) {
                    this.dirtyFiles.add(to); // the loop reports it as too large
                    continue;
                }
                const hash = await computeContentHash(content);
                const built = this.buildData(file, parseMarkdown(content));
                const item: BulkSyncItem = { action: 'rename', file_path: from, new_file_path: to, data: built.data };
                (built.kind === 'person' ? peopleItems : entryItems).push(item);
                sent.set(from, { file, hash });
            } catch (error) {
                console.error(`Failed to prepare rename ${from} → ${to}:`, error);
                this.dirtyFiles.add(to);
            }
        }

        const send = async (items: BulkSyncItem[], people: boolean): Promise<void> => {
            if (items.length === 0) return;
            let result;
            try {
                result = people
                    ? await this.apiClient.bulkSync([], items)
                    : await this.apiClient.bulkSync(items, []);
            } catch (error) {
                console.error('Bulk rename failed:', error);
                for (const item of items) {
                    if (item.new_file_path) this.pendingRenames.set(item.file_path, item.new_file_path);
                }
                return;
            }
            this.captureProcessingStatus(result.processing_status);
            const section = people ? result.people : result.entries;
            const refused = new Set(section.errors.map((err: { file_path: string }) => err.file_path));
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
        };

        await send(entryItems, false);
        await send(peopleItems, true);
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
        debugLog(
            `Restored sync state: ${this.syncedFiles.size} tracked files, ` +
            `userId=${this.userId || 'none'}, ` +
            `lastSync=${state.lastSyncTime ? new Date(state.lastSyncTime).toISOString() : 'never'}`
        );
    }

    getTrackedFileCount(): number {
        return this.syncedFiles.size;
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
        };
    }

    clearState(): void {
        debugLog('Clearing sync state (account switch or logout)');
        this.userId = null;
        this.lastSyncTime = null;
        this.syncedFiles.clear();
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

    async syncAll(forceSync: boolean = false): Promise<{ synced: number; skipped: number; errors: number; total: number }> {
        if (this.apiClient.isAuthInvalidated()) {
            throw new Error('Authentication expired. Please log in again in Pensio settings.');
        }
        if (this.isSyncing) {
            debugLog('syncAll skipped — already in progress');
            return { synced: 0, skipped: 0, errors: 0, total: 0 };
        }

        this.isSyncing = true;

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

                    const content = await this.app.vault.read(file);
                    const hash = await computeContentHash(content);

                    // Hash-based dedup: skip if content unchanged
                    const tracked = this.syncedFiles.get(file.path);
                    if (tracked && tracked.hash === hash) {
                        skippedCount++;
                        this.syncedFiles.set(file.path, { hash, mtime: file.stat.mtime });
                        continue;
                    }

                    const parsed = parseMarkdown(content);

                    const sizeMB = new Blob([content]).size / (1024 * 1024);
                    if (sizeMB > this.MAX_ENTRY_SIZE_MB) {
                        errors.push(`${file.path}: File too large (${sizeMB.toFixed(2)}MB)`);
                        continue;
                    }

                    const built = this.buildData(file, parsed);
                    (built.kind === 'person' ? peopleItems : entryItems).push({
                        action: 'create',
                        file_path: file.path,
                        data: built.data,
                    });

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

            // Send entries in chunks
            const BULK_CHUNK_SIZE = 50;

            for (let i = 0; i < entryItems.length; i += BULK_CHUNK_SIZE) {
                const chunk = entryItems.slice(i, i + BULK_CHUNK_SIZE);
                try {
                    const result = await this.apiClient.bulkSync(chunk, []);
                    this.captureProcessingStatus(result.processing_status);
                    debugLog(`Bulk entries ${i + 1}-${i + chunk.length}: ` +
                        `${result.entries.created} created, ${result.entries.updated} updated`);

                    const errorPaths = new Set(
                        result.entries.errors.map((err: { file_path: string }) => err.file_path)
                    );
                    for (const err of result.entries.errors) {
                        const errMsg = typeof err.error === 'object'
                            ? JSON.stringify(err.error) : err.error;
                        errors.push(`${err.file_path}: ${errMsg}`);
                    }

                    for (const item of chunk) {
                        if (!errorPaths.has(item.file_path)) {
                            const info = trackingDeferred.get(item.file_path);
                            if (info) {
                                this.updateFileTracking(info.file, info.hash);
                            }
                        }
                    }
                } catch (error) {
                    console.error('Bulk entry sync failed:', error);
                    errors.push(`Bulk sync chunk: ${(error as Error).message || error}`);
                }
            }

            for (let i = 0; i < peopleItems.length; i += BULK_CHUNK_SIZE) {
                const chunk = peopleItems.slice(i, i + BULK_CHUNK_SIZE);
                try {
                    const result = await this.apiClient.bulkSync([], chunk);
                    this.captureProcessingStatus(result.processing_status);
                    debugLog(`Bulk people ${i + 1}-${i + chunk.length}: ` +
                        `${result.people.created} created, ${result.people.updated} updated`);

                    const errorPaths = new Set(
                        result.people.errors.map((err: { file_path: string }) => err.file_path)
                    );
                    for (const err of result.people.errors) {
                        const errMsg = typeof err.error === 'object'
                            ? JSON.stringify(err.error) : err.error;
                        errors.push(`${err.file_path}: ${errMsg}`);
                    }

                    for (const item of chunk) {
                        if (!errorPaths.has(item.file_path)) {
                            const info = trackingDeferred.get(item.file_path);
                            if (info) {
                                this.updateFileTracking(info.file, info.hash);
                            }
                        }
                    }
                } catch (error) {
                    console.error('Bulk people sync failed:', error);
                    errors.push(`Bulk sync chunk: ${(error as Error).message || error}`);
                }
            }

            // Mirror delete
            if (this.settings.enableMirrorDelete) {
                try {
                    await this.mirrorDelete(filesToSync);
                } catch (error) {
                    console.error('Mirror delete failed:', error);
                    errors.push(`Mirror delete: ${(error as Error).message || error}`);
                }
            }

            const syncedCount = trackingDeferred.size;
            debugLog('Sync completed');

            if (errors.length === 0) {
                this.lastSyncTime = syncStartTime;
                debugLog('Sync complete — tracking', this.syncedFiles.size, 'files');
            }

            await this.persistState();

            // Report the quota before any error throw — a sync that failed on
            // a few files still learned whether the account is capped.
            this.notifyProcessingStatus();

            if (errors.length > 0) {
                throw new Error(`Sync completed with ${errors.length} error(s): ${errors[0]}`);
            }

            // Return summary for callers that want to show results
            return { synced: syncedCount, skipped: skippedCount, errors: errors.length, total: filesToSync.length };
        } finally {
            this.isSyncing = false;
        }
    }

    // ========================================================================
    // Delete handling
    // ========================================================================

    private async processDeletes(): Promise<void> {
        const deletePaths = Array.from(this.pendingDeletes);
        this.pendingDeletes.clear();

        const entryDeletes: BulkSyncItem[] = [];
        const peopleDeletes: BulkSyncItem[] = [];

        for (const filePath of deletePaths) {
            const contentType = this.detectContentType(filePath);
            const item: BulkSyncItem = { action: 'delete', file_path: filePath };
            if (contentType === 'person') {
                peopleDeletes.push(item);
            } else {
                entryDeletes.push(item);
            }
        }

        if (entryDeletes.length > 0) {
            try {
                const result = await this.apiClient.bulkSync(entryDeletes, []);
                debugLog(`Deleted ${result.entries.deleted} entries`);
            } catch (error) {
                console.error('Bulk entry delete failed:', error);
            }
        }

        if (peopleDeletes.length > 0) {
            try {
                const result = await this.apiClient.bulkSync([], peopleDeletes);
                debugLog(`Deleted ${result.people.deleted} people`);
            } catch (error) {
                console.error('Bulk people delete failed:', error);
            }
        }
    }

    // ========================================================================
    // Mirror delete
    // ========================================================================

    private async mirrorDelete(localFiles: TFile[]): Promise<void> {
        debugLog('Starting mirror delete');

        const localPaths = new Set(localFiles.map(f => f.path));

        try {
            const serverEntries = await this.apiClient.listEntries();
            for (const entry of serverEntries) {
                if (!entry.file_path) continue;
                if (entry.source !== 'obsidian_plugin') continue;
                if (!localPaths.has(entry.file_path)) {
                    debugLog(`Deleting entry not in vault: ${entry.file_path}`);
                    await this.apiClient.deleteEntry(entry.id);
                }
            }

            const serverPeople = await this.apiClient.listPeople();
            for (const person of serverPeople) {
                if (!person.person_note_path) continue;
                if (person.source !== 'obsidian_plugin') continue;
                if (!localPaths.has(person.person_note_path)) {
                    debugLog(`Deleting person not in vault: ${person.person_note_path}`);
                    await this.apiClient.deletePerson(person.id);
                }
            }

            debugLog('Mirror delete completed');
        } catch (error) {
            console.error('Mirror delete failed:', error);
        }
    }
}
