/**
 * However the browser answers a Connect, the plugin says what happened and
 * the settings tab stops waiting (main.ts::finishOneClickConnect).
 *
 * ⛔ Until 0.8.0 (review F32): an email not yet confirmed came back as
 * *Connecting was cancelled*, which she had not done, and only a connection
 * redrew the tab, so after any other answer the card went on saying *Waiting
 * for your browser…* on its own clock.
 *
 * Sabotage-checked (2026-10-21), each alone then restored:
 * - the redraw only on a connection (no `finally`) → both tests RED;
 * - no notice for `unverified` → "says what to do" RED.
 */
import { Notice } from 'obsidian';
import { OneClickConnect } from '../auth/oneClick';
import PensioPlugin from '../main';

const NoticeMock = Notice as unknown as jest.Mock;
const lastNotice = (): string => (NoticeMock.mock.calls[NoticeMock.mock.calls.length - 1] as [string])[0];

function plugin() {
    const p = new (PensioPlugin as unknown as new () => PensioPlugin)();
    const internals = p as unknown as Record<string, unknown>;
    internals.oneClick = new OneClickConnect(jest.fn(async () => ({ access: 'a', refresh: 'r' })));
    internals.settingTab = { update: jest.fn() };
    internals.settings = { apiUrl: 'https://pensio.app' };
    return p;
}

const tab = (p: PensioPlugin) => (p as unknown as { settingTab: { update: jest.Mock } }).settingTab;

async function answer(p: PensioPlugin, params: Record<string, string>): Promise<void> {
    const url = await p.oneClick.start('https://pensio.app', 'vault', 'Obsidian');
    const state = new URL(url).searchParams.get('state') ?? '';
    await (p as unknown as { finishOneClickConnect: (q: Record<string, string>) => Promise<void> })
        .finishOneClickConnect({ ...params, state });
}

beforeEach(() => NoticeMock.mockClear());

it('an email not yet confirmed says what to do, and the tab stops waiting', async () => {
    const p = plugin();

    await answer(p, { error: 'email_unverified' });

    const message = lastNotice();
    expect(message).toContain('Confirm your email address first');
    expect(message).not.toContain('cancelled');
    expect(tab(p).update).toHaveBeenCalled();
});

it('a cancel redraws the tab too', async () => {
    const p = plugin();

    await answer(p, { error: 'access_denied' });

    expect(lastNotice()).toContain('cancelled');
    expect(tab(p).update).toHaveBeenCalled();
});
