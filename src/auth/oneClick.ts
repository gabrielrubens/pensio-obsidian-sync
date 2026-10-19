/**
 * Connect to Pensio in one click: approve in the browser, and Obsidian is
 * connected — the way an editor connects an MCP server.
 *
 * 1. start(): make a PKCE verifier and a random `state`, keep both in memory
 *    only, and return the address of Pensio's approval page, which carries the
 *    verifier's S256 challenge (never the verifier).
 * 2. She signs in, confirms it is her and approves; her browser opens
 *    obsidian://pensio-connect?code=…&state=… (core/views/obsidian_connect.py).
 * 3. handleCallback(): refuse a callback this vault did not start (`state`),
 *    then trade the code and the verifier for a token family at
 *    POST /api/v1/auth/connect/ (api/obsidian_connect.py).
 *
 * ⭐ The code is useless without the verifier, and a forged callback carries
 * the wrong `state` (and a code bound to someone else's challenge). No token
 * ever travels in a URL — only the code does.
 *
 * The typed setup code stays as the fallback: an install where obsidian:// is
 * not registered (some Linux packages) never gets the callback.
 */

/** How long a started connection waits for the browser. Approval may include
 * signing in and finding the second factor; the server's code is minted only
 * at approval and lives two minutes from then. */
export const PENDING_TTL_MS = 15 * 60 * 1000;

export const CALLBACK_ACTION = 'pensio-connect';

interface Pending {
    verifier: string;
    state: string;
    deviceId: string;
    startedAt: number;
}

export interface ConnectResult {
    access: string;
    refresh: string;
}

export type CallbackOutcome =
    | { kind: 'connected'; result: ConnectResult }
    | { kind: 'cancelled' }
    | { kind: 'not-ours' }
    | { kind: 'expired' };

export interface Exchanger {
    (code: string, verifier: string, deviceId: string): Promise<ConnectResult>;
}

function base64url(bytes: Uint8Array): string {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteCount: number): string {
    const bytes = new Uint8Array(byteCount);
    crypto.getRandomValues(bytes);
    return base64url(bytes);
}

/** RFC 7636 S256: base64url(SHA-256(verifier)), unpadded. */
export async function challengeFor(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return base64url(new Uint8Array(digest));
}

export class OneClickConnect {
    private pending: Pending | null = null;

    constructor(private readonly exchange: Exchanger, private readonly now: () => number = Date.now) {}

    /**
     * Begin a connection and return the page to open. A second press replaces
     * the first: only the most recent request can complete.
     */
    async start(apiUrl: string, deviceId: string, deviceName: string, vault = ''): Promise<string> {
        const verifier = randomString(32);
        const state = randomString(16);
        this.pending = { verifier, state, deviceId, startedAt: this.now() };

        const params = new URLSearchParams({
            challenge: await challengeFor(verifier),
            state,
            device_id: deviceId,
            device_name: deviceName,
            // Echoed into the callback, so with several vaults open the code
            // comes back to this one rather than the last one in front.
            ...(vault ? { vault } : {}),
        });
        const base = (apiUrl || 'https://pensio.app').replace(/\/+$/, '').replace('://www.', '://');
        return `${base}/connect/obsidian/?${params.toString()}`;
    }

    isWaiting(): boolean {
        return this.pending !== null && this.now() - this.pending.startedAt < PENDING_TTL_MS;
    }

    /** obsidian://pensio-connect landed. Never throws for a callback that is
     * not ours; the exchange's own failure (an expired code) does throw. */
    async handleCallback(params: Record<string, string | undefined>): Promise<CallbackOutcome> {
        const pending = this.pending;
        if (!pending || !params.state || params.state !== pending.state) {
            // Not started here, or a stale tab, or forged: touch nothing.
            return { kind: 'not-ours' };
        }
        // From here the request is spent, whatever happens: one callback each.
        this.pending = null;

        if (this.now() - pending.startedAt >= PENDING_TTL_MS) {
            return { kind: 'expired' };
        }
        if (params.error || !params.code) {
            return { kind: 'cancelled' };
        }
        const result = await this.exchange(params.code, pending.verifier, pending.deviceId);
        return { kind: 'connected', result };
    }
}
