/**
 * Chat projection for Agent ACP sessions.
 *
 * Live frames (`agent.acp.frame` → `session/update` / `session/request_permission`)
 * and replayed history (`dsh/sessionHistory` native events) fold into one
 * in-memory chat list. Pure functions — unit-tested without a browser.
 */

export type ToolState = 'running' | 'finished' | 'failed'

export interface ChatMessage {
  kind: 'message'
  id: string
  role: 'user' | 'assistant'
  text: string
  reasoning?: string
  streaming?: boolean
  turnEnd?: { reason: 'completed' | 'stopped' | 'failed'; time: number }
  createdAt: number
}

export interface ToolActivity {
  kind: 'tool'
  id: string
  toolName: string
  state: ToolState
  argumentsText?: string
  resultText?: string
  createdAt: number
}

export interface ApprovalActivity {
  kind: 'approval'
  id: string
  approvalId: string
  toolName: string
  reason?: string
  resolved?: 'allow-once' | 'reject-once' | 'cancel'
  createdAt: number
}

export type ChatItem = ChatMessage | ToolActivity | ApprovalActivity

const LIVE_ASSISTANT_ID = 'acp-assistant-live'
const LIVE_USER_ID = 'acp-user-live'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const MAX_DETAIL = 16_000

function boundedDetail(value: unknown): string | undefined {
  if (typeof value === 'string') return value.slice(0, MAX_DETAIL)
  if (value === undefined || value === null) return undefined
  try {
    return JSON.stringify(value, null, 2)?.slice(0, MAX_DETAIL)
  } catch {
    return undefined
  }
}

function extractText(update: Record<string, unknown>): string | undefined {
  const content = update.content
  if (isRecord(content) && typeof content.text === 'string') return content.text
  if (typeof content === 'string') return content
  return undefined
}

/** Append text deltas into one streaming bubble so chunks do not fan out. */
function appendDelta(
  items: ChatItem[],
  role: 'user' | 'assistant',
  text: string,
  field: 'text' | 'reasoning',
): ChatItem[] {
  const id = role === 'user' ? LIVE_USER_ID : LIVE_ASSISTANT_ID
  const existing = items.findIndex(item => item.kind === 'message' && item.id === id)
  if (existing >= 0) {
    const current = items[existing] as ChatMessage
    const copy = items.slice()
    copy[existing] = {
      ...current,
      [field]: `${current[field] ?? ''}${text}`,
      streaming: role === 'assistant',
    }
    return copy
  }
  const message: ChatMessage = {
    kind: 'message',
    id,
    role,
    text: field === 'text' ? text : '',
    createdAt: Date.now(),
    ...(role === 'assistant' ? { streaming: true } : {}),
    ...(field === 'reasoning' ? { reasoning: text } : {}),
  }
  return [...items, message]
}

function finalizeLive(items: ChatItem[]): ChatItem[] {
  return items.map(item => item.kind === 'message' && item.id === LIVE_ASSISTANT_ID
    ? { ...item, streaming: false }
    : item.kind === 'message' && item.id === LIVE_USER_ID
      ? { ...item, streaming: false }
      : item)
}

/** Accumulate one `tool-call-delta` chunk onto a running tool card. */
function appendToolDelta(items: ChatItem[], chunk: Record<string, unknown>): ChatItem[] {
  const delta = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
  const id = `history-tool:${stringValue(chunk.id) ?? stringValue(chunk.index) ?? 'streaming'}`
  const index = items.findIndex(item => item.kind === 'tool' && item.id === id)
  const copy = items.slice()
  const update = (previous?: ToolActivity): ToolActivity => ({
    kind: 'tool',
    id,
    toolName: stringValue(chunk.name) ?? previous?.toolName ?? '工具',
    state: 'running',
    createdAt: previous?.createdAt ?? Date.now(),
    ...(delta.length > 0 || previous?.argumentsText !== undefined
      ? { argumentsText: boundedDetail(`${previous?.argumentsText ?? ''}${delta}`) }
      : {}),
    ...(previous?.resultText === undefined ? {} : { resultText: previous.resultText }),
  })
  if (index >= 0) copy[index] = update(items[index] as ToolActivity)
  else copy.push(update())
  return copy
}

/**
 * Apply one `agent.acp.frame` (session/update | session/request_permission).
 * Unknown update kinds are ignored so backend extensions never break the view.
 */
export function applySessionFrame(items: ChatItem[], frame: { method: string; params: unknown }): ChatItem[] {
  const params = isRecord(frame.params) ? frame.params : {}
  if (frame.method === 'session/update') return applySessionUpdate(items, params)
  if (frame.method === 'session/request_permission') return upsertApproval(items, params)
  return items
}

/** Wire-shaped helper: frames arrive as `{ frame: { method, params } }`. */
export function applyAgentFrame(items: ChatItem[], data: { frame?: { method?: string; params?: unknown } }): ChatItem[] {
  const method = data.frame?.method
  if (typeof method !== 'string') return items
  return applySessionFrame(items, { method, params: data.frame?.params })
}

function applySessionUpdate(items: ChatItem[], params: Record<string, unknown>): ChatItem[] {
  const update = isRecord(params.update) ? params.update : params
  const kind = stringValue(update.sessionUpdate) ?? stringValue(update.type)
  if (kind === undefined) return items

  if (kind === 'user_message_chunk') {
    const text = extractText(update)
    if (!text) return items
    return appendDelta(items, 'user', text, 'text')
  }
  if (kind === 'agent_message_chunk' || kind === 'agent_message') {
    const text = extractText(update)
    if (!text) return items
    return appendDelta(items, 'assistant', text, 'text')
  }
  if (kind === 'agent_thought_chunk' || kind === 'agent_thought') {
    const text = extractText(update)
    if (!text) return items
    return appendDelta(items, 'assistant', text, 'reasoning')
  }
  if (kind === 'prompt_completed' || kind === 'prompt_failed') {
    const reason = kind === 'prompt_failed' ? 'failed' as const
      : update.stopReason === 'cancelled' || update.stopReason === 'aborted' || update.stopReason === 'interrupted'
        ? 'stopped' as const
        : 'completed' as const
    const time = Date.now()
    // Retire the live bubbles so the next turn opens fresh ones, and stamp the
    // assistant turn with its final status ("已完成"/"已停止"/"生成失败").
    return finalizeLive(items).map(item => {
      if (item.kind === 'message' && (item.id === LIVE_ASSISTANT_ID || item.id === LIVE_USER_ID)) {
        return {
          ...item,
          id: `${item.id}:${time}`,
          ...(item.role === 'assistant' ? { turnEnd: { reason, time } } : {}),
        }
      }
      if (item.kind === 'tool' && item.state === 'running' && reason !== 'completed') {
        return { ...item, state: 'failed' as const }
      }
      return item
    })
  }
  if (kind === 'session_info_update' || kind === 'session_title_update') {
    // Title updates are surfaced by the runtime through its session list.
    return items
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    return applyToolCall(items, update, kind === 'tool_call_update')
  }
  return items
}

function applyToolCall(items: ChatItem[], update: Record<string, unknown>, isUpdate: boolean): ChatItem[] {
  const callId = stringValue(update.toolCallId) ?? stringValue(update.callId) ?? stringValue(update.name) ?? 'tool'
  const id = `acp-tool:${callId}`
  const existingIndex = items.findIndex(item => item.kind === 'tool' && item.id === id)
  const previous = existingIndex >= 0 ? items[existingIndex] as ToolActivity : undefined
  const toolName = stringValue(update.title) ?? stringValue(update.toolName) ?? stringValue(update.name) ?? previous?.toolName ?? '工具'
  const status = stringValue(update.status)
  const state: ToolState = status === 'failed' ? 'failed'
    : status === 'completed' || (isUpdate && update.output !== undefined) || (isUpdate && update.rawOutput !== undefined) ? 'finished'
      : previous?.state === 'failed' ? 'failed'
        : 'running'
  const argumentsText = boundedDetail(update.rawInput ?? update.parameters) ?? previous?.argumentsText
  const resultText = boundedDetail(update.rawOutput ?? update.output ?? update.content) ?? previous?.resultText
  const next: ToolActivity = {
    kind: 'tool',
    id,
    toolName,
    state,
    createdAt: previous?.createdAt ?? Date.now(),
    ...(argumentsText === undefined ? {} : { argumentsText }),
    ...(resultText === undefined ? {} : { resultText }),
  }
  if (existingIndex >= 0) {
    const copy = items.slice()
    copy[existingIndex] = next
    return copy
  }
  return [...items, next]
}

function upsertApproval(items: ChatItem[], params: Record<string, unknown>): ChatItem[] {
  const requestHandle = stringValue(params.requestHandle)
  if (requestHandle === undefined) return items
  const toolCall = isRecord(params.toolCall) ? params.toolCall : {}
  const toolName = stringValue(params.toolName) ?? stringValue(toolCall.title) ?? '权限确认'
  const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : undefined
  const reason = boundedDetail(params.reason ?? rawInput?.message ?? toolCall.rawInput)
  const id = `acp-approval:${requestHandle}`
  const next: ApprovalActivity = {
    kind: 'approval',
    id,
    approvalId: requestHandle,
    toolName,
    createdAt: Date.now(),
    ...(reason === undefined ? {} : { reason }),
  }
  const existingIndex = items.findIndex(item => item.id === id)
  if (existingIndex >= 0) {
    const copy = items.slice()
    const previous = items[existingIndex]!
    copy[existingIndex] = previous.kind === 'approval'
      ? { ...previous, ...next, ...(previous.resolved === undefined ? {} : { resolved: previous.resolved }) }
      : next
    return copy
  }
  return [...items, next]
}

/** Mark a pending approval as answered so the card stops offering actions. */
export function resolveApproval(items: ChatItem[], approvalId: string, decision: 'allow-once' | 'reject-once' | 'cancel'): ChatItem[] {
  return items.map(item => item.kind === 'approval' && item.approvalId === approvalId
    ? { ...item, resolved: decision }
    : item)
}

interface HistoryEvent {
  type?: unknown
  seq?: unknown
  time?: unknown
  data?: unknown
}

interface ContentBlock {
  type?: unknown
  text?: unknown
  content?: unknown
  toolCallId?: unknown
  isError?: unknown
}

function blocksToText(blocks: unknown): { text: string; reasoning: string; toolResults: Array<{ toolCallId: string; text: string; failed: boolean }> } {
  const text: string[] = []
  const reasoning: string[] = []
  const toolResults: Array<{ toolCallId: string; text: string; failed: boolean }> = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!isRecord(block)) continue
    const item = block as ContentBlock
    if (item.type === 'text' && typeof item.text === 'string') text.push(item.text)
    else if (item.type === 'reasoning' && typeof item.text === 'string') reasoning.push(item.text)
    else if (item.type === 'tool-result') {
      const inner = blocksToText(item.content)
      toolResults.push({
        toolCallId: typeof item.toolCallId === 'string' ? item.toolCallId : '',
        text: inner.text || inner.reasoning,
        failed: item.isError === true,
      })
    }
  }
  return { text: text.join(''), reasoning: reasoning.join(''), toolResults }
}

/**
 * Fold `dsh/sessionHistory` events (native DSH session events produced by the
 * Host's ACP history projection) into chat items. Tolerant of unknown shapes.
 * Also used incrementally for live `session/follow` entries.
 */
export function foldHistoryEvents(events: readonly unknown[]): ChatItem[] {
  return foldNativeEvents([], events)
}

export function foldNativeEvents(items: ChatItem[], events: readonly unknown[]): ChatItem[] {
  for (const raw of events) {
    if (!isRecord(raw)) continue
    // Accept both `{ type, event: {...} }` envelopes and bare `{ event }` ones.
    const outerType = stringValue(raw.type)
    const body = isRecord(raw.event) ? raw.event : raw
    const type = stringValue(body.type) ?? outerType
    const data = isRecord(body.data) ? body.data : {}
    if (type === 'assistant/chunk') {
      // Streaming delta from session/follow (text-delta / reasoning-delta /
      // tool-call-delta). Tool-call deltas accumulate arguments on a live card.
      const chunk = isRecord(data.chunk) ? data.chunk : {}
      const chunkType = stringValue(chunk.type)
      if (chunkType === 'tool-call-delta') {
        items = appendToolDelta(items, chunk)
        continue
      }
      const text = typeof chunk.text === 'string' ? chunk.text : ''
      if (text.length === 0) continue
      if (chunkType === 'reasoning-delta') items = appendDelta(items, 'assistant', text, 'reasoning')
      else items = appendDelta(items, 'assistant', text, 'text')
      continue
    }
    if (type === 'turn/end' || type === 'prompt/finished' || type === 'prompt/failed') {
      // Native turn boundary: seal live bubbles and stamp the status line.
      const reason = type === 'prompt/failed' ? 'failed' as const
        : isRecord(data.reason) && stringValue(data.reason.kind) === 'cancelled' ? 'stopped' as const
          : 'completed' as const
      const time = typeof body.time === 'number' && body.time > 0 ? body.time : Date.now()
      items = finalizeLive(items).map(item => {
        if (item.kind === 'message' && (item.id === LIVE_ASSISTANT_ID || item.id === LIVE_USER_ID)) {
          return {
            ...item,
            id: `${item.id}:${time}`,
            ...(item.role === 'assistant' ? { turnEnd: { reason, time } } : {}),
          }
        }
        return item
      })
      continue
    }
    if (type === 'user/message' || type === 'assistant/message') {
      const message = isRecord(data.message) ? data.message : data
      const content = blocksToText(message.content)
      const role = type === 'user/message' ? 'user' as const : 'assistant' as const
      if (content.text.length > 0 || content.reasoning.length > 0) {
        const time = typeof body.time === 'number' && body.time > 0 ? body.time : Date.now()
        items.push({
          kind: 'message',
          id: stringValue(message.id) ?? `history:${items.length}`,
          role,
          text: content.text,
          createdAt: time,
          ...(role === 'assistant' ? { turnEnd: { reason: 'completed' as const, time } } : {}),
          ...(content.reasoning.length > 0 ? { reasoning: content.reasoning } : {}),
        })
      }
    } else if (type === 'tool/call') {
      items.push({
        kind: 'tool',
        id: `history-tool:${stringValue(data.callId) ?? items.length}`,
        toolName: stringValue(data.name) ?? '工具',
        state: 'running',
        createdAt: Date.now(),
        ...(typeof data.arguments === 'string' ? { argumentsText: boundedDetail(data.arguments) } : {}),
      })
    } else if (type === 'tool/result') {
      const message = isRecord(data.message) ? data.message : data
      const content = blocksToText(message.content)
      for (const result of content.toolResults) {
        const id = `history-tool:${result.toolCallId || items.length}`
        const index = items.findIndex(item => item.kind === 'tool' && item.id === id)
        const update: ToolActivity = {
          kind: 'tool',
          id,
          toolName: index >= 0 ? (items[index] as ToolActivity).toolName : '工具',
          state: result.failed ? 'failed' : 'finished',
          createdAt: index >= 0 ? (items[index] as ToolActivity).createdAt : Date.now(),
          ...(result.text.length > 0 ? { resultText: boundedDetail(result.text) } : {}),
        }
        if (index >= 0) items[index] = update
        else items.push(update)
      }
    }
  }
  return items
}

/**
 * Merge a live tail onto folded history. The live prefix that re-streams the
 * history tail is dropped only when it is an exact suffix match — text alone is
 * not identity, so divergent turns never collapse.
 */
export function mergeHistoryAndLive(history: ChatItem[], live: ChatItem[]): ChatItem[] {
  for (let count = Math.min(history.length, live.length); count > 0; count--) {
    const suffix = history.slice(history.length - count)
    const prefix = live.slice(0, count)
    const matches = prefix.every((item, index) => {
      const previous = suffix[index]!
      if (item.kind !== previous.kind) return false
      if (item.kind === 'message' && previous.kind === 'message') {
        return previous.role === item.role && previous.text === item.text
      }
      if (item.kind === 'tool' && previous.kind === 'tool') {
        return previous.toolName === item.toolName
      }
      return previous.id === item.id
    })
    const anchored = prefix.some((item, index) => item.id === suffix[index]!.id
      || (item.kind === 'tool' && suffix[index]!.kind === 'tool' && (suffix[index] as ToolActivity).toolName === (item as ToolActivity).toolName))
    if (matches && anchored) {
      return [...history.slice(0, history.length - count), ...prefix.map((item, index) => {
        const previous = suffix[index]!
        if (item.kind === 'tool' && previous.kind === 'tool') {
          return {
            ...previous,
            ...item,
            argumentsText: item.argumentsText ?? previous.argumentsText,
            resultText: item.resultText ?? previous.resultText,
          }
        }
        return item
      }), ...live.slice(count)]
    }
  }
  return [...history, ...live]
}
