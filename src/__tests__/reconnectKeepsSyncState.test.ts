/**
 * New tokens keep the sync history when they are for the same account, and
 * start it again when they are not.
 *
 * ⭐ A connection that expired or was stopped, reconnected with a setup code,
 * one click or tokens pasted by hand, must not re-upload the whole vault.
 * Tokens for another account must start the history again before any sync
 * uploads to it.
 *
 * ⛔ Until 0.7.1 this was decided by comparing the first 16 characters of each
 * token, and every Pensio token starts with the same 16 (the JWT header), so a
 * real change went unnoticed and only an EMPTIED field counted as one. Gabriel
 * cleared both token fields to reconnect (2026-10-20): the first keystroke
 * wiped the history, and the reconnect re-uploaded every note into an
 * exhausted rate limit (review F5, F7). The old test used made-up tokens
 * ('old-access-aaaa…'), which is why it never saw this. These use tokens
 * shaped like Pensio's.
 *
 * Sabotage-checked (2026-10-18): setTokens ignoring keepSyncState → the first
 * test RED; keeping the state when it names no owner → the second test RED.
 * Re-checked on 0.7.1 (2026-10-20), each alone then restored:
 * - setTokens comparing nothing (always keeping) → "another account" RED;
 * - setTokens always clearing → "the same account" RED;
 * - forgetTokens clearing the sync state → "emptying both fields" RED;
 * - previousRefresh ignoring the emptied token → "emptying both fields" RED.
 */
import PensioPlugin from '../main';

/** A token shaped like Pensio's: a JWT whose payload names the account. */
function token(userId: string, kind: 'access' | 'refresh', n = 1): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ token_type: kind, user_id: userId, family: `fam-${n}`, jti: `${kind}-${n}` })).toString('base64url');
    return `${header}.${payload}.signature${n}`;
}

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
    internals.apiClient = {
        initializeTokens: jest.fn(async () => undefined),
        isAuthInvalidated: () => false,
        logout: jest.fn(async () => undefined),
    };
    internals.accountGuard = { clearAccount: jest.fn() };
    internals.syncEngine = {
        clearState: jest.fn(),
        stopWatching: jest.fn(),
        startWatching: jest.fn(),
        startAutoSync: jest.fn(),
        getTrackedFileCount: () => 12,
    };
    internals._syncState = syncState;
    return p;
}

const engine = (p: PensioPlugin) =>
    (p as unknown as { syncEngine: { clearState: jest.Mock } }).syncEngine;

describe('setTokens', () => {
    it('keeps the sync history for tokens of the same account', async () => {
        const p = plugin({ userId: 'her-id' });
        await p.setTokens(token('her-id', 'access', 1), token('her-id', 'refresh', 1));
        await p.setTokens(token('her-id', 'access', 2), token('her-id', 'refresh', 2));

        expect(engine(p).clearState).not.toHaveBeenCalled();
    });

    it('starts it again for tokens of another account', async () => {
        const p = plugin({ userId: 'her-id' });
        await p.setTokens(token('someone-else', 'access'), token('someone-else', 'refresh'));

        expect(engine(p).clearState).toHaveBeenCalled();
    });

    it('starts again a sync state that names no owner', async () => {
        const p = plugin({ userId: null });
        await p.setTokens(token('her-id', 'access'), token('her-id', 'refresh'));

        expect(engine(p).clearState).toHaveBeenCalled();
    });
});

describe('emptying both token fields', () => {
    it('stops using the tokens, keeps the history, and ends the old connection on the next connect', async () => {
        const p = plugin({ userId: 'her-id' });
        const oldRefresh = token('her-id', 'refresh', 1);
        await p.setTokens(token('her-id', 'access', 1), oldRefresh);

        await p.forgetTokens();

        expect(p.getAccessToken()).toBe('');
        expect(p.getRefreshToken()).toBe('');
        expect(engine(p).clearState).not.toHaveBeenCalled();
        // Sent as previous_refresh, so Pensio ends the connection it replaces.
        expect(p.previousRefresh()).toBe(oldRefresh);

        // Reconnecting the same account keeps the history.
        await p.setTokens(token('her-id', 'access', 2), token('her-id', 'refresh', 2));
        expect(engine(p).clearState).not.toHaveBeenCalled();
    });
});
