import { DEFAULT_SETTINGS, JournalFolderMapping, PensioSettings, SyncStateData } from '../types';
import { Tokens } from './tokenStore';

/** Pre-0.3.0 folder mappings carried extra per-folder fields. */
interface LegacyFolderMapping extends JournalFolderMapping {
    entryType?: string;
    label?: string;
}

/**
 * Shape of the plugin's persisted data.json. Settings fields plus the sync
 * state and two legacy plaintext-token keys migrated to SecretStorage.
 */
interface PersistedData extends Partial<PensioSettings> {
    _syncState?: SyncStateData | null;
    apiToken?: string;
    refreshToken?: string;
}

/**
 * What 0.8.0 no longer keeps in data.json, read once on a device's first run
 * (`plugin/deviceState.ts::settleLegacy`) and written back unchanged.
 *
 * ⭐ Written back because data.json is shared: an older version on another
 * device still reads its device id and sync history from it, and that
 * device's tokens are bound to that id. ⛔ So this version never writes its
 * own id or history here: an id written here becomes the other device's on
 * its next load, which is how F30 happened.
 */
export interface Passthrough {
    deviceId: string;
    syncState: SyncStateData | null;
}

/** What data.json holds, read and migrated. */
export interface LoadedData {
    settings: PensioSettings;
    passthrough: Passthrough;
    /** Plaintext tokens an old version left in data.json, to move to SecretStorage. */
    legacyTokens: Tokens | null;
}

/** Read data.json (as `loadData` returned it), migrating what old versions wrote. */
export function parsePersisted(raw: unknown): LoadedData {
    const rawData = (raw ?? {}) as PersistedData;

    // Extract sync state before merging with settings defaults
    const syncState = rawData._syncState ?? null;
    const settingsData: PersistedData = { ...rawData };
    delete settingsData._syncState;

    // Legacy plaintext tokens → SecretStorage (one-time)
    let legacyTokens: Tokens | null = null;
    if (settingsData.apiToken || settingsData.refreshToken) {
        legacyTokens = { access: settingsData.apiToken || '', refresh: settingsData.refreshToken || '' };
        delete settingsData.apiToken;
        delete settingsData.refreshToken;
    }

    const settings: PensioSettings = Object.assign({}, DEFAULT_SETTINGS, settingsData);

    // Migrate old folder mappings that had entryType/label fields (pre-0.3.0)
    const folders = settings.journalFolders as LegacyFolderMapping[];
    if (folders?.length > 0 && folders[0].entryType !== undefined) {
        settings.journalFolders = folders.map(
            (m): JournalFolderMapping => ({ folder: m.folder })
        );
    }
    return { settings, passthrough: { deviceId: settings.deviceId, syncState }, legacyTokens };
}

/** What data.json is written as: the settings, and what `Passthrough` keeps for older versions. */
export function persistable(settings: PensioSettings, passthrough: Passthrough): Record<string, unknown> {
    const data: Record<string, unknown> = { ...settings, deviceId: passthrough.deviceId };
    if (passthrough.syncState) {
        data._syncState = passthrough.syncState;
    }
    return data;
}
