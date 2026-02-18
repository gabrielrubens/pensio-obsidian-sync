import { App, TAbstractFile, TFile } from 'obsidian';
import { ApiClient } from '../api/client';
import { debugLog } from '../logger';
import { BulkSyncItem, CreateEntryRequest, CreatePersonRequest, PensioSettings, SyncedFileInfo, SyncQueueItem, SyncStateData } from '../types';
import { computeContentHash } from './hash';
import { extractDateFromFilename, parseMarkdown } from './parser';

/**
 * Sync engine handles file watching and syncing with the API
 */
export class SyncEngine {
    private app: App;
    private settings: PensioSettings;
    private apiClient: ApiClient;
    private syncQueue: SyncQueueItem[] = [];
    private isWatching = false;
    private isSyncing = false;
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    private recentDeletes: Map<string, { name: string, timestamp: number }> = new Map();
    private syncIntervalTimer: NodeJS.Timeout | null = null;
    private readonly DEBOUNCE_MS = 1000; // Wait 1 second before syncing
    private readonly RENAME_DETECTION_MS = 5000; // Track deletes for 5 seconds
    private readonly MAX_ENTRY_SIZE_MB = 1; // Max file size for sync (1MB)
    private readonly SYNC_INTERVAL_MS = 5 * 60 * 1000; // Periodic sync every 5 minutes
    private readonly INITIAL_SYNC_DELAY_MS = 5000; // Wait 5 seconds for vault to index
    private readonly STATE_SAVE_DEBOUNCE_MS = 5000; // Debounce state persistence (5s)

    // Incremental sync tracking (persisted via onSaveState callback)
    private lastSyncTime: number | null = null;
    private syncedFiles: Map<string, SyncedFileInfo> = new Map();
    private stateSaveTimer: NodeJS.Timeout | null = null;

    // Bind handlers once to preserve reference for cleanup
    private readonly boundOnFileCreated: (file: TAbstractFile) => Promise<void>;
    private readonly boundOnFileModified: (file: TAbstractFile) => Promise<void>;
    private readonly boundOnFileDeleted: (file: TAbstractFile) => Promise<void>;

    constructor(
        app: App,
        settings: PensioSettings,
        apiClient: ApiClient,
        private onSaveState: (state: SyncStateData) => Promise<void> = async () => { }
    ) {
        this.app = app;
        this.settings = settings;
        this.apiClient = apiClient;

        // Bind event handlers once
        this.boundOnFileCreated = this.onFileCreated.bind(this);
        this.boundOnFileModified = this.onFileModified.bind(this);
        this.boundOnFileDeleted = this.onFileDeleted.bind(this);
    }

    /**
     * Start watching for file changes
     */
    startWatching(): void {
        if (this.isWatching) return;

        debugLog('Starting file watcher for auto-sync');
        this.isWatching = true;

        // Register event handlers
        this.app.vault.on('create', this.boundOnFileCreated);
        this.app.vault.on('modify', this.boundOnFileModified);
        this.app.vault.on('delete', this.boundOnFileDeleted);
    }

    /**
     * Stop watching for file changes and periodic sync
     */
    stopWatching(): void {
        if (!this.isWatching) return;

        debugLog('Stopping file watcher and periodic sync');
        this.isWatching = false;

        // Clear periodic sync timer
        if (this.syncIntervalTimer) {
            clearInterval(this.syncIntervalTimer);
            this.syncIntervalTimer = null;
        }

        // Flush pending state save
        if (this.stateSaveTimer) {
            clearTimeout(this.stateSaveTimer);
            this.stateSaveTimer = null;
            this.persistState();
        }

        // Unregister event handlers
        this.app.vault.off('create', this.boundOnFileCreated);
        this.app.vault.off('modify', this.boundOnFileModified);
        this.app.vault.off('delete', this.boundOnFileDeleted);
    }

    /**
     * Start auto-sync: initial sync after delay + periodic sync every 5 minutes.
     * Called from main.ts on plugin load and after settings change.
     */
    startAutoSync(): void {
        // Wait for vault to finish indexing before initial sync
        setTimeout(async () => {
            if (!this.isWatching) return; // Stopped before timer fired
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

        // Set up periodic sync (every 5 minutes)
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

    /**
     * Handle file creation
     */
    private async onFileCreated(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile)) return;
        if (!this.shouldSyncFile(file)) return;

        debugLog('File created:', file.path);

        // Check if this is a rename (file with similar name was recently deleted)
        const wasRenamed = this.checkForRename(file);
        if (wasRenamed) {
            debugLog('Detected rename, will update existing record');
            // Treat as update, not create
            this.debounceSync(file.path, 'update');
        } else {
            this.debounceSync(file.path, 'create');
        }
    }

    /**
     * Handle file modification
     */
    private async onFileModified(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile)) return;
        if (!this.shouldSyncFile(file)) return;

        debugLog('File modified:', file.path);
        this.debounceSync(file.path, 'update');
    }

    /**
     * Handle file deletion
     */
    private async onFileDeleted(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile)) return;
        if (!this.shouldSyncFile(file)) return;

        debugLog('File deleted:', file.path);

        // Remove from incremental sync tracking
        this.removeFileTracking(file.path);

        // Track this deletion for rename detection
        const fileName = this.extractBaseName(file.path);
        this.recentDeletes.set(file.path, {
            name: fileName,
            timestamp: Date.now()
        });

        // Clean up old tracked deletes after RENAME_DETECTION_MS
        setTimeout(() => {
            this.recentDeletes.delete(file.path);
        }, this.RENAME_DETECTION_MS);

        this.debounceSync(file.path, 'delete');
    }

    /**
     * Check if a newly created file is actually a rename
     */
    private checkForRename(newFile: TFile): boolean {
        const newFileName = this.extractBaseName(newFile.path);
        const now = Date.now();

        // Check if any recently deleted file has a similar name
        for (const [deletedPath, info] of this.recentDeletes.entries()) {
            // Check if deletion was recent
            if (now - info.timestamp > this.RENAME_DETECTION_MS) {
                this.recentDeletes.delete(deletedPath);
                continue;
            }

            // Same folder and similar name suggests rename
            const newFolder = this.getParentFolder(newFile.path);
            const deletedFolder = this.getParentFolder(deletedPath);

            if (newFolder === deletedFolder) {
                // Check if names are similar (might be numbered versions)
                // Or if they're in the same category (both are people files)
                const similarName = this.areSimilarNames(info.name, newFileName);
                if (similarName) {
                    // Remove from recent deletes
                    this.recentDeletes.delete(deletedPath);
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Extract base name without extension and numbering
     */
    private extractBaseName(filePath: string): string {
        const fileName = filePath.split('/').pop() || '';
        // Remove .md extension
        const withoutExt = fileName.replace(/\.md$/, '');
        // Remove trailing numbers like _2, _3, etc.
        return withoutExt.replace(/_\d+$/, '');
    }

    /**
     * Get parent folder of a file path
     */
    private getParentFolder(filePath: string): string {
        const parts = filePath.split('/');
        parts.pop(); // Remove filename
        return parts.join('/');
    }

    /**
     * Check if two names are similar (for rename detection)
     */
    private areSimilarNames(name1: string, name2: string): boolean {
        // Exact match after removing numbers
        if (name1 === name2) return true;

        // Levenshtein distance for fuzzy matching
        // For now, just check if one contains the other
        const lower1 = name1.toLowerCase();
        const lower2 = name2.toLowerCase();

        return lower1.includes(lower2) || lower2.includes(lower1);
    }

    /**
     * Debounce sync to prevent duplicate events
     */
    private debounceSync(filePath: string, action: 'create' | 'update' | 'delete'): void {
        // Clear existing timer for this file
        const existingTimer = this.debounceTimers.get(filePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // Set new timer
        const timer = setTimeout(() => {
            this.addToQueue(filePath, action);
            this.processQueue();
            this.debounceTimers.delete(filePath);
        }, this.DEBOUNCE_MS);

        this.debounceTimers.set(filePath, timer);
    }

    /**
     * Check if file should be synced
     */
    private shouldSyncFile(file: TFile): boolean {
        // Must be markdown
        if (!file.path.endsWith('.md')) return false;

        // Check journal folders
        const inJournalFolder = this.settings.journalFolders.some(mapping =>
            mapping.folder.trim().length > 0 &&
            (file.path.startsWith(mapping.folder + '/') || file.path === mapping.folder)
        );
        if (inJournalFolder) return true;

        // Check people folder
        if (this.settings.peopleFolder.trim().length > 0) {
            if (file.path.startsWith(this.settings.peopleFolder + '/') || file.path === this.settings.peopleFolder) {
                return true;
            }
        }

        return false;
    }

    /**
     * Check if file needs syncing based on content hash.
     * Fast path: skip if mtime unchanged.
     * Slow path: compute SHA-256 hash and compare with stored hash.
     */
    private async needsSync(file: TFile): Promise<boolean> {
        const tracked = this.syncedFiles.get(file.path);
        if (!tracked) {
            return true;  // New file, never synced
        }

        // Fast path: mtime unchanged → content unchanged
        if (file.stat.mtime === tracked.mtime) {
            return false;
        }

        // mtime changed — compute hash to verify content actually changed
        const content = await this.app.vault.read(file);
        const hash = await computeContentHash(content);
        if (hash === tracked.hash) {
            // Content identical despite mtime change — update mtime tracking
            this.syncedFiles.set(file.path, { hash, mtime: file.stat.mtime });
            return false;
        }

        return true;  // Content truly changed
    }

    /**
     * Update file tracking after successful sync
     */
    private updateFileTracking(file: TFile, hash: string): void {
        this.syncedFiles.set(file.path, {
            mtime: file.stat.mtime,
            hash,
        });
    }

    /**
     * Remove file from tracking
     */
    private removeFileTracking(filePath: string): void {
        this.syncedFiles.delete(filePath);
    }

    // ========================================================================
    // State Persistence
    // ========================================================================

    /**
     * Restore sync state from persisted data (called on plugin load).
     * This is the key defense against re-uploading all files on reload.
     */
    restoreState(state: SyncStateData): void {
        this.lastSyncTime = state.lastSyncTime;
        this.syncedFiles = new Map(
            Object.entries(state.files).map(([path, info]) => [
                path,
                { mtime: info.mtime, hash: info.hash },
            ])
        );
        debugLog(
            `Restored sync state: ${this.syncedFiles.size} tracked files, ` +
            `lastSync=${state.lastSyncTime ? new Date(state.lastSyncTime).toISOString() : 'never'}`
        );
    }

    /**
     * Get current sync state for persistence
     */
    getState(): SyncStateData {
        const files: Record<string, SyncedFileInfo> = {};
        for (const [path, info] of this.syncedFiles) {
            files[path] = { hash: info.hash, mtime: info.mtime };
        }
        return { lastSyncTime: this.lastSyncTime, files };
    }

    /**
     * Persist sync state immediately
     */
    private async persistState(): Promise<void> {
        try {
            await this.onSaveState(this.getState());
            debugLog('Sync state persisted:', this.syncedFiles.size, 'files');
        } catch (error) {
            console.error('Failed to persist sync state:', error);
        }
    }

    /**
     * Debounced state persistence (for file watcher events).
     * Batches rapid file changes into a single disk write.
     */
    private debouncedPersistState(): void {
        if (this.stateSaveTimer) {
            clearTimeout(this.stateSaveTimer);
        }
        this.stateSaveTimer = setTimeout(async () => {
            await this.persistState();
            this.stateSaveTimer = null;
        }, this.STATE_SAVE_DEBOUNCE_MS);
    }

    /**
     * Add item to sync queue
     */
    private addToQueue(filePath: string, action: 'create' | 'update' | 'delete'): void {
        // Remove existing items for this file
        this.syncQueue = this.syncQueue.filter(item => item.filePath !== filePath);

        // Add new item
        this.syncQueue.push({
            filePath,
            action,
            timestamp: Date.now(),
            retryCount: 0
        });
    }

    /**
     * Process sync queue
     */
    private async processQueue(): Promise<void> {
        if (this.isSyncing || this.syncQueue.length === 0) return;

        // Don't process queue if auth is dead
        if (this.apiClient.isAuthInvalidated()) {
            debugLog('Queue processing skipped — auth invalidated');
            this.syncQueue = [];
            return;
        }

        this.isSyncing = true;

        try {
            while (this.syncQueue.length > 0) {
                const item = this.syncQueue.shift();
                if (!item) break;

                try {
                    await this.syncQueueItem(item);
                } catch (error) {
                    console.error(`Failed to sync ${item.filePath}:`, error);

                    // Parse error status
                    const errorStatus = error?.status || 0;

                    // Don't retry auth errors (401) or conflicts (409)
                    if (errorStatus === 401 || errorStatus === 409) {
                        debugLog(`Skipping retry for ${item.filePath} (status ${errorStatus})`);
                        continue;
                    }

                    // Retry logic for network errors
                    if (item.retryCount < 3) {
                        item.retryCount++;
                        this.syncQueue.push(item);
                    }
                }
            }
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * Sync a single queue item
     */
    private async syncQueueItem(item: SyncQueueItem): Promise<void> {
        const { filePath, action } = item;

        if (action === 'delete') {
            await this.deleteFile(filePath);
        } else {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                await this.syncFile(file);
            }
        }
    }

    /**
     * Sync a single file
     * @returns true if file was synced, false if skipped
     */
    async syncFile(file: TFile, forceSync: boolean = false): Promise<boolean> {
        debugLog('Syncing file:', file.path);

        // Read file content and compute hash
        const content = await this.app.vault.read(file);
        const hash = await computeContentHash(content);

        // Hash-based dedup: always check, even on force sync.
        // This is the key safety net — identical content is never re-uploaded.
        const tracked = this.syncedFiles.get(file.path);
        if (tracked && tracked.hash === hash) {
            debugLog('File unchanged (hash match), skipping:', file.path);
            // Update mtime tracking in case it changed
            this.syncedFiles.set(file.path, { hash, mtime: file.stat.mtime });
            return false;
        }

        // Determine content type based on folder
        const contentType = this.detectContentType(file.path);
        debugLog(`Content type detected: ${contentType}`);

        // Parse markdown
        const parsed = parseMarkdown(content);

        // Check file size
        const sizeMB = new Blob([content]).size / (1024 * 1024);
        if (sizeMB > this.MAX_ENTRY_SIZE_MB) {
            throw new Error(`File too large (${sizeMB.toFixed(2)}MB > ${this.MAX_ENTRY_SIZE_MB}MB)`);
        }

        // Sync based on content type
        if (contentType === 'person') {
            await this.syncPerson(file, parsed);
        } else {
            await this.syncEntry(file, parsed, contentType);
        }

        // Update file tracking after successful sync
        this.updateFileTracking(file, hash);
        this.debouncedPersistState();
        return true;
    }

    /**
     * Detect content type based on file path.
     * Returns 'person' for people folder, or the matched entry type string
     * from journalFolders (e.g. 'daily_journal', 'deep_dive').
     */
    private detectContentType(filePath: string): string {
        // Check if in people folder
        if (this.settings.peopleFolder && filePath.startsWith(this.settings.peopleFolder + '/')) {
            return 'person';
        }
        if (this.settings.peopleFolder && filePath === this.settings.peopleFolder) {
            return 'person';
        }

        // Check journal folder mappings — return the matched entry type
        for (const mapping of this.settings.journalFolders) {
            if (mapping.folder.trim().length > 0 &&
                (filePath.startsWith(mapping.folder + '/') || filePath === mapping.folder)) {
                return mapping.entryType;
            }
        }

        // Fallback
        return 'daily_journal';
    }

    /**
     * Sync journal entry
     * @param folderEntryType entry type from folder mapping (e.g. 'daily_journal')
     */
    private async syncEntry(file: TFile, parsed: any, folderEntryType: string): Promise<void> {
        // Resolve entry date: frontmatter → filename → file creation time
        const entryDate = parsed.date
            || extractDateFromFilename(file.name)
            || new Date(file.stat.ctime).toISOString().slice(0, 10);

        // Resolve entry type: frontmatter overrides folder mapping
        const entryType = parsed.entryType || folderEntryType;

        // Plugin sends RAW markdown, backend processes everything
        const entryData: CreateEntryRequest = {
            title: parsed.title || file.basename,
            content_html: parsed.content,  // Raw markdown - backend will render
            content_plain: parsed.content,  // Raw markdown - backend extracts
            entry_date: entryDate,          // Extracted: frontmatter → filename → ctime
            entry_type: entryType,          // Extracted: frontmatter → default
            file_path: file.path,
            frontmatter: {},  // Backend parses frontmatter
            file_modified_at: new Date(file.stat.mtime).toISOString()
        };

        // Check if entry exists
        const existingEntry = await this.apiClient.findEntryByPath(file.path);

        if (existingEntry) {
            // Update existing entry
            await this.apiClient.updateEntry(existingEntry.id, entryData);
            debugLog('Updated entry:', file.path);
        } else {
            // Create new entry
            await this.apiClient.createEntry(entryData);
            debugLog('Created entry:', file.path);
        }
    }

    /**
     * Sync person
     */
    private async syncPerson(file: TFile, parsed: any): Promise<void> {
        // Plugin sends RAW markdown, backend parses frontmatter and extracts fields
        const personName = parsed.title || file.basename;
        const personData: CreatePersonRequest = {
            name: personName,
            aliases: [],  // Backend extracts from frontmatter
            person_note_path: file.path,
            relationship: '',  // Backend extracts from frontmatter
            birthday: null,  // Backend extracts from frontmatter
            tags: [],  // Backend extracts from frontmatter
            from_locations: [],  // Backend extracts from frontmatter
            lived_in: [],  // Backend extracts from frontmatter
            metadata: {
                raw_content: parsed.content  // Backend processes markdown
            }
        };

        // Check if person exists by path OR by name
        let existingPerson = await this.apiClient.findPersonByPath(file.path);
        if (!existingPerson) {
            existingPerson = await this.apiClient.findPersonByName(personName);
        }

        if (existingPerson) {
            // Update existing person
            await this.apiClient.updatePerson(existingPerson.id, personData);
            debugLog('Updated person:', file.path);
        } else {
            // Create new person
            try {
                await this.apiClient.createPerson(personData);
                debugLog('Created person:', file.path);
            } catch (error) {
                // If we get a conflict error, person was created concurrently
                if (error?.status === 409 || error?.message?.includes('duplicate key')) {
                    debugLog('Person already exists (created concurrently):', personName);
                    // Fetch the existing person and update it
                    existingPerson = await this.apiClient.findPersonByName(personName);
                    if (existingPerson) {
                        await this.apiClient.updatePerson(existingPerson.id, personData);
                        debugLog('Updated person after conflict:', file.path);
                    }
                } else {
                    throw error;
                }
            }
        }
    }

    /**
     * Delete file from server
     */
    private async deleteFile(filePath: string): Promise<void> {
        const contentType = this.detectContentType(filePath);

        if (contentType === 'person') {
            const person = await this.apiClient.findPersonByPath(filePath);
            if (person) {
                await this.apiClient.deletePerson(person.id);
                debugLog('Deleted person:', filePath);
            }
        } else {
            const entry = await this.apiClient.findEntryByPath(filePath);
            if (entry) {
                await this.apiClient.deleteEntry(entry.id);
                debugLog('Deleted entry:', filePath);
            }
        }
    }

    /**
     * Sync all files in configured folders using bulk sync API.
     *
     * Batches files into chunks and sends them via the bulk endpoint
     * for much better performance vs individual API calls.
     */
    async syncAll(forceSync: boolean = false): Promise<void> {
        // Abort immediately if auth is dead — no point making API calls
        if (this.apiClient.isAuthInvalidated()) {
            throw new Error('Authentication expired. Please log in again in Pensio settings.');
        }

        debugLog(forceSync
            ? 'Starting force sync (re-checking all files, hash dedup active)'
            : 'Starting incremental sync');

        const syncStartTime = Date.now();
        const files = this.app.vault.getMarkdownFiles();
        const filesToSync = files.filter(file => this.shouldSyncFile(file));

        debugLog(`Found ${filesToSync.length} files to check`);

        // Track errors
        const errors: string[] = [];

        // Separate files into entries and people, read+parse, skip unchanged
        const entryItems: BulkSyncItem[] = [];
        const peopleItems: BulkSyncItem[] = [];
        let skippedCount = 0;

        for (const file of filesToSync) {
            try {
                // Incremental mode: fast-path mtime check (avoids file read)
                if (!forceSync) {
                    const trackedFile = this.syncedFiles.get(file.path);
                    if (trackedFile && file.stat.mtime === trackedFile.mtime) {
                        skippedCount++;
                        continue;
                    }
                }

                // Read file and compute content hash
                const content = await this.app.vault.read(file);
                const hash = await computeContentHash(content);

                // Hash-based dedup: skip if content unchanged (both modes)
                // This is the key safety net — even force sync won't re-upload
                // identical content, preventing unnecessary LLM costs.
                const tracked = this.syncedFiles.get(file.path);
                if (tracked && tracked.hash === hash) {
                    skippedCount++;
                    // Update mtime in tracking (mtime may have changed)
                    this.syncedFiles.set(file.path, { hash, mtime: file.stat.mtime });
                    continue;
                }

                const parsed = parseMarkdown(content);
                const contentType = this.detectContentType(file.path);

                // Check file size
                const sizeMB = new Blob([content]).size / (1024 * 1024);
                if (sizeMB > this.MAX_ENTRY_SIZE_MB) {
                    errors.push(`${file.path}: File too large (${sizeMB.toFixed(2)}MB)`);
                    continue;
                }

                if (contentType === 'person') {
                    const personName = parsed.title || file.basename;
                    peopleItems.push({
                        action: 'create',  // bulk endpoint upserts on create
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
                    // Frontmatter overrides folder mapping
                    const entryType = parsed.entryType || contentType;

                    entryItems.push({
                        action: 'create',  // bulk endpoint upserts on create
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

                // Update tracking after preparing
                this.updateFileTracking(file, hash);
            } catch (error) {
                console.error(`Failed to prepare ${file.path}:`, error);
                errors.push(`${file.path}: ${error.message || error}`);
            }
        }

        if (skippedCount > 0) {
            debugLog(`Skipped ${skippedCount} unchanged files (hash dedup)`);
        }
        debugLog(`Syncing ${entryItems.length} entries + ${peopleItems.length} people`);

        // Send in chunks of BULK_CHUNK_SIZE
        const BULK_CHUNK_SIZE = 50;

        for (let i = 0; i < entryItems.length; i += BULK_CHUNK_SIZE) {
            const chunk = entryItems.slice(i, i + BULK_CHUNK_SIZE);
            try {
                const result = await this.apiClient.bulkSync(chunk, []);
                debugLog(`Bulk entries ${i + 1}-${i + chunk.length}: ` +
                    `${result.entries.created} created, ${result.entries.updated} updated`);
                if (result.entries.errors.length > 0) {
                    for (const err of result.entries.errors) {
                        const errMsg = typeof err.error === 'object'
                            ? JSON.stringify(err.error)
                            : err.error;
                        errors.push(`${err.file_path}: ${errMsg}`);
                    }
                }
            } catch (error) {
                console.error('Bulk entry sync failed:', error);
                errors.push(`Bulk sync chunk: ${error.message || error}`);
            }
        }

        for (let i = 0; i < peopleItems.length; i += BULK_CHUNK_SIZE) {
            const chunk = peopleItems.slice(i, i + BULK_CHUNK_SIZE);
            try {
                const result = await this.apiClient.bulkSync([], chunk);
                debugLog(`Bulk people ${i + 1}-${i + chunk.length}: ` +
                    `${result.people.created} created, ${result.people.updated} updated`);
                if (result.people.errors.length > 0) {
                    for (const err of result.people.errors) {
                        const errMsg = typeof err.error === 'object'
                            ? JSON.stringify(err.error)
                            : err.error;
                        errors.push(`${err.file_path}: ${errMsg}`);
                    }
                }
            } catch (error) {
                console.error('Bulk people sync failed:', error);
                errors.push(`Bulk sync chunk: ${error.message || error}`);
            }
        }

        // Mirror sync: Delete items from server that don't exist locally
        // Only runs when explicitly enabled — protects web-GUI entries
        if (this.settings.enableMirrorDelete) {
            try {
                await this.mirrorDelete(filesToSync);
            } catch (error) {
                console.error('Mirror delete failed:', error);
                errors.push(`Mirror delete: ${error.message || error}`);
            }
        } else {
            debugLog('Mirror delete disabled (enable in settings)');
        }

        debugLog('Full sync completed');

        // Update last sync time after successful sync
        if (errors.length === 0) {
            this.lastSyncTime = syncStartTime;
            debugLog('Sync complete — tracking', this.syncedFiles.size, 'files');
        }

        // Always persist state (even with errors, to save tracking of successful files)
        await this.persistState();

        // Throw error if any failures occurred
        if (errors.length > 0) {
            throw new Error(`Sync completed with ${errors.length} error(s): ${errors[0]}`);
        }
    }

    /**
     * Delete items from server that no longer exist in vault (mirror sync).
     *
     * Safety: Only considers entries/people that have a file_path (i.e.,
     * originated from a file-based source).  Web-GUI entries have
     * file_path=null and are always skipped.
     */
    private async mirrorDelete(localFiles: TFile[]): Promise<void> {
        debugLog('Starting mirror delete');

        // Build set of local file paths for fast lookup
        const localPaths = new Set(localFiles.map(f => f.path));

        try {
            // Get all entries from server
            const serverEntries = await this.apiClient.listEntries();
            for (const entry of serverEntries) {
                // Skip entries without a file_path (web-GUI, quick-capture)
                if (!entry.file_path) continue;

                if (!localPaths.has(entry.file_path)) {
                    debugLog(`Deleting entry not in vault: ${entry.file_path}`);
                    await this.apiClient.deleteEntry(entry.id);
                }
            }

            // Get all people from server
            const serverPeople = await this.apiClient.listPeople();
            for (const person of serverPeople) {
                if (person.person_note_path && !localPaths.has(person.person_note_path)) {
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
