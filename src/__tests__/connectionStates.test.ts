/**
 * Every connection state but a verified one shows the way to connect.
 *
 * ⛔ The bug (2026-10-18): tokens stored but no account cached — after a
 * restart with tokens revoked on the web, or simply dead — rendered "Tokens
 * entered — not yet verified" and a Test connection button, and no setup-code
 * field. The person was stuck: the only way out was clearing the token fields
 * under Advanced.
 *
 * First written for plugin 0.5.2 (#1456); this version also renders the
 * Connect button and presses the controls rather than only listing them.
 *
 * Since 0.6.1 the tab is setting definitions (Obsidian 1.13), and the test
 * renders it as Obsidian does: `update()` builds the definitions and the mock
 * draws them (src/__mocks__/obsidian.ts), so a click that redraws really
 * draws the next state.
 *
 * Sabotage-checked (2026-10-18), each alone then restored:
 * - drop renderPairingSetting from renderUnverifiedState → the unverified test RED;
 * - Test connection not re-rendering on a dead session → the 401 test RED;
 * - Disconnect not calling plugin.logout → the disconnect test RED;
 * - Connect not calling plugin.startOneClickConnect → the one-click test RED.
 *
 * Re-checked on the definitions (2026-10-19), each alone then restored:
 * - the unverified state without the pairing rows → the unverified test RED;
 * - Test connection not redrawing on a dead session → the 401 test RED;
 * - Disconnect without setDestructive() → the disconnect test RED.
 */
import { Setting } from 'obsidian';
import { PensioSettingTab } from '../settings';
import PensioPlugin from '../main';

type FakeSetting = {
    name: string;
    group: string | undefined;
    buttons: { text: string; destructive: boolean; click: (() => unknown) | null }[];
};

const rendered = (): FakeSetting[] => (Setting as unknown as { rendered: FakeSetting[] }).rendered;
/** The names in the Connection group of the most recent render. */
const names = (): string[] => rendered().filter(s => s.group === 'Connection').map(s => s.name);
const settingNamed = (name: string): FakeSetting => {
    const found = rendered().find(s => s.group === 'Connection' && s.name === name);
    if (!found) throw new Error(`no setting named ${name}; rendered: ${names().join(', ')}`);
    return found;
};

interface FakePluginState {
    tokens: boolean;
    account: { email: string } | null;
    invalidated: boolean;
}

function makePlugin(state: FakePluginState) {
    const plugin = {
        settings: { apiUrl: 'https://pensio.app', journalFolders: [], peopleFolder: '', autoSync: true },
        getAccessToken: () => (state.tokens ? 'access' : ''),
        getRefreshToken: () => (state.tokens ? 'refresh' : ''),
        accountGuard: { getAccount: () => state.account },
        apiClient: {
            isAuthInvalidated: () => state.invalidated,
            getTokenManager: () => ({ getTokenExpiry: async () => null }),
            getSyncStatus: async () => ({ total_entries: 0 }),
        },
        syncEngine: { getLastProcessingStatus: () => null },
        verifyAccountBeforeSync: jest.fn(async () => {
            // The server said 401 and the refresh could not cure it.
            state.invalidated = true;
            return false;
        }),
        startOneClickConnect: jest.fn(async () => undefined),
        logout: jest.fn(async () => {
            state.tokens = false;
            state.account = null;
        }),
    };
    return plugin;
}

/** Renders the tab the way Obsidian does: build the definitions, draw them. */
function render(state: FakePluginState) {
    const plugin = makePlugin(state);
    const tab = new PensioSettingTab({} as never, plugin as unknown as PensioPlugin);
    tab.update();
    return { tab, plugin };
}

describe('the connection section', () => {
    it('offers a setup code when nothing is connected', () => {
        render({ tokens: false, account: null, invalidated: false });
        expect(names()).toEqual(expect.arrayContaining(['Connect to Pensio', 'Setup code']));
    });

    it('offers a setup code when tokens are stored but not verified', () => {
        render({ tokens: true, account: null, invalidated: false });
        expect(names()).toEqual(expect.arrayContaining(['Connect to Pensio', 'Setup code']));
    });

    it('offers a setup code when the session is dead', () => {
        render({ tokens: true, account: null, invalidated: true });
        expect(names()).toEqual(expect.arrayContaining(['Connect to Pensio', 'Setup code']));
    });

    it('offers no setup code once the connection is verified', () => {
        render({ tokens: true, account: { email: 'her@example.com' }, invalidated: false });
        expect(names()).not.toContain('Setup code');
        expect(names()).not.toContain('Connect to Pensio');
        expect(names()).toContain('Disconnect');
    });

    it('moves to the reconnect state when Test connection gets a 401', async () => {
        jest.useFakeTimers();
        const state = { tokens: true, account: null, invalidated: false };
        const { plugin } = render(state);

        const test = settingNamed('Test connection').buttons[0];
        await test.click?.();

        expect(plugin.verifyAccountBeforeSync).toHaveBeenCalledWith({ reconnectOn401: true });
        // Re-rendered into the reconnect state, which still offers the way back.
        expect(names()).toEqual(expect.arrayContaining(['Connect to Pensio', 'Setup code']));
        expect(names()).not.toContain('Test connection');
        jest.useRealTimers();
    });

    it('Disconnect stops the connection and shows the way to connect again', async () => {
        const state = { tokens: true, account: { email: 'her@example.com' }, invalidated: false };
        const { plugin } = render(state);

        const disconnect = settingNamed('Disconnect').buttons[0];
        expect(disconnect.destructive).toBe(true);
        await disconnect.click?.();

        expect(plugin.logout).toHaveBeenCalled();
        expect(names()).toEqual(expect.arrayContaining(['Connect to Pensio', 'Setup code']));
    });

    it('Connect opens the browser for one click', async () => {
        const { plugin } = render({ tokens: false, account: null, invalidated: false });

        await settingNamed('Connect to Pensio').buttons[0].click?.();

        expect(plugin.startOneClickConnect).toHaveBeenCalled();
    });
});
