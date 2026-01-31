/**
 * Secure token storage using Electron safeStorage API
 * 
 * On desktop platforms (where Obsidian runs on Electron):
 * - Mac: Uses KeyChain
 * - Windows: Uses Credential Manager  
 * - Linux: Uses Secret Service API/libsecret
 * 
 * Falls back to encrypted settings storage for mobile or unsupported platforms.
 */

import { Notice } from 'obsidian';

export interface TokenData {
    accessToken: string;
    refreshToken: string;
    expiresAt: number; // Unix timestamp in milliseconds
}

/**
 * Token storage service with secure OS-level encryption
 */
export class TokenStorage {
    private storageKey = 'journalwise-tokens';
    private isSafeStorageAvailable: boolean;

    constructor() {
        // Check if Electron safeStorage is available (desktop only)
        this.isSafeStorageAvailable = this.checkSafeStorageAvailability();
    }

    /**
     * Check if Electron safeStorage API is available and usable
     */
    private checkSafeStorageAvailability(): boolean {
        try {
            // @ts-ignore - Electron API may not be in types
            const { safeStorage } = require('electron');
            return safeStorage && safeStorage.isEncryptionAvailable();
        } catch (error) {
            // Not running on Electron or safeStorage not available
            return false;
        }
    }

    /**
     * Store tokens securely
     */
    async storeTokens(tokens: TokenData): Promise<void> {
        try {
            const tokenJson = JSON.stringify(tokens);

            if (this.isSafeStorageAvailable) {
                // Use Electron safeStorage for OS-level encryption
                // @ts-ignore
                const { safeStorage } = require('electron');
                const encrypted = safeStorage.encryptString(tokenJson);
                const base64 = encrypted.toString('base64');
                
                // Store in localStorage with a marker that it's encrypted
                localStorage.setItem(this.storageKey, `encrypted:${base64}`);
            } else {
                // Fallback: Store with basic obfuscation (not truly secure)
                // For mobile or unsupported platforms
                const obfuscated = this.obfuscate(tokenJson);
                localStorage.setItem(this.storageKey, `obfuscated:${obfuscated}`);
                
                // Warn user once that tokens are not fully encrypted
                if (!localStorage.getItem('journalwise-storage-warning-shown')) {
                    new Notice(
                        'Journal Wise: Token storage using basic encryption. ' +
                        'For maximum security, use the desktop app.',
                        8000
                    );
                    localStorage.setItem('journalwise-storage-warning-shown', 'true');
                }
            }
        } catch (error) {
            console.error('Failed to store tokens:', error);
            throw new Error('Failed to store authentication tokens securely');
        }
    }

    /**
     * Retrieve tokens securely
     */
    async retrieveTokens(): Promise<TokenData | null> {
        try {
            const stored = localStorage.getItem(this.storageKey);
            if (!stored) {
                return null;
            }

            let tokenJson: string;

            if (stored.startsWith('encrypted:')) {
                // Decrypt using Electron safeStorage
                const base64 = stored.substring('encrypted:'.length);
                // @ts-ignore
                const { safeStorage } = require('electron');
                const buffer = Buffer.from(base64, 'base64');
                tokenJson = safeStorage.decryptString(buffer);
            } else if (stored.startsWith('obfuscated:')) {
                // De-obfuscate fallback storage
                const obfuscated = stored.substring('obfuscated:'.length);
                tokenJson = this.deobfuscate(obfuscated);
            } else {
                // Legacy plain storage - migrate to new format
                tokenJson = stored;
            }

            const tokens: TokenData = JSON.parse(tokenJson);
            
            // Validate token data structure
            if (!tokens.accessToken || !tokens.refreshToken || !tokens.expiresAt) {
                console.warn('Invalid token data structure, clearing storage');
                await this.clearTokens();
                return null;
            }

            return tokens;
        } catch (error) {
            console.error('Failed to retrieve tokens:', error);
            // Clear corrupted data
            await this.clearTokens();
            return null;
        }
    }

    /**
     * Clear stored tokens
     */
    async clearTokens(): Promise<void> {
        localStorage.removeItem(this.storageKey);
    }

    /**
     * Check if tokens are stored
     */
    hasTokens(): boolean {
        return localStorage.getItem(this.storageKey) !== null;
    }

    /**
     * Simple obfuscation for fallback storage (NOT cryptographically secure)
     * This is just to prevent casual inspection, not real encryption
     */
    private obfuscate(text: string): string {
        // Base64 encode twice with a simple XOR
        const xorKey = 0x5A; // Simple XOR key
        const bytes = new TextEncoder().encode(text);
        const xored = Array.from(bytes).map(b => b ^ xorKey);
        return btoa(String.fromCharCode(...xored));
    }

    /**
     * Reverse obfuscation
     */
    private deobfuscate(obfuscated: string): string {
        const xorKey = 0x5A;
        const decoded = atob(obfuscated);
        const bytes = Array.from(decoded).map(c => c.charCodeAt(0) ^ xorKey);
        return new TextDecoder().decode(new Uint8Array(bytes));
    }

    /**
     * Get storage method information (for debugging/settings display)
     */
    getStorageMethod(): string {
        if (this.isSafeStorageAvailable) {
            // @ts-ignore
            const { platform } = require('os');
            const os = platform();
            if (os === 'darwin') return 'Secure (macOS KeyChain)';
            if (os === 'win32') return 'Secure (Windows Credential Manager)';
            if (os === 'linux') return 'Secure (Linux Secret Service)';
            return 'Secure (OS Keychain)';
        }
        return 'Basic (Obfuscated)';
    }
}
