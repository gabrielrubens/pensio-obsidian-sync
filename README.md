# Pensio Sync - Obsidian Plugin

Sync your Obsidian vault with [Pensio](https://pensio.app) for AI-powered emotional insights and reflections.

> **Network disclosure**: This plugin sends vault content (journal entries and people notes from your configured sync folders) to an external Pensio server over HTTPS. A Pensio account is required. No data is sent until you explicitly connect and configure sync folders. See [Security & Privacy](#security--privacy) for details.

## Features

- 🔄 **Automatic sync** — real-time sync when files change
- 🔐 **Secure** — JWT authentication with device tracking
- ⚡ **Selective sync** — choose which folders to sync
- 🚫 **Smart filtering** — exclude patterns (e.g., `.obsidian`, `.trash`)
- 📊 **Status tracking** — see sync status in status bar
- 🔀 **Conflict resolution** — choose how to handle conflicts

## Installation

### BRAT (recommended for beta)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins
2. In BRAT settings, click **Add Beta plugin**
3. Enter: `gabrielrubens/pensio-obsidian-sync`
4. Enable the plugin in Settings → Community Plugins

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/gabrielrubens/pensio-obsidian-sync/releases)
2. Create `.obsidian/plugins/pensio-sync/` in your vault
3. Copy the downloaded files into that folder
4. Reload Obsidian
5. Enable the plugin in Settings → Community Plugins

## Setup

1. **Get a Pensio account**
   - Sign up at [pensio.app](https://pensio.app) or self-host the [Pensio backend](https://github.com/gabrielrubens/pensio)

2. **Configure plugin**
   - Open Settings → Pensio Sync
   - Enter your server URL (e.g., `https://pensio.app`)
   - Click **Connect** and log in with your credentials
   - Set device name (optional)

3. **Choose sync folders**
   - Set folders to sync (e.g., `Journal, People`)
   - Set exclude patterns if needed

4. **Enable auto-sync** (optional)
   - Toggle "Auto-sync" on
   - Files will sync automatically when changed

## Usage

### Commands

Access via Command Palette (Ctrl/Cmd + P):

- **Sync now** — manually sync all files
- **Sync current file** — sync only active file
- **Check sync status** — view sync statistics
- **Logout** — clear credentials and disconnect

### Status bar

The plugin shows sync status in the bottom status bar:

- ☁️ Idle (ready to sync)
- 🔄 Syncing (in progress)
- ✅ Success (sync completed)
- ⚠️ Error (sync failed)

### Conflict resolution

Choose how to handle conflicts in settings:

- **Server wins** — always use server version (default)
- **Local wins** — always use local version

## Security & Privacy

This plugin communicates with an external server (Pensio). Here is exactly what is transmitted and why:

| Data sent | Purpose | When |
|---|---|---|
| Username & password | Authentication (exchanged for JWT tokens) | On connect |
| Journal entry content | Sync entries for AI analysis | On sync |
| People note content | Sync relationship notes | On sync |
| File paths & timestamps | Detect changes, resolve conflicts | On sync |
| Device name | Identify this device in multi-device setups | On connect |

**What is NOT sent**: Files outside your configured sync folders, `.obsidian` config, excluded patterns, plugin settings.

- All communication uses HTTPS
- JWT tokens with automatic rotation (access: 24h, refresh: 90d)
- Device-specific tokens (revoke per-device from the web UI)
- Tokens stored via Electron safeStorage when available, localStorage fallback
- No credentials stored in vault files
- Configurable file size limits (default: 1MB)

## Development

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
npm install
```

### Build

```bash
# Development (watch mode)
npm run dev

# Production
npm run build
```

### Test

```bash
npm test
npm run test:watch
npm run test:coverage
```

### Test in Obsidian

1. Build the plugin
2. Copy `main.js`, `manifest.json`, `styles.css` to your test vault's `.obsidian/plugins/pensio-sync/`
3. Reload Obsidian

## Architecture

```
src/
├── main.ts              # Plugin entry point
├── settings.ts          # Settings UI
├── types.ts             # TypeScript types & defaults
├── logger.ts            # Debug logging utility
├── api/
│   └── client.ts        # API client (HTTP requests)
├── auth/
│   ├── tokenManager.ts  # JWT token lifecycle
│   └── tokenStorage.ts  # Secure token persistence
└── sync/
    ├── engine.ts        # Sync engine (diff, upload)
    └── parser.ts        # Markdown/frontmatter parser
```

## Troubleshooting

### "Connection failed"
- Check server URL is correct (include `https://`)
- Verify credentials are valid
- Check network connection

### "File too large"
- Increase max entry size in settings
- Check file is under server limit (default 1MB)

### Files not syncing
- Check file is in a configured sync folder
- Verify file doesn't match exclude patterns
- Enable auto-sync in settings
- Enable **Debug mode** in Advanced settings for detailed logs

## Support

- [Issues](https://github.com/gabrielrubens/pensio-obsidian-sync/issues)
- [Pensio Documentation](https://github.com/gabrielrubens/pensio)

## License

[MIT](LICENSE)
