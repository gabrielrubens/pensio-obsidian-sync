# Pensio Sync - Obsidian Plugin

Sync your Obsidian vault with [Pensio](https://pensio.app) for AI-powered emotional insights and reflections.

> **Network disclosure**: This plugin sends vault content (journal entries and people notes from your configured sync folders) to an external Pensio server over HTTPS. A Pensio account is required. No data is sent until you explicitly connect and configure sync folders. See [Security & Privacy](#security--privacy) for details.

## Features

- 🔄 **Automatic sync** — real-time sync when files change (on by default)
- 🔐 **Secure** — JWT authentication with automatic token refresh
- ⚡ **Selective sync** — choose which folders to sync
- 📊 **Status tracking** — see sync status in status bar
- 🧠 **Frontmatter aware** — entry type and date extracted from YAML front matter

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

2. **Get your tokens**
   - Open Settings → Pensio Sync
   - Click **Open token page** to visit your Pensio settings
   - Copy your **Access Token** and **Refresh Token** and paste them in the plugin

3. **Choose sync folders**
   - Set your **Journal folder** (default: `Journal`) and **People folder** (default: `People`)
   - Each `.md` file in the journal folder becomes an entry; each in the people folder becomes a relationship

Auto-sync is on by default. The server URL defaults to `https://www.pensio.app` — self-hosted users can change it under Advanced settings.

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

## Security & Privacy

This plugin communicates with an external server (Pensio). Here is exactly what is transmitted and why:

| Data sent | Purpose | When |
|---|---|---|
| Access & refresh tokens | Authentication (pasted from Pensio settings page) | On connect |
| Journal entry content | Sync entries for AI analysis | On sync |
| People note content | Sync relationship notes | On sync |
| File paths & timestamps | Detect changes, resolve conflicts | On sync |

**What is NOT sent**: Files outside your configured sync folders, `.obsidian` config, plugin settings.

- All communication uses HTTPS
- JWT tokens with automatic rotation (access: 24h, refresh: 90d)
- Tokens stored via Electron safeStorage when available, localStorage fallback
- No credentials stored in vault files
- Max file size: 1MB

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
- Files over 1MB are skipped
- Split large files into smaller ones

### Files not syncing
- Check file is in the configured Journal or People folder
- Auto-sync is on by default — use "Sync now" command for manual sync
- Enable **Debug mode** in Advanced settings for detailed logs

## Support

- [Issues](https://github.com/gabrielrubens/pensio-obsidian-sync/issues)
- [Pensio Documentation](https://github.com/gabrielrubens/pensio)

## License

[MIT](LICENSE)
