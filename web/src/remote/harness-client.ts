/**
 * Trimmed port of HarnessAlphaClient (upstream packages/client-core): the
 * native DSH session domain over `harness.remote.*`. Covers what the web
 * workbench needs — list/create/prompt/cancel plus session follow — and maps
 * follow records into native session events the chat projection already folds.
 */
import { RemoteGatewayError, RemoteTypertGateway, createRemoteId } from './harness-gateway'
import type { RemoteClientCore } from './client-core'

export interface HarnessRemoteSession {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  title?: string
  cwd?: string
  parentSessionId?: string
}

export interface HarnessSessionEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
}

export interface HarnessHistoryEntry {
  event: HarnessSessionEvent
}

export interface HarnessFollowSnapshot {
  entries: HarnessHistoryEntry[]
  hasMore: boolean
  cursor?: number
}

export class HarnessClient {
  private readonly gateway: RemoteTypertGateway
  private followHandle?: { controller: AbortController; stream?: AsyncIterable<unknown> }

  constructor(core: RemoteClientCore) {
    this.gateway = new RemoteTypertGateway(core)
  }

  private async callValue<T>(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.gateway.call<T>(endpoint, { args }, signal)
  }

  async listSessions(signal?: AbortSignal): Promise<HarnessRemoteSession[]> {
    const result = await this.callValue<{ items: unknown[] }>('session/list', { _request: {} }, signal)
    return (Array.isArray(result.items) ? result.items : [])
      .map(normalizeSession)
      .filter((item): item is HarnessRemoteSession => item !== undefined)
  }

  async createSession(cwd: string, signal?: AbortSignal): Promise<{ sessionId: string }> {
    const result = await this.callValue<{ sessionId: string }>('session/create', { request: { cwd } }, signal)
    if (typeof result.sessionId !== 'string' || result.sessionId.length === 0) {
      throw new RemoteGatewayError('INVALID_RESPONSE', 'Host 未返回新会话 ID。')
    }
    return result
  }

  async prompt(sessionId: string, text: string, signal?: AbortSignal): Promise<void> {
    const timeZone = clientTimeZone()
    await this.callValue('session/prompt', {
      request: {
        requestId: createRemoteId(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        ...(timeZone === undefined ? {} : { clientTimeZone: timeZone }),
      },
    }, signal)
  }

  async cancel(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.callValue('session/cancel', { request: { sessionId } }, signal)
  }

  /**
   * Attach to one session: returns the snapshot history and then streams live
   * entries through `onEntry` until the handle is closed.
   */
  async follow(
    sessionId: string,
    onEntry: (entries: HarnessHistoryEntry[]) => void,
    signal?: AbortSignal,
  ): Promise<HarnessFollowSnapshot> {
    await this.closeFollow(false)
    const controller = new AbortController()
    const abortForward = () => controller.abort()
    signal?.addEventListener('abort', abortForward, { once: true })
    this.followHandle = { controller }
    const source = await this.gateway.open('session/follow', {
      args: {
        request: {
          address: { kind: 'session', sessionId },
          maxMessages: 200,
        },
      },
    }, controller.signal)
    this.followHandle.stream = source
    const iterator = source[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done || !isRecord(first.value) || first.value.type !== 'snapshot') {
      await this.closeFollow(false)
      throw new RemoteGatewayError('INVALID_MESSAGE', 'Host 返回的会话快照无效。')
    }
    const snapshot = first.value
    const cursor = typeof snapshot.cursor === 'number' ? snapshot.cursor : undefined
    void (async () => {
      try {
        while (this.followHandle?.controller === controller) {
          const next = await iterator.next()
          if (next.done || this.followHandle?.controller !== controller) return
          const entries = entriesFromFollowValue(next.value)
          if (entries.length > 0) onEntry(entries)
        }
      } catch {
        // Stream failures end live updates; history on screen stays valid.
      }
    })()
    return {
      entries: historyEntriesFromRecords(Array.isArray(snapshot.records) ? snapshot.records : []),
      hasMore: snapshot.hasMore === true,
      ...(cursor === undefined ? {} : { cursor }),
    }
  }

  async closeFollow(notifyRemote = true): Promise<void> {
    const handle = this.followHandle
    this.followHandle = undefined
    if (handle === undefined) return
    handle.controller.abort()
    if (handle.stream && 'close' in handle.stream && typeof handle.stream.close === 'function') {
      await handle.stream.close(notifyRemote).catch(() => undefined)
    }
  }

  async close(): Promise<void> {
    await this.closeFollow()
  }
}

function normalizeSession(value: unknown): HarnessRemoteSession | undefined {
  if (!isRecord(value)
    || typeof value.sessionId !== 'string'
    || typeof value.updatedAt !== 'number'
    || typeof value.running !== 'boolean'
    || typeof value.blank !== 'boolean') return undefined
  return {
    sessionId: value.sessionId,
    updatedAt: value.updatedAt,
    running: value.running,
    blank: value.blank,
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    ...(typeof value.parentSessionId === 'string' ? { parentSessionId: value.parentSessionId } : {}),
  }
}

export function historyEntriesFromRecords(records: unknown[]): HarnessHistoryEntry[] {
  return records.flatMap(record => {
    if (!isRecord(record)) return []
    if (record.type === 'event' && isRecord(record.event)) return historyEntryFromEvent(record.event)
    if (record.type === 'chunks' && isRecord(record.event)) return entriesFromChunkRun(record.event)
    return []
  })
}

export function entriesFromFollowValue(value: unknown): HarnessHistoryEntry[] {
  if (!isRecord(value)) return []
  if (value.type === 'event' && isRecord(value.event)) return historyEntryFromEvent(value.event)
  if (value.type === 'chunks' && isRecord(value.event)) return entriesFromChunkRun(value.event)
  return []
}

function historyEntryFromEvent(event: Record<string, unknown>): HarnessHistoryEntry[] {
  if (typeof event.type !== 'string' || typeof event.seq !== 'number' || typeof event.time !== 'number') return []
  return [{
    event: {
      type: event.type,
      seq: event.seq,
      time: event.time,
      data: isRecord(event.data) ? event.data : {},
    },
  }]
}

/** Compact chunk runs expand into `assistant/chunk` deltas. */
function entriesFromChunkRun(event: Record<string, unknown>): HarnessHistoryEntry[] {
  if (typeof event.type !== 'string' || typeof event.seq !== 'number' || typeof event.time !== 'number' || !isRecord(event.data)) return []
  const seq: number = event.seq
  const data = event.data
  const base = {
    ...(typeof data.turn === 'number' ? { turn: data.turn } : {}),
    ...(typeof data.step === 'number' ? { step: data.step } : {}),
  }
  const dt = Array.isArray(data.dt) ? data.dt.filter((item): item is number => typeof item === 'number') : []
  if (event.type === 'chunkrow/text-chunks' || event.type === 'chunkrow/reasoning-chunks') {
    const texts = Array.isArray(data.texts) ? data.texts.filter((item): item is string => typeof item === 'string') : []
    let time = event.time
    return texts.map((text, offset) => {
      if (offset > 0) time += dt[offset - 1] ?? 0
      return {
        event: {
          type: 'assistant/chunk',
          seq: seq + offset,
          time,
          data: {
            ...base,
            chunk: {
              type: event.type === 'chunkrow/text-chunks' ? 'text-delta' : 'reasoning-delta',
              text,
            },
          },
        },
      }
    })
  }
  return []
}

function clientTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone !== 'string' || zone.length === 0) return undefined
    if (zone === 'UTC') return zone
    return /^[A-Za-z_]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?$/.test(zone) ? zone : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
