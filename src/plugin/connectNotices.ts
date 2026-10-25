import { CallbackOutcome } from '../auth/oneClick';
import { explainFailure, FailureContext, NOTICE_MS, notify } from '../notices';

/** How a disconnect went (`PensioPlugin.logout`). */
export type DisconnectOutcome = 'stopped' | 'already-ended' | 'nothing' | { failed: unknown };

/** Say how obsidian://pensio-connect ended, for every outcome but a connection. */
export function noticeForCallback(outcome: Exclude<CallbackOutcome, { kind: 'connected' }>): void {
    switch (outcome.kind) {
        case 'cancelled':
            notify('Connecting was cancelled in the browser. Nothing changed here.', NOTICE_MS.info, 'connection');
            return;
        case 'unverified':
            notify(
                'Confirm your email address first: open the link Pensio emailed you, ' +
                'then press Connect to Pensio again.',
                NOTICE_MS.failure, 'connection',
            );
            return;
        case 'expired':
            notify('That request expired. Press Connect to Pensio in the settings again.', NOTICE_MS.failure, 'connection');
            return;
        case 'already-used':
            notify('That approval was already used. This vault is connected.', NOTICE_MS.info, 'connection');
            return;
        case 'not-ours':
            notify(
                'Pensio couldn’t match this approval to a Connect request in this vault. ' +
                'Press Connect to Pensio again, and approve in the newest browser tab.',
                NOTICE_MS.failure, 'connection',
            );
            return;
    }
}

/**
 * Say what Disconnect did. ⭐ It says what happened (review F35): 0.7.0 said
 * Pensio "could not be reached" when it was reached and refused, and when
 * nothing was ever asked.
 */
export function noticeForDisconnect(outcome: DisconnectOutcome, context: FailureContext): void {
    if (outcome === 'stopped') {
        notify('Disconnected. This vault no longer syncs.');
    } else if (outcome === 'already-ended') {
        notify('Disconnected. This connection had already ended on Pensio.');
    } else if (outcome === 'nothing') {
        notify('Disconnected. There was no connection to stop.');
    } else {
        const { reason } = explainFailure(outcome.failed, context);
        notify(
            `Disconnected here, but Pensio didn’t stop the connection there. ${reason} ` +
            'Stop it on the web too: Settings → Connected apps.',
            NOTICE_MS.failure,
        );
    }
}
