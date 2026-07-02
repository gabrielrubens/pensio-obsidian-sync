# Authentication & Token Lifecycle

How Pensio Sync authenticates, refreshes, and stores credentials — and the
design rules that keep a pairing alive across weeks of Obsidian being closed.

## Pairing

The plugin authenticates with a **one-time setup code** (TV-style pairing):

1. The Pensio web app (Settings → API tokens → **Connect Obsidian**) mints an
   8-character code. It expires in 5 minutes and can be used once.
2. The plugin exchanges the code at `POST /api/v1/auth/pair/` together with a
   locally generated `device_id` and a device name.
3. The server answers with a fresh **per-device token family**: a short-lived
   access token (30 min) and a long-lived refresh token.

Every pairing gets its own token family, so pairing a second device can never
invalidate the first one. Manual access/refresh token entry remains available
under **Advanced** for self-hosted servers.

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
  Pensio" and the settings tab asks for a new setup code. Local notes and
  sync history are untouched.
- **Tokens are wiped only on explicit logout.** A refresh failure — of any
  kind — never deletes credentials.
- After a failed refresh the plugin **never falls back to a stale access
  token**; the request fails with a typed error instead of producing
  confusing downstream 401s.

## Storage

- Tokens live in **Obsidian SecretStorage** (OS-level encrypted keychain),
  never in `data.json` — so they can't leak through vault syncing.
- Every save is **verified by read-back** (with one retry), and the plugin
  flushes tokens once more in `onunload()` as a belt-and-braces measure
  against opaque flush timing.
- Legacy plaintext tokens from very old versions are migrated to
  SecretStorage automatically and removed from `data.json`.

## Revocation

Each pairing appears as a device on the Pensio token page and can be revoked
there at any time; the server rejects refreshes from revoked devices. The
plugin's **Logout** command clears local tokens and sync state.
