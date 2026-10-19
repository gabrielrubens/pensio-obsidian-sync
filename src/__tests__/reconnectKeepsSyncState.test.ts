/**
 * Reconnecting keeps the sync state; pasting another token by hand does not.
 *
 * ⭐ A connection that expired or was stopped, reconnected with a setup code
 * or one click, must not re-upload the whole vault: the sync state stays, and
 * the account guard (which compares its stored user id on the next verify)
 * still clears it if the new connection is someone else's account.
 *
 * Sabotage-checked (2026-10-18): setTokens ignoring keepSyncState → the first
 * test RED; keeping the state when it names no owner → the second test RED.
 */
import PensioPlugin from '../main';

function plugin(syncState: { userId: string | null } | null) {
    const p = new (PensioPlugin as unknown as new () => PensioPlugin)();
    const secrets: Record<string, string> = {};
    const internals = p as unknown as Record<string, unknown>;
    internals.app = {
        secretStorage: {
            getSecret: (k: string) => secrets[k] ?? '',
            setSecret: (k: string, v: string) => { secrets[k] = v; },
        },
    };
    internals.settings = { autoSync: false, apiUrl: 'https://pensio.app' };
    internals.apiClient = { initializeTokens: jest.fn(async () => undefined), isAuthInvalidated: () => false };
    internals.accountGuard = { clearAccount: jest.fn() };
    internals.syncEngine = {
        clearState: jest.fn(),
        stopWatching: jest.fn(),
        getTrackedFileCount: () => 0,
    };
    internals.statusBarItem = { empty: jest.fn(), createSpan: jest.fn(() => ({})) };
    internals._syncState = syncState;
    return p;
}

const engine = (p: PensioPlugin) =>
    (p as unknown as { syncEngine: { clearState: jest.Mock } }).syncEngine;

describe('setTokens', () => {
    it('keeps an owned sync state when a pairing reconnects', async () => {
        const p = plugin({ userId: 'her-id' });
        await p.setTokens('old-access-aaaaaaaaaaaa', 'old-refresh-bbbbbbbbbbbb');
        await p.setTokens('new-access-cccccccccccc', 'new-refresh-dddddddddddd', { keepSyncState: true });

        expect(engine(p).clearState).not.toHaveBeenCalled();
    });

    it('clears a sync state that names no owner, even on a pairing', async () => {
        const p = plugin({ userId: null });
        await p.setTokens('old-access-aaaaaaaaaaaa', 'old-refresh-bbbbbbbbbbbb');
        await p.setTokens('new-access-cccccccccccc', 'new-refresh-dddddddddddd', { keepSyncState: true });

        expect(engine(p).clearState).toHaveBeenCalled();
    });

    it('clears it when tokens are pasted by hand, as before', async () => {
        const p = plugin({ userId: 'her-id' });
        await p.setTokens('old-access-aaaaaaaaaaaa', 'old-refresh-bbbbbbbbbbbb');
        await p.setTokens('new-access-cccccccccccc', 'new-refresh-dddddddddddd');

        expect(engine(p).clearState).toHaveBeenCalled();
    });
});
