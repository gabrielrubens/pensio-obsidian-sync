/**
 * The status card says whether this vault is syncing, in every state, and
 * carries the one button that state needs.
 *
 * ⭐ Design "B · Status card" (plugin 0.7.0). Before it, *connected* was one
 * row among the buttons ("✓ Connected as …"), and nothing said whether the
 * last sync had worked, so a vault that had stopped syncing still looked
 * connected.
 *
 * Sabotage-checked (2026-10-20), each alone then restored:
 * - cardView ignoring `problem` → "says when the last sync failed" RED;
 * - the connect action's search name shortened to "Connect" → "is found as
 *   Connect to Pensio" RED;
 * - timeAgo counting hours as minutes → the timeAgo test RED.
 */
import { HttpError } from '../errors';
import { explainFailure } from '../notices';
import { CardFacts, cardSearchName, cardView, timeAgo } from '../statusCard';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const MIN = 60 * 1000;

const facts = (overrides: Partial<CardFacts>): CardFacts => ({
    state: 'connected',
    email: 'gabriel@example.com',
    tracked: 412,
    lastSync: NOW - 3 * MIN,
    problem: null,
    checking: false,
    checkProblem: null,
    now: NOW,
    ...overrides,
});

describe('the status card', () => {
    it('says who is connected, how much has synced and when', () => {
        expect(cardView(facts({}))).toEqual({
            tone: 'ok', icon: 'check', title: 'Connected',
            detail: 'gabriel@example.com · 412 notes · synced 3 min ago',
            signUp: false, action: 'sync',
        });
        expect(cardView(facts({ tracked: 1, lastSync: null })).detail)
            .toBe('gabriel@example.com · 1 note · not synced yet');
    });

    it('says when the last sync failed, and why, instead of looking connected', () => {
        const explanation = explainFailure(new Error('net::ERR_INTERNET_DISCONNECTED'), {
            apiUrl: 'https://pensio.app', autoSync: true,
        });
        const view = cardView(facts({ problem: { explanation, message: '', at: NOW - 3 * MIN } }));
        expect(view).toEqual({
            tone: 'warn', icon: 'alert-triangle', title: 'Not syncing',
            detail: 'Couldn’t reach Pensio. Last tried 3 min ago.',
            signUp: false, action: 'sync',
        });
    });

    it('offers Connect to Pensio, and an account, when nothing is connected', () => {
        expect(cardView(facts({ state: 'disconnected' }))).toEqual({
            tone: 'off', icon: 'cloud-off', title: 'Not connected', detail: '', signUp: true, action: 'connect',
        });
    });

    it('says an expired session lost nothing, and offers Connect to Pensio', () => {
        const view = cardView(facts({ state: 'reconnect' }));
        expect(view.title).toBe('Session expired');
        expect(view.detail).toBe('Your notes and sync history are safe.');
        expect(view.tone).toBe('warn');
        expect(view.action).toBe('connect');
    });

    it('checks saved tokens with no button, and offers Try again when it could not', () => {
        expect(cardView(facts({ state: 'unverified', checking: true }))).toMatchObject({
            tone: 'pending', title: 'Checking connection…', action: null,
        });
        const checkProblem = explainFailure(new HttpError('Bad gateway', 502), { apiUrl: 'https://pensio.app', autoSync: true });
        expect(cardView(facts({ state: 'unverified', checkProblem }))).toMatchObject({
            tone: 'warn', title: 'Couldn’t check the connection',
            detail: 'Pensio’s server had a problem (error 502).', action: 'check',
        });
    });

    it('is found as Connect to Pensio wherever it carries that button', () => {
        // Pensio's help pages say "press Connect to Pensio" in every state.
        for (const state of ['disconnected', 'reconnect'] as const) {
            expect(cardView(facts({ state })).action).toBe('connect');
            expect(cardSearchName(state)).toBe('Connect to Pensio');
        }
        expect(cardSearchName('connected')).toBe('Connection');
    });
});

describe('timeAgo', () => {
    it('says how long ago, the way a person would', () => {
        expect(timeAgo(NOW - 20 * 1000, NOW)).toBe('just now');
        expect(timeAgo(NOW - 3 * MIN, NOW)).toBe('3 min ago');
        expect(timeAgo(NOW - 5 * 60 * MIN, NOW)).toBe('5 h ago');
        expect(timeAgo(NOW - 30 * 60 * MIN, NOW)).toBe('yesterday');
        expect(timeAgo(NOW - 3 * 24 * 60 * MIN, NOW)).toBe('3 days ago');
        expect(timeAgo(NOW - 30 * 24 * 60 * MIN, NOW)).toMatch(/^on /);
    });
});
