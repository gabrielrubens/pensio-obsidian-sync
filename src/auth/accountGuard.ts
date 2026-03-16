/**
 * Account Guard — prevents syncing data to the wrong account.
 *
 * Before every sync operation the guard verifies that the current
 * API tokens still belong to the same user whose sync state is
 * stored locally.  If the user ID changes (account switch) the
 * guard clears all local sync tracking to force a full re-sync.
 *
 * Privacy rationale: journal entries are deeply personal data.
 * Syncing them to a stranger's account is a data-leak — this
 * module makes that impossible even if the user accidentally
 * pastes the wrong tokens.
 */

import { Notice } from 'obsidian';
import { ApiClient } from '../api/client';
import { debugLog } from '../logger';
import { CurrentUserResponse, SyncStateData } from '../types';

export interface AccountInfo {
    id: string;
    email: string;
    username: string;
}

/**
 * Result of an account verification check.
 *
 * - `ok`                 — same account, safe to sync
 * - `account-switched`   — different account detected, sync state was cleared
 * - `first-connection`   — no prior account on record (fresh install / cleared state)
 * - `error`              — network or auth error, block sync as a precaution
 */
export type VerifyResult =
    | { status: 'ok'; account: AccountInfo }
    | { status: 'account-switched'; previousId: string; account: AccountInfo }
    | { status: 'first-connection'; account: AccountInfo }
    | { status: 'error'; message: string };

export class AccountGuard {
    private cachedAccount: AccountInfo | null = null;

    /**
     * Verify the current API tokens belong to the same user stored
     * in the sync state.  Returns the verification result.
     *
     * @param apiClient   – authenticated API client
     * @param syncState   – current persisted sync state (may be null)
     */
    async verify(
        apiClient: ApiClient,
        syncState: SyncStateData | null,
    ): Promise<VerifyResult> {
        // Fetch current user from the server
        let currentUser: CurrentUserResponse;
        try {
            currentUser = await apiClient.fetchCurrentUser();
        } catch (error: any) {
            // Auth errors (401) — let normal auth flow handle it
            if (error.status === 401) {
                return { status: 'error', message: 'Authentication expired' };
            }
            console.error('Account guard: failed to verify identity', error);
            return { status: 'error', message: error.message || 'Network error' };
        }

        const account: AccountInfo = {
            id: currentUser.id,
            email: currentUser.email,
            username: currentUser.username,
        };

        // Cache for display in settings UI
        this.cachedAccount = account;

        // First-ever connection or no sync state yet
        if (!syncState || !syncState.userId) {
            debugLog('Account guard: first connection for', account.email);
            return { status: 'first-connection', account };
        }

        // Same account — all good
        if (syncState.userId === account.id) {
            debugLog('Account guard: verified —', account.email);
            return { status: 'ok', account };
        }

        // ACCOUNT SWITCH DETECTED
        debugLog(
            `Account guard: SWITCH DETECTED! ` +
            `State has userId=${syncState.userId}, ` +
            `but current user is ${account.id} (${account.email})`
        );

        new Notice(
            `⚠️ Pensio: Account changed to ${account.email}. ` +
            `Sync state cleared — all files will re-sync.`,
            10000,
        );

        return {
            status: 'account-switched',
            previousId: syncState.userId,
            account,
        };
    }

    /**
     * Get the last verified account info (cached from most recent verify()).
     * Returns null if verify() hasn't been called yet.
     */
    getAccount(): AccountInfo | null {
        return this.cachedAccount;
    }

    /**
     * Clear the cached account (e.g. on logout).
     */
    clearAccount(): void {
        this.cachedAccount = null;
    }
}
