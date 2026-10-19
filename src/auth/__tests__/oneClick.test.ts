/**
 * The plugin's half of the one-click connect: what it sends, what it keeps,
 * and which callbacks it refuses.
 *
 * Sabotage-checked (2026-10-18), each alone then restored:
 * - put the verifier in the page address → "never sends the verifier" RED;
 * - skip the state comparison → "a forged callback" RED;
 * - keep `pending` after a callback → "one callback each" RED;
 * - drop the TTL check → "a request left waiting too long" RED.
 */
import { createHash } from 'crypto';
import { challengeFor, OneClickConnect, PENDING_TTL_MS } from '../oneClick';

function query(url: string): URLSearchParams {
    return new URL(url).searchParams;
}

function connector(now = () => 1_000) {
    const exchange = jest.fn(async () => ({ access: 'a', refresh: 'r' }));
    return { exchange, connect: new OneClickConnect(exchange, now) };
}

describe('challengeFor', () => {
    it('is RFC 7636 S256', async () => {
        // RFC 7636 Appendix B.
        const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
        expect(await challengeFor(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });
});

describe('OneClickConnect', () => {
    it('opens Pensio with the challenge, the state and the vault', async () => {
        const { connect } = connector();
        const url = await connect.start(
            'https://pensio.app/', 'obsidian-0123456789abcdef', 'Obsidian — Journal', 'Journal'
        );

        expect(url.startsWith('https://pensio.app/connect/obsidian/?')).toBe(true);
        const q = query(url);
        expect(q.get('challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{16,}$/);
        expect(q.get('device_id')).toBe('obsidian-0123456789abcdef');
        expect(q.get('device_name')).toBe('Obsidian — Journal');
        expect(q.get('vault')).toBe('Journal');
    });

    it('never sends the verifier, only its challenge', async () => {
        const { connect, exchange } = connector();
        const url = await connect.start('https://pensio.app', 'vault', 'Obsidian');
        const q = query(url);

        await connect.handleCallback({ code: 'c', state: q.get('state') ?? '' });
        const verifier = (exchange.mock.calls[0] as unknown as string[])[1];

        expect(url).not.toContain(verifier);
        const s256 = createHash('sha256').update(verifier).digest('base64url');
        expect(q.get('challenge')).toBe(s256);
    });

    it('trades the code and the verifier for the connection', async () => {
        const { connect, exchange } = connector();
        const q = query(await connect.start('https://pensio.app', 'vault-1', 'Obsidian'));

        const outcome = await connect.handleCallback({ code: 'the-code', state: q.get('state') ?? '' });

        expect(outcome).toEqual({ kind: 'connected', result: { access: 'a', refresh: 'r' } });
        expect(exchange).toHaveBeenCalledWith('the-code', expect.any(String), 'vault-1');
    });

    it('refuses a forged callback: the wrong state touches nothing', async () => {
        const { connect, exchange } = connector();
        await connect.start('https://pensio.app', 'vault', 'Obsidian');

        const outcome = await connect.handleCallback({ code: 'attackers-code', state: 'guessed' });

        expect(outcome.kind).toBe('not-ours');
        expect(exchange).not.toHaveBeenCalled();
        expect(connect.isWaiting()).toBe(true);
    });

    it('refuses a callback it did not start', async () => {
        const { connect, exchange } = connector();

        const outcome = await connect.handleCallback({ code: 'c', state: 's' });

        expect(outcome.kind).toBe('not-ours');
        expect(exchange).not.toHaveBeenCalled();
    });

    it('takes one callback each', async () => {
        const { connect, exchange } = connector();
        const state = query(await connect.start('https://pensio.app', 'vault', 'Obsidian')).get('state') ?? '';

        await connect.handleCallback({ code: 'c', state });
        const replay = await connect.handleCallback({ code: 'c', state });

        expect(replay.kind).toBe('not-ours');
        expect(exchange).toHaveBeenCalledTimes(1);
    });

    it('a second press replaces the first', async () => {
        const { connect, exchange } = connector();
        const first = query(await connect.start('https://pensio.app', 'vault', 'Obsidian')).get('state') ?? '';
        await connect.start('https://pensio.app', 'vault', 'Obsidian');

        expect((await connect.handleCallback({ code: 'c', state: first })).kind).toBe('not-ours');
        expect(exchange).not.toHaveBeenCalled();
    });

    it('a cancelled approval ends the request', async () => {
        const { connect, exchange } = connector();
        const state = query(await connect.start('https://pensio.app', 'vault', 'Obsidian')).get('state') ?? '';

        const outcome = await connect.handleCallback({ error: 'access_denied', state });

        expect(outcome.kind).toBe('cancelled');
        expect(exchange).not.toHaveBeenCalled();
        expect(connect.isWaiting()).toBe(false);
    });

    it('a request left waiting too long is not completed', async () => {
        let now = 1_000;
        const { connect, exchange } = connector(() => now);
        const state = query(await connect.start('https://pensio.app', 'vault', 'Obsidian')).get('state') ?? '';

        now += PENDING_TTL_MS;
        const outcome = await connect.handleCallback({ code: 'c', state });

        expect(outcome.kind).toBe('expired');
        expect(exchange).not.toHaveBeenCalled();
    });
});
