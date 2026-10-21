import { TFile } from 'obsidian';
import { BulkSyncItem } from '../types';

/**
 * Mirror delete: when a note THIS VAULT synced is gone from its sync folders,
 * its entry on Pensio goes too.
 *
 * ⛔ Until 0.7.2 it listed every entry on the account and deleted each
 * Obsidian entry whose path this vault did not have. A second vault on the
 * same account (a work vault, a test vault, a phone with other folders) owns
 * notes this one never had, so mirror delete in either vault deleted the
 * other's entries, one request at a time. The other vault still tracked them
 * as synced and never sent them again (review CRIT-1, 2026-10-20). Listing the
 * account was also the plugin's biggest drain on the hourly request budget
 * (review F9).
 *
 * ⭐ Now it deletes only paths in this vault's own sync history (the paths
 * Pensio has its entries under) that the sync no longer sees, by path, through
 * the same bulk endpoint a live delete uses. Nothing to delete means nothing
 * is sent. After the sync history is wiped it deletes nothing, which is the
 * safe answer.
 */

/** Paths sent in one request. */
export const MIRROR_CHUNK = 50;

/** Paths this vault synced whose notes the sync no longer sees. */
export function goneNotes(tracked: Iterable<string>, seen: TFile[]): string[] {
    const local = new Set(seen.map(file => file.path));
    return [...tracked].filter(path => !local.has(path));
}

/**
 * One delete per path, for the entries and the people sections both.
 *
 * ⭐ Both, because whether a gone path was a journal note or a person note
 * depends on the folder settings when it was synced, which may not be today's.
 * The server deletes only a row a vault wrote at that exact path, and answers
 * "not found" for the section that has none.
 */
export function deleteItems(paths: string[]): BulkSyncItem[] {
    return paths.map(file_path => ({ action: 'delete', file_path }));
}

/** What mirror delete needs to know about this sync before it may run. */
export interface MirrorView {
    enabled: boolean;
    /** The notes this sync sees. */
    seen: TFile[];
    /** The folder settings differ from the last sync that worked. */
    foldersChanged: boolean;
    /** The configured folders (empty fields left out). */
    roots: string[];
    folderExists: (root: string) => boolean;
    /** Paths in this vault's sync history. */
    tracked: string[];
}

/**
 * Why mirror delete may not run now, or null when it may. ⛔ It deletes what
 * it cannot see, so it runs only when what it sees can be trusted (review F10):
 * with Mirror delete on, clearing a folder field for 5 s deleted that folder's
 * entries on Pensio. It is skipped when:
 * - the folder settings changed since the last successful sync (she may be
 *   typing a path);
 * - a configured folder that held notes this vault synced does not exist
 *   now (renamed, or mistyped): a folder that never existed has nothing on
 *   Pensio to lose, so the default People folder may simply be missing;
 * - the sync sees no notes at all.
 */
export function mirrorSkip(view: MirrorView): string | null {
    if (!view.enabled) return 'it is off';
    if (view.seen.length === 0) return 'the sync sees no notes';
    if (view.foldersChanged) return 'the folder settings changed since the last sync';
    const lost = view.roots.some(root =>
        !view.folderExists(root) && view.tracked.some(path => path.startsWith(`${root}/`)));
    if (lost) return 'a sync folder with synced notes does not exist';
    return null;
}
