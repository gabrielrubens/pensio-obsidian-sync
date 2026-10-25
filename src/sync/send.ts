import { TFile } from 'obsidian';
import { debugLog } from '../logger';
import { BulkSyncItem, BulkSyncResponse, ProcessingStatus } from '../types';
import { itemBytes, Section, sendInChunks } from './chunks';
import { Collected } from './collect';
import { SyncHistory } from './history';
import { ServerCapabilities } from './serverCapabilities';
import { TooLargeNotes } from './tooLarge';

/** What sending the collected notes needs from the sync engine. */
export interface SendContext {
    /** One bulk request; its answer says what the server can do. */
    post(section: Section, chunk: BulkSyncItem[]): Promise<BulkSyncResponse>;
    /** The quota a bulk answer reported. */
    statusSeen(status?: ProcessingStatus): void;
    server: ServerCapabilities;
    history: SyncHistory;
    tooLarge: TooLargeNotes;
    /** Notes to read again at the next sync. */
    dirty: Set<string>;
    /** A note moved while its request was out: Pensio has it at `sentAt`. */
    movedWhileSent(file: TFile, sentAt: string): void;
}

/**
 * Send the collected notes, entries then people, and track each one Pensio
 * answered for. Errors go into `collected.errors`; a note Pensio did not take
 * leaves `collected.trackingDeferred`.
 *
 * ⛔ The first request that fails outright (offline, a 429, a dead session, a
 * server error) ends the sync: every later one would fail the same way, and
 * each one cost a request and a token refresh, about 39 refreshes a run for a
 * 600-note first sync, every 5 minutes, into the very limit that refused it
 * (review F20). ⭐ Requests are sized in bytes, not notes (sync/chunks.ts).
 */
export async function sendCollected(
    collected: Collected, ctx: SendContext,
): Promise<{ halted: boolean; underlying: unknown }> {
    const { entryItems, peopleItems, trackingDeferred, errors } = collected;
    const { server, history, tooLarge, dirty } = ctx;
    // The first request that failed outright, so the notice can say why.
    let underlying: unknown;
    let halted = false;
    const sections: [Section, BulkSyncItem[]][] = [['entries', entryItems], ['people', peopleItems]];
    for (const [section, items] of sections) {
        if (halted) break;
        try {
            await sendInChunks(items, {
                post: chunk => ctx.post(section, chunk),
                answered: (chunk, result) => {
                    ctx.statusSeen(result.processing_status);
                    debugLog(`Bulk ${section}: ${chunk.length} sent, ` +
                        `${result[section].created} created, ${result[section].updated} updated`);
                    const errorPaths = new Set(result[section].errors.map(err => err.file_path));
                    for (const err of result[section].errors) {
                        const errMsg = typeof err.error === 'object' ? JSON.stringify(err.error) : err.error;
                        errors.push(`${err.file_path}: ${errMsg}`);
                    }
                    // ⛔ Stored without its text (serverCapabilities.ts::lostText):
                    // not synced, and sent again in full next sync.
                    const lost = server.lostText(chunk, result);
                    for (const item of chunk) {
                        const info = trackingDeferred.get(item.file_path);
                        if (!info || errorPaths.has(item.file_path)) continue;
                        if (lost.has(item)) {
                            trackingDeferred.delete(item.file_path);
                            dirty.add(item.file_path);
                            continue;
                        }
                        // ⭐ Where it was SENT, which is where Pensio has it.
                        // ⛔ Until 0.8.0 it was tracked where the note was when
                        // the answer came: a note renamed while its first
                        // request was out was recorded at its new path, the
                        // entry stayed at the old one, mirror delete never
                        // found it, and the next edit made a second entry
                        // (*Rename in flight*). Now that rename becomes a move.
                        history.track(info.file, info.hash, item.file_path);
                        if (info.file.path !== item.file_path) ctx.movedWhileSent(info.file, item.file_path);
                    }
                },
                // The server's own limit is lower than the one the
                // plugin knows: this note is too large there.
                refused: item => {
                    const info = trackingDeferred.get(item.file_path);
                    trackingDeferred.delete(item.file_path);
                    if (info) tooLarge.add(item.file_path, info.file.stat.mtime, itemBytes(item), server.wentOnce(item));
                },
            });
        } catch (error) {
            console.error(`Bulk ${section} sync failed:`, error);
            underlying ??= error;
            halted = true;
            errors.push(`Bulk sync chunk: ${(error as Error).message || error}`);
        }
    }
    return { halted, underlying };
}
