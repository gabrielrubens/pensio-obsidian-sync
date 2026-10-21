/**
 * Notes too large to sync, remembered by path and modification time (plugin
 * 0.7.3, review CRIT-4).
 *
 * ⛔ THE BUG: a note over 1 MB was skipped with "File too large", and that
 * line made every sync a failure. The time of the last sync never moved and
 * the settings card said *Not syncing*, although every other note synced:
 * Gabriel's `pensio-prod-demo` vault holds a 1.1 MB note and was "not
 * syncing" because of it, forever.
 *
 * ⭐ Now such a note is a warning about that note, not a failed sync. The card
 * stays *Connected* and adds a line naming it (`tooLargeLine`). The note is
 * remembered at the modification time it had, so it is not read again every
 * five minutes, and it is checked again once she edits it. A note that is
 * deleted, moved out of the sync folders or made smaller is forgotten by the
 * next sync, which takes the line away.
 * 🧪 `src/sync/__tests__/tooLargeNote.test.ts`.
 */

export interface TooLargeNote {
    /** The note's modification time when it was found too large (ms). */
    mtime: number;
    /** What its own request would have been, in bytes. */
    bytes: number;
    /**
     * Measured with its text once (plugin 0.7.4, `serverCapabilities.ts`).
     * ⭐ A note found too large with its text twice is read again once the
     * server says it takes it once: it may fit now.
     */
    textOnce?: boolean;
}

export class TooLargeNotes {
    private notes = new Map<string, TooLargeNote>();
    /** The notes this sync has found too large so far; null between syncs. */
    private next: Map<string, TooLargeNote> | null = null;

    /** A sync starts: a note it does not find too large again is forgotten. */
    begin(): void {
        this.next = new Map();
    }

    /**
     * True when this note has not changed since it was found too large, and
     * would go the same way (`textOnce`): it still is, and it need not be read
     * again.
     */
    unchanged(path: string, mtime: number, textOnce = false): boolean {
        const known = this.notes.get(path);
        if (!known || known.mtime !== mtime || (known.textOnce ?? false) !== textOnce) return false;
        this.next?.set(path, known);
        return true;
    }

    /** This note is too large to sync, as it is now. */
    add(path: string, mtime: number, bytes: number, textOnce = false): void {
        console.warn(`Pensio: ${path} is too large to sync (its request would be ${bytes} bytes)`);
        const note = copied({ mtime, bytes, textOnce });
        if (this.next) this.next.set(path, note);
        else this.notes.set(path, note);
    }

    /** The sync looked at every note: keep only what it found too large. */
    finish(): void {
        if (this.next) this.notes = this.next;
        this.next = null;
    }

    /** The paths of the notes too large to sync, in order. */
    paths(): string[] {
        return [...this.notes.keys()].sort();
    }

    toState(): Record<string, TooLargeNote> {
        const state: Record<string, TooLargeNote> = {};
        for (const [path, note] of this.notes) state[path] = copied(note);
        return state;
    }

    restore(state: Record<string, TooLargeNote> | undefined): void {
        this.notes = new Map();
        for (const path of Object.keys(state ?? {})) {
            const note: TooLargeNote = (state ?? {})[path];
            this.notes.set(path, copied(note));
        }
    }

    clear(): void {
        this.notes = new Map();
        this.next = null;
    }
}

/** A note's three fields, and nothing else a saved state may carry. */
function copied(note: TooLargeNote): TooLargeNote {
    return note.textOnce ? { mtime: note.mtime, bytes: note.bytes, textOnce: true } : { mtime: note.mtime, bytes: note.bytes };
}

/** A note's name, as Obsidian shows it: the file name without `.md`. */
function noteName(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
}

/**
 * "1 note is too large to sync: Long note", or null when none is. ⭐ The one
 * wording, for the card, the status bar and the notices; it names the notes
 * so she can find them.
 */
export function tooLargeLine(paths: string[]): string | null {
    if (paths.length === 0) return null;
    const shown = paths.slice(0, 2).map(noteName).join(', ');
    const more = paths.length > 2 ? ` and ${paths.length - 2} more` : '';
    const counted = paths.length === 1 ? '1 note is' : `${paths.length} notes are`;
    return `${counted} too large to sync: ${shown}${more}`;
}
