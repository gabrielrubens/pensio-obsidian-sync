import { CreateEntryRequest, CreatePersonRequest, DEFAULT_SETTINGS, PersonResponse } from '../types';

describe('PensioSettings', () => {
    it('should have correct default settings', () => {
        expect(DEFAULT_SETTINGS.apiUrl).toBe('');
        expect(DEFAULT_SETTINGS.apiToken).toBe('');
        expect(DEFAULT_SETTINGS.deviceId).toBe('');
        expect(DEFAULT_SETTINGS.autoSync).toBe(false);
        expect(DEFAULT_SETTINGS.syncInterval).toBe(5);
    });

    it('should have individual folder settings', () => {
        expect(DEFAULT_SETTINGS.journalFolder).toBe('Journal');
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

    it('should have mirror delete disabled by default', () => {
        expect(DEFAULT_SETTINGS.enableMirrorDelete).toBe(false);
    });
});

describe('API Request Types', () => {
    it('CreateEntryRequest should have all required fields', () => {
        const entry: CreateEntryRequest = {
            title: 'Test Entry',
            content_html: '<p>Test</p>',
            content_plain: 'Test',
            entry_date: '2026-01-23',
            entry_type: 'daily_journal',
            file_path: 'Journal/test.md',
            frontmatter: {},
            file_modified_at: '2026-01-23T12:00:00Z'
        };

        expect(entry.title).toBe('Test Entry');
        expect(entry.entry_type).toBe('daily_journal');
    });

    it('CreatePersonRequest should have all required fields', () => {
        const person: CreatePersonRequest = {
            name: 'Alice Johnson',
            aliases: ['Alice', 'AJ'],
            person_note_path: 'People/Alice Johnson.md',
            relationship: 'friend',
            birthday: '1990-05-15',
            tags: ['work', 'friend'],
            from_locations: ['USA'],
            lived_in: ['Berlin', 'London'],
            metadata: { notes: 'Met at conference' }
        };

        expect(person.name).toBe('Alice Johnson');
        expect(person.aliases).toContain('Alice');
        expect(person.tags).toContain('work');
    });
});

describe('API Response Types', () => {
    it('PersonResponse should include all fields', () => {
        const person: PersonResponse = {
            id: 'uuid-123',
            name: 'Bob Smith',
            aliases: [],
            person_note_path: 'People/Bob Smith.md',
            relationship: '',
            birthday: null,
            tags: [],
            from_locations: [],
            lived_in: [],
            metadata: {},
            source: 'vault_sync',
            created_at: '2026-01-23T12:00:00Z',
            updated_at: '2026-01-23T12:00:00Z'
        };

        expect(person.id).toBe('uuid-123');
        expect(person.source).toBe('vault_sync');
    });

});

describe('Folder Type Detection Logic', () => {
    it('should detect people folder paths correctly', () => {
        const peopleFolder = 'People';

        // Files inside people folder
        expect('People/alice.md'.startsWith(peopleFolder + '/')).toBe(true);
        expect('People/bob.md'.startsWith(peopleFolder + '/')).toBe(true);

        // Files outside people folder
        expect('Journal/entry.md'.startsWith(peopleFolder + '/')).toBe(false);
        expect('Templates/daily.md'.startsWith(peopleFolder + '/')).toBe(false);
    });

    it('should detect journal folder paths correctly', () => {
        const journalFolder = 'Journal';
        const peopleFolder = 'People';

        // Journal files
        const journalPath = 'Journal/2026-01-23.md';
        const isInJournal = journalPath.startsWith(journalFolder + '/');
        const isInPeople = journalPath.startsWith(peopleFolder + '/');

        expect(isInJournal).toBe(true);
        expect(isInPeople).toBe(false);
    });

    it('should handle empty folder settings', () => {
        const emptyFolder = '';
        const filePath = 'Journal/entry.md';

        // Empty folder should not match
        expect(filePath.startsWith(emptyFolder + '/')).toBe(false);
        expect(emptyFolder.trim().length === 0).toBe(true);
    });
});

