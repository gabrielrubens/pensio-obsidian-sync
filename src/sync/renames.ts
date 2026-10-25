import { App, TAbstractFile, TFile, TFolder } from 'obsidian';
import { debugLog } from '../logger';
import { BulkSyncItem, BulkSyncResponse, ProcessingStatus } from '../types';
import { itemBytes, Section, sendInChunks, tooLargeAlone } from './chunks';
import { SyncFolders } from './folders';
import { computeContentHash } from './hash';
import { SyncHistory } from './history';
import { parseMarkdown } from './parser';
import { buildData } from './payload';
import { ServerCapabilities } from './serverCapabilities';

/** What the rename queue needs from the sync engine. */
export interface RenameContext {
    app: App;
    folders: SyncFolders;
    history: SyncHistory;
    /** Notes to read again at the next sync. */
    dirty: Set<string>;
    /** Paths whose entry is to be deleted at the next sync. */
    deletes: Set<string>;
    server: ServerCapabilities;
    /** One bulk request; its answer says what the server can do. */
    post(section: Section, chunk: BulkSyncItem[]): Promise<BulkSyncResponse>;
    /** The quota a bulk answer reported. */
    statusSeen(status?: ProcessingStatus): void;
    /** Ask for a sync soon. */
    schedule(): void;
}

/**
 * Notes renamed or moved, waiting to be sent: old path → new path.
 *
 * ⭐ **THE SAME ENTRY, AT ITS NEW PATH** (decided 2026-10-20). Obsidian fires
 * `rename` — never `create` + `delete` — and the plugin did not listen for it,
 * so a renamed note became a second entry and the first stayed behind. Found by
 * the `pensio-prod-demo` fixture vault.
 */
export class RenameQueue {
    private pending = new Map<string, string>();

    constructor(private readonly ctx: RenameContext) { }

    get size(): number {
        return this.pending.size;
    }

    /**
     * The moves waiting, for the saved sync state. ⛔ Before 0.8.0 they lived
     * in memory only: a move not yet sent when Obsidian quit was lost, the
     * entry stayed at the old path and the note became a second entry when
     * next edited (*Move lost on restart*).
     */
    toState(): Record<string, string> {
        const moves: Record<string, string> = {};
        this.pending.forEach((to, from) => { moves[from] = to; });
        return moves;
    }

    restore(moves: Record<string, string> | undefined): void {
        this.pending.clear();
        for (const from of Object.keys(moves ?? {})) {
            const to = moves?.[from];
            if (typeof to === 'string') this.pending.set(from, to);
        }
    }

    /** Another account: its moves are not this one's. */
    clear(): void {
        this.pending.clear();
    }

    /** The path a queued move started from, if `path` is where one ends. */
    private originOf(path: string): string | undefined {
        let origin: string | undefined;
        this.pending.forEach((to, from) => { if (to === path) origin = from; });
        return origin;
    }

    /**
     * A note was deleted: the path whose entry should go. A move still waiting
     * to be sent never reached Pensio, so the entry is at the path the note
     * came from: delete that one.
     */
    deleted(path: string): string {
        const origin = this.originOf(path);
        if (origin === undefined) return path;
        this.pending.delete(origin);
        this.ctx.history.move(path, origin);
        return origin;
    }

    /**
     * A note was renamed or moved.
     *
     * - inside the synced folders, same kind → a move (`process`)
     * - out of the synced folders → nothing is sent. ⛔ Moving is not deleting:
     *   the entry stays (decided 2026-10-20). Mirror delete, if she turned it on,
     *   is what removes entries whose notes left.
     * - into the synced folders, never synced, or changed kind → a new note here
     */
    renamed(file: TAbstractFile, oldPath: string): void {
        const { folders, history, dirty } = this.ctx;
        if (file instanceof TFolder) {
            // A folder moves every note inside it. Whether Obsidian also reports
            // each child does not matter: the file branch ignores a move it has
            // already been told about.
            const walk = (child: TAbstractFile): void => {
                if (child instanceof TFolder) {
                    child.children.forEach(walk);
                } else if (child instanceof TFile) {
                    this.renamed(child, oldPath + child.path.slice(file.path.length));
                }
            };
            file.children.forEach(walk);
            return;
        }
        if (!(file instanceof TFile)) return;
        if (this.pending.get(oldPath) === file.path) return;

        const wasIn = folders.isSynced(oldPath);
        const isIn = folders.isSynced(file.path);
        if (!wasIn && !isIn) return;

        debugLog('File renamed:', oldPath, '→', file.path);
        const tracked = history.get(oldPath);
        // a → b, then b → c before a sync, is one move from a.
        const origin = this.originOf(oldPath);
        dirty.delete(oldPath);

        const sameKind = wasIn && isIn &&
            folders.contentType(oldPath) === folders.contentType(file.path);
        if (sameKind && (tracked || origin)) {
            if (origin) this.pending.delete(origin);
            this.pending.set(origin ?? oldPath, file.path);
            history.move(oldPath, file.path);
            this.ctx.schedule();
            return;
        }
        // ⭐ Not sent as a move, so its entry stays on Pensio where it was, and
        // the sync history keeps that path: mirror delete removes only what
        // this vault synced (sync/mirror.ts), so a path dropped here would keep
        // its entry for good. A move still waiting to be sent never reached
        // Pensio, so the entry is at the path it came from.
        if (origin) {
            this.pending.delete(origin);
            history.move(oldPath, origin);
        }
        if (isIn) dirty.add(file.path);
        this.ctx.schedule();
    }

    /**
     * Send the queued moves. ⭐ **AN OLDER SERVER IS KNOWN BY WHAT IT ANSWERS**,
     * never by an error message — those are translated. A server that can move a
     * row says `capabilities.rename` on every bulk answer; one that cannot
     * refuses the item and says nothing, and the note falls back to delete +
     * create (decided 2026-10-20). A server that CAN rename and still refuses
     * gets the note synced where it is now and nothing deleted.
     */
    async process(): Promise<void> {
        const { app, folders, server, dirty } = this.ctx;
        const moves = Array.from(this.pending.entries());
        this.pending.clear();

        const entryItems: BulkSyncItem[] = [];
        const peopleItems: BulkSyncItem[] = [];
        const sent = new Map<string, { file: TFile; hash: string }>();

        for (const [from, to] of moves) {
            const file = app.vault.getAbstractFileByPath(to);
            if (!(file instanceof TFile)) continue; // moved again or gone before this ran
            try {
                const content = await app.vault.read(file);
                const hash = await computeContentHash(content);
                const built = buildData(file, parseMarkdown(content), folders.contentType(file.path));
                const item = server.shaped({ action: 'rename', file_path: from, new_file_path: to, data: built.data });
                if (tooLargeAlone(itemBytes(item))) {
                    this.moveNotSent(from, to); // the loop finds it too large, and says so
                    continue;
                }
                (built.kind === 'person' ? peopleItems : entryItems).push(item);
                sent.set(from, { file, hash });
            } catch (error) {
                console.error(`Failed to prepare rename ${from} → ${to}:`, error);
                dirty.add(to);
            }
        }

        // ⛔ Before 0.7.3 every move went in ONE request: moving a folder of
        // long notes made a body Pensio refuses, and the moves were queued
        // again, to fail the same way every sync (review CRIT-4).
        const send = async (items: BulkSyncItem[], section: Section): Promise<void> => {
            const done = new Set<BulkSyncItem>();
            try {
                await sendInChunks(items, {
                    post: chunk => this.ctx.post(section, chunk),
                    answered: (chunk, result) => {
                        chunk.forEach(item => done.add(item));
                        this.answered(chunk, result, section, sent);
                    },
                    refused: item => {
                        done.add(item);
                        if (item.new_file_path) this.moveNotSent(item.file_path, item.new_file_path);
                    },
                });
            } catch (error) {
                console.error('Bulk rename failed:', error);
                for (const item of items) {
                    if (!done.has(item) && item.new_file_path) this.pending.set(item.file_path, item.new_file_path);
                }
            }
        };

        await send(entryItems, 'entries');
        await send(peopleItems, 'people');
    }

    /**
     * A move that will not be sent: the note is too large to sync where it is
     * now (sync/tooLarge.ts). Pensio still has its entry at `from`, so the
     * history says `from` (0.7.2: the history names the path Pensio has, which
     * is what lets mirror delete find it), and the loop finds the note at `to`
     * too large and says so.
     */
    private moveNotSent(from: string, to: string): void {
        this.ctx.history.move(to, from);
        this.ctx.dirty.add(to);
    }

    /** What Pensio did with one request of moves (see `process`). */
    private answered(
        items: BulkSyncItem[], result: BulkSyncResponse, section: Section,
        sent: Map<string, { file: TFile; hash: string }>,
    ): void {
        const { history, dirty, deletes, server } = this.ctx;
        this.ctx.statusSeen(result.processing_status);
        const refused = new Set(result[section].errors.map((err: { file_path: string }) => err.file_path));
        const canRename = result.capabilities?.rename === true;
        const lost = server.lostText(items, result);
        const notMoved = new Set(result[section].not_moved ?? []);
        for (const item of items) {
            const info = sent.get(item.file_path);
            if (!info) continue;
            const failed = refused.has(item.file_path) ||
                (item.new_file_path !== undefined && refused.has(item.new_file_path));
            if (!failed && notMoved.has(item.file_path)) {
                // ⭐ The new path was taken (*Rename onto a taken path*): the
                // note went onto the entry there, and the one it left is still
                // at the old path. Delete that one, as for a server that
                // cannot move a row. ⛔ Until 0.8.0 nothing said so, and it
                // stayed on Pensio in no history, for good. The history keeps
                // the old path until the delete is answered (sendDeletes).
                history.set(item.file_path, { mtime: info.file.stat.mtime, hash: info.hash });
                deletes.add(item.file_path);
            }
            if (!failed && lost.has(item)) {
                // Moved, but stored without its text: untracked, it is sent
                // again in full, at its new path, by the loop of this sync.
                history.forget(info.file.path);
                continue;
            }
            if (!failed) {
                history.track(info.file, info.hash);
                continue;
            }
            history.forget(info.file.path);
            dirty.add(info.file.path);
            if (!canRename) {
                deletes.add(item.file_path);
            }
        }
    }
}
