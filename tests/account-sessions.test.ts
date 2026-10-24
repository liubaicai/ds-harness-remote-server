import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { ACCOUNT_SESSION_TTL_SECONDS, hash, Store } from '../src/store.js'
import { createRemoteServer } from '../src/server.js'

const account = 'owner@example.com', password = 'test-session-password'
const ttl = 30 * 86400_000
let dir: string, file: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-sessions-')); file = join(dir, 'state.json') })
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })
const open = (email = account, pass = password) => new Store(file, email, pass)

describe('persistent account sessions', () => {
  it('lasts exactly 30 days and stores only token hashes across restart', () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const session = open().issueAccountSession()
    expect(ACCOUNT_SESSION_TTL_SECONDS).toBe(2592000)
    expect(session.expiresAt).toBe(now + ttl)
    const saved = readFileSync(file, 'utf8')
    expect(saved).not.toContain(session.token)
    expect(JSON.parse(saved).accountSessions[hash(session.token)]).toBe(now + ttl)
    const restarted = open()
    clock.mockReturnValue(now + ttl - 1)
    expect(() => restarted.authenticateAccountSession(session.token)).not.toThrow()
    clock.mockReturnValue(now + ttl)
    expect(() => restarted.authenticateAccountSession(session.token)).toThrow('ACCOUNT_AUTH_REQUIRED')
  })
  it('persists logout and isolates other sessions', () => {
    const store = open(), first = store.issueAccountSession(), second = store.issueAccountSession()
    store.revokeAccountSession(first.token)
    const restarted = open()
    expect(() => restarted.authenticateAccountSession(first.token)).toThrow('ACCOUNT_AUTH_REQUIRED')
    expect(() => restarted.authenticateAccountSession(second.token)).not.toThrow()
  })
  it.each(['account', 'password'])('invalidates sessions when %s changes', changed => {
    const session = open().issueAccountSession()
    const store = open(changed === 'account' ? 'new@example.com' : account, changed === 'password' ? 'changed-test-password' : password)
    expect(() => store.authenticateAccountSession(session.token)).toThrow('ACCOUNT_AUTH_REQUIRED')
  })
  it('loads legacy state without accountSessions', () => {
    open()
    const state = JSON.parse(readFileSync(file, 'utf8'))
    delete state.accountSessions
    writeFileSync(file, JSON.stringify(state))
    expect(open().issueAccountSession().token).toBeTruthy()
  })
  it('bounds sessions and reclaims expired slots', () => {
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const store = open()
    for (let i = 0; i < 256; i++) store.issueAccountSession()
    expect(() => store.issueAccountSession()).toThrow('RATE_LIMITED')
    clock.mockReturnValue(now + ttl)
    expect(store.issueAccountSession().expiresAt).toBe(now + 2 * ttl)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).accountSessions)).toHaveLength(1)
  })
  it('sets a secure 30-day browser cookie and revokes it through HTTP logout', async () => {
    const app = createRemoteServer({ account, password, dataFile: file, publicUrl: 'https://example.com', ice: { probeStun: false } })
    app.server.listen(0, '127.0.0.1')
    await once(app.server, 'listening')
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/v1`
    try {
      const before = Date.now()
      const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: account, password }) })
      expect(login.status).toBe(200)
      const data = await login.json()
      expect(data.expiresAt).toBeGreaterThanOrEqual(before + ttl)
      expect(data.expiresAt).toBeLessThanOrEqual(Date.now() + ttl)
      const setCookie = login.headers.get('set-cookie')!
      for (const attr of ['Max-Age=2592000', 'HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/']) expect(setCookie).toContain(attr)
      const headers = { Cookie: setCookie.split(';')[0] }
      expect((await fetch(`${base}/auth/me`, { headers })).status).toBe(200)
      const logout = await fetch(`${base}/auth/logout`, { method: 'POST', headers })
      expect(logout.status).toBe(200)
      expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
      expect((await fetch(`${base}/auth/me`, { headers })).status).toBe(401)
    } finally { await app.close() }
  })
})
