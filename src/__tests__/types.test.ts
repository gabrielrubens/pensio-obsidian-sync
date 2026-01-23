import { DEFAULT_SETTINGS } from '../types';

describe('JournalWiseSettings', () => {
    it('should have correct default settings', () => {
        expect(DEFAULT_SETTINGS.apiUrl).toBe('');
        expect(DEFAULT_SETTINGS.apiToken).toBe('');
        expect(DEFAULT_SETTINGS.deviceId).toBe('');
        expect(DEFAULT_SETTINGS.autoSync).toBe(false);
        expect(DEFAULT_SETTINGS.syncInterval).toBe(5);
    });

    it('should have individual folder settings', () => {
        expect(DEFAULT_SETTINGS.journalFolder).toBe('Journal');
        expect(DEFAULT_SETTINGS.promptFolder).toBe('Prompts');
        expect(DEFAULT_SETTINGS.peopleFolder).toBe('People');
    });

    it('should not have deviceName field', () => {
        expect((DEFAULT_SETTINGS as any).deviceName).toBeUndefined();
    });

    it('should not have syncFolders array', () => {
        expect((DEFAULT_SETTINGS as any).syncFolders).toBeUndefined();
    });

    it('should have exclude patterns', () => {
        expect(DEFAULT_SETTINGS.excludePatterns).toContain('.obsidian/**');
        expect(DEFAULT_SETTINGS.excludePatterns).toContain('.trash/**');
    });

    it('should have conflict resolution strategy', () => {
        expect(DEFAULT_SETTINGS.conflictResolution).toBe('server-wins');
    });

    it('should have max entry size', () => {
        expect(DEFAULT_SETTINGS.maxEntrySizeMB).toBe(5);
    });
});
