import { EntryResponse, PensioSettings, PersonResponse } from '../../types';
import { SyncEngine } from '../engine';
import { FakeFile, fakeVault } from './fakeVault';

// Mock obsidian module
jest.mock('obsidian');

describe('Mirror Delete Safety', () => {
    let engine: SyncEngine;
    let mockApiClient: any;
    let mockApp: any;
    let settings: PensioSettings;
    let localFiles: FakeFile[];

    const makeEntry = (overrides: Partial<EntryResponse> = {}): EntryResponse => ({
        id: 'entry-1',
        title: 'Test',
        content_html: '',
        content_plain: '',
        entry_date: '2026-01-01',
        entry_type: 'daily_journal',
        source: 'obsidian_plugin',
        file_path: 'Journal/test.md',
        file_hash: 'abc',
        frontmatter: {},
        primary_emotion: '',
        file_modified_at: '2026-01-01T00:00:00Z',
        api_last_modified: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        people: [],
        ...overrides,
    });

    const makePerson = (overrides: Partial<PersonResponse> = {}): PersonResponse => ({
        id: 'person-1',
        name: 'Alice',
        aliases: [],
        person_note_path: 'People/Alice.md',
        relationship: '',
        birthday: null,
        tags: [],
        from_locations: [],
        lived_in: [],
        metadata: {},
        source: 'obsidian_plugin',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        ...overrides,
    });

    beforeEach(() => {
        mockApiClient = {
            listEntries: jest.fn().mockResolvedValue([]),
            listPeople: jest.fn().mockResolvedValue([]),
            deleteEntry: jest.fn().mockResolvedValue(undefined),
            deletePerson: jest.fn().mockResolvedValue(undefined),
            bulkSync: jest.fn().mockResolvedValue({
                entries: { created: 0, updated: 0, deleted: 0, skipped: 0, errors: [] },
                people: { created: 0, updated: 0, deleted: 0, skipped: 0, errors: [] },
                total_time_ms: 0,
            }),
            isAuthInvalidated: jest.fn().mockReturnValue(false),
            getSyncStatus: jest.fn().mockResolvedValue({ last_sync: null, total_entries: 0 }),
        };

        settings = {
            apiUrl: 'https://pensio.app',
            deviceId: 'test',
            autoSync: false,
            journalFolders: [{ folder: 'Journal' }],
            peopleFolder: 'People',
            enableMirrorDelete: true,
            debugMode: false,
        };

        // ⭐ One note present by default. Since 0.7.1 mirror delete does not
        // run when a sync sees no notes at all (review F10), so a test that
        // started from an empty vault would pass for that reason alone and stop
        // testing which entries it keeps.
        localFiles = [{ path: 'Journal/kept.md' }];
        mockApp = { vault: fakeVault(() => localFiles) };
        mockApp.vault.read.mockResolvedValue('hello');

        engine = new SyncEngine(mockApp, settings, mockApiClient);
    });

    // --- Entry tests ---

    it('should delete server entry not in local vault', async () => {
        const entry = makeEntry({ id: 'e1', file_path: 'Journal/deleted.md', source: 'obsidian_plugin' });
        mockApiClient.listEntries.mockResolvedValue([entry]);

        await engine.syncAll(false);

        expect(mockApiClient.deleteEntry).toHaveBeenCalledWith('e1');
    });

    it('should NOT delete entry with matching local file', async () => {
        const entry = makeEntry({ id: 'e1', file_path: 'Journal/exists.md', source: 'obsidian_plugin' });
        mockApiClient.listEntries.mockResolvedValue([entry]);

        localFiles = [{ path: 'Journal/exists.md' }];
        mockApp.vault.read.mockResolvedValue('hello');

        await engine.syncAll(false);

        expect(mockApiClient.deleteEntry).not.toHaveBeenCalled();
    });

    it('should NOT delete entry with no file_path (web-created)', async () => {
        const entry = makeEntry({ id: 'e1', file_path: null, source: 'web_gui' });
        mockApiClient.listEntries.mockResolvedValue([entry]);

        await engine.syncAll(false);

        expect(mockApiClient.deleteEntry).not.toHaveBeenCalled();
    });

    it('should NOT delete entry with source !== obsidian_plugin', async () => {
        const webEntry = makeEntry({ id: 'e1', file_path: 'Journal/web.md', source: 'web_gui' });
        const fsEntry = makeEntry({ id: 'e2', file_path: 'Journal/fs.md', source: 'file_system_sync' });
        mockApiClient.listEntries.mockResolvedValue([webEntry, fsEntry]);

        await engine.syncAll(false);

        expect(mockApiClient.deleteEntry).not.toHaveBeenCalled();
    });

    it('should only delete obsidian_plugin entries among mixed sources', async () => {
        const pluginEntry = makeEntry({ id: 'e1', file_path: 'Journal/gone.md', source: 'obsidian_plugin' });
        const webEntry = makeEntry({ id: 'e2', file_path: 'Journal/web.md', source: 'web_gui' });
        mockApiClient.listEntries.mockResolvedValue([pluginEntry, webEntry]);

        await engine.syncAll(false);

        expect(mockApiClient.deleteEntry).toHaveBeenCalledTimes(1);
        expect(mockApiClient.deleteEntry).toHaveBeenCalledWith('e1');
    });

    // --- Person tests ---

    it('should delete server person not in local vault', async () => {
        const person = makePerson({ id: 'p1', person_note_path: 'People/Gone.md', source: 'obsidian_plugin' });
        mockApiClient.listPeople.mockResolvedValue([person]);

        await engine.syncAll(false);

        expect(mockApiClient.deletePerson).toHaveBeenCalledWith('p1');
    });

    it('should NOT delete person with matching local file', async () => {
        const person = makePerson({ id: 'p1', person_note_path: 'People/Alice.md', source: 'obsidian_plugin' });
        mockApiClient.listPeople.mockResolvedValue([person]);

        localFiles = [{ path: 'People/Alice.md' }];
        mockApp.vault.read.mockResolvedValue('hello');

        await engine.syncAll(false);

        expect(mockApiClient.deletePerson).not.toHaveBeenCalled();
    });

    it('should NOT delete person with no person_note_path', async () => {
        const person = makePerson({ id: 'p1', person_note_path: '', source: 'obsidian_plugin' });
        mockApiClient.listPeople.mockResolvedValue([person]);

        await engine.syncAll(false);

        expect(mockApiClient.deletePerson).not.toHaveBeenCalled();
    });

    it('should NOT delete person with source !== obsidian_plugin', async () => {
        const person = makePerson({ id: 'p1', person_note_path: 'People/Web.md', source: 'web_gui' });
        mockApiClient.listPeople.mockResolvedValue([person]);

        await engine.syncAll(false);

        expect(mockApiClient.deletePerson).not.toHaveBeenCalled();
    });

    it('should NOT delete anything when the sync sees no notes at all', async () => {
        // An empty view of the vault is far likelier a misconfiguration than a
        // vault emptied while Obsidian was closed (review F10).
        localFiles = [];
        mockApiClient.listEntries.mockResolvedValue([makeEntry({ id: 'e1', file_path: 'Journal/gone.md' })]);

        await engine.syncAll(false);

        expect(mockApiClient.listEntries).not.toHaveBeenCalled();
        expect(mockApiClient.deleteEntry).not.toHaveBeenCalled();
    });

    // --- Mirror delete disabled ---

    it('should NOT delete anything when mirror delete is disabled', async () => {
        settings.enableMirrorDelete = false;
        engine = new SyncEngine(mockApp, settings, mockApiClient);

        const entry = makeEntry({ id: 'e1', file_path: 'Journal/gone.md', source: 'obsidian_plugin' });
        const person = makePerson({ id: 'p1', person_note_path: 'People/Gone.md', source: 'obsidian_plugin' });
        mockApiClient.listEntries.mockResolvedValue([entry]);
        mockApiClient.listPeople.mockResolvedValue([person]);

        await engine.syncAll(false);

        expect(mockApiClient.listEntries).not.toHaveBeenCalled();
        expect(mockApiClient.listPeople).not.toHaveBeenCalled();
        expect(mockApiClient.deleteEntry).not.toHaveBeenCalled();
        expect(mockApiClient.deletePerson).not.toHaveBeenCalled();
    });
});
