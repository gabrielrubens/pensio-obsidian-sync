import { PensioSettings } from '../../types';
import { SyncEngine } from '../engine';
import { fakeVault } from './fakeVault';

// Mock obsidian module
jest.mock('obsidian');

/**
 * A People note's `aliases:` are the backend's to read, not the plugin's to send.
 *
 * The engine used to build every CreatePersonRequest with a hardcoded
 * `aliases: []`, and the backend's PersonSerializer assigns every key it is
 * handed — so re-syncing a People note EMPTIED the aliases its person had been
 * given in the web UI. Silent data loss on an existing field, once per sync.
 *
 * The fix is on both sides: the backend now parses `aliases:` out of the note's
 * frontmatter (and ignores a client-sent value when the note declares none, so
 * plugin versions already installed stop clobbering too), and the payload below
 * no longer carries the field at all.
 *
 * SABOTAGE 2026-10-19: put `aliases: []` back in the person payload in
 * engine.ts -> RED on "sends the People note without an aliases field" (and
 * `tsc -noEmit` rejects it too, since CreatePersonRequest has no such field —
 * two guards, deliberately). Restored.
 */
describe('Person sync payload: aliases', () => {
    let engine: SyncEngine;
    let mockApiClient: any;
    let mockApp: any;
    let settings: PensioSettings;

    const PERSON_NOTE = `---
title: Emma
aliases:
  - Em
relationship: family
---

My sister.
`;

    const peopleFile = {
        path: 'People/Emma.md',
        name: 'Emma.md',
        basename: 'Emma',
        extension: 'md',
        stat: { mtime: 1, ctime: 1, size: PERSON_NOTE.length },
    };

    /** The people array of the one bulkSync call that carried people. */
    const peopleSent = (): any[] => {
        const call = mockApiClient.bulkSync.mock.calls.find(
            (args: any[]) => Array.isArray(args[1]) && args[1].length > 0
        );
        return call ? call[1] : [];
    };

    beforeEach(() => {
        mockApiClient = {
            listEntries: jest.fn().mockResolvedValue([]),
            listPeople: jest.fn().mockResolvedValue([]),
            deleteEntry: jest.fn().mockResolvedValue(undefined),
            deletePerson: jest.fn().mockResolvedValue(undefined),
            bulkSync: jest.fn().mockResolvedValue({
                entries: { created: 0, updated: 0, deleted: 0, skipped: 0, errors: [] },
                people: { created: 1, updated: 0, deleted: 0, skipped: 0, errors: [] },
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
            enableMirrorDelete: false,
            debugMode: false,
        };

        mockApp = { vault: fakeVault(() => [peopleFile]) };
        mockApp.vault.read.mockResolvedValue(PERSON_NOTE);

        engine = new SyncEngine(mockApp, settings, mockApiClient);
    });

    it('sends the People note without an aliases field', async () => {
        await engine.syncAll(false);

        const people = peopleSent();
        expect(people).toHaveLength(1);
        expect(people[0].file_path).toBe('People/Emma.md');
        expect('aliases' in people[0].data).toBe(false);
    });

    it('sends the raw note, so the backend can read the aliases from it', async () => {
        await engine.syncAll(false);

        const sent = peopleSent()[0];
        expect(sent.data.name).toBe('Emma');
        expect(sent.data.metadata.raw_content).toContain('aliases:');
        expect(sent.data.metadata.raw_content).toContain('- Em');
    });
});
