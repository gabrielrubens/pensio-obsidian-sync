import {
    daysToDrain,
    isQuotaLimited,
    isThrottled,
    quotaDayKey,
    quotaNoticeMessage,
    quotaSummaryLine,
    shouldNotifyQuota,
} from '../sync/quotaNotice';
import { ProcessingStatus } from '../types';

/** Free account that has spent today's cap with a big import still queued. */
const throttled: ProcessingStatus = {
    processed_today: 10,
    daily_limit: 10,
    remaining_today: 0,
    pending: 571,
};

/** Free account with quota left. */
const withinQuota: ProcessingStatus = {
    processed_today: 3,
    daily_limit: 10,
    remaining_today: 7,
    pending: 40,
};

/** Pro account — the backend reports 0 / -1 for unlimited. */
const unlimited: ProcessingStatus = {
    processed_today: 120,
    daily_limit: 0,
    remaining_today: -1,
    pending: 30,
};

describe('quota predicates', () => {
    it('treats daily_limit 0 as unlimited, not as a cap of zero', () => {
        expect(isQuotaLimited(unlimited)).toBe(false);
        expect(isThrottled(unlimited)).toBe(false);
    });

    it('is throttled only when the cap is spent and work is waiting', () => {
        expect(isThrottled(throttled)).toBe(true);
        expect(isThrottled(withinQuota)).toBe(false);
        expect(isThrottled({ ...throttled, pending: 0 })).toBe(false);
    });

    it('rounds the drain estimate up — a partial day is still a day', () => {
        expect(daysToDrain(throttled)).toBe(58);
        expect(daysToDrain({ ...throttled, pending: 1 })).toBe(1);
        expect(daysToDrain(unlimited)).toBe(0);
    });
});

describe('shouldNotifyQuota', () => {
    const day = new Date('2026-07-29T11:00:00Z');

    it('notifies the first time the cap is hit today', () => {
        expect(shouldNotifyQuota(throttled, null, day)).toBe(true);
    });

    it('stays silent for the rest of the same quota day', () => {
        // Sync runs every five minutes; "still over quota" is not news.
        expect(shouldNotifyQuota(throttled, '2026-07-29', day)).toBe(false);
    });

    it('speaks again once the quota has reset', () => {
        expect(shouldNotifyQuota(throttled, '2026-07-28', day)).toBe(true);
    });

    it('never notifies an unthrottled or unknown account', () => {
        expect(shouldNotifyQuota(withinQuota, null, day)).toBe(false);
        expect(shouldNotifyQuota(unlimited, null, day)).toBe(false);
        // Older / self-hosted backends send no status at all.
        expect(shouldNotifyQuota(null, null, day)).toBe(false);
        expect(shouldNotifyQuota(undefined, null, day)).toBe(false);
    });

    it('keys the day in UTC, matching the server quota reset', () => {
        // 23:30 UTC-day boundary: local time in e.g. UTC+13 is already
        // tomorrow, but the server quota has not reset yet.
        expect(quotaDayKey(new Date('2026-07-29T23:30:00Z'))).toBe('2026-07-29');
        expect(quotaDayKey(new Date('2026-07-30T00:30:00Z'))).toBe('2026-07-30');
    });
});

describe('message copy', () => {
    it('leads with reassurance, not the upsell', () => {
        const msg = quotaNoticeMessage(throttled);
        expect(msg).toContain('synced and safe');
        expect(msg).toContain('10 of 10');
        expect(msg).toContain('571 still waiting');
        expect(msg).toContain('58 days');
    });

    it('says "day" when a single day is left', () => {
        expect(quotaNoticeMessage({ ...throttled, pending: 5 })).toContain('about 1 day.');
    });

    it('summarises the capped, drained and unlimited cases distinctly', () => {
        expect(quotaSummaryLine(throttled)).toContain('571 waiting');
        expect(quotaSummaryLine({ ...throttled, pending: 0 })).toContain('up to date');
        expect(quotaSummaryLine(unlimited)).toContain('processing now');
        expect(quotaSummaryLine({ ...unlimited, pending: 0 })).toBe('Emotion analysis: up to date');
        expect(quotaSummaryLine(null)).toBeNull();
    });
});
