/**
 * Content hash utility for sync deduplication.
 *
 * Computes SHA-256 of file content to detect true changes.
 * Used by the sync engine to avoid re-uploading unchanged files,
 * even when file metadata (mtime) has changed.
 *
 * Uses Web Crypto API (available in Electron desktop + mobile).
 */

/**
 * Compute SHA-256 hash of a string content.
 * Returns lowercase hex string (64 chars).
 */
export async function computeContentHash(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
