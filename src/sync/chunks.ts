import { toRequestError } from '../errors';
import { BulkSyncItem, BulkSyncResponse } from '../types';

/**
 * How much one bulk request carries (plugin 0.7.3, review CRIT-4).
 *
 * ⛔ THE BUG: notes went fifty to a request, whatever their size, and each
 * note's text is in the body twice (`content_html` and `content_plain`: the
 * server hashes and stores the second, so it cannot be left out). Pensio
 * refuses a body over 2 MiB with an HTML 400 before the sync code runs, so
 * fifty long notes failed on the same request every sync, forever, and
 * nothing after them synced either.
 *
 * ⭐ Now a request is measured in the bytes it sends, and stays under
 * `CHUNK_BUDGET_BYTES`. A note bigger than that goes alone; a note whose own
 * request is over `REQUEST_LIMIT_BYTES` cannot sync at all, and the caller
 * says so for that note (`tooLarge.ts`) instead of failing the sync.
 * 🧪 `src/sync/__tests__/requestSize.test.ts`.
 */

/**
 * The body of `POST /api/v1/sync/bulk/`. ⛔ The one place it is shaped:
 * `ApiClient.bulkSync` sends exactly this, and the sizes below are measured
 * on it, so the two cannot drift apart.
 */
export function bulkPayload(entries: BulkSyncItem[], people: BulkSyncItem[]): { entries: BulkSyncItem[]; people: BulkSyncItem[] } {
    return { entries, people };
}

/**
 * Pensio refuses a request body larger than this: Django's
 * `DATA_UPLOAD_MAX_MEMORY_SIZE` (`config/settings/base.py`).
 * 🧪 `tests/api/test_a_sync_request_too_large_says_so.py` fails if the two
 * differ.
 */
export const REQUEST_LIMIT_BYTES = 2 * 1024 * 1024;

/** What one request aims to stay under: a quarter below the limit. */
export const CHUNK_BUDGET_BYTES = 1.5 * 1024 * 1024;

/** The two parts of a bulk request a note can go in. */
export type Section = 'entries' | 'people';

/** And never more notes than this in one request, however small they are. */
export const MAX_NOTES_PER_REQUEST = 50;

const encoder = new TextEncoder();

/** What a string weighs on the wire: UTF-8 bytes, never characters. */
export function utf8Bytes(text: string): number {
    return encoder.encode(text).length;
}

/** `{"entries":[],"people":[]}`: the body with no notes in it. */
const EMPTY_BODY_BYTES = utf8Bytes(JSON.stringify(bulkPayload([], [])));

/** One note's share of a request body. */
export function itemBytes(item: BulkSyncItem): number {
    return utf8Bytes(JSON.stringify(item));
}

/**
 * The body bytes of a request carrying notes of these sizes, in either
 * section: the empty body, each note, and a comma between two.
 */
export function requestBytes(sizes: number[]): number {
    if (sizes.length === 0) return EMPTY_BODY_BYTES;
    return EMPTY_BODY_BYTES + sizes.reduce((sum, size) => sum + size, 0) + sizes.length - 1;
}

/** A note whose own request is more than Pensio takes: it cannot sync. */
export function tooLargeAlone(size: number): boolean {
    return requestBytes([size]) > REQUEST_LIMIT_BYTES;
}

export interface ChunkPlan {
    /** Send one request. */
    post: (items: BulkSyncItem[]) => Promise<BulkSyncResponse>;
    /** Pensio answered the request carrying these notes. */
    answered: (items: BulkSyncItem[], result: BulkSyncResponse) => void;
    /** Pensio said this note, alone, is too large (a 413). */
    refused: (item: BulkSyncItem) => void;
    budget?: number;
    maxNotes?: number;
}

/**
 * Send these notes in order, in requests of at most `budget` bytes and
 * `maxNotes` notes. A note bigger than the budget goes in a request of its
 * own.
 *
 * ⭐ A server that still says a request is too large (a 413: one with a
 * smaller limit than Pensio's) gets the same notes again in requests half the
 * size, and the rest of this sync keeps that size. A note it refuses alone is
 * `refused`, and the rest go on.
 *
 * ⛔ Any other failure is thrown, so the caller ends the sync there: every
 * later request would fail the same way (review F20).
 */
export async function sendInChunks(items: BulkSyncItem[], plan: ChunkPlan): Promise<void> {
    const sizes = items.map(itemBytes);
    const maxNotes = plan.maxNotes ?? MAX_NOTES_PER_REQUEST;
    let budget = plan.budget ?? CHUNK_BUDGET_BYTES;
    let start = 0;
    while (start < items.length) {
        // A note always goes, alone if it is bigger than the budget.
        let end = start + 1;
        let bytes = requestBytes([sizes[start]]);
        while (end < items.length && end - start < maxNotes && bytes + 1 + sizes[end] <= budget) {
            bytes += 1 + sizes[end];
            end++;
        }
        const chunk = items.slice(start, end);
        let result: BulkSyncResponse;
        try {
            result = await plan.post(chunk);
        } catch (error) {
            if (toRequestError(error).status !== 413) throw error;
            if (chunk.length === 1) {
                plan.refused(chunk[0]);
                start = end;
            } else {
                // Strictly smaller than this chunk, so the next one holds fewer notes.
                budget = Math.floor(bytes / 2);
            }
            continue;
        }
        plan.answered(chunk, result);
        start = end;
    }
}
