import { App, TAbstractFile, TFile } from 'obsidian';
import { ApiClient } from '../api/client';
import { RefreshError } from '../auth/tokenManager';
import { SyncFailure } from '../errors';
import { debugLog } from '../logger';
import { BulkSyncItem, BulkSyncResponse, PensioSettings, ProcessingStatus, SyncStateData } from '../types';
import { Section } from './chunks';
import { collectChanges } from './collect';
import { DeleteContext, MirrorGate, mirrorDelete, sendDeletes } from './deletes';
import { SyncFolders } from './folders';
import { sendCollected } from './send';
import { SyncHistory } from './history';
import { RenameQueue } from './renames';
import { ServerCapabilities } from './serverCapabilities';
import { TooLargeNotes } from './tooLarge';
import { SyncWatcher } from './watcher';

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

/**
 * Sync engine — watches vault files and syncs to Pensio via bulk API.
 *
 * Architecture: file watcher marks files as "dirty"; all syncing goes
 * through syncAll() which batches dirty files into bulk API calls.
 * This single code path eliminates dual-path bugs and N+1 queries.
 *
 * The parts live beside it: which notes sync (`folders.ts`), what was synced
 * (`history.ts`), moves (`renames.ts`), deletes and mirror delete
 * (`deletes.ts`), and when syncs run by themselves (`watcher.ts`).
 */
export class SyncEngine {
    /** How soon a queued move or delete is saved (`saveSoon`). */
    static readonly SAVE_SOON_MS = 1000;

    private app: App;
    private settings: PensioSettings;
    private apiClient: ApiClient;
    private isSyncing = false;
    /** The sync running now, so a second caller gets its real result. */
    private current: Promise<SyncResult> | null = null;
    /** A request of this sync reached Pensio and was answered. */
    private contacted = false;
    private readonly folders: SyncFolders;
    private readonly history = new SyncHistory();
    private readonly renames: RenameQueue;
    private readonly mirror: MirrorGate;
    private readonly watcher: SyncWatcher;
    /** Notes whose own request is more than Pensio takes (sync/chunks.ts). */
    private tooLarge = new TooLargeNotes();
    /** What the server last said it can do: whether a note's text may go once. */
    private server = new ServerCapabilities(() => this.settings.apiUrl);

    // Dirty set: files changed by watcher, pending next syncAll
    private dirtyFiles = new Set<string>();
    private pendingDeletes = new Set<string>();
    /** A save asked for by a move or a delete (`saveSoon`). */
    private saveSoonTimer: number | null = null;

    // Emotion-analysis quota, as last reported by the bulk endpoint. The most
    // recent chunk of a sync wins, so after a big import this holds the state
    // once every entry has landed.
    private lastProcessingStatus: ProcessingStatus | null = null;

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

    constructor(
        app: App,
        settings: PensioSettings,
        apiClient: ApiClient,
        private onSaveState: (state: SyncStateData) => Promise<void> = async () => { }
    ) {
        this.app = app;
        this.settings = settings;
        this.apiClient = apiClient;
        this.folders = new SyncFolders(settings, app);
        this.mirror = new MirrorGate(settings, this.folders, this.history);
        this.renames = new RenameQueue({
            app,
            folders: this.folders,
            history: this.history,
            dirty: this.dirtyFiles,
            deletes: this.pendingDeletes,
            server: this.server,
            post: (section, chunk) => this.post(section, chunk),
            statusSeen: status => this.captureProcessingStatus(status),
            schedule: () => this.watcher.schedule(),
        });
        this.watcher = new SyncWatcher(app, {
            changed: file => this.onFileChanged(file),
            deleted: file => this.onFileDeleted(file),
            renamed: (file, oldPath) => {
                this.renames.renamed(file, oldPath);
                this.saveSoon();
            },
            sync: () => this.syncAll(false),
            isSyncing: () => this.isSyncing,
            isAuthInvalidated: () => this.apiClient.isAuthInvalidated(),
            failed: error => this.onSyncFailed?.(error),
        });
    }

    // ========================================================================
    // Lifecycle (watcher.ts)
    // ========================================================================

    startWatching(): void {
        this.watcher.start();
    }

    stopWatching(): void {
        this.watcher.stop();
        void this.saveNow();
    }

    /**
     * Save now what `saveSoon` was waiting to save: Obsidian is quitting, or
     * the sync is stopping. ⛔ Obsidian does not unload plugins when it quits,
     * so a save left to `stopWatching` never ran, and a move made in the last
     * second before quitting was lost (found by Gabriel's test of 0.8.0,
     * 2026-10-22). `plugin/wiring.ts::saveOnQuit` calls this from Obsidian's
     * `quit` event, which waits for it.
     */
    /** A save is waiting (`saveSoon`): something changed in the last second. */
    get saveWaiting(): boolean {
        return this.saveSoonTimer !== null;
    }

    async saveNow(): Promise<void> {
        if (this.saveSoonTimer === null) return;
        window.clearTimeout(this.saveSoonTimer);
        this.saveSoonTimer = null;
        await this.persistState();
    }

    /** The automatic sync is running: a failure will be tried again by itself. */
    isAutoSyncing(): boolean {
        return this.watcher.isAutoSyncing();
    }

    startAutoSync(): void {
        this.watcher.startAutoSync();
    }

    // ========================================================================
    // File watcher — marks dirty, triggers debounced syncAll
    // ========================================================================

    private onFileChanged(file: TAbstractFile): void {
        if (!(file instanceof TFile)) return;
        if (!this.shouldSyncFile(file)) return;

        debugLog('File changed:', file.path);
        this.dirtyFiles.add(file.path);
        this.watcher.schedule();
    }

    private onFileDeleted(file: TAbstractFile): void {
        if (!(file instanceof TFile)) return;
        if (!this.shouldSyncFile(file)) return;

        debugLog('File deleted:', file.path);
        this.dirtyFiles.delete(file.path);
        // ⭐ The history keeps the path until Pensio has answered the delete
        // (sendDeletes). ⛔ It used to drop it here, before anything was
        // sent: a delete that failed (offline, a 429, a 5xx) was then lost,
        // and since 0.7.2 mirror delete, which works from the history, could
        // never find it again (review of 0.7.2, 2026-10-21).
        this.pendingDeletes.add(this.renames.deleted(file.path));
        this.saveSoon();
        this.watcher.schedule();
    }

    /**
     * A move or a delete changed what is waiting to be sent: save it within a
     * second, so a restart does not lose a move (0.8.0, *Move lost on
     * restart*). One save for a burst: moving a folder moves every note in it.
     */
    private saveSoon(): void {
        if (this.saveSoonTimer !== null) window.clearTimeout(this.saveSoonTimer);
        this.saveSoonTimer = window.setTimeout(() => {
            this.saveSoonTimer = null;
            void this.persistState();
        }, SyncEngine.SAVE_SOON_MS);
    }

    /**
     * Mark a file dirty so it's included in the next syncAll.
     * Used by the sync-current-file command.
     */
    markDirty(filePath: string): void {
        this.dirtyFiles.add(filePath);
    }

    shouldSyncFile(file: TFile): boolean {
        return this.folders.isSynced(file.path);
    }

    /** The files a sync reads (folders.ts). */
    private filesInSyncFolders(): TFile[] {
        return this.folders.files();
    }

    // ========================================================================
    // Sync tracking & state persistence
    // ========================================================================

    restoreState(state: SyncStateData): void {
        this.history.restore(state);
        this.renames.restore(state.renames);
        this.tooLarge.restore(state.tooLarge);
        this.server.restore(state.capabilities);
        debugLog(
            `Restored sync state: ${this.history.size} tracked files, ` +
            `userId=${this.history.userId || 'none'}, ` +
            `lastSync=${state.lastSyncTime ? new Date(state.lastSyncTime).toISOString() : 'never'}`
        );
    }

    getTrackedFileCount(): number {
        return this.history.size;
    }

    /** The paths in the sync history: the paths Pensio has an entry at. */
    trackedPaths(): string[] {
        return [...this.history.paths()].sort();
    }

    /** When the last sync with nothing failing finished (ms), or null. */
    getLastSyncTime(): number | null {
        return this.history.lastSyncTime;
    }

    /** The notes too large to sync, by path (sync/tooLarge.ts). */
    getTooLargeNotes(): string[] {
        return this.tooLarge.paths();
    }

    getState(): SyncStateData {
        return {
            ...this.history.toState(),
            tooLarge: this.tooLarge.toState(),
            capabilities: this.server.toState(),
            renames: this.renames.toState(),
        };
    }

    clearState(): void {
        debugLog('Clearing sync state (account switch or logout)');
        this.history.clear();
        this.tooLarge.clear();
        this.server.clear();
        this.renames.clear();
        // A different account has a different tier and quota — the previous
        // account's "already told them today" must not silence the new one.
        this.lastProcessingStatus = null;
    }

    /** Last known emotion-analysis quota, or null if never reported. */
    getLastProcessingStatus(): ProcessingStatus | null {
        return this.lastProcessingStatus;
    }

    /** UTC day the quota notice was last shown, for once-a-day deduping. */
    getLastQuotaNoticeDay(): string | null {
        return this.history.lastQuotaNoticeDay;
    }

    /** Record that the quota notice was shown today, and persist it. */
    markQuotaNoticeShown(day: string): void {
        this.history.lastQuotaNoticeDay = day;
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
        this.history.userId = userId;
    }

    getUserId(): string | null {
        return this.history.userId;
    }

    private async persistState(): Promise<void> {
        try {
            await this.onSaveState(this.getState());
            debugLog('Sync state persisted:', this.history.size, 'files');
        } catch (error) {
            console.error('Failed to persist sync state:', error);
        }
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

            // ⛔ **DELETES BEFORE RENAMES** (2026-10-21). Renames used to go
            // first, so deleting a note and renaming another onto its name in
            // one sync sent the rename while the old row still held that path:
            // the server, refusing to delete, synced the note onto that row —
            // and the delete then removed it. The renamed note was left with no
            // person and the original was orphaned ("Ben 3", in the
            // `pensio-prod-demo` vault). A delete frees the path first now.
            if (this.pendingDeletes.size > 0) {
                await sendDeletes(this.pendingDeletes, this.deleteContext());
            }

            // Then renames. An older server's fallback queues a delete, sent by
            // the second pass, and a create, which the loop below sends.
            if (this.renames.size > 0) {
                await this.renames.process();
                if (this.pendingDeletes.size > 0) {
                    await sendDeletes(this.pendingDeletes, this.deleteContext());
                }
            }

            // Collect files to sync
            const filesToSync = this.filesInSyncFolders();
            debugLog(`Found ${filesToSync.length} files to check`);

            const collected = await collectChanges(filesToSync, forceSync, {
                app: this.app, folders: this.folders, history: this.history, tooLarge: this.tooLarge,
                server: this.server, dirty: this.dirtyFiles, ask: () => this.post('entries', []),
            });
            const { trackingDeferred, skippedCount, errors } = collected;

            // Clear dirty set — we've processed all files
            this.dirtyFiles.clear();

            if (skippedCount > 0) {
                debugLog(`Skipped ${skippedCount} unchanged files (hash dedup)`);
            }
            debugLog(`Syncing ${collected.entryItems.length} entries + ${collected.peopleItems.length} people`);

            const sent = await sendCollected(collected, {
                post: (section, chunk) => this.post(section, chunk),
                statusSeen: status => this.captureProcessingStatus(status),
                server: this.server, history: this.history, tooLarge: this.tooLarge, dirty: this.dirtyFiles,
                movedWhileSent: (file, sentAt) => {
                    this.renames.renamed(file, sentAt);
                    this.saveSoon();
                },
            });
            const halted = sent.halted;
            let underlying = sent.underlying;
            this.tooLarge.finish();

            // Mirror delete
            if (!halted && this.mirror.allowed(asked, filesToSync)) {
                try {
                    this.mirror.ran();
                    await mirrorDelete(filesToSync, this.deleteContext());
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
                this.mirror.syncWorked();
                // Only a sync Pensio answered is a sync: "synced just now"
                // must not appear after one that sent nothing.
                if (this.contacted) this.history.lastSyncTime = syncStartTime;
                debugLog('Sync complete — tracking', this.history.size, 'files');
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

    /** One bulk request, in one section; its answer says what the server can do. */
    private async post(section: Section, chunk: BulkSyncItem[]): Promise<BulkSyncResponse> {
        const result = await this.reached(section === 'people'
            ? this.apiClient.bulkSync([], chunk) : this.apiClient.bulkSync(chunk, []));
        this.server.answered(result);
        return result;
    }

    /** Pensio answered this request: the sync has been in touch. */
    private async reached<T>(request: Promise<T>): Promise<T> {
        const answer = await request;
        this.contacted = true;
        return answer;
    }

    private deleteContext(): DeleteContext {
        return {
            apiClient: this.apiClient,
            history: this.history,
            reached: request => this.reached(request),
        };
    }
}
