# Journal Wise Sync - Obsidian Plugin

Sync your Obsidian vault with [Journal Wise](https://github.com/gabrielrubens/journal-wise) for AI-powered emotional insights and reflections.

## Features

- 🔄 **Automatic Sync**: Real-time sync when files change
- 🔐 **Secure**: JWT authentication with device tracking
- ⚡ **Selective Sync**: Choose which folders to sync
- 🚫 **Smart Filtering**: Exclude patterns (e.g., `.obsidian`, `.trash`)
- 📊 **Status Tracking**: See sync status in status bar
- 🔀 **Conflict Resolution**: Choose how to handle conflicts

## Installation

### From Obsidian Community Plugins (Coming Soon)
1. Open Settings → Community Plugins
2. Search for "Journal Wise Sync"
3. Click Install

### Manual Installation
1. Download latest release from [GitHub Releases](https://github.com/gabrielrubens/journal-wise/releases)
2. Extract to `.obsidian/plugins/journal-wise-sync/`
3. Reload Obsidian
4. Enable plugin in Settings → Community Plugins

## Setup

1. **Install Journal Wise Backend**
   - Follow [backend setup instructions](../README.md)
   - Get your server URL (e.g., `https://journal.example.com`)

2. **Configure Plugin**
   - Open Settings → Journal Wise Sync
   - Enter API URL
   - Enter API token (generate in web UI)
   - Set device name (optional)

3. **Choose Sync Folders**
   - Set folders to sync (e.g., `Journal, People`)
   - Set exclude patterns if needed

4. **Enable Auto-Sync** (optional)
   - Toggle "Auto-sync" on
   - Files will sync automatically when changed

## Usage

### Commands

Access via Command Palette (Ctrl/Cmd + P):

- **Sync now**: Manually sync all files
- **Sync current file**: Sync only active file
- **Check sync status**: View sync statistics
- **Logout**: Clear API token

### Status Bar

The plugin shows sync status in the bottom status bar:

- ☁️ Idle (ready to sync)
- 🔄 Syncing (in progress)
- ✅ Success (sync completed)
- ⚠️ Error (sync failed)

### Conflict Resolution

Choose how to handle conflicts in settings:

- **Server wins**: Always use server version (default)
- **Local wins**: Always use local version
- **Ask me**: Show dialog to choose (coming soon)

## Development

### Prerequisites

- Node.js 18+
- npm or yarn

### Setup

```bash
cd obsidian-plugin
npm install
```

### Build

```bash
# Development (watch mode)
npm run dev

# Production
npm run build
```

### Test in Obsidian

1. Build the plugin
2. Copy `main.js`, `manifest.json`, `styles.css` to test vault's `.obsidian/plugins/journal-wise-sync/`
3. Reload Obsidian

### Lint

```bash
npm run lint
npm run lint:fix
```

## Architecture

```
obsidian-plugin/
├── src/
│   ├── main.ts              # Plugin entry point
│   ├── settings.ts          # Settings UI
│   ├── types.ts             # TypeScript types
│   ├── api/
│   │   └── client.ts        # API client
│   └── sync/
│       ├── engine.ts        # Sync engine
│       └── parser.ts        # Markdown parser
├── manifest.json            # Plugin metadata
├── package.json             # Dependencies
└── tsconfig.json            # TypeScript config
```

## Security

- ✅ JWT authentication with token rotation
- ✅ HTTPS required for production
- ✅ Device-specific tokens (revoke per-device)
- ✅ No credentials stored in vault
- ✅ Configurable file size limits

## Troubleshooting

### "Connection failed"
- Check API URL is correct (include `https://`)
- Verify token is valid (regenerate in web UI)
- Check network connection

### "File too large"
- Increase max entry size in settings
- Check file is under server limit (5MB default)

### Files not syncing
- Check file is in configured sync folder
- Verify file doesn't match exclude patterns
- Enable auto-sync in settings

## Support

- [Issues](https://github.com/gabrielrubens/journal-wise/issues)
- [Discussions](https://github.com/gabrielrubens/journal-wise/discussions)
- [Documentation](https://github.com/gabrielrubens/journal-wise)

## License

MIT License - see [LICENSE](../LICENSE)
