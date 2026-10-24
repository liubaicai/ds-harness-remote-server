import { createHmac } from 'node:crypto'

/** Wire shape expected by every client's `/api/v1/turn/credentials` parser. */
export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

export interface IceConfig {
  /** STUN endpoints used to discover the public address for P2P hole punching. */
  stunUrls: string[]
  /** TURN endpoints used when hole punching fails. */
  turnUrls: string[]
  /** coturn `static-auth-secret`; enables short-lived HMAC credentials. */
  turnSecret?: string
  /** Static TURN credentials, used when no shared secret is configured. */
  turnUsername?: string
  turnPassword?: string
  /** Lifetime of generated TURN credentials. */
  turnTtlSeconds: number
  /**
   * Measure STUN reachability at startup and move the fastest endpoints to the
   * front. Off by default so embedding code never does surprise network I/O;
   * the `main.ts` entry point enables it.
   */
  probeStun?: boolean
}

/**
 * Built-in STUN endpoints, fastest-for-China first and a global anycast
 * fallback second. A single hard-coded default would be a silent single point
 * of failure: if it is blocked, every direct connection quietly degrades to
 * Relay. `DSH_SERVER_STUN_URLS` replaces this list entirely.
 */
export const DEFAULT_STUN_URLS = ['stun:stun.miwifi.com:3478', 'stun:stun.cloudflare.com:3478']
export const DEFAULT_TURN_TTL_SECONDS = 3600
const ICE_URL_SCHEMES = ['stun:', 'stuns:', 'turn:', 'turns:']

export function splitUrlList(value: string | undefined): string[] {
  return (value ?? '').split(',').map(item => item.trim()).filter(item => item.length > 0)
}

export function normalizeIceConfig(input: Partial<IceConfig> = {}): IceConfig {
  const stunUrls = validateUrls(input.stunUrls ?? DEFAULT_STUN_URLS, 'stun')
  const turnUrls = validateUrls(input.turnUrls ?? [], 'turn')
  if (turnUrls.length > 0 && input.turnSecret === undefined
    && !(input.turnUsername !== undefined && input.turnPassword !== undefined)) {
    throw new Error('TURN endpoints require DSH_SERVER_TURN_SECRET or DSH_SERVER_TURN_USERNAME/DSH_SERVER_TURN_PASSWORD.')
  }
  const ttl = input.turnTtlSeconds ?? DEFAULT_TURN_TTL_SECONDS
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 86_400) throw new Error('TURN credential TTL must be 60-86400 seconds.')
  return {
    stunUrls,
    turnUrls,
    ...(input.turnSecret === undefined ? {} : { turnSecret: input.turnSecret }),
    ...(input.turnUsername === undefined ? {} : { turnUsername: input.turnUsername }),
    ...(input.turnPassword === undefined ? {} : { turnPassword: input.turnPassword }),
    turnTtlSeconds: ttl,
    ...(input.probeStun === undefined ? {} : { probeStun: input.probeStun }),
  }
}

function validateUrls(urls: readonly string[], kind: 'stun' | 'turn'): string[] {
  for (const candidate of urls) {
    if (typeof candidate !== 'string' || !ICE_URL_SCHEMES.some(scheme => candidate.startsWith(scheme))) {
      throw new Error(`Invalid ICE server URL (expected ${ICE_URL_SCHEMES.join('/')}): ${String(candidate)}`)
    }
    if (kind === 'stun' && !/^stuns?:/.test(candidate)) throw new Error(`Invalid STUN URL: ${candidate}`)
    if (kind === 'turn' && !/^turns?:/.test(candidate)) throw new Error(`Invalid TURN URL: ${candidate}`)
  }
  return [...urls]
}

/**
 * Build the ICE server list handed to a peer for one connection.
 *
 * With a shared secret this implements the coturn REST convention
 * (draft-uberti-behave-turn-rest-00): `username` is `<expiry-unix>:<label>` and
 * `credential` is base64(HMAC-SHA1(secret, username)). Credentials therefore
 * expire on their own and never grant standing relay access.
 */
export function iceServersFor(config: IceConfig, label: string, now = Date.now()): IceServer[] {
  const servers: IceServer[] = []
  if (config.stunUrls.length > 0) servers.push({ urls: [...config.stunUrls] })
  if (config.turnUrls.length === 0) return servers
  if (config.turnSecret !== undefined) {
    const expiry = Math.floor(now / 1000) + config.turnTtlSeconds
    const username = `${expiry}:${label}`
    const credential = createHmac('sha1', config.turnSecret).update(username).digest('base64')
    servers.push({ urls: [...config.turnUrls], username, credential })
  } else if (config.turnUsername !== undefined && config.turnPassword !== undefined) {
    servers.push({ urls: [...config.turnUrls], username: config.turnUsername, credential: config.turnPassword })
  }
  return servers
}

/** True when the deployment can offer anything beyond direct candidates. */
export function hasRelayOrStunSupport(config: IceConfig): boolean {
  return config.stunUrls.length > 0 || config.turnUrls.length > 0
}

/**
 * Credential label. Must not contain ':' because coturn splits the username on
 * the first colon.
 */
export function credentialLabel(connectionId: string, deviceId: string): string {
  return `${connectionId.slice(0, 8)}-${deviceId.slice(0, 8)}`.replaceAll(':', '')
}
