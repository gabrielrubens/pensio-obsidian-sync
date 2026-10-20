import { Explanation } from './notices';
import { SyncProblem } from './syncStatus';

export type ConnectionState = 'connected' | 'unverified' | 'reconnect' | 'disconnected';

/** The card's colour: working, needs her, not connected, or checking. */
export type CardTone = 'ok' | 'warn' | 'off' | 'pending';

/** A button the card carries. */
export type CardAction = 'connect' | 'sync' | 'check';

/** Everything the card says, read when it is drawn. */
export interface CardFacts {
    state: ConnectionState;
    email: string | null;
    /** Notes this vault has synced. */
    tracked: number;
    /** When the last sync with nothing failing finished (ms), or null. */
    lastSync: number | null;
    /** The last sync failed, and why. */
    problem: SyncProblem | null;
    /** Saved tokens are being checked right now. */
    checking: boolean;
    /** Checking the saved tokens failed, and why. */
    checkProblem: Explanation | null;
    /** No check has run for these tokens yet. */
    unchecked?: boolean;
    now: number;
}

export interface CardView {
    tone: CardTone;
    /** A Lucide icon name, as Obsidian's setIcon takes it. */
    icon: string;
    title: string;
    detail: string;
    /** Follow the detail with "No account? Create one free". */
    signUp: boolean;
    /** The buttons, the main one first. */
    actions: CardAction[];
}

/** A passing problem: trying again may work, so Try again comes first. */
function passing(problem: Explanation): boolean {
    return problem.kind === 'offline' || problem.kind === 'busy' || problem.kind === 'server';
}

/** "just now", "3 min ago", "5 h ago", "2 days ago", or the date. */
export function timeAgo(then: number, now: number): string {
    const minutes = Math.floor((now - then) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
    return `on ${new Date(then).toLocaleDateString()}`;
}

/**
 * What the status card at the top of the settings says, for every state the
 * plugin can be in (plugin 0.7.0, design "B · Status card").
 *
 * ⭐ The card answers *is this vault syncing?* before anything else on the
 * screen, in a colour, an icon and a word, and carries the one button that
 * state needs: **Connect to Pensio** when there is no working connection,
 * **Sync now** when there is. ⛔ The connect label is quoted by Pensio's help
 * pages in every state, so it is never shortened to "Connect" or "Reconnect".
 * 🧪 `src/__tests__/statusCard.test.ts`.
 */
export function cardView(f: CardFacts): CardView {
    switch (f.state) {
        case 'disconnected':
            return { tone: 'off', icon: 'cloud-off', title: 'Not connected', detail: '', signUp: true, actions: ['connect'] };
        case 'reconnect':
            return {
                tone: 'warn', icon: 'alert-triangle', title: 'Session expired',
                detail: 'Your notes and sync history are safe.', signUp: false, actions: ['connect'],
            };
        case 'unverified':
            if (f.checkProblem && !f.checking) {
                // ⛔ 0.7.0 offered only Try again here, so the obvious way out,
                // connecting again, meant clearing the token fields by hand
                // (review F4). Connect keeps the sync history.
                return {
                    tone: 'warn', icon: 'alert-triangle', title: 'Couldn’t check the connection',
                    detail: [f.checkProblem.reason, f.checkProblem.next].filter(Boolean).join(' '),
                    signUp: false,
                    actions: passing(f.checkProblem) ? ['check', 'connect'] : ['connect', 'check'],
                };
            }
            if (!f.checking && f.unchecked === false) {
                // Checked, and still not known: never a spinner that never ends.
                return {
                    tone: 'pending', icon: 'help-circle', title: 'Not checked yet',
                    detail: 'Tokens are saved.', signUp: false, actions: ['check', 'connect'],
                };
            }
            return {
                tone: 'pending', icon: 'refresh-cw', title: 'Checking connection…',
                detail: 'Tokens are saved. This takes a second.', signUp: false, actions: [],
            };
        case 'connected': {
            if (f.problem) {
                return {
                    tone: 'warn', icon: 'alert-triangle', title: 'Not syncing',
                    detail: `${f.problem.explanation.reason} Last tried ${timeAgo(f.problem.at, f.now)}.`,
                    signUp: false, actions: ['sync'],
                };
            }
            const parts = [
                f.email ?? '',
                `${f.tracked} ${f.tracked === 1 ? 'note' : 'notes'}`,
                f.lastSync ? `synced ${timeAgo(f.lastSync, f.now)}` : 'not synced yet',
            ].filter(Boolean);
            return { tone: 'ok', icon: 'check', title: 'Connected', detail: parts.join(' · '), signUp: false, actions: ['sync'] };
        }
    }
}

/**
 * The card's name in Obsidian's settings search. Typing *connect* finds it in
 * every state, and where there is no working connection it is named after the
 * button it carries.
 */
export function cardSearchName(state: ConnectionState): string {
    return state === 'disconnected' || state === 'reconnect' ? 'Connect to Pensio' : 'Connection';
}

export const CARD_SEARCH_ALIASES = ['connect', 'reconnect', 'connection', 'account', 'status', 'sync now', 'version'];
