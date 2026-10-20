import { Notice } from 'obsidian';
import { RefreshError } from './auth/tokenManager';
import { HttpError, RefusalDetails, SyncFailure, toRequestError } from './errors';

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
 * - a failure says what happened and what to do next, in plain words, and
 *   ⛔ (0.7.1) only promises what will happen: "the plugin tries again every 5
 *   minutes" only where the automatic sync really is running. 0.7.0 said it
 *   after a Test connection, a Connect and a setup code too, none of which is
 *   ever retried, and called every 429 "too many requests from this vault",
 *   when no limit is per vault (review F14).
 */

/** How long a notice stays, in ms. `0` is Obsidian's "until dismissed". */
export const NOTICE_MS = {
    info: 6000,
    failure: 0,
} as const;

const PREFIX = 'Pensio: ';

/**
 * A notice that replaces its predecessor rather than stacking under it. Before
 * 0.7.1 a reconnect could leave "Sync failed …" and "The connection test
 * failed …" on screen together for the same cause (review F27).
 */
export type NoticeSlot = 'connection';
const slots = new Map<NoticeSlot, Notice>();

/** Show a notice from Pensio; in a slot, it replaces the one shown there. */
export function notify(message: string, duration: number = NOTICE_MS.info, slot?: NoticeSlot): Notice {
    if (slot) slots.get(slot)?.hide();
    const notice = new Notice(message.startsWith(PREFIX) ? message : PREFIX + message, duration);
    if (slot) slots.set(slot, notice);
    return notice;
}

/** Take a slot's notice away, when what it said is no longer true. */
export function clearNotice(slot: NoticeSlot): void {
    slots.get(slot)?.hide();
    slots.delete(slot);
}

export type FailureKind = 'offline' | 'expired' | 'busy' | 'server' | 'refused' | 'notes' | 'other';

/** What went wrong (`reason`) and what to do about it (`next`). */
export interface Explanation {
    kind: FailureKind;
    reason: string;
    next: string;
    /** When it may be tried again (ms), when the server said. */
    retryAt?: number;
}

export interface FailureContext {
    /** The Server URL, to name a self-hosted server instead of Pensio. */
    apiUrl: string;
    /**
     * The plugin will try this again by itself: the automatic sync is running.
     * ⛔ False for anything she pressed that nothing repeats (Test connection,
     * Connect, a setup code, the card's check).
     */
    retries: boolean;
    /**
     * What to do when the server refused the request (a 4xx with a message),
     * where only the caller knows: a spent setup code needs a new one. Every
     * other kind keeps its own advice, so offline still says to check the
     * internet.
     */
    whenRefused?: string;
    /** The clock, for "try again after 15:42". */
    now?: () => number;
}

// Electron's net::ERR_*, Node's error codes, and the WebView wordings that
// iOS and Android use for a request that never reached a server.
const UNREACHABLE = /net::|ERR_INTERNET|ERR_NAME|ERR_CONNECTION|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|failed to fetch|networkerror|network request failed|network connection was lost|timed? ?out|offline|could not connect|unable to resolve|internet connection appears/i;

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

/** 15:42, in her own clock's format. */
export function clockTime(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** What a refusal said beyond its status, wherever it came from. */
function detailsOf(error: unknown): RefusalDetails {
    if (error instanceof HttpError || error instanceof RefreshError) return error.details;
    return {};
}

/** Which limit refused it, in her words. Unknown when an older server did not say. */
function busyReason(scope: string | undefined, where: string): string {
    switch (scope) {
        case 'account':
            return `Your ${where} account has made more requests this hour than ${where} allows, counting every device and app you connected.`;
        case 'network':
        case 'network_connect':
            return 'There have been too many connection attempts from your network this hour.';
        case 'network_refresh':
            return 'There have been too many sign-in renewals from your network this hour.';
        default:
            return `${where} is limiting requests for now.`;
    }
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
    const now = context.now ?? Date.now;
    const refreshed = error instanceof RefreshError ? error : null;
    // A refresh that got an answer carries its status; no status means no answer.
    const status = refreshed ? refreshed.status : toRequestError(error).status;
    const message = toRequestError(error).message;

    if ((refreshed && refreshed.reason === 'auth-invalid') || (!refreshed && status === 401)) {
        return {
            kind: 'expired',
            reason: 'The connection to Pensio has stopped.',
            next: 'Open Settings → Pensio Journaling Sync and press Connect to Pensio. Your notes and sync history are kept.',
        };
    }
    const unreachable = (refreshed !== null && status === undefined)
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
                context.retries ? RETRY_AUTOMATIC : '',
            ),
        };
    }
    if (status === 429) {
        const { scope, retryAfter } = detailsOf(error);
        const retryAt = retryAfter ? now() + retryAfter * 1000 : undefined;
        const next = retryAt
            ? (context.retries
                ? `Nothing is lost. Syncing starts again by ${clockTime(retryAt)}.`
                : `Nothing is lost. Try again after ${clockTime(retryAt)}.`)
            : (context.retries
                ? `Nothing is lost. ${RETRY_AUTOMATIC}`
                : 'Nothing is lost. Try again later: this can last up to an hour.');
        return { kind: 'busy', reason: busyReason(scope, where), next, retryAt };
    }
    if (status !== undefined && status >= 500) {
        return {
            kind: 'server',
            reason: `${where}’s server had a problem (error ${status}).`,
            next: joinSentences('Nothing was lost.', context.retries ? RETRY_AUTOMATIC : 'Try again in a few minutes.'),
        };
    }
    if (refreshed) {
        return {
            kind: 'refused',
            reason: `${where} didn’t accept this vault’s sign-in renewal (error ${status}).`,
            next: 'Press Connect to Pensio to connect again. Your notes and sync history are kept.',
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
        // Not the developer console: a phone has none (review F37).
        next: 'If it keeps happening, press the bug icon at the top of the plugin’s settings to report it.',
    };
}

/** The words of a failure notice, without the prefix: "<what> failed. <why> <next>". */
export function failureMessage(what: string, error: unknown, context: FailureContext): string {
    const { reason, next } = explainFailure(error, context);
    return joinSentences(`${what} failed.`, reason, next);
}

/** A failure notice: says what failed, why, and what to do; stays until dismissed. */
export function notifyFailure(what: string, error: unknown, context: FailureContext, slot?: NoticeSlot): Notice {
    return notify(failureMessage(what, error, context), NOTICE_MS.failure, slot);
}
