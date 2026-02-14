import { App, TAbstractFile, TFile } from 'obsidian';
import { ApiClient } from '../api/client';
import { CreateEntryRequest, CreatePersonRequest, CreatePromptRequest, PensioSettings, SyncQueueItem } from '../types';
import { parseMarkdown } from './parser';

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
    private readonly DEBOUNCE_MS = 1000; // Wait 1 second before syncing
    private readonly RENAME_DETECTION_MS = 5000; // Track deletes for 5 seconds

    // Incremental sync tracking
    private lastSyncTime: number | null = null;
    private syncedFiles: Map<string, { mtime: number, hash: string }> = new Map();

    // Bind handlers once to preserve reference for cleanup
    private readonly boundOnFileCreated: (file: TAbstractFile) => Promise<void>;
    private readonly boundOnFileModified: (file: TAbstractFile) => Promise<void>;
    private readonly boundOnFileDeleted: (file: TAbstractFile) => Promise<void>;

    constructor(app: App, settings: PensioSettings, apiClient: ApiClient) {
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

        console.log('Starting file watcher for auto-sync');
        this.isWatching = true;

        // Register event handlers
        this.app.vault.on('create', this.boundOnFileCreated);
        this.app.vault.on('modify', this.boundOnFileModified);
        this.app.vault.on('delete', this.boundOnFileDeleted);
    }

    /**
     * Stop watching for file changes
     */
    stopWatching(): void {
        if (!this.isWatching) return;

        console.log('Stopping file watcher');
        this.isWatching = false;

        // Unregister event handlers
        this.app.vault.off('create', this.boundOnFileCreated);
        this.app.vault.off('modify', this.boundOnFileModified);
        this.app.vault.off('delete', this.boundOnFileDeleted);
    }

    /**
     * Handle file creation
     */
    private async onFileCreated(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile)) return;
        if (!this.shouldSyncFile(file)) return;

        console.log('File created:', file.path);

        // Check if this is a rename (file with similar name was recently deleted)
        const wasRenamed = this.checkForRename(file);
        if (wasRenamed) {
            console.log('Detected rename, will update existing record');
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

        console.log('File modified:', file.path);
        this.debounceSync(file.path, 'update');
    }

    /**
     * Handle file deletion
     */
    private async onFileDeleted(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile)) return;
        if (!this.shouldSyncFile(file)) return;

        console.log('File deleted:', file.path);

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

        // Check if in any of the sync folders
        const syncFolders = [
            this.settings.journalFolder,
            this.settings.promptFolder,
            this.settings.peopleFolder
        ].filter(folder => folder.trim().length > 0);

        const inSyncFolder = syncFolders.some(folder =>
            file.path.startsWith(folder + '/') || file.path === folder
        );
        if (!inSyncFolder) return false;

        // Check exclude patterns
        const excluded = this.settings.excludePatterns.some(pattern => {
            const regex = new RegExp(pattern.replace('**', '.*').replace('*', '[^/]*'));
            return regex.test(file.path);
        });

        return !excluded;
    }

    /**
     * Check if file needs syncing based on modification time
     * Returns true if file is new or modified since last sync
     */
    private async needsSync(file: TFile): Promise<boolean> {
        // If no last sync time, sync everything
        if (!this.lastSyncTime) {
            return true;
        }

        // Check if file was modified since last sync
        if (file.stat.mtime > this.lastSyncTime) {
            return true;
        }

        // Check tracked file info
        const tracked = this.syncedFiles.get(file.path);
        if (!tracked) {
            // File not tracked yet, needs sync
            return true;
        }

        // Check if mtime changed
        if (file.stat.mtime !== tracked.mtime) {
            return true;
        }

        // Optionally check content hash (for now, mtime is sufficient)
        return false;
    }

    /**
     * Update file tracking after successful sync
     */
    private updateFileTracking(file: TFile, hash?: string): void {
        this.syncedFiles.set(file.path, {
            mtime: file.stat.mtime,
            hash: hash || ''
        });
    }

    /**
     * Remove file from tracking
     */
    private removeFileTracking(filePath: string): void {
        this.syncedFiles.delete(filePath);
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
                        console.log(`Skipping retry for ${item.filePath} (status ${errorStatus})`);
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
        console.log('Syncing file:', file.path);

        // Check if file needs syncing (incremental sync optimization)
        if (!forceSync) {
            const needsSync = await this.needsSync(file);
            if (!needsSync) {
                console.log('File unchanged, skipping sync:', file.path);
                return false;
            }
        }

        // Determine content type based on folder
        const contentType = this.detectContentType(file.path);
        console.log(`Content type detected: ${contentType}`);

        // Read file content
        const content = await this.app.vault.read(file);

        // Parse markdown
        const parsed = parseMarkdown(content);

        // Check file size
        const sizeMB = new Blob([content]).size / (1024 * 1024);
        if (sizeMB > this.settings.maxEntrySizeMB) {
            throw new Error(`File too large (${sizeMB.toFixed(2)}MB > ${this.settings.maxEntrySizeMB}MB)`);
        }

        // Sync based on content type
        if (contentType === 'prompt') {
            await this.syncPrompt(file, parsed);
        } else if (contentType === 'person') {
            await this.syncPerson(file, parsed);
        } else {
            await this.syncEntry(file, parsed);
        }

        // Update file tracking after successful sync
        this.updateFileTracking(file);
        return true;
    }

    /**
     * Detect content type based on file path
     */
    private detectContentType(filePath: string): 'entry' | 'prompt' | 'person' {
        // Check if in prompt folder
        if (this.settings.promptFolder && filePath.startsWith(this.settings.promptFolder + '/')) {
            return 'prompt';
        }
        // Check if in people folder
        if (this.settings.peopleFolder && filePath.startsWith(this.settings.peopleFolder + '/')) {
            return 'person';
        }
        // Check if exact match (for top-level files)
        if (this.settings.promptFolder && filePath === this.settings.promptFolder) {
            return 'prompt';
        }
        if (this.settings.peopleFolder && filePath === this.settings.peopleFolder) {
            return 'person';
        }
        // Default to entry (journal)
        return 'entry';
    }

    /**
     * Sync journal entry
     */
    private async syncEntry(file: TFile, parsed: any): Promise<void> {
        // Plugin sends RAW markdown, backend processes everything
        const entryData: CreateEntryRequest = {
            title: parsed.title || file.basename,
            content_html: parsed.content,  // Raw markdown - backend will render
            content_plain: parsed.content,  // Raw markdown - backend extracts
            entry_date: null,  // Backend extracts from frontmatter or filename
            entry_type: 'daily_journal',  // Backend determines from path/frontmatter
            file_path: file.path,
            frontmatter: {},  // Backend parses frontmatter
            file_modified_at: new Date(file.stat.mtime).toISOString()
        };

        // Check if entry exists
        const existingEntry = await this.apiClient.findEntryByPath(file.path);

        if (existingEntry) {
            // Update existing entry
            await this.apiClient.updateEntry(existingEntry.id, entryData);
            console.log('Updated entry:', file.path);
        } else {
            // Create new entry
            await this.apiClient.createEntry(entryData);
            console.log('Created entry:', file.path);
        }
    }

    /**
     * Sync prompt
     */
    private async syncPrompt(file: TFile, parsed: any): Promise<void> {
        // Plugin sends RAW markdown, backend processes everything
        const promptData: CreatePromptRequest = {
            title: parsed.title || file.basename,
            content: parsed.content,  // Raw markdown
            content_html: parsed.content,  // Backend will render HTML
            description: '',  // Backend extracts from frontmatter
            file_path: file.path
        };

        // Check if prompt exists
        const existingPrompt = await this.apiClient.findPromptByPath(file.path);

        if (existingPrompt) {
            // Update existing prompt
            await this.apiClient.updatePrompt(existingPrompt.id, promptData);
            console.log('Updated prompt:', file.path);
        } else {
            // Create new prompt
            await this.apiClient.createPrompt(promptData);
            console.log('Created prompt:', file.path);
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
            console.log('Updated person:', file.path);
        } else {
            // Create new person
            try {
                await this.apiClient.createPerson(personData);
                console.log('Created person:', file.path);
            } catch (error) {
                // If we get a conflict error, person was created concurrently
                if (error?.status === 409 || error?.message?.includes('duplicate key')) {
                    console.log('Person already exists (created concurrently):', personName);
                    // Fetch the existing person and update it
                    existingPerson = await this.apiClient.findPersonByName(personName);
                    if (existingPerson) {
                        await this.apiClient.updatePerson(existingPerson.id, personData);
                        console.log('Updated person after conflict:', file.path);
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

        if (contentType === 'prompt') {
            const prompt = await this.apiClient.findPromptByPath(filePath);
            if (prompt) {
                await this.apiClient.deletePrompt(prompt.id);
                console.log('Deleted prompt:', filePath);
            }
        } else if (contentType === 'person') {
            const person = await this.apiClient.findPersonByPath(filePath);
            if (person) {
                await this.apiClient.deletePerson(person.id);
                console.log('Deleted person:', filePath);
            }
        } else {
            const entry = await this.apiClient.findEntryByPath(filePath);
            if (entry) {
                await this.apiClient.deleteEntry(entry.id);
                console.log('Deleted entry:', filePath);
            }
        }
    }

    /**
     * Sync all files in configured folders
     */
    async syncAll(forceSync: boolean = false): Promise<void> {
        console.log(forceSync ? 'Starting force sync (ignoring change detection)' : 'Starting incremental sync');

        const syncStartTime = Date.now();
        const files = this.app.vault.getMarkdownFiles();
        const filesToSync = files.filter(file => this.shouldSyncFile(file));

        console.log(`Found ${filesToSync.length} files to sync`);

        // Track errors
        const errors: string[] = [];

        // Sync all local files to server
        let skippedCount = 0;
        for (const file of filesToSync) {
            try {
                const synced = await this.syncFile(file, forceSync);
                if (!synced) {
                    skippedCount++;
                }
            } catch (error) {
                console.error(`Failed to sync ${file.path}:`, error);
                errors.push(`${file.path}: ${error.message || error}`);
            }
        }

        if (skippedCount > 0) {
            console.log(`Skipped ${skippedCount} unchanged files`);
        }

        // Mirror sync: Delete items from server that don't exist locally
        try {
            await this.mirrorDelete(filesToSync);
        } catch (error) {
            console.error('Mirror delete failed:', error);
            errors.push(`Mirror delete: ${error.message || error}`);
        }

        console.log('Full sync completed');

        // Update last sync time after successful sync
        if (errors.length === 0) {
            this.lastSyncTime = syncStartTime;
            console.log('Incremental sync enabled - tracking', this.syncedFiles.size, 'files');
        }

        // Throw error if any failures occurred
        if (errors.length > 0) {
            throw new Error(`Sync completed with ${errors.length} error(s): ${errors[0]}`);
        }
    }

    /**
     * Delete items from server that no longer exist in vault (mirror sync)
     */
    private async mirrorDelete(localFiles: TFile[]): Promise<void> {
        console.log('Starting mirror delete');

        // Build set of local file paths for fast lookup
        const localPaths = new Set(localFiles.map(f => f.path));

        try {
            // Get all entries from server
            const serverEntries = await this.apiClient.listEntries();
            for (const entry of serverEntries) {
                if (!localPaths.has(entry.file_path)) {
                    console.log(`Deleting entry not in vault: ${entry.file_path}`);
                    await this.apiClient.deleteEntry(entry.id);
                }
            }

            // Get all prompts from server
            const serverPrompts = await this.apiClient.listPrompts();
            for (const prompt of serverPrompts) {
                if (!localPaths.has(prompt.file_path)) {
                    console.log(`Deleting prompt not in vault: ${prompt.file_path}`);
                    await this.apiClient.deletePrompt(prompt.id);
                }
            }

            // Get all people from server
            const serverPeople = await this.apiClient.listPeople();
            for (const person of serverPeople) {
                if (person.person_note_path && !localPaths.has(person.person_note_path)) {
                    console.log(`Deleting person not in vault: ${person.person_note_path}`);
                    await this.apiClient.deletePerson(person.id);
                }
            }

            console.log('Mirror delete completed');
        } catch (error) {
            console.error('Mirror delete failed:', error);
        }
    }
}
