/**
 * The status card and the connection rows, drawn the way Obsidian draws them,
 * in every state, with their buttons pressed.
 *
 * ⛔ The first bug (2026-10-18): tokens stored but no account cached — after a
 * restart with tokens revoked on the web, or simply dead — rendered "Tokens
 * entered — not yet verified" and a Test connection button, and no setup-code
 * field. Every state but a verified connection now shows the way to connect.
 *
 * ⛔ The second (plugin 0.7.0, Gabriel's screenshots of 2026-10-20): every
 * redraw of the card added another brand line and another icon, because
 * Obsidian redraws a row by calling render again on the SAME row, and the old
 * test mock built a fresh one each time, so no test could see it (review F1,
 * F16). The mock now reuses rows the way Obsidian 1.14.4 does
 * (src/__mocks__/obsidian.ts), and these tests open the tab, redraw it, and
 * count what is on it.
 *
 * Sabotage-checked (2026-10-18, 0.5.2): drop the setup code from the
 * unverified state → RED; Test connection not re-rendering on a dead session
 * → RED; Disconnect not calling plugin.logout → RED; Connect not calling
 * plugin.startOneClickConnect → RED.
 * Re-checked on the status card (2026-10-20, 0.7.0): onChange redrawing
 * instead of repainting → "repaints in place" RED; Disconnect without the
 * dialog → "asks first" RED; "Connect" for "Connect to Pensio" and no version
 * → "comes first" RED.
 * Re-checked on 0.7.1 (2026-10-20), each alone then restored:
 * - renderCard without dropCardParts (the 0.7.0 code) → "one brand line and
 *   one icon" RED (2, 3, … copies);
 * - the card keeping its old subscriptions (neither the cleanup nor the next
 *   render unsubscribing) → "one brand line and one icon" RED (the listener
 *   count grows);
 * - the card starting its own check instead of the shared one → "share one
 *   check" RED;
 * - the tab not following the connection while closed → "opens as it is now"
 *   RED;
 * - the setup code not kept on the section → "survives a redraw" RED;
 * - the Sync now label written to the captured button only → "Syncing… after
 *   a redraw" RED;
 * - the couldn't-check card without Connect → "Connect to Pensio beside Try
 *   again" RED.
 */
import { ConfirmationModal, Setting } from 'obsidian';
import { AccountCheck } from '../accountCheck';
import { HttpError } from '../errors';
import PensioPlugin from '../main';
import { PensioSettingTab } from '../settings';
import { SyncStatus } from '../syncStatus';

type FakeButton = { text: string; cta: boolean; destructive: boolean; disabled: boolean; click: (() => unknown) | null };
type FakeText = { value: string; type: (value: string) => Promise<void> };
type FakeNode = { textContent: string; find: (cls: string) => { attrs: Record<string, string> }[] };
type FakeSetting = {
    name: string;
    desc: string;
    searchName: string;
    group: string | undefined;
    page: string | undefined;
    classes: string[];
    buttons: FakeButton[];
    texts: FakeText[];
    renders: number;
    settingEl: FakeNode;
};
type FakeModal = { title: string; opened: boolean; cancel: boolean; buttons: FakeButton[] };

const rendered = (): FakeSetting[] => (Setting as unknown as { rendered: FakeSetting[] }).rendered;
const card = (): FakeSetting => {
    const found = rendered().find(s => s.classes.includes('pensio-status-card'));
    if (!found) throw new Error('no status card');
    return found;
};
/** What the definitions are called, as settings search finds them. */
const names = (): string[] => rendered().map(s => s.searchName);
const settingNamed = (name: string): FakeSetting => {
    const found = rendered().find(s => s.searchName === name);
    if (!found) throw new Error(`no setting named ${name}; rendered: ${names().join(', ')}`);
    return found;
};
const buttonsOf = (s: FakeSetting) => s.buttons.map(b => [b.text, b.cta]);
const lastModal = (): FakeModal => (ConfirmationModal as unknown as { last: FakeModal }).last;

/** Let every pending promise chain finish. */
const settle = () => new Promise(resolve => setImmediate(resolve));
const settleAll = async () => { for (let i = 0; i < 10; i++) await settle(); };
/** Settle until `done`, or give up after a while. */
const until = async (done: () => boolean) => {
    for (let i = 0; i < 30 && !done(); i++) await settle();
};

interface FakePluginState {
    tokens: boolean;
    account: { email: string } | null;
    invalidated: boolean;
}

function makePlugin(state: FakePluginState, verify?: (options: { onError?: (e: unknown) => void }) => boolean) {
    const plugin = {
        app: {},
        manifest: { version: '0.7.1' },
        settings: { apiUrl: 'https://pensio.app', journalFolders: [], peopleFolder: '', autoSync: true },
        getAccessToken: () => (state.tokens ? 'access' : ''),
        getRefreshToken: () => (state.tokens ? 'refresh' : ''),
        previousRefresh: () => (state.tokens ? 'refresh' : ''),
        accountGuard: { getAccount: () => state.account },
        apiClient: {
            isAuthInvalidated: () => state.invalidated,
            getSyncStatus: jest.fn(async () => ({ total_entries: 0 })),
        },
        syncEngine: {
            getLastProcessingStatus: () => null,
            getTrackedFileCount: () => 0,
            getLastSyncTime: () => null,
        },
        syncStatus: null as unknown as SyncStatus,
        accountCheck: null as unknown as AccountCheck,
        register: jest.fn(),
        failureContext: () => ({ apiUrl: 'https://pensio.app', retries: false }),
        verifyAccountBeforeSync: jest.fn(async (options: { onError?: (e: unknown) => void } = {}) => {
            // A request takes a turn of the event loop, as a real one does, so a
            // check that loops shows up as a count instead of hanging the run.
            await settle();
            if (verify) return verify(options);
            // The server said 401 and the refresh could not cure it.
            state.invalidated = true;
            return false;
        }),
        startOneClickConnect: jest.fn(async () => undefined),
        syncNow: jest.fn(async () => undefined),
        logout: jest.fn(async () => {
            state.tokens = false;
            state.account = null;
            plugin.syncStatus.reset();
        }),
    };
    plugin.syncStatus = new SyncStatus({
        statusBar: () => null,
        isAuthInvalidated: () => state.invalidated,
        trackedCount: () => 0,
        failureContext: plugin.failureContext,
    });
    plugin.accountCheck = new AccountCheck(
        (onError) => plugin.verifyAccountBeforeSync({ onError }),
        plugin.failureContext,
        () => plugin.syncStatus.changed(),
    );
    return plugin;
}

/** She opens the plugin's settings: Obsidian draws the tab. */
function open(state: FakePluginState, verify?: (options: { onError?: (e: unknown) => void }) => boolean) {
    const plugin = makePlugin(state, verify);
    const tab = new PensioSettingTab({} as never, plugin as unknown as PensioPlugin);
    tab.update();
    (tab as unknown as { open: () => void }).open();
    return { tab, plugin };
}

const listeners = (plugin: { syncStatus: SyncStatus }) =>
    (plugin.syncStatus as unknown as { listeners: Set<unknown> }).listeners.size;

const nothing = () => ({ tokens: false, account: null, invalidated: false });
const connected = () => ({ tokens: true, account: { email: 'her@example.com' }, invalidated: false });
const unchecked = () => ({ tokens: true, account: null, invalidated: false });
const busy = (options: { onError?: (e: unknown) => void }) => {
    options.onError?.(new HttpError('Rate limit exceeded.', 429));
    return false;
};

describe('the status card', () => {
    it('comes first, with the name, the version and Connect to Pensio', () => {
        open(nothing());

        expect(rendered()[0]).toBe(card());
        expect(card().settingEl.textContent).toContain('Pensio – AI Journaling');
        expect(card().settingEl.textContent).toContain('v0.7.1');
        expect(card().name).toBe('Not connected');
        expect(card().desc).toBe('No account? Create one free');
        expect(buttonsOf(card())).toEqual([['Connect to Pensio', true]]);
        expect(card().settingEl.find('extra-setting-button').map(b => b.attrs.tooltip)).toEqual(['Documentation', 'Report an issue']);
    });

    it('draws one brand line and one icon however often it is redrawn', async () => {
        const { tab, plugin } = open(unchecked(), busy);
        await until(() => card().name === 'Couldn’t check the connection');
        const row = card();
        const subscribed = listeners(plugin);

        for (let press = 0; press < 3; press++) {
            await card().buttons.find(b => b.text === 'Try again')?.click?.();
            await settleAll();
        }
        for (let i = 0; i < 5; i++) tab.update();
        await settleAll();

        expect(card()).toBe(row);                 // the same row, drawn again …
        expect(row.renders).toBeGreaterThan(3);
        expect(row.settingEl.find('pensio-card-top')).toHaveLength(1);   // … and nothing piled up
        expect(row.settingEl.find('pensio-card-icon')).toHaveLength(1);
        expect(listeners(plugin)).toBe(subscribed);
    });

    it('says who is connected, and Sync now syncs', async () => {
        const { plugin } = open(connected());

        expect(card().name).toBe('Connected');
        expect(card().desc).toBe('her@example.com · 0 notes · not synced yet');
        await card().buttons[0].click?.();

        expect(card().buttons[0].text).toBe('Sync now');
        expect(plugin.syncNow).toHaveBeenCalled();
    });

    it('still says Syncing… after a redraw during the sync, and Sync now after it', async () => {
        const { tab, plugin } = open(connected());
        let finish: () => void = () => undefined;
        plugin.syncNow.mockImplementation(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined); }));

        const pressed = card().buttons[0].click?.();
        tab.update();                               // something redraws mid-sync
        expect([card().buttons[0].text, card().buttons[0].disabled]).toEqual(['Syncing…', true]);

        finish();
        await pressed;
        expect([card().buttons[0].text, card().buttons[0].disabled]).toEqual(['Sync now', false]);
    });

    it('repaints the card in place when a sync fails, without redrawing the tab', () => {
        const { plugin } = open(connected());
        const before = card();
        const renders = before.renders;

        plugin.syncStatus.failed(new HttpError('Bad gateway', 502), { asked: false });

        // The same row, not drawn again: a redraw would take the cursor out of a folder field.
        expect(card()).toBe(before);
        expect(before.renders).toBe(renders);
        expect(before.name).toBe('Not syncing');
        expect(before.desc).toBe('Pensio’s server had a problem (error 502). Last tried just now.');
    });

    it('offers Connect to Pensio and the setup code under it when the session is dead', () => {
        open({ tokens: true, account: null, invalidated: true });

        expect(card().name).toBe('Session expired');
        expect(card().buttons[0].text).toBe('Connect to Pensio');
        expect(names().slice(0, 2)).toEqual(['Connect to Pensio', 'Setup code']);
    });

    it('checks saved tokens itself, once, and lands on what it found', async () => {
        const { plugin } = open(unchecked());

        expect(card().name).toBe('Checking connection…');
        expect(names()).toContain('Setup code');
        await until(() => card().name !== 'Checking connection…');
        await settleAll();

        expect(plugin.verifyAccountBeforeSync).toHaveBeenCalledTimes(1);
        // ⛔ Not the "she asked" rule: a 401 here must not end a live connection (review F22).
        expect(plugin.verifyAccountBeforeSync).not.toHaveBeenCalledWith(expect.objectContaining({ reconnectOn401: true }));
        expect(card().name).toBe('Session expired');
    });

    it('and the card and a connect share one check', async () => {
        const { plugin } = open(unchecked(), () => false);

        void plugin.accountCheck.run();             // what adoptConnection does
        await settleAll();

        expect(plugin.verifyAccountBeforeSync).toHaveBeenCalledTimes(1);
    });

    it('offers Connect to Pensio beside Try again when it could not check, and does not loop', async () => {
        const { plugin } = open(unchecked(), busy);
        await until(() => card().name === 'Couldn’t check the connection');
        await settleAll();

        expect(plugin.verifyAccountBeforeSync).toHaveBeenCalledTimes(1);
        expect(card().desc).toBe('Pensio is limiting requests for now. Nothing is lost. Try again later: this can last up to an hour.');
        expect(buttonsOf(card())).toEqual([['Try again', true], ['Connect to Pensio', false]]);

        await card().buttons[1].click?.();
        expect(plugin.startOneClickConnect).toHaveBeenCalled();

        await card().buttons[0].click?.();
        await until(() => plugin.verifyAccountBeforeSync.mock.calls.length === 2);
        expect(plugin.verifyAccountBeforeSync).toHaveBeenCalledTimes(2);
    });

    it('opens the browser for one click, and then says it is waiting', async () => {
        const { plugin } = open(nothing());

        await card().buttons[0].click?.();

        expect(plugin.startOneClickConnect).toHaveBeenCalled();
        expect(card().buttons[0].text).toBe('Waiting for your browser…');
    });
});

describe('the connection rows', () => {
    it('offers the setup code under the card whenever nothing works', () => {
        open(nothing());
        expect(names().slice(0, 2)).toEqual(['Connect to Pensio', 'Setup code']);
    });

    it('keeps a setup code being typed when the tab redraws', async () => {
        const { tab } = open(nothing());
        await settingNamed('Setup code').texts[0].type('ABCD-EFGH');

        tab.update();                               // the card's check finishing, say

        expect(settingNamed('Setup code').texts[0].value).toBe('ABCD-EFGH');
    });

    it('puts the account at the end once connected, with no setup code', () => {
        open(connected());

        const account = rendered().filter(s => s.group === 'Account').map(s => s.searchName);
        // Emotion analysis is drawn only once there is a reading to show.
        expect(account).toEqual(['Open Pensio', 'Manage devices', 'Connect again', 'Disconnect']);
        expect(names()).not.toContain('Setup code');
    });

    it('lets a connected vault connect again, and shows the setup code while it waits', async () => {
        const { plugin } = open(connected());
        const again = settingNamed('Connect again').buttons[0];
        expect([again.text, again.cta]).toEqual(['Connect to Pensio', false]);

        await again.click?.();

        expect(plugin.startOneClickConnect).toHaveBeenCalled();
        expect(settingNamed('Setup code').group).toBe('Account');
    });

    it('Disconnect asks first, and only the dialog’s Disconnect disconnects', async () => {
        const { plugin } = open(connected());

        const disconnect = settingNamed('Disconnect').buttons[0];
        expect(disconnect.destructive).toBe(true);
        await disconnect.click?.();

        expect(plugin.logout).not.toHaveBeenCalled();
        const modal = lastModal();
        expect(modal.opened).toBe(true);
        expect(modal.cancel).toBe(true);
        expect(modal.title).toBe('Disconnect this vault?');

        const confirm = modal.buttons[0];
        expect([confirm.text, confirm.destructive]).toEqual(['Disconnect', true]);
        await confirm.click?.();
        await settleAll();

        expect(plugin.logout).toHaveBeenCalled();
        expect(card().name).toBe('Not connected');
    });

    it('opens as it is now after the connection changed while the settings were closed', () => {
        const state = connected();
        const { tab, plugin } = open(state);
        (tab as unknown as { close: () => void }).close();

        state.invalidated = true;                   // the session dies meanwhile
        plugin.syncStatus.connectionStopped();
        (tab as unknown as { open: () => void }).open();

        expect(card().name).toBe('Session expired');
        expect(names()).toContain('Setup code');
        expect(names()).not.toContain('Disconnect');
    });

    it('Test connection is on the Advanced page, and a 401 there turns the card to Session expired', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'queueMicrotask'] });
        try {
            const { tab, plugin } = open({ tokens: true, account: { email: 'her@example.com' }, invalidated: false });
            const advanced = tab as unknown as { openPage: (n: string) => void; closePage: () => void };
            advanced.openPage('Advanced');
            const test = settingNamed('Test connection');
            expect(test.page).toBe('Advanced');

            await test.buttons[0].click?.();
            await settleAll();
            advanced.closePage();

            expect(plugin.verifyAccountBeforeSync).toHaveBeenCalledWith(expect.objectContaining({ reconnectOn401: true }));
            expect(card().name).toBe('Session expired');
        } finally {
            jest.useRealTimers();
        }
    });
});
