import { AccountGuard } from '../../auth/accountGuard';
import { CurrentUserResponse, SyncStateData } from '../../types';

// Mock logger
jest.mock('../../logger', () => ({
    debugLog: jest.fn(),
}));

/**
 * Creates a mock ApiClient with a controllable fetchCurrentUser response.
 */
function createMockApiClient(response?: CurrentUserResponse, error?: any) {
    return {
        fetchCurrentUser: error
            ? jest.fn().mockRejectedValue(error)
            : jest.fn().mockResolvedValue(response),
    } as any;
}

function makeSyncState(overrides: Partial<SyncStateData> = {}): SyncStateData {
    return {
        userId: 'user-aaa-111',
        lastSyncTime: Date.now(),
        files: { 'Journal/test.md': { hash: 'abc123', mtime: 1000 } },
        ...overrides,
    };
}

const USER_A: CurrentUserResponse = {
    id: 'user-aaa-111',
    email: 'alice@example.com',
    username: 'alice',
};

const USER_B: CurrentUserResponse = {
    id: 'user-bbb-222',
    email: 'bob@example.com',
    username: 'bob',
};

describe('AccountGuard', () => {
    let guard: AccountGuard;

    beforeEach(() => {
        guard = new AccountGuard();
    });

    // =================================================================
    // Core Verification Logic
    // =================================================================

    describe('verify()', () => {
        it('returns "ok" when userId matches current user', async () => {
            const client = createMockApiClient(USER_A);
            const state = makeSyncState({ userId: USER_A.id });

            const result = await guard.verify(client, state);

            expect(result.status).toBe('ok');
            expect((result as any).account.id).toBe(USER_A.id);
            expect(client.fetchCurrentUser).toHaveBeenCalledTimes(1);
        });

        it('returns "first-connection" when syncState is null', async () => {
            const client = createMockApiClient(USER_A);

            const result = await guard.verify(client, null);

            expect(result.status).toBe('first-connection');
            expect((result as any).account.email).toBe('alice@example.com');
        });

        it('returns "first-connection" when syncState has no userId', async () => {
            const client = createMockApiClient(USER_A);
            const state = makeSyncState({ userId: null });

            const result = await guard.verify(client, state);

            expect(result.status).toBe('first-connection');
        });

        it('returns "account-switched" when userId differs', async () => {
            const client = createMockApiClient(USER_B);
            const state = makeSyncState({ userId: USER_A.id });

            const result = await guard.verify(client, state);

            expect(result.status).toBe('account-switched');
            if (result.status === 'account-switched') {
                expect(result.previousId).toBe(USER_A.id);
                expect(result.account.id).toBe(USER_B.id);
                expect(result.account.email).toBe('bob@example.com');
            }
        });

        it('returns "error" on network failure', async () => {
            const client = createMockApiClient(undefined, new Error('Network timeout'));

            const result = await guard.verify(client, makeSyncState());

            expect(result.status).toBe('error');
            if (result.status === 'error') {
                expect(result.message).toBe('Network timeout');
            }
        });

        it('returns "error" with auth message on 401', async () => {
            const authError: any = new Error('Unauthorized');
            authError.status = 401;
            const client = createMockApiClient(undefined, authError);

            const result = await guard.verify(client, makeSyncState());

            expect(result.status).toBe('error');
            if (result.status === 'error') {
                expect(result.message).toBe('Authentication expired');
            }
        });
    });

    // =================================================================
    // Account Caching
    // =================================================================

    describe('getAccount()', () => {
        it('returns null before first verify()', () => {
            expect(guard.getAccount()).toBeNull();
        });

        it('returns account info after successful verify()', async () => {
            const client = createMockApiClient(USER_A);
            await guard.verify(client, null);

            const account = guard.getAccount();
            expect(account).not.toBeNull();
            expect(account!.email).toBe('alice@example.com');
        });

        it('updates cached account after account switch', async () => {
            // First verify with User A
            const clientA = createMockApiClient(USER_A);
            await guard.verify(clientA, null);
            expect(guard.getAccount()!.email).toBe('alice@example.com');

            // Switch to User B
            const clientB = createMockApiClient(USER_B);
            const state = makeSyncState({ userId: USER_A.id });
            await guard.verify(clientB, state);
            expect(guard.getAccount()!.email).toBe('bob@example.com');
        });

        it('does NOT update cache on error', async () => {
            // Successful initial verify
            const clientOk = createMockApiClient(USER_A);
            await guard.verify(clientOk, null);
            expect(guard.getAccount()!.email).toBe('alice@example.com');

            // Failed verify — cache should retain old value
            const clientErr = createMockApiClient(undefined, new Error('fail'));
            await guard.verify(clientErr, makeSyncState());
            expect(guard.getAccount()!.email).toBe('alice@example.com');
        });
    });

    describe('clearAccount()', () => {
        it('clears the cached account', async () => {
            const client = createMockApiClient(USER_A);
            await guard.verify(client, null);
            expect(guard.getAccount()).not.toBeNull();

            guard.clearAccount();
            expect(guard.getAccount()).toBeNull();
        });
    });

    // =================================================================
    // Privacy: Account Switch Scenarios
    // =================================================================

    describe('account switch scenarios', () => {
        it('detects switch even when only userId differs (same email would be weird but possible)', async () => {
            const userC: CurrentUserResponse = {
                id: 'user-ccc-333',
                email: 'alice@example.com', // same email, different server/account
                username: 'alice',
            };
            const client = createMockApiClient(userC);
            const state = makeSyncState({ userId: USER_A.id });

            const result = await guard.verify(client, state);
            expect(result.status).toBe('account-switched');
        });

        it('handles rapid verify() calls (dedup)', async () => {
            const client = createMockApiClient(USER_A);
            const state = makeSyncState({ userId: USER_A.id });

            // Fire multiple verifies concurrently
            const results = await Promise.all([
                guard.verify(client, state),
                guard.verify(client, state),
                guard.verify(client, state),
            ]);

            expect(results.every(r => r.status === 'ok')).toBe(true);
            // Each call makes its own API request (stateless)
            expect(client.fetchCurrentUser).toHaveBeenCalledTimes(3);
        });

        it('legacy state migration: null userId treated as first-connection', async () => {
            const client = createMockApiClient(USER_A);
            // Simulate data.json from before account guard existed
            const legacyState: SyncStateData = {
                userId: null,
                lastSyncTime: Date.now() - 86400000,
                files: {
                    'Journal/old-entry.md': { hash: 'legacy', mtime: 500 },
                },
            };

            const result = await guard.verify(client, legacyState);

            // Should be 'first-connection' not 'account-switched'
            // because legacy state has no userId to compare against
            expect(result.status).toBe('first-connection');
        });
    });
});
