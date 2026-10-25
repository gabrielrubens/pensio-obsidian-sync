import { serverUrl } from '../apiUrl';
import { OneClickConnect } from '../auth/oneClick';
import type PensioPlugin from '../main';
import { notify } from '../notices';
import { quotaDayKey, quotaNoticeMessage, shouldNotifyQuota } from '../sync/quotaNotice';
import { SyncStatus } from '../syncStatus';
import { ProcessingStatus } from '../types';

/** Whether this vault is syncing: the status bar, the notices, the status card. */
export function createSyncStatus(plugin: PensioPlugin): SyncStatus {
    return new SyncStatus({
        statusBar: () => plugin.statusBarItem ?? null,
        isAuthInvalidated: () => plugin.apiClient?.isAuthInvalidated() ?? false,
        trackedCount: () => plugin.syncEngine?.getTrackedFileCount() ?? 0,
        tooLarge: () => plugin.syncEngine?.getTooLargeNotes() ?? [],
        failureContext: () => plugin.syncFailureContext(),
    });
}

/**
 * One-click connect: the browser hands the code back at
 * obsidian://pensio-connect (src/auth/oneClick.ts). The exchange sends the
 * refresh token this vault holds, so the connection it replaces ends.
 */
export function createOneClick(plugin: PensioPlugin): OneClickConnect {
    return new OneClickConnect(
        (code, verifier, deviceId) =>
            plugin.apiClient.connectWithCode(code, verifier, deviceId, plugin.previousRefresh()),
        {
            // This device only, never synced: a reload, an update or a
            // second press must not orphan an approval (review F24).
            store: {
                load: () => plugin.app.loadLocalStorage('pensio-one-click') as unknown,
                save: (value: unknown) => plugin.app.saveLocalStorage('pensio-one-click', value),
            },
        },
    );
}

/**
 * Obsidian is quitting: save what is waiting to be saved, a move made in the
 * last second (`SyncEngine.saveNow`). ⛔ Not `onunload`, which Obsidian does
 * not call when it quits.
 *
 * ⛔ **A TASK ONLY WHEN A SAVE IS WAITING.** Obsidian answers any quit task by
 * cancelling the quit, waiting for the task, then closing the window and
 * nothing else (`App.registerQuitHook`, read in obsidian-1.14.4.asar on
 * 2026-10-22: `i.isEmpty() || (t.preventDefault(), … window.close())`). On a
 * Mac the app then stays running with no window. The first version of this
 * added a task on every quit, so every ⌘Q left Obsidian running (Gabriel's
 * test, 2026-10-22). Now a quit with nothing waiting is an ordinary quit; only
 * in the second after a move does Obsidian wait, as it does for its own saves.
 */
export function saveOnQuit(plugin: PensioPlugin): void {
    plugin.registerEvent(plugin.app.workspace.on('quit', (tasks) => {
        if (plugin.syncEngine.saveWaiting) tasks.add(() => plugin.syncEngine.saveNow());
    }));
}

/** How the sync engine reports to the plugin. */
export function wireSyncEngine(plugin: PensioPlugin): void {
    const engine = plugin.syncEngine;

    // Surface the free-tier analysis quota. Auto-sync is on by default and
    // silent, so without this a first import of a large vault finishes
    // with no indication that analysis will take weeks.
    engine.onProcessingStatus = (status) => showQuotaNotice(plugin, status);

    // An automatic sync reports how it ended; one she asked for is
    // reported by syncNow.
    engine.onSyncFailed = (error) => plugin.syncStatus.failed(error, { asked: false });
    engine.onSyncSucceeded = (contacted) => {
        // A sync ended with nothing failing; `contacted`: Pensio answered it.
        plugin.syncStatus.synced(contacted);
        if (!contacted) return;
        // Pensio answers again: an account nobody could check gets checked now.
        if (!plugin.accountGuard.getAccount()) void plugin.accountCheck.run();
    };
    // A problem on screen, or an account nobody has checked, makes a sync
    // with nothing to send ask Pensio anyway (review F26).
    engine.needsContact = () =>
        plugin.syncStatus.getProblem() !== null || plugin.accountGuard.getAccount() === null;
}

/**
 * Tell the user, at most once a day, that the free daily analysis cap is
 * spent and roughly how long the backlog will take.
 *
 * Deliberately once per quota day: sync runs on a five-minute timer, and
 * "you are still over quota" is an unchanging state, not news. Repeating
 * it every tick is the same mistake the server-side throttle event made.
 */
function showQuotaNotice(plugin: PensioPlugin, status: ProcessingStatus): void {
    const day = quotaDayKey();
    if (!shouldNotifyQuota(status, plugin.syncEngine.getLastQuotaNoticeDay())) {
        return;
    }

    plugin.syncEngine.markQuotaNoticeShown(day);

    const notice = notify(quotaNoticeMessage(status), 20000);
    // messageEl is absent under the test mock — optional chaining keeps the
    // message itself working even if the click target is unavailable.
    const apiUrl = serverUrl(plugin.settings.apiUrl);
    (notice as { messageEl?: HTMLElement })?.messageEl?.addEventListener('click', () => {
        window.open(`${apiUrl}/pricing/`);
    });
}
