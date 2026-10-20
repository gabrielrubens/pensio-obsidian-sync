import { Notice } from 'obsidian';
import { RefreshError } from './auth/tokenManager';
import { SyncFailure, toRequestError } from './errors';

/**
 * Every notice the plugin shows goes through here (plugin 0.7.0).
 *
 * ⛔ The bug: a failed sync showed "Sync failed: Sync completed with 1
 * error(s): Bulk sync chunk: …" for Obsidian's default few seconds. It did not
 * say it came from Pensio, so it could have been any plugin; it was gone
 * before it could be read; and it quoted the engine's bookkeeping instead of
 * saying what went wrong and what to do.
 *
 * ⭐ Three rules, each held by `src/__tests__/notices.test.ts`:
 * - every notice starts with "Pensio:", and none is made anywhere but here;
 * - a failure stays until it is dismissed;
 * - a failure says what happened and what to do next, in plain words.
 */

/** How long a notice stays, in ms. `0` is Obsidian's "until dismissed". */
export const NOTICE_MS = {
    info: 6000,
    failure: 0,
} as const;

const PREFIX = 'Pensio: ';

/** Show a notice from Pensio. */
export function notify(message: string, duration: number = NOTICE_MS.info): Notice {
    return new Notice(message.startsWith(PREFIX) ? message : PREFIX + message, duration);
}

export type FailureKind = 'offline' | 'expired' | 'busy' | 'server' | 'refused' | 'notes' | 'other';

/** What went wrong (`reason`) and what to do about it (`next`). */
export interface Explanation {
    kind: FailureKind;
    reason: string;
    next: string;
}

export interface FailureContext {
    /** The Server URL, to name a self-hosted server instead of Pensio. */
    apiUrl: string;
    /** Auto-sync is on, so a failed sync is retried without her. */
    autoSync: boolean;
    /**
     * What to do when the server refused the request (a 4xx with a message),
     * where only the caller knows: a spent setup code needs a new one. Every
     * other kind keeps its own advice, so offline still says to check the
     * internet.
     */
    whenRefused?: string;
}

// Electron's net::ERR_*, Node's error codes, and the WebView wordings that
// iOS and Android use for a request that never reached a server.
const UNREACHABLE = /net::|ERR_INTERNET|ERR_NAME|ERR_CONNECTION|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|failed to fetch|networkerror|network request failed|network connection was lost|timed? ?out|offline|could not connect|unable to resolve/i;

const RETRY_AUTOMATIC = 'The plugin tries again every 5 minutes.';

/** Pensio, or the host of a self-hosted server. */
function serverName(apiUrl: string): string {
    try {
        const host = new URL(apiUrl || 'https://pensio.app').hostname.replace(/^www\./, '');
        return host === 'pensio.app' ? 'Pensio' : host;
    } catch {
        return 'the server';
    }
}

/** A server's message as a sentence: capitalised, ending in a full stop. */
function sentence(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return '';
    const capitalised = trimmed[0].toUpperCase() + trimmed.slice(1);
    return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

function joinSentences(...parts: string[]): string {
    return parts.filter(Boolean).join(' ');
}

/** Turn anything a request or a sync can throw into plain words. */
export function explainFailure(error: unknown, context: FailureContext): Explanation {
    if (error instanceof SyncFailure) {
        if (error.underlying !== undefined) return explainFailure(error.underlying, context);
        const count = error.problems.length;
        const first = error.problems[0] ?? '';
        return {
            kind: 'notes',
            reason: `${count} ${count === 1 ? 'note' : 'notes'} couldn’t sync. ${sentence(first)}`,
            next: 'Everything else synced.',
        };
    }

    const where = serverName(context.apiUrl);
    const selfHosted = where !== 'Pensio';
    const { status, message } = toRequestError(error);
    const retry = context.autoSync ? RETRY_AUTOMATIC : 'Try again in a few minutes.';

    if ((error instanceof RefreshError && error.reason === 'auth-invalid') || status === 401) {
        return {
            kind: 'expired',
            reason: 'The connection to Pensio has stopped.',
            next: 'Open Settings → Pensio Journaling Sync and press Connect to Pensio. Your notes and sync history are kept.',
        };
    }
    const unreachable = (error instanceof RefreshError && error.reason === 'transient')
        || (status === undefined && UNREACHABLE.test(message ?? ''))
        || (typeof navigator !== 'undefined' && navigator.onLine === false);
    if (unreachable) {
        return {
            kind: 'offline',
            reason: `Couldn’t reach ${where}.`,
            next: joinSentences(
                selfHosted
                    ? 'Check your internet connection and the Server URL under Advanced.'
                    : 'Check your internet connection.',
                context.autoSync ? RETRY_AUTOMATIC : '',
            ),
        };
    }
    if (status === 429) {
        return {
            kind: 'busy',
            reason: `${where} is getting too many requests from this vault.`,
            next: retry,
        };
    }
    if (status !== undefined && status >= 500) {
        return {
            kind: 'server',
            reason: `${where}’s server had a problem (error ${status}).`,
            next: joinSentences('Nothing was lost.', retry),
        };
    }
    if (status !== undefined && status >= 400) {
        return {
            kind: 'refused',
            reason: sentence(message ?? '') || `${where} refused the request (error ${status}).`,
            next: context.whenRefused ?? '',
        };
    }
    return {
        kind: 'other',
        reason: sentence(message ?? '') || 'Something went wrong.',
        next: 'Turn on Debug mode under Advanced to see the details in the developer console.',
    };
}

/** The words of a failure notice, without the prefix: "<what> failed. <why> <next>". */
export function failureMessage(what: string, error: unknown, context: FailureContext): string {
    const { reason, next } = explainFailure(error, context);
    return joinSentences(`${what} failed.`, reason, next);
}

/** A failure notice: says what failed, why, and what to do; stays until dismissed. */
export function notifyFailure(what: string, error: unknown, context: FailureContext): Notice {
    return notify(failureMessage(what, error, context), NOTICE_MS.failure);
}
