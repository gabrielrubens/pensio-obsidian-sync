/**
 * A vault's device id, tokens and sync history are its own on this device,
 * and data.json holds only the settings (plugin 0.8.0, plugin/deviceState.ts).
 *
 * ⛔ What 0.7 did, all from one cause, everything in the synced data.json:
 * - CRIT-6: every sync rewrote data.json, so a setting changed on another
 *   device was written back over within minutes;
 * - F30: the device id came from whichever device wrote data.json last, so
 *   after a reinstall or on a second machine the tokens no longer matched it
 *   and every refresh failed as *Session expired*;
 * - *Copied `.obsidian`*: a vault copied from another carried its history,
 *   and with Mirror delete on deleted the other vault's entries;
 * - CRIT-2 (defensive): one pair of SecretStorage names for every vault.
 *
 * Sabotage-checked (2026-10-21), each alone then restored:
 * - settleLegacy adopting tokens that name another vault → "another vault's
 *   tokens" RED;
 * - settleLegacy keeping the history with no tokens → "starts clean" RED;
 * - open() not emptying the shared names → "moves the tokens" RED;
 * - open() reading data.json again on a later run → "never data.json again" RED;
 * - persistable() writing this device's id → "writes nothing of this device"
 *   (settingDefinitions.test.ts) RED;
 * - saveSyncState writing data.json → "a sync saves the history here" RED;
 * - onExternalSettingsChange replacing the settings object, or taking the
 *   other device's id → "a setting changed on another device" RED;
 * - saveOnQuit not asking the engine to save (2026-10-22) → "saves what is
 *   waiting when Obsidian quits" RED;
 * - saveOnQuit adding a task on every quit (the first version, which left
 *   Obsidian running after ⌘Q) → "adds no task when nothing waits" RED.
 */
import PensioPlugin from '../main';
import {
    DEVICE_ID_KEY, DeviceIO, DeviceStore, LEGACY_SECRET_NAMES, Legacy, secretNames, settleLegacy, stateFile,
} from '../plugin/deviceState';
import { saveOnQuit } from '../plugin/wiring';
import { SyncStateData } from '../types';

/** A token shaped like Pensio's, minted for `deviceId`. */
function token(deviceId: string | null, kind: 'access' | 'refresh' = 'refresh'): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const claims = { token_type: kind, user_id: 'her-id', ...(deviceId ? { device_id: deviceId } : {}) };
    return `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

const HISTORY: SyncStateData = { userId: 'her-id', lastSyncTime: 1, files: { 'Journal/a.md': { hash: 'h', mtime: 1 } } };

function legacy(over: Partial<Legacy> = {}): Legacy {
    return {
        deviceId: 'obsidian-aaaa',
        syncState: HISTORY,
        tokens: { access: token('obsidian-aaaa', 'access'), refresh: token('obsidian-aaaa') },
        fromSharedNames: true,
        ...over,
    };
}

/** Obsidian's storage on one device: local storage, files, SecretStorage. */
function device() {
    const local = new Map<string, unknown>();
    const files = new Map<string, string>();
    const secrets = new Map<string, string>();
    const io: DeviceIO = {
        loadLocal: key => local.get(key) ?? null,
        saveLocal: (key, value) => { local.set(key, value); },
        read: async path => files.get(path) ?? null,
        write: async (path, text) => { files.set(path, text); },
        secrets: {
            getSecret: (id: string) => secrets.get(id) ?? null,
            setSecret: (id: string, value: string) => { secrets.set(id, value); },
            listSecrets: () => [...secrets.keys()],
        } as unknown as DeviceIO['secrets'],
    };
    return { io, local, files, secrets };
}

describe('the first run of 0.8.0 in a vault', () => {
    it('keeps the id and the history when the tokens were minted for this vault', () => {
        const settled = settleLegacy(legacy());

        expect(settled.deviceId).toBe('obsidian-aaaa');
        expect(settled.tokens.refresh).toBe(token('obsidian-aaaa'));
        expect(settled.syncState).toBe(HISTORY);
    });

    it('does not take another vault\'s tokens (CRIT-2)', () => {
        const settled = settleLegacy(legacy({ tokens: { access: 'a', refresh: token('obsidian-bbbb') } }), () => 'obsidian-new');

        expect(settled).toEqual({ deviceId: 'obsidian-new', tokens: { access: '', refresh: '' }, syncState: null });
    });

    it('keeps a token pasted by hand, which names the web\'s id, never a vault\'s', () => {
        const pasted = { access: 'a', refresh: token('web-abc') };

        expect(settleLegacy(legacy({ tokens: pasted })).tokens).toEqual(pasted);
    });

    it('starts clean with no tokens of its own: a copied vault, or a machine that never connected', () => {
        const settled = settleLegacy(legacy({ tokens: { access: '', refresh: '' } }), () => 'obsidian-new');

        expect(settled.deviceId).toBe('obsidian-new');
        expect(settled.syncState).toBeNull();
    });

    it('moves the tokens under this vault\'s own names, and empties the shared ones', async () => {
        const { io, local, files, secrets } = device();

        const opened = await DeviceStore.open(io, '.obsidian/plugins/pensio-sync', () => legacy());

        expect(opened.store.deviceId).toBe('obsidian-aaaa');
        expect(secrets.get(secretNames('obsidian-aaaa').refresh)).toBe(token('obsidian-aaaa'));
        expect(secrets.get(LEGACY_SECRET_NAMES.refresh)).toBe('');
        expect(local.get(DEVICE_ID_KEY)).toBe('obsidian-aaaa');
        expect(JSON.parse(files.get(stateFile('.obsidian/plugins/pensio-sync', 'obsidian-aaaa')) ?? 'null')).toEqual(HISTORY);
    });

    it('leaves another vault\'s tokens in the shared names for it', async () => {
        const { io, secrets } = device();
        secrets.set(LEGACY_SECRET_NAMES.refresh, token('obsidian-bbbb'));

        await DeviceStore.open(io, 'dir', () => legacy({ tokens: { access: 'a', refresh: token('obsidian-bbbb') } }));

        expect(secrets.get(LEGACY_SECRET_NAMES.refresh)).toBe(token('obsidian-bbbb'));
    });
});

describe('every later run', () => {
    it('reads this device\'s own id, tokens and history, and never data.json again', async () => {
        const { io } = device();
        const first = await DeviceStore.open(io, 'dir', () => legacy());
        first.store.writeTokens({ access: 'access-2', refresh: 'refresh-2' });

        const again = await DeviceStore.open(io, 'dir', () => { throw new Error('read data.json again'); });

        expect(again.store.deviceId).toBe('obsidian-aaaa');
        expect(again.tokens).toEqual({ access: 'access-2', refresh: 'refresh-2' });
        expect(again.syncState).toEqual(HISTORY);
    });

    it('starts the history again when its file cannot be read', async () => {
        const { io, files } = device();
        await DeviceStore.open(io, 'dir', () => legacy());
        files.set(stateFile('dir', 'obsidian-aaaa'), '{"files": {"Journal/a.md"');
        const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        const again = await DeviceStore.open(io, 'dir', () => legacy());

        expect(again.syncState).toBeNull();
        quiet.mockRestore();
    });
});

/** A real PensioPlugin with this device's store and Obsidian faked around it. */
async function plugin(dataJson: Record<string, unknown>) {
    const p = new (PensioPlugin as unknown as new () => PensioPlugin)();
    const internals = p as unknown as Record<string, unknown>;
    const { io } = device();
    internals.device = (await DeviceStore.open(io, 'dir', () => legacy())).store;
    internals.settings = {
        apiUrl: 'https://pensio.app', deviceId: 'obsidian-aaaa', autoSync: false,
        journalFolders: [{ folder: 'Journal' }], peopleFolder: 'People', enableMirrorDelete: true, debugMode: false,
    };
    internals.loadData = jest.fn(async () => dataJson);
    internals.saveData = jest.fn(async () => undefined);
    internals.apiClient = { updateSettings: jest.fn() };
    internals.syncEngine = { stopWatching: jest.fn(), startWatching: jest.fn(), startAutoSync: jest.fn() };
    internals.settingTab = { update: jest.fn() };
    return { p, internals };
}

describe('the plugin', () => {
    it('applies a setting changed on another device, and keeps this device\'s id', async () => {
        const { p, internals } = await plugin({ journalFolders: [{ folder: 'Work' }], deviceId: 'obsidian-other' });
        const settings = p.settings;

        await p.onExternalSettingsChange();

        // The same object: the sync and mirror delete read it live, so a
        // folder change defers mirror delete as one made here would.
        expect(p.settings).toBe(settings);
        expect(p.settings.journalFolders).toEqual([{ folder: 'Work' }]);
        expect(p.settings.deviceId).toBe('obsidian-aaaa');
        expect((internals.apiClient as { updateSettings: jest.Mock }).updateSettings).toHaveBeenCalled();
        expect((internals.settingTab as { update: jest.Mock }).update).toHaveBeenCalled();
    });

    it('saves a sync\'s history on this device, never in data.json', async () => {
        const { p, internals } = await plugin({});
        const store = internals.device as DeviceStore;
        const save = jest.spyOn(store, 'saveState');

        await (p as unknown as { saveSyncState: (s: SyncStateData) => Promise<void> }).saveSyncState(HISTORY);

        expect(save).toHaveBeenCalledWith(HISTORY);
        expect(internals.saveData).not.toHaveBeenCalled();
    });
});

describe('Obsidian quitting', () => {
    /** A plugin as `saveOnQuit` sees it, and the tasks Obsidian's quit collects. */
    function quitting(saveWaiting: boolean) {
        const handlers: Record<string, (tasks: { add: (fn: () => Promise<unknown>) => void }) => void> = {};
        const tasks: Promise<unknown>[] = [];
        const plugin = {
            registerEvent: jest.fn(),
            app: { workspace: { on: (name: string, fn: (typeof handlers)[string]) => { handlers[name] = fn; return {}; } } },
            syncEngine: { saveWaiting, saveNow: jest.fn(async () => undefined) },
        };
        saveOnQuit(plugin as unknown as PensioPlugin);
        return { plugin, tasks, quit: () => handlers['quit']({ add: fn => { tasks.push(fn()); } }) };
    }

    it('saves what is waiting when Obsidian quits, and Obsidian waits for it', async () => {
        const { plugin, tasks, quit } = quitting(true);

        quit();
        await Promise.all(tasks);

        expect(plugin.registerEvent).toHaveBeenCalled();
        expect(plugin.syncEngine.saveNow).toHaveBeenCalledTimes(1);
        expect(tasks).toHaveLength(1);
    });

    it('adds no task when nothing waits, so ⌘Q quits Obsidian at once', () => {
        // ⛔ Any task makes Obsidian cancel the quit and close only the
        // window (App.registerQuitHook): Obsidian then stays running.
        const { plugin, tasks, quit } = quitting(false);

        quit();

        expect(tasks).toHaveLength(0);
        expect(plugin.syncEngine.saveNow).not.toHaveBeenCalled();
    });
});
