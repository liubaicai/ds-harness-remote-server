import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { devNull } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const composePath = fileURLToPath(new URL('../compose.yaml', import.meta.url))
const source = readFileSync(composePath, 'utf8')
const hasCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 10_000 }).status === 0
const shell = process.platform === 'win32' ? `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Git\\bin\\sh.exe` : 'sh'
const hasShell = spawnSync(shell, ['-c', 'exit 0'], { timeout: 5_000 }).status === 0

// Structural regressions remain covered even on development hosts without Docker.
describe('Compose TURN deployment safety', () => {
  it('does not require an optional TURN secret during Compose interpolation', () => {
    expect(source).not.toMatch(/\$\{DSH_SERVER_TURN_SECRET:\?/)
    expect(source).toContain('DSH_SERVER_STUN_URLS-stun:')
    expect(source).toContain('DSH_SERVER_TURN_USERNAME: ${DSH_SERVER_TURN_USERNAME:-}')
    expect(source).toContain('DSH_SERVER_TURN_PASSWORD: ${DSH_SERVER_TURN_PASSWORD:-}')
    expect(source).toContain('DSH_SERVER_TRUSTED_PROXIES: ${DSH_SERVER_TRUSTED_PROXIES:-}')
  })

  it('guards coturn before exec and quotes shell-expanded secret and arguments', () => {
    const guard = source.indexOf('if [ -z "$${DSH_SERVER_TURN_SECRET}" ]; then')
    const fail = source.indexOf('exit 1', guard)
    const exec = source.indexOf('exec turnserver --static-auth-secret="$${DSH_SERVER_TURN_SECRET}" "$$@"')
    expect(guard).toBeGreaterThan(0)
    expect(fail).toBeGreaterThan(guard)
    expect(exec).toBeGreaterThan(fail)
  })
})

describe.skipIf(!hasShell)('coturn shell startup guard', () => {
  it.each([undefined, ''])('exits before launching TURN with secret %j', secret => {
    const block = source.match(/      - \|\n([\s\S]*?)      - --\n/)![1]!
    const script = block.replace(/^        /gm, '').replaceAll('$$', '$')
    const env = { ...process.env }
    delete env.DSH_SERVER_TURN_SECRET
    if (secret !== undefined) env.DSH_SERVER_TURN_SECRET = secret
    const result = spawnSync(shell, ['-ec', script, '--', '--no-cli'], { env, encoding: 'utf8', timeout: 5_000 })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('DSH_SERVER_TURN_SECRET is required for the turn profile')
    expect(result.stderr).not.toContain('turnserver:')
  })
})

describe.skipIf(!hasCompose)('Docker Compose rendered configuration (no daemon required)', () => {
  function config(overrides: Record<string, string> = {}, turn = false) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_SERVER_') && !key.startsWith('COMPOSE_')))
    Object.assign(env, { DSH_SERVER_ACCOUNT: 'owner@example.com', DSH_SERVER_PASSWORD: 'compose-test-password', ...overrides })
    const result = spawnSync('docker', ['compose', '--env-file', devNull, '-f', composePath, ...(turn ? ['--profile', 'turn'] : []), 'config', '--format', 'json'], { env, encoding: 'utf8', timeout: 20_000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }

  it('renders ordinary startup with no TURN secret and preserves default STUN', () => {
    const rendered = config()
    expect(rendered.services.coturn).toBeUndefined()
    expect(rendered.services.server.environment.DSH_SERVER_ANDROID_LOGIN_COMPAT).toBe('1')
    expect(config({ DSH_SERVER_ANDROID_LOGIN_COMPAT: '0' }).services.server.environment.DSH_SERVER_ANDROID_LOGIN_COMPAT).toBe('0')
    expect(rendered.services.server.environment.DSH_SERVER_TURN_SECRET).toBe('')
    expect(rendered.services.server.environment.DSH_SERVER_STUN_URLS).toContain('stun:stun.miwifi.com:3478')
  })

  it('preserves explicit empty STUN and forwards static credentials and trusted proxies', () => {
    const values = { DSH_SERVER_STUN_URLS: '', DSH_SERVER_TURN_USERNAME: 'static-user', DSH_SERVER_TURN_PASSWORD: 'static-password', DSH_SERVER_TRUSTED_PROXIES: '127.0.0.1,::1' }
    expect(config(values).services.server.environment).toMatchObject(values)
  })

  it('enables coturn with runtime validation instead of a global secret requirement', () => {
    const coturn = config({}, true).services.coturn
    expect(coturn.environment.DSH_SERVER_TURN_SECRET).toBe('')
    expect(coturn.entrypoint.slice(0, 2)).toEqual(['/bin/sh', '-ec'])
    // Compose config escapes dollars for round-tripping; the engine receives one $.
    const script = coturn.entrypoint[2].replaceAll('$$', '$')
    expect(script).toContain('if [ -z "${DSH_SERVER_TURN_SECRET}" ]; then')
    expect(script).toContain('exit 1')
    expect(script).toContain('exec turnserver --static-auth-secret="${DSH_SERVER_TURN_SECRET}" "$@"')
    expect(config({ DSH_SERVER_TURN_SECRET: 'test-secret' }, true).services.coturn.environment.DSH_SERVER_TURN_SECRET).toBe('test-secret')
  })
})
