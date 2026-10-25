import { SecretStorage } from 'obsidian';
import { debugLog } from '../logger';

export interface Tokens {
    access: string;
    refresh: string;
}

/** Where a pair of tokens is kept in SecretStorage (`plugin/deviceState.ts::secretNames`). */
export interface SecretNames {
    access: string;
    refresh: string;
}

/**
 * Load tokens from Obsidian's SecretStorage (encrypted at rest). A value read
 * before a failure is kept; `current` is what a failure leaves.
 */
export function readTokens(secrets: SecretStorage, names: SecretNames, current: Tokens): Tokens {
    const tokens = { ...current };
    try {
        tokens.access = secrets.getSecret(names.access) || '';
        tokens.refresh = secrets.getSecret(names.refresh) || '';
    } catch (error) {
        console.error('Failed to load tokens from SecretStorage:', error);
    }
    return tokens;
}

/**
 * Save tokens to SecretStorage, verified by read-back. Losing this write used
 * to brick the pairing (the server no longer blacklists the predecessor, so a
 * lost write is recoverable — but still verify).
 */
export function writeTokens(secrets: SecretStorage, names: SecretNames, tokens: Tokens): void {
    const write = () => {
        secrets.setSecret(names.access, tokens.access);
        secrets.setSecret(names.refresh, tokens.refresh);
    };
    const verified = () =>
        (secrets.getSecret(names.access) || '') === tokens.access &&
        (secrets.getSecret(names.refresh) || '') === tokens.refresh;

    try {
        write();
        if (!verified()) {
            debugLog('SecretStorage read-back mismatch — retrying token save');
            write();
            if (!verified()) {
                console.error('Pensio: token save could not be verified — tokens may not survive a restart');
            }
        }
    } catch (error) {
        console.error('Failed to save tokens to SecretStorage:', error);
    }
}
