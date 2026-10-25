import { TFile } from 'obsidian';
import { ApiClient } from '../api/client';
import { debugLog } from '../logger';
import { PensioSettings } from '../types';
import { SyncFolders } from './folders';
import { SyncHistory } from './history';
import { deleteItems, goneNotes, MIRROR_CHUNK, mirrorSkip } from './mirror';

/** What deleting entries needs from the sync engine. */
export interface DeleteContext {
    apiClient: ApiClient;
    history: SyncHistory;
    /** Mark the sync as having reached Pensio. */
    reached<T>(request: Promise<T>): Promise<T>;
}

/**
 * Send the deletes of notes deleted while the plugin ran, by path, in both
 * sections (see `deleteItems`), and only then drop each path from the
 * history. A request that fails keeps the rest queued for the next sync, and
 * in the history, where mirror delete can find them too.
 */
export async function sendDeletes(pending: Set<string>, ctx: DeleteContext): Promise<void> {
    const paths = Array.from(pending);
    pending.clear();

    for (let i = 0; i < paths.length; i += MIRROR_CHUNK) {
        const chunk = paths.slice(i, i + MIRROR_CHUNK);
        const items = deleteItems(chunk);
        try {
            const result = await ctx.reached(ctx.apiClient.bulkSync(items, items));
            debugLog(`Deleted ${result.entries.deleted} entries, ${result.people.deleted} people`);
            for (const path of chunk) ctx.history.forget(path);
        } catch (error) {
            console.error('Bulk delete failed:', error);
            for (const path of paths.slice(i)) pending.add(path);
            return;
        }
    }
}

/**
 * Delete the entries of notes this vault synced and no longer sees
 * (sync/mirror.ts). A request that fails stops it and fails the sync; what it
 * did not reach stays in the history and is tried next time.
 */
export async function mirrorDelete(localFiles: TFile[], ctx: DeleteContext): Promise<void> {
    const gone = goneNotes(ctx.history.paths(), localFiles);
    for (let i = 0; i < gone.length; i += MIRROR_CHUNK) {
        const paths = gone.slice(i, i + MIRROR_CHUNK);
        const items = deleteItems(paths);
        const result = await ctx.reached(ctx.apiClient.bulkSync(items, items));
        debugLog(`Mirror delete: ${result.entries.deleted} entries, ${result.people.deleted} people`);
        // Answered: Pensio has no entry at these paths now, so a note
        // that comes back is sent again.
        for (const path of paths) ctx.history.forget(path);
    }
}

/**
 * When mirror delete may run: never when `mirrorSkip` says so, and by itself
 * at most once an hour; Sync now runs it at once.
 */
export class MirrorGate {
    /**
     * ⛔ Not for what it costs — since 0.7.2 a pass with nothing gone sends
     * nothing — but as a margin. The folder-change guard defers mirror delete
     * for one sync only, so without this a folder field left half typed, or a
     * folder taken off the list for a moment, lost its entries at the next
     * automatic sync, minutes later. 0.7.1 had the gate for the account
     * listing, and 0.7.2 first removed it with the listing (review of 0.7.2,
     * 2026-10-21).
     */
    static readonly INTERVAL_MS = 60 * 60 * 1000;
    private lastRunAt = 0;
    /** The folder settings the last successful sync used. */
    private foldersAtLastSync: string;

    constructor(
        private readonly settings: PensioSettings,
        private readonly folders: SyncFolders,
        private readonly history: SyncHistory,
    ) {
        this.foldersAtLastSync = folders.signature();
    }

    /** A sync ended with nothing failing: these folder settings are proven. */
    syncWorked(): void {
        this.foldersAtLastSync = this.folders.signature();
    }

    /** `asked`: she pressed something, so the hour does not apply. */
    allowed(asked: boolean, seen: TFile[]): boolean {
        const skip = mirrorSkip({
            enabled: this.settings.enableMirrorDelete,
            seen,
            foldersChanged: this.folders.signature() !== this.foldersAtLastSync,
            roots: this.folders.roots(),
            folderExists: root => this.folders.exists(root),
            tracked: [...this.history.paths()],
        });
        if (skip && this.settings.enableMirrorDelete) debugLog(`Mirror delete skipped: ${skip}`);
        return skip === null && (asked || Date.now() - this.lastRunAt >= MirrorGate.INTERVAL_MS);
    }

    /** Mirror delete is about to run. */
    ran(): void {
        this.lastRunAt = Date.now();
    }
}
