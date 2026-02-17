/**
 * Debug logger — only logs when debugMode is enabled in settings.
 * console.error always logs regardless of debug mode.
 */

let _debugMode = false;

export function setDebugMode(enabled: boolean): void {
    _debugMode = enabled;
}

export function debugLog(...args: unknown[]): void {
    if (_debugMode) {
        console.log('[Pensio]', ...args);
    }
}
