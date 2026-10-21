import { BulkSyncItem, BulkSyncResponse, Capabilities, CapabilitiesState } from '../types';
import { itemBytes, tooLargeAlone } from './chunks';

/**
 * What the Pensio server this vault syncs with says it can do, remembered
 * from its last bulk answer (plugin 0.7.4, review CRIT-4).
 *
 * ⛔ THE BUG: each note's text went in a request twice, as `content_html` and
 * `content_plain`, because the server hashed and stored only the second and
 * nothing filled it from the first. With Pensio's 2 MiB limit on a request,
 * a note over about 1 MB could not sync at all.
 *
 * ⭐ A server that fills `content_plain` itself says `content_once` in every
 * bulk answer, and to that server, and only to it, a note's text goes once:
 * notes up to about the whole 2 MiB now sync. `chunks.ts` measures the body
 * actually sent, so the request sizes follow by themselves.
 *
 * ⛔ NEVER ASSUMED. A server that has not answered yet, an older one, a
 * self-hosted one that has not updated, or a different Server URL gets the
 * text twice, as before: one that does not fill `content_plain` would store
 * the note with no text and no hash, and every sync after that would send
 * the note to the model again.
 * ⛔ AND NEVER TRUSTED PAST ITS ANSWER. A server rolled back to an image
 * without `content_once` takes a note sent once with a 200 and keeps no text
 * for it (a new note), or its old text (an edited or moved one). Every answer
 * says it again, so a note that went once in a request whose answer does not
 * say it is not counted as synced: the next sync sends it again, in full
 * (`lostText`). Decided 2026-10-21 (Gabriel, option B).
 * 🧪 `src/sync/__tests__/textOnce.test.ts`.
 */
export class ServerCapabilities {
    private heard: CapabilitiesState | null = null;

    /** `server` is the Server URL now: an answer counts only for the server that gave it. */
    constructor(private server: () => string) { }

    /** A bulk answer: what this server says it can do. Absent means nothing more than create, update and delete. */
    answered(result: BulkSyncResponse): void {
        const capabilities: Capabilities = {};
        for (const [name, value] of Object.entries(result.capabilities ?? {})) {
            if (typeof value === 'boolean') capabilities[name as keyof Capabilities] = value;
        }
        this.heard = { server: this.server(), capabilities };
    }

    /** Has the server this vault syncs with answered a bulk request? */
    known(): boolean {
        return this.heard !== null && this.heard.server === this.server();
    }

    /** True only when this server said it fills `content_plain` itself. */
    textOnce(): boolean {
        return this.known() && this.heard?.capabilities.content_once === true;
    }

    /**
     * The item as this server wants it: without `content_plain` when it said
     * `content_once`. ⛔ Only an exact copy of `content_html` is left out,
     * since that is what the server puts back.
     */
    shaped(item: BulkSyncItem): BulkSyncItem {
        return (this.textOnce() && withoutTheCopy(item)) || item;
    }

    /**
     * Did this item go with its text once? What a too-large note is remembered
     * by (`tooLarge.ts`): an item built before the server said `content_once`
     * still carries the copy, whatever the server says by the time it is
     * refused.
     */
    wentOnce(item: BulkSyncItem): boolean {
        return this.textOnce() && withoutTheCopy(item) === null;
    }

    /**
     * The items of this request that went with their text once, answered by a
     * server that does not say `content_once` (a rollback): stored without
     * their text, so they must be sent again in full. A person note's text is
     * never doubled (`metadata.raw_content`), so it is never one of them.
     */
    lostText(items: BulkSyncItem[], result: BulkSyncResponse): Set<BulkSyncItem> {
        if (result.capabilities?.content_once === true) return new Set();
        return new Set(items.filter(sentWithoutTheCopy));
    }

    /**
     * Before a note is called too large: if it would fit with its text once
     * and this server has not said whether it takes that, ask it once, with
     * `ask` (an empty bulk request). True when the note can now go once.
     *
     * ⭐ Without this, a vault whose only note left to sync is a long one
     * would never send anything that brings an answer, so it would never
     * learn: Gabriel's `pensio-prod-demo` vault, on the first sync after the
     * plugin is updated.
     */
    async askIfOnceFits(item: BulkSyncItem, ask: () => Promise<BulkSyncResponse>): Promise<boolean> {
        if (this.known()) return false;
        const once = withoutTheCopy(item);
        if (!once || tooLargeAlone(itemBytes(once))) return false;
        this.answered(await ask());
        return this.textOnce();
    }

    toState(): CapabilitiesState | undefined {
        return this.heard ? { server: this.heard.server, capabilities: { ...this.heard.capabilities } } : undefined;
    }

    restore(state: CapabilitiesState | undefined): void {
        this.heard = state ? { server: state.server, capabilities: { ...state.capabilities } } : null;
    }

    clear(): void {
        this.heard = null;
    }
}

/** An entry that went with its text in `content_html` alone. */
function sentWithoutTheCopy(item: BulkSyncItem): boolean {
    const data = item.data;
    return data !== undefined && 'content_html' in data && !('content_plain' in data);
}

/** The item with its text once, or null when its `content_plain` is not a copy of `content_html`. */
function withoutTheCopy(item: BulkSyncItem): BulkSyncItem | null {
    const data = item.data;
    if (!data || !('content_plain' in data) || data.content_plain !== data.content_html) return null;
    const once = { ...data };
    delete once.content_plain;
    return { ...item, data: once };
}
