import { computeContentHash } from '../hash';

// Web Crypto API polyfill for Node (Jest doesn't have crypto.subtle)
import { webcrypto } from 'crypto';
if (!globalThis.crypto) {
    (globalThis as any).crypto = webcrypto;
}

describe('computeContentHash', () => {
    it('should return a 64-char hex string (SHA-256)', async () => {
        const hash = await computeContentHash('Hello, World!');
        expect(hash).toHaveLength(64);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce deterministic output for same input', async () => {
        const content = '# Journal Entry\n\nToday was great.';
        const hash1 = await computeContentHash(content);
        const hash2 = await computeContentHash(content);
        expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different content', async () => {
        const hash1 = await computeContentHash('Content A');
        const hash2 = await computeContentHash('Content B');
        expect(hash1).not.toBe(hash2);
    });

    it('should handle empty string', async () => {
        const hash = await computeContentHash('');
        expect(hash).toHaveLength(64);
        // Known SHA-256 of empty string
        expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('should handle unicode content', async () => {
        const hash = await computeContentHash('日本語テスト 🎉');
        expect(hash).toHaveLength(64);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should handle frontmatter content', async () => {
        const content = `---
date: 2026-02-18
tags: [journal]
---

# My Entry

Some content here.`;
        const hash = await computeContentHash(content);
        expect(hash).toHaveLength(64);
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should detect whitespace differences', async () => {
        const hash1 = await computeContentHash('Hello World');
        const hash2 = await computeContentHash('Hello  World');
        const hash3 = await computeContentHash('Hello World\n');
        expect(hash1).not.toBe(hash2);
        expect(hash1).not.toBe(hash3);
    });

    it('should match Python hashlib.sha256 output', async () => {
        // This ensures plugin and backend hashes are compatible
        // Python: hashlib.sha256("test content".encode("utf-8")).hexdigest()
        const hash = await computeContentHash('test content');
        expect(hash).toBe('6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72');
    });
});
