import type PensioPlugin from '../main';
import { notifyFailure } from '../notices';
import { SyncStateData } from '../types';

export interface VerifyOptions {
    reconnectOn401?: boolean;
    /** Report a failure here instead of in a notice. */
    onError?: (error: unknown) => void;
}

/** The plugin state the account check reads and writes. */
export interface AccountSafetyState {
    syncState(): SyncStateData | null;
    saveSyncState(state: SyncStateData): Promise<void>;
}

/**
 * Verify account identity before any sync operation.
 * Returns true if safe to proceed, false if sync should be aborted.
 *
 * On account switch: clears sync state, stamps new userId, persists.
 * On first connection: stamps userId, persists.
 */
export async function verifyAccount(
    plugin: PensioPlugin, state: AccountSafetyState, options: VerifyOptions = {},
): Promise<boolean> {
    // Skip verification if not authenticated
    if (!plugin.getAccessToken() || !plugin.getRefreshToken()) {
        return false;
    }
    if (plugin.apiClient.isAuthInvalidated()) {
        return false;
    }

    const result = await plugin.accountGuard.verify(
        plugin.apiClient,
        state.syncState(),
    );

    switch (result.status) {
        case 'ok':
            return true;

        case 'first-connection':
            // Stamp userId on sync state for future verification
            plugin.syncEngine.setUserId(result.account.id);
            await state.saveSyncState(plugin.syncEngine.getState());
            return true;

        case 'account-switched':
            // Clear everything and start fresh for the new account
            plugin.syncEngine.clearState();
            plugin.syncEngine.setUserId(result.account.id);
            await state.saveSyncState(plugin.syncEngine.getState());
            return true;

        case 'error':
            // Only when the person asked (Test connection): a 401 the
            // refresh could not cure means this connection is gone, so
            // show the reconnect state instead of a bare failure.
            if (result.unauthorized && options.reconnectOn401) {
                plugin.apiClient.markAuthInvalidated();
                return false;
            }
            // Block sync on error — fail safe, not fail open
            {
                const error = result.error ?? new Error(result.message);
                if (options.onError) options.onError(error);
                else notifyFailure('Sync', error, plugin.failureContext());
            }
            return false;
    }
}
