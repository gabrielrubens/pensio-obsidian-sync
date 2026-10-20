# Pensio Journaling Sync

Sync your journal to [Pensio](https://pensio.app) for AI-powered journaling insights: emotion and mood tracking, relationship mapping, and weekly reflections on your notes.

> **Available in the [Obsidian Community Plugins directory](https://community.obsidian.md/plugins/pensio-sync).** Install it in a couple of clicks (see [Installation](#installation)). Questions or a bug? [Open an issue](https://github.com/gabrielrubens/pensio-obsidian-sync/issues).

> **Required disclosures** (per [Obsidian developer policies](https://docs.obsidian.md/Developer+policies)):
> - **Account required** — A free [Pensio](https://pensio.app) account is needed.
> - **Network use** — This plugin sends journal content from your configured sync folders to Pensio servers (`pensio.app`) over HTTPS. Data is used for storage, AI-based emotion analysis, and insight generation. No data leaves your device until you explicitly connect and configure folders.
> - **Privacy** — See [Pensio Privacy Policy](https://pensio.app/privacy/).

## What is Pensio?

**[Pensio](https://pensio.app)** is an AI-powered journaling platform. Write naturally — Pensio automatically extracts 60+ emotions, generates weekly & monthly insights, tracks relationships mentioned in your writing, and provides an AI advisor (Explore) that can answer questions about your entire journal history.

This plugin connects your Obsidian vault to Pensio so you can keep writing in your favorite editor while Pensio adds the intelligence layer on top.

![Pensio Journaling Sync settings in Obsidian — Connect to Pensio with the setup code beneath it, then the journal folders to sync](https://raw.githubusercontent.com/gabrielrubens/pensio-obsidian-sync/main/docs/screenshot.png)

## Features

- **Automatic sync** — syncs when files change, or on a 5-minute interval
- **Selective sync** — only configured folders are synced; everything else stays local
- **Multi-folder support** — map multiple vault folders for sync
- **Frontmatter aware** — entry type and date extracted from YAML front matter
- **Connect from Obsidian** — press **Connect to Pensio**, and Pensio opens in your browser to approve the vault or hand you a one-time setup code; no passwords or long tokens to copy
- **Secure authentication** — per-device tokens with automatic refresh, stored via Obsidian's SecretStorage
- **Account safety** — detects account switches and prevents cross-account data leaks
- **People folder sync** — dedicated folder for relationship notes, synced as Pensio relationship profiles, aliases included
- **Renames follow your notes** — rename or move a note and its Pensio entry moves with it, keeping its emotion reading and links. Moving a note out of your synced folders keeps its entry
- **Deletes follow your vault** — deleting a note in Obsidian deletes the entry the plugin made from it (only plugin-created entries, never web ones)
- **Mirror delete** (opt-in) — also removes entries whose notes left your synced folders while Obsidian was closed or outside it
- **Status bar** — live sync status with tracked file count
- **Mobile compatible** — works on Obsidian mobile (iOS & Android)

## Installation

### From Community Plugins (recommended)

1. In Obsidian, open **Settings → Community plugins** and click **Browse**
2. Search for **Pensio Journaling Sync**
3. Click **Install**, then **Enable**

Or open the [directory listing](https://community.obsidian.md/plugins/pensio-sync) and use "Install".

### Beta / pre-release builds (BRAT)

Want the newest build before it reaches the directory? Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), choose **Add beta plugin**, and enter `gabrielrubens/pensio-obsidian-sync`.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/gabrielrubens/pensio-obsidian-sync/releases)
2. Create `.obsidian/plugins/pensio-sync/` in your vault
3. Copy the downloaded files into that folder
4. Reload Obsidian and enable the plugin

## Setup

1. **Create a Pensio account** at [pensio.app/register](https://pensio.app/register/)
2. **Connect** — open Obsidian Settings → Pensio Journaling Sync and press **Connect to Pensio**. Your browser opens Pensio: approve the vault there, or, if Pensio gives you a one-time setup code instead, enter it under **Setup code** and press **Use code**
3. **Browser doesn't come back to Obsidian?** Open [Connect Obsidian](https://pensio.app/tokens/pair-obsidian/) yourself, generate a setup code, enter it under **Setup code** and press **Use code**
4. **Configure folders** — under **Journal folders**, press **+** to add each vault folder to sync (default: `Journal`); each row has its own delete button

Auto-sync is on by default. Entries sync as you write.

Self-hosting or prefer raw tokens? Manual access/refresh token entry lives under **Advanced**.

## Usage

### Commands

Access via Command Palette (Ctrl/Cmd + P):

| Command | Description |
|---|---|
| **Sync now** | Incremental sync (only changed files) |
| **Force sync all files** | Re-check all files (still skips unchanged content) |
| **Sync current file** | Sync only the active file |
| **Check sync status** | Show server entries and local tracked files |
| **Disconnect from Pensio** | Stop this vault's connection on Pensio, then clear tokens and sync state here |

### Status bar

- **Cloud** idle — ready to sync (shows tracked file count)
- **Spinner** syncing — in progress
- **Check** success — sync completed (shows files synced)
- **Warning** *Pensio sync failed* — stays until a sync works; click it to read why and what to do
- **Cloud off** *Pensio offline* — Pensio could not be reached; the plugin tries again every 5 minutes
- **Cloud off** reconnect — the connection stopped or expired; press **Connect to Pensio** in settings (your notes and sync history are untouched)

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

**Frontmatter is metadata, not writing.** Pensio keeps it alongside the entry; word counts and Pensio's AI read only what you wrote under it.

**An empty note is not an entry.** A note with nothing written under its frontmatter (a new blank note, a template that is only properties) stays in your vault and becomes an entry the first time it has words.

## How it works

1. **File watching** — the plugin monitors your configured folders for changes
2. **Content hashing** — unchanged files are skipped (SHA-256 deduplication)
3. **Bulk upload** — changed files are sent in batches of 50 to the Pensio API
4. **Backend processing** — Pensio extracts emotions, wikilinks, and generates insights from your entries

Only `.md` files in your configured sync folders are sent. Everything else stays local.

## People folder

Besides journal entries, the plugin can sync **relationship notes** from a dedicated People folder (default: `People/`).

Create a markdown file per person:

```
People/
├── Sarah.md
├── David.md
└── Mom.md
```

Each file becomes a [relationship profile](https://pensio.app/features/relationships/) on Pensio. The person's name is taken from the `title` frontmatter key, or the filename if not set. You can add any notes about the person in the file body.

#### Person frontmatter

Add a `relationship` field to categorize the person:

```yaml
---
title: Sarah
relationship: close_friend
birthday: 1990-05-15
aliases:
  - Sar
tags:
  - college
  - roommate
---
Notes about Sarah...
```

`aliases` are other names for the person: with the note above, `[[Sar]]` in a journal entry's text links to Sarah.

**Accepted `relationship` values**: `partner`, `family`, `close_friend`, `friend`, `coworker`, `professional`, `acquaintance`, `other`. Legacy formats (e.g., `1:👪 Family`, `Friend`) are normalized automatically on sync.

When you mention someone in a journal entry using an Obsidian wiki-link — the person's note name (or one of their `aliases`) wrapped in double square brackets — Pensio links that mention to their relationship profile. A wiki-link in the text only links someone who already exists. To create a person from an entry, list them under `People:` in the entry's frontmatter:

```yaml
---
People:
  - "[[Sarah]]"
---
```

#### Aliases

How a note's `aliases:` behaves on sync:

- One alias can sit on a single line: `aliases: Em`.
- To clear a person's aliases from the vault, write `aliases: []`. Leaving the key out changes nothing, so aliases you added on the web stay.
- Each alias follows the same rule as a name (one line, a human length). One that breaks it is dropped and the rest still sync; two that differ only in capitals count once.
- A person you added on the web keeps what you gave them there: a note fills in only what they don't have yet, so it gives aliases to someone with none and never replaces theirs.

Set the People folder in Settings → Pensio Journaling Sync, just below the journal folders, beside **Auto-sync**. Leave it empty to turn people sync off.

## What you get on Pensio

Once your entries sync, Pensio processes them automatically:

- [**60+ emotions extracted**](https://pensio.app/features/emotion-tracking/) — each entry is analyzed for emotional content
- [**Weekly & monthly insights**](https://pensio.app/features/insights/) — AI-generated reflections on patterns in your writing
- [**Relationship profiles**](https://pensio.app/features/relationships/) — people mentioned via wiki-links are tracked and profiled
- [**Explore AI**](https://pensio.app/features/explore/) — ask questions about your entire journal history and get answers grounded in your entries
- [**Constellation**](https://pensio.app/features/constellation/) — visual map of how your entries connect through themes, emotions, and people

All of this happens on the web — your markdown files in Obsidian stay untouched.

## Security & privacy

| What | Details |
|---|---|
| **Transport** | All communication over HTTPS |
| **Authentication** | **Connect to Pensio** (approved in your browser, PKCE) or a one-time setup code → per-device JWT family; short-lived access tokens, refresh tokens renewed automatically (sliding reissue) |
| **Token storage** | Obsidian SecretStorage, write-verified — backed by the OS keychain on desktop; app-local (never inside your vault files, never synced with the vault) on mobile |
| **Data sent** | Markdown content, file paths, timestamps from configured folders only |
| **Data NOT sent** | Files outside sync folders, `.obsidian` config, plugin settings, vault structure |
| **Max file size** | 1 MB per file (larger files are skipped) |

## Documentation

For a full overview of the plugin and Pensio's features, see the [Obsidian Sync feature page](https://pensio.app/features/obsidian-sync/).

## Troubleshooting

### "Connection failed"
- Press **Connect to Pensio** again, or generate a fresh setup code on the [Connect Obsidian](https://pensio.app/tokens/pair-obsidian/) page, enter it under **Setup code** and press **Use code**
- Self-hosting? Check the server URL under **Advanced** includes `https://`
- Check network connectivity

### "Session expired"
- The plugin never deletes anything on failures — press **Connect to Pensio** in Settings → Pensio Journaling Sync to reconnect, and syncing resumes where it left off
- A connection also ends a year after it was made, or when it is stopped in Pensio → Settings → Connected apps; reconnect the same way

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
