import { App, TAbstractFile, TFile } from 'obsidian';
import { ApiClient } from '../api/client';
import { debugLog } from '../logger';
import { BulkSyncItem, PensioSettings, SyncedFileInfo, SyncStateData } from '../types';
import { computeContentHash } from './hash';
import { extractDateFromFilename, parseMarkdown } from './parser';

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
    private syncIntervalTimer: NodeJS.Timeout | null = null;
    private readonly MAX_ENTRY_SIZE_MB = 1;
    private readonly SYNC_INTERVAL_MS = 5 * 60 * 1000;
    private readonly INITIAL_SYNC_DELAY_MS = 5000;
    private readonly STATE_SAVE_DEBOUNCE_MS = 5000;
    private readonly WATCHER_SYNC_DEBOUNCE_MS = 3000;

    // Dirty set: files changed by watcher, pending next syncAll
    private dirtyFiles = new Set<string>();
    private pendingDeletes = new Set<string>();
    private watcherSyncTimer: NodeJS.Timeout | null = null;

    // Incremental sync tracking (persisted via onSaveState callback)
    private lastSyncTime: number | null = null;
    private syncedFiles: Map<string, SyncedFileInfo> = new Map();
    private stateSaveTimer: NodeJS.Timeout | null = null;
    private userId: string | null = null;

    // Bind handlers once to preserve reference for cleanup
    private readonly boundOnFileChanged: (file: TAbstractFile) => void;
    private readonly boundOnFileDeleted: (file: TAbstractFile) => void;

    constructor(
        app: App,
        settings: PensioSettings,
        apiClient: ApiClient,
        private onSaveState: (state: SyncStateData) => Promise<void> = async () => { }
    ) {
        this.app = app;
        this.settings = settings;
        this.apiClient = apiClient;

        this.boundOnFileChanged = this.onFileChanged.bind(this);
        this.boundOnFileDeleted = this.onFileDeleted.bind(this);
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
    }

    stopWatching(): void {
        if (!this.isWatching) return;

        debugLog('Stopping file watcher and periodic sync');
        this.isWatching = false;

        if (this.syncIntervalTimer) {
            clearInterval(this.syncIntervalTimer);
            this.syncIntervalTimer = null;
        }
        if (this.watcherSyncTimer) {
            clearTimeout(this.watcherSyncTimer);
            this.watcherSyncTimer = null;
        }
        if (this.stateSaveTimer) {
            clearTimeout(this.stateSaveTimer);
            this.stateSaveTimer = null;
            this.persistState();
        }

        this.app.vault.off('create', this.boundOnFileChanged);
        this.app.vault.off('modify', this.boundOnFileChanged);
        this.app.vault.off('delete', this.boundOnFileDeleted);
    }

    startAutoSync(): void {
        setTimeout(async () => {
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
        }, this.INITIAL_SYNC_DELAY_MS);

        if (this.syncIntervalTimer) {
            clearInterval(this.syncIntervalTimer);
        }
        this.syncIntervalTimer = setInterval(async () => {
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
     * Schedule a syncAll after a short debounce, so rapid edits batch together.
     */
    private scheduleSyncFromWatcher(): void {
        if (this.watcherSyncTimer) {
            clearTimeout(this.watcherSyncTimer);
        }
        this.watcherSyncTimer = setTimeout(async () => {
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
        if (!file.path.endsWith('.md')) return false;

        const inJournalFolder = this.settings.journalFolders.some(mapping =>
            mapping.folder.trim().length > 0 &&
            file.path.startsWith(mapping.folder + '/')
        );
        if (inJournalFolder) return true;

        if (this.settings.peopleFolder.trim().length > 0) {
            if (file.path.startsWith(this.settings.peopleFolder + '/')) {
                return true;
            }
        }

        return false;
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
        this.syncedFiles = new Map(
            Object.entries(state.files).map(([path, info]) => [
                path,
                { mtime: info.mtime, hash: info.hash },
            ])
        );
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
        return { userId: this.userId, lastSyncTime: this.lastSyncTime, files };
    }

    clearState(): void {
        debugLog('Clearing sync state (account switch or logout)');
        this.userId = null;
        this.lastSyncTime = null;
        this.syncedFiles.clear();
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
            clearTimeout(this.stateSaveTimer);
        }
        this.stateSaveTimer = setTimeout(async () => {
            await this.persistState();
            this.stateSaveTimer = null;
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

            // Process pending deletes first
            if (this.pendingDeletes.size > 0) {
                await this.processDeletes();
            }

            // Collect files to sync
            const files = this.app.vault.getMarkdownFiles();
            const filesToSync = files.filter(file => this.shouldSyncFile(file));
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
                    const contentType = this.detectContentType(file.path);

                    const sizeMB = new Blob([content]).size / (1024 * 1024);
                    if (sizeMB > this.MAX_ENTRY_SIZE_MB) {
                        errors.push(`${file.path}: File too large (${sizeMB.toFixed(2)}MB)`);
                        continue;
                    }

                    if (contentType === 'person') {
                        const personName = parsed.title || file.basename;
                        peopleItems.push({
                            action: 'create',
                            file_path: file.path,
                            data: {
                                name: personName,
                                aliases: [],
                                person_note_path: file.path,
                                relationship: '',
                                birthday: null,
                                tags: [],
                                from_locations: [],
                                lived_in: [],
                                metadata: { raw_content: parsed.content },
                            },
                        });
                    } else {
                        const entryDate = parsed.date
                            || extractDateFromFilename(file.name)
                            || new Date(file.stat.ctime).toISOString().slice(0, 10);
                        const entryType = parsed.entryType || contentType;

                        entryItems.push({
                            action: 'create',
                            file_path: file.path,
                            data: {
                                title: parsed.title || file.basename,
                                content_html: parsed.content,
                                content_plain: parsed.content,
                                entry_date: entryDate,
                                entry_type: entryType,
                                file_path: file.path,
                                frontmatter: {},
                                file_modified_at: new Date(file.stat.mtime).toISOString(),
                            },
                        });
                    }

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
