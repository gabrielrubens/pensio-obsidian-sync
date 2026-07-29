/**
 * Free-tier emotion-analysis quota — the plugin's side of the throttle.
 *
 * Pensio analyzes a limited number of entries per day on free accounts
 * (10/day at time of writing; Pro is unlimited). Importing a vault of a few
 * hundred notes therefore drains over weeks. That is deliberate — but the
 * plugin never said so. The backend has sent `processing_status` on every
 * bulk-sync response since v0.5.3, explicitly "for plugin UX", and nothing
 * ever read it: a user could import 600 notes, watch the sync succeed, and
 * then see nothing happen for two months with no explanation anywhere in
 * Obsidian.
 *
 * This module is the decision layer, kept free of Obsidian imports so it can
 * be tested directly: given a status and when we last spoke up, should we say
 * something, and what should it say?
 */

import { ProcessingStatus } from '../types';

/**
 * Quota day key (UTC).
 *
 * The server counts "today" against UTC midnight, so deduping on the UTC day
 * makes the notice reappear exactly when the quota actually resets rather
 * than at the user's local midnight.
 */
export function quotaDayKey(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
}

/** True when this account has a daily cap at all (Pro reports 0 = unlimited). */
export function isQuotaLimited(status: ProcessingStatus): boolean {
    return status.daily_limit > 0;
}

/** True when the cap is spent AND there is still a backlog waiting on it. */
export function isThrottled(status: ProcessingStatus): boolean {
    return isQuotaLimited(status) && status.remaining_today <= 0 && status.pending > 0;
}

/** Whole days to drain the backlog at the current cap. */
export function daysToDrain(status: ProcessingStatus): number {
    if (!isQuotaLimited(status)) return 0;
    return Math.ceil(status.pending / status.daily_limit);
}

/**
 * Should we interrupt the user right now?
 *
 * At most once per quota day. Sync runs on a timer, so without this the
 * plugin would repeat the same unchanging fact every few minutes — the exact
 * failure the server-side throttle event had.
 */
export function shouldNotifyQuota(
    status: ProcessingStatus | null | undefined,
    lastNoticeDay: string | null | undefined,
    now: Date = new Date()
): boolean {
    if (!status) return false;
    if (!isThrottled(status)) return false;
    return lastNoticeDay !== quotaDayKey(now);
}

/** The one-a-day interruption. Plain text — Obsidian notices are not markdown. */
export function quotaNoticeMessage(status: ProcessingStatus): string {
    const days = daysToDrain(status);
    const dayWord = days === 1 ? 'day' : 'days';
    return (
        `Pensio: daily analysis limit reached.\n\n` +
        `${status.processed_today} of ${status.daily_limit} entries analyzed today, ` +
        `${status.pending} still waiting.\n\n` +
        `Your notes are synced and safe — free accounts analyze ` +
        `${status.daily_limit} entries per day, so the rest will finish over ` +
        `about ${days} ${dayWord}. Click here to upgrade for instant analysis.`
    );
}

/** Persistent one-liner for the settings card. Null when there is nothing to say. */
export function quotaSummaryLine(status: ProcessingStatus | null | undefined): string | null {
    if (!status) return null;
    if (!isQuotaLimited(status)) {
        return status.pending > 0
            ? `Emotion analysis: ${status.pending} entries queued — processing now`
            : 'Emotion analysis: up to date';
    }
    if (status.pending === 0) {
        return `Emotion analysis: up to date (${status.processed_today} of ${status.daily_limit} today)`;
    }
    const days = daysToDrain(status);
    const dayWord = days === 1 ? 'day' : 'days';
    return (
        `Emotion analysis: ${status.processed_today} of ${status.daily_limit} today — ` +
        `${status.pending} waiting, about ${days} ${dayWord} to finish`
    );
}
