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
import { HarnessClient, deriveSessionTitle, isSubagentSession, type HarnessRemoteSession } from './harness-client'
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
  /** Raw parent link (also set on forks — not a routing hint by itself). */
  parentSessionId?: string
  /** Explicit `origin: 'subagent'` — selects the durable parent address form. */
  subagent?: boolean
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

/** Bound on older-history pages fetched after the (deliberately small) follow snapshot. */
const MAX_HISTORY_BACKFILL_PAGES = 6

/** Oldest native event seq in a page — the `beforeSeq` cursor for the next page. */
function oldestSeq(entries: ReadonlyArray<{ event?: { seq?: unknown } }>): number | undefined {
  let oldest: number | undefined
  for (const entry of entries) {
    const seq = entry.event?.seq
    if (typeof seq === 'number' && (oldest === undefined || seq < oldest)) oldest = seq
  }
  return oldest
}

interface HarnessFeatures {
  capabilities: string[]
  remoteGateway: boolean
  /** Present when the Host advertises `harness.remote.v3` (assistant-stream frames). */
  sessionFormat?: 3
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
  const remoteV3 = capabilities.includes('harness.remote.v3')
  const remoteGateway = capabilities.includes('harness.remote.v1') || remoteV3
  const acpBackends = ACP_BACKENDS.filter(backend => {
    const capability = `agent.acp.${backend}.v1`
    if (!capabilities.includes(capability)) return false
    if (workspaceTypes === undefined) return true
    const entries = workspaceTypes.filter(item => isRecord(item) && item.id === backend)
    return entries.length === 1 && entries[0]?.capability === capability && entries[0]?.available === true
  })
  return { capabilities, remoteGateway, ...(remoteV3 ? { sessionFormat: 3 as const } : {}), acpBackends }
}

/** A cancelled request (session switch / disconnect) is not a failure. */
function isAbortError(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code
  if (code === 'RPC_ABORTED' || code === 'CANCELLED' || code === 'ABORT_ERR') return true
  const name = (error as { name?: string } | undefined)?.name
  if (name === 'AbortError') return true
  return error instanceof Error && /\bwas aborted\b|aborted|abort/i.test(error.message)
}

export function explainError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code = (error as { code?: string }).code
  if (code === 'RPC_ABORTED' || code === 'CANCELLED') return ''
  if (code === 'METHOD_NOT_ALLOWED' || /disabled or unavailable/i.test(error.message)) {
    return `Host 未启用该 Agent 后端（${error.message}）。如需 Agent 会话请在 Host 插件配置 acp.enabled / acp.backends；DSH 会话不受影响。`
  }
  if (/durable parent address|subagent sessions/i.test(error.message)) {
    return '该会话是子代理会话，需要通过父会话地址打开。已自动重试父地址；若仍失败请从父会话进入。'
  }
  if (/oversized harness remote frame/i.test(error.message)) {
    return '会话历史超过 Host 的单帧上限。已自动缩小快照窗口重试；若仍失败，请让 Host 插件升级以支持分片传输。'
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
  /** Last connected Host — the target of silent auto-reconnect. */
  private host?: HostSummary
  /** Set by an explicit disconnect; suppresses auto-reconnect. */
  private manualDisconnect = true
  /** True while teardown runs — a close caused by us is not a drop. */
  private tearingDown = false
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectAttempts = 0

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
    this.clearReconnect()
    await this.disconnect()
    this.manualDisconnect = false
    this.host = host
    await this.openConnection(host, false)
  }

  /** Establish the encrypted carrier and discover Host capabilities. */
  private async openConnection(host: HostSummary, silent: boolean): Promise<void> {
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
          this.handleConnectionLost(event.reason ?? '连接已断开。')
        },
      })
      const transport = new SecureTransport(link, {
        identity: { deviceId: identity.deviceId, privateKey: identity.privateKey, publicKey: identity.publicKey },
        host: { deviceId: host.deviceId, identityKey: host.identityKey },
      })
      const core = new RemoteClientCore(transport, 35_000)
      core.onClose(error => {
        if (this.core === core) this.handleConnectionLost(error?.message ?? '连接已断开。')
      })
      await core.connect()
      this.core = core

      // Compact history keeps session snapshots under the single-frame limit
      // (the Host truncates tool output/text); without it large sessions fail
      // to load. Same call the Android client makes; harmless on old Hosts.
      await core.rpc('remote.history.configure', { compact: true }).catch(() => undefined)

      // Capability discovery drives everything below — never assume a backend.
      const features = await describeHarness(core)
      if (features.remoteGateway) this.harness = new HarnessClient(core, features.sessionFormat)

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
      if (silent) {
        // A background reconnect attempt failed: keep retrying quietly instead
        // of flashing a failure banner at the user.
        await this.teardown()
        this.scheduleReconnect()
        throw error
      }
      this.patch({ connection: 'failed', connectionError: explainError(error) })
      await this.teardown()
      throw error
    }
  }

  /** A transport that dropped on its own: reconnect silently, keep the UI. */
  private handleConnectionLost(reason: string): void {
    if (this.tearingDown) return
    if (this.manualDisconnect) {
      this.patch({ connection: 'disconnected', connectionError: reason })
      return
    }
    this.patch({ connection: 'connecting', connectionError: undefined, prompting: false })
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.manualDisconnect || this.host === undefined || this.reconnectTimer !== undefined) return
    const attempt = this.reconnectAttempts
    // 1s, 2s, 4s, 8s, capped at 10s.
    const delay = Math.min(1000 * 2 ** attempt, 10_000)
    this.reconnectAttempts = attempt + 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.reconnect()
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.reconnectAttempts = 0
  }

  /** Silent reconnect: restore the carrier and reopen the last session. */
  private reconnect(): void {
    const host = this.host
    if (this.manualDisconnect || host === undefined) return
    const sessionId = this.snapshot.activeSessionId
    const kind = this.snapshot.activeKind
    void (async () => {
      try {
        await this.teardown()
        await this.openConnection(host, true)
        this.reconnectAttempts = 0
        // Reopen whatever was on screen before the drop.
        if (sessionId !== undefined) {
          const entry = this.snapshot.dshSessions.find(item => item.conversationId === sessionId)
          if (kind === 'dsh') await this.openDshSession(sessionId, entry?.path ?? this.activePath, false, entry).catch(() => undefined)
          else if (kind === 'acp') await this.openSession(sessionId, this.activeBackend, this.activePath).catch(() => undefined)
        }
      } catch {
        // openConnection already scheduled the next attempt.
      }
    })()
  }

  async disconnect(): Promise<void> {
    this.manualDisconnect = true
    this.clearReconnect()
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
      title: deriveSessionTitle(item),
      createdAt: item.updatedAt,
      updatedAt: item.updatedAt,
      kind: 'dsh',
      ...(item.cwd === undefined ? {} : { path: item.cwd }),
      running: item.running,
      ...(item.parentSessionId === undefined ? {} : { parentSessionId: item.parentSessionId }),
      // Only an explicit subagent origin selects the durable parent address;
      // forks carry parentSessionId too but stay on the plain session form.
      ...(isSubagentSession(item) ? { subagent: true } : {}),
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
  async openDshSession(sessionId: string, cwd?: string, fresh = false, entry?: Pick<SessionEntry, 'parentSessionId' | 'subagent'>): Promise<void> {
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
    try {
      // Subagent sessions need their durable parent address; forks (parent link
      // without the subagent origin) stay on the plain session form unless the
      // Host insists — then retry once through the parent address.
      const parent = entry?.subagent ? entry.parentSessionId : undefined
      const snapshot = await harness.follow(sessionId, entries => {
        if (abort.signal.aborted) return
        this.liveItems = foldNativeEvents(this.liveItems, entries as unknown[])
        this.publishItems()
      }, abort.signal, parent).catch(async error => {
        const wantsParent = parent === undefined
          && entry?.parentSessionId !== undefined
          && /durable parent|subagent/i.test(error instanceof Error ? error.message : '')
        if (!wantsParent || abort.signal.aborted) throw error
        return harness.follow(sessionId, entries => {
          if (abort.signal.aborted) return
          this.liveItems = foldNativeEvents(this.liveItems, entries as unknown[])
          this.publishItems()
        }, abort.signal, entry.parentSessionId)
      })
      if (abort.signal.aborted) return
      if (!fresh) {
        // The follow snapshot is deliberately small (the Host rejects oversized
        // single frames). Backfill older history page by page — each page is a
        // plain RPC response, so long sessions never need one giant frame.
        let entries = snapshot.entries
        let hasMore = snapshot.hasMore
        let oldest = oldestSeq(entries)
        let pages = 0
        const parentForPages = entry?.subagent ? entry.parentSessionId : undefined
        while (hasMore && oldest !== undefined && pages < MAX_HISTORY_BACKFILL_PAGES && !abort.signal.aborted) {
          try {
            const page = await harness.pageHistory(sessionId, oldest, 60, parentForPages)
            if (page.entries.length === 0) break
            entries = [...page.entries, ...entries]
            hasMore = page.hasMore
            const nextOldest = oldestSeq(page.entries)
            if (nextOldest === undefined || nextOldest >= oldest) break
            oldest = nextOldest
            pages += 1
          } catch {
            break
          }
        }
        this.historyItems = foldHistoryEvents(entries as unknown[])
      }
      this.publishItems()
      this.patch({ historyLoaded: true })
    } catch (error) {
      // Superseded by another open (or by disconnect): a cancelled request is
      // normal, never a user-facing failure.
      if (abort.signal.aborted || isAbortError(error)) return
      throw error
    }
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
    try {
      this.stream = await acp.openStream(sessionId, frame => this.onFrame(sessionId, frame), undefined, abort.signal)
    } catch (error) {
      // Superseded by another open (or by disconnect): not a failure.
      if (abort.signal.aborted || isAbortError(error)) return
      throw error
    }
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
    this.tearingDown = true
    try {
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
    } finally {
      this.tearingDown = false
    }
  }
}

function backendFromSessionId(sessionId: string): AcpAgentBackend {
  const prefix = sessionId.split(':')[0]
  return prefix !== undefined && prefix.length > 0 && prefix !== sessionId ? prefix : 'cursor'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
