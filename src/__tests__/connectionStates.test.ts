/**
 * Every connection state that is not a working connection offers a way back.
 *
 * ⛔ The "Tokens entered — not yet verified" state showed only Test
 * connection. Tokens that no longer work (the connection was removed on the
 * web, or they were pasted wrong) land there, and with no setup-code field the
 * only way back was clearing the token fields under Advanced, which nobody
 * finds. Reported 2026-10-18.
 *
 * 🧪 Sabotage-checked (2026-10-18): removing `renderPairingSetting` from
 * `renderUnverifiedState` turns `an unverified connection can pair again` red;
 * restored.
 */

const settingNames: string[] = [];

jest.mock('obsidian', () => {
    const actual = jest.requireActual('../__mocks__/obsidian.ts');
    class RecordingSetting {
        setName(name: string) { settingNames.push(name); return this; }
        setDesc() { return this; }
        setHeading() { return this; }
        addText() { return this; }
        addToggle() { return this; }
        addButton() { return this; }
        addDropdown() { return this; }
    }
    return { ...actual, Setting: RecordingSetting };
});

import { PensioSettingTab } from '../settings';

/** Just enough of an Obsidian element to render into, collecting its text. */
function fakeElement(texts: string[]): any {
    const el: any = {
        createDiv: (opts?: { text?: string }) => { if (opts?.text) texts.push(opts.text); return fakeElement(texts); },
        createSpan: (opts?: { text?: string }) => { if (opts?.text) texts.push(opts.text); return fakeElement(texts); },
        createEl: (_tag: string, opts?: { text?: string }) => { if (opts?.text) texts.push(opts.text); return fakeElement(texts); },
        appendText: (text: string) => { texts.push(text); },
        setAttr: () => undefined,
        empty: () => undefined,
    };
    return el;
}

function render(state: { tokens: boolean; account: boolean; invalidated: boolean }) {
    settingNames.length = 0;
    const texts: string[] = [];
    const plugin: any = {
        settings: { apiUrl: 'https://pensio.app' },
        getAccessToken: () => (state.tokens ? 'access' : ''),
        getRefreshToken: () => (state.tokens ? 'refresh' : ''),
        accountGuard: { getAccount: () => (state.account ? { email: 'her@example.com' } : null) },
        apiClient: {
            isAuthInvalidated: () => state.invalidated,
            getTokenManager: () => ({ getTokenExpiry: () => Promise.resolve(null) }),
            getSyncStatus: () => Promise.reject(new Error('offline')),
        },
        syncEngine: { getLastProcessingStatus: () => null },
    };
    const tab = new PensioSettingTab({} as any, plugin);
    (tab as any).renderConnectionStatus(fakeElement(texts));
    return { settingNames: [...settingNames], texts };
}

describe('every state that is not a working connection offers a way back', () => {
    it('a new install can pair', () => {
        expect(render({ tokens: false, account: false, invalidated: false }).settingNames)
            .toContain('Setup code');
    });

    it('an unverified connection can pair again', () => {
        const { settingNames: names, texts } = render({ tokens: true, account: false, invalidated: false });
        expect(names).toContain('Setup code');
        expect(names).toContain('Test connection');
        expect(texts).toContain('Connect Obsidian');
    });

    it('an expired session can pair again', () => {
        expect(render({ tokens: true, account: false, invalidated: true }).settingNames)
            .toContain('Setup code');
    });

    it('a working connection is not asked for a code', () => {
        const names = render({ tokens: true, account: true, invalidated: false }).settingNames;
        expect(names).not.toContain('Setup code');
        expect(names).toContain('Logout');
    });
});
