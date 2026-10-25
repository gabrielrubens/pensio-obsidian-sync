import { TFile } from 'obsidian';
import type PensioPlugin from '../main';
import { NOTICE_MS, notify, notifyFailure } from '../notices';
import { quotaSummaryLine } from '../sync/quotaNotice';
import { tooLargeLine } from '../sync/tooLarge';

/** The plugin's commands in Obsidian's command palette. */
export function registerCommands(plugin: PensioPlugin): void {
    // Manual sync command
    plugin.addCommand({
        id: 'sync-now',
        name: 'Sync now',
        callback: () => plugin.syncNow()
    });

    // Force sync all files (ignore change detection)
    plugin.addCommand({
        id: 'force-sync-all',
        name: 'Force sync all files',
        callback: () => plugin.syncNow({ force: true })
    });

    // Sync current file
    plugin.addCommand({
        id: 'sync-current-file',
        name: 'Sync current file',
        callback: async () => {
            const file = plugin.app.workspace.getActiveFile();
            if (!file) {
                notify('Open a note first, then sync it.');
                return;
            }
            if (!file.path.endsWith('.md')) {
                notify('Only Markdown notes sync to Pensio.');
                return;
            }
            await plugin.syncNow({ file });
        }
    });

    // Check sync status
    plugin.addCommand({
        id: 'check-sync-status',
        name: 'Check sync status',
        callback: async () => {
            try {
                const status = await plugin.apiClient.getSyncStatus();
                const account = plugin.accountGuard.getAccount();
                const accountLine = account ? `Account: ${account.email}\n` : '';
                const trackedFiles = plugin.syncEngine.getTrackedFileCount();
                // Prefer the value this call just fetched; fall back to
                // the last sync's reading on older servers.
                const quotaLine = quotaSummaryLine(
                    status.processing_status ?? plugin.syncEngine.getLastProcessingStatus()
                );
                notify(
                    'sync status\n' +
                    `${accountLine}` +
                    `Server entries: ${status.total_entries}\n` +
                    `Local tracked files: ${trackedFiles}` +
                    (quotaLine ? `\n${quotaLine}` : '')
                );
            } catch (error) {
                notifyFailure('Checking the sync status', error, plugin.failureContext(), 'connection');
                console.error('Status error:', error);
            }
        }
    });

    // Disconnect. The id stays 'logout' so a hotkey bound to it keeps working.
    plugin.addCommand({
        id: 'logout',
        name: 'Disconnect from Pensio',
        callback: async () => {
            await plugin.logout();
        }
    });
}

/**
 * A sync she asked for: a command, or *Sync now* on the status card. It
 * always says how it ended, and a failure stays on screen until she
 * dismisses it (SyncStatus).
 */
export async function runSyncNow(plugin: PensioPlugin, options: { force?: boolean; file?: TFile } = {}): Promise<void> {
    // ⛔ Before 0.7.1 a sync with nothing connected did nothing visible.
    if (!plugin.getAccessToken() || !plugin.getRefreshToken()) {
        notify('This vault isn’t connected. Open the plugin’s settings and press Connect to Pensio.', NOTICE_MS.failure);
        return;
    }
    if (plugin.apiClient.isAuthInvalidated()) {
        notify('The connection to Pensio has stopped. Open the plugin’s settings and press Connect to Pensio.', NOTICE_MS.failure);
        return;
    }
    plugin.syncStatus.syncing();
    try {
        const verified = await plugin.verifyAccountBeforeSync({
            onError: (error) => plugin.syncStatus.failed(error, { asked: true }),
        });
        if (!verified) {
            plugin.syncStatus.idle();
            return;
        }
        if (options.file) plugin.syncEngine.markDirty(options.file.path);
        const result = await plugin.syncEngine.syncAll(options.force ?? false, { asked: true });
        plugin.syncStatus.succeeded(`${result.synced} synced`);
        const tooLarge = tooLargeLine(result.tooLarge);
        if (options.file && result.tooLarge.includes(options.file.path)) {
            notify(`${options.file.name} is too large to sync. Split it into smaller notes to sync it.`);
        } else if (options.file) {
            notify(result.synced > 0 ? `${options.file.name} synced.` : `${options.file.name} was already up to date.`);
        } else {
            notify(`${options.force ? 'Full sync' : 'Sync'} done. ${result.synced} synced, ${result.skipped} unchanged.` +
                (tooLarge ? ` ${tooLarge}.` : ''));
        }
    } catch (error) {
        plugin.syncStatus.failed(error, { asked: true });
        console.error('Sync error:', error);
    }
}
