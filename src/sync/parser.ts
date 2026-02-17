/**
 * Lightweight markdown parser for Obsidian plugin
 * 
 * Philosophy: Keep plugin simple, let backend handle all processing.
 * This parser extracts basic structure — title and date from frontmatter.
 * All validation, normalization, and heavy processing happens on the backend.
 */

export interface ParsedMarkdown {
    /** Raw markdown content (backend will render to HTML) */
    content: string;
    /** Title extracted from frontmatter or empty string (fallback to filename in engine) */
    title: string;
    /** Entry date extracted from frontmatter (YYYY-MM-DD) or null */
    date: string | null;
    /** Entry type extracted from frontmatter or null */
    entryType: string | null;
}

/**
 * Date keys to look for in frontmatter, in priority order.
 * Checked case-insensitively.
 */
const DATE_KEYS = ['date', 'created', 'created_at', 'entry_date'];

/**
 * Entry type keys to look for in frontmatter.
 */
const TYPE_KEYS = ['type', 'entry_type'];

/**
 * Known Pensio entry types and their aliases.
 * Keys are normalized (lowercase, underscored). Values are the canonical type.
 */
const ENTRY_TYPE_MAP: Record<string, string> = {
    'daily_journal': 'daily_journal',
    'daily': 'daily_journal',
    'journal': 'daily_journal',
    'prompted_journal': 'prompted_journal',
    'prompted': 'prompted_journal',
    'prompt': 'prompted_journal',
    'deep_dive': 'deep_dive',
    'deep dive': 'deep_dive',
    'deepdive': 'deep_dive',
    'meeting_note': 'meeting_note',
    'meeting': 'meeting_note',
    'person_note': 'person_note',
    'relationship_note': 'person_note',
    'other': 'other',
};

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
 * Date priority:
 * 1. Frontmatter date/created/created_at/entry_date field
 * 2. null (engine.ts will try filename regex, then file.stat.ctime)
 * 
 * Note: We don't extract from first H1 because journal files often have
 * section headers like "# Context" which are not the title.
 */
export function parseMarkdown(content: string): ParsedMarkdown {
    let title = '';
    let date: string | null = null;
    let entryType: string | null = null;

    // Check for frontmatter (content between --- markers at start)
    if (content.startsWith('---')) {
        const endIndex = content.indexOf('---', 3);
        if (endIndex > 0) {
            const frontmatter = content.substring(3, endIndex);

            // Extract title
            const titleMatch = frontmatter.match(/^title:\s*(.+)$/mi);
            if (titleMatch) {
                title = titleMatch[1].trim();
                // Remove quotes if present
                if ((title.startsWith('"') && title.endsWith('"')) ||
                    (title.startsWith("'") && title.endsWith("'"))) {
                    title = title.slice(1, -1);
                }
            }

            // Extract date from frontmatter
            date = extractDateFromFrontmatter(frontmatter);

            // Extract entry type from frontmatter
            entryType = extractEntryType(frontmatter);
        }
    }

    return {
        content: content,    // Send raw markdown, backend processes it
        title: title,        // From frontmatter or empty (fallback to filename)
        date: date,          // From frontmatter or null (fallback to filename/ctime)
        entryType: entryType // From frontmatter or null (default to daily_journal)
    };
}

/**
 * Extract date from frontmatter text.
 * 
 * Checks keys in priority order: date, created, created_at, entry_date.
 * Handles:
 * - YYYY-MM-DD (plain dates)
 * - YYYY-MM-DDTHH:mm, YYYY-MM-DDTHH:mm:ss (ISO datetimes)
 * - YYYY/MM/DD (slash-separated)
 * 
 * Returns YYYY-MM-DD string or null.
 */
export function extractDateFromFrontmatter(frontmatter: string): string | null {
    for (const key of DATE_KEYS) {
        // Case-insensitive key match, allowing various casings (Date, Created, etc.)
        const regex = new RegExp(`^${key}:\\s*(.+)$`, 'mi');
        const match = frontmatter.match(regex);
        if (match) {
            const value = match[1].trim();
            // Remove quotes if present
            const unquoted = (value.startsWith('"') || value.startsWith("'"))
                ? value.slice(1, -1)
                : value;
            const parsed = parseDateString(unquoted);
            if (parsed) return parsed;
        }
    }
    return null;
}

/**
 * Parse a date string into YYYY-MM-DD format.
 * 
 * Supports:
 * - 2024-09-04 (plain)
 * - 2024-09-04T22:28 (ISO datetime without seconds)
 * - 2024-09-04T22:28:00 (ISO datetime with seconds)
 * - 2024-09-04T22:28:00+02:00 (ISO with timezone)
 * - 2024/09/04 (slash-separated)
 */
export function parseDateString(value: string): string | null {
    if (!value) return null;

    // ISO datetime: extract YYYY-MM-DD before T or space
    const isoMatch = value.match(/^(\d{4}-\d{2}-\d{2})[T ]/);
    if (isoMatch) {
        if (isValidDate(isoMatch[1])) return isoMatch[1];
    }

    // Plain date: YYYY-MM-DD
    const plainMatch = value.match(/^(\d{4}-\d{2}-\d{2})$/);
    if (plainMatch) {
        if (isValidDate(plainMatch[1])) return plainMatch[1];
    }

    // Slash-separated: YYYY/MM/DD
    const slashMatch = value.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
    if (slashMatch) {
        const dateStr = `${slashMatch[1]}-${slashMatch[2]}-${slashMatch[3]}`;
        if (isValidDate(dateStr)) return dateStr;
    }

    return null;
}

/**
 * Extract entry date from filename.
 * Looks for YYYY-MM-DD pattern anywhere in the filename.
 */
export function extractDateFromFilename(filename: string): string | null {
    const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
    if (match && isValidDate(match[1])) {
        return match[1];
    }
    return null;
}

/**
 * Extract entry type from frontmatter text.
 * Normalizes to a known Pensio type or returns 'other'.
 */
export function extractEntryType(frontmatter: string): string | null {
    for (const key of TYPE_KEYS) {
        const regex = new RegExp(`^${key}:\\s*(.+)$`, 'mi');
        const match = frontmatter.match(regex);
        if (match) {
            const raw = match[1].trim().replace(/["']/g, '');
            const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
            return ENTRY_TYPE_MAP[normalized] || 'other';
        }
    }
    return null;
}

/**
 * Validate a YYYY-MM-DD date string.
 */
function isValidDate(dateStr: string): boolean {
    const parts = dateStr.split('-');
    if (parts.length !== 3) return false;
    const [year, month, day] = parts.map(Number);
    if (year < 1900 || year > 2100) return false;
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;
    // Basic month-day validation
    const d = new Date(year, month - 1, day);
    return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}
