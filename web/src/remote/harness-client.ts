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
  /** Only an explicit `origin: 'subagent'` selects subagent routing (forks also carry a parent). */
  origin?: 'subagent'
  projections?: { values?: Record<string, unknown> }
}

/**
 * Subagent routing predicate (mirrors upstream `isSubagentSession`): forks also
 * carry `parentSessionId`, but only the explicit origin selects the durable
 * parent address form.
 */
export function isSubagentSession(
  session: Pick<HarnessRemoteSession, 'origin' | 'parentSessionId'>,
): session is { origin: 'subagent'; parentSessionId: string } {
  return session.origin === 'subagent' && session.parentSessionId !== undefined
}

/**
 * Official SessionAddress: a subagent session must be addressed through its
 * durable parent (`{ kind: 'subagent', parentSessionId, childSessionId }`);
 * the plain session form is rejected by the Host with a "durable parent
 * address" error.
 */
export function sessionAddress(sessionId: string, parentSessionId?: string) {
  return parentSessionId === undefined
    ? { kind: 'session' as const, sessionId }
    : { kind: 'subagent' as const, parentSessionId, childSessionId: sessionId, mode: 'unknown' as const }
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

interface AssistantStreamState {
  attemptId: string
  startedAfterSeq: number
  turn: number
  step: number
  nextIndex: number
}

interface FollowHandle {
  controller: AbortController
  stream?: AsyncIterable<unknown>
  /** sessionFormat 3 assistant-stream attempt being decoded (ordered chunks). */
  assistant?: AssistantStreamState
}

export class HarnessClient {
  private readonly gateway: RemoteTypertGateway
  private readonly sessionFormat: 3 | undefined
  private followHandle?: FollowHandle

  constructor(core: RemoteClientCore, sessionFormat?: 3) {
    this.gateway = new RemoteTypertGateway(core)
    this.sessionFormat = sessionFormat
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
    const result = await this.callValue<{ accepted?: boolean }>('session/cancel', { request: { sessionId } }, signal)
    if (result?.accepted !== true) throw new RemoteGatewayError('INVALID_MESSAGE', 'Host 未接受停止请求。')
  }

  /**
   * Attach to one session: returns the snapshot history and then streams live
   * entries through `onEntry` until the handle is closed. Tolerant of Host
   * snapshot variations (control preludes, result envelopes, chunked frames,
   * history replayed as live entries) — a missing snapshot degrades to an
   * empty history instead of blocking the conversation.
   *
   * Subagent sessions must be opened with their durable parent
   * (`parentSessionId`) or the Host rejects the plain session form.
   */
  async follow(
    sessionId: string,
    onEntry: (entries: HarnessHistoryEntry[]) => void,
    signal?: AbortSignal,
    parentSessionId?: string,
  ): Promise<HarnessFollowSnapshot> {
    await this.closeFollow(false)
    const controller = new AbortController()
    const abortForward = () => controller.abort()
    signal?.addEventListener('abort', abortForward, { once: true })
    const handle: FollowHandle = { controller }
    this.followHandle = handle
    const request = {
      args: {
        request: {
          address: sessionAddress(sessionId, parentSessionId),
          maxMessages: 200,
          ...(this.sessionFormat === 3 ? { assistantStream: true as const } : {}),
        },
      },
    }
    let source
    try {
      source = await this.gateway.open('session/follow', request, controller.signal, { transferFrames: true })
    } catch (error) {
      // Hosts whose stream schema predates `transferFrames` reject the flag.
      if (controller.signal.aborted) throw error
      source = await this.gateway.open('session/follow', request, controller.signal)
    }
    this.followHandle.stream = source
    const iterator = source[Symbol.asyncIterator]()

    // Find the snapshot, skipping control preludes; history may also arrive as
    // ordinary event/chunk frames with no snapshot envelope at all.
    const leading: HarnessHistoryEntry[] = []
    let snapshot: HarnessFollowSnapshot = { entries: [], hasMore: false }
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      const value = unwrapEnvelope(next.value)
      if (!isRecord(value)) continue
      const records = Array.isArray(value.records) ? value.records : undefined
      if (records !== undefined || value.type === 'snapshot') {
        if (this.sessionFormat === 3) handle.assistant = assistantStreamBaseline(value.assistantStream)
        snapshot = {
          entries: historyEntriesFromRecords(records ?? []),
          hasMore: value.hasMore === true,
          ...(typeof value.cursor === 'number' ? { cursor: value.cursor } : {}),
        }
        break
      }
      const entries = this.entriesFromSessionFollow(handle, value)
      if (entries.length > 0) leading.push(...entries)
      // Unknown control values (ready/baseline/…) are skipped silently.
    }

    const pump = (entries: HarnessHistoryEntry[]) => {
      if (entries.length > 0 && !controller.signal.aborted) onEntry(entries)
    }
    pump(leading)
    void (async () => {
      try {
        while (this.followHandle?.controller === controller) {
          const next = await iterator.next()
          if (next.done || this.followHandle?.controller !== controller) return
          pump(this.entriesFromSessionFollow(handle, unwrapEnvelope(next.value)))
        }
      } catch {
        // Stream failures end live updates; history on screen stays valid.
      }
    })()
    return snapshot
  }

  /**
   * Route one follow value: sessionFormat 3 assistant-stream frames are decoded
   * in order (attemptId + index) into `assistant/chunk` deltas; everything else
   * uses the classic event/chunks record shapes.
   */
  private entriesFromSessionFollow(handle: FollowHandle, value: unknown): HarnessHistoryEntry[] {
    if (this.sessionFormat !== 3 || !isRecord(value) || value.type !== 'assistant-stream') {
      return entriesFromFollowValue(value)
    }
    const frame = isRecord(value.frame) ? value.frame : undefined
    if (frame === undefined || typeof frame.type !== 'string') return []
    if (frame.type === 'start') {
      handle.assistant = assistantStreamAttempt(frame, 0)
      return []
    }
    const attempt = handle.assistant
    if (frame.type === 'end') {
      if (attempt !== undefined && frame.attemptId === attempt.attemptId) handle.assistant = undefined
      return []
    }
    if (frame.type !== 'chunk' || attempt === undefined
      || frame.attemptId !== attempt.attemptId
      || frame.index !== attempt.nextIndex
      || typeof frame.time !== 'number'
      || !isRecord(frame.chunk)) return []
    attempt.nextIndex += 1
    return [{
      event: {
        type: 'assistant/chunk',
        seq: attempt.startedAfterSeq + 1 - 1 / (attempt.nextIndex + 1),
        time: frame.time,
        data: { turn: attempt.turn, step: attempt.step, chunk: frame.chunk },
      },
    }]
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
    ...(value.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
    ...(isRecord(value.projections) ? { projections: { values: isRecord(value.projections.values) ? value.projections.values : undefined } } : {}),
  }
}

function assistantStreamBaseline(value: unknown): AssistantStreamState | undefined {
  return isRecord(value) && isRecord(value.activeAttempt) ? assistantStreamAttempt(value.activeAttempt) : undefined
}

function assistantStreamAttempt(value: Record<string, unknown>, defaultNextIndex?: number): AssistantStreamState | undefined {
  const nextIndex = typeof value.nextIndex === 'number' ? value.nextIndex : defaultNextIndex
  return typeof value.attemptId === 'string'
    && typeof value.startedAfterSeq === 'number'
    && typeof value.turn === 'number'
    && typeof value.step === 'number'
    && nextIndex !== undefined
    ? { attemptId: value.attemptId, startedAfterSeq: value.startedAfterSeq, turn: value.turn, step: value.step, nextIndex }
    : undefined
}

/**
 * Display title for a native session. The Host projects titles through
 * `projections.values` (sessionListMetadata.title and friends) — never fall
 * back to the raw session ID in the UI.
 */
export function deriveSessionTitle(session: HarnessRemoteSession): string {
  const values = session.projections?.values
  if (isRecord(values)) {
    const metadata = isRecord(values.sessionListMetadata) ? values.sessionListMetadata : undefined
    const fromMetadata = trimText(metadata?.title)
    if (fromMetadata !== undefined) return fromMetadata
    for (const [key, value] of Object.entries(values)) {
      if (/title/i.test(key) && typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
    for (const container of ['summary', 'metadata', 'session', 'data', 'view'] as const) {
      const nested = values[container]
      if (isRecord(nested)) {
        for (const [key, value] of Object.entries(nested)) {
          if (/title/i.test(key) && typeof value === 'string' && value.trim().length > 0) return value.trim()
        }
      }
    }
  }
  const direct = trimText(session.title)
  if (direct !== undefined) return direct
  return session.blank ? '新对话' : '会话'
}

function trimText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
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
  const chunkIndex = typeof data.index === 'number' ? data.index : undefined
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
              ...(chunkIndex === undefined ? {} : { index: chunkIndex }),
              text,
            },
          },
        },
      }
    })
  }
  if (event.type !== 'chunkrow/tool-call-chunks') return []
  const args = Array.isArray(data.args) ? data.args.filter((item): item is string => typeof item === 'string') : []
  let toolTime = event.time
  return args.map((text, offset) => {
    if (offset > 0) toolTime += dt[offset - 1] ?? 0
    return {
      event: {
        type: 'assistant/chunk',
        seq: seq + offset,
        time: toolTime,
        data: {
          ...base,
          chunk: {
            type: 'tool-call-delta',
            ...(chunkIndex === undefined ? {} : { index: chunkIndex }),
            ...(typeof data.id === 'string' ? { id: data.id } : {}),
            ...(typeof data.name === 'string' ? { name: data.name } : {}),
            argumentsDelta: text,
          },
        },
      },
    }
  })
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

/** Some Host versions wrap stream values in `{ok,value}` result envelopes. */
function unwrapEnvelope(value: unknown): unknown {
  return isRecord(value) && value.ok === true && 'value' in value ? value.value : value
}
