# Changelog

What changed in each release of Pensio Journaling Sync, for the people who use it.

Each section below is the text of that version's GitHub release: the release
workflow publishes the section whose heading names the version, and refuses to
publish a release without one. Releases before 0.5.0 are on
[GitHub](https://github.com/gabrielrubens/pensio-obsidian-sync/releases).

## 0.6.1

- **Renaming or moving a note keeps its entry.** It used to make a second entry in Pensio, which then read the note all over again. Now the entry moves with the note and keeps its reading and its links. A note moved out of your sync folders keeps its entry too: moving a note is not deleting it.
- **Find any of its settings from Obsidian's settings search.** Type "people folder", "mirror delete" or "setup code" in the search box at the top of Settings and it takes you straight there.
- **Journal folders use Obsidian's own folder picker.** Add a folder with the + button and remove one with its delete button.
- **Syncing looks only inside your sync folders.** The plugin no longer lists the rest of your vault to find them.
- **Aliases in a People note reach Pensio.** An `aliases:` list in a person's note becomes their other names in Pensio, so `[[Em]]` in an entry finds Emma. A sync no longer clears aliases you set.
- Needs Obsidian 1.13 or later. On an older Obsidian, the plugin stays on 0.6.0 until Obsidian is updated.

## 0.6.0 — 2026-10-19

- **Connect in one click.** Press **Connect to Pensio** in the plugin's settings, approve the vault in your browser, and Obsidian is connected. When a connection expires or you stop it, the same button connects it again, and your notes and sync history stay as they were. The setup code is still there for a browser that can't hand back to Obsidian.
- **Disconnect stops the connection on Pensio too.** It used to forget the connection only on that computer. Another computer syncing the same vault keeps its own.

## 0.5.2 — 2026-10-18

- **A connection that stopped working can always connect again.** Tokens that no longer work used to leave only *Test connection* on screen. The setup code is offered there too now, and a failed test switches the tab to *Reconnect*.

## 0.5.1 — 2026-10-18

- **Pairing a vault again ends the connection it replaces**, instead of leaving it listed in Connected apps. A second computer syncing the same vault keeps its own connection.

## 0.5.0 — 2026-07-29

- **See where your vault is in the analysis queue.** After a big first sync, the settings say how many entries are still waiting for emotion analysis and about how many days that will take. Free accounts analyze a set number of entries a day, so a large vault no longer looks stuck.
