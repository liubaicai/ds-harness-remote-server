import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { Gateway, MAX_AUTHENTICATED_PEERS, SERVER_VERSION, UnauthenticatedAdmission } from '../src/gateway.js'
import { ApiError, type Store } from '../src/store.js'
import {
  createControlFrame, decodeControlFrame, encodeControlFrame,
  MAX_CONTROL_FRAME_BYTES, MAX_RELAY_FRAME_BYTES, type ControlFrame,
} from '../src/protocol/index.js'

const hello = { role: 'client', deviceId: 'client', accessToken: 'token', protocols: [1], capabilities: ['transport.relay'] }

describe('control schema hardening', () => {
  it.each(['clientVersion', 'harnessVersion'])('bounds hello %s in UTF-8 bytes, not code units', field => {
    for (const value of ['a'.repeat(64), '界'.repeat(21) + 'a']) {
      expect(() => encodeControlFrame(createControlFrame('hello', { ...hello, [field]: value }))).not.toThrow()
    }
    for (const value of ['', 'a'.repeat(65), '界'.repeat(22), '😀'.repeat(17)]) {
      const frame = createControlFrame('hello', { ...hello, [field]: value })
      expect(() => encodeControlFrame(frame)).toThrow()
      expect(() => decodeControlFrame(JSON.stringify(frame))).toThrow()
    }
    expect(() => encodeControlFrame(createControlFrame('hello', hello))).not.toThrow()
  })

  it.each(['connect.request', 'connect.incoming'] as const)('%s requires one to four distinct transports', type => {
    const base = type === 'connect.request' ? { hostDeviceId: 'host' } : {
      connectionId: 'link', clientDeviceId: 'client', clientIdentityKey: 'key', authorization: 'account',
    }
    for (const preferredTransports of [[], ['relay', 'relay'], ['lan', 'p2p', 'turn', 'relay', 'lan']]) {
      expect(() => encodeControlFrame(createControlFrame(type, { ...base, preferredTransports }))).toThrow()
    }
    for (const preferredTransports of [['relay'], ['lan', 'p2p', 'turn', 'relay']]) {
      expect(() => encodeControlFrame(createControlFrame(type, { ...base, preferredTransports }))).not.toThrow()
    }
  })
})

describe('bounded unauthenticated admission', () => {
  it('enforces separate per-address and global pending quotas and idempotent release', () => {
    const admission = new UnauthenticatedAdmission(() => 0)
    const releases: Array<(authenticated?: boolean) => void> = []
    for (let address = 0; address < 4; address++) {
      for (let i = 0; i < 8; i++) releases.push(admission.acquire(`address-${address}`)!)
      expect(admission.acquire(`address-${address}`)).toBeUndefined()
    }
    expect(releases.every(Boolean)).toBe(true)
    expect(admission.acquire('another-address')).toBeUndefined()
    releases[0]!(); releases[0]!()
    expect(admission.acquire('another-address')).toBeTypeOf('function')
    expect(admission.acquire('yet-another-address')).toBeUndefined()
  })

  it('limits repeated failed upgrades per address and globally, then resets the time window', () => {
    let now = 0
    const admission = new UnauthenticatedAdmission(() => now)
    for (let address = 0; address < 4; address++) {
      for (let i = 0; i < 32; i++) {
        const release = admission.acquire(`address-${address}`)
        expect(release).toBeTypeOf('function')
        release!()
      }
      expect(admission.acquire(`address-${address}`)).toBeUndefined()
    }
    expect(admission.acquire('fresh-address')).toBeUndefined()
    now = 10_000
    expect(admission.acquire('address-0')).toBeTypeOf('function')
    expect(admission.acquire('fresh-address')).toBeTypeOf('function')
  })

  it('does not penalize hundreds of successfully authenticated devices behind one proxy', () => {
    const admission = new UnauthenticatedAdmission(() => 0)
    for (let i = 0; i < 1000; i++) {
      const release = admission.acquire('proxy')
      expect(release).toBeTypeOf('function')
      release!(true); release!(true)
    }
    const leases = Array.from({ length: 8 }, () => admission.acquire('proxy'))
    expect(leases.every(Boolean)).toBe(true)
    expect(admission.acquire('proxy')).toBeUndefined()
  })

  it('keeps pending leases across rate windows without refunding the wrong window', () => {
    let now = 0
    const admission = new UnauthenticatedAdmission(() => now)
    const old = admission.acquire('proxy')!
    now = 10_000
    for (let i = 0; i < 32; i++) admission.acquire('proxy')!()
    old(true)
    expect(admission.acquire('proxy')).toBeUndefined()
  })
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.useRealTimers()
})

class Wire {
  private readonly queued: ControlFrame[] = []
  private readonly waiting: Array<(frame: ControlFrame) => void> = []
  constructor(readonly ws: WebSocket) {
    ws.on('message', raw => {
      const frame = decodeControlFrame(raw.toString())
      const waiter = this.waiting.shift()
      if (waiter) waiter(frame)
      else this.queued.push(frame)
    })
  }
  send(type: ControlFrame['type'], payload: unknown): void {
    this.ws.send(JSON.stringify(createControlFrame(type, payload)))
  }
  async next(type: ControlFrame['type']): Promise<any> {
    const queued = this.queued.shift()
    const frame = queued ?? await new Promise<ControlFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Missing ${type}`)), 3000)
      this.waiting.push(value => { clearTimeout(timer); resolve(value) })
    })
    expect(frame.type).toBe(type)
    return frame.payload
  }
}

async function fixture() {
  const server: Server = createServer()
  const devices = new Map<string, { descriptor: { deviceId: string; role: 'client' | 'host'; clientVersion: string; identityKey: string } }>()
  const store = {
    authenticate: (token: string) => { const device = devices.get(token); if (!device) throw new ApiError('AUTH_INVALID'); return device },
    get: (id: string) => { const device = devices.get(id); if (!device) throw new ApiError('DEVICE_NOT_FOUND'); return device },
    touch: vi.fn(),
  }
  const gateway = new Gateway(server, store as unknown as Store, 'http://localhost', { webrtc: true })
  const sockets: WebSocket[] = []
  cleanups.push(async () => {
    for (const ws of sockets) ws.terminate()
    gateway.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/v1/connect`
  const open = async () => {
    const ws = new WebSocket(url); sockets.push(ws)
    const wire = new Wire(ws)
    await once(ws, 'open')
    return wire
  }
  const login = async (id: string, role: 'host' | 'client' = 'client', capabilities = ['transport.relay', 'transport.p2p']) => {
    devices.set(id, { descriptor: { deviceId: id, role, clientVersion: '0.5.19', identityKey: 'key' } })
    const wire = await open()
    wire.send('hello', { ...hello, role, deviceId: id, accessToken: id, capabilities })
    return wire
  }
  return { gateway, store, sockets, url, open, login }
}

describe('isolated Gateway wire behavior', () => {
  it('preserves all 256 authenticated slots with idle unauthenticated sockets and permits replacement', async () => {
    const { gateway, open, login } = await fixture()
    const idle = await Promise.all(Array.from({ length: 7 }, () => open()))
    expect(gateway.peers.size).toBe(0)
    for (let i = 0; i < MAX_AUTHENTICATED_PEERS; i++) {
      const wire = await login(`client-${i}`)
      expect(await wire.next('hello.ack')).toMatchObject({ serverVersion: SERVER_VERSION })
    }
    expect(SERVER_VERSION).toBe('0.5.19')
    expect(gateway.peers.size).toBe(256)
    expect(idle.every(wire => wire.ws.readyState === WebSocket.OPEN)).toBe(true)
    const excess = await login('excess')
    const excessClosed = once(excess.ws, 'close')
    expect(await excess.next('error')).toMatchObject({ code: 'RATE_LIMITED' })
    await excessClosed
    const replacement = await login('client-0')
    await replacement.next('hello.ack')
    expect(gateway.peers.size).toBe(256)
  }, 15_000)

  it('rejects the ninth idle socket before upgrade and releases slots on close', async () => {
    const { open, url, sockets, gateway } = await fixture()
    const idle = await Promise.all(Array.from({ length: 8 }, () => open()))
    const rejected = new WebSocket(url); sockets.push(rejected)
    const status = await new Promise<number | undefined>(resolve => {
      rejected.on('error', () => {})
      rejected.on('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode); rejected.terminate() })
    })
    expect(status).toBe(429)
    expect(gateway.peers.size).toBe(0)
    const closed = once(idle[0]!.ws, 'close')
    idle[0]!.ws.close(); await closed
    expect((await open()).ws.readyState).toBe(WebSocket.OPEN)
  })

  it('rejects oversized hello versions before touching persistence', async () => {
    const { open, store } = await fixture()
    const wire = await open()
    wire.send('hello', { ...hello, clientVersion: '界'.repeat(22) })
    expect(await wire.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' })
    expect(store.touch).not.toHaveBeenCalled()
  })

  it.each([false, true])('requires negotiated relay even after handshake (relay offered: %s)', async relay => {
    const { gateway, login } = await fixture()
    const host = await login('host', 'host'), client = await login('client')
    await host.next('hello.ack'); await client.next('hello.ack')
    client.send('connect.request', { hostDeviceId: 'host', preferredTransports: relay ? ['p2p', 'relay'] : ['p2p'] })
    const { connectionId } = await host.next('connect.incoming')
    host.send('connect.accepted', { connectionId }); await client.next('connect.accepted')
    client.send('secure.handshake', { connectionId, targetDeviceId: 'host', step: 1, data: 'one' }); await host.next('secure.handshake')
    host.send('secure.handshake', { connectionId, targetDeviceId: 'client', step: 2, data: 'two' }); await client.next('secure.handshake')
    client.send('relay', { connectionId, targetDeviceId: 'host', counter: 0, ciphertext: 'opaque' })
    if (relay) expect(await host.next('relay')).toMatchObject({ ciphertext: 'opaque' })
    else {
      expect(await client.next('error')).toMatchObject({ code: 'CAPABILITY_NOT_SUPPORTED', connectionId })
      expect(await host.next('error')).toMatchObject({ code: 'CAPABILITY_NOT_SUPPORTED', connectionId })
      expect(gateway.ownsLink(connectionId, 'client')).toBe(false)
      client.send('ping', { nonce: 'still-alive' })
      expect(await client.next('pong')).toEqual({ nonce: 'still-alive' })
    }
  })
})

// Focused send/timer tests avoid coupling to Store persistence or server routes.
describe('outbound validation and heartbeat safety', () => {
  function fakePeer(gateway: Gateway, failure?: 'throw' | 'callback') {
    const ws = {
      readyState: WebSocket.OPEN, bufferedAmount: 0,
      send: vi.fn((_encoded: string, callback: (error?: Error) => void) => {
        if (failure === 'throw') throw new Error('socket failure')
        if (failure === 'callback') callback(new Error('async socket failure'))
      }),
      close: vi.fn(), terminate: vi.fn(),
    }
    const peer = { ws: ws as unknown as WebSocket, id: 'fake', role: 'client' as const, capabilities: [], version: '0.5.19', lastPong: Date.now() }
    gateway.peers.set(peer.id, peer)
    return { peer, ws }
  }
  function gateway() {
    const result = new Gateway(createServer(), {} as Store, 'http://localhost')
    cleanups.push(() => result.close())
    return result
  }
  it('rejects oversized control/relay and invalid payloads without writing bytes or throwing', () => {
    const instance = gateway()
    const send = (instance as unknown as { send(peer: unknown, frame: ControlFrame): void }).send.bind(instance)
    for (const frame of [
      createControlFrame('ping', { nonce: 'a'.repeat(MAX_CONTROL_FRAME_BYTES) }),
      createControlFrame('relay', { connectionId: 'x', targetDeviceId: 'y', counter: 0, ciphertext: 'a'.repeat(MAX_RELAY_FRAME_BYTES) }),
      createControlFrame('pong', { nonce: '' }),
    ]) {
      const { peer, ws } = fakePeer(instance)
      expect(() => send(peer, frame)).not.toThrow()
      expect(ws.send).not.toHaveBeenCalled()
      expect(instance.peers.has(peer.id)).toBe(false)
    }
    const { peer, ws } = fakePeer(instance)
    send(peer, createControlFrame('ping', { nonce: 'valid' }))
    expect(decodeControlFrame(ws.send.mock.calls[0]![0])).toMatchObject({ type: 'ping', payload: { nonce: 'valid' } })
  })
  it.each(['throw', 'callback'] as const)('contains %s socket failure during heartbeat', failure => {
    vi.useFakeTimers()
    const instance = gateway()
    const { ws } = fakePeer(instance, failure)
    expect(() => vi.advanceTimersByTime(25_000)).not.toThrow()
    expect(ws.send).toHaveBeenCalledOnce()
    expect(instance.peers.size).toBe(0)
  })
})
