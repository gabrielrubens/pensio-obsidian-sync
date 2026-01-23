import { parseMarkdown } from '../parser';

describe('parseMarkdown', () => {
    it('should parse frontmatter', () => {
        const content = `---
date: 2026-01-23
mood: happy
tags: [test, journal]
---

# Test Entry

This is a test.`;

        const result = parseMarkdown(content);

        expect(result.frontmatter.date).toBe('2026-01-23');
        expect(result.frontmatter.mood).toBe('happy');
        expect(result.frontmatter.tags).toEqual(['test', 'journal']);
    });

    it('should extract title from first heading', () => {
        const content = `# My Title

Content here.`;

        const result = parseMarkdown(content);

        expect(result.title).toBe('My Title');
    });

    it('should strip markdown formatting', () => {
        const content = `**Bold** and *italic* text with [link](url) and [[wikilink]].`;

        const result = parseMarkdown(content);

        expect(result.text).toContain('Bold');
        expect(result.text).toContain('italic');
        expect(result.text).not.toContain('**');
        expect(result.text).not.toContain('*');
        expect(result.text).not.toContain('[');
    });

    it('should handle content without frontmatter', () => {
        const content = `# Just Content

No frontmatter here.`;

        const result = parseMarkdown(content);

        expect(result.frontmatter).toEqual({});
        expect(result.title).toBe('Just Content');
    });

    it('should handle empty content', () => {
        const result = parseMarkdown('');

        expect(result.frontmatter).toEqual({});
        expect(result.title).toBe('');
        expect(result.html).toBe('');
        expect(result.text).toBe('');
    });

    it('should parse boolean values in frontmatter', () => {
        const content = `---
published: true
draft: false
---

Content`;

        const result = parseMarkdown(content);

        expect(result.frontmatter.published).toBe(true);
        expect(result.frontmatter.draft).toBe(false);
    });

    it('should parse quoted strings in frontmatter', () => {
        const content = `---
title: "My Title with: colon"
---

Content`;

        const result = parseMarkdown(content);

        expect(result.frontmatter.title).toBe('My Title with: colon');
    });
});
