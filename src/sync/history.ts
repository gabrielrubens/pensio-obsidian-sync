import { TFile } from 'obsidian';
import { SyncedFileInfo, SyncStateData } from '../types';

/**
 * What this vault has synced: each note's path with the mtime and hash it had
 * when Pensio last answered for it, plus whose account that was and when the
 * last sync worked.
 *
 * ⭐ The history names the path Pensio has (plugin 0.7.2): mirror delete works
 * from it (sync/mirror.ts), so a path dropped too early keeps its entry on
 * Pensio for good, and a path kept too long deletes one that should stay.
 */
export class SyncHistory {
    private files = new Map<string, SyncedFileInfo>();
    /** The account this history belongs to (src/auth/accountGuard.ts). */
    userId: string | null = null;
    /** When the last sync with nothing failing finished (ms), or null. */
    lastSyncTime: number | null = null;
    /** UTC day the quota notice was last shown, for once-a-day deduping. */
    lastQuotaNoticeDay: string | null = null;

    get(path: string): SyncedFileInfo | undefined {
        return this.files.get(path);
    }

    set(path: string, info: SyncedFileInfo): void {
        this.files.set(path, info);
    }

    /**
     * Pensio answered for this note as it is now, at `at`: the path it was
     * sent with, which is where Pensio has it. ⚠️ Not always where the note is
     * now: a note renamed while its request was out is still at the path sent
     * (*Rename in flight*, `sync/send.ts`).
     */
    track(file: TFile, hash: string, at: string = file.path): void {
        this.files.set(at, { mtime: file.stat.mtime, hash });
    }

    forget(path: string): void {
        this.files.delete(path);
    }

    /** What was tracked at `from` is now tracked at `to` (nothing, if nothing was). */
    move(from: string, to: string): void {
        const tracked = this.files.get(from);
        this.files.delete(from);
        if (tracked) this.files.set(to, tracked);
    }

    paths(): IterableIterator<string> {
        return this.files.keys();
    }

    get size(): number {
        return this.files.size;
    }

    /** The parts of the saved sync state this history owns. */
    toState(): Pick<SyncStateData, 'userId' | 'lastSyncTime' | 'files' | 'lastQuotaNoticeDay'> {
        const files: Record<string, SyncedFileInfo> = {};
        for (const [path, info] of this.files) {
            files[path] = { hash: info.hash, mtime: info.mtime };
        }
        return {
            userId: this.userId,
            lastSyncTime: this.lastSyncTime,
            files,
            lastQuotaNoticeDay: this.lastQuotaNoticeDay,
        };
    }

    restore(state: SyncStateData): void {
        this.userId = state.userId ?? null;
        this.lastSyncTime = state.lastSyncTime;
        this.lastQuotaNoticeDay = state.lastQuotaNoticeDay ?? null;
        // Rebuild the tracking map with explicit types so the entries never
        // widen to `any` under a minimal DOM/ES lib (Object.entries needs
        // ES2017 typings the review bot's checker may not resolve).
        const restored = new Map<string, SyncedFileInfo>();
        for (const path of Object.keys(state.files)) {
            const info: SyncedFileInfo = state.files[path];
            restored.set(path, { mtime: info.mtime, hash: info.hash });
        }
        this.files = restored;
    }

    clear(): void {
        this.userId = null;
        this.lastSyncTime = null;
        this.files.clear();
        this.lastQuotaNoticeDay = null;
    }
}
