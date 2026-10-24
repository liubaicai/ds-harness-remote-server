import { createSocket } from 'node:dgram'
import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'

/**
 * Best-effort reachability probe for STUN endpoints.
 *
 * Why this exists: the built-in default is a fixed list, but "reachable" is a
 * property of the network the deployment runs in, not of the software. A stale
 * or blocked default silently degrades every connection to Relay, so at start
 * the Server measures what it can actually reach and puts those first.
 *
 * Ordering matters more than it looks: browsers fan out to every URL, but
 * werift — the fallback RTC backend on Hosts without native libwebrtc — uses
 * only the first STUN entry it sees.
 */

export interface StunProbeResult {
  url: string
  reachable: boolean
  rttMs?: number
}

export interface StunProbeOptions {
  timeoutMs?: number
  attempts?: number
}

const DEFAULT_TIMEOUT_MS = 1500
const DEFAULT_ATTEMPTS = 2
const MAGIC_COOKIE = 0x2112a442
const BINDING_REQUEST = 0x0001
const BINDING_SUCCESS = 0x0101

/** Split `stun:host:port` into host and port. IPv6 literals use brackets. */
export function parseStunEndpoint(url: string): { host: string; port: number } | undefined {
  const trimmed = url.trim()
  const scheme = /^stuns?:/i.exec(trimmed)
  if (scheme === null) return undefined
  const authority = trimmed.slice(scheme[0].length).split('?')[0]!.trim()
  if (authority.length === 0) return undefined
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority)
  if (bracketed !== null) {
    const port = bracketed[2] === undefined ? 3478 : Number(bracketed[2])
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? { host: bracketed[1]!, port } : undefined
  }
  const separator = authority.lastIndexOf(':')
  if (separator < 0) return { host: authority, port: 3478 }
  const host = authority.slice(0, separator)
  const port = Number(authority.slice(separator + 1))
  if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { host, port }
}

function bindingRequest(transaction: Buffer): Buffer {
  const packet = Buffer.alloc(20)
  packet.writeUInt16BE(BINDING_REQUEST, 0)
  packet.writeUInt16BE(0, 2)
  packet.writeUInt32BE(MAGIC_COOKIE, 4)
  transaction.copy(packet, 8)
  return packet
}

function isBindingSuccess(message: Buffer, transaction: Buffer): boolean {
  return message.length >= 20
    && message.readUInt16BE(0) === BINDING_SUCCESS
    && message.readUInt32BE(4) === MAGIC_COOKIE
    && message.subarray(8, 20).equals(transaction)
}

async function resolve(host: string): Promise<{ address: string; family: 4 | 6 } | undefined> {
  try {
    const ipv4 = await lookup(host, { family: 4 })
    return { address: ipv4.address, family: 4 }
  } catch {
    // Fall through to IPv6: some deployments resolve STUN names to AAAA only.
  }
  try {
    const ipv6 = await lookup(host, { family: 6 })
    return { address: ipv6.address, family: 6 }
  } catch {
    return undefined
  }
}

async function probeOne(url: string, timeoutMs: number, attempts: number): Promise<StunProbeResult> {
  const endpoint = parseStunEndpoint(url)
  // `stuns:` needs a TLS handshake a bare UDP probe cannot do, so it stays
  // unprobed rather than being reported as broken.
  if (endpoint === undefined || /^\s*stuns:/i.test(url)) return { url, reachable: false }
  const target = await resolve(endpoint.host)
  if (target === undefined) return { url, reachable: false }
  const socket = createSocket(target.family === 6 ? 'udp6' : 'udp4')
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const transaction = randomBytes(12)
      const rtt = await exchange(socket, bindingRequest(transaction), endpoint.port, target.address, transaction, timeoutMs)
      if (rtt !== undefined) return { url, reachable: true, rttMs: rtt }
    }
    return { url, reachable: false }
  } finally {
    socket.close()
  }
}

function exchange(
  socket: ReturnType<typeof createSocket>,
  packet: Buffer,
  port: number,
  address: string,
  transaction: Buffer,
  timeoutMs: number,
): Promise<number | undefined> {
  return new Promise(resolve => {
    let settled = false
    const finish = (value: number | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('error', onError)
      resolve(value)
    }
    const onMessage = (message: Buffer): void => {
      if (isBindingSuccess(message, transaction)) finish(Date.now() - started)
    }
    const onError = (): void => finish(undefined)
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    socket.on('message', onMessage)
    socket.on('error', onError)
    const started = Date.now()
    socket.send(packet, port, address, error => {
      if (error) finish(undefined)
    })
  })
}

/** Probe every endpoint concurrently. Never throws; failures read as unreachable. */
export async function probeStunServers(
  urls: readonly string[],
  options: StunProbeOptions = {},
): Promise<StunProbeResult[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS
  return Promise.all(urls.map(url => probeOne(url, timeoutMs, attempts)))
}

/**
 * Reachable endpoints first, fastest first. Unreachable and unprobed endpoints
 * keep their configured order at the end, so a fully failed probe leaves the
 * configuration untouched.
 */
export function orderStunUrls(urls: readonly string[], results: readonly StunProbeResult[]): string[] {
  const byUrl = new Map(results.map(result => [result.url, result]))
  return urls
    .map((url, index) => ({ url, index, rtt: byUrl.get(url)?.reachable === true ? byUrl.get(url)?.rttMs ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER }))
    .sort((left, right) => left.rtt - right.rtt || left.index - right.index)
    .map(entry => entry.url)
}

/** One-line summary for startup logs. */
export function describeStunProbe(results: readonly StunProbeResult[]): string {
  return results
    .map(result => `${result.url} ${result.reachable ? `${result.rttMs ?? '?'}ms` : 'unreachable'}`)
    .join(', ')
}
