// The plugin runs in Obsidian's browser-like (Electron) runtime, so the source
// uses window.setTimeout/setInterval (required for popout-window compatibility).
// The Jest 'node' test environment has no `window`; alias it to the global so
// those timer calls resolve during unit tests.
if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
}
