/**
 * Lightweight markdown parser for Obsidian plugin
 * 
 * Philosophy: Keep plugin simple, let backend handle all processing.
 * This parser ONLY extracts basic structure - all validation, normalization,
 * and processing happens on the backend.
 */

export interface ParsedMarkdown {
    /** Raw markdown content (backend will render to HTML) */
    content: string;
    /** Title extracted from first H1 or empty string */
    title: string;
}

/**
 * Parse markdown with minimal processing
 * 
 * The plugin's job is just to send raw markdown to the backend.
 * Backend handles:
 * - Frontmatter parsing (emoji stripping, key normalization, YAML multiline lists)
 * - Wikilink extraction
 * - Markdown rendering
 * - Validation
 */
export function parseMarkdown(content: string): ParsedMarkdown {
    // Extract title from first H1 (optional, backend can handle this too)
    let title = '';
    const titleMatch = content.match(/^#\s+(.+)$/m);
    if (titleMatch) {
        title = titleMatch[1].trim();
    }

    return {
        content: content,  // Send raw markdown, backend processes it
        title: title
    };
}
