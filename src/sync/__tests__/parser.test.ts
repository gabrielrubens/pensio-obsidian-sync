/**
 * Tests for simplified markdown parser
 * 
 * Philosophy: Plugin is lightweight, just sends raw markdown to backend.
 * Backend handles all parsing, validation, and processing.
 */

import { parseMarkdown } from '../parser';

describe('parseMarkdown', () => {
    it('should extract title from H1', () => {
        const content = '# My Title\n\nContent here';
        const result = parseMarkdown(content);

        expect(result.title).toBe('My Title');
        expect(result.content).toBe(content);
    });

    it('should return empty title if no H1', () => {
        const content = 'Just some content without heading';
        const result = parseMarkdown(content);

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
