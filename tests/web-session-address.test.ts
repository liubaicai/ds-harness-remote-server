import { describe, expect, it } from 'vitest'
import { isSubagentSession, sessionAddress } from '../web/src/remote/harness-client'
import { foldNativeEvents, type ChatItem } from '../web/src/remote/projection'

describe('subagent session addressing', () => {
  it('uses the plain session form without a parent link', () => {
    expect(sessionAddress('s1')).toEqual({ kind: 'session', sessionId: 's1' })
  })

  it('routes subagent sessions through their durable parent address', () => {
    expect(sessionAddress('child-1', 'parent-1')).toEqual({
      kind: 'subagent',
      parentSessionId: 'parent-1',
      childSessionId: 'child-1',
      mode: 'unknown',
    })
  })

  it('only the explicit origin selects subagent routing (forks keep the plain form)', () => {
    expect(isSubagentSession({ origin: 'subagent', parentSessionId: 'p' })).toBe(true)
    // Fork: parent link without the subagent origin.
    expect(isSubagentSession({ parentSessionId: 'p' })).toBe(false)
    // Origin without a usable parent cannot route either.
    expect(isSubagentSession({ origin: 'subagent' })).toBe(false)
    expect(isSubagentSession({})).toBe(false)
  })
})

describe('tool-call deltas', () => {
  it('accumulates arguments onto one running tool card', () => {
    let items: ChatItem[] = []
    items = foldNativeEvents(items, [{
      type: 'event',
      event: {
        type: 'assistant/chunk', seq: 1, time: 1,
        data: { chunk: { type: 'tool-call-delta', id: 'call-1', name: 'Bash', argumentsDelta: 'ls -' } },
      },
    }])
    items = foldNativeEvents(items, [{
      type: 'event',
      event: {
        type: 'assistant/chunk', seq: 2, time: 2,
        data: { chunk: { type: 'tool-call-delta', id: 'call-1', argumentsDelta: 'la' } },
      },
    }])
    expect(items).toHaveLength(1)
    const tool = items[0]!
    expect(tool.kind).toBe('tool')
    if (tool.kind === 'tool') {
      expect(tool.toolName).toBe('Bash')
      expect(tool.state).toBe('running')
      expect(tool.argumentsText).toBe('ls -la')
    }
  })
})
