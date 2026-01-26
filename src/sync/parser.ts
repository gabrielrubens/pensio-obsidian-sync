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
    /** Title extracted from frontmatter or empty string (fallback to filename in engine) */
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
 * 
 * Title priority:
 * 1. Frontmatter 'title' field (if exists)
 * 2. Empty string (engine.ts will fall back to file.basename)
 * 
 * Note: We don't extract from first H1 because journal files often have
 * section headers like "# Context" which are not the title.
 */
export function parseMarkdown(content: string): ParsedMarkdown {
    // Try to extract title from frontmatter only
    let title = '';
    
    // Check for frontmatter (content between --- markers at start)
    if (content.startsWith('---')) {
        const endIndex = content.indexOf('---', 3);
        if (endIndex > 0) {
            const frontmatter = content.substring(3, endIndex);
            // Look for title: in frontmatter
            const titleMatch = frontmatter.match(/^title:\s*(.+)$/m);
            if (titleMatch) {
                title = titleMatch[1].trim();
                // Remove quotes if present
                if ((title.startsWith('"') && title.endsWith('"')) ||
                    (title.startsWith("'") && title.endsWith("'"))) {
                    title = title.slice(1, -1);
                }
            }
        }
    }

    return {
        content: content,  // Send raw markdown, backend processes it
        title: title       // From frontmatter or empty (fallback to filename)
    };
}
