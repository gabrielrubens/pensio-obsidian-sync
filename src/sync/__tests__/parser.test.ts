/**
 * Tests for simplified markdown parser
 * 
 * Philosophy: Plugin is lightweight, just sends raw markdown to backend.
 * Backend handles all parsing, validation, and processing.
 * 
 * Title extraction: Only from frontmatter, NOT from H1 headers.
 * This avoids incorrectly using section headers like "# Context" as titles.
 */

import { parseMarkdown } from '../parser';

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

        // Should NOT use H1 as title - engine.ts falls back to filename
        expect(result.title).toBe('');
        expect(result.content).toBe(content);
    });

    it('should return empty title if no frontmatter', () => {
        const content = 'Just some content without frontmatter';
        const result = parseMarkdown(content);

        expect(result.title).toBe('');
        expect(result.content).toBe(content);
    });

    it('should return empty title if frontmatter has no title field', () => {
        const content = '---\ndate: 2026-01-23\ntags: [journal]\n---\n# Context\n\nBody text';
        const result = parseMarkdown(content);

        // No title in frontmatter, should be empty (fallback to filename)
        expect(result.title).toBe('');
        expect(result.content).toBe(content);
    });

    it('should preserve raw markdown with frontmatter', () => {
        const content = '---\ntitle: Test\ndate: 2026-01-23\n---\n# Content\n\nBody text';
        const result = parseMarkdown(content);

        // Raw content preserved - backend will parse frontmatter
        expect(result.content).toBe(content);
        expect(result.content).toContain('---');
        expect(result.content).toContain('title: Test');
    });

    it('should preserve wikilinks - backend extracts them', () => {
        const content = 'Met with [[John Smith]] and [[Jane Doe]]';
        const result = parseMarkdown(content);

        // Raw content with wikilinks preserved
        expect(result.content).toContain('[[John Smith]]');
        expect(result.content).toContain('[[Jane Doe]]');
    });
});
