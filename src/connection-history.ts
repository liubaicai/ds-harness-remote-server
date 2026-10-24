import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

export const retention = { maxRecords: 1000, maxAgeMs: 7 * 24 * 3600_000 } as const
export const MAX_EVENTS = 64
const transport = z.enum(['lan', 'p2p', 'turn', 'relay'])
const stage = z.enum(['pending', 'accepted', 'handshake', 'ready', 'closed', 'rejected', 'failed', 'interrupted'])
const reason = z.enum(['CONNECTION_FAILED', 'CONNECTION_REPLACED', 'AUTH_INVALID', 'SLOW_CONSUMER', 'HOST_OFFLINE', 'CAPABILITY_NOT_SUPPORTED', 'RATE_LIMITED', 'INVALID_MESSAGE', 'CONNECTION_NOT_FOUND', 'REJECTED', 'SERVER_SHUTDOWN', 'SERVER_RESTART', 'OTHER'])
const number = z.number().finite().nonnegative()
const eventSchema = z.object({ at: number, type: z.enum(['stage', 'transport', 'ended']), stage: stage.optional(), transport: transport.optional(), source: z.enum(['host', 'client']).optional(), reason: reason.optional() }).strip()
const recordSchema = z.object({ connectionId: z.string().max(256), host: z.string().max(256), client: z.string().max(256), stage, connectedAt: number, readyAt: number.optional(), endedAt: number.optional(), endReason: reason.optional(), selectedTransport: transport.optional(), hostTransport: transport.optional(), handshakeDurationMs: number.optional(), relayBytes: number, relayFrames: number, events: z.array(eventSchema).max(MAX_EVENTS), eventsDropped: number.default(0) }).strip()
export type ConnectionRecord = z.infer<typeof recordSchema>
export type HistoryEvent = z.infer<typeof eventSchema>
export type Transport = z.infer<typeof transport>
const terminal = new Set(['closed', 'rejected', 'failed', 'interrupted'])
export function safeReason(value: string): z.infer<typeof reason> { const result = reason.safeParse(value); return result.success ? result.data : 'OTHER' }

/** Bounded metadata only. No frame payloads, peer messages or signaling enter this store. */
export class ConnectionHistory {
  private records: ConnectionRecord[] = []
  private timer?: ReturnType<typeof setTimeout>
  private housekeeping: ReturnType<typeof setInterval>
  private dirty = false
  private closed = false
  persistenceHealthy = true
  constructor(readonly file: string, private readonly now: () => number = Date.now) {
    if (existsSync(file)) {
      try {
        const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
        if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { records?: unknown }).records)) throw new Error('invalid history')
        for (const item of (raw as { records: unknown[] }).records.slice(-retention.maxRecords)) {
          const parsed = recordSchema.safeParse(item)
          if (!parsed.success) continue
          const record = parsed.data
          if ((record.endedAt ?? record.connectedAt) < this.now() - retention.maxAgeMs) continue
          if (!terminal.has(record.stage)) {
            record.stage = 'interrupted'; record.endedAt = this.now(); record.endReason = 'SERVER_RESTART'
            this.append(record, { at: this.now(), type: 'ended', stage: 'interrupted', reason: 'SERVER_RESTART' })
          }
          this.records.push(record)
        }
      } catch { this.persistenceHealthy = false }
    }
    this.prune(); this.changed()
    this.housekeeping = setInterval(() => this.flush(), 3600_000)
    this.housekeeping.unref()
  }
  private prune() {
    const cutoff = this.now() - retention.maxAgeMs
    const count = this.records.length
    this.records = this.records.filter(r => (r.endedAt ?? r.connectedAt) >= cutoff)
    if (this.records.length !== count) this.changed()
    // Prefer evicting completed attempts, preserving the at-most-256 active links.
    while (this.records.length > retention.maxRecords) {
      const index = this.records.findIndex(r => terminal.has(r.stage))
      this.records.splice(index < 0 ? 0 : index, 1)
    }
  }
  private append(record: ConnectionRecord, event: HistoryEvent) {
    if (record.events.length >= MAX_EVENTS) { record.events.splice(1, 1); record.eventsDropped++ }
    record.events.push(event)
  }
  private changed() {
    this.dirty = true
    if (!this.closed && !this.timer) { this.timer = setTimeout(() => { this.timer = undefined; this.flush() }, 1000); this.timer.unref() }
  }
  start(connectionId: string, host: string, client: string, connectedAt = this.now()) {
    // connect.request host IDs are client supplied and need not be registered.
    const bounded = (id: string) => id.length <= 256 ? id : `sha256:${createHash('sha256').update(id).digest('hex')}`
    connectionId = bounded(connectionId); host = bounded(host); client = bounded(client)
    this.records.push({ connectionId, host, client, stage: 'pending', connectedAt, relayBytes: 0, relayFrames: 0, eventsDropped: 0, events: [{ at: connectedAt, type: 'stage', stage: 'pending' }] })
    this.prune(); this.changed()
  }
  failure(host: string, client: string, code: string) { const id = randomUUID(); this.start(id, host, client); this.end(id, code, 'failed') }
  updateStage(id: string, value: 'accepted' | 'handshake' | 'ready') {
    const r = this.records.find(r => r.connectionId === id); if (!r || terminal.has(r.stage)) return
    r.stage = value
    if (value === 'ready') { r.readyAt = this.now(); r.handshakeDurationMs = Math.max(0, r.readyAt - r.connectedAt) }
    this.append(r, { at: this.now(), type: 'stage', stage: value }); this.changed()
  }
  transport(id: string, value: Transport, source: 'host' | 'client') {
    const r = this.records.find(r => r.connectionId === id); if (!r || terminal.has(r.stage)) return
    const key = source === 'host' ? 'hostTransport' : 'selectedTransport'
    if (r[key] === value) return
    r[key] = value; this.append(r, { at: this.now(), type: 'transport', transport: value, source }); this.changed()
  }
  relay(id: string, bytes: number) {
    const r = this.records.find(r => r.connectionId === id); if (!r) return
    r.relayFrames = Math.min(Number.MAX_SAFE_INTEGER, r.relayFrames + 1)
    r.relayBytes = Math.min(Number.MAX_SAFE_INTEGER, r.relayBytes + bytes); this.changed()
  }
  end(id: string, code: string, state: 'closed' | 'failed' | 'rejected' | 'interrupted' = 'closed') {
    const r = this.records.find(r => r.connectionId === id); if (!r || terminal.has(r.stage)) return
    r.stage = state; r.endedAt = this.now(); r.endReason = safeReason(code)
    this.append(r, { at: this.now(), type: 'ended', stage: state, reason: r.endReason }); this.changed()
  }
  all(): ConnectionRecord[] { this.prune(); return structuredClone(this.records).reverse() }
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    this.prune()
    if (!this.dirty) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      writeFileSync(temp, JSON.stringify({ version: 1, records: this.records }), { mode: 0o600 })
      renameSync(temp, this.file)
      this.dirty = false; this.persistenceHealthy = true
    } catch {
      this.persistenceHealthy = false
      if (!this.closed && !this.timer) { this.timer = setTimeout(() => { this.timer = undefined; this.flush() }, 5000); this.timer.unref() }
    }
  }
  close() { this.closed = true; clearInterval(this.housekeeping); for (const r of this.records) if (!terminal.has(r.stage)) this.end(r.connectionId, 'SERVER_SHUTDOWN'); this.flush() }
}

export function connectionStats(records: ConnectionRecord[]) {
  const transports = { lan: 0, p2p: 0, turn: 0, relay: 0, unknown: 0 }
  for (const r of records) transports[r.hostTransport ?? r.selectedTransport ?? 'unknown']++
  const samples = records.flatMap(r => r.handshakeDurationMs === undefined ? [] : [r.handshakeDurationMs])
  return { generatedAt: Date.now(), retention, totals: { connections: records.length, active: records.filter(r => !terminal.has(r.stage)).length, ready: records.filter(r => r.readyAt !== undefined).length, failed: records.filter(r => ['failed', 'rejected', 'interrupted'].includes(r.stage) || (r.stage === 'closed' && r.readyAt === undefined)).length, relayBytes: records.reduce((n, r) => n + r.relayBytes, 0), relayFrames: records.reduce((n, r) => n + r.relayFrames, 0) }, transports, handshake: { samples: samples.length, averageMs: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null }, semantics: { relay: '服务器向目标 WebSocket 成功写出的双向密文帧数与解码后密文字节数，不含 JSON/base64 开销；不代表对端收到或应用吞吐量。', handshake: '从连接请求到服务器观察到第二步握手的耗时，不代表解密或应用成功。', directPath: '未采集直连吞吐量、丢包或端到端延迟；传输类型为客户端选择或 Host 声明。' } }
}

/** Build from schema primitives explicitly; never recursively redact an arbitrary object. */
export function exportRecords(records: ConnectionRecord[]) {
  const salt = randomUUID(), ids = new Map<string, string>()
  const alias = (id: string, kind: string) => { const key = `${kind}:${id}`; if (!ids.has(key)) ids.set(key, `${kind}-${salt}-${ids.size + 1}`); return ids.get(key)! }
  return records.map(input => {
    const r = recordSchema.parse(input)
    return { connectionId: alias(r.connectionId, 'connection'), host: alias(r.host, 'device'), client: alias(r.client, 'device'), stage: r.stage, connectedAt: r.connectedAt, readyAt: r.readyAt, endedAt: r.endedAt, endReason: r.endReason, selectedTransport: r.selectedTransport, hostTransport: r.hostTransport, handshakeDurationMs: r.handshakeDurationMs, relayBytes: r.relayBytes, relayFrames: r.relayFrames, eventsDropped: r.eventsDropped, events: r.events.map(e => ({ at: e.at, type: e.type, stage: e.stage, transport: e.transport, source: e.source, reason: e.reason })) }
  })
}
