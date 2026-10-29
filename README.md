# DS Harness Remote — Self-hosted Server (standalone)

**English** · [中文](README.zh.md)

This repository is the **Server half** of [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote), extracted into a self-contained project so it can be built, deployed and patched on its own.

It is meant to be used **with that project's Host plugin and clients** (Desktop, Web, Android, dsh-TUI). Nothing else is needed on the Server side: this repo contains the HTTP/WebSocket Server, the account and device registry, the Web UI, and the vendored protocol schema the clients speak.

> Baseline: upstream `apps/server` at commit [`4d888ad`](https://github.com/liguobao/ds-harness-remote/tree/4d888ad3e359416836072796d06348eba37eccc6) (version `0.5.19`), plus the changes listed in [What differs from upstream](#what-differs-from-upstream).

## Why this fork exists

Upstream's self-hosted Server is Relay-only by design: `hello.ack` hard-codes `webrtcEnabled: false`, the capability list only contains `transport.relay`, WebRTC signaling frames are dropped, and `GET /api/v1/turn/credentials` does not exist. Clients therefore skip LAN/P2P/TURN entirely and always relay through the Server.

This fork brokers the whole ladder — **LAN → P2P → TURN → Relay** — so connections fall back to Relay only when they have to.

## Quick start (Docker)

```bash
git clone git@github.com:liubaicai/ds-harness-remote-server.git
cd ds-harness-remote-server
cp .env.example .env
# Edit .env: DSH_SERVER_ACCOUNT, DSH_SERVER_PASSWORD (12+ chars), DSH_SERVER_PUBLIC_URL
docker compose up -d --build
```

Open <http://localhost:8080>. Device credentials persist in the `server-data` volume; `docker compose down` stops the service.

Put an HTTPS reverse proxy in front of it instead of exposing the Node listener directly. The proxy must support WebSocket Upgrade at `/ws/v1/connect` with an idle timeout above 75 seconds.

### Reverse proxy security

By default the Server ignores `X-Forwarded-For` and uses the socket peer for login throttling and audit addresses. Set `DSH_SERVER_TRUSTED_PROXIES` to a comma-separated list of **exact IP addresses or CIDRs of your own proxies**, for example `127.0.0.1,::1` for a same-host proxy. Docker may expose a bridge gateway as the peer instead: configure the actual observed proxy address, not an assumed loopback address. Invalid entries fail startup. Do not use public/client networks or trust-all ranges (`0.0.0.0/0`, `::/0`).

The Server consults XFF only when the immediate socket peer is trusted, then walks the chain **right to left**, stopping at the first untrusted address. IPv4-mapped IPv6 addresses are normalized to IPv4; malformed chains fall back to the socket peer. Your trusted proxy must overwrite XFF with the actual peer (a single edge proxy can use nginx `proxy_set_header X-Forwarded-For $remote_addr;`) or append the actual connecting peer to a properly managed chain. Never blindly forward an attacker-supplied header. Restrict direct access to the backend with bind/firewall rules; the allowlist is not a substitute for that restriction. A shared unconfigured proxy makes all clients share one login-throttle bucket.

### Delete a paired device

The account-authenticated endpoint `DELETE /api/v1/account/devices/:id` returns `200 {"status":"deleted"}`. Authenticate with the account session cookie or account bearer token, not a device token. Deletion removes the device and its tokens, disconnects its active WebSocket, and frees a slot in the 256-device limit. Already-revoked devices can also be deleted (the device list only shows active devices). A minimal deleted-ID tombstone remains to prevent old device credentials from re-registering that identity: to pair the device again, create a new device ID and repeat pairing. Deletion does not erase remote files or data on the Host.

### Prebuilt image

CI builds multi-arch images (amd64/arm64) after the test suite passes and publishes them to `ghcr.io/liubaicai/ds-harness-remote-server`:

```bash
docker run -d --name dsh-remote-server \
  -e DSH_SERVER_ACCOUNT=you@example.com \
  -e DSH_SERVER_PASSWORD=<12+ characters> \
  -e DSH_SERVER_PUBLIC_URL=https://remote.example.com \
  -p 8080:8080 -v dsh-server-data:/data \
  ghcr.io/liubaicai/ds-harness-remote-server:latest
```

Tags: `latest` and `main` track the default branch, `v*` releases produce semver tags (`0.5.19`, `0.5`), and `sha-<short>` pins a commit. To use it in Compose, replace the `server` service's `build:` block with `image: ghcr.io/liubaicai/ds-harness-remote-server:<tag>` and keep the rest as is.

## Local setup

Requires Node.js 22 and pnpm 9.15.4. Everything runs from the repository root — there is no workspace, `apps/` or `packages/` layout any more:

```bash
pnpm install
pnpm build                 # tsc → dist/, vite → dist/public/
cp .env.example .env       # then edit account / password
node --env-file=.env dist/main.js
```

For development with reload: `pnpm dev` (tsx watch on `src/main.ts`; build the Web UI once with `pnpm build` so it is served from `dist/public/`).

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run the Server from TypeScript sources |
| `pnpm build` | Compile `src/` to `dist/` and build the Web UI into `dist/public/` |
| `pnpm start` | Run the compiled Server (`node dist/main.js`) |
| `pnpm check` | Type-check the Server and the Web UI |
| `pnpm test` | Run the test suite |

Set the same Server URL on your Host and Client, then sign in with the same account. Use an email address as the account name for compatibility with existing clients.

## Android v0.5.22 / v0.5.23 login compatibility

These Android versions hide the password button when a self-hosted server has no OAuth providers. This server enables a discovery-only workaround by default: `/api/v1/auth/oauth/providers` advertises a placeholder GitHub entry, which makes Android display the key/password button. **Tap the key icon and use your existing server account and password.** The GitHub entry is not real OAuth; opening it shows instructions to return to password login. If you open GitHub by mistake, use **Cancel and return to app** on the instructions page to clear the client's pending login; simply pressing Back may leave its buttons disabled. If that link fails, fully close and reopen the app. The link sends only an OAuth cancellation error, never credentials. No third-party service, QR login, OAuth token exchange, or authentication bypass is enabled.

After upgrading to an Android client that fixes the empty-provider login screen, set `DSH_SERVER_ANDROID_LOGIN_COMPAT=0` and restart/recreate the server container. Discovery then returns an empty list; password authentication is unchanged. Server release versions are independent of the upstream Android app versions.

## Configuration

| Variable | Purpose / default |
| --- | --- |
| `DSH_SERVER_ACCOUNT` | Required login account |
| `DSH_SERVER_PASSWORD` | Required; at least 12 characters |
| `DSH_SERVER_PUBLIC_URL` | Browser-facing URL; default `http://localhost:8080` |
| `DSH_SERVER_HOST` | Listen / port-binding address; default `127.0.0.1`, use `0.0.0.0` for LAN access |
| `DSH_SERVER_PORT` | Default `8080` |
| `DSH_SERVER_DATA_FILE` | Default `data/state.json`, relative to the working directory |
| `DSH_SERVER_TRUSTED_PROXIES` | Comma-separated exact proxy IPs/CIDRs; default empty (ignore XFF); trust only controlled proxies |
| `DSH_SERVER_ANDROID_LOGIN_COMPAT` | Restore Android v0.5.22/23 password entry via placeholder GitHub discovery; default `1`, set `0` to disable |
| `DSH_SERVER_WEBRTC` | Broker LAN/P2P/TURN instead of Relay only; default `1`, set `0` to force Relay |
| `DSH_SERVER_STUN_URLS` | Comma-separated STUN URLs; default `stun:stun.miwifi.com:3478,stun:stun.cloudflare.com:3478`, empty disables STUN |
| `DSH_SERVER_STUN_PROBE` | Probe STUN reachability at startup and try the fastest first; default `1`, set `0` to disable |
| `DSH_SERVER_TURN_URLS` | Comma-separated TURN URLs; default empty (STUN-only) |
| `DSH_SERVER_TURN_SECRET` | coturn shared secret for expiring credentials |
| `DSH_SERVER_TURN_USERNAME` / `DSH_SERVER_TURN_PASSWORD` | Static TURN credentials instead of a shared secret |
| `DSH_SERVER_TURN_TTL` | TURN credential lifetime in seconds; default `3600` |

## WebRTC data plane (LAN → P2P → TURN → Relay)

Peers degrade through four tiers and stop at the first one that works:

| Mode | Data path | Requires |
| --- | --- | --- |
| LAN | Client ↔ Host directly, never leaving the local segment | both peers on one L2 segment |
| P2P | Direct after STUN-assisted NAT traversal | reachable STUN, compatible NAT mapping |
| TURN | Relayed by a TURN server, still over WebRTC | TURN endpoints plus credentials |
| Relay | Client ↔ this Server's WebSocket ↔ Host | nothing; always available |

The Server brokers the ladder instead of forcing Relay. The account endpoint `GET /api/v1/account/connections` (and the web UI's live connections panel) shows each active link's two devices, the Client's chosen transport, and the path the Host announced (LAN/P2P/TURN/Relay) — account visibility only. It only:

1. advertises `transport.lan/p2p/turn/relay` with `webrtcEnabled: true` in `hello.ack`, intersected with what the peer offered;
2. forwards `signal.offer`, `signal.answer`, and `signal.ice` verbatim between the two devices of a connection;
3. mints ICE credentials at `GET /api/v1/turn/credentials?connection_id=<id>`, scoped to a live connection.

Encryption boundaries do not change: Noise IK still runs over `/ws/v1/connect`, and only ciphertext moves to the data channel. A Server-side observer sees SDP/ICE in the clear but gains nothing over Relay, because the payloads stay end-to-end encrypted.

### STUN and P2P

STUN defaults to `stun:stun.miwifi.com:3478,stun:stun.cloudflare.com:3478` — a China-fast endpoint first, a global anycast one second. Without STUN only LAN peers and peers sharing a public IP can connect directly; everything else falls back to Relay. Set `DSH_SERVER_STUN_URLS=` empty to disable it, or point it at your own STUN listener.

At startup the Server probes the configured endpoints and moves the fastest reachable one to the front (`DSH_SERVER_STUN_PROBE=0` disables this). Browsers fan out to every URL regardless, but the fallback Host RTC backend (werift, used when native `@roamhq/wrtc` cannot load) only reads the first entry, so the ordering decides whether that path can punch. A failed probe keeps your configured order.

### TURN

TURN is only needed when hole punching fails — symmetric or carrier-grade NAT, strict corporate firewalls. Deploy coturn with a shared secret:

```conf
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=<same value as DSH_SERVER_TURN_SECRET>
realm=ds-harness-remote
min-port=49160
max-port=49200
no-multicast-peers
```

Then configure the Server:

```bash
DSH_SERVER_TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp
DSH_SERVER_TURN_SECRET=<shared secret>
```

Open `3478/tcp`, `3478/udp`, `5349/tcp`, and the relay range `49160-49200/udp`. On a cloud VM behind 1:1 NAT also give coturn `external-ip=<public-ip>/<private-ip>`.

Credentials follow the coturn REST convention — `username=<expiry>:<label>`, `credential=base64(HMAC-SHA1(secret, username))` — so they expire after `DSH_SERVER_TURN_TTL` seconds and are only issued to the two devices of a live connection. Static `DSH_SERVER_TURN_USERNAME`/`DSH_SERVER_TURN_PASSWORD` work too but grant standing relay access.

`docker compose --profile turn up -d` starts the bundled coturn on a Linux host (it needs host networking for the relay port range). Set a strong, nonempty `DSH_SERVER_TURN_SECRET` first: the coturn container exits before starting the relay if the secret is missing or empty. Ordinary `docker compose up -d` does not require a TURN secret because the profile is optional. Static username/password credentials are passed through to the Server for an external TURN service; they do not replace the bundled profile's shared-secret requirement. An explicitly empty `DSH_SERVER_STUN_URLS=` is preserved in Compose too. On Docker Desktop run coturn on the host instead.

## Connection diagnostics, history and quality

The account device page now includes connection history and quality statistics, refreshing every 30 seconds. Open **Connection diagnostics** for service checks, or diagnose an individual history row for its stage/transport/end timeline. The dialog downloads a sanitized JSON diagnostic bundle.

- History captures new connection attempts, handshake stages, reported transport changes, rejections and disconnect reasons. It cannot reconstruct connections from before this upgrade.
- Statistics cover retained records: connection counts, completed handshakes, mean request-to-handshake-completion time, last reported transports, relay ciphertext bytes and frames.
- Relay counters count ciphertext whose WebSocket send callback succeeded, not confirmed delivery; they exclude wire framing, direct-path traffic and TURN traffic. Handshake completion does not prove application success.
- Heartbeat RTT is **server-to-device**, not client-to-Host end-to-end latency. Direct-path throughput, end-to-end RTT and packet loss are unavailable without client telemetry; no estimates are presented as measurements.
- Diagnostics use configuration, device presence, connection events and the existing startup STUN probe. Opening diagnostics does not scan arbitrary targets. Server-side STUN reachability does not establish client reachability, and configured TURN credentials do not establish TURN availability.

History is persisted beside the account data at `<DSH_SERVER_DATA_FILE>.connections.json`, bounded to 7 days and 1,000 records with throttled atomic writes and hourly idle cleanup. Connections active for more than 7 days can age out of history without affecting the live connections list or the connection itself. Recovered active records are marked interrupted rather than shown online after restart. Protect this file like account data: it contains device IDs and timing metadata, but no application payload, ciphertext content, SDP or ICE candidates. Diagnostic downloads use a strict field allowlist and fresh per-export anonymous identifiers, excluding account/device names, original IDs, addresses, credentials and free text. Timing and aggregate metadata remain in the bundle; review before sharing.

All new endpoints require an account cookie or account Bearer token; device tokens cannot access them:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/account/connection-history?limit=20&offset=0` | Paginated retained history |
| `GET /api/v1/account/connection-stats` | Retained-record statistics and server-to-device RTT |
| `GET /api/v1/account/diagnostics` | Service diagnostics |
| `GET /api/v1/account/diagnostics?connectionId=<id>` | Individual connection diagnostics |
| `GET /api/v1/account/diagnostics/export` | Sanitized JSON attachment; also accepts `connectionId` |

## Web sessions (browser access to DSH conversations)

After signing in to the management page, click **Sessions** on an online Host (or open `/app/sessions` directly) to list workspaces and sessions in the browser, open past sessions, create new ones and chat in real time — the capability the hosted edition (dsh.r2049.cn) has and the upstream open-source build lacks.

**How it works.** The browser registers as a standard `client` device (`platform: browser`, X25519 identity kept in localStorage), opens the Relay link over `/ws/v1/connect`, completes the `Noise_IK_25519_ChaChaPoly_SHA256` end-to-end handshake with the Host, and then uses exactly the same `agent.acp.*` business plane as the Android/Desktop clients:

- catalog: `initialize`, `dsh/workspaceList`, `dsh/sessionList`, `dsh/sessionHistory`;
- conversation: `session/new`, `session/load`, `session/prompt`, `session/cancel`, with streaming updates delivered via `agent.acp.stream.open` + `agent.acp.frame`;
- approvals: `session/request_permission` cards answered once via `agent.acp.respond`.

The server only relays ciphertext; conversation content never leaves the browser and the Host. The chat UI (message stream, tool cards, approval cards) is a pure in-memory frontend projection. The web MVP uses the Relay data plane (WebRTC upgrade is a follow-up), and the Host must enable an ACP backend (`acp.enabled` / `acp.backends`); the effective backend list comes from the Host's `initialize` reply.

## What differs from upstream

| Area | Upstream | Here |
| --- | --- | --- |
| `hello.ack` | `webrtcEnabled: false`, `['transport.relay']` | Real capability intersection, `webrtcEnabled` from config, `webrtcFallbackTimeoutMs: 8000` |
| Connection setup | Client must offer `relay` | Any direct transport both sides support is accepted and stored on the link |
| Signaling | `signal.*` frames silently dropped | Forwarded verbatim between the two parties of a link |
| Path selection | `transport === 'relay'` only | Any negotiated tier; the Host's announcement is relayed without tearing the link down |
| TURN | No `/api/v1/turn/credentials` (404) | Device auth + live-link ownership check + expiring coturn credentials |
| STUN | Single hard-coded endpoint | Ordered default list + startup reachability probe |
| Layout | `apps/server` inside a pnpm workspace | Single package at the repository root |

## Repository layout

```
src/                Server sources (HTTP, WebSocket gateway, store, ICE)
src/protocol/       Vendored from upstream packages/protocol — the wire contract
web/                Web UI (Vite + React + Ant Design), built into dist/public/
web/src/remote/     Web session client stack (identity, relay link, Noise IK, ACP)
tests/              Vitest suite, including a vendored Noise IK implementation
Dockerfile          Multi-stage production image
compose.yaml        Server (+ optional coturn profile)
```

`src/protocol/` and `tests/support/crypto/` are copies of upstream sources, kept byte-identical apart from import specifiers so they can be re-synced by copying the files again. They are covered by the upstream MIT licence (see `LICENSE`).

## Tests

```bash
pnpm test        # vitest run
pnpm check       # server and web type checks
pnpm build
node web/tests/observability.browser.mjs  # optional real-browser UI checks
```

The browser check runs an isolated loopback fixture server with mock data, covering pagination, diagnostics, JSON download, light/dark themes, mobile layout, empty/error states and expired login. It requires local Chromium, Chrome or Edge; set `BROWSER_PATH` to override executable discovery. It does not modify the running service. Screenshots are written to the temporary directory printed by the command.

Observability tests additionally cover retention/capacity, restart recovery, bounded event timelines, account-only authorization and diagnostic export allowlists.

The suite covers account/device authorization, credential rotation, revocation and deletion, trusted-proxy/XFF anti-spoofing (IPv4/IPv6), Control-frame validation, end-to-end encrypted Relay (real Noise IK), relay authorization and replay handling, WebRTC brokering (signaling fan-out, unnegotiated transports, third-party injection), TURN credential minting, the STUN probe, the web session channel (browser device registration, relay selection, encrypted `agent.acp.*` round trips) and the ACP chat projection (streaming messages, tools, approvals, history folding). Compose regression tests additionally render configuration when the Docker Compose CLI is installed (no daemon needed), and execute the missing-secret guard when a POSIX shell is available; those integration checks are skipped when their tools are unavailable.

## Keeping in sync with upstream

Upstream may refactor `apps/server` at any time. When re-syncing:

1. copy `apps/server/src/*` over `src/` (keeping this repo's `protocol/` path rewrite: `@dsh-remote/protocol` → `./protocol/index.js`);
2. copy `apps/server/web/` over `web/`;
3. re-apply the four behavioural changes listed above — they live in `src/gateway.ts` (handshake, connection gating, signaling, selection), `src/server.ts` (TURN endpoint + STUN probe wiring), `src/ice.ts` and `src/stun-probe.ts`.

## Licence

MIT, following upstream. Vendored protocol/crypto sources keep their original copyright.
