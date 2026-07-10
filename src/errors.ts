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
