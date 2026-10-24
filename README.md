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

## Configuration

| Variable | Purpose / default |
| --- | --- |
| `DSH_SERVER_ACCOUNT` | Required login account |
| `DSH_SERVER_PASSWORD` | Required; at least 12 characters |
| `DSH_SERVER_PUBLIC_URL` | Browser-facing URL; default `http://localhost:8080` |
| `DSH_SERVER_HOST` | Listen / port-binding address; default `127.0.0.1`, use `0.0.0.0` for LAN access |
| `DSH_SERVER_PORT` | Default `8080` |
| `DSH_SERVER_DATA_FILE` | Default `data/state.json`, relative to the working directory |
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

The Server brokers the ladder instead of forcing Relay. It only:

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

`docker compose --profile turn up -d` starts the bundled coturn on a Linux host (it needs host networking for the relay port range). On Docker Desktop run coturn on the host instead.

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
tests/              Vitest suite, including a vendored Noise IK implementation
Dockerfile          Multi-stage production image
compose.yaml        Server (+ optional coturn profile)
```

`src/protocol/` and `tests/support/crypto/` are copies of upstream sources, kept byte-identical apart from import specifiers so they can be re-synced by copying the files again. They are covered by the upstream MIT licence (see `LICENSE`).

## Tests

```bash
pnpm test        # vitest run
```

The suite covers account/device authorization, credential rotation and revocation, Control-frame validation, end-to-end encrypted Relay (real Noise IK), relay authorization and replay handling, WebRTC brokering (signaling fan-out, unnegotiated transports, third-party injection), TURN credential minting, and the STUN probe.

## Keeping in sync with upstream

Upstream may refactor `apps/server` at any time. When re-syncing:

1. copy `apps/server/src/*` over `src/` (keeping this repo's `protocol/` path rewrite: `@dsh-remote/protocol` → `./protocol/index.js`);
2. copy `apps/server/web/` over `web/`;
3. re-apply the four behavioural changes listed above — they live in `src/gateway.ts` (handshake, connection gating, signaling, selection), `src/server.ts` (TURN endpoint + STUN probe wiring), `src/ice.ts` and `src/stun-probe.ts`.

## Licence

MIT, following upstream. Vendored protocol/crypto sources keep their original copyright.
