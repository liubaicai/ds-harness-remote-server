import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { DEFAULT_STUN_URLS, credentialLabel, iceServersFor, normalizeIceConfig } from '../src/ice.js'

describe('ice configuration', () => {
  it('defaults to STUN only, so P2P hole punching works without a TURN server', () => {
    const config = normalizeIceConfig()
    expect(config.stunUrls).toEqual(DEFAULT_STUN_URLS)
    expect(config.turnUrls).toEqual([])
    expect(iceServersFor(config, 'label')).toEqual([{ urls: DEFAULT_STUN_URLS }])
  })
  it('can disable STUN entirely for LAN-only or air-gapped deployments', () => {
    const config = normalizeIceConfig({ stunUrls: [] })
    expect(iceServersFor(config, 'label')).toEqual([])
  })
  it('mints expiring coturn REST credentials from a shared secret', () => {
    const config = normalizeIceConfig({
      turnUrls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349?transport=tcp'],
      turnSecret: 'turn-shared-secret',
      turnTtlSeconds: 600,
    })
    const now = 1_700_000_000_000
    const servers = iceServersFor(config, 'conn-device', now)
    expect(servers).toHaveLength(2)
    const turn = servers[1]!
    const expiry = Math.floor(now / 1000) + 600
    expect(turn.username).toBe(`${expiry}:conn-device`)
    expect(turn.credential).toBe(createHmac('sha1', 'turn-shared-secret').update(`${expiry}:conn-device`).digest('base64'))
    expect(turn.urls).toEqual(['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349?transport=tcp'])
  })
  it('supports static credentials as an alternative to a shared secret', () => {
    const config = normalizeIceConfig({ turnUrls: ['turn:turn.example.com:3478'], turnUsername: 'user', turnPassword: 'pass' })
    expect(iceServersFor(config, 'label')[1]).toEqual({
      urls: ['turn:turn.example.com:3478'], username: 'user', credential: 'pass',
    })
  })
  it('rejects unusable configuration at startup', () => {
    expect(() => normalizeIceConfig({ turnUrls: ['turn:turn.example.com:3478'] })).toThrow(/TURN endpoints require/)
    expect(() => normalizeIceConfig({ stunUrls: ['http://example.com'] })).toThrow(/Invalid ICE server URL/)
    expect(() => normalizeIceConfig({ turnUrls: ['stun:example.com:3478'], turnSecret: 'x' })).toThrow(/Invalid TURN URL/)
    expect(() => normalizeIceConfig({ turnUrls: ['turn:t:3478'], turnSecret: 'x', turnTtlSeconds: 5 })).toThrow(/TTL/)
  })
  it('keeps the coturn username free of separators', () => {
    const label = credentialLabel('8f1c2b3a-4d5e-9a0b-7c6d-5e4f3a2b1c0d', 'a1b2c3d4-e5f6-4a3b-8c9d-0e1f2a3b4c5d')
    expect(label).toBe('8f1c2b3a-a1b2c3d4')
    expect(label).not.toContain(':')
  })
})
