# Pensio Sync — Obsidian Plugin

Sync your Obsidian vault with [Pensio](https://pensio.app) for AI-powered emotional insights and reflections.

> **Required disclosures** (per [Obsidian developer policies](https://docs.obsidian.md/Developer+policies)):
> - **Account required** — A free [Pensio](https://pensio.app) account is needed.
> - **Network use** — This plugin sends journal content from your configured sync folders to Pensio servers (`pensio.app`) over HTTPS. Data is used for storage, AI-based emotion analysis, and insight generation. No data leaves your device until you explicitly connect and configure folders.
> - **Privacy** — See [Pensio Privacy Policy](https://pensio.app/privacy/).

## What is Pensio?

**[Pensio](https://pensio.app)** is an AI-powered journaling platform. Write naturally — Pensio automatically extracts 60+ emotions, generates weekly & monthly insights, tracks relationships mentioned in your writing, and provides an AI advisor (Explore) that can answer questions about your entire journal history.

This plugin connects your Obsidian vault to Pensio so you can keep writing in your favorite editor while Pensio adds the intelligence layer on top.

## Features

- **Automatic sync** — syncs when files change, or on a 5-minute interval
- **Selective sync** — only configured folders are synced; everything else stays local
- **Multi-folder support** — map multiple vault folders for sync
- **Frontmatter aware** — entry type and date extracted from YAML front matter
- **Secure authentication** — JWT tokens with automatic refresh, stored in Obsidian's encrypted SecretStorage
- **Account safety** — detects account switches and prevents cross-account data leaks
- **Mirror delete** — entries removed from your vault are removed from Pensio (only plugin-created entries)
- **Status bar** — live sync status with tracked file count
- **Mobile compatible** — works on Obsidian mobile (iOS & Android)

## Installation

### BRAT (recommended)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins
2. In BRAT settings, click **Add Beta plugin**
3. Enter: `gabrielrubens/pensio-obsidian-sync`
4. Enable the plugin in Settings → Community plugins

### Community Plugins

*Available soon* — Pensio Sync will be submitted to the Obsidian Community Plugins directory.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/gabrielrubens/pensio-obsidian-sync/releases)
2. Create `.obsidian/plugins/pensio-sync/` in your vault
3. Copy the downloaded files into that folder
4. Reload Obsidian and enable the plugin

## Setup

1. **Create a Pensio account** at [pensio.app/register](https://pensio.app/register/)
2. **Get your tokens** — go to [Settings → API tokens](https://pensio.app/settings/#tokens) and generate an access + refresh token pair
3. **Paste tokens** — open Obsidian Settings → Pensio Sync, paste both tokens, click **Test Connection**
4. **Configure folders** — add your vault folders to sync (default: `Journal`)

Auto-sync is on by default. Entries sync as you write.

## Usage

### Commands

Access via Command Palette (Ctrl/Cmd + P):

| Command | Description |
|---|---|
| **Sync now** | Incremental sync (only changed files) |
| **Force sync all files** | Re-check all files (still skips unchanged content) |
| **Sync current file** | Sync only the active file |
| **Check sync status** | Show server entries and local tracked files |
| **Logout** | Clear tokens and sync state |

### Status bar

- ☁️ Idle — ready to sync (shows tracked file count)
- 🔄 Syncing — in progress
- ✅ Success — sync completed (shows files synced)
- ⚠️ Error — sync failed (check console for details)

### Frontmatter

The plugin reads YAML front matter to determine entry type, date, and title.

**Entry type** — recognized keys: `type`, `entry_type`. Frontmatter type overrides the default folder type.

| Frontmatter value | Maps to |
|---|---|
| `daily_journal`, `daily`, `journal` | Daily Journal |
| `prompted_journal`, `prompted` | Prompted Journal |
| `deep_dive`, `deep dive` | Deep Dive |
| `meeting_note`, `meeting` | Meeting Note |
| `other` | Other |
| *(anything else)* | Other |

**Date** — recognized keys (in priority order): `date`, `created`, `created_at`, `entry_date`. Falls back to file modification time if not present.

**Title** — extracted from the `title` frontmatter key, falling back to the filename.

Example:

```yaml
---
type: deep_dive
date: 2025-03-18
title: My reflection on change
---
```

## How it works

1. **File watching** — the plugin monitors your configured folders for changes
2. **Content hashing** — unchanged files are skipped (SHA-256 deduplication)
3. **Bulk upload** — changed files are sent in batches of 50 to the Pensio API
4. **Backend processing** — Pensio extracts emotions, wikilinks, and generates insights from your entries

Only `.md` files in your configured sync folders are sent. Everything else stays local.

## What you get on Pensio

Once your entries sync, Pensio processes them automatically:

- **60+ emotions extracted** — each entry is analyzed for emotional content
- **Weekly & monthly insights** — AI-generated reflections on patterns in your writing
- **Relationship profiles** — people mentioned via `[[wikilinks]]` are tracked and profiled
- **Explore AI** — ask questions about your entire journal history and get answers grounded in your entries
- **Constellation** — visual map of how your entries connect through themes, emotions, and people

All of this happens on the web — your markdown files in Obsidian stay untouched.

## Security & privacy

| What | Details |
|---|---|
| **Transport** | All communication over HTTPS |
| **Authentication** | JWT access tokens (24h) + refresh tokens (90d) with automatic rotation |
| **Token storage** | Obsidian SecretStorage (OS-level encrypted keychain) |
| **Data sent** | Markdown content, file paths, timestamps from configured folders only |
| **Data NOT sent** | Files outside sync folders, `.obsidian` config, plugin settings, vault structure |
| **Max file size** | 1 MB per file (larger files are skipped) |

## Documentation

For a full overview of the plugin and Pensio's features, see the [Obsidian Sync feature page](https://pensio.app/features/obsidian-sync/).

## Development

```bash
npm install          # Install dependencies
npm run build        # Production build (tsc + esbuild)
npm run dev          # Watch mode
npm test             # Run tests
```

### Architecture

```
src/
├── main.ts              # Plugin entry point, settings, token persistence
├── settings.ts          # Settings UI tab
├── types.ts             # TypeScript types & defaults
├── logger.ts            # Debug logging (gated behind settings.debugMode)
├── api/
│   └── client.ts        # HTTP client (requestUrl, JWT auth, bulk sync)
├── auth/
│   ├── tokenManager.ts  # JWT lifecycle (refresh scheduling, 401 handling)
│   └── accountGuard.ts  # Cross-account safety (prevents data leaks)
└── sync/
    ├── engine.ts        # Sync engine (file watching, batching, state)
    ├── parser.ts        # Frontmatter parser (title, date, type)
    └── hash.ts          # SHA-256 content hashing
```

## Troubleshooting

### "Connection failed"
- Verify the server URL includes `https://`
- Regenerate tokens from your Pensio settings page
- Check network connectivity

### Files not syncing
- Confirm the file is inside a configured sync folder
- Use **Sync now** or **Force sync all files** from the command palette
- Enable **Debug mode** in Advanced settings for detailed console logs

### "File too large"
- Files over 1 MB are skipped — split into smaller files

## Support

- [GitHub Issues](https://github.com/gabrielrubens/pensio-obsidian-sync/issues)
- [Pensio](https://pensio.app)

## License

[MIT](LICENSE)
