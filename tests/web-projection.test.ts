import { describe, expect, it } from 'vitest'
import {
  applyAgentFrame,
  applySessionFrame,
  foldHistoryEvents,
  foldNativeEvents,
  mergeHistoryAndLive,
  resolveApproval,
  type ChatItem,
} from '../web/src/remote/projection'

function textFrame(sessionId: string, kind: string, text: string) {
  return {
    streamId: 'stream-1',
    frame: {
      method: 'session/update',
      params: { sessionId, update: { sessionUpdate: kind, content: { type: 'text', text } }, seq: 1 },
    },
  }
}

describe('ACP session projection', () => {
  it('streams agent chunks into one assistant bubble and thoughts into reasoning', () => {
    let items: ChatItem[] = []
    items = applyAgentFrame(items, textFrame('s1', 'agent_message_chunk', 'Hello'))
    items = applyAgentFrame(items, textFrame('s1', 'agent_message_chunk', ' world'))
    items = applyAgentFrame(items, textFrame('s1', 'agent_thought_chunk', 'thinking…'))
    expect(items).toHaveLength(1)
    const message = items[0]!
    expect(message.kind).toBe('message')
    if (message.kind === 'message') {
      expect(message.role).toBe('assistant')
      expect(message.text).toBe('Hello world')
      expect(message.reasoning).toBe('thinking…')
      expect(message.streaming).toBe(true)
    }
  })

  it('opens a new user bubble and finalizes the live assistant on prompt completion', () => {
    let items: ChatItem[] = []
    items = applyAgentFrame(items, textFrame('s1', 'user_message_chunk', '问题'))
    items = applyAgentFrame(items, textFrame('s1', 'agent_message_chunk', '回答'))
    items = applySessionFrame(items, {
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'prompt_completed', stopReason: 'end_turn' } },
    })
    expect(items.map(item => item.kind === 'message' ? item.role : item.kind)).toEqual(['user', 'assistant'])
    const assistant = items[1]!
    expect(assistant.kind === 'message' && assistant.streaming).toBe(false)
    expect(assistant.kind === 'message' && assistant.turnEnd?.reason).toBe('completed')
    // The finished turn is sealed: the next turn must open fresh bubbles.
    const next = applyAgentFrame(items, textFrame('s1', 'agent_message_chunk', '下一轮'))
    expect(next).toHaveLength(3)
    expect(next[2]!.id).not.toBe(assistant.id)
  })

  it('marks running tools failed when the turn is cancelled', () => {
    let items: ChatItem[] = []
    items = applySessionFrame(items, {
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', status: 'running', rawInput: { command: 'ls' } } },
    })
    items = applySessionFrame(items, {
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'prompt_completed', stopReason: 'cancelled' } },
    })
    const tool = items[0]!
    expect(tool.kind).toBe('tool')
    if (tool.kind === 'tool') expect(tool.state).toBe('failed')
  })

  it('folds tool_call_update into the same tool row and records output', () => {
    let items: ChatItem[] = []
    items = applySessionFrame(items, {
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', status: 'running' } },
    })
    items = applySessionFrame(items, {
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', output: 'file contents' } },
    })
    expect(items).toHaveLength(1)
    const tool = items[0]!
    if (tool.kind === 'tool') {
      expect(tool.state).toBe('finished')
      expect(tool.resultText).toContain('file contents')
    }
  })

  it('tracks permission requests and resolves them once', () => {
    let items: ChatItem[] = []
    items = applySessionFrame(items, {
      method: 'session/request_permission',
      params: {
        sessionId: 's1',
        requestHandle: 'h1',
        toolCall: { title: 'Shell', rawInput: { command: 'rm -rf /tmp/x' } },
      },
    })
    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe('approval')
    items = resolveApproval(items, 'h1', 'reject-once')
    const approval = items[0]!
    expect(approval.kind === 'approval' && approval.resolved).toBe('reject-once')
  })

  it('ignores unknown frame methods and update kinds', () => {
    const items: ChatItem[] = []
    const next = applySessionFrame(items, {
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'available_commands_update', ...{} } },
    })
    expect(next).toEqual([])
    expect(applyAgentFrame([], { frame: undefined })).toEqual([])
  })
})

describe('history folding and merge', () => {
  it('folds native history events into chat items', () => {
    const events = [
      { type: 'event', event: { type: 'user/message', seq: 0, time: 1000, data: { message: { id: 'm1', role: 'user', content: [{ type: 'text', text: '你好' }] } } } },
      { type: 'event', event: { type: 'assistant/message', seq: 1, time: 2000, data: { message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '你好！' }, { type: 'reasoning', text: '思考' }] } } } },
      { type: 'event', event: { type: 'tool/call', seq: 2, time: 0, data: { callId: 'c1', name: 'Bash', arguments: '{"command":"ls"}' } } },
      { type: 'event', event: { type: 'tool/result', seq: 3, time: 0, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] } } } },
    ]
    const items = foldHistoryEvents(events)
    expect(items.map(item => item.kind)).toEqual(['message', 'message', 'tool'])
    const [user, assistant] = items
    expect(user.kind === 'message' && user.role === 'user' && user.text).toBe('你好')
    expect(assistant.kind === 'message' && assistant.reasoning).toBe('思考')
    // tool/call + tool/result collapse into one finished row
    expect(items.filter(item => item.kind === 'tool')).toHaveLength(1)
    const toolItem = items.find(item => item.kind === 'tool')
    if (toolItem?.kind === 'tool') {
      expect(toolItem.state).toBe('finished')
      expect(toolItem.resultText).toContain('ok')
    }
  })

  it('collapses a re-streamed suffix only when item identity matches', () => {
    const history = foldHistoryEvents([
      { type: 'event', event: { type: 'user/message', seq: 0, time: 1, data: { message: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }] } } } },
      { type: 'event', event: { type: 'assistant/message', seq: 1, time: 2, data: { message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'hello' }] } } } },
    ])
    // Live redelivery of the same tail under the same synthetic IDs.
    const live: ChatItem[] = [
      { kind: 'message', id: 'm2', role: 'assistant', text: 'hello', createdAt: 3 },
    ]
    const merged = mergeHistoryAndLive(history, live)
    expect(merged.filter(item => item.kind === 'message')).toHaveLength(2)
    expect(merged[1]!.id).toBe('m2')
  })

  it('keeps divergent turns separate instead of collapsing equal text', () => {
    const history = foldHistoryEvents([
      { type: 'event', event: { type: 'assistant/message', seq: 0, time: 1, data: { message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'same' }] } } } },
    ])
    const live = applyAgentFrame([], textFrame('s1', 'agent_message_chunk', 'same'))
    const merged = mergeHistoryAndLive(history, live)
    expect(merged).toHaveLength(2)
  })
})

describe('native DSH event folding', () => {
  it('streams assistant/chunk deltas and seals the turn on turn/end', () => {
    let items: ChatItem[] = []
    items = foldNativeEvents(items, [
      { event: { type: 'user/message', seq: 1, time: 1, data: { message: { id: 'u1', role: 'user', content: [{ type: 'text', text: '问题' }] } } } },
    ])
    items = foldNativeEvents(items, [
      { event: { type: 'assistant/chunk', seq: 2, time: 2, data: { chunk: { type: 'text-delta', text: '答' } } } },
      { event: { type: 'assistant/chunk', seq: 3, time: 3, data: { chunk: { type: 'text-delta', text: '案' } } } },
      { event: { type: 'assistant/chunk', seq: 4, time: 4, data: { chunk: { type: 'reasoning-delta', text: '思考' } } } },
    ])
    expect(items).toHaveLength(2)
    const live = items[1]!
    expect(live.kind === 'message' && live.text).toBe('答案')
    expect(live.kind === 'message' && live.reasoning).toBe('思考')
    expect(live.kind === 'message' && live.streaming).toBe(true)

    items = foldNativeEvents(items, [{ event: { type: 'turn/end', seq: 5, time: 5, data: { reason: { kind: 'completed' } } } }])
    const sealed = items[1]!
    expect(sealed.kind === 'message' && sealed.turnEnd?.reason).toBe('completed')
    expect(sealed.kind === 'message' && sealed.streaming).toBe(false)
    // Sealed turn: the next chunk opens a fresh bubble.
    const next = foldNativeEvents(items, [{ event: { type: 'assistant/chunk', seq: 6, time: 6, data: { chunk: { type: 'text-delta', text: '下一轮' } } } }])
    expect(next).toHaveLength(3)
    expect(next[2]!.id).not.toBe(sealed.id)
  })

  it('folds tool call/result rows from live native events', () => {
    let items: ChatItem[] = []
    items = foldNativeEvents(items, [
      { event: { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c9', name: 'Bash', arguments: '{"command":"ls"}' } } },
    ])
    items = foldNativeEvents(items, [
      { event: { type: 'tool/result', seq: 2, time: 2, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c9', content: [{ type: 'text', text: 'ok' }] }] } } } },
    ])
    expect(items).toHaveLength(1)
    const tool = items[0]!
    if (tool.kind === 'tool') {
      expect(tool.toolName).toBe('Bash')
      expect(tool.state).toBe('finished')
      expect(tool.resultText).toContain('ok')
    }
  })
})
