import { App, TAbstractFile, TFile } from 'obsidian';
import { ApiClient } from '../api/client';
import { CreateEntryRequest, JournalWiseSettings, SyncQueueItem } from '../types';
import { parseMarkdown } from './parser';

/**
 * Sync engine handles file watching and syncing with the API
 */
export class SyncEngine {
    private app: App;
    private settings: JournalWiseSettings;
    private apiClient: ApiClient;
    private syncQueue: SyncQueueItem[] = [];
    private isWatching = false;
    private isSyncing = false;

    constructor(app: App, settings: JournalWiseSettings, apiClient: ApiClient) {
        this.app = app;
        this.settings = settings;
        this.apiClient = apiClient;
    }

    /**
     * Start watching for file changes
     */
    startWatching(): void {
        if (this.isWatching) return;

        console.log('Starting file watcher');
        this.isWatching = true;

        // Register event handlers
        this.app.vault.on('create', this.onFileCreated.bind(this));
        this.app.vault.on('modify', this.onFileModified.bind(this));
        this.app.vault.on('delete', this.onFileDeleted.bind(this));
    }

    /**
     * Stop watching for file changes
     */
    stopWatching(): void {
        if (!this.isWatching) return;

        console.log('Stopping file watcher');
        this.isWatching = false;

        // Unregister event handlers
        this.app.vault.off('create', this.onFileCreated.bind(this));
        this.app.vault.off('modify', this.onFileModified.bind(this));
        this.app.vault.off('delete', this.onFileDeleted.bind(this));
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

        // Check if in sync folders
        const inSyncFolder = this.settings.syncFolders.some(folder =>
            file.path.startsWith(folder)
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

        // Read file content
        const content = await this.app.vault.read(file);

        // Parse markdown
        const parsed = parseMarkdown(content);

        // Check file size
        const sizeMB = new Blob([content]).size / (1024 * 1024);
        if (sizeMB > this.settings.maxEntrySizeMB) {
            throw new Error(`File too large (${sizeMB.toFixed(2)}MB > ${this.settings.maxEntrySizeMB}MB)`);
        }

        // Prepare entry data
        const entryData: CreateEntryRequest = {
            title: parsed.title || file.basename,
            content_html: parsed.html,
            content_plain: parsed.text,
            entry_date: parsed.frontmatter?.date || null,
            entry_type: parsed.frontmatter?.type || 'daily_journal',
            file_path: file.path,
            frontmatter: parsed.frontmatter,
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
     * Delete file from server
     */
    private async deleteFile(filePath: string): Promise<void> {
        const entry = await this.apiClient.findEntryByPath(filePath);
        if (entry) {
            await this.apiClient.deleteEntry(entry.id);
            console.log('Deleted entry:', filePath);
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

        for (const file of filesToSync) {
            try {
                await this.syncFile(file);
            } catch (error) {
                console.error(`Failed to sync ${file.path}:`, error);
            }
        }

        console.log('Full sync completed');
    }
}
