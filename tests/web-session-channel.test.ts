/**
 * End-to-end check of the Web session channel choreography: the exact control
 * frames the browser client emits (hello → connect.request → accepted →
 * transport.selected → Noise IK handshake → relayed `agent.acp.*` RPC) run
 * against a real Gateway with a scripted Host peer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { createControlFrame, createRpcRequest, createRpcResponse, createEvent, decodeMessage, encodeMessage } from '../src/protocol/index.js'
import { NoiseIkSession, createNoisePrologue, generateKeyPair, toBase64Url, fromBase64Url } from './support/crypto/index.js'
import { createRemoteServer } from '../src/server.js'

const account = 'owner@example.com', password = 'local-test-password'
let app: ReturnType<typeof createRemoteServer>, dir: string, base: string, accountToken: string
const sockets: WebSocket[] = []
const noiseSessions: NoiseIkSession[] = []

async function request(path: string, method = 'GET', body?: unknown, token?: string, cookie?: string) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, data: await response.json() }
}

class Wire {
  messages: any[] = []
  waiters: (() => void)[] = []
  constructor(readonly ws: WebSocket) {
    ws.on('message', raw => { this.messages.push(JSON.parse(raw.toString())); for (const notify of this.waiters.splice(0)) notify() })
  }
  send(type: Parameters<typeof createControlFrame>[0], payload: unknown) {
    this.ws.send(JSON.stringify(createControlFrame(type, payload)))
  }
  async next(type: string, timeout = 4000): Promise<any> {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      const idx = this.messages.findIndex(m => m.type === type)
      if (idx >= 0) return this.messages.splice(idx, 1)[0].payload
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 25); this.waiters.push(() => { clearTimeout(timer); resolve() }) })
    }
    throw new Error(`Missing frame ${type}`)
  }
}

async function device(role: 'host' | 'client', platform: string, token = accountToken) {
  const keys = generateKeyPair()
  const descriptor = {
    deviceId: randomUUID(),
    identityKey: keys.publicKey,
    name: 'test-device',
    role,
    platform,
    clientVersion: platform === 'browser' ? 'web-0.5.19' : '0.4.15',
  }
  const result = await request('/devices/register', 'POST', { v: 1, device: descriptor }, token)
  expect(result.status).toBe(200)
  return { ...descriptor, keys, ...result.data }
}

async function socket(d: Awaited<ReturnType<typeof device>>) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws/v1/connect')
  sockets.push(ws)
  const wire = new Wire(ws)
  await once(ws, 'open')
  wire.send('hello', {
    role: d.role,
    deviceId: d.deviceId,
    accessToken: d.accessToken,
    protocols: [1],
    capabilities: ['transport.relay'],
    clientVersion: d.clientVersion,
  })
  return wire
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-web-session-'))
  app = createRemoteServer({ account, password, dataFile: join(dir, 'state.json'), publicUrl: 'http://localhost:8080', webrtc: false })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  const { port } = app.server.address() as { port: number }
  base = `http://127.0.0.1:${port}`
  accountToken = (await request('/auth/login', 'POST', { email: account, password })).data.token
})

afterEach(async () => {
  for (const noise of noiseSessions.splice(0)) noise.destroy()
  for (const ws of sockets.splice(0)) ws.terminate()
  await app.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('web session channel', () => {
  it('registers a browser device from the account session and completes the encrypted ACP round trip', async () => {
    // 1. Browser device registration is accepted with platform "browser".
    const host = await device('host', 'linux')
    const browser = await device('client', 'browser', accountToken)
    expect(browser.platform).toBe('browser')

    // 2. Control channel: hello → connect.request (relay-only) → accepted.
    const hostWire = await socket(host)
    const clientWire = await socket(browser)
    await hostWire.next('hello.ack')
    await clientWire.next('hello.ack')
    clientWire.send('connect.request', { hostDeviceId: host.deviceId, preferredTransports: ['relay'] })
    const incoming = await hostWire.next('connect.incoming')
    expect(incoming.clientDeviceId).toBe(browser.deviceId)
    expect(incoming.preferredTransports).toEqual(['relay'])
    hostWire.send('connect.accepted', { connectionId: incoming.connectionId })
    const { connectionId } = await clientWire.next('connect.accepted')

    // 3. The browser announces the relay data plane (as RelayLink does).
    clientWire.send('transport.selected', { connectionId, targetDeviceId: host.deviceId, transport: 'relay' })
    expect((await hostWire.next('transport.selected')).transport).toBe('relay')

    // 4. Noise IK handshake, client as initiator with the shared prologue.
    const prologue = createNoisePrologue(connectionId, host.deviceId, browser.deviceId)
    const initiator = new NoiseIkSession({
      role: 'initiator',
      localPrivateKey: browser.keys.privateKey,
      localPublicKey: browser.identityKey,
      remotePublicKey: host.identityKey,
      prologue,
    })
    const responder = new NoiseIkSession({
      role: 'responder',
      localPrivateKey: host.keys.privateKey,
      localPublicKey: host.identityKey,
      remotePublicKey: browser.identityKey,
      prologue,
    })
    noiseSessions.push(initiator, responder)
    clientWire.send('secure.handshake', { connectionId, targetDeviceId: host.deviceId, step: 1, data: toBase64Url(initiator.writeHandshake()) })
    responder.readHandshake(fromBase64Url((await hostWire.next('secure.handshake')).data))
    hostWire.send('secure.handshake', { connectionId, targetDeviceId: browser.deviceId, step: 2, data: toBase64Url(responder.writeHandshake()) })
    initiator.readHandshake(fromBase64Url((await clientWire.next('secure.handshake')).data))
    expect(initiator.complete).toBe(true)

    // 5. Encrypted `agent.acp.call` (initialize) relays end to end.
    const requestMessage = createRpcRequest('agent.acp.call', { method: 'initialize', params: { protocolVersion: 1 } }, 'req-initialize')
    clientWire.send('relay', {
      connectionId,
      targetDeviceId: host.deviceId,
      counter: 0,
      ciphertext: toBase64Url(initiator.encrypt(encodeMessage(requestMessage))),
    })
    const relayed = await hostWire.next('relay')
    const inbound = decodeMessage(responder.decrypt(fromBase64Url(relayed.ciphertext)))
    expect(inbound.type).toBe('rpc.request')
    expect((inbound.payload as { method: string }).method).toBe('agent.acp.call')

    // 6. Host answers and streams one session/update event back through relay.
    const response = createRpcResponse('req-initialize', {
      protocolVersion: 1,
      capability: 'agent.acp.v1',
      backend: 'cursor',
      capabilities: ['agent.acp.v1'],
      availableBackends: ['cursor'],
    })
    hostWire.send('relay', {
      connectionId,
      targetDeviceId: browser.deviceId,
      counter: 0,
      ciphertext: toBase64Url(responder.encrypt(encodeMessage(response))),
    })
    const reply = decodeMessage(initiator.decrypt(fromBase64Url((await clientWire.next('relay')).ciphertext)))
    expect(reply.type).toBe('rpc.response')
    expect((reply.payload as { result: { availableBackends: string[] } }).result.availableBackends).toEqual(['cursor'])

    const event = createEvent('agent.acp.frame', {
      streamId: 'session:demo',
      frame: {
        method: 'session/update',
        params: { sessionId: 'demo', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } }, seq: 1 },
      },
    })
    hostWire.send('relay', {
      connectionId,
      targetDeviceId: browser.deviceId,
      counter: 1,
      ciphertext: toBase64Url(responder.encrypt(encodeMessage(event))),
    })
    const eventMessage = decodeMessage(initiator.decrypt(fromBase64Url((await clientWire.next('relay')).ciphertext)))
    expect(eventMessage.type).toBe('event')
    expect((eventMessage.payload as { event: string }).event).toBe('agent.acp.frame')
  })
})
