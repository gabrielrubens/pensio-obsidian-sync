# Authentication & Token Lifecycle

How Pensio Journaling Sync authenticates, refreshes, and stores credentials — and the
design rules that keep a pairing alive across weeks of Obsidian being closed.

## Connecting

There are two ways in, and both end in the same place: a fresh **per-device
token family** — a short-lived access token (30 min) and a long-lived refresh
token — minted for a locally generated `device_id` and a device name.

**Connect to Pensio** (plugin 0.6.0) is the button the settings tab leads with:

1. The plugin makes a PKCE verifier and a random `state`, keeps both in memory,
   and opens `/connect/obsidian/` in the browser with the verifier's challenge.
2. On Pensio she approves the vault. Pensio sends a single-use code back to
   `obsidian://pensio-connect`, never a token.
3. The plugin checks `state` and exchanges the code and the verifier at
   `POST /api/v1/auth/connect/`.

⚠️ While one-click connect is still rolling out on Pensio, the same button can
land on the setup-code page instead of the approval. Then the second way below
finishes the job, and nothing about the plugin changes.

**The setup code** (TV-style pairing) sits beneath it, under **Setup code**:

1. The Pensio web app (Settings → Connected apps → **Connect Obsidian**) mints
   an 8-character code. It expires in 5 minutes and can be used once.
2. She enters it under **Setup code** and presses **Use code**; the plugin
   exchanges it at `POST /api/v1/auth/pair/`.

It is also the way in for an install whose browser cannot open `obsidian://`
links, where the one-click round trip never comes back.

Every connection gets its own token family, so connecting a second device can
never invalidate the first one. Connecting again from the same vault sends the
refresh token it already holds, so the connection it replaces ends instead of
staying listed in Connected apps. Manual access/refresh token entry remains
available under **Advanced** for self-hosted servers.

## Refresh: lazy + sliding reissue

- **Lazy refresh only.** The plugin refreshes the access token when it is
  about to expire at the moment a request needs it, and after a 401. There is
  deliberately **no background refresh timer** — idle rotation adds persist
  events (and therefore chances to lose a write) without adding security.
- **Sliding reissue on the server.** The refresh endpoint returns a new
  refresh token only once the current one is past ~half of its lifetime, and
  the previous token is **not** invalidated — it simply ages out. If the
  plugin ever fails to persist a reissued token (crash, force-quit), the old
  one still works on next launch. Nothing is lost.
- **Concurrent refreshes are deduplicated** behind a single in-flight promise.

## Failure handling: never destroy state

- **Transient failures** (offline, server errors, rate limits) are retried
  with backoff and then surfaced as a soft error. Tokens are kept; the next
  sync retries.
- **Confirmed-dead sessions** (HTTP 401, or a 400 whose body carries the
  server's `reauth_required` / `token_not_valid` markers) switch the plugin
  into a persistent **Reconnect** state: the status bar shows "Reconnect
  Pensio" and the settings tab offers **Connect to Pensio** and the setup
  code again. Local notes and sync history are untouched.
- **Tokens are wiped only on an explicit Disconnect.** A refresh failure — of
  any kind — never deletes credentials.
- After a failed refresh the plugin **never falls back to a stale access
  token**; the request fails with a typed error instead of producing
  confusing downstream 401s.

## Storage

- Tokens live in **Obsidian SecretStorage** — backed by the OS keychain on
  desktop, app-local storage on mobile — never in `data.json`, so they can't
  leak through vault syncing.
- Every save is **verified by read-back** (with one retry), and the plugin
  flushes tokens once more in `onunload()` as a belt-and-braces measure
  against opaque flush timing.
- Legacy plaintext tokens from very old versions are migrated to
  SecretStorage automatically and removed from `data.json`.

## Revocation

Each connection is listed in Pensio → Settings → **Connected apps**, where
**Stop it** ends it at any time; the server refuses every request from a
stopped device. Each connection also ends a year after it was made.

The plugin's **Disconnect** (the button in its settings, and the **Disconnect
from Pensio** command) stops this vault's connection on Pensio first, at
`POST /api/v1/auth/disconnect/`, then clears the tokens and sync state here.
Offline, or on a session that is already dead, it still clears locally and says
to stop the connection in Connected apps too. Another computer syncing the same
vault keeps its own connection.
