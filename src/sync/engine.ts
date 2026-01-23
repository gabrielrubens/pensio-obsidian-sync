import { App, TAbstractFile, TFile } from 'obsidian';
import { ApiClient } from '../api/client';
import { CreateEntryRequest, CreatePersonRequest, CreatePromptRequest, JournalWiseSettings, SyncQueueItem } from '../types';
import { parseMarkdown } from './parser';

/**
 * Sync engine handles file watching and syncing with the API
 */
export class SyncEngine {
    private app: App;
    private settings: JournalWiseSettings;
    private apiClient: ApiClient;
    private syncQueue: SyncQueueItem[] = [];
    private isWatching = false; private onFileCreatedBound?: (file: TAbstractFile) => Promise<void>;
    private onFileModifiedBound?: (file: TAbstractFile) => Promise<void>;
    private onFileDeletedBound?: (file: TAbstractFile) => Promise<void>; private isSyncing = false;

    // Bind handlers once to preserve reference for cleanup
    private readonly boundOnFileCreated: (file: TAbstractFile) => Promise<void>;
    private readonly boundOnFileModified: (file: TAbstractFile) => Promise<void>;
    private readonly boundOnFileDeleted: (file: TAbstractFile) => Promise<void>;

    constructor(app: App, settings: JournalWiseSettings, apiClient: ApiClient) {
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
        this.addToQueue(file.path, 'create');
        await this.processQueue();
    }

    /**
     * Handle file modification
     */
    private async onFileModified(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile)) return;
        if (!this.shouldSyncFile(file)) return;

        console.log('File modified:', file.path);
        this.addToQueue(file.path, 'update');
        await this.processQueue();
    }

    /**
     * Handle file deletion
     */
    private async onFileDeleted(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile)) return;
        if (!this.shouldSyncFile(file)) return;

        console.log('File deleted:', file.path);
        this.addToQueue(file.path, 'delete');
        await this.processQueue();
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

                    // Retry logic
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
     */
    async syncFile(file: TFile): Promise<void> {
        console.log('Syncing file:', file.path);

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
        const personData: CreatePersonRequest = {
            name: parsed.title || file.basename,
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

        // Check if person exists
        const existingPerson = await this.apiClient.findPersonByPath(file.path);

        if (existingPerson) {
            // Update existing person
            await this.apiClient.updatePerson(existingPerson.id, personData);
            console.log('Updated person:', file.path);
        } else {
            // Create new person
            await this.apiClient.createPerson(personData);
            console.log('Created person:', file.path);
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
    async syncAll(): Promise<void> {
        console.log('Starting full sync');

        const files = this.app.vault.getMarkdownFiles();
        const filesToSync = files.filter(file => this.shouldSyncFile(file));

        console.log(`Found ${filesToSync.length} files to sync`);

        // Track errors
        const errors: string[] = [];

        // Sync all local files to server
        for (const file of filesToSync) {
            try {
                await this.syncFile(file);
            } catch (error) {
                console.error(`Failed to sync ${file.path}:`, error);
                errors.push(`${file.path}: ${error.message || error}`);
            }
        }

        // Mirror sync: Delete items from server that don't exist locally
        try {
            await this.mirrorDelete(filesToSync);
        } catch (error) {
            console.error('Mirror delete failed:', error);
            errors.push(`Mirror delete: ${error.message || error}`);
        }

        console.log('Full sync completed');

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
