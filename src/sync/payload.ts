import { TFile } from 'obsidian';
import { CreateEntryRequest, CreatePersonRequest } from '../types';
import { extractDateFromFilename, ParsedMarkdown } from './parser';

export type BuiltNote =
    | { kind: 'person'; data: CreatePersonRequest }
    | { kind: 'entry'; data: CreateEntryRequest };

/**
 * The bulk payload for a note, as the server's create/update/rename read it.
 * `contentType` is the folder rule's answer for the note (`SyncFolders`).
 */
export function buildData(file: TFile, parsed: ParsedMarkdown, contentType: string): BuiltNote {
    if (contentType === 'person') {
        return {
            kind: 'person',
            data: {
                // No `aliases` key, deliberately. The backend reads
                // `aliases:` out of the note's own frontmatter, the
                // way it already reads relationship and birthday —
                // and this sent a hardcoded `[]` with every note it
                // re-sends, which EMPTIED aliases typed in the web
                // UI on the next sync. The field a note does not
                // speak for is a field this payload leaves out.
                // ⭐ The filename, never `title:` (2026-10-21): a `[[link]]`
                // in Obsidian names the file. The server decides it too, so
                // every plugin version agrees (`bulk_views._named_by_their_note`).
                name: file.basename,
                person_note_path: file.path,
                relationship: '',
                birthday: null,
                tags: [],
                from_locations: [],
                lived_in: [],
                metadata: { raw_content: parsed.content },
            },
        };
    }
    const entryDate = parsed.date
        || extractDateFromFilename(file.name)
        || new Date(file.stat.ctime).toISOString().slice(0, 10);
    return {
        kind: 'entry',
        data: {
            title: parsed.title || file.basename,
            content_html: parsed.content,
            content_plain: parsed.content,
            entry_date: entryDate,
            entry_type: parsed.entryType || contentType,
            file_path: file.path,
            frontmatter: {},
            file_modified_at: new Date(file.stat.mtime).toISOString(),
        },
    };
}
