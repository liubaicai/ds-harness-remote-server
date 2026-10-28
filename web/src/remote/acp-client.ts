/**
 * Port of the shared AgentAcpClient (upstream packages/client-core/src/acp-client.ts):
 * the generic Agent ACP domain used by every Remote client, including Web.
 *
 * Business RPC travels as `agent.acp.call` (compiled allowlist on the Host);
 * ordered `session/update` and `session/request_permission` notifications are
 * delivered through `agent.acp.frame` events after `agent.acp.stream.open`.
 */
import { bytesToCanonicalBase64, canonicalBase64ToBytes } from './base64'
import { RemoteRpcError, type RemoteClientCore } from './client-core'
import type { EventPayload } from './protocol'

export type AcpAgentBackend = 'cursor' | 'antigravity' | 'pi' | 'opencode' | 'claude' | (string & {})

/**
 * `session/prompt` blocks until the upstream turn finishes. Keep this well
 * above the default client-wide timeout.
 */
export const ACP_PROMPT_RPC_TIMEOUT_MS = 10 * 60_000

const AGENT_ACP_TRANSFER_CHUNK_BYTES = 512 * 1024
const MAX_AGENT_ACP_TRANSFER_BYTES = 288 * 1024 * 1024

export interface AcpRemoteSession {
  sessionId: string
  cwd?: string
  mode?: 'agent' | 'plan' | 'ask'
}

export interface AcpStream {
  streamId: string
  close(): Promise<void>
}

export interface AgentAcpFrameData {
  streamId: string
  frame: { method: string; params: unknown }
}

export interface AgentAcpStreamClosedData {
  streamId: string
  reason: 'cancelled' | 'completed' | 'failed' | 'peer-disconnected'
}

type AgentAcpTransferCommitResult =
  | { kind: 'inline'; response: unknown }
  | { kind: 'chunked'; transferId: string; totalBytes: number; totalChunks: number }

interface AgentAcpTransferReadResult {
  transferId: string
  index: number
  data: string
}

export class AgentAcpClient {
  constructor(private readonly core: RemoteClientCore) {}

  async call(method: string, params: unknown = {}, signal?: AbortSignal): Promise<unknown> {
    const timeoutMs = method === 'session/prompt' ? ACP_PROMPT_RPC_TIMEOUT_MS : undefined
    return this.core.rpc('agent.acp.call', { method, params }, signal, timeoutMs === undefined ? undefined : { timeoutMs })
  }

  async initialize(
    params: { protocolVersion?: number; backend?: AcpAgentBackend; clientInfo?: { name?: string; version?: string } } = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.call('initialize', { protocolVersion: 1, ...params }, signal)
  }

  async respond(
    requestHandle: string,
    decision: 'allow-once' | 'reject-once' | 'cancel',
    result?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.core.rpc('agent.acp.respond', {
      requestHandle,
      decision,
      ...(result === undefined ? {} : { result }),
    }, signal)
  }

  async listWorkspaces(backend?: AcpAgentBackend, signal?: AbortSignal): Promise<Array<{ path: string; title?: string; sessionCount?: number; backend?: string }>> {
    const result = await this.call('dsh/workspaceList', { ...(backend === undefined ? {} : { backend }) }, signal).catch(error => {
      if (backend === 'pi' || backend === 'claude') throw error
      return []
    })
    return Array.isArray(result) ? result as Array<{ path: string; title?: string; sessionCount?: number; backend?: string }> : []
  }

  async listSessions(
    path: string,
    backend?: AcpAgentBackend,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<Array<{ conversationId: string; title: string; createdAt: number; updatedAt: number }>> {
    const result = await this.call('dsh/sessionList', {
      path,
      ...(backend === undefined ? {} : { backend }),
      ...(limit === undefined ? {} : { limit }),
    }, signal).catch(error => {
      if (backend === 'pi' || backend === 'claude') throw error
      return { items: [] }
    })
    return isRecord(result) && Array.isArray(result.items)
      ? result.items as Array<{ conversationId: string; title: string; createdAt: number; updatedAt: number }>
      : []
  }

  /** Read-only history: `{ events: [...] }` of native DSH session events. */
  async loadSessionHistory(sessionId: string, backend?: AcpAgentBackend, signal?: AbortSignal): Promise<unknown[]> {
    const result = await this.transferCall('dsh/sessionHistory', {
      sessionId,
      ...(backend === undefined ? {} : { backend }),
    }, signal).catch(error => {
      if (backend === 'pi' || backend === 'claude' || backend === 'opencode') throw error
      return { events: [] }
    })
    return isRecord(result) && Array.isArray(result.events) ? result.events : []
  }

  async createSession(
    cwd: string,
    mode?: 'agent' | 'plan' | 'ask',
    backend?: AcpAgentBackend,
    signal?: AbortSignal,
  ): Promise<AcpRemoteSession> {
    const result = await this.call('session/new', {
      cwd,
      mcpServers: [],
      ...(mode === undefined ? {} : { mode }),
      ...(backend === undefined ? {} : { backend }),
    }, signal)
    const sessionId = readString(result, 'sessionId')
    if (sessionId === undefined) throw new RemoteRpcError('INVALID_RESPONSE', 'ACP session/new did not return sessionId.')
    return { sessionId, cwd, ...(mode === undefined ? {} : { mode }) }
  }

  /** Attach (or resume) a live session so subsequent prompts own the stream. */
  async loadSession(sessionId: string, backend?: AcpAgentBackend, signal?: AbortSignal): Promise<unknown> {
    return this.call('session/load', { sessionId, ...(backend === undefined ? {} : { backend }) }, signal)
  }

  async prompt(
    sessionId: string,
    text: string,
    signal?: AbortSignal,
    images: Array<{ type: 'image'; mimeType: string; data: string }> = [],
    backend?: AcpAgentBackend,
  ): Promise<unknown> {
    const params = {
      sessionId,
      ...(backend === undefined ? {} : { backend }),
      prompt: [...(text.length > 0 ? [{ type: 'text', text }] : []), ...images],
    }
    return images.length > 0 ? this.transferCall('session/prompt', params, signal) : this.call('session/prompt', params, signal)
  }

  async cancel(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    return this.call('session/cancel', { sessionId }, signal)
  }

  async openStream(
    sessionId: string,
    onFrame: (frame: AgentAcpFrameData) => void,
    onClosed?: (closed: AgentAcpStreamClosedData) => void,
    signal?: AbortSignal,
  ): Promise<AcpStream> {
    const streamId = createRemoteId()
    const unsubscribe = this.core.onEvent(event => {
      if (event.event === 'agent.acp.frame' && isRecord(event.data)) {
        const data = event.data as unknown as AgentAcpFrameData
        if (!frameMatchesSubscription(data, streamId, sessionId)) return
        onFrame(data)
      }
      if (event.event === 'agent.acp.stream.closed' && isRecord(event.data) && event.data.streamId === streamId) {
        onClosed?.(event.data as unknown as AgentAcpStreamClosedData)
      }
    })
    try {
      await this.core.rpc('agent.acp.stream.open', { streamId, sessionId }, signal)
      if (signal?.aborted) {
        unsubscribe()
        await this.core.rpc('agent.acp.stream.close', { streamId }).catch(() => undefined)
        throw signal.reason
      }
    } catch (error) {
      unsubscribe()
      throw error
    }
    return {
      streamId,
      close: async () => {
        unsubscribe()
        await this.core.rpc('agent.acp.stream.close', { streamId }).catch(() => undefined)
      },
    }
  }

  async transferCall(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const requestBytes = new TextEncoder().encode(JSON.stringify({ method, params }))
    if (requestBytes.byteLength > MAX_AGENT_ACP_TRANSFER_BYTES) {
      throw new RemoteRpcError('REQUEST_TOO_LARGE', 'The ACP transfer request exceeds the bounded limit.')
    }
    const transferId = createRemoteId()
    const totalChunks = Math.ceil(requestBytes.byteLength / AGENT_ACP_TRANSFER_CHUNK_BYTES)
    try {
      await this.core.rpc('agent.acp.transfer.open', {
        transferId,
        totalBytes: requestBytes.byteLength,
        totalChunks,
      }, signal)
      for (let index = 0; index < totalChunks; index += 1) {
        const start = index * AGENT_ACP_TRANSFER_CHUNK_BYTES
        const end = Math.min(start + AGENT_ACP_TRANSFER_CHUNK_BYTES, requestBytes.byteLength)
        await this.core.rpc('agent.acp.transfer.chunk', {
          transferId,
          index,
          data: bytesToCanonicalBase64(requestBytes.subarray(start, end)),
        }, signal)
      }
      const commit = await this.core.rpc<AgentAcpTransferCommitResult>('agent.acp.transfer.commit', { transferId }, signal,
        method === 'session/prompt' ? { timeoutMs: ACP_PROMPT_RPC_TIMEOUT_MS } : undefined)
      if (commit.kind === 'inline') return commit.response
      if (commit.kind !== 'chunked' || commit.transferId !== transferId
        || !Number.isSafeInteger(commit.totalBytes) || commit.totalBytes < 1 || commit.totalBytes > MAX_AGENT_ACP_TRANSFER_BYTES
        || commit.totalChunks !== Math.ceil(commit.totalBytes / AGENT_ACP_TRANSFER_CHUNK_BYTES)) {
        throw new RemoteRpcError('INVALID_RESPONSE', 'Invalid ACP transfer descriptor.')
      }
      const chunks: Uint8Array[] = []
      for (let index = 0; index < commit.totalChunks; index += 1) {
        const part = await this.core.rpc<AgentAcpTransferReadResult>('agent.acp.transfer.read', { transferId, index }, signal)
        if (part.transferId !== transferId || part.index !== index || typeof part.data !== 'string') {
          throw new RemoteRpcError('INVALID_RESPONSE', 'Invalid ACP transfer chunk.')
        }
        const chunk = canonicalBase64ToBytes(part.data)
        const expected = Math.min(AGENT_ACP_TRANSFER_CHUNK_BYTES, commit.totalBytes - index * AGENT_ACP_TRANSFER_CHUNK_BYTES)
        if (chunk.length !== expected) throw new RemoteRpcError('INVALID_RESPONSE', 'Invalid ACP transfer chunk size.')
        chunks.push(chunk)
      }
      const bytes = concat(chunks, commit.totalBytes)
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    } finally {
      await this.core.rpc('agent.acp.transfer.close', { transferId }).catch(() => undefined)
    }
  }
}

function readString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Match Host frames by explicit stream id or by ACP session id (fallback delivery). */
function frameMatchesSubscription(data: AgentAcpFrameData, streamId: string, sessionId: string): boolean {
  if (data.streamId === streamId) return true
  if (data.streamId === `session:${sessionId}`) return true
  const params = isRecord(data.frame.params) ? data.frame.params : undefined
  if (params === undefined) return false
  if (params.sessionId === sessionId) return true
  return isRecord(params.update) && params.update.sessionId === sessionId
}

function concat(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const output = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function createRemoteId(): string {
  if (globalThis.crypto?.randomUUID !== undefined) return globalThis.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export type { EventPayload }
