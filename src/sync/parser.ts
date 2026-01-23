/**
 * Parse markdown content into structured data
 */

export interface ParsedMarkdown {
    frontmatter: Record<string, any>;
    title: string;
    html: string;
    text: string;
}

/**
 * Parse markdown with frontmatter
 */
export function parseMarkdown(content: string): ParsedMarkdown {
    const result: ParsedMarkdown = {
        frontmatter: {},
        title: '',
        html: '',
        text: ''
    };

    // Parse frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (frontmatterMatch) {
        result.frontmatter = parseFrontmatter(frontmatterMatch[1]);
        content = content.substring(frontmatterMatch[0].length);
    }

    // Extract title (first heading or filename)
    const titleMatch = content.match(/^#\s+(.+)$/m);
    if (titleMatch) {
        result.title = titleMatch[1].trim();
    }

    // For now, store content as-is
    // Server will handle markdown-to-HTML conversion
    result.html = content;
    result.text = stripMarkdown(content);

    return result;
}

/**
 * Parse YAML frontmatter
 */
function parseFrontmatter(yaml: string): Record<string, any> {
    const result: Record<string, any> = {};

    yaml.split('\n').forEach(line => {
        const match = line.match(/^(\w+):\s*(.*)$/);
        if (match) {
            const key = match[1];
            let value: any = match[2].trim();

            // Remove quotes
            if (value.startsWith('"') && value.endsWith('"')) {
                value = value.substring(1, value.length - 1);
            }

            // Parse arrays
            if (value.startsWith('[') && value.endsWith(']')) {
                value = value
                    .substring(1, value.length - 1)
                    .split(',')
                    .map(v => v.trim().replace(/^"(.*)"$/, '$1'));
            }

            // Parse booleans
            if (value === 'true') value = true;
            if (value === 'false') value = false;

            result[key] = value;
        }
    });

    return result;
}

/**
 * Strip markdown formatting to get plain text
 */
function stripMarkdown(markdown: string): string {
    let text = markdown;

    // Remove headings
    text = text.replace(/^#{1,6}\s+/gm, '');

    // Remove bold/italic
    text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
    text = text.replace(/(\*|_)(.*?)\1/g, '$2');

    // Remove links but keep text
    text = text.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');

    // Remove wikilinks but keep text
    text = text.replace(/\[\[([^\]]+)\]\]/g, '$1');

    // Remove images
    text = text.replace(/!\[([^\]]*)\]\([^\)]+\)/g, '');

    // Remove code blocks
    text = text.replace(/```[\s\S]*?```/g, '');
    text = text.replace(/`([^`]+)`/g, '$1');

    // Remove HTML tags
    text = text.replace(/<[^>]+>/g, '');

    return text.trim();
}
