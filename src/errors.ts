/**
 * Typed error helpers.
 *
 * Obsidian's `requestUrl` rejects with an object carrying an HTTP `status`
 * and (sometimes) a parsed `json` body. `catch` binds the value as `unknown`,
 * so these helpers narrow it to a well-typed shape instead of reaching into
 * `any` (which trips `@typescript-eslint/no-unsafe-*`).
 */

/** Shape of errors thrown by Obsidian's requestUrl and this plugin's HTTP layer. */
export interface RequestError {
    status?: number;
    json?: unknown;
    message?: string;
}

/** Narrow an unknown caught value to the RequestError shape (never throws). */
export function toRequestError(error: unknown): RequestError {
    if (error && typeof error === 'object') {
        const e = error as Record<string, unknown>;
        return {
            status: typeof e.status === 'number' ? e.status : undefined,
            json: e.json,
            message: typeof e.message === 'string' ? e.message : undefined,
        };
    }
    return {};
}

/** A human-readable message for a caught value (for Notices / logs). */
export function errorMessage(error: unknown, fallback = 'Unknown error'): string {
    return toRequestError(error).message ?? fallback;
}

/** An Error carrying an HTTP status, synthesized from a non-2xx response. */
export class HttpError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = 'HttpError';
    }
}

/**
 * A sync that ran but could not finish everything.
 *
 * ⭐ `underlying` is the first request that failed outright (offline, a server
 * error, a stopped connection), so a notice can say *which*. Before 0.7.0 the
 * engine threw a plain Error whose message was its own bookkeeping — "Sync
 * completed with 1 error(s): Bulk sync chunk: net::ERR_…" — and that was the
 * whole notice, for a few seconds. `problems` are the per-note lines, kept
 * for the console.
 */
export class SyncFailure extends Error {
    constructor(readonly problems: string[], readonly underlying?: unknown) {
        super(`Sync completed with ${problems.length} error(s): ${problems[0]}`);
        this.name = 'SyncFailure';
    }
}
