import { runScenarios, scenarioName } from './support/test-scenarios.mjs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHmac } from 'node:crypto'
import { once } from 'node:events'
import { createSocket } from 'node:dgram'
import { WebSocket } from 'ws'
import { MAX_CONTROL_FRAME_BYTES, createControlFrame } from '../src/protocol/index.js'
import { NoiseIkSession, createNoisePrologue, generateKeyPair, toBase64Url, fromBase64Url } from './support/crypto/index.js'
import { createRemoteServer } from '../src/server.js'
import { DEFAULT_STUN_URLS } from '../src/ice.js'

const account = 'owner@example.com', password = 'local-test-password'
let app: ReturnType<typeof createRemoteServer>, dir: string, base: string, accountToken: string
const sockets: WebSocket[] = []
const noiseSessions: NoiseIkSession[] = []
async function request(path: string, method = 'GET', body?: unknown, token?: string, headers = {}) {
  const response = await fetch(`${base}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, data: await response.json(), headers: response.headers }
}
async function page(path: string) {
  const response = await fetch(`${base}${path}`)
  const type = response.headers.get('content-type') ?? ''
  return { status: response.status, type, text: type.includes('application/json') ? JSON.stringify(await response.json()) : await response.text() }
}
// fetch refuses a fixed list of "bad ports". This host hands out ephemeral
// ports from 1024 upwards, so a loopback listener can legitimately land on one
// and make every request in the case fail with a bare "bad port".
const BAD_PORTS = new Set([2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080])
async function start(pass = password, extra: Partial<Parameters<typeof createRemoteServer>[0]> = {}) {
  app = createRemoteServer({ account, password: pass, dataFile: join(dir, 'state.json'), publicUrl: 'http://localhost:8080', ...extra })
  for (let attempt = 0; ; attempt++) {
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening')
    const { port } = app.server.address() as { port: number }
    if (!BAD_PORTS.has(port)) { base = `http://127.0.0.1:${port}`; return }
    if (attempt === 20) throw new Error('could not bind a port fetch will talk to')
    await new Promise<void>((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()))
  }
}
async function device(role: 'host' | 'client' = 'client') {
  const keys = generateKeyPair()
  const descriptor = { deviceId: randomUUID(), identityKey: keys.publicKey, name: 'test-device', role, platform: 'linux', clientVersion: '0.4.15' }
  const result = await request('/devices/register', 'POST', { v: 1, device: descriptor }, accountToken)
  expect(result.status).toBe(200)
  return { ...descriptor, keys, ...result.data }
}
class Wire {
  messages: any[] = []
  waiters: (() => void)[] = []
  constructor(readonly ws: WebSocket) { ws.on('message', raw => { this.messages.push(JSON.parse(raw.toString())); for (const notify of this.waiters.splice(0)) notify() }) }
  send(type: Parameters<typeof createControlFrame>[0], payload: unknown) { this.ws.send(JSON.stringify(createControlFrame(type, payload))) }
  async next(type: string): Promise<any> {
    const until = Date.now() + 3000
    while (Date.now() < until) {
      const idx = this.messages.findIndex(m => m.type === type)
      if (idx >= 0) return this.messages.splice(idx, 1)[0].payload
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 50); this.waiters.push(() => { clearTimeout(timer); resolve() }) })
    }
    throw new Error(`Missing frame ${type}`)
  }
}
async function socket(d: Awaited<ReturnType<typeof device>>, overrides = {}) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws/v1/connect'); sockets.push(ws)
  const wire = new Wire(ws); await once(ws, 'open')
  wire.send('hello', { role: d.role, deviceId: d.deviceId, accessToken: d.accessToken, protocols: [1], capabilities: ['transport.relay', 'transport.p2p'], clientVersion: d.clientVersion, ...overrides })
  return wire
}
async function connection(preferredTransports: Array<'lan' | 'p2p' | 'turn' | 'relay'> = ['relay']) {
  const h = await device('host'), c = await device(), host = await socket(h), client = await socket(c)
  expect(await host.next('hello.ack')).toMatchObject({
    capabilities: ['transport.p2p', 'transport.relay'],
    webrtcEnabled: true,
    webrtcFallbackTimeoutMs: 8000,
  })
  await client.next('hello.ack')
  client.send('connect.request', { hostDeviceId: h.deviceId, preferredTransports })
  const incoming = await host.next('connect.incoming')
  expect(incoming.clientIdentityKey).toBe(c.identityKey)
  expect(incoming.preferredTransports).toEqual(preferredTransports)
  host.send('connect.accepted', { connectionId: incoming.connectionId })
  const { connectionId } = await client.next('connect.accepted')
  return { h, c, host, client, connectionId }
}
async function handshake(ctx: Awaited<ReturnType<typeof connection>>) {
  const { h, c, host, client, connectionId } = ctx
  const prologue = createNoisePrologue(connectionId, h.deviceId, c.deviceId)
  const initiator = new NoiseIkSession({ role: 'initiator', localPrivateKey: c.keys.privateKey, localPublicKey: c.identityKey, remotePublicKey: h.identityKey, prologue })
  const responder = new NoiseIkSession({ role: 'responder', localPrivateKey: h.keys.privateKey, localPublicKey: h.identityKey, remotePublicKey: c.identityKey, prologue })
  noiseSessions.push(initiator, responder)
  client.send('secure.handshake', { connectionId, targetDeviceId: h.deviceId, step: 1, data: toBase64Url(initiator.writeHandshake()) })
  responder.readHandshake(fromBase64Url((await host.next('secure.handshake')).data))
  host.send('secure.handshake', { connectionId, targetDeviceId: c.deviceId, step: 2, data: toBase64Url(responder.writeHandshake()) })
  initiator.readHandshake(fromBase64Url((await client.next('secure.handshake')).data))
  return { initiator, responder }
}
const prepareScenario1 = async () => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-server-'))
  await start()
  accountToken = (await request('/auth/login', 'POST', { email: account, password })).data.token
}
beforeEach(prepareScenario1)
const cleanupScenario2 = async () => {
  for (const noise of noiseSessions.splice(0)) noise.destroy()
  for (const ws of sockets.splice(0)) ws.terminate()
  await app.close()
  rmSync(dir, { recursive: true, force: true })
}
afterEach(cleanupScenario2)

describe('Android password login compatibility', () => {
  it('advertises a known provider without QR support, so Android reveals the password entry', async () => {
    const result = await request('/auth/oauth/providers')
    expect(result.status).toBe(200)
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(result.headers.get('set-cookie')).toBeNull()
    expect(result.data).toEqual({ items: [{
      id: 'github', displayName: 'Password login compatibility', startUrl: '/api/v1/auth/oauth/github/start',
    }] })
    // Mirrors Android v0.5.23's known-provider filter and password-button gate.
    const oauthMethods = ['zhihu', 'github', 'google'].filter(id => result.data.items.some((p: { id: string }) => p.id === id))
    expect(oauthMethods.length).toBeGreaterThan(0)
    expect(result.data.items.every((p: { qrStartUrl?: string }) => p.qrStartUrl === undefined)).toBe(true)
  })

  it('shows only instructions on OAuth start and never authenticates or reflects callback parameters', async () => {
    const response = await fetch(`${base}/api/v1/auth/oauth/github/start?redirect_uri=https://attacker.example&state=untrusted-marker&code=fake`, { redirect: 'manual' })
    expect(response.status).toBe(501)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('set-cookie')).toBeNull()
    const html = await response.text()
    expect(html).toContain('点击钥匙图标')
    expect(html).toContain('tap the key icon')
    expect(html).not.toContain('attacker.example')
    expect(html).not.toContain('untrusted-marker')
    const cancelHref = html.match(/href="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&')
    expect(cancelHref).toBeDefined()
    const cancel = new URL(cancelHref!)
    expect(cancel.protocol).toBe('dshremote:')
    expect(cancel.hostname).toBe('oauth')
    expect(cancel.searchParams.get('error')).toBe('password_login_required')
    expect(cancel.searchParams.has('token')).toBe(false)
    expect(cancel.searchParams.get('nonce')).toMatch(/^[a-f0-9-]{36}$/)
    const again = await page('/api/v1/auth/oauth/github/start?return_to=https://attacker.example')
    expect(again.text).not.toContain(cancel.searchParams.get('nonce')!)
    expect(again.text).not.toContain('attacker.example')
    expect((await request('/auth/me')).status).toBe(401)
    expect((await request('/auth/login', 'POST', { email: account, password: 'wrong' })).status).toBe(401)
    const login = await request('/auth/login', 'POST', { email: account, password })
    expect(login.status).toBe(200)
    expect((await request('/auth/me', 'GET', undefined, login.data.token)).status).toBe(200)
    expect((await request('/auth/oauth/github/start', 'POST', {})).status).toBe(404)
    expect((await request('/auth/oauth/github/callback?code=fake&state=fake')).status).toBe(404)
    expect((await request('/auth/oauth/qr/start?provider=github', 'POST', {})).status).toBe(404)
  })

  it('can disable the placeholder without disabling password authentication', async () => {
    await app.close()
    await start(password, { androidLoginCompat: false })
    const result = await request('/auth/oauth/providers')
    expect(result.status).toBe(200)
    expect(result.data).toEqual({ items: [] })
    expect((await request('/auth/oauth/github/start')).status).toBe(404)
    expect((await request('/auth/login', 'POST', { email: account, password })).status).toBe(200)
  })
})

describe('account and device authorization', () => {
  it('separates account, cookie and device credentials; rejects cross-origin requests', async () => {
    expect((await request('/auth/login', 'POST', { email: account, password: 'wrong' })).status).toBe(401)
    expect((await request('/auth/login', 'POST', { email: account, password }, undefined, { Origin: 'https://attacker.example' })).status).toBe(403)
    const d = await device()
    expect((await request('/auth/me', 'GET', undefined, d.accessToken)).status).toBe(401)
    expect((await request('/devices', 'GET', undefined, accountToken)).status).toBe(401)
    expect((await request('/devices/register', 'POST', { v: 1, device: d })).status).toBe(401)
    const login = await request('/auth/login', 'POST', { email: account, password })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    expect(login.headers.get('set-cookie')).toContain('HttpOnly')
    expect((await request('/account/devices', 'GET', undefined, undefined, { Cookie: cookie })).status).toBe(200)
    await request('/auth/logout', 'POST', {}, undefined, { Cookie: cookie })
    expect((await request('/auth/me', 'GET', undefined, login.data.token)).status).toBe(401)
  })
  it('pins identity and requires distinct opposite-role registration', async () => {
    const h = await device('host'), c = await device()
    const changed = { deviceId: h.deviceId, name: h.name, role: h.role, platform: h.platform, clientVersion: h.clientVersion, identityKey: c.identityKey }
    expect((await request('/devices/register', 'POST', { v: 1, device: changed }, accountToken)).data.error.code).toBe('PEER_IDENTITY_MISMATCH')
    expect((await request(`/devices/${h.deviceId}`, 'GET', undefined, c.accessToken)).data.identityKey).toBe(h.identityKey)
    expect((await request(`/devices/${c.deviceId}`, 'GET', undefined, c.accessToken)).status).toBe(403)
    const descriptor = { ...changed, deviceId: randomUUID() }
    expect((await request('/devices/register-owned-role', 'POST', { v: 1, device: descriptor }, h.accessToken)).status).toBe(409)
    expect((await request('/devices/register-owned-role', 'POST', { v: 1, device: descriptor }, c.accessToken)).status).toBe(200)
  })
  it('rejects delegated re-registration of an existing device identity', async () => {
    const h = await device('host'), c = await device()
    // The public descriptor is readable, but a client must not be able to
    // rotate the Host's credentials through register-owned-role.
    const publicDescriptor = await request(`/devices/${h.deviceId}`, 'GET', undefined, c.accessToken)
    const { deviceId, identityKey, name, role, platform, clientVersion } = publicDescriptor.data
    const attempt = await request('/devices/register-owned-role', 'POST', { v: 1, device: { deviceId, identityKey, name, role, platform, clientVersion } }, c.accessToken)
    expect(attempt.status).toBe(409)
    expect(attempt.data.error.code).toBe('REQUEST_CONFLICT')
    expect((await request('/me', 'GET', undefined, h.accessToken)).status).toBe(200)
  })
  it('deletes a device from the account and tombstones its identity', async () => {
    const d = await device('host'), wire = await socket(d); await wire.next('hello.ack')
    const closed = once(wire.ws, 'close')
    expect((await request(`/account/devices/${d.deviceId}`, 'DELETE')).status).toBe(401)
    expect((await request(`/account/devices/${randomUUID()}`, 'DELETE', undefined, accountToken)).status).toBe(404)
    expect((await request(`/account/devices/${d.deviceId}`, 'DELETE', undefined, accountToken)).status).toBe(200)
    await closed
    expect((await request('/me', 'GET', undefined, d.accessToken)).status).toBe(401)
    expect((await request('/auth/refresh', 'POST', { deviceId: d.deviceId, refreshToken: d.refreshToken })).status).toBe(404)
    const remaining = await request('/account/devices', 'GET', undefined, accountToken)
    expect(remaining.data.items.map((item: { deviceId: string }) => item.deviceId)).not.toContain(d.deviceId)
    // The identity stays tombstoned: the stale descriptor cannot register again.
    const descriptor = { deviceId: d.deviceId, identityKey: d.identityKey, name: d.name, role: d.role, platform: d.platform, clientVersion: d.clientVersion }
    expect((await request('/devices/register', 'POST', { v: 1, device: descriptor }, accountToken)).data.error.code).toBe('DEVICE_REVOKED')
  })
  it('separates login rate buckets per client behind a trusted proxy', async () => {
    await app.close()
    await start(password, { trustedProxies: ['127.0.0.1'] })
    accountToken = (await request('/auth/login', 'POST', { email: account, password })).data.token
    for (let n = 0; n < 21; n++) await request('/auth/login', 'POST', { email: account, password: 'wrong' }, undefined, { 'X-Forwarded-For': '198.51.100.10' })
    const attacker = await request('/auth/login', 'POST', { email: account, password: 'wrong' }, undefined, { 'X-Forwarded-For': '198.51.100.10' })
    const victim = await request('/auth/login', 'POST', { email: account, password }, undefined, { 'X-Forwarded-For': '203.0.113.20' })
    expect(attacker.status).toBe(429)
    expect(victim.status).toBe(200)
  })
  it('persists credentials as digests, rotates refresh tokens and revokes a reused family', async () => {
    const d = await device()
    const saved = readFileSync(join(dir, 'state.json'), 'utf8')
    expect(saved).not.toContain(d.refreshToken); expect(saved).not.toContain(d.accessToken); expect(saved).not.toContain(password)
    await app.close(); await start()
    expect((await request('/devices', 'GET', undefined, d.accessToken)).status).toBe(200)
    const rotated = await request('/auth/refresh', 'POST', { deviceId: d.deviceId, refreshToken: d.refreshToken })
    expect(rotated.status).toBe(200)
    expect(rotated.data.refreshTokenExpiresAt).toBe(d.refreshTokenExpiresAt)
    expect((await request('/auth/refresh', 'POST', { deviceId: d.deviceId, refreshToken: d.refreshToken })).status).toBe(401)
    expect((await request('/devices', 'GET', undefined, rotated.data.accessToken)).status).toBe(401)
  })
  it('invalidates credentials when the configured password changes', async () => {
    const d = await device(); await app.close(); await start('a-different-password')
    expect((await request('/devices', 'GET', undefined, d.accessToken)).status).toBe(401)
    expect((await request('/auth/refresh', 'POST', { deviceId: d.deviceId, refreshToken: d.refreshToken })).status).toBe(401)
  })
})
describe('control authorization and encrypted relay', () => {
  it('rejects invalid Control messages at the WebSocket boundary', async () => {
    await runScenarios(['unsupported-version', 'binary-control', 'oversized-control', 'unknown-frame-type'].map(reason => ({
      name: reason,
      run: async () => {
        const wire = await socket(await device())
        await wire.next('hello.ack')
        const closed = once(wire.ws, 'close')
        const frame = {
          ...createControlFrame('ping', { nonce: reason === 'oversized-control' ? 'a'.repeat(MAX_CONTROL_FRAME_BYTES) : 'test' }),
          ...(reason === 'unsupported-version' ? { v: 2 } : {}),
          ...(reason === 'unknown-frame-type' ? { type: 'unknown' } : {}),
        }
        wire.ws.send(JSON.stringify(frame), { binary: reason === 'binary-control' })
        expect((await wire.next('error')).code).toBe(reason === 'unsupported-version' ? 'UNSUPPORTED_VERSION' : 'INVALID_MESSAGE')
        expect((await closed)[0]).toBe(4001)
      },
    })), async () => {
      await cleanupScenario2()
      await prepareScenario1()
    })
  })
  it('relays real Noise IK ciphertext and rejects replay', async () => {
    const ctx = await connection(), { initiator, responder } = await handshake(ctx)
    const ciphertext = toBase64Url(initiator.encrypt(new TextEncoder().encode('private prompt')))
    const payload = { connectionId: ctx.connectionId, targetDeviceId: ctx.h.deviceId, counter: 0, ciphertext }
    ctx.client.send('relay', payload)
    const received = await ctx.host.next('relay')
    expect(received.ciphertext).not.toContain('private prompt')
    expect(new TextDecoder().decode(responder.decrypt(fromBase64Url(received.ciphertext)))).toBe('private prompt')
    ctx.client.send('relay', payload)
    expect((await ctx.client.next('error')).code).toBe('INVALID_MESSAGE')
  })
  it('rejects unauthorized relay routes', async () => {
    const rows = ['wrong-target', 'third-device', 'unknown-connection', 'before-handshake'] as const
    await runScenarios(
      rows.map((row, index) => {
        const reason = row
        return {
          name: scenarioName('rejects unauthorized relay: %s', row, index),
          run: async () => {
            const ctx = await connection()
            if (reason !== 'before-handshake') await handshake(ctx)
            const attacker = reason === 'third-device' ? await socket(await device()) : ctx.client
            if (reason === 'third-device') await attacker.next('hello.ack')
            attacker.send('relay', {
              connectionId: reason === 'unknown-connection' ? randomUUID() : ctx.connectionId,
              targetDeviceId: reason === 'wrong-target' ? randomUUID() : ctx.h.deviceId,
              counter: 0,
              ciphertext: 'opaque',
            })
            expect((await attacker.next('error')).code).toBe(reason === 'before-handshake' ? 'INVALID_MESSAGE' : 'CONNECTION_NOT_FOUND')
            ctx.host.send('ping', { nonce: 'route-check' })
            await ctx.host.next('pong')
            expect(ctx.host.messages.filter((m) => m.type === 'relay')).toHaveLength(0)
          },
        }
      }),
      async () => {
        await cleanupScenario2()
        await prepareScenario1()
      },
    )
  })
  it('forwards relay ciphertext verbatim and tears down only that link on a replayed frame', async () => {
    const ctx = await connection(), { initiator, responder } = await handshake(ctx)
    const request = toBase64Url(initiator.encrypt(new TextEncoder().encode('synthetic request')))
    ctx.client.send('relay', { connectionId: ctx.connectionId, targetDeviceId: ctx.h.deviceId, counter: 0, ciphertext: request })
    const delivered = await ctx.host.next('relay')
    // The Server is a byte pipe: no re-encoding, padding or reordering.
    expect(delivered.ciphertext).toBe(request)
    expect(new TextDecoder().decode(responder.decrypt(fromBase64Url(delivered.ciphertext)))).toBe('synthetic request')

    const response = toBase64Url(responder.encrypt(new TextEncoder().encode('synthetic response')))
    ctx.host.send('relay', { connectionId: ctx.connectionId, targetDeviceId: ctx.c.deviceId, counter: 0, ciphertext: response })
    const returned = await ctx.client.next('relay')
    expect(returned.ciphertext).toBe(response)
    expect(new TextDecoder().decode(initiator.decrypt(fromBase64Url(returned.ciphertext)))).toBe('synthetic response')

    // A replayed counter tears down this link only: both parties are told, the
    // link stops routing, and the Host keeps its socket for other Clients.
    ctx.host.send('relay', { connectionId: ctx.connectionId, targetDeviceId: ctx.c.deviceId, counter: 0, ciphertext: response })
    expect(await ctx.host.next('error')).toMatchObject({ code: 'INVALID_MESSAGE', connectionId: ctx.connectionId })
    expect(await ctx.client.next('error')).toMatchObject({ code: 'INVALID_MESSAGE', connectionId: ctx.connectionId })
    const late = toBase64Url(initiator.encrypt(new TextEncoder().encode('after teardown')))
    ctx.client.send('relay', { connectionId: ctx.connectionId, targetDeviceId: ctx.h.deviceId, counter: 1, ciphertext: late })
    expect((await ctx.client.next('error')).code).toBe('CONNECTION_NOT_FOUND')
    ctx.host.send('ping', { nonce: 'host-still-online' })
    expect(await ctx.host.next('pong')).toEqual({ nonce: 'host-still-online' })
  })
  it('rejects a relayed initiator whose static identity or connection prologue differs from local trust', async () => {
    await runScenarios(['wrong-static-key', 'wrong-prologue'].map(reason => ({
      name: reason,
      run: async () => {
        const ctx = await connection()
        const prologue = createNoisePrologue(ctx.connectionId, ctx.h.deviceId, ctx.c.deviceId)
        const initiator = new NoiseIkSession({
          role: 'initiator', localPrivateKey: ctx.c.keys.privateKey, localPublicKey: ctx.c.identityKey,
          remotePublicKey: ctx.h.identityKey, prologue,
        })
        const responder = new NoiseIkSession({
          role: 'responder', localPrivateKey: ctx.h.keys.privateKey, localPublicKey: ctx.h.identityKey,
          remotePublicKey: reason === 'wrong-static-key' ? generateKeyPair().publicKey : ctx.c.identityKey,
          prologue: reason === 'wrong-prologue' ? createNoisePrologue(randomUUID(), ctx.h.deviceId, ctx.c.deviceId) : prologue,
        })
        noiseSessions.push(initiator, responder)
        ctx.client.send('secure.handshake', {
          connectionId: ctx.connectionId, targetDeviceId: ctx.h.deviceId, step: 1, data: toBase64Url(initiator.writeHandshake()),
        })
        const received = await ctx.host.next('secure.handshake')
        const read = () => responder.readHandshake(fromBase64Url(received.data))
        if (reason === 'wrong-static-key') expect(read).toThrow(/static key/)
        else expect(read).toThrow()
        expect(responder.complete).toBe(false)
        expect(() => responder.encrypt(new Uint8Array([1]))).toThrow()
        ctx.client.send('relay', {
          connectionId: ctx.connectionId, targetDeviceId: ctx.h.deviceId, counter: 0, ciphertext: 'AQIDBA',
        })
        expect((await ctx.client.next('error')).code).toBe('INVALID_MESSAGE')
        ctx.host.send('ping', { nonce: 'handshake-check' })
        await ctx.host.next('pong')
        expect(ctx.host.messages.filter(m => m.type === 'relay')).toHaveLength(0)
      },
    })), async () => {
      await cleanupScenario2()
      await prepareScenario1()
    })
  })
  it('rejects account tokens and mismatched device roles in hello', async () => {
    const d = await device()
    expect((await (await socket(d, { accessToken: accountToken })).next('error')).code).toBe('AUTH_INVALID')
    expect((await (await socket(d, { role: 'host' })).next('error')).code).toBe('AUTH_INVALID')
  })
  it('replaces a device socket without removing the new connection', async () => {
    const d = await device(), old = await socket(d); await old.next('hello.ack')
    const closed = once(old.ws, 'close'), current = await socket(d)
    await current.next('hello.ack'); expect((await closed)[0]).toBe(4003)
    current.send('ping', { nonce: 'new-socket' }); expect(await current.next('pong')).toEqual({ nonce: 'new-socket' })
  })
  it('keeps concurrent clients isolated and tears down revoked connections', async () => {
    const ctx = await connection(), second = await device(), wire = await socket(second); await wire.next('hello.ack')
    wire.send('connect.request', { hostDeviceId: ctx.h.deviceId, preferredTransports: ['relay'] })
    const incoming = await ctx.host.next('connect.incoming')
    ctx.host.send('connect.accepted', { connectionId: incoming.connectionId }); await wire.next('connect.accepted')
    expect(ctx.client.messages.filter(m => m.type === 'error')).toHaveLength(0)
    await handshake(ctx)
    const closed = once(wire.ws, 'close')
    expect((await request('/devices/self', 'DELETE', undefined, second.accessToken)).status).toBe(200)
    await closed
    expect(await ctx.host.next('error')).toMatchObject({ connectionId: incoming.connectionId })
    expect((await request('/devices', 'GET', undefined, second.accessToken)).status).toBe(401)
  })
})
describe('webrtc transport brokering', () => {
  it('forwards offer, answer, ICE and the transport selection between both parties', async () => {
    const ctx = await connection(['p2p', 'relay'])
    const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n'
    ctx.client.send('signal.offer', { connectionId: ctx.connectionId, targetDeviceId: ctx.h.deviceId, sdp })
    expect(await ctx.host.next('signal.offer')).toMatchObject({ targetDeviceId: ctx.h.deviceId, sdp })
    ctx.host.send('signal.answer', { connectionId: ctx.connectionId, targetDeviceId: ctx.c.deviceId, sdp: 'v=0\r\nanswer' })
    expect((await ctx.client.next('signal.answer')).sdp).toBe('v=0\r\nanswer')
    const candidate = { candidate: 'candidate:1 1 udp 2130706431 10.0.0.2 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 }
    ctx.host.send('signal.ice', { connectionId: ctx.connectionId, targetDeviceId: ctx.c.deviceId, candidate })
    expect((await ctx.client.next('signal.ice')).candidate.candidate).toContain('typ host')
    ctx.client.send('transport.selected', { connectionId: ctx.connectionId, targetDeviceId: ctx.h.deviceId, transport: 'p2p' })
    expect(await ctx.host.next('transport.selected')).toMatchObject({ targetDeviceId: ctx.h.deviceId, transport: 'p2p' })
    // The Noise control handshake is unaffected by the data plane choice.
    await handshake(ctx)
  })
  it('refuses signaling and selection outside the negotiated transports', async () => {
    await runScenarios(['unnegotiated-selection', 'relay-only-signaling'].map(reason => ({
      name: reason,
      run: async () => {
        const ctx = reason === 'relay-only-signaling' ? await connection() : await connection(['p2p', 'relay'])
        if (reason === 'unnegotiated-selection') {
          ctx.client.send('transport.selected', { connectionId: ctx.connectionId, targetDeviceId: ctx.h.deviceId, transport: 'turn' })
        } else {
          ctx.client.send('signal.offer', { connectionId: ctx.connectionId, targetDeviceId: ctx.h.deviceId, sdp: 'v=0' })
        }
        expect((await ctx.client.next('error')).code).toBe('CAPABILITY_NOT_SUPPORTED')
        expect(ctx.host.messages.filter(m => m.type === 'signal.offer' || m.type === 'transport.selected')).toHaveLength(0)
      },
    })), async () => {
      await cleanupScenario2()
      await prepareScenario1()
    })
  })
  it('forwards the Host data-path announcement without letting it break the link', async () => {
    const ctx = await connection(['p2p', 'relay'])
    // A Host that saw a LAN candidate pair reports 'lan' even when the Client did
    // not prefer it; the Client ignores announcements, so the link must survive.
    ctx.host.send('transport.selected', { connectionId: ctx.connectionId, targetDeviceId: ctx.c.deviceId, transport: 'lan' })
    ctx.host.send('transport.selected', { connectionId: ctx.connectionId, targetDeviceId: ctx.c.deviceId, transport: 'p2p' })
    expect(await ctx.client.next('transport.selected')).toMatchObject({ targetDeviceId: ctx.c.deviceId, transport: 'p2p' })
    await handshake(ctx)
  })
  it('rejects signaling from a device that is not a party to the connection', async () => {
    const ctx = await connection(['p2p', 'relay'])
    const attacker = await socket(await device()); await attacker.next('hello.ack')
    attacker.send('signal.offer', { connectionId: ctx.connectionId, targetDeviceId: ctx.h.deviceId, sdp: 'v=0' })
    expect((await attacker.next('error')).code).toBe('CONNECTION_NOT_FOUND')
    expect(ctx.host.messages.filter(m => m.type === 'signal.offer')).toHaveLength(0)
  })
  it('falls back to Relay-only negotiation when the deployment disables WebRTC', async () => {
    await app.close()
    await start(password, { webrtc: false })
    accountToken = (await request('/auth/login', 'POST', { email: account, password })).data.token
    const h = await device('host'), host = await socket(h)
    expect(await host.next('hello.ack')).toMatchObject({ capabilities: ['transport.relay'], webrtcEnabled: false })
    // A Client asking only for a direct transport is rejected outright.
    const direct = await socket(await device())
    expect(await direct.next('hello.ack')).toMatchObject({ capabilities: ['transport.relay'], webrtcEnabled: false })
    direct.send('connect.request', { hostDeviceId: h.deviceId, preferredTransports: ['p2p', 'turn'] })
    expect((await direct.next('error')).code).toBe('CAPABILITY_NOT_SUPPORTED')
    // Relay still negotiates, and signaling stays closed.
    const relay = await socket(await device())
    await relay.next('hello.ack')
    relay.send('connect.request', { hostDeviceId: h.deviceId, preferredTransports: ['relay'] })
    const incoming = await host.next('connect.incoming')
    expect(incoming.preferredTransports).toEqual(['relay'])
    host.send('connect.accepted', { connectionId: incoming.connectionId })
    const { connectionId } = await relay.next('connect.accepted')
    relay.send('signal.offer', { connectionId, targetDeviceId: h.deviceId, sdp: 'v=0' })
    expect((await relay.next('error')).code).toBe('CAPABILITY_NOT_SUPPORTED')
  })
  it('exposes live connections with their data path to the account only', async () => {
    const ctx = await connection(['p2p', 'relay'])
    expect((await request('/account/connections', 'GET')).status).toBe(401)
    expect((await request('/account/connections', 'GET', undefined, ctx.c.accessToken)).status).toBe(401)
    const find = async () => {
      const list = await request('/account/connections', 'GET', undefined, accountToken)
      return list.data.items.find((item: { connectionId: string }) => item.connectionId === ctx.connectionId)
    }
    const before = await find()
    expect(before).toMatchObject({ stage: 'accepted', client: { deviceId: ctx.c.deviceId, name: 'test-device' }, host: { deviceId: ctx.h.deviceId, name: 'test-device' } })
    expect(before.selectedTransport).toBeUndefined()
    ctx.client.send('transport.selected', { connectionId: ctx.connectionId, targetDeviceId: ctx.h.deviceId, transport: 'p2p' })
    await ctx.host.next('transport.selected')
    const selected = await find()
    expect(selected).toMatchObject({ selectedTransport: 'p2p', stage: 'accepted' })
    ctx.host.send('transport.selected', { connectionId: ctx.connectionId, targetDeviceId: ctx.c.deviceId, transport: 'lan' })
    await handshake(ctx)
    const ready = await find()
    expect(ready).toMatchObject({ selectedTransport: 'p2p', hostTransport: 'lan', stage: 'ready' })
    ctx.client.ws.terminate()
    const until = Date.now() + 3000
    while ((await find()) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50))
    expect(await find()).toBeUndefined()
  })
})
describe('ice credential endpoint', () => {
  it('issues credentials only to the two parties of a live connection', async () => {
    const ctx = await connection()
    const path = `/turn/credentials?connection_id=${ctx.connectionId}`
    expect((await request(path)).status).toBe(401)
    expect((await request(path, 'GET', undefined, ctx.h.accessToken)).status).toBe(200)
    const own = await request(path, 'GET', undefined, ctx.c.accessToken)
    expect(own.status).toBe(200)
    expect(own.data.iceServers).toEqual([{ urls: DEFAULT_STUN_URLS }])
    const outsider = await device()
    expect((await request(path, 'GET', undefined, outsider.accessToken)).status).toBe(404)
    expect((await request('/turn/credentials', 'GET', undefined, ctx.c.accessToken)).status).toBe(400)
    expect((await request(`/turn/credentials?connection_id=${randomUUID()}`, 'GET', undefined, ctx.c.accessToken)).status).toBe(404)
  })
  it('hands peers the fastest STUN endpoint this deployment can reach', async () => {
    const responder = createSocket('udp4')
    responder.on('message', (message, remote) => {
      const response = Buffer.from(message)
      response.writeUInt16BE(0x0101, 0)
      responder.send(response, remote.port, remote.address)
    })
    responder.bind(0, '127.0.0.1')
    await once(responder, 'listening')
    const silent = createSocket('udp4')
    silent.bind(0, '127.0.0.1')
    await once(silent, 'listening')
    const liveUrl = `stun:127.0.0.1:${(responder.address() as { port: number }).port}`
    const silentUrl = `stun:127.0.0.1:${(silent.address() as { port: number }).port}`
    try {
      await app.close()
      await start(password, { ice: { stunUrls: [silentUrl, liveUrl], probeStun: true } })
      accountToken = (await request('/auth/login', 'POST', { email: account, password })).data.token
      const ctx = await connection()
      const until = Date.now() + 6000
      let urls: string[] = []
      while (Date.now() < until) {
        const result = await request(`/turn/credentials?connection_id=${ctx.connectionId}`, 'GET', undefined, ctx.c.accessToken)
        urls = result.data.iceServers[0].urls
        if (urls[0] === liveUrl) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(urls).toEqual([liveUrl, silentUrl])
    } finally {
      responder.close()
      silent.close()
    }
  })
    it('serves TURN credentials with an expiry when a shared secret is configured', async () => {
      await app.close()
      await start(password, { ice: { turnUrls: ['turn:turn.example.com:3478?transport=udp'], turnSecret: 'turn-shared-secret', turnTtlSeconds: 600 } })
      accountToken = (await request('/auth/login', 'POST', { email: account, password })).data.token
    const ctx = await connection()
    const before = Math.floor(Date.now() / 1000)
    const result = await request(`/turn/credentials?connection_id=${ctx.connectionId}`, 'GET', undefined, ctx.c.accessToken)
    expect(result.status).toBe(200)
    const turn = result.data.iceServers.find((server: { urls: string[] }) => server.urls.some(url => url.startsWith('turn:')))
    expect(turn.urls).toEqual(['turn:turn.example.com:3478?transport=udp'])
    const [expiry, label] = String(turn.username).split(':')
    expect(Number(expiry)).toBeGreaterThanOrEqual(before + 600)
    expect(Number(expiry)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 600)
    expect(label).toBe(`${ctx.connectionId.slice(0, 8)}-${ctx.c.deviceId.slice(0, 8)}`)
    expect(turn.credential).toBe(createHmac('sha1', 'turn-shared-secret').update(turn.username).digest('base64'))
  })
})
describe('connection observability', () => {
  it('requires account authentication including for downloads and validates pagination', async () => {
    const d = await device()
    for (const path of ['/account/connection-history', '/account/connection-stats', '/account/diagnostics', '/account/diagnostics/export']) {
      expect((await request(path)).status).toBe(401)
      expect((await request(path, 'GET', undefined, d.accessToken)).status).toBe(401)
      expect((await request(path, 'GET', undefined, accountToken)).status).toBe(200)
    }
    for (const query of ['limit=0', 'limit=101', 'limit=-1', 'offset=-1', 'offset=1.5', 'limit=abc']) expect((await request(`/account/connection-history?${query}`, 'GET', undefined, accountToken)).status).toBe(400)
    expect((await request('/account/diagnostics?connectionId=missing', 'GET', undefined, accountToken)).status).toBe(404)
    const checks = (await request('/account/diagnostics', 'GET', undefined, accountToken)).data.checks
    expect(checks.find((c: any) => c.id === 'turn-reachability').status).toBe('unknown')
    expect(checks.find((c: any) => c.id === 'client-reachability').status).toBe('unknown')
  })
  it('records lifecycle and transport changes, counts only forwarded relay ciphertext, persists shutdown', async () => {
    const ctx = await connection(); const { initiator } = await handshake(ctx)
    ctx.client.send('transport.selected', { connectionId: ctx.connectionId, targetDeviceId: ctx.h.deviceId, transport: 'relay' })
    await ctx.host.next('transport.selected')
    const ciphertext = toBase64Url(initiator.encrypt(new TextEncoder().encode('SECRET-PAYLOAD')))
    ctx.client.send('relay', { connectionId: ctx.connectionId, targetDeviceId: ctx.h.deviceId, counter: 0, ciphertext })
    await ctx.host.next('relay')
    const result = await request('/account/connection-history?limit=1&offset=0', 'GET', undefined, accountToken)
    const r = result.data.items[0]
    expect(r).toMatchObject({ connectionId: ctx.connectionId, stage: 'ready', selectedTransport: 'relay', relayFrames: 1, relayBytes: Buffer.from(ciphertext, 'base64url').length })
    expect(r.events.filter((e: any) => e.type === 'stage').map((e: any) => e.stage)).toEqual(['pending', 'accepted', 'handshake', 'ready'])
    expect(r.handshakeDurationMs).toBeGreaterThanOrEqual(0)
    const exported = await request(`/account/diagnostics/export?connectionId=${ctx.connectionId}`, 'GET', undefined, accountToken)
    expect(exported.headers.get('content-disposition')).toContain('attachment')
    const text = JSON.stringify(exported.data)
    for (const secret of [ctx.connectionId, ctx.h.deviceId, ctx.c.deviceId, ctx.h.identityKey, ctx.h.accessToken, ctx.h.name, account, ciphertext, 'SECRET-PAYLOAD']) expect(text).not.toContain(secret)
    expect(exported.data.connections).toHaveLength(1)
    expect((await request('/account/connection-stats', 'GET', undefined, accountToken)).data.totals).toMatchObject({ ready: 1, relayFrames: 1 })
    await app.close(); await start(); accountToken = (await request('/auth/login', 'POST', { email: account, password })).data.token
    expect((await request('/account/connection-history', 'GET', undefined, accountToken)).data.items[0]).toMatchObject({ stage: 'closed', endReason: 'SERVER_SHUTDOWN', relayFrames: 1 })
  })
  it('records offline, capability failures and Host rejection without peer reason text', async () => {
    const h = await device('host'), c = await device(), client = await socket(c); await client.next('hello.ack')
    client.send('connect.request', { hostDeviceId: h.deviceId, preferredTransports: ['relay'] }); await client.next('error')
    const host = await socket(h); await host.next('hello.ack')
    client.send('connect.request', { hostDeviceId: h.deviceId, preferredTransports: ['turn'] }); await client.next('error')
    const c2 = await device(), client2 = await socket(c2); await client2.next('hello.ack')
    client2.send('connect.request', { hostDeviceId: h.deviceId, preferredTransports: ['relay'] })
    const incoming = await host.next('connect.incoming')
    host.send('connect.rejected', { connectionId: incoming.connectionId, reason: 'SECRET-REASON' }); await client2.next('connect.rejected')
    const records = (await request('/account/connection-history', 'GET', undefined, accountToken)).data.items
    expect(records.map((r: any) => r.endReason)).toEqual(['REJECTED', 'CAPABILITY_NOT_SUPPORTED', 'HOST_OFFLINE'])
    expect(JSON.stringify(records)).not.toContain('SECRET-REASON')
  })
})

describe('web ui routing', () => {
  it('serves the shell for every client route and keeps file and API paths strict', async () => {
    const web = join(dir, 'public')
    mkdirSync(join(web, 'assets'), { recursive: true })
    writeFileSync(join(web, 'index.html'), '<!doctype html><div id="root"></div>')
    writeFileSync(join(web, 'assets', 'app-abc123.js'), 'console.log(1)')
    writeFileSync(join(web, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await app.close()
    await start(password, { publicDir: web })

    // A reload on a Client route must return the shell. /app/remote is the one
    // that used to 404 because the Server kept a hard-coded page list.
    for (const path of ['/', '/app', '/app/login', '/app/remote', '/app/remote?device=abc', '/some/nested/route']) {
      const response = await page(path)
      expect(response.status, path).toBe(200)
      expect(response.type, path).toContain('text/html')
      expect(response.text, path).toContain('<div id="root">')
    }

    const script = await page('/assets/app-abc123.js')
    expect(script.status).toBe(200)
    expect(script.type).toContain('text/javascript')
    expect(script.text).toContain('console.log(1)')
    expect((await page('/icon.png')).type).toBe('image/png')

    // A missing bundle must 404 as JSON rather than returning the shell, or a
    // broken build would load HTML as a script and fail silently.
    const missing = await page('/assets/app-missing.js')
    expect(missing.status).toBe(404)
    expect(missing.type).toContain('application/json')

    // API paths are never shadowed by the shell, and health stays JSON.
    const unknown = await page('/api/v1/nope')
    expect(unknown.status).toBe(404)
    expect(unknown.type).toContain('application/json')
    expect((await page('/healthz')).text).toBe('{"status":"ok"}')
  })
})
