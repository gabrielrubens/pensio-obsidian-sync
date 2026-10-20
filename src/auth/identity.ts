/**
 * Which Pensio account a token belongs to, read from the token itself.
 *
 * ⭐ A Pensio token is a JWT whose payload names the account in `user_id`
 * (SIMPLE_JWT's USER_ID_CLAIM in config/settings/base.py) and the connection
 * in `family` (api/tokens.py::FAMILY_CLAIM). Reading them needs no request and
 * no secret: the signature is the server's to check, and this only decides
 * whether the vault's sync history belongs to the account the new tokens are
 * for.
 *
 * ⛔ Before 0.7.1 that decision compared the first 16 characters of each
 * token, and every Pensio token starts with the same 16 (the JWT header). So
 * a real change of tokens went unnoticed, and only an EMPTIED field counted as
 * one, which wiped the sync history of anyone who cleared the fields to paste
 * new ones (review F5, F7).
 */

interface Claims {
    user_id?: unknown;
    family?: unknown;
}

function claims(token: string): Claims | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
        const payload: unknown = JSON.parse(json);
        return payload && typeof payload === 'object' ? payload : null;
    } catch {
        return null;
    }
}

/** The account a token is for, or null when it is not a Pensio token. */
export function tokenUserId(token: string): string | null {
    const id = claims(token.trim())?.user_id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

/** It reads as a Pensio token: three parts, and an account inside. */
export function looksLikeToken(token: string): boolean {
    return tokenUserId(token) !== null;
}
