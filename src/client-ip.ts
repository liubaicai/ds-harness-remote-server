import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'

type Address = { family: 4 | 6; value: bigint; text: string; mapped: boolean }
type Network = { family: 4 | 6; value: bigint; shift: bigint }

function parseAddress(input: string): Address | undefined {
  // Do not accept scoped literals, ports, brackets, hostnames or alternate IPv4 encodings.
  if (input.includes('%')) return undefined
  const family = isIP(input)
  if (family === 4) {
    const value = input.split('.').reduce((result, byte) => (result << 8n) | BigInt(byte), 0n)
    return { family: 4, value, text: input, mapped: false }
  }
  if (family !== 6) return undefined
  let expanded = input.toLowerCase()
  if (expanded.includes('.')) {
    const colon = expanded.lastIndexOf(':')
    const bytes = expanded.slice(colon + 1).split('.').map(Number)
    expanded = `${expanded.slice(0, colon)}:${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`
  }
  const [left, right] = expanded.split('::')
  const start = left ? left.split(':') : []
  const end = right ? right.split(':') : []
  const words = right === undefined ? start : [...start, ...Array<string>(8 - start.length - end.length).fill('0'), ...end]
  const value = words.reduce((result, word) => (result << 16n) | BigInt(`0x${word}`), 0n)
  if (value >> 32n === 0xffffn) {
    const v4 = value & 0xffffffffn
    const text = [24n, 16n, 8n, 0n].map(shift => Number((v4 >> shift) & 255n)).join('.')
    return { family: 4, value: v4, text, mapped: true }
  }
  // Canonicalize equivalent IPv6 spellings so they share one rate-limit identity.
  const hex = words.map(word => Number.parseInt(word, 16).toString(16))
  let bestStart = -1
  let bestLength = 1
  for (let i = 0; i < hex.length;) {
    if (hex[i] !== '0') { i++; continue }
    const begin = i
    while (hex[i] === '0') i++
    if (i - begin > bestLength) { bestStart = begin; bestLength = i - begin }
  }
  const text = bestStart < 0 ? hex.join(':') : `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`
  return { family: 6, value, text, mapped: false }
}

function parseNetwork(entry: string): Network {
  const parts = entry.trim().split('/')
  const address = parseAddress(parts[0] ?? '')
  const invalid = () => new Error(`Invalid trusted proxy IP/CIDR: ${entry}`)
  if (!address || parts.length > 2) throw invalid()
  const width = address.mapped || address.family === 6 ? 128 : 32
  const rawPrefix = parts[1]
  if (rawPrefix !== undefined && !/^(0|[1-9]\d*)$/.test(rawPrefix)) throw invalid()
  let prefix = rawPrefix === undefined ? width : Number(rawPrefix)
  if (prefix > width) throw invalid()
  if (address.mapped) {
    // Broader IPv6 networks must never accidentally become IPv4 trust-all rules.
    if (prefix < 96) throw invalid()
    prefix -= 96
  }
  const shift = BigInt((address.family === 4 ? 32 : 128) - prefix)
  return { family: address.family, value: address.value >> shift, shift }
}

/** Compile an explicit proxy allowlist once. No proxies are trusted by default. */
export function createClientIpResolver(trustedProxies: readonly string[] = []): (req: Pick<IncomingMessage, 'socket' | 'headers'>) => string {
  const networks = trustedProxies.map(parseNetwork)
  const trusted = (address: Address) => networks.some(network => network.family === address.family && address.value >> network.shift === network.value)
  return req => {
    const remote = parseAddress(req.socket.remoteAddress ?? '')
    if (!remote) return 'unknown'
    const forwarded = req.headers['x-forwarded-for']
    if (!trusted(remote) || typeof forwarded !== 'string' || !forwarded.trim()) return remote.text
    const chain = forwarded.split(',').map(value => parseAddress(value.trim()))
    // A malformed chain is unusable; never skip an invalid hop to reach attacker input.
    if (chain.some(address => !address)) return remote.text
    let client = remote
    for (let index = chain.length - 1; index >= 0 && trusted(client); index--) client = chain[index]!
    return client.text
  }
}
