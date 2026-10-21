/**
 * The settings tab as setting definitions (Obsidian 1.13), since plugin 0.6.1.
 *
 * ⭐ Why it moved: the Community plugin review reported that a tab without
 * getSettingDefinitions() does not appear in Obsidian's settings search, and
 * that display() and setWarning() are deprecated. These tests pin what the move
 * must not lose:
 * - every setting the old tab had is still there, and searchable;
 * - every control writes through plugin.saveSettings(), which keeps the sync
 *   state in data.json (the framework's default writer would drop it);
 * - every control key reads back what it wrote — an unknown key is ignored on
 *   write, so a typo in a key would silently save nothing;
 * - the journal folder list adds and removes, and saves both.
 *
 * Since 0.7.0 (design "B · Status card") the order is the card, the setup
 * code while there is no working connection, the journal folders, Sync, the
 * account once connected, and Advanced as a sub-page. Documentation and
 * Report an issue are icon buttons on the card, so they left search: they
 * are links, not settings.
 *
 * Sabotage-checked (2026-10-19), each alone then restored:
 * - setControlValue writing `saveData(this.plugin.settings)` instead of
 *   saveSettings() → "keeps the sync state" and "stops the file watcher" RED;
 * - a control key misspelled ('autosync') → "reads back what it wrote" RED;
 * - Mirror delete's row hidden (`visible: false`) → "every setting" RED;
 * - onDelete not saving → the list test RED.
 *
 * Re-checked on 0.7.0 (2026-10-20), each alone then restored:
 * - Advanced as a plain group instead of `type: 'page'` → "Advanced is a
 *   page" RED;
 * - the Sync group moved above the journal folders → "in this order" RED.
 *
 * 0.7.1: the mock draws the tab the way Obsidian 1.14.4 does (rows reused, a
 * sub-page's rows only while it is open), so what search can find is read
 * from the definitions, as Obsidian indexes them. And the manual token fields
 * apply only a whole pair (review F5). Re-checked (2026-10-20), each alone
 * then restored:
 * - tokenDefinition applying each keystroke again → "typing in a token field"
 *   RED;
 * - applyTokenDraft without the both-empty branch → "emptying both fields" RED.
 */
import { Setting } from 'obsidian';
import PensioPlugin from '../main';
import { PensioSettingTab } from '../settings';

type FakeText = { value: string; type: (value: string) => Promise<void> };
type Tab = PensioSettingTab & { open: () => void; openPage: (name: string) => void };

/** A token shaped like Pensio's: a JWT whose payload names the account. */
function token(userId: string, kind: 'access' | 'refresh'): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ token_type: kind, user_id: userId })).toString('base64url');
    return `${header}.${payload}.signature`;
}

interface Indexed { name: string; searchable: boolean; page?: string }
/** What Obsidian's settings search indexes: every definition, sub-pages included. */
function searchIndex(items: unknown[], page?: string): Indexed[] {
    const found: Indexed[] = [];
    for (const item of items as Array<{ type?: string; name?: string; items?: unknown[]; searchable?: boolean | (() => boolean) }>) {
        if (item.type === 'group' || item.type === 'list') {
            found.push(...searchIndex(item.items ?? [], page));
            continue;
        }
        const searchable = typeof item.searchable === 'function' ? item.searchable() : item.searchable !== false;
        found.push({ name: item.name ?? '', searchable, page });
        if (item.type === 'page') found.push(...searchIndex(item.items ?? [], item.name));
    }
    return found;
}

type FakeSetting = {
    texts: FakeText[];
    searchName: string;
    group: string | undefined;
    page: string | undefined;
    opensPage: boolean;
    searchable: boolean;
};
const rendered = (): FakeSetting[] => (Setting as unknown as { rendered: FakeSetting[] }).rendered;

interface PluginState {
    tokens: boolean;
    account: { email: string } | null;
}

/** A real PensioPlugin, with Obsidian and the network faked around it. */
function makePlugin(state: PluginState = { tokens: false, account: null }) {
    const p = new (PensioPlugin as unknown as new () => PensioPlugin)();
    const internals = p as unknown as Record<string, unknown>;
    internals.settings = {
        apiUrl: 'https://pensio.app',
        deviceId: 'device-1',
        autoSync: false,
        journalFolders: [{ folder: 'Journal' }],
        peopleFolder: 'People',
        enableMirrorDelete: false,
        debugMode: false,
    };
    internals._syncState = { userId: 'her-id', syncedFiles: { 'Journal/a.md': { hash: 'h', mtime: 1 } } };
    internals._accessToken = state.tokens ? 'access' : '';
    internals._refreshToken = state.tokens ? 'refresh' : '';
    internals.saveData = jest.fn(async () => undefined);
    internals.manifest = { version: '0.7.0' };
    internals.accountGuard = {
        getAccount: () => state.account,
        // The card checks saved tokens it has not seen work; offline here.
        verify: async () => ({ status: 'error', message: 'offline', error: new Error('net::ERR_INTERNET_DISCONNECTED') }),
    };
    internals.apiClient = {
        isAuthInvalidated: () => false,
        updateSettings: jest.fn(),
        getTokenManager: () => ({ getTokenExpiry: async () => null }),
        getSyncStatus: async () => ({ total_entries: 0 }),
    };
    internals.syncEngine = {
        stopWatching: jest.fn(),
        startWatching: jest.fn(),
        startAutoSync: jest.fn(),
        getLastProcessingStatus: () => null,
        getTrackedFileCount: () => 1,
        getLastSyncTime: () => null,
        getTooLargeNotes: () => [],
        setUserId: jest.fn(),
    };
    return p;
}

/** Let every pending promise chain finish. */
const settle = () => new Promise(resolve => setImmediate(resolve));

const saveData = (p: PensioPlugin) => (p as unknown as { saveData: jest.Mock }).saveData;

/** She opens the plugin's settings. */
function renderTab(p: PensioPlugin): Tab {
    const tab = new PensioSettingTab({} as never, p) as Tab;
    tab.update();
    tab.open();
    return tab;
}

const field = (name: string): FakeText => {
    const row = rendered().find(s => s.searchName === name);
    if (!row) throw new Error(`no ${name}`);
    return row.texts[0];
};

/** Every control definition, wherever it sits in groups and lists. */
function controlKeys(items: unknown[]): string[] {
    const keys: string[] = [];
    for (const item of items as Array<{ items?: unknown[]; control?: { key: string } }>) {
        if (item.items) keys.push(...controlKeys(item.items));
        if (item.control) keys.push(item.control.key);
    }
    return keys;
}

describe('the settings tab', () => {
    it('keeps every setting the old tab had, and each is searchable', () => {
        const disconnected = renderTab(makePlugin());
        const offered = searchIndex(disconnected.settingItems).filter(s => s.searchable).map(s => s.name);
        expect(offered).toEqual(expect.arrayContaining([
            'Connect to Pensio', 'Setup code',
            'Folder 1', 'People folder', 'Auto-sync',
            'Server URL', 'Mirror delete', 'Debug mode',
            'Access token', 'Refresh token', 'Test connection',
        ]));
        expect(disconnected.settingItems.length).toBeGreaterThan(0);

        const tab = renderTab(makePlugin({ tokens: true, account: { email: 'her@example.com' } }));
        const connected = searchIndex(tab.settingItems).filter(s => s.searchable).map(s => s.name);
        expect(connected).toEqual(expect.arrayContaining(['Open Pensio', 'Manage devices', 'Connect again', 'Disconnect']));
    });

    it('draws the tab in this order: the card, folders, Sync, the account, Advanced', () => {
        const onTheTab = () => rendered().filter(s => s.page === undefined).map(s => s.searchName);

        renderTab(makePlugin());
        expect(onTheTab()).toEqual(['Connect to Pensio', 'Setup code', 'Folder 1', 'People folder', 'Auto-sync', 'Advanced']);

        renderTab(makePlugin({ tokens: true, account: { email: 'her@example.com' } }));
        // Emotion analysis is drawn once there is a reading to show.
        expect(onTheTab()).toEqual([
            'Connection', 'Folder 1', 'People folder', 'Auto-sync',
            'Open Pensio', 'Manage devices', 'Connect again', 'Disconnect',
            'Advanced',
        ]);
    });

    it('Advanced is a page, and settings search still reaches every setting on it', () => {
        const tab = renderTab(makePlugin());

        const advanced = rendered().find(s => s.searchName === 'Advanced');
        expect(advanced?.opensPage).toBe(true);
        const ADVANCED = ['Server URL', 'Mirror delete', 'Debug mode', 'Access token', 'Refresh token', 'Test connection'];
        const indexed = searchIndex(tab.settingItems).filter(s => s.page === 'Advanced');
        expect(indexed.map(s => s.name)).toEqual(ADVANCED);
        expect(indexed.every(s => s.searchable)).toBe(true);

        tab.openPage('Advanced');
        expect(rendered().map(s => s.searchName)).toEqual(ADVANCED);
    });

    it('typing in a token field applies nothing until both hold a whole pair', async () => {
        const p = makePlugin();
        const setTokens = jest.spyOn(p, 'setTokens').mockResolvedValue(undefined);
        const forget = jest.spyOn(p, 'forgetTokens').mockResolvedValue(undefined);
        const tab = renderTab(p);
        tab.openPage('Advanced');

        await field('Access token').type('eyJhbGciOi');               // half pasted
        await field('Access token').type(token('her-id', 'access'));  // one whole token
        expect(setTokens).not.toHaveBeenCalled();
        expect(forget).not.toHaveBeenCalled();

        await field('Refresh token').type(token('her-id', 'refresh'));
        expect(setTokens).toHaveBeenCalledTimes(1);
        expect(setTokens).toHaveBeenCalledWith(token('her-id', 'access'), token('her-id', 'refresh'));
    });

    it('emptying both fields forgets the tokens, and only then', async () => {
        const p = makePlugin({ tokens: true, account: null });
        const internals = p as unknown as Record<string, unknown>;
        internals._accessToken = token('her-id', 'access');
        internals._refreshToken = token('her-id', 'refresh');
        const setTokens = jest.spyOn(p, 'setTokens').mockResolvedValue(undefined);
        const forget = jest.spyOn(p, 'forgetTokens').mockResolvedValue(undefined);
        const tab = renderTab(p);
        tab.openPage('Advanced');

        await field('Access token').type('');
        expect(forget).not.toHaveBeenCalled();
        await field('Refresh token').type('');

        expect(forget).toHaveBeenCalledTimes(1);
        expect(setTokens).not.toHaveBeenCalled();
    });

    it('keeps the sync state when a setting changes', async () => {
        const p = makePlugin();
        const tab = renderTab(p);

        await tab.setControlValue('debugMode', true);

        expect(saveData(p)).toHaveBeenCalledTimes(1);
        const written = saveData(p).mock.calls[0][0] as Record<string, unknown>;
        expect(written.debugMode).toBe(true);
        expect(written._syncState).toEqual(expect.objectContaining({ userId: 'her-id' }));
    });

    it('stops the file watcher when Auto-sync is switched off', async () => {
        const p = makePlugin({ tokens: true, account: null });
        (p.settings as { autoSync: boolean }).autoSync = true;
        const tab = renderTab(p);

        await tab.setControlValue('autoSync', false);

        const engine = (p as unknown as { syncEngine: { stopWatching: jest.Mock; startWatching: jest.Mock } }).syncEngine;
        expect(engine.stopWatching).toHaveBeenCalled();
        expect(engine.startWatching).not.toHaveBeenCalled();
    });

    it('reads back what each control wrote', async () => {
        const p = makePlugin();
        const tab = renderTab(p);
        const keys = controlKeys(tab.settingItems);
        expect(keys).toEqual(expect.arrayContaining(['peopleFolder', 'autoSync', 'apiUrl', 'journalFolders.0']));

        for (const key of keys) {
            const before = tab.getControlValue(key);
            const next = typeof before === 'boolean' ? !before : `Changed/${key}`;
            await tab.setControlValue(key, next);
            expect(tab.getControlValue(key)).toBe(next);
        }
    });

    it('stores folders trimmed and normalized, and a cleared folder as empty', async () => {
        const p = makePlugin();
        const tab = renderTab(p);

        await tab.setControlValue('journalFolders.0', '  Journal/2026/ ');
        await tab.setControlValue('peopleFolder', '   ');

        expect(p.settings.journalFolders[0].folder).toBe('Journal/2026');
        expect(p.settings.peopleFolder).toBe('');
    });

    it('ignores a key it does not know, and saves nothing', async () => {
        const p = makePlugin();
        const tab = renderTab(p);

        await tab.setControlValue('deviceId', 'someone-else');

        expect(p.settings.deviceId).toBe('device-1');
        expect(saveData(p)).not.toHaveBeenCalled();
    });

    it('adds and removes journal folders, saving each change', async () => {
        const p = makePlugin();
        const tab = renderTab(p);
        const list = () => (tab.settingItems as Array<{ type?: string; addItem?: { action: (el: HTMLElement) => void }; onDelete?: (i: number) => void }>)
            .find(item => item.type === 'list')!;

        list().addItem!.action({} as HTMLElement);
        await settle();
        expect(p.settings.journalFolders).toEqual([{ folder: 'Journal' }, { folder: '' }]);
        expect(rendered().map(s => s.searchName)).toContain('Folder 2');

        list().onDelete!(0);
        await settle();
        expect(p.settings.journalFolders).toEqual([{ folder: '' }]);
        expect(saveData(p)).toHaveBeenCalledTimes(2);
    });
});
