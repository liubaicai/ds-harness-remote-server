/**
 * Session runtime: one browser tab ↔ one Host.
 *
 * Bootstraps the browser device identity, opens the relay + Noise channel and
 * exposes the Agent ACP surface (workspaces, sessions, chat) as plain
 * callbacks/records the UI can render.
 */
import { AgentAcpClient, ACP_PROMPT_RPC_TIMEOUT_MS, type AgentAcpFrameData, type AcpAgentBackend, type AcpStream } from './acp-client'
import { RemoteClientCore, RemoteRpcError } from './client-core'
import { ensureIdentity, WEB_CLIENT_VERSION, type DeviceIdentity } from './identity'
import {
  applyAgentFrame,
  foldHistoryEvents,
  mergeHistoryAndLive,
  resolveApproval,
  type ChatItem,
} from './projection'
import { RelayLink } from './relay-link'
import { SecureTransport } from './secure-transport'

export interface HostSummary {
  deviceId: string
  name: string
  online: boolean
  identityKey: string
  clientVersion?: string
  harnessVersion?: string
}

export interface WorkspaceEntry {
  path: string
  title?: string
  sessionCount?: number
  backend: AcpAgentBackend
}

export interface SessionEntry {
  conversationId: string
  title: string
  createdAt: number
  updatedAt: number
  backend: AcpAgentBackend
  path: string
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed'

export interface RuntimeSnapshot {
  connection: ConnectionState
  connectionError?: string
  backends: AcpAgentBackend[]
  workspaces: WorkspaceEntry[]
  sessions: SessionEntry[]
  activeSessionId?: string
  items: ChatItem[]
  prompting: boolean
  promptError?: string
  historyLoaded: boolean
}

type Listener = (snapshot: RuntimeSnapshot) => void

async function fetchHosts(): Promise<HostSummary[]> {
  const response = await fetch('/api/v1/account/devices', {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000),
  })
  const data = await response.json() as {
    items?: Array<{ deviceId: string; name: string; role: string; online: boolean; identityKey?: string; clientVersion?: string; harnessVersion?: string }>
    error?: { code?: string }
  }
  if (!response.ok) throw new Error(data.error?.code ?? `HTTP ${response.status}`)
  return (data.items ?? [])
    .filter(item => item.role === 'host' && typeof item.identityKey === 'string' && item.identityKey.length > 0)
    .map(item => ({
      deviceId: item.deviceId,
      name: item.name,
      online: item.online,
      identityKey: item.identityKey as string,
      ...(item.clientVersion === undefined ? {} : { clientVersion: item.clientVersion }),
      ...(item.harnessVersion === undefined ? {} : { harnessVersion: item.harnessVersion }),
    }))
}

export class SessionRuntime {
  private core?: RemoteClientCore
  private acp?: AgentAcpClient
  private identity?: DeviceIdentity
  private stream?: AcpStream
  private snapshot: RuntimeSnapshot = {
    connection: 'idle',
    backends: [],
    workspaces: [],
    sessions: [],
    items: [],
    prompting: false,
    historyLoaded: false,
  }
  private readonly listeners = new Set<Listener>()
  private activePath?: string
  private activeBackend?: AcpAgentBackend
  private liveItems: ChatItem[] = []
  private historyItems: ChatItem[] = []
  private sessionAbort?: AbortController

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): RuntimeSnapshot {
    return this.snapshot
  }

  static async listHosts(): Promise<HostSummary[]> {
    return fetchHosts()
  }

  async connect(host: HostSummary): Promise<void> {
    await this.disconnect()
    this.patch({ connection: 'connecting', connectionError: undefined })
    try {
      const identity = await ensureIdentity()
      this.identity = identity
      const link = new RelayLink({
        deviceId: identity.deviceId,
        accessToken: identity.accessToken,
        hostDeviceId: host.deviceId,
        hostIdentityKey: host.identityKey,
        clientIdentityKey: identity.publicKey,
        clientVersion: WEB_CLIENT_VERSION,
        onClose: event => {
          if (this.snapshot.connection === 'connected' || this.snapshot.connection === 'connecting') {
            this.patch({ connection: 'disconnected', connectionError: event.reason })
          }
        },
      })
      const transport = new SecureTransport(link, {
        identity: { deviceId: identity.deviceId, privateKey: identity.privateKey, publicKey: identity.publicKey },
        host: { deviceId: host.deviceId, identityKey: host.identityKey },
      })
      const core = new RemoteClientCore(transport, 35_000)
      core.onClose(error => {
        if (this.core === core) {
          this.patch({
            connection: 'disconnected',
            connectionError: error?.message ?? '连接已断开。',
            prompting: false,
          })
        }
      })
      await core.connect()
      this.core = core
      this.acp = new AgentAcpClient(core)
      const init = await this.acp.initialize({ clientInfo: { name: 'dsh-web', version: '0.5.19' } }) as {
        capabilities?: unknown
        availableBackends?: unknown
      } | undefined
      const backends = readBackends(init)
      this.patch({ connection: 'connected', backends })
      await this.refreshCatalog()
    } catch (error) {
      this.patch({
        connection: 'failed',
        connectionError: error instanceof Error ? error.message : String(error),
      })
      await this.teardown()
      throw error
    }
  }

  async disconnect(): Promise<void> {
    await this.teardown()
    this.patch({
      connection: 'idle',
      connectionError: undefined,
      backends: [],
      workspaces: [],
      sessions: [],
      activeSessionId: undefined,
      items: [],
      prompting: false,
      promptError: undefined,
      historyLoaded: false,
    })
    this.liveItems = []
    this.historyItems = []
    this.activePath = undefined
    this.activeBackend = undefined
  }

  /** Reload workspace + session catalog for every announced backend. */
  async refreshCatalog(): Promise<void> {
    const acp = this.requireAcp()
    const backends = this.snapshot.backends.length > 0 ? this.snapshot.backends : [undefined]
    const workspaces: WorkspaceEntry[] = []
    const seen = new Set<string>()
    for (const backend of backends) {
      try {
        const items = await acp.listWorkspaces(backend)
        for (const item of items) {
          if (typeof item.path !== 'string' || item.path.length === 0) continue
          const entry: WorkspaceEntry = {
            path: item.path,
            backend: (item.backend as AcpAgentBackend | undefined) ?? backend ?? 'cursor',
            ...(item.title === undefined ? {} : { title: item.title }),
            ...(item.sessionCount === undefined ? {} : { sessionCount: item.sessionCount }),
          }
          // Per-backend queries may project the same workspace more than once.
          const key = `${entry.backend}:${entry.path}`
          if (seen.has(key)) continue
          seen.add(key)
          workspaces.push(entry)
        }
      } catch {
        // A backend without a catalog simply contributes no workspaces.
      }
    }
    this.patch({ workspaces })
    if (this.activePath !== undefined) {
      await this.loadSessions(this.activePath, this.activeBackend).catch(() => undefined)
    }
  }

  async loadSessions(path: string, backend?: AcpAgentBackend): Promise<void> {
    const acp = this.requireAcp()
    this.activePath = path
    this.activeBackend = backend
    const items = await acp.listSessions(path, backend)
    this.patch({
      sessions: items.map(item => ({
        conversationId: item.conversationId,
        title: item.title || item.conversationId,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        backend: backend ?? backendFromSessionId(item.conversationId),
        path,
      })),
    })
  }

  async newSession(cwd: string, backend?: AcpAgentBackend): Promise<void> {
    const acp = this.requireAcp()
    const created = await acp.createSession(cwd, 'agent', backend)
    this.activePath = cwd
    this.activeBackend = backend ?? backendFromSessionId(created.sessionId)
    await this.openSession(created.sessionId, this.activeBackend, cwd, true)
    await this.loadSessions(cwd, this.activeBackend).catch(() => undefined)
  }

  async openSession(sessionId: string, backend?: AcpAgentBackend, path?: string, fresh = false): Promise<void> {
    const acp = this.requireAcp()
    this.sessionAbort?.abort()
    const abort = new AbortController()
    this.sessionAbort = abort
    if (this.stream) {
      await this.stream.close().catch(() => undefined)
      this.stream = undefined
    }
    this.liveItems = []
    this.historyItems = []
    this.patch({
      activeSessionId: sessionId,
      items: [],
      prompting: false,
      promptError: undefined,
      historyLoaded: false,
    })
    const resolvedBackend = backend ?? backendFromSessionId(sessionId)
    this.activeBackend = resolvedBackend
    if (path !== undefined) this.activePath = path

    if (!fresh) {
      // Best effort: make the session live for prompts; history is read-only.
      try {
        await acp.loadSession(sessionId, resolvedBackend, abort.signal)
      } catch (error) {
        if (abort.signal.aborted) return
        if (!(error instanceof RemoteRpcError)) throw error
      }
      try {
        const events = await acp.loadSessionHistory(sessionId, resolvedBackend, abort.signal)
        if (abort.signal.aborted) return
        this.historyItems = foldHistoryEvents(events)
        this.publishItems()
      } catch {
        // History is optional (some backends do not replay); the live stream
        // still renders whatever arrives from now on.
      }
    }
    this.patch({ historyLoaded: true })

    this.stream = await acp.openStream(sessionId, frame => this.onFrame(sessionId, frame), undefined, abort.signal)
  }

  async sendPrompt(text: string): Promise<void> {
    const acp = this.requireAcp()
    const sessionId = this.snapshot.activeSessionId
    if (sessionId === undefined) throw new Error('请先选择会话。')
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    this.patch({ prompting: true, promptError: undefined })
    try {
      await acp.prompt(sessionId, trimmed, undefined, [], this.activeBackend)
    } catch (error) {
      this.patch({ promptError: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      this.patch({ prompting: false })
    }
  }

  async cancelPrompt(): Promise<void> {
    const acp = this.requireAcp()
    const sessionId = this.snapshot.activeSessionId
    if (sessionId === undefined) return
    await acp.cancel(sessionId).catch(() => undefined)
  }

  async respondPermission(approvalId: string, decision: 'allow-once' | 'reject-once' | 'cancel'): Promise<void> {
    const acp = this.requireAcp()
    await acp.respond(approvalId, decision)
    this.liveItems = resolveApproval(this.liveItems, approvalId, decision)
    this.publishItems()
  }

  private onFrame(sessionId: string, frame: AgentAcpFrameData): void {
    if (this.snapshot.activeSessionId !== sessionId) return
    this.liveItems = applyAgentFrame(this.liveItems, frame)
    this.publishItems()
  }

  private publishItems(): void {
    this.patch({ items: mergeHistoryAndLive(this.historyItems, this.liveItems) })
  }

  private patch(partial: Partial<RuntimeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial }
    for (const listener of this.listeners) listener(this.snapshot)
  }

  private requireAcp(): AgentAcpClient {
    if (this.acp === undefined) throw new Error('尚未连接到 Host。')
    return this.acp
  }

  private async teardown(): Promise<void> {
    this.sessionAbort?.abort()
    this.sessionAbort = undefined
    if (this.stream) {
      await this.stream.close().catch(() => undefined)
      this.stream = undefined
    }
    const core = this.core
    this.core = undefined
    this.acp = undefined
    if (core) await core.close().catch(() => undefined)
  }
}

function readBackends(init: unknown): AcpAgentBackend[] {
  if (typeof init !== 'object' || init === null) return []
  const record = init as { availableBackends?: unknown; capabilities?: unknown; backend?: unknown }
  const fromList = Array.isArray(record.availableBackends)
    ? record.availableBackends.filter((value): value is string => typeof value === 'string')
    : []
  if (fromList.length > 0) return fromList
  if (typeof record.backend === 'string') return [record.backend]
  return []
}

function backendFromSessionId(sessionId: string): AcpAgentBackend {
  const prefix = sessionId.split(':')[0]
  return prefix !== undefined && prefix.length > 0 && prefix !== sessionId ? prefix : 'cursor'
}

export { ACP_PROMPT_RPC_TIMEOUT_MS }
