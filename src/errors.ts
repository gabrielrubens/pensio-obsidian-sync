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

/** What the server said about a refused request, beyond its status. */
export interface RefusalDetails {
    /** The stable error code (docs/admin/api-errors.md), e.g. 'rate_limited'. */
    code?: string;
    /** Which limit refused it: 'account', 'network', 'network_refresh', … */
    scope?: string;
    /** Seconds until it may be tried again (Retry-After). */
    retryAfter?: number;
}

/** An Error carrying an HTTP status, synthesized from a non-2xx response. */
export class HttpError extends Error {
    constructor(message: string, readonly status?: number, readonly details: RefusalDetails = {}) {
        super(message);
        this.name = 'HttpError';
    }
}

/** The headers and body of a refused response, as requestUrl returns them. */
interface RefusedResponse {
    status: number;
    headers?: Record<string, string>;
    json?: unknown;
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
    if (!headers) return undefined;
    const key = Object.keys(headers).find(k => k.toLowerCase() === name);
    return key ? headers[key] : undefined;
}

/**
 * The HttpError for a refused response: the server's own message (the error
 * envelope in api/errors.py), its code and scope, and Retry-After.
 *
 * ⛔ Before 0.7.1 an ordinary request let requestUrl throw on a 4xx/5xx, and
 * that rejection carries only the status and the headers, never the body. So
 * every refusal read "Request failed, status 429", and a Retry-After the
 * server sent could not be seen.
 */
export function refusal(response: RefusedResponse, fallbackMessage: string): HttpError {
    let body: { error?: { message?: string; code?: string; scope?: string; retry_after?: unknown; fields?: { code?: string[] } }; detail?: string } | undefined;
    try {
        body = response.json as typeof body;
    } catch {
        body = undefined; // not JSON: keep the fallback message
    }
    const message = body?.error?.fields?.code?.[0] || body?.error?.message || body?.detail || fallbackMessage;
    const retryAfter = Number(header(response.headers, 'retry-after') ?? body?.error?.retry_after);
    return new HttpError(message, response.status, {
        code: body?.error?.code,
        scope: body?.error?.scope,
        retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    });
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
