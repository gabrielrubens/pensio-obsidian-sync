import { SecretStorage } from 'obsidian';
import { tokenDeviceId } from '../auth/identity';
import { SyncStateData } from '../types';
import { readTokens, Tokens, writeTokens } from './tokenStore';

/**
 * What belongs to this vault ON THIS DEVICE, kept out of the synced data.json
 * (plugin 0.8.0, 2026-10-21).
 *
 * ⛔ **Until 0.8.0 all of it lived in data.json**, which a vault synced between
 * devices (Obsidian Sync, iCloud, Syncthing) carries from one to the other:
 * - every sync rewrote data.json, so a setting changed on one device was written
 *   back over by the other within minutes (review CRIT-6);
 * - the device id arrived from the other device: after a reinstall, or on a
 *   second machine whose data.json came late, the id no longer matched the
 *   tokens and every refresh failed as *Session expired* (F30);
 * - a vault set up by copying another's `.obsidian` carried that vault's sync
 *   history, so with Mirror delete on its first syncs deleted the other
 *   vault's entries (*Copied `.obsidian`*).
 *
 * Now:
 * - **the device id** is in this vault's local storage on this device
 *   (`app.saveLocalStorage`, never synced, kept through a reinstall);
 * - **the sync history** is a file named by that id (`stateFile`), because a
 *   large vault's history is megabytes, more than local storage holds on a
 *   phone. Another device's file is never read;
 * - **the tokens** are in SecretStorage under names that carry the id
 *   (`secretNames`), so two vaults never share them, even where SecretStorage
 *   is shared (review CRIT-2, defensive: Obsidian documents it as per vault);
 * - **data.json** holds the settings, and is written only when they change.
 */

/** The device id's key in this vault's local storage. */
export const DEVICE_ID_KEY = 'pensio-device-id';

/** The SecretStorage names before 0.8.0: one pair for every vault. */
export const LEGACY_SECRET_NAMES = { access: 'pensio-access-token', refresh: 'pensio-refresh-token' };

/** Where this vault keeps its tokens on this device. */
export function secretNames(deviceId: string): { access: string; refresh: string } {
    return {
        access: `${LEGACY_SECRET_NAMES.access}-${deviceId}`,
        refresh: `${LEGACY_SECRET_NAMES.refresh}-${deviceId}`,
    };
}

/** The sync history's file, inside the plugin's own folder. */
export function stateFile(pluginDir: string, deviceId: string): string {
    return `${pluginDir}/devices/${deviceId}.json`;
}

/** A device id, as every version has made them. */
export function newDeviceId(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return 'obsidian-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** What 0.7 left behind for this vault, read once, the first time 0.8.0 runs. */
export interface Legacy {
    /** data.json's `deviceId`: the id of whichever device wrote it last. */
    deviceId: string;
    /** data.json's `_syncState`. */
    syncState: SyncStateData | null;
    /** Tokens under the names every vault shared, or plaintext in data.json. */
    tokens: Tokens;
    /** They came from the shared names, not from data.json. */
    fromSharedNames: boolean;
}

export interface Settled {
    deviceId: string;
    tokens: Tokens;
    syncState: SyncStateData | null;
}

export const NO_TOKENS: Tokens = { access: '', refresh: '' };

/**
 * The first time 0.8.0 runs in this vault on this device: which id, tokens and
 * history are this vault's own.
 *
 * ⭐ **The tokens decide.** They are this vault's when they were minted for the
 * device id in its data.json, and then the id and the history stay: nothing
 * reconnects and nothing is sent again. They are not when they name another
 * vault's id, which is how one vault's tokens reach another where SecretStorage
 * is shared (CRIT-2); a token pasted by hand names the web's id, never a vault's,
 * so it stays. With no tokens of its own, the vault starts clean under a new id:
 * a copied vault, or a second machine that never connected, no longer inherits
 * another's history (F30, *Copied `.obsidian`*).
 */
export function settleLegacy(legacy: Legacy, newId: () => string = newDeviceId): Settled {
    const claim = tokenDeviceId(legacy.tokens.refresh);
    const anotherVaults = claim !== null && claim.startsWith('obsidian-') && claim !== legacy.deviceId;
    const ours = !!legacy.tokens.refresh && !anotherVaults;
    if (!ours) return { deviceId: newId(), tokens: NO_TOKENS, syncState: null };
    return {
        deviceId: legacy.deviceId || newId(),
        tokens: legacy.tokens,
        syncState: legacy.syncState,
    };
}

/** What the store reads and writes: Obsidian's, behind an interface tests can fake. */
export interface DeviceIO {
    loadLocal(key: string): unknown;
    saveLocal(key: string, value: unknown): void;
    /** A file's text, or null when there is none. */
    read(path: string): Promise<string | null>;
    write(path: string, text: string): Promise<void>;
    secrets: SecretStorage;
}

export interface Opened {
    store: DeviceStore;
    tokens: Tokens;
    syncState: SyncStateData | null;
}

/** This vault's own id, tokens and sync history on this device. */
export class DeviceStore {
    private constructor(
        private readonly io: DeviceIO,
        private readonly dir: string,
        readonly deviceId: string,
    ) { }

    /**
     * Open the store. The first time (no id in local storage), settle what 0.7
     * left (`settleLegacy`), move it here, and empty the shared token names when
     * the tokens in them were this vault's. ⭐ The id is saved last, so a first
     * run cut short settles again rather than half.
     */
    static async open(io: DeviceIO, dir: string, legacy: () => Legacy): Promise<Opened> {
        const saved = io.loadLocal(DEVICE_ID_KEY);
        if (typeof saved === 'string' && saved) {
            const store = new DeviceStore(io, dir, saved);
            return { store, tokens: store.readTokens(), syncState: await store.loadState() };
        }
        const old = legacy();
        const settled = settleLegacy(old);
        const store = new DeviceStore(io, dir, settled.deviceId);
        store.writeTokens(settled.tokens);
        if (settled.tokens.refresh && old.fromSharedNames) {
            writeTokens(io.secrets, LEGACY_SECRET_NAMES, NO_TOKENS);
        }
        if (settled.syncState) await store.saveState(settled.syncState);
        io.saveLocal(DEVICE_ID_KEY, settled.deviceId);
        return { store, tokens: settled.tokens, syncState: settled.syncState };
    }

    readTokens(): Tokens {
        return readTokens(this.io.secrets, secretNames(this.deviceId), NO_TOKENS);
    }

    writeTokens(tokens: Tokens): void {
        writeTokens(this.io.secrets, secretNames(this.deviceId), tokens);
    }

    /** The saved sync history, or null. ⭐ A file that cannot be read starts it
     * again: every note is sent once more, and mirror delete, which works
     * from the history, has nothing to delete. */
    async loadState(): Promise<SyncStateData | null> {
        try {
            const text = await this.io.read(stateFile(this.dir, this.deviceId));
            const parsed: unknown = text ? JSON.parse(text) : null;
            const state = parsed as SyncStateData | null;
            return state && typeof state === 'object' && state.files && typeof state.files === 'object' ? state : null;
        } catch (error) {
            console.error('Pensio: the sync history could not be read; starting it again.', error);
            return null;
        }
    }

    /** Save the sync history; null forgets it. */
    async saveState(state: SyncStateData | null): Promise<void> {
        await this.io.write(stateFile(this.dir, this.deviceId), JSON.stringify(state));
    }
}
