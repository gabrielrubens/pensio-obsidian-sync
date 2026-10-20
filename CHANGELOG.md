# Changelog

What changed in each release of Pensio Journaling Sync, for the people who use it.

Each section below is the text of that version's GitHub release: the release
workflow publishes the section whose heading names the version, and refuses to
publish a release without one. Releases before 0.5.0 are on
[GitHub](https://github.com/gabrielrubens/pensio-obsidian-sync/releases).

## 0.7.1

- **The card at the top of the settings draws once.** In 0.7.0 every redraw added another line and another icon to it.
- **Far fewer requests to Pensio, so a busy day no longer locks a vault out.** Mirror delete now runs at most once an hour by itself (and at once when you press Sync now), and a sync that hits a problem stops there instead of trying every remaining part.
- **Clearing a folder field no longer deletes that folder's entries.** With Mirror delete on, emptying or retyping a journal folder for a few seconds deleted its entries on Pensio. Mirror delete now waits for a sync that worked with the new folders, skips a folder that has gone missing, and sends a note again if it comes back after its entry was removed.
- **Pasted tokens apply only as a whole pair.** Under Advanced, the token fields used to apply every keystroke. Now they change nothing until both hold a complete token, and they keep your sync history when the tokens are for the same account. Emptying both stops syncing without forgetting what was synced, and the next connect ends the old connection on Pensio.
- **When Pensio is limiting requests, the plugin says so.** It says when to try again if Pensio tells it, and promises a retry only when one will happen. Other errors show what Pensio actually said.
- **"Couldn't check the connection" offers Connect to Pensio** next to Try again. The plugin checks the account again by itself when Pensio next answers, and opening the settings always shows the connection as it is now.
- **A connection in progress is harder to lose.** An approval still completes if Obsidian restarts or you press Connect twice. Opening the browser's link a second time says the vault is already connected. A setup code you are typing survives a redraw.
- **Disconnect and Sync now say what happened**, including when nothing was connected.

## 0.7.0

- **See at a glance whether this vault is syncing.** The top of the plugin's settings is one card now. Green: connected, with your account, how many notes have synced and when. Orange: the session expired or the last sync failed, and why. Outlined: nothing is connected yet. The plugin's version is on it too.
- **Getting back in is one button.** Whenever there is no working connection, the card carries **Connect to Pensio**, with the setup code right under it. A connected vault can renew its connection with **Connect again**, under Account. **Sync now** is on the card once you are connected.
- **A failed sync says what went wrong, and stays until you close it.** Every notice now starts with "Pensio:", so you know which plugin it is from, and says what to do: check your internet connection, press Connect to Pensio, or wait while the plugin tries again. A background sync that fails tells you once, and the status bar says so until a sync works again. Click the status bar to read why.
- **Tokens nobody has checked are checked for you** when you open the settings. You no longer have to find Test connection.
- **Disconnect asks first.**
- **Less to read, in a clearer order:** the card, your journal folders, Sync, your account, then Advanced, which is its own page now. Obsidian's settings search still finds every setting. Documentation and Report an issue are the two icons on the card.

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
