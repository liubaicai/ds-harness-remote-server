/**
 * Session runtime: one browser tab ↔ one Host.
 *
 * Two session domains are supported, selected by what the Host advertises
 * through `harness.transport.describe`:
 *  - native DSH sessions (`harness.remote.*` → `session/*`) — the default
 *    conversation surface of DeepSeek Harness;
 *  - Agent ACP workspaces (`agent.acp.*` → Cursor/Antigravity/Pi/OpenCode/…)
 *    only for backends the Host actually enables.
 */
import { AgentAcpClient, type AcpAgentBackend, type AgentAcpFrameData, type AcpStream } from './acp-client'
import { RemoteClientCore, RemoteRpcError } from './client-core'
import { HarnessClient, type HarnessRemoteSession } from './harness-client'
import { ensureIdentity, WEB_CLIENT_VERSION } from './identity'
import {
  applyAgentFrame,
  foldHistoryEvents,
  foldNativeEvents,
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

export type SessionKind = 'dsh' | 'acp'

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
  kind: SessionKind
  backend?: AcpAgentBackend
  path?: string
  running?: boolean
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed'

export interface RuntimeSnapshot {
  connection: ConnectionState
  connectionError?: string
  /** Native DSH session domain available on the Host. */
  dshAvailable: boolean
  /** ACP backends the Host advertises as enabled/ready. */
  backends: AcpAgentBackend[]
  acpNote?: string
  workspaces: WorkspaceEntry[]
  dshSessions: SessionEntry[]
  sessions: SessionEntry[]
  activeSessionId?: string
  activeKind?: SessionKind
  activePath?: string
  items: ChatItem[]
  prompting: boolean
  promptError?: string
  historyLoaded: boolean
}

type Listener = (snapshot: RuntimeSnapshot) => void

const ACP_BACKENDS = ['cursor', 'antigravity', 'pi', 'opencode', 'claude'] as const

interface HarnessFeatures {
  capabilities: string[]
  remoteGateway: boolean
  acpBackends: AcpAgentBackend[]
}

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

/** Capability discovery: what does this Host actually offer? */
async function describeHarness(core: RemoteClientCore): Promise<HarnessFeatures> {
  let value: unknown
  try {
    value = await core.rpc('harness.transport.describe', {})
  } catch (error) {
    if (error instanceof RemoteRpcError && error.code === 'METHOD_NOT_FOUND') {
      // Legacy Host: assume the native gateway exists but no ACP backends.
      return { capabilities: ['harness.remote.v1'], remoteGateway: true, acpBackends: [] }
    }
    throw error
  }
  const record = isRecord(value) ? value : {}
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.filter((item): item is string => typeof item === 'string')
    : []
  const workspaceTypes = Array.isArray(record.workspaceTypes) ? record.workspaceTypes : undefined
  const remoteGateway = capabilities.includes('harness.remote.v1') || capabilities.includes('harness.remote.v3')
  const acpBackends = ACP_BACKENDS.filter(backend => {
    const capability = `agent.acp.${backend}.v1`
    if (!capabilities.includes(capability)) return false
    if (workspaceTypes === undefined) return true
    const entries = workspaceTypes.filter(item => isRecord(item) && item.id === backend)
    return entries.length === 1 && entries[0]?.capability === capability && entries[0]?.available === true
  })
  return { capabilities, remoteGateway, acpBackends }
}

export function explainError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code = (error as { code?: string }).code
  if (code === 'METHOD_NOT_ALLOWED' || /disabled or unavailable/i.test(error.message)) {
    return `Host 未启用该 Agent 后端（${error.message}）。如需 Agent 会话请在 Host 插件配置 acp.enabled / acp.backends；DSH 会话不受影响。`
  }
  if (code === 'SESSION_NOT_FOUND') return '会话不存在或已被清理。'
  if (code === 'HOST_OFFLINE') return 'Host 离线，请检查 Host 插件后重连。'
  if (code === 'CAPABILITY_NOT_SUPPORTED') return 'Host 不支持该操作。'
  return error.message
}

export class SessionRuntime {
  private core?: RemoteClientCore
  private acp?: AgentAcpClient
  private harness?: HarnessClient
  private stream?: AcpStream
  private snapshot: RuntimeSnapshot = {
    connection: 'idle',
    dshAvailable: false,
    backends: [],
    workspaces: [],
    dshSessions: [],
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
    this.patch({ connection: 'connecting', connectionError: undefined, acpNote: undefined })
    try {
      const identity = await ensureIdentity()
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
          this.patch({ connection: 'disconnected', connectionError: error?.message ?? '连接已断开。', prompting: false })
        }
      })
      await core.connect()
      this.core = core

      // Capability discovery drives everything below — never assume a backend.
      const features = await describeHarness(core)
      if (features.remoteGateway) this.harness = new HarnessClient(core)

      let acpNote: string | undefined
      if (features.acpBackends.length > 0) {
        this.acp = new AgentAcpClient(core)
        // Initialize against an explicitly discovered backend; hosts route a
        // bare `initialize` to their default adapter which may be disabled.
        let initialized = false
        for (const backend of features.acpBackends) {
          try {
            await this.acp.initialize({ backend })
            initialized = true
            break
          } catch (error) {
            acpNote = explainError(error)
          }
        }
        if (!initialized) this.acp = undefined
      }

      this.patch({
        connection: 'connected',
        dshAvailable: features.remoteGateway,
        backends: this.acp ? features.acpBackends : [],
        acpNote,
      })
      await this.refreshCatalog()
    } catch (error) {
      this.patch({ connection: 'failed', connectionError: explainError(error) })
      await this.teardown()
      throw error
    }
  }

  async disconnect(): Promise<void> {
    await this.teardown()
    this.patch({
      connection: 'idle',
      connectionError: undefined,
      dshAvailable: false,
      backends: [],
      acpNote: undefined,
      workspaces: [],
      dshSessions: [],
      sessions: [],
      activeSessionId: undefined,
      activeKind: undefined,
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

  /** Reload both catalogs from whatever the Host offers. */
  async refreshCatalog(): Promise<void> {
    if (this.harness !== undefined) {
      try {
        const items = await this.harness.listSessions()
        this.patch({ dshSessions: items.map(item => this.toDshEntry(item)) })
      } catch {
        // Native catalog unavailable; keep whatever else is connected.
      }
    }
    if (this.acp !== undefined && this.snapshot.backends.length > 0) {
      const workspaces: WorkspaceEntry[] = []
      const seen = new Set<string>()
      for (const backend of this.snapshot.backends) {
        try {
          const items = await this.acp.listWorkspaces(backend)
          for (const item of items) {
            if (typeof item.path !== 'string' || item.path.length === 0) continue
            const entry: WorkspaceEntry = {
              path: item.path,
              backend: (item.backend as AcpAgentBackend | undefined) ?? backend,
              ...(item.title === undefined ? {} : { title: item.title }),
              ...(item.sessionCount === undefined ? {} : { sessionCount: item.sessionCount }),
            }
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
      if (this.snapshot.activeKind === 'acp' && this.activePath !== undefined) {
        await this.loadSessions(this.activePath, this.activeBackend).catch(() => undefined)
      }
    }
  }

  private toDshEntry(item: HarnessRemoteSession): SessionEntry {
    return {
      conversationId: item.sessionId,
      title: item.title || (item.blank ? '新对话' : item.sessionId),
      createdAt: item.updatedAt,
      updatedAt: item.updatedAt,
      kind: 'dsh',
      ...(item.cwd === undefined ? {} : { path: item.cwd }),
      running: item.running,
    }
  }

  /** ACP: list sessions for one workspace. */
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
        kind: 'acp' as const,
        backend: backend ?? backendFromSessionId(item.conversationId),
        path,
      })),
    })
  }

  /** New native DSH session on the Host. */
  async newDshSession(cwd: string): Promise<void> {
    const harness = this.requireHarness()
    const created = await harness.createSession(cwd)
    await this.openDshSession(created.sessionId, cwd, true)
    await this.refreshCatalog().catch(() => undefined)
  }

  /** New ACP session for one agent backend. */
  async newSession(cwd: string, backend?: AcpAgentBackend): Promise<void> {
    const acp = this.requireAcp()
    const created = await acp.createSession(cwd, 'agent', backend)
    this.activePath = cwd
    this.activeBackend = backend ?? backendFromSessionId(created.sessionId)
    await this.openSession(created.sessionId, this.activeBackend, cwd, true)
    await this.loadSessions(cwd, this.activeBackend).catch(() => undefined)
  }

  /** Open a native DSH session: snapshot history + live follow. */
  async openDshSession(sessionId: string, cwd?: string, fresh = false): Promise<void> {
    const harness = this.requireHarness()
    this.sessionAbort?.abort()
    const abort = new AbortController()
    this.sessionAbort = abort
    await this.stream?.close().catch(() => undefined)
    this.stream = undefined
    await harness.closeFollow(false).catch(() => undefined)
    this.liveItems = []
    this.historyItems = []
    this.patch({
      activeSessionId: sessionId,
      activeKind: 'dsh',
      items: [],
      prompting: false,
      promptError: undefined,
      historyLoaded: false,
    })
    this.activePath = cwd
    this.activeBackend = undefined
    const snapshot = await harness.follow(sessionId, entries => {
      if (abort.signal.aborted) return
      this.liveItems = foldNativeEvents(this.liveItems, entries as unknown[])
      this.publishItems()
    }, abort.signal)
    if (abort.signal.aborted) return
    if (!fresh) this.historyItems = foldHistoryEvents(snapshot.entries as unknown[])
    this.publishItems()
    this.patch({ historyLoaded: true })
  }

  /** Open an ACP session (agent backend). */
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
      activeKind: 'acp',
      items: [],
      prompting: false,
      promptError: undefined,
      historyLoaded: false,
    })
    const resolvedBackend = backend ?? backendFromSessionId(sessionId)
    this.activeBackend = resolvedBackend
    if (path !== undefined) this.activePath = path

    if (!fresh) {
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
        // History is optional; live stream still renders from now on.
      }
    }
    this.patch({ historyLoaded: true })
    this.stream = await acp.openStream(sessionId, frame => this.onFrame(sessionId, frame), undefined, abort.signal)
  }

  async sendPrompt(text: string): Promise<void> {
    const sessionId = this.snapshot.activeSessionId
    if (sessionId === undefined) throw new Error('请先选择会话。')
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    this.patch({ prompting: true, promptError: undefined })
    try {
      if (this.snapshot.activeKind === 'dsh') {
        await this.requireHarness().prompt(sessionId, trimmed)
      } else {
        await this.requireAcp().prompt(sessionId, trimmed, undefined, [], this.activeBackend)
      }
    } catch (error) {
      this.patch({ promptError: explainError(error) })
      throw error
    } finally {
      this.patch({ prompting: false })
    }
  }

  async cancelPrompt(): Promise<void> {
    const sessionId = this.snapshot.activeSessionId
    if (sessionId === undefined) return
    try {
      if (this.snapshot.activeKind === 'dsh') await this.requireHarness().cancel(sessionId)
      else await this.requireAcp().cancel(sessionId)
    } catch { /* best effort */ }
  }

  async respondPermission(approvalId: string, decision: 'allow-once' | 'reject-once' | 'cancel'): Promise<void> {
    // ACP approvals; native Harness approvals ride the events stream (later).
    if (this.acp === undefined) return
    await this.acp.respond(approvalId, decision)
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
    if (this.acp === undefined) throw new Error('Host 未启用 Agent ACP 后端。')
    return this.acp
  }

  private requireHarness(): HarnessClient {
    if (this.harness === undefined) throw new Error('Host 不支持原生 DSH 会话。')
    return this.harness
  }

  private async teardown(): Promise<void> {
    this.sessionAbort?.abort()
    this.sessionAbort = undefined
    if (this.stream) {
      await this.stream.close().catch(() => undefined)
      this.stream = undefined
    }
    if (this.harness) {
      await this.harness.close().catch(() => undefined)
      this.harness = undefined
    }
    const core = this.core
    this.core = undefined
    this.acp = undefined
    if (core) await core.close().catch(() => undefined)
  }
}

function backendFromSessionId(sessionId: string): AcpAgentBackend {
  const prefix = sessionId.split(':')[0]
  return prefix !== undefined && prefix.length > 0 && prefix !== sessionId ? prefix : 'cursor'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
