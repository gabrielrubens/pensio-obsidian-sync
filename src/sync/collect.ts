import { App, TFile } from 'obsidian';
import { BulkSyncItem, BulkSyncResponse } from '../types';
import { itemBytes, tooLargeAlone } from './chunks';
import { SyncFolders } from './folders';
import { computeContentHash } from './hash';
import { SyncHistory } from './history';
import { parseMarkdown } from './parser';
import { buildData } from './payload';
import { ServerCapabilities } from './serverCapabilities';
import { TooLargeNotes } from './tooLarge';

/** What reading the notes needs from the sync engine. */
export interface CollectContext {
    app: App;
    folders: SyncFolders;
    history: SyncHistory;
    tooLarge: TooLargeNotes;
    server: ServerCapabilities;
    /** Notes changed since the last sync: read even when their mtime matches. */
    dirty: Set<string>;
    /** An empty bulk request, to ask a server what it can do. */
    ask: () => Promise<BulkSyncResponse>;
}

/** The notes a sync will send, and what it learned reading them. */
export interface Collected {
    entryItems: BulkSyncItem[];
    peopleItems: BulkSyncItem[];
    /** The notes being sent, tracked once Pensio answers for them. */
    trackingDeferred: Map<string, { file: TFile; hash: string }>;
    skippedCount: number;
    errors: string[];
}

/**
 * Read the notes in the sync folders and build what to send: every note
 * changed since the last sync, or every note when `forceSync`, and none that
 * is unchanged or too large.
 */
export async function collectChanges(files: TFile[], forceSync: boolean, ctx: CollectContext): Promise<Collected> {
    const { app, folders, history, tooLarge, server, dirty } = ctx;
    const out: Collected = {
        entryItems: [], peopleItems: [], trackingDeferred: new Map(), skippedCount: 0, errors: [],
    };

    for (const file of files) {
        try {
            // Incremental mode: skip unchanged files unless dirty
            if (!forceSync && !dirty.has(file.path)) {
                const trackedFile = history.get(file.path);
                if (trackedFile && file.stat.mtime === trackedFile.mtime) {
                    out.skippedCount++;
                    continue;
                }
            }
            // Too large when last read, and not edited since: still is.
            if (tooLarge.unchanged(file.path, file.stat.mtime, server.textOnce())) continue;

            const content = await app.vault.read(file);
            const hash = await computeContentHash(content);

            // Hash-based dedup: skip if content unchanged
            const tracked = history.get(file.path);
            if (tracked && tracked.hash === hash) {
                out.skippedCount++;
                history.set(file.path, { hash, mtime: file.stat.mtime });
                continue;
            }

            const built = buildData(file, parseMarkdown(content), folders.contentType(file.path));
            let item = server.shaped({ action: 'create', file_path: file.path, data: built.data });
            // Too large with its text twice: a server that takes it
            // once may not have said so yet (serverCapabilities.ts).
            if (tooLargeAlone(itemBytes(item)) && await server.askIfOnceFits(item, ctx.ask)) {
                item = server.shaped(item);
            }
            // ⭐ A warning about this note, not a failed sync (review CRIT-4).
            const bytes = itemBytes(item);
            if (tooLargeAlone(bytes)) {
                tooLarge.add(file.path, file.stat.mtime, bytes, server.wentOnce(item));
                continue;
            }
            (built.kind === 'person' ? out.peopleItems : out.entryItems).push(item);

            out.trackingDeferred.set(file.path, { file, hash });
        } catch (error) {
            console.error(`Failed to prepare ${file.path}:`, error);
            out.errors.push(`${file.path}: ${(error as Error).message || error}`);
        }
    }
    return out;
}
