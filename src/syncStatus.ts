import { Notice, setIcon, setTooltip } from 'obsidian';
import { explainFailure, Explanation, FailureContext, failureMessage, notify, NOTICE_MS } from './notices';

/** The last sync failed, and this is why. Cleared by the next sync that works. */
export interface SyncProblem {
    explanation: Explanation;
    /** The whole notice, "Sync failed. <why> <next>", without the prefix. */
    message: string;
    /** When it happened (ms). */
    at: number;
}

/** What SyncStatus needs from the plugin. */
export interface SyncStatusHost {
    statusBar(): HTMLElement | null;
    isAuthInvalidated(): boolean;
    trackedCount(): number;
    /** How to word a sync failure: retries is true only while auto-sync runs. */
    failureContext(): FailureContext;
}

const STOPPED_MESSAGE =
    'The connection stopped, so this vault is not syncing. Your notes are safe. ' +
    'Open Settings → Pensio Journaling Sync and press Connect to Pensio.';

/**
 * Whether this vault is syncing, said in three places from one record: the
 * status bar, a notice, and the status card at the top of the settings
 * (which listens through `onChange`).
 *
 * ⭐ The notice rule (plugin 0.7.0):
 * - a sync she asked for (a command, *Sync now*) always says how it ended;
 * - an automatic sync that fails says so ONCE, the first time, and the status
 *   bar keeps saying it until a sync works again, which also takes the
 *   notice away. Sync runs every five minutes, so telling her on every
 *   attempt would be noise; telling her never is how a vault stopped syncing
 *   for days with nothing on screen.
 * - an automatic sync that cannot reach the server tells only the status bar:
 *   a laptop on a train or a phone opened offline is not news.
 * 🧪 `src/__tests__/syncStatus.test.ts`.
 */
export class SyncStatus {
    private problem: SyncProblem | null = null;
    private problemNotice: Notice | null = null;
    private readonly listeners = new Set<() => void>();
    private resetTimer: number | null = null;

    constructor(private readonly host: SyncStatusHost, private readonly now: () => number = Date.now) {}

    getProblem(): SyncProblem | null {
        return this.problem;
    }

    /** Call `listener` whenever the sync status changes; returns how to stop. */
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    syncing(): void {
        this.paint('refresh-cw', 'Syncing…', 'Pensio is syncing this vault');
    }

    /** A sync she asked for worked: say so briefly, then go back to idle. */
    succeeded(detail: string): void {
        this.clearProblem();
        this.paint('check', detail, `Pensio: ${detail}`);
        this.resetTimer = window.setTimeout(() => this.idle(), 3000);
        this.emit();
    }

    /** Any sync worked: whatever was wrong is not any more. */
    recovered(): void {
        if (this.problem === null) return;
        this.clearProblem();
        this.idle();
        this.emit();
    }

    failed(error: unknown, options: { asked: boolean }): void {
        const context = this.host.failureContext();
        const explanation = explainFailure(error, context);
        const firstOfStreak = this.problem === null;
        this.problem = { explanation, message: failureMessage('Sync', error, context), at: this.now() };
        // A stopped connection has its own notice (connectionStopped), shown once.
        const tell = options.asked
            || (firstOfStreak && explanation.kind !== 'offline' && explanation.kind !== 'expired');
        if (tell) this.showProblem();
        this.idle();
        this.emit();
    }

    /** The server confirmed this connection is dead. */
    connectionStopped(): void {
        this.problemNotice?.hide();
        this.problemNotice = notify(STOPPED_MESSAGE, NOTICE_MS.failure);
        this.idle();
        this.emit();
    }

    /** New tokens, or none: forget the last problem and start over. */
    reset(): void {
        this.clearProblem();
        this.idle();
        this.emit();
    }

    idle(): void {
        if (this.resetTimer !== null) {
            window.clearTimeout(this.resetTimer);
            this.resetTimer = null;
        }
        if (this.host.isAuthInvalidated()) {
            this.paint('cloud-off', 'Reconnect Pensio', `Pensio: ${STOPPED_MESSAGE}`);
            return;
        }
        if (this.problem) {
            const { kind } = this.problem.explanation;
            const [icon, text] = kind === 'offline' ? ['cloud-off', 'Pensio offline']
                : kind === 'busy' ? ['clock', 'Pensio busy']
                    : ['alert-triangle', 'Pensio sync failed'];
            this.paint(icon, text, `Pensio: ${this.problem.message}`);
            return;
        }
        const tracked = this.host.trackedCount();
        this.paint(
            'cloud',
            tracked > 0 ? `${tracked} synced` : 'Pensio',
            tracked > 0 ? `Pensio: ${tracked} notes synced` : 'Pensio Journaling Sync',
        );
    }

    /** The status bar was pressed: say what it means, in a notice that stays. */
    explain(): void {
        if (this.host.isAuthInvalidated()) {
            this.problemNotice?.hide();
            this.problemNotice = notify(STOPPED_MESSAGE, NOTICE_MS.failure);
        } else if (this.problem) {
            this.showProblem();
        } else {
            const tracked = this.host.trackedCount();
            notify(tracked > 0 ? `${tracked} notes synced. Nothing is waiting.` : 'Nothing has synced yet.');
        }
    }

    private showProblem(): void {
        if (!this.problem) return;
        this.problemNotice?.hide();
        this.problemNotice = notify(this.problem.message, NOTICE_MS.failure);
    }

    private clearProblem(): void {
        this.problem = null;
        this.problemNotice?.hide();
        this.problemNotice = null;
    }

    /** Something the card shows changed (the account check started or ended). */
    changed(): void {
        this.emit();
    }

    private emit(): void {
        // A copy: a listener that redraws the settings tab unsubscribes and
        // subscribes again, and walking the live Set would visit the newcomer,
        // which redraws again, without end.
        for (const listener of [...this.listeners]) listener();
    }

    private paint(icon: string, text: string, tooltip: string): void {
        const bar = this.host.statusBar();
        if (!bar) return;
        bar.empty();
        const iconEl = bar.createSpan({ cls: 'pensio-status-icon' });
        setIcon(iconEl, icon);
        bar.createSpan({ text, cls: 'pensio-status-text' });
        setTooltip(bar, tooltip, { placement: 'top' });
    }
}
