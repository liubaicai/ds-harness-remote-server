/**
 * DSH 会话页 —— 复刻 DeepSeek Harness 原生会话界面。
 *
 * 布局（对照 DSH 客户端截图）：
 *  左栏：品牌头 / 新建对话 / 工作区分组会话树（相对时间）；
 *  右栏：标题栏 · 消息流（用户灰气泡右对齐，AI 无气泡 + 状态行 + 元信息）
 *        · 思考折叠卡 · 工具过程卡 · 权限卡 · 圆角输入卡 + 加密提示。
 */
import { App, Button, Input, Modal, Select, Space, Tooltip } from 'antd'
import {
  ArrowUpOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  CopyOutlined,
  FileAddOutlined,
  FolderOutlined,
  LinkOutlined,
  LogoutOutlined,
  PlusCircleOutlined,
  ReloadOutlined,
  RocketOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { navigate } from './nav'
import { Markdown } from './markdown'
import { ThemeToggle } from './ThemeToggle'
import {
  SessionRuntime,
  explainError,
  type HostSummary,
  type RuntimeSnapshot,
  type SessionEntry,
  type WorkspaceEntry,
} from './remote/runtime'
import type { AcpAgentBackend } from './remote/acp-client'
import type { ChatItem } from './remote/projection'
import './sessions.css'

const backendLabels: Record<string, string> = {
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  pi: 'Pi',
  opencode: 'OpenCode',
  claude: 'Claude',
}
const backendLabel = (backend: string) => backendLabels[backend] ?? backend

const QUICK_PROMPTS = [
  '帮我看看这个项目的整体结构',
  '解释一下当前报错的原因并给出修复方案',
  '继续上一次的任务',
  '为这段代码补充单元测试',
]

function fmtClock(value: number): string {
  if (!value) return ''
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function fmtRelative(value: number): string {
  if (!value) return ''
  const diff = Math.max(0, Date.now() - value)
  const minute = 60_000, hour = 3_600_000, day = 86_400_000
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)}m`
  if (diff < day) return `${Math.floor(diff / hour)}h`
  return `${Math.floor(diff / day)}d`
}

function useRuntime() {
  const runtimeRef = useRef<SessionRuntime>()
  if (runtimeRef.current === undefined) runtimeRef.current = new SessionRuntime()
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(runtimeRef.current.getSnapshot())
  useEffect(() => runtimeRef.current!.subscribe(setSnapshot), [])
  return { runtime: runtimeRef.current, snapshot }
}

export function SessionsPage({ onSignedOut }: { onSignedOut: () => void }) {
  const { message } = App.useApp()
  const { runtime, snapshot } = useRuntime()
  const [hosts, setHosts] = useState<HostSummary[]>()
  const [hostId, setHostId] = useState<string>()
  const [draft, setDraft] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [newKind, setNewKind] = useState<'dsh' | 'acp'>('dsh')
  const [newBackend, setNewBackend] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [quickOpen, setQuickOpen] = useState(false)
  const autoTried = useRef(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  const loadHosts = useCallback(async () => {
    try {
      const items = await SessionRuntime.listHosts()
      setHosts(items)
      const requested = new URLSearchParams(window.location.search).get('host')
      setHostId(current => current ?? (requested && items.some(item => item.deviceId === requested && item.online) ? requested : undefined)
        ?? items.find(item => item.online)?.deviceId)
    } catch (error) {
      if (error instanceof Error && /ACCOUNT_AUTH_REQUIRED|HTTP 401/.test(error.message)) onSignedOut()
    }
  }, [onSignedOut])

  useEffect(() => { void loadHosts() }, [loadHosts])
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [snapshot.items])

  const host = useMemo(() => hosts?.find(item => item.deviceId === hostId), [hosts, hostId])
  const activeSession = useMemo(
    () => snapshot.dshSessions.concat(snapshot.sessions).find(item => item.conversationId === snapshot.activeSessionId),
    [snapshot.dshSessions, snapshot.sessions, snapshot.activeSessionId],
  )
  // Native DSH sessions grouped by workspace (cwd), like the Host's own UI.
  const dshGroups = useMemo(() => {
    const groups = new Map<string, SessionEntry[]>()
    for (const entry of snapshot.dshSessions) {
      const key = entry.path ?? ''
      const list = groups.get(key)
      if (list) list.push(entry)
      else groups.set(key, [entry])
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [snapshot.dshSessions])

  const connect = useCallback(async () => {
    if (!host) return
    try { await runtime.connect(host) } catch { /* snapshot carries the error */ }
  }, [runtime, host])

  // Entering from the device list (or opening the page) auto-connects the
  // selected Host and loads its session catalog — no extra click.
  useEffect(() => {
    if (autoTried.current || !host || !host.online) return
    if (snapshot.connection !== 'idle') return
    autoTried.current = true
    void connect()
  }, [host, snapshot.connection, connect])

  const openSession = useCallback(async (entry: SessionEntry) => {
    try {
      if (entry.kind === 'dsh') await runtime.openDshSession(entry.conversationId, entry.path, false, entry)
      else await runtime.openSession(entry.conversationId, entry.backend, entry.path)
    } catch (error) {
      void message.error(explainError(error))
    }
  }, [runtime, message])

  const openWorkspace = useCallback(async (workspace: WorkspaceEntry) => {
    try {
      await runtime.loadSessions(workspace.path, workspace.backend)
    } catch (error) {
      void message.error(explainError(error))
    }
  }, [runtime, message])

  const createSession = useCallback(async () => {
    const path = newPath.trim()
    if (path.length === 0) return
    setCreating(true)
    try {
      if (newKind === 'dsh') await runtime.newDshSession(path)
      else await runtime.newSession(path, (newBackend ?? snapshot.backends[0]) as AcpAgentBackend | undefined)
      setNewOpen(false)
      setNewPath('')
    } catch (error) {
      void message.error(explainError(error))
    } finally {
      setCreating(false)
    }
  }, [runtime, newPath, newKind, newBackend, snapshot.backends, message])

  const send = useCallback(async () => {
    const text = draft
    if (text.trim().length === 0 || snapshot.prompting) return
    setDraft('')
    try {
      await runtime.sendPrompt(text)
    } catch (error) {
      void message.error(explainError(error))
    }
  }, [runtime, draft, snapshot.prompting, message])

  const copyText = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => message.success('已复制'))
  }, [message])

  const connectionChip = snapshot.connection === 'connected'
    ? { cls: 'is-on', label: '已连接' }
    : snapshot.connection === 'connecting'
      ? { cls: 'is-busy', label: '握手中…' }
      : snapshot.connection === 'disconnected'
        ? { cls: '', label: '已断开' }
        : snapshot.connection === 'failed'
          ? { cls: '', label: '连接失败' }
          : { cls: '', label: '未连接' }

  return <div className="sessions-shell">
    {/* ── 侧栏 ── */}
    <aside className="dsh-sidebar">
      <div className="dsh-sidebar-head">
        <a className="dsh-brand" href="/" aria-label="返回首页">
          <img src="/brand-whale.webp" alt="" />
          <span className="dsh-brand-name">deepseek</span>
          <span className="dsh-brand-pill">HARNESS</span>
        </a>
        <div className="dsh-sidebar-actions">
          <Tooltip title="刷新设备"><button className="dsh-icon-btn" onClick={() => void loadHosts()}><ReloadOutlined /></button></Tooltip>
          <Tooltip title="切换主题"><span><ThemeToggle /></span></Tooltip>
        </div>
      </div>

      <button className="dsh-new-chat" onClick={() => {
        setNewPath(snapshot.workspaces[0]?.path ?? snapshot.dshSessions[0]?.path ?? '')
        setNewKind(snapshot.dshAvailable ? 'dsh' : 'acp')
        setNewBackend(snapshot.backends[0])
        setNewOpen(true)
      }} disabled={snapshot.connection !== 'connected'}>
        <PlusCircleOutlined /> 新建对话
      </button>

      <div className="dsh-host-row">
        <Select
          className="dsh-host-select"
          size="small"
          placeholder="选择在线 Host"
          value={hostId}
          onChange={setHostId}
          options={(hosts ?? []).map(item => ({
            value: item.deviceId,
            label: item.online ? item.name : `${item.name}（离线）`,
            disabled: !item.online,
          }))}
        />
        <Button size="small" type={snapshot.connection === 'connected' ? 'default' : 'primary'}
          onClick={() => void connect()} disabled={!host || snapshot.connection === 'connecting'}
          loading={snapshot.connection === 'connecting'}>
          {snapshot.connection === 'connected' ? '重连' : '连接'}
        </Button>
      </div>

      <div className="dsh-section-head">
        <span>{snapshot.dshAvailable ? 'DSH 会话' : '工作区'}</span>
        <span className="dsh-section-head-actions">
          <button className="dsh-icon-btn" onClick={() => void runtime.refreshCatalog().catch(() => undefined)} title="刷新目录"><ReloadOutlined /></button>
          <button className="dsh-icon-btn" onClick={() => {
            setNewPath(snapshot.workspaces[0]?.path ?? snapshot.dshSessions[0]?.path ?? '')
            setNewKind(snapshot.dshAvailable ? 'dsh' : 'acp')
            setNewBackend(snapshot.backends[0])
            setNewOpen(true)
          }} title="新建会话"><FileAddOutlined /></button>
        </span>
      </div>

      <div className="dsh-side-scroll">
        {/* 原生 DSH 会话：按工作区分组 */}
        {snapshot.dshAvailable && dshGroups.map(([path, entries]) => {
          const key = `dsh:${path}`
          const open = !collapsed[key]
          return <div className="dsh-ws-group" key={key}>
            <button className="dsh-ws-head" onClick={() => setCollapsed(current => ({ ...current, [key]: !current[key] }))}>
              <FolderOutlined />
              <span className="dsh-ws-name">{path ? basename(path) : '其他会话'}</span>
              <span className={`dsh-ws-chevron ${open ? 'is-open' : ''}`}>⌄</span>
            </button>
            {open && entries.map(entry => (
              <button key={entry.conversationId}
                className={`dsh-session-row ${snapshot.activeSessionId === entry.conversationId ? 'is-active' : ''}`}
                onClick={() => void openSession(entry)}>
                <span className="dsh-session-title">
                  {entry.title || '新对话'}
                  {entry.subagent && <span className="dsh-sub-tag">子代理</span>}
                </span>
                <span className="dsh-session-time">{fmtRelative(entry.updatedAt || entry.createdAt)}</span>
              </button>
            ))}
          </div>
        })}
        {snapshot.dshAvailable && dshGroups.length === 0 && snapshot.workspaces.length === 0 && (
          <div className="dsh-empty"><div className="dsh-empty-sub">Host 上暂无 DSH 会话，点上方 ＋ 新建。</div></div>
        )}
        {/* Agent ACP 工作区 */}
        {snapshot.workspaces.length > 0 && <div className="dsh-section-head" style={{ paddingTop: 10 }}><span>Agent 工作区</span></div>}
        {snapshot.workspaces.length === 0 && snapshot.connection === 'connected' && !snapshot.dshAvailable
          ? <div className="dsh-empty"><div className="dsh-empty-sub">{snapshot.acpNote ?? 'Host 未提供会话能力。'}</div></div>
          : snapshot.workspaces.length === 0 && snapshot.connection !== 'connected'
            ? <div className="dsh-empty"><div className="dsh-empty-sub">连接 Host 后显示工作区与会话</div></div>
            : groupWorkspaces(snapshot.workspaces).map(group => {
            const open = !collapsed[`${group.backend}:${group.path}`]
            return <div className="dsh-ws-group" key={`${group.backend}:${group.path}`}>
              <button className="dsh-ws-head" onClick={() => {
                const key = `${group.backend}:${group.path}`
                setCollapsed(current => ({ ...current, [key]: !current[key] }))
                if (open) void openWorkspace(group).catch(() => undefined)
              }}>
                <FolderOutlined />
                <span className="dsh-ws-name">{group.title ?? basename(group.path)}</span>
                <span className={`dsh-ws-chevron ${open ? 'is-open' : ''}`}>⌄</span>
              </button>
              {open && snapshot.sessions
                .filter(item => item.path === group.path && item.backend === group.backend)
                .map(entry => (
                  <button key={entry.conversationId}
                    className={`dsh-session-row ${snapshot.activeSessionId === entry.conversationId ? 'is-active' : ''}`}
                    onClick={() => void openSession(entry)}>
                    <span className="dsh-session-title">{entry.title || '新对话'}</span>
                    <span className="dsh-session-time">{fmtRelative(entry.updatedAt || entry.createdAt)}</span>
                  </button>
                ))}
            </div>
          })}
      </div>

      <div className="dsh-sidebar-foot">
        <button className="dsh-foot-btn" onClick={() => navigate('/app/remote')}><LinkOutlined /> 设备管理</button>
        <button className="dsh-foot-btn" onClick={() => navigate('/app/remote')}><ClockCircleOutlined /> 连接历史</button>
        <button className="dsh-foot-btn" onClick={onSignedOut}><LogoutOutlined /> 退出</button>
      </div>
    </aside>

    {/* ── 聊天主栏 ── */}
    <main className="dsh-main">
      <header className="dsh-chat-head">
        <h1 className="dsh-chat-title">{activeSession?.title ?? (snapshot.activeSessionId ? '新对话' : 'Web 会话')}</h1>
        <span className={`dsh-status-chip ${connectionChip.cls}`}><span className="dot" />{connectionChip.label}</span>
        {snapshot.backends.map(backend => <span key={backend} className="dsh-status-chip">{backendLabel(backend)}</span>)}
        <Tooltip title="新建对话"><button className="dsh-icon-btn" onClick={() => {
          setNewPath(snapshot.workspaces[0]?.path ?? snapshot.dshSessions[0]?.path ?? '')
          setNewKind(snapshot.dshAvailable ? 'dsh' : 'acp')
          setNewBackend(snapshot.backends[0])
          setNewOpen(true)
        }}><PlusCircleOutlined /></button></Tooltip>
      </header>

      <div className="dsh-chat-scroll">
        {snapshot.items.length === 0
          ? <div className="dsh-empty">
            <ThunderboltOutlined style={{ fontSize: 30, opacity: 0.35 }} />
            <div className="dsh-empty-title">{snapshot.activeSessionId ? '开始对话' : '选择或新建一个会话'}</div>
            <div className="dsh-empty-sub">
              {snapshot.activeSessionId
                ? '输入第一条消息，回复将经 Noise IK 端到端加密通道流式返回。'
                : '从左侧工作区打开历史会话，或点击「新建对话」创建。'}
            </div>
          </div>
          : <div className="dsh-chat-column">
            {snapshot.items.map(item => (
              <ChatRow key={item.id} item={item} onCopy={copyText}
                onDecision={(approvalId, decision) => void runtime.respondPermission(approvalId, decision)
                  .catch(err => message.error(String(err)))} />
            ))}
            {snapshot.prompting && <div className="dsh-msg"><div className="dsh-turn-status is-live">生成中<span className="dsh-streaming-dots"><i /><i /><i /></span></div></div>}
            <div ref={bottomRef} />
          </div>}
        {snapshot.promptError && <div className="dsh-error-bar">{snapshot.promptError}</div>}
      </div>

      <div className="dsh-composer-wrap">
        {snapshot.connection !== 'connected' && (
          <div className="dsh-connect-hint">
            <span>{snapshot.connectionError ?? '连接 Host 后即可开始对话。'}</span>
          </div>
        )}
        <div className="dsh-composer">
          <textarea
            ref={composerRef}
            rows={1}
            placeholder="输入消息..."
            value={draft}
            disabled={!snapshot.activeSessionId || snapshot.prompting}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
            }}
          />
          <div className="dsh-composer-row">
            <button className="dsh-round-btn" title="添加附件（即将支持）" disabled><PlusCircleOutlined /></button>
            <div style={{ position: 'relative' }}>
              <button className="dsh-pill-btn is-soft" onClick={() => setQuickOpen(open => !open)}>
                <ThunderboltOutlined /> 快捷提示词
              </button>
              {quickOpen && (
                <div style={{
                  position: 'absolute', bottom: 42, left: 0, zIndex: 20, minWidth: 220,
                  background: 'var(--color-surface)', border: '1px solid var(--color-border)',
                  borderRadius: 12, padding: 6, boxShadow: 'var(--shadow-surface)',
                }}>
                  {QUICK_PROMPTS.map(prompt => (
                    <button key={prompt} className="dsh-session-row" style={{ padding: '8px 10px' }}
                      onClick={() => {
                        setDraft(prompt)
                        setQuickOpen(false)
                        composerRef.current?.focus()
                      }}>{prompt}</button>
                  ))}
                </div>
              )}
            </div>
            <span className="dsh-pill-btn" style={{ cursor: 'default' }}>
              {snapshot.activeKind === 'dsh'
                ? '✦ DSH'
                : `✦ ${backendLabel(activeSession?.backend ?? snapshot.backends[0] ?? 'agent')}`}
            </span>
            {snapshot.prompting
              ? <button className="dsh-send-btn is-stop" title="停止" onClick={() => void runtime.cancelPrompt()}>■</button>
              : <button className="dsh-send-btn" title="发送" disabled={!snapshot.activeSessionId || draft.trim().length === 0} onClick={() => void send()}><ArrowUpOutlined /></button>}
          </div>
        </div>
        <div className="dsh-composer-note">对话全程加密，远程操作受 DeepSeek Harness 权限控制。</div>
      </div>
    </main>

    <Modal title="新建会话" open={newOpen} onCancel={() => setNewOpen(false)} onOk={() => void createSession()} confirmLoading={creating} okText="创建" cancelText="取消">
      <Space direction="vertical" style={{ width: '100%' }}>
        {snapshot.dshAvailable && snapshot.backends.length > 0 && (
          <>
            <span>会话类型</span>
            <Select
              style={{ width: '100%' }}
              value={newKind}
              onChange={value => setNewKind(value)}
              options={[
                { value: 'dsh', label: 'DSH 会话' },
                { value: 'acp', label: 'Agent 会话' },
              ]}
            />
          </>
        )}
        <span>工作目录（Host 上已存在的绝对路径）</span>
        <Input value={newPath} onChange={event => setNewPath(event.target.value)} placeholder="/home/user/project" />
        {newKind === 'acp' && (
          <>
            <span>后端</span>
            <Select
              style={{ width: '100%' }}
              value={newBackend ?? snapshot.backends[0]}
              onChange={setNewBackend}
              options={(snapshot.backends.length > 0 ? snapshot.backends : []).map(backend => ({ value: backend, label: backendLabel(backend) }))}
            />
          </>
        )}
      </Space>
    </Modal>
  </div>
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function groupWorkspaces(workspaces: WorkspaceEntry[]): WorkspaceEntry[] {
  const seen = new Set<string>()
  return workspaces.filter(workspace => {
    const key = `${workspace.backend}:${workspace.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function ChatRow({ item, onCopy, onDecision }: {
  item: ChatItem
  onCopy: (text: string) => void
  onDecision: (approvalId: string, decision: 'allow-once' | 'reject-once' | 'cancel') => void
}) {
  if (item.kind === 'message' && item.role === 'user') {
    return <div className="dsh-msg dsh-msg-user">
      <div className="dsh-bubble">{item.text}</div>
      <div className="dsh-msg-meta">
        <span>{fmtClock(item.createdAt)}</span>
        <button className="dsh-meta-btn" onClick={() => onCopy(item.text)}><CopyOutlined /></button>
      </div>
    </div>
  }

  if (item.kind === 'message') {
    const status = item.streaming
      ? { text: '生成中', cls: 'is-live' }
      : item.turnEnd?.reason === 'stopped'
        ? { text: '已停止', cls: '' }
        : item.turnEnd?.reason === 'failed'
          ? { text: '生成失败', cls: '' }
          : item.turnEnd
            ? { text: '已完成', cls: '' }
            : undefined
    return <div className="dsh-msg">
      {status && <div className={`dsh-turn-status ${status.cls}`}>{status.text}</div>}
      {item.reasoning && item.reasoning.length > 0 && (
        <details className="dsh-reasoning">
          <summary>思考过程</summary>
          <pre>{item.reasoning}</pre>
        </details>
      )}
      {item.text.length > 0 && <div className="dsh-assistant-text"><Markdown text={item.text} /></div>}
      <div className="dsh-msg-meta">
        {item.text.length > 0 && <button className="dsh-meta-btn" onClick={() => onCopy(item.text)}><CopyOutlined /></button>}
        {item.streaming && <span className="dsh-streaming-dots"><i /><i /><i /></span>}
        <span style={{ marginLeft: 'auto' }}>{fmtClock(item.createdAt)}</span>
      </div>
    </div>
  }

  if (item.kind === 'tool') {
    return <ToolCard item={item} />
  }

  return <div className="dsh-msg">
    <div className="dsh-approval-card">
      <div className="dsh-approval-title">
        <span className="dsh-approval-icon"><SettingOutlined /></span>
        <span>权限确认：{item.toolName}</span>
      </div>
      {item.reason && <pre>{item.reason}</pre>}
      {item.resolved
        ? <span className="dsh-approval-resolved">
          <CheckOutlined />
          {item.resolved === 'allow-once' ? '已允许' : item.resolved === 'reject-once' ? '已拒绝' : '已取消'}
        </span>
        : <div className="dsh-approval-actions">
          <Button size="small" type="primary" onClick={() => onDecision(item.approvalId, 'allow-once')}>允许一次</Button>
          <Button size="small" danger onClick={() => onDecision(item.approvalId, 'reject-once')}>拒绝</Button>
          <Button size="small" onClick={() => onDecision(item.approvalId, 'cancel')}>取消</Button>
        </div>}
    </div>
  </div>
}

function ToolCard({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const hasDetail = Boolean(item.argumentsText || item.resultText)
  return <div className={`dsh-tool-card ${open ? 'is-open' : ''}`}>
    <div className="dsh-tool-head" onClick={() => hasDetail && setOpen(value => !value)}>
      <span className="dsh-tool-icon"><RocketOutlined /></span>
      <span className="dsh-tool-name">{item.toolName}</span>
      <span className={`dsh-tool-state ${item.state === 'failed' ? 'is-failed' : item.state === 'finished' ? 'is-done' : ''}`}>
        {item.state === 'failed' ? '失败' : item.state === 'finished' ? '已完成' : '运行中'}
      </span>
      {hasDetail && <span className="dsh-tool-chevron">⌄</span>}
    </div>
    {open && hasDetail && (
      <div className="dsh-tool-detail">
        {item.argumentsText && <><span className="dsh-detail-label">输入</span><pre>{item.argumentsText}</pre></>}
        {item.resultText && <><span className="dsh-detail-label">输出</span><pre>{item.resultText}</pre></>}
      </div>
    )}
  </div>
}
