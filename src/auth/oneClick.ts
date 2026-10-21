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
import { serverUrl } from '../apiUrl';

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
    | { kind: 'expired' }
    /** This approval already connected the vault: the link was opened twice. */
    | { kind: 'already-used' };

/** Where the waiting requests are kept: this device only, never synced. */
export interface PendingStore {
    load(): unknown;
    save(value: unknown): void;
}

interface Saved {
    pending?: Pending[];
    used?: { state: string; at: number }[];
}

/** At most this many requests wait at once; the oldest goes first. */
const MAX_PENDING = 5;

function isUsed(value: unknown): value is { state: string; at: number } {
    const u = value as { state?: unknown; at?: unknown };
    return !!u && typeof u.state === 'string' && typeof u.at === 'number';
}

function isPending(value: unknown): value is Pending {
    const p = value as Pending;
    return !!p && typeof p.verifier === 'string' && typeof p.state === 'string'
        && typeof p.deviceId === 'string' && typeof p.startedAt === 'number';
}

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
    /**
     * ⭐ Every request still waiting, each with its own state and verifier,
     * kept in vault-local storage on this device (Obsidian's saveLocalStorage,
     * never synced). ⛔ 0.7.0 kept one request in memory only, so a plugin
     * reload or update while she approved, or a second press of Connect, made
     * her real approval "not started from this vault" (review F24). Allowing
     * several is as safe as one: a callback must carry one of OUR unguessable
     * states, and its code works only with that request's verifier.
     */
    private pending: Pending[] = [];
    /** Requests that completed, so a link opened twice says so. */
    private used: { state: string; at: number }[] = [];
    private readonly store: PendingStore | null;
    private readonly now: () => number;

    constructor(
        private readonly exchange: Exchanger,
        options: { store?: PendingStore; now?: () => number } = {},
    ) {
        this.store = options.store ?? null;
        this.now = options.now ?? Date.now;
        this.restore();
    }

    private restore(): void {
        try {
            const loaded: unknown = this.store?.load() ?? null;
            const saved: Saved = loaded && typeof loaded === 'object' ? loaded : {};
            this.pending = (Array.isArray(saved.pending) ? saved.pending : []).filter(isPending);
            this.used = (Array.isArray(saved.used) ? saved.used : []).filter(isUsed);
            this.prune();
        } catch {
            this.pending = [];
            this.used = [];
        }
    }

    private prune(): void {
        const now = this.now();
        this.pending = this.pending.filter(p => now - p.startedAt < PENDING_TTL_MS).slice(-MAX_PENDING);
        this.used = this.used.filter(u => now - u.at < PENDING_TTL_MS).slice(-MAX_PENDING);
    }

    private persist(): void {
        try {
            this.store?.save({ pending: this.pending, used: this.used });
        } catch {
            // Storage refused: the request still completes while Obsidian runs.
        }
    }

    /** Begin a connection and return the page to open. */
    async start(apiUrl: string, deviceId: string, deviceName: string, vault = ''): Promise<string> {
        const verifier = randomString(32);
        const state = randomString(16);
        this.prune();
        this.pending.push({ verifier, state, deviceId, startedAt: this.now() });
        this.pending = this.pending.slice(-MAX_PENDING);
        this.persist();

        const params = new URLSearchParams({
            challenge: await challengeFor(verifier),
            state,
            device_id: deviceId,
            device_name: deviceName,
            // Echoed into the callback, so with several vaults open the code
            // comes back to this one rather than the last one in front.
            ...(vault ? { vault } : {}),
        });
        const base = serverUrl(apiUrl);
        return `${base}/connect/obsidian/?${params.toString()}`;
    }

    isWaiting(): boolean {
        return this.pending.some(p => this.now() - p.startedAt < PENDING_TTL_MS);
    }

    /** obsidian://pensio-connect landed. Never throws for a callback that is
     * not ours; the exchange's own failure (an expired code) does throw. */
    async handleCallback(params: Record<string, string | undefined>): Promise<CallbackOutcome> {
        const state = params.state;
        const pending = state ? this.pending.find(p => p.state === state) : undefined;
        if (!pending) {
            if (state && this.used.some(u => u.state === state)) return { kind: 'already-used' };
            // Not started here, or forged: touch nothing.
            return { kind: 'not-ours' };
        }
        const spend = () => {
            this.pending = this.pending.filter(p => p !== pending);
            this.persist();
        };

        if (this.now() - pending.startedAt >= PENDING_TTL_MS) {
            spend();
            return { kind: 'expired' };
        }
        if (params.error || !params.code) {
            spend();
            return { kind: 'cancelled' };
        }
        let result: ConnectResult;
        try {
            result = await this.exchange(params.code, pending.verifier, pending.deviceId);
        } catch (error) {
            // ⭐ A refusal spends the request. A failure that may pass (no
            // answer, a server error, a rate limit) keeps it, so opening the
            // browser's link again can still finish the approval she gave.
            const status = (error as { status?: unknown })?.status;
            const definite = typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
            if (definite) spend();
            throw error;
        }
        spend();
        this.used.push({ state: pending.state, at: this.now() });
        this.prune();
        this.persist();
        return { kind: 'connected', result };
    }
}
