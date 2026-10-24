import { describe, expect, it } from 'vitest'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { orderStunUrls, parseStunEndpoint, probeStunServers } from '../src/stun-probe.js'

/** Minimal STUN responder: echoes the request back as a Binding Success. */
async function fakeStunServer(reply: boolean) {
  const socket = createSocket('udp4')
  socket.on('message', (message, remote) => {
    if (!reply) return
    const response = Buffer.from(message)
    response.writeUInt16BE(0x0101, 0)
    socket.send(response, remote.port, remote.address)
  })
  socket.bind(0, '127.0.0.1')
  await once(socket, 'listening')
  const { port } = socket.address() as { port: number }
  return { port, close: () => socket.close() }
}

describe('stun endpoint parsing', () => {
  it('accepts the forms coturn and browsers emit', () => {
    expect(parseStunEndpoint('stun:stun.example.com:3478')).toEqual({ host: 'stun.example.com', port: 3478 })
    expect(parseStunEndpoint('stun:stun.example.com')).toEqual({ host: 'stun.example.com', port: 3478 })
    expect(parseStunEndpoint('stun:stun.example.com:3478?transport=udp')).toEqual({ host: 'stun.example.com', port: 3478 })
    expect(parseStunEndpoint('stun:[2001:db8::1]:3479')).toEqual({ host: '2001:db8::1', port: 3479 })
  })
  it('rejects anything that is not a STUN URL', () => {
    expect(parseStunEndpoint('turn:turn.example.com:3478')).toBeUndefined()
    expect(parseStunEndpoint('stun:')).toBeUndefined()
    expect(parseStunEndpoint('stun:host:0')).toBeUndefined()
    expect(parseStunEndpoint('stun:host:99999')).toBeUndefined()
  })
})

describe('stun reachability ordering', () => {
  it('moves reachable endpoints ahead of unreachable ones, fastest first', () => {
    const urls = ['stun:a:3478', 'stun:b:3478', 'stun:c:3478']
    const ordered = orderStunUrls(urls, [
      { url: 'stun:a:3478', reachable: false },
      { url: 'stun:b:3478', reachable: true, rttMs: 220 },
      { url: 'stun:c:3478', reachable: true, rttMs: 25 },
    ])
    expect(ordered).toEqual(['stun:c:3478', 'stun:b:3478', 'stun:a:3478'])
  })
  it('leaves the configured order untouched when nothing responds', () => {
    const urls = ['stun:a:3478', 'stun:b:3478']
    const ordered = orderStunUrls(urls, urls.map(url => ({ url, reachable: false })))
    expect(ordered).toEqual(urls)
  })
})

describe('stun probing', () => {
  it('reports a responding endpoint as reachable and a silent one as not', async () => {
    const live = await fakeStunServer(true)
    const silent = await fakeStunServer(false)
    const urls = [`stun:127.0.0.1:${silent.port}`, `stun:127.0.0.1:${live.port}`]
    try {
      const results = await probeStunServers(urls, { timeoutMs: 400, attempts: 1 })
      expect(results[0]).toMatchObject({ url: urls[0], reachable: false })
      expect(results[1]).toMatchObject({ url: urls[1], reachable: true })
      expect(results[1]!.rttMs).toBeGreaterThanOrEqual(0)
      expect(orderStunUrls(urls, results)[0]).toBe(`stun:127.0.0.1:${live.port}`)
    } finally {
      live.close()
      silent.close()
    }
  })
  it('does not probe TLS endpoints, which a plain UDP exchange cannot verify', async () => {
    const [result] = await probeStunServers(['stuns:stun.example.com:5349'], { timeoutMs: 100, attempts: 1 })
    expect(result).toEqual({ url: 'stuns:stun.example.com:5349', reachable: false })
  })
})
