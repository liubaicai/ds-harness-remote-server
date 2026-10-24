import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionHistory, connectionStats, exportRecords, MAX_EVENTS, retention } from '../src/connection-history.js'
import { diagnose, sanitizedDiagnosticExport } from '../src/diagnostics.js'
import { normalizeIceConfig } from '../src/ice.js'
const dirs: string[] = [], stores: ConnectionHistory[] = []
function fixture(now?: () => number) { const dir = mkdtempSync(join(tmpdir(), 'history-')); dirs.push(dir); const h = new ConnectionHistory(join(dir, 'state.connections.json'), now); stores.push(h); return h }
afterEach(() => { for (const h of stores.splice(0)) h.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.useRealTimers() })
describe('bounded connection metadata persistence', () => {
  it('throttles atomic persistence and flushes at close', () => {
    vi.useFakeTimers()
    const h = fixture(); h.start('id', 'host', 'client'); h.flush()
    h.relay('id', 42)
    expect(JSON.parse(readFileSync(h.file, 'utf8')).records[0].relayBytes).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(JSON.parse(readFileSync(h.file, 'utf8')).records[0].relayBytes).toBe(42)
    h.close()
    expect(JSON.parse(readFileSync(h.file, 'utf8')).records[0]).toMatchObject({ stage: 'closed', endReason: 'SERVER_SHUTDOWN' })
  })
  it('retries failed writes without traffic and never reschedules after close', () => {
    vi.useFakeTimers(); const h = fixture(); h.flush()
    const original = h.file
    // A directory at the temp-file path makes atomic writes fail on every platform.
    mkdirSync(`${original}.tmp`)
    h.start('id', 'h', 'c'); vi.advanceTimersByTime(1000)
    expect(h.persistenceHealthy).toBe(false)
    rmSync(`${original}.tmp`, { recursive: true })
    vi.advanceTimersByTime(5000); expect(h.persistenceHealthy).toBe(true)
    expect(JSON.parse(readFileSync(original, 'utf8')).records).toHaveLength(1)
    h.close(); h.relay('id', 1); expect(vi.getTimerCount()).toBe(0); h.flush()
  })
  it('automatically expires idle persisted records and stops housekeeping on close', () => {
    vi.useFakeTimers(); const h = fixture(); h.start('id', 'h', 'c'); h.end('id', 'REJECTED', 'rejected'); h.flush()
    vi.advanceTimersByTime(retention.maxAgeMs + 3600_000)
    expect(JSON.parse(readFileSync(h.file, 'utf8')).records).toEqual([])
    h.close(); expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds oversized unregistered Host IDs and diagnostics export remains available', () => {
    const h = fixture(); h.failure('x'.repeat(10000), 'client', 'HOST_OFFLINE')
    expect(h.all()[0]!.host.length).toBeLessThan(257)
    expect(exportRecords(h.all())).toHaveLength(1)
  })
  it('warns for incompatible Hosts and ended links while preserving unknown network reachability', () => {
    const h = fixture(); h.start('id', 'h', 'c'); h.updateStage('id', 'ready'); h.transport('id', 'p2p', 'client'); h.transport('id', 'relay', 'host'); h.end('id', 'AUTH_INVALID')
    const result = diagnose({ webrtc: true, ice: normalizeIceConfig(), probe: { state: 'disabled', results: [] }, devices: [{ deviceId: 'h', role: 'host', online: true, clientVersion: '0.2.14' }], connection: h.all()[0]!, persistenceHealthy: true })
    expect(result.checks.find(c => c.id === 'host-version')?.status).toBe('warning')
    expect(result.checks.find(c => c.id === 'connection')?.status).toBe('warning')
    expect(result.checks.find(c => c.id === 'transport')?.message).toContain('无法确定回退原因')
    expect(result.checks.find(c => c.id === 'transport')?.message).toContain('本身不代表失败')
    expect(result.checks.find(c => c.id === 'turn-reachability')?.status).toBe('unknown')
  })
  it('recovers active links as interrupted and retains ended links without rewriting them', () => {
    let now = 10000; const h = fixture(() => now)
    h.start('active', 'host', 'client'); h.start('ended', 'host', 'client'); h.end('ended', 'REJECTED', 'rejected'); h.flush()
    now += 200
    const restored = new ConnectionHistory(h.file, () => now); stores.push(restored)
    expect(restored.all().find(r => r.connectionId === 'active')).toMatchObject({ stage: 'interrupted', endReason: 'SERVER_RESTART', endedAt: now })
    expect(restored.all().find(r => r.connectionId === 'ended')).toMatchObject({ stage: 'rejected', endedAt: 10000 })
    restored.flush(); expect(JSON.parse(readFileSync(h.file, 'utf8')).records[0].stage).toBe('interrupted')
  })
  it('bounds records and events, prioritizes active records, prunes seven day retention', () => {
    let now = 10000; const h = fixture(() => now)
    h.start('active', 'host', 'client')
    for (let i = 0; i < 1100; i++) h.failure('host', 'client', 'HOST_OFFLINE')
    expect(h.all()).toHaveLength(retention.maxRecords)
    expect(h.all().some(r => r.connectionId === 'active')).toBe(true)
    for (let i = 0; i < 100; i++) h.transport('active', i % 2 ? 'relay' : 'p2p', 'client')
    const active = h.all().find(r => r.connectionId === 'active')!
    expect(active.events).toHaveLength(MAX_EVENTS); expect(active.events[0]?.stage).toBe('pending'); expect(active.eventsDropped).toBeGreaterThan(0)
    h.flush(); now += retention.maxAgeMs + 1
    const restored = new ConnectionHistory(h.file, () => now); stores.push(restored)
    expect(restored.all()).toEqual([]); expect(h.all()).toEqual([])
    h.flush(); expect(JSON.parse(readFileSync(h.file, 'utf8')).records).toEqual([])
  })
  it('loads only valid allowlisted records and safely handles corrupt JSON', () => {
    const h = fixture(); h.start('id', 'host', 'client'); h.flush()
    const raw = JSON.parse(readFileSync(h.file, 'utf8')); raw.records[0].payload = 'SECRET'; raw.records.push({ connectionId: 'bad' }); writeFileSync(h.file, JSON.stringify(raw))
    const restored = new ConnectionHistory(h.file); stores.push(restored)
    expect(restored.all()).toHaveLength(1); expect(JSON.stringify(restored.all())).not.toContain('SECRET')
    writeFileSync(h.file, '{bad')
    const corrupt = new ConnectionHistory(h.file); stores.push(corrupt)
    expect(corrupt.all()).toEqual([]); expect(corrupt.persistenceHealthy).toBe(false)
  })
  it('exports per-download pseudonyms and no client-controlled strings, URLs, credentials or messages', () => {
    const h = fixture(); h.start('PRIVATE-CONNECTION', 'PRIVATE-HOST', 'PRIVATE-CLIENT'); h.end('PRIVATE-CONNECTION', 'PRIVATE-MESSAGE')
    const input = diagnose({ webrtc: true, ice: normalizeIceConfig({ stunUrls: ['stun:PRIVATE-IP:3478'], turnUrls: ['turn:PRIVATE-URL'], turnSecret: 'PRIVATE-KEY' }), probe: { state: 'complete', observedAt: 1, results: [{ reachable: true, rttMs: 2 }] }, devices: [{ deviceId: 'PRIVATE-HOST', online: true, clientVersion: 'PRIVATE-VERSION' }], connection: h.all()[0]!, persistenceHealthy: true })
    const first = sanitizedDiagnosticExport(input, h.all()), second = sanitizedDiagnosticExport(input, h.all())
    expect(JSON.stringify(first)).not.toContain('PRIVATE-')
    expect(first.connections[0]?.endReason).toBe('OTHER')
    expect(first.connections[0]?.host).not.toBe(second.connections[0]?.host)
    expect(first.unknown).toContain('turnReachability')
    expect(exportRecords(h.all())[0]?.events).toHaveLength(2)
  })
  it('aggregates observed handshake and relay only, leaves direct performance unknown', () => {
    let now = 100; const h = fixture(() => now); h.start('id', 'h', 'c'); now = 150; h.updateStage('id', 'ready'); h.transport('id', 'p2p', 'host'); h.relay('id', 17)
    const s = connectionStats(h.all()); expect(s.handshake).toEqual({ samples: 1, averageMs: 50 }); expect(s.totals.relayBytes).toBe(17); expect(s.transports.p2p).toBe(1); expect(s).not.toHaveProperty('throughput')
  })
})
