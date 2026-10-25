import { App, TAbstractFile } from 'obsidian';
import { debugLog } from '../logger';

/** What the watcher asks the sync engine to do. */
export interface WatcherHooks {
    changed(file: TAbstractFile): void;
    deleted(file: TAbstractFile): void;
    renamed(file: TAbstractFile, oldPath: string): void;
    /** One automatic sync. */
    sync(): Promise<unknown>;
    isSyncing(): boolean;
    isAuthInvalidated(): boolean;
    /** An automatic sync failed (`SyncEngine.onSyncFailed`). */
    failed(error: unknown): void;
}

/**
 * When syncs run by themselves: on a change (after a short debounce), 5 s
 * after the watcher starts, and every five minutes.
 */
export class SyncWatcher {
    private readonly SYNC_INTERVAL_MS = 5 * 60 * 1000;
    private readonly INITIAL_SYNC_DELAY_MS = 5000;
    private readonly WATCHER_SYNC_DEBOUNCE_MS = 3000;

    private watching = false;
    private syncIntervalTimer: number | null = null;
    /**
     * The sync `startAutoSync` schedules 5 s after it starts. ⛔ Before 0.7.1 it
     * was never kept, so stopping could not cancel it: every settings save
     * (each keystroke in a folder or token field) armed one more full sync
     * (review F10).
     */
    private initialSyncTimer: number | null = null;
    private watcherSyncTimer: number | null = null;

    // Arrow wrappers (not .bind, which the type-checker widens to `any`)
    // keep a stable reference for off() while staying type-safe.
    private readonly onChanged = (file: TAbstractFile): void => { this.hooks.changed(file); };
    private readonly onDeleted = (file: TAbstractFile): void => { this.hooks.deleted(file); };
    private readonly onRenamed = (file: TAbstractFile, oldPath: string): void => { this.hooks.renamed(file, oldPath); };

    constructor(private readonly app: App, private readonly hooks: WatcherHooks) { }

    start(): void {
        if (this.watching) return;

        debugLog('Starting file watcher for auto-sync');
        this.watching = true;

        this.app.vault.on('create', this.onChanged);
        this.app.vault.on('modify', this.onChanged);
        this.app.vault.on('delete', this.onDeleted);
        this.app.vault.on('rename', this.onRenamed);
    }

    stop(): void {
        if (!this.watching) return;

        debugLog('Stopping file watcher and periodic sync');
        this.watching = false;

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

        this.app.vault.off('create', this.onChanged);
        this.app.vault.off('modify', this.onChanged);
        this.app.vault.off('delete', this.onDeleted);
        this.app.vault.off('rename', this.onRenamed);
    }

    /** The automatic sync is running: a failure will be tried again by itself. */
    isAutoSyncing(): boolean {
        return this.watching && this.syncIntervalTimer !== null;
    }

    startAutoSync(): void {
        if (this.initialSyncTimer) window.clearTimeout(this.initialSyncTimer);
        this.initialSyncTimer = window.setTimeout(() => {
            this.initialSyncTimer = null;
            void (async () => {
                if (!this.watching) return;
                if (this.hooks.isAuthInvalidated()) {
                    debugLog('Initial sync skipped — auth invalidated');
                    return;
                }
                debugLog('Running initial sync...');
                try {
                    await this.hooks.sync();
                    debugLog('Initial sync completed');
                } catch (error) {
                    console.error('Initial sync failed:', error);
                    this.hooks.failed(error);
                }
            })();
        }, this.INITIAL_SYNC_DELAY_MS);

        if (this.syncIntervalTimer) {
            window.clearInterval(this.syncIntervalTimer);
        }
        this.syncIntervalTimer = window.setInterval(() => {
            void (async () => {
                if (this.hooks.isSyncing()) {
                    debugLog('Periodic sync skipped — sync already in progress');
                    return;
                }
                if (this.hooks.isAuthInvalidated()) {
                    debugLog('Periodic sync skipped — auth invalidated');
                    return;
                }
                debugLog('Running periodic sync...');
                try {
                    await this.hooks.sync();
                } catch (error) {
                    console.error('Periodic sync failed:', error);
                    this.hooks.failed(error);
                }
            })();
        }, this.SYNC_INTERVAL_MS);
    }

    /** Sync after a short debounce, so rapid edits batch together. */
    schedule(): void {
        if (this.watcherSyncTimer) {
            window.clearTimeout(this.watcherSyncTimer);
        }
        this.watcherSyncTimer = window.setTimeout(() => {
            void (async () => {
                this.watcherSyncTimer = null;
                if (this.hooks.isSyncing()) {
                    debugLog('Watcher sync deferred — sync already in progress');
                    return;
                }
                if (this.hooks.isAuthInvalidated()) {
                    debugLog('Watcher sync skipped — auth invalidated');
                    return;
                }
                try {
                    await this.hooks.sync();
                } catch (error) {
                    console.error('Watcher-triggered sync failed:', error);
                    this.hooks.failed(error);
                }
            })();
        }, this.WATCHER_SYNC_DEBOUNCE_MS);
    }
}
