import { CreateEntryRequest, CreatePersonRequest, CreatePromptRequest, DEFAULT_SETTINGS, PersonResponse, PromptResponse } from '../types';

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

    it('CreatePromptRequest should have all required fields', () => {
        const prompt: CreatePromptRequest = {
            title: 'Test Prompt',
            content: 'What are you grateful for?',
            content_html: '<p>What are you grateful for?</p>',
            description: 'Daily gratitude',
            file_path: 'Prompts/gratitude.md'
        };

        expect(prompt.title).toBe('Test Prompt');
        expect(prompt.description).toBe('Daily gratitude');
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

    it('PromptResponse should include usage_count', () => {
        const prompt: PromptResponse = {
            id: 'uuid-456',
            title: 'Weekly Review',
            content: 'Review questions...',
            content_html: '<p>Review questions...</p>',
            description: 'End of week reflection',
            source: 'vault_sync',
            file_path: 'Prompts/weekly.md',
            file_hash: 'abc123',
            created_at: '2026-01-23T12:00:00Z',
            updated_at: '2026-01-23T12:00:00Z',
            usage_count: 5
        };

        expect(prompt.id).toBe('uuid-456');
        expect(prompt.usage_count).toBe(5);
    });
});

describe('Folder Type Detection Logic', () => {
    it('should detect prompt folder paths correctly', () => {
        const promptFolder = 'Journal/Prompts';

        // Files inside prompt folder
        expect('Journal/Prompts/daily.md'.startsWith(promptFolder + '/')).toBe(true);
        expect('Journal/Prompts/weekly.md'.startsWith(promptFolder + '/')).toBe(true);

        // Files outside prompt folder
        expect('Journal/entry.md'.startsWith(promptFolder + '/')).toBe(false);
        expect('People/alice.md'.startsWith(promptFolder + '/')).toBe(false);
    });

    it('should detect people folder paths correctly', () => {
        const peopleFolder = 'People';

        // Files inside people folder
        expect('People/alice.md'.startsWith(peopleFolder + '/')).toBe(true);
        expect('People/bob.md'.startsWith(peopleFolder + '/')).toBe(true);

        // Files outside people folder
        expect('Journal/entry.md'.startsWith(peopleFolder + '/')).toBe(false);
        expect('Prompts/daily.md'.startsWith(peopleFolder + '/')).toBe(false);
    });

    it('should detect journal folder paths correctly', () => {
        const journalFolder = 'Journal';
        const promptFolder = 'Journal/Prompts';
        const peopleFolder = 'People';

        // Journal files (not in prompt subfolder)
        const journalPath = 'Journal/2026-01-23.md';
        const isInJournal = journalPath.startsWith(journalFolder + '/');
        const isInPrompt = journalPath.startsWith(promptFolder + '/');
        const isInPeople = journalPath.startsWith(peopleFolder + '/');

        expect(isInJournal).toBe(true);
        expect(isInPrompt).toBe(false);
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

