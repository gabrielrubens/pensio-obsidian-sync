/**
 * The status card and the connection rows, drawn the way Obsidian draws them,
 * in every state, with their buttons pressed.
 *
 * ⛔ The first bug (2026-10-18): tokens stored but no account cached — after a
 * restart with tokens revoked on the web, or simply dead — rendered "Tokens
 * entered — not yet verified" and a Test connection button, and no setup-code
 * field. The person was stuck: the only way out was clearing the token fields
 * under Advanced. Every state but a verified connection now shows the way to
 * connect, and saved tokens are checked by the card itself.
 *
 * ⭐ Since 0.7.0 the tab is design "B · Status card": the card on top says
 * whether this vault is syncing and carries Connect to Pensio or Sync now; the
 * setup code sits under it while there is no working connection; the account
 * rows and Disconnect are an Account group at the end; Test connection is on
 * the Advanced page. The test renders as Obsidian does: `update()` builds the
 * definitions and the mock draws them (src/__mocks__/obsidian.ts), so a click
 * that redraws really draws the next state.
 *
 * Sabotage-checked (2026-10-18, 0.5.2): drop the setup code from the
 * unverified state → RED; Test connection not re-rendering on a dead session
 * → RED; Disconnect not calling plugin.logout → RED; Connect not calling
 * plugin.startOneClickConnect → RED.
 *
 * Re-checked on the status card (2026-10-20), each alone then restored:
 * - the card's onChange redrawing the tab instead of repainting → "repaints
 *   the card in place" RED;
 * - startCheck without the once-per-tokens guard → "checks them once" RED
 *   (the check loops);
 * - Disconnect calling logout() without the dialog → "asks first" RED;
 * - the card's connect button labelled "Connect" → "the card comes first" RED;
 * - the brand without the manifest version → "the card comes first" RED.
 */
import { ConfirmationModal, ExtraButtonComponent, Setting } from 'obsidian';
import { HttpError } from '../errors';
import PensioPlugin from '../main';
import { PensioSettingTab } from '../settings';
import { SyncStatus } from '../syncStatus';

type FakeButton = { text: string; cta: boolean; destructive: boolean; click: (() => unknown) | null };
type FakeSetting = {
    name: string;
    searchName: string;
    group: string | undefined;
    page: string | undefined;
    classes: string[];
    buttons: FakeButton[];
    settingEl: { recorded: string };
    descEl: { recorded: string };
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
const lastModal = (): FakeModal => (ConfirmationModal as unknown as { last: FakeModal }).last;
const iconTips = (): string[] =>
    (ExtraButtonComponent as unknown as { rendered: { tooltip: string }[] }).rendered.map(b => b.tooltip);

/** Let every pending promise chain finish. */
const settle = () => new Promise(resolve => setImmediate(resolve));
/** Settle until `done`, or give up after a while. */
const until = async (done: () => boolean) => {
    for (let i = 0; i < 20 && !done(); i++) await settle();
};

interface FakePluginState {
    tokens: boolean;
    account: { email: string } | null;
    invalidated: boolean;
}

function makePlugin(state: FakePluginState, verify?: (options: { onError?: (e: unknown) => void }) => boolean) {
    const plugin = {
        app: {},
        manifest: { version: '0.7.0' },
        settings: { apiUrl: 'https://pensio.app', journalFolders: [], peopleFolder: '', autoSync: true },
        getAccessToken: () => (state.tokens ? 'access' : ''),
        getRefreshToken: () => (state.tokens ? 'refresh' : ''),
        accountGuard: { getAccount: () => state.account },
        apiClient: {
            isAuthInvalidated: () => state.invalidated,
            getSyncStatus: async () => ({ total_entries: 0 }),
        },
        syncEngine: {
            getLastProcessingStatus: () => null,
            getTrackedFileCount: () => 0,
            getLastSyncTime: () => null,
        },
        syncStatus: null as unknown as SyncStatus,
        failureContext: () => ({ apiUrl: 'https://pensio.app', autoSync: true }),
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
        }),
    };
    plugin.syncStatus = new SyncStatus({
        statusBar: () => null,
        isAuthInvalidated: () => state.invalidated,
        trackedCount: () => 0,
        failureContext: plugin.failureContext,
    });
    return plugin;
}

/** Renders the tab the way Obsidian does: build the definitions, draw them. */
function render(state: FakePluginState, verify?: (options: { onError?: (e: unknown) => void }) => boolean) {
    const plugin = makePlugin(state, verify);
    const tab = new PensioSettingTab({} as never, plugin as unknown as PensioPlugin);
    tab.update();
    return { tab, plugin };
}

const nothing = { tokens: false, account: null, invalidated: false };
const connected = () => ({ tokens: true, account: { email: 'her@example.com' }, invalidated: false });

describe('the status card', () => {
    it('comes first, with the name, the version and Connect to Pensio', () => {
        render(nothing);

        expect(rendered()[0]).toBe(card());
        expect(card().settingEl.recorded).toContain('Pensio – AI Journaling');
        expect(card().settingEl.recorded).toContain('v0.7.0');
        expect(card().name).toBe('Not connected');
        expect(card().descEl.recorded).toBe('No account? Create one free');
        expect(card().buttons.map(b => [b.text, b.cta])).toEqual([['Connect to Pensio', true]]);
        expect(iconTips()).toEqual(['Documentation', 'Report an issue']);
    });

    it('says who is connected, and Sync now syncs', async () => {
        const { plugin } = render(connected());

        expect(card().name).toBe('Connected');
        expect(card().descEl.recorded).toBe('her@example.com · 0 notes · not synced yet');
        await card().buttons[0].click?.();

        expect(card().buttons[0].text).toBe('Sync now');
        expect(plugin.syncNow).toHaveBeenCalled();
    });

    it('repaints the card in place when a sync fails, without redrawing the tab', () => {
        const { plugin } = render(connected());
        const before = card();

        plugin.syncStatus.failed(new HttpError('Bad gateway', 502), { asked: false });

        // The same row: a redraw would take the cursor out of a folder field.
        expect(card()).toBe(before);
        expect(before.name).toBe('Not syncing');
        expect(before.descEl.recorded).toBe('Pensio’s server had a problem (error 502). Last tried just now.');
    });

    it('offers Connect to Pensio and the setup code under it when the session is dead', () => {
        render({ tokens: true, account: null, invalidated: true });

        expect(card().name).toBe('Session expired');
        expect(card().buttons[0].text).toBe('Connect to Pensio');
        expect(names().slice(0, 2)).toEqual(['Connect to Pensio', 'Setup code']);
    });

    it('checks saved tokens itself, once, and lands on what it found', async () => {
        const { plugin } = render({ tokens: true, account: null, invalidated: false });

        expect(card().name).toBe('Checking connection…');
        expect(names()).toContain('Setup code');
        await until(() => card().name !== 'Checking connection…');
        for (let i = 0; i < 10; i++) await settle();

        expect(plugin.verifyAccountBeforeSync).toHaveBeenCalledTimes(1);
        expect(plugin.verifyAccountBeforeSync).toHaveBeenCalledWith(expect.objectContaining({ reconnectOn401: true }));
        expect(card().name).toBe('Session expired');
    });

    it('says when it could not check them, offers Try again, and does not loop', async () => {
        const { plugin } = render({ tokens: true, account: null, invalidated: false }, (options) => {
            options.onError?.(new Error('net::ERR_INTERNET_DISCONNECTED'));
            return false;
        });
        await until(() => card().name !== 'Checking connection…');
        for (let i = 0; i < 10; i++) await settle();

        expect(plugin.verifyAccountBeforeSync).toHaveBeenCalledTimes(1);
        expect(card().name).toBe('Couldn’t check the connection');
        expect(card().descEl.recorded).toBe('Couldn’t reach Pensio.');

        await card().buttons[0].click?.();
        await until(() => plugin.verifyAccountBeforeSync.mock.calls.length === 2);
        expect(plugin.verifyAccountBeforeSync).toHaveBeenCalledTimes(2);
    });

    it('opens the browser for one click, and then says it is waiting', async () => {
        const { plugin } = render(nothing);

        await card().buttons[0].click?.();

        expect(plugin.startOneClickConnect).toHaveBeenCalled();
        expect(card().buttons[0].text).toBe('Waiting for your browser…');
    });
});

describe('the connection rows', () => {
    it('offers the setup code under the card whenever nothing works', () => {
        render(nothing);
        expect(names().slice(0, 2)).toEqual(['Connect to Pensio', 'Setup code']);
    });

    it('puts the account at the end once connected, with no setup code', () => {
        render(connected());

        const account = rendered().filter(s => s.group === 'Account').map(s => s.searchName);
        expect(account).toEqual(['Emotion analysis', 'Open Pensio', 'Manage devices', 'Connect again', 'Disconnect']);
        expect(names()).not.toContain('Setup code');
    });

    it('lets a connected vault connect again, and shows the setup code while it waits', async () => {
        const { plugin } = render(connected());
        const again = settingNamed('Connect again').buttons[0];
        expect([again.text, again.cta]).toEqual(['Connect to Pensio', false]);

        await again.click?.();

        expect(plugin.startOneClickConnect).toHaveBeenCalled();
        expect(settingNamed('Setup code').group).toBe('Account');
    });

    it('Disconnect asks first, and only the dialog’s Disconnect disconnects', async () => {
        const { plugin } = render(connected());

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

        expect(plugin.logout).toHaveBeenCalled();
        expect(card().name).toBe('Not connected');
    });

    it('Test connection is on the Advanced page, and a 401 there turns the card to Session expired', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate'] });
        try {
            const { plugin } = render({ tokens: true, account: { email: 'her@example.com' }, invalidated: false });
            const test = settingNamed('Test connection');
            expect(test.page).toBe('Advanced');

            await test.buttons[0].click?.();

            expect(plugin.verifyAccountBeforeSync).toHaveBeenCalledWith(expect.objectContaining({ reconnectOn401: true }));
            expect(card().name).toBe('Session expired');
        } finally {
            jest.useRealTimers();
        }
    });
});
