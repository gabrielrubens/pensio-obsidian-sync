/**
 * Tests for markdown parser
 * 
 * Philosophy: Plugin is lightweight, just sends raw markdown to backend.
 * Backend handles all parsing, validation, and processing.
 * 
 * The parser extracts:
 * - Title from frontmatter (NOT from H1 headers)
 * - Date from frontmatter (various formats) with fallback to filename
 * - Entry type from frontmatter (normalized to Pensio types)
 */

import {
    extractDateFromFilename,
    extractDateFromFrontmatter,
    extractEntryType,
    parseDateString,
    parseMarkdown
} from '../parser';

describe('parseMarkdown', () => {
    it('should extract title from frontmatter', () => {
        const content = '---\ntitle: My Journal Entry\ndate: 2026-01-23\n---\n# Context\n\nBody text';
        const result = parseMarkdown(content);

        expect(result.title).toBe('My Journal Entry');
        expect(result.content).toBe(content);
    });

    it('should handle quoted title in frontmatter', () => {
        const content = '---\ntitle: "My Quoted Title"\ndate: 2026-01-23\n---\n\nContent';
        const result = parseMarkdown(content);

        expect(result.title).toBe('My Quoted Title');
    });

    it('should handle single-quoted title in frontmatter', () => {
        const content = "---\ntitle: 'Single Quoted'\n---\n\nContent";
        const result = parseMarkdown(content);

        expect(result.title).toBe('Single Quoted');
    });

    it('should NOT extract title from H1 - avoids section headers like Context', () => {
        const content = '# Context\n\nThis is a section, not the title';
        const result = parseMarkdown(content);

        expect(result.title).toBe('');
        expect(result.content).toBe(content);
    });

    it('should return empty title if no frontmatter', () => {
        const content = 'Just some content without frontmatter';
        const result = parseMarkdown(content);

        expect(result.title).toBe('');
        expect(result.date).toBeNull();
        expect(result.entryType).toBeNull();
        expect(result.content).toBe(content);
    });

    it('should return empty title if frontmatter has no title field', () => {
        const content = '---\ndate: 2026-01-23\ntags: [journal]\n---\n# Context\n\nBody text';
        const result = parseMarkdown(content);

        expect(result.title).toBe('');
        expect(result.content).toBe(content);
    });

    it('should preserve raw markdown with frontmatter', () => {
        const content = '---\ntitle: Test\ndate: 2026-01-23\n---\n# Content\n\nBody text';
        const result = parseMarkdown(content);

        expect(result.content).toBe(content);
        expect(result.content).toContain('---');
        expect(result.content).toContain('title: Test');
    });

    it('should preserve wikilinks - backend extracts them', () => {
        const content = 'Met with [[John Smith]] and [[Jane Doe]]';
        const result = parseMarkdown(content);

        expect(result.content).toContain('[[John Smith]]');
        expect(result.content).toContain('[[Jane Doe]]');
    });

    it('should extract date alongside title', () => {
        const content = '---\ntitle: My Day\ndate: 2024-09-04\n---\nBody';
        const result = parseMarkdown(content);

        expect(result.title).toBe('My Day');
        expect(result.date).toBe('2024-09-04');
    });

    it('should extract entry type alongside title and date', () => {
        const content = '---\ntitle: Deep Thoughts\ndate: 2024-09-04\ntype: deep_dive\n---\nBody';
        const result = parseMarkdown(content);

        expect(result.title).toBe('Deep Thoughts');
        expect(result.date).toBe('2024-09-04');
        expect(result.entryType).toBe('deep_dive');
    });
});

describe('extractDateFromFrontmatter', () => {
    it('should extract date from "date" key', () => {
        expect(extractDateFromFrontmatter('date: 2024-09-04')).toBe('2024-09-04');
    });

    it('should extract date from "Created" key (case-insensitive)', () => {
        expect(extractDateFromFrontmatter('Created: 2024-09-04')).toBe('2024-09-04');
    });

    it('should extract date from "created_at" key', () => {
        expect(extractDateFromFrontmatter('created_at: 2024-09-04')).toBe('2024-09-04');
    });

    it('should extract date from "entry_date" key', () => {
        expect(extractDateFromFrontmatter('entry_date: 2024-09-04')).toBe('2024-09-04');
    });

    it('should handle ISO datetime without seconds (Created: 2024-09-04T22:28)', () => {
        expect(extractDateFromFrontmatter('Created: 2024-09-04T22:28')).toBe('2024-09-04');
    });

    it('should handle ISO datetime with seconds', () => {
        expect(extractDateFromFrontmatter('date: 2024-09-04T22:28:00')).toBe('2024-09-04');
    });

    it('should handle ISO datetime with timezone', () => {
        expect(extractDateFromFrontmatter('date: 2024-09-04T22:28:00+02:00')).toBe('2024-09-04');
    });

    it('should handle ISO datetime with Z timezone', () => {
        expect(extractDateFromFrontmatter('date: 2024-09-04T22:28:00Z')).toBe('2024-09-04');
    });

    it('should handle slash-separated dates', () => {
        expect(extractDateFromFrontmatter('date: 2024/09/04')).toBe('2024-09-04');
    });

    it('should prioritize "date" over "created"', () => {
        const fm = 'created: 2024-01-01\ndate: 2024-09-04';
        expect(extractDateFromFrontmatter(fm)).toBe('2024-09-04');
    });

    it('should fall back to "created" if "date" is absent', () => {
        expect(extractDateFromFrontmatter('created: 2024-09-04')).toBe('2024-09-04');
    });

    it('should handle quoted date values', () => {
        expect(extractDateFromFrontmatter('date: "2024-09-04"')).toBe('2024-09-04');
    });

    it('should handle single-quoted date values', () => {
        expect(extractDateFromFrontmatter("date: '2024-09-04'")).toBe('2024-09-04');
    });

    it('should return null if no date key found', () => {
        expect(extractDateFromFrontmatter('title: No Date')).toBeNull();
    });

    it('should return null for empty frontmatter', () => {
        expect(extractDateFromFrontmatter('')).toBeNull();
    });

    it('should handle multiline frontmatter with date in the middle', () => {
        const fm = 'title: My Entry\nCreated: 2024-09-04T22:28\ntags: [journal]';
        expect(extractDateFromFrontmatter(fm)).toBe('2024-09-04');
    });
});

describe('parseDateString', () => {
    it('should parse YYYY-MM-DD', () => {
        expect(parseDateString('2024-09-04')).toBe('2024-09-04');
    });

    it('should parse ISO datetime without seconds', () => {
        expect(parseDateString('2024-09-04T22:28')).toBe('2024-09-04');
    });

    it('should parse ISO datetime with seconds', () => {
        expect(parseDateString('2024-09-04T22:28:00')).toBe('2024-09-04');
    });

    it('should parse ISO datetime with timezone', () => {
        expect(parseDateString('2024-09-04T22:28:00+02:00')).toBe('2024-09-04');
    });

    it('should parse YYYY/MM/DD', () => {
        expect(parseDateString('2024/09/04')).toBe('2024-09-04');
    });

    it('should return null for invalid dates', () => {
        expect(parseDateString('2024-13-04')).toBeNull();
        expect(parseDateString('2024-09-32')).toBeNull();
        expect(parseDateString('not-a-date')).toBeNull();
        expect(parseDateString('')).toBeNull();
    });

    it('should return null for empty input', () => {
        expect(parseDateString('')).toBeNull();
    });
});

describe('extractDateFromFilename', () => {
    it('should extract date from filename like 2024-09-04.md', () => {
        expect(extractDateFromFilename('2024-09-04.md')).toBe('2024-09-04');
    });

    it('should extract date from filename with prefix', () => {
        expect(extractDateFromFilename('Journal 2024-09-04 Morning.md')).toBe('2024-09-04');
    });

    it('should return null for filename without date', () => {
        expect(extractDateFromFilename('My Random Note.md')).toBeNull();
    });

    it('should return null for invalid date in filename', () => {
        expect(extractDateFromFilename('2024-13-45.md')).toBeNull();
    });
});

describe('extractEntryType', () => {
    it('should extract exact type', () => {
        expect(extractEntryType('type: daily_journal')).toBe('daily_journal');
    });

    it('should normalize "Deep Dive" to deep_dive', () => {
        expect(extractEntryType('type: Deep Dive')).toBe('deep_dive');
    });

    it('should normalize "meeting" to meeting_note', () => {
        expect(extractEntryType('type: meeting')).toBe('meeting_note');
    });

    it('should normalize "prompted" to prompted_journal', () => {
        expect(extractEntryType('type: prompted')).toBe('prompted_journal');
    });

    it('should normalize "daily" to daily_journal', () => {
        expect(extractEntryType('type: daily')).toBe('daily_journal');
    });

    it('should map unknown types to "other"', () => {
        expect(extractEntryType('type: brainstorm')).toBe('other');
    });

    it('should handle entry_type key', () => {
        expect(extractEntryType('entry_type: deep_dive')).toBe('deep_dive');
    });

    it('should handle quoted values', () => {
        expect(extractEntryType('type: "deep_dive"')).toBe('deep_dive');
    });

    it('should return null if no type found', () => {
        expect(extractEntryType('title: No Type')).toBeNull();
    });
});
