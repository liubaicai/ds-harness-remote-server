import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { deviceRegistrationRequestSchema, deviceRefreshRequestSchema } from './protocol/index.js'
import { ApiError, Store, equal, hash, secret } from './store.js'
import { createClientIpResolver } from './client-ip.js'
import { Gateway } from './gateway.js'
import { credentialLabel, iceServersFor, normalizeIceConfig, type IceConfig } from './ice.js'
import { describeStunProbe, orderStunUrls, probeStunServers } from './stun-probe.js'

export interface Config {
  account: string
  password: string
  dataFile: string
  publicUrl: string
  /** Broker WebRTC (LAN / P2P / TURN) signaling instead of Relay-only. Defaults to true. */
  webrtc?: boolean
  /** STUN/TURN endpoints handed to peers through `/api/v1/turn/credentials`. */
  ice?: Partial<IceConfig>
  /** Directory holding the built Web UI. Defaults to `../dist/public`. */
  publicDir?: string
  /** Proxy IP/CIDR allowlist whose `X-Forwarded-For` may be trusted for rate limiting. */
  trustedProxies?: string[]
}
const loginSchema = z.object({ email: z.string().min(1).max(254), password: z.string().min(1).max(1024) }).strict()
const defaultPublicDir = fileURLToPath(new URL('../dist/public/', import.meta.url))
function readAssets(dir: string): Map<string, Buffer> {
  if (!existsSync(dir)) return new Map()
  // Normalise the separator so asset keys never start with a slash, whether or
  // not the configured directory was written with a trailing one.
  const root = dir.endsWith(sep) ? dir : dir + sep
  const assets = new Map<string, Buffer>()
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = join(entry.parentPath, entry.name)
    const path = file.slice(root.length).replaceAll('\\', '/')
    assets.set(path, readFileSync(file))
  }
  return assets
}
// A path is a file request when its last segment has an extension, or when it
// lives under the hashed /assets/ output. Everything else is a Client route.
function isFileRequest(path: string): boolean {
  if (path.startsWith('/api/') || path.startsWith('/ws/')) return false
  return path.startsWith('/assets/') || /\.[^/]+$/.test(path)
}
function contentType(name: string): string {
  if (name.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (name.endsWith('.css')) return 'text/css; charset=utf-8'
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.webp')) return 'image/webp'
  if (name.endsWith('.svg')) return 'image/svg+xml'
  if (name.endsWith('.ico')) return 'image/x-icon'
  return 'text/html; charset=utf-8'
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new ApiError('INVALID_MESSAGE', 415)
  let length = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    length += chunk.length
    if (length > 16384) throw new ApiError('FRAME_TOO_LARGE', 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ApiError('INVALID_MESSAGE') }
}
export function createRemoteServer(config: Config) {
  if (!config.account.trim() || config.password.length < 12) throw new Error('DSH_SERVER_ACCOUNT and DSH_SERVER_PASSWORD (at least 12 characters) are required.')
  const url = new URL(config.publicUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('DSH_SERVER_PUBLIC_URL must be an HTTP(S) origin.')
  const store = new Store(config.dataFile, config.account.trim(), config.password)
  const webrtc = config.webrtc !== false
  const ice = normalizeIceConfig(config.ice)
  if (ice.probeStun === true && ice.stunUrls.length > 0) {
    // Best effort and detached: the Server starts serving immediately, and the
    // ordering improves once the measurements land. Browsers fan out to every
    // endpoint, but werift (the fallback Host RTC backend) only takes the
    // first, so this ordering is what decides whether that path can punch.
    void probeStunServers(ice.stunUrls).then(results => {
      const ordered = orderStunUrls(ice.stunUrls, results)
      ice.stunUrls = ordered
      const summary = ordered.map(url => results.find(result => result.url === url)).filter(result => result !== undefined)
      if (summary.every(result => !result.reachable)) {
        console.warn(`[ice] No STUN endpoint responded (${describeStunProbe(summary)}); direct connections may fall back to Relay.`)
      } else {
        console.info(`[ice] STUN probe, preferred first: ${describeStunProbe(summary)}`)
      }
    }, () => undefined)
  }
  const assets = readAssets(config.publicDir ?? defaultPublicDir)
  const clientIp = createClientIpResolver(config.trustedProxies)
  const sessions = new Map<string, number>()
  const limits = new Map<string, { count: number; until: number }>()
  function rate(key: string, max: number) {
    for (const [k, v] of limits) if (v.until < Date.now()) limits.delete(k)
    let entry = limits.get(key)
    if (!entry) { if (limits.size >= 4096) throw new ApiError('RATE_LIMITED', 429); entry = { count: 0, until: Date.now() + 60_000 }; limits.set(key, entry) }
    if (++entry.count > max) throw new ApiError('RATE_LIMITED', 429)
  }
  function token(req: IncomingMessage): string {
    const authorization = req.headers.authorization
    if (authorization) return authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    return /(?:^|;\s*)dsh_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''
  }
  function accountAuth(req: IncomingMessage) {
    const key = hash(token(req))
    if ((sessions.get(key) ?? 0) <= Date.now()) { sessions.delete(key); throw new ApiError('ACCOUNT_AUTH_REQUIRED', 401) }
  }
  function deviceAuth(req: IncomingMessage) {
    if (!req.headers.authorization?.startsWith('Bearer ')) throw new ApiError('AUTH_REQUIRED', 401)
    return store.authenticate(req.headers.authorization.slice(7))
  }
  function cookie(value: string, age: number): string { return `dsh_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${url.protocol === 'https:' ? '; Secure' : ''}` }
  const profile = () => ({ account: store.account, profile: { displayName: store.account }, isAdmin: false })
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
    void route(req, res).catch(error => {
      if (res.headersSent || res.destroyed) return
      const e = error instanceof ApiError ? error : error instanceof z.ZodError ? new ApiError('INVALID_MESSAGE') : new ApiError('INTERNAL_ERROR', 500)
      if (e.status === 429) res.setHeader('Retry-After', '60')
      json(res, e.status, { error: { code: e.code, message: e.code, requestId: randomUUID(), retryable: e.status === 429 || e.status >= 500 } })
    })
  })
  const gateway = new Gateway(server, store, url.origin, { webrtc })
  function descriptor(d: ReturnType<Store['get']>) {
    return { ...d.descriptor, membershipId: `account:${hash(store.account).slice(0, 16)}`, online: gateway.peers.has(d.descriptor.deviceId), lastSeenAt: d.lastSeenAt }
  }
  async function route(req: IncomingMessage, res: ServerResponse) {
    const requestUrl = new URL(req.url ?? '/', url)
    const path = requestUrl.pathname
    const method = req.method
    if (req.headers.origin && req.headers.origin !== url.origin) throw new ApiError('AUTH_INVALID', 403)
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError('AUTH_INVALID', 403)
    // A file request resolves to that file or to a 404 — never to the shell, or
    // a missing bundle would silently arrive as HTML.
    if (method === 'GET' && isFileRequest(path)) {
      const asset = assets.get(path.slice(1))
      if (!asset) throw new ApiError('METHOD_NOT_FOUND', 404)
      res.setHeader('Content-Type', contentType(path))
      res.end(asset); return
    }
    if (method === 'GET' && (path === '/health' || path === '/healthz' || path === '/ready')) { json(res, 200, { status: 'ok' }); return }
    // History-mode SPA. The Client routes on window.location.pathname, so every
    // remaining GET renders index.html; without this a reload on /app/remote
    // would 404 because only the exact paths the Server knew about were served.
    if (method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/ws/')) {
      const shell = assets.get('index.html')
      if (!shell) throw new ApiError('METHOD_NOT_FOUND', 404)
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(shell); return
    }
    rate(`api:${clientIp(req)}`, 240)
    if (method === 'POST' && path === '/api/v1/auth/login') {
      rate(`login:${clientIp(req)}`, 20)
      const credentials = loginSchema.parse(await body(req))
      if (!equal(credentials.email.trim(), store.account) || !equal(credentials.password, config.password)) throw new ApiError('AUTH_INVALID', 401)
      for (const [key, expires] of sessions) if (expires <= Date.now()) sessions.delete(key)
      if (sessions.size >= 256) throw new ApiError('RATE_LIMITED', 429)
      const value = secret(), expiresAt = Date.now() + 8 * 3600_000
      sessions.set(hash(value), expiresAt)
      res.setHeader('Set-Cookie', cookie(value, 8 * 3600))
      json(res, 200, { ...profile(), token: value, expiresAt }); return
    }
    if (method === 'GET' && path === '/api/v1/auth/me') { accountAuth(req); json(res, 200, profile()); return }
    if (method === 'POST' && path === '/api/v1/auth/logout') {
      sessions.delete(hash(token(req))); res.setHeader('Set-Cookie', cookie('', 0)); json(res, 200, { status: 'ok' }); return
    }
    if (method === 'GET' && path === '/api/v1/account/devices') {
      accountAuth(req); json(res, 200, { items: store.list().map(descriptor), serverUrl: url.origin, transport: webrtc ? 'auto' : 'relay' }); return
    }
    // Remove a device from the account: its tokens die, its socket drops, and
    // the registration slot is freed. The identity stays tombstoned so a stale
    // device token can never re-register itself under the same deviceId.
    const removal = /^\/api\/v1\/account\/devices\/([^/]+)$/.exec(path)
    if (method === 'DELETE' && removal) {
      accountAuth(req)
      store.delete(decodeURIComponent(removal[1]!))
      json(res, 200, { status: 'deleted' }); return
    }
    if (method === 'POST' && (path === '/api/v1/devices/register' || path === '/api/v1/devices/register-owned-role')) {
      const source = path.endsWith('register-owned-role') ? deviceAuth(req) : undefined
      if (!source) accountAuth(req)
      const { device } = deviceRegistrationRequestSchema.parse(await body(req))
      if (source && (source.descriptor.deviceId === device.deviceId || source.descriptor.role === device.role)) throw new ApiError('INVALID_MESSAGE', 409)
      // Delegated registration bootstraps a brand-new device only. Accepting an
      // existing identity here would let any client rotate the Host's
      // credentials and take over its slot.
      json(res, 200, store.register(device, source !== undefined)); return
    }
    if (method === 'POST' && path === '/api/v1/auth/refresh') {
      const data = deviceRefreshRequestSchema.parse(await body(req))
      json(res, 200, store.refresh(data.deviceId, data.refreshToken)); return
    }
    if (method === 'DELETE' && path === '/api/v1/devices/self') {
      store.revoke(deviceAuth(req).descriptor.deviceId); json(res, 200, { status: 'revoked' }); return
    }
    if (method === 'GET' && path === '/api/v1/me') { json(res, 200, descriptor(deviceAuth(req))); return }
    // STUN/TURN credentials for one WebRTC negotiation. Scoped to a live link so
    // a credential cannot be harvested and reused outside its connection.
    if (method === 'GET' && path === '/api/v1/turn/credentials') {
      const source = deviceAuth(req)
      const connectionId = requestUrl.searchParams.get('connection_id')
      if (!connectionId) throw new ApiError('INVALID_MESSAGE')
      if (!gateway.ownsLink(connectionId, source.descriptor.deviceId)) throw new ApiError('CONNECTION_NOT_FOUND', 404)
      rate(`ice:${hash(source.descriptor.deviceId)}`, 60)
      json(res, 200, { iceServers: iceServersFor(ice, credentialLabel(connectionId, source.descriptor.deviceId)) }); return
    }
    if (method === 'GET' && path === '/api/v1/devices') {
      const source = deviceAuth(req)
      if (source.descriptor.role !== 'client') throw new ApiError('MEMBERSHIP_REQUIRED', 403)
      const items = store.list().filter(d => d.descriptor.role === 'host').map(d => {
        const { identityKey: _key, ...item } = descriptor(d)
        return item
      })
      json(res, 200, { items, nextCursor: null }); return
    }
    const match = /^\/api\/v1\/devices\/([^/]+)(\/presence)?$/.exec(path)
    if (method === 'GET' && match) {
      const source = deviceAuth(req), target = store.get(match[1]!)
      if (source.descriptor.role === target.descriptor.role) throw new ApiError('MEMBERSHIP_REQUIRED', 403)
      const d = descriptor(target)
      json(res, 200, match[2] ? { deviceId: d.deviceId, online: d.online, lastSeenAt: d.lastSeenAt } : d); return
    }
    throw new ApiError('METHOD_NOT_FOUND', 404)
  }
  return { server, store, gateway, close: async () => { gateway.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value))
}
