/**
 * Browser device identity for the Remote channel.
 *
 * A web session is an ordinary `client` device: one X25519 key pair and a
 * device registration issued against the account cookie. Tokens rotate
 * through the standard `/api/v1/auth/refresh` endpoint.
 */
import { generateKeyPair } from './crypto'

const STORAGE_KEY = 'dsh.web.identity.v1'
export const WEB_CLIENT_VERSION = 'web-0.5.19'

export interface DeviceIdentity {
  deviceId: string
  name: string
  privateKey: string
  publicKey: string
  accessToken: string
  accessTokenExpiresAt: number
  refreshToken: string
  refreshTokenExpiresAt: number
}

interface TokenPair {
  accessToken: string
  accessTokenExpiresAt: number
  refreshToken: string
  refreshTokenExpiresAt: number
}

async function api<T>(path: string, body?: unknown, method?: 'GET' | 'POST' | 'DELETE'): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  })
  const data = await response.json() as { error?: { code?: string } }
  if (!response.ok) {
    const error = new Error(data.error?.code ?? `HTTP ${response.status}`) as Error & { code?: string }
    error.code = data.error?.code ?? 'REQUEST_FAILED'
    throw error
  }
  return data as T
}

function load(): DeviceIdentity | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    const value = JSON.parse(raw) as DeviceIdentity
    if (!value.deviceId || !value.privateKey || !value.publicKey) return undefined
    return value
  } catch {
    return undefined
  }
}

function save(identity: DeviceIdentity): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity))
}

/** Reset a broken or revoked local identity so the next call registers fresh. */
export function clearIdentity(): void {
  localStorage.removeItem(STORAGE_KEY)
}

function defaultName(): string {
  const ua = navigator.userAgent
  const platform = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Mac/i.test(ua) ? 'macOS' : /Win/i.test(ua) ? 'Windows' : /Linux/i.test(ua) ? 'Linux' : 'Web'
  return `Web ${platform}`
}

/**
 * Return a usable device identity, registering a new browser device with the
 * account session on first use and rotating tokens when the access token is
 * near expiry. Registration is idempotent for an unchanged identity.
 */
export async function ensureIdentity(forceNew = false): Promise<DeviceIdentity> {
  if (forceNew) clearIdentity()
  let identity = load()
  if (identity === undefined) {
    const keys = generateKeyPair()
    const candidate: DeviceIdentity = {
      deviceId: crypto.randomUUID(),
      name: defaultName(),
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      accessToken: '', accessTokenExpiresAt: 0, refreshToken: '', refreshTokenExpiresAt: 0,
    }
    const tokens = await api<TokenPair>('/devices/register', {
      v: 1,
      device: {
        deviceId: candidate.deviceId,
        name: candidate.name,
        role: 'client',
        platform: 'browser',
        identityKey: candidate.publicKey,
        clientVersion: WEB_CLIENT_VERSION,
      },
    })
    save({ ...candidate, ...tokens })
    return { ...candidate, ...tokens }
  }
  // Refresh when the access token expires within ten minutes.
  if (identity.accessTokenExpiresAt - Date.now() < 10 * 60_000) {
    try {
      const tokens = await api<TokenPair>('/auth/refresh', { deviceId: identity.deviceId, refreshToken: identity.refreshToken })
      identity = { ...identity, ...tokens }
      save(identity)
    } catch (error) {
      // A used/expired refresh token invalidates the device credentials; the
      // stale identity is dropped so the caller can re-register cleanly.
      const code = (error as { code?: string }).code
      if (code === 'AUTH_INVALID' || code === 'TOKEN_EXPIRED' || code === 'DEVICE_REVOKED' || code === 'DEVICE_NOT_FOUND') {
        clearIdentity()
        return ensureIdentity()
      }
      throw error
    }
  }
  return identity
}
