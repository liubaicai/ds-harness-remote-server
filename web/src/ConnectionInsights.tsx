import { Alert, Button, Descriptions, Empty, Modal, Space, Table, Tag, Timeline, Typography } from 'antd'
import type { TableColumnsType } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, RequestError, type Device } from './api'
import { eventLabel, formatBytes, formatDuration, reasonLabel, stageLabels, transportLabels, type ConnectionHistory, type ConnectionRecord, type ConnectionStats, type Diagnostics } from './observability'
import './observability.css'

const { Text, Paragraph } = Typography
const PAGE_SIZE = 20
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const statusLabels = { ok: '正常', warning: '需注意', unknown: '未验证', error: '异常' }
const statusColors = { ok: 'success', warning: 'warning', unknown: 'default', error: 'error' } as const

export function ConnectionInsights({ devices, onSignedOut }: { devices: Device[]; onSignedOut: () => void }) {
  const [history, setHistory] = useState<ConnectionHistory>()
  const [stats, setStats] = useState<ConnectionStats>()
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [diagnosticError, setDiagnosticError] = useState('')
  const [diagnostics, setDiagnostics] = useState<Diagnostics>()
  const [selection, setSelection] = useState<string | null>(null)
  const [diagnosing, setDiagnosing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const loadVersion = useRef(0)
  const diagnosticVersion = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; loadVersion.current++; diagnosticVersion.current++ } }, [])
  const failure = useCallback((err: unknown) => {
    if (err instanceof RequestError && err.status === 401) onSignedOut()
    return err instanceof Error ? err.message : '请求失败，请重试。'
  }, [onSignedOut])
  const load = useCallback(async () => {
    const version = ++loadVersion.current
    setLoading(true)
    try {
      const [nextHistory, nextStats] = await Promise.all([
        api<ConnectionHistory>(`/account/connection-history?limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}`),
        api<ConnectionStats>('/account/connection-stats'),
      ])
      if (version !== loadVersion.current) return
      if (page > 1 && !nextHistory.items.length && nextHistory.total <= (page - 1) * PAGE_SIZE) {
        setPage(Math.max(1, Math.ceil(nextHistory.total / PAGE_SIZE)))
        return
      }
      setHistory(nextHistory); setStats(nextStats); setError('')
    } catch (err) { if (version === loadVersion.current) setError(failure(err)) }
    finally { if (version === loadVersion.current) setLoading(false) }
  }, [page, failure])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load() }, 30_000)
    return () => { clearInterval(timer); loadVersion.current++ }
  }, [load])

  async function diagnose(connectionId = '') {
    const version = ++diagnosticVersion.current
    setSelection(connectionId); setDiagnostics(undefined); setDiagnosticError(''); setDiagnosing(true)
    try {
      const result = await api<Diagnostics>(`/account/diagnostics${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ''}`)
      if (version === diagnosticVersion.current) setDiagnostics(result)
    } catch (err) { if (version === diagnosticVersion.current) setDiagnosticError(failure(err)) }
    finally { if (version === diagnosticVersion.current) setDiagnosing(false) }
  }
  async function download() {
    setExporting(true); setDiagnosticError('')
    try {
      const result = await api<unknown>(`/account/diagnostics/export${selection ? `?connectionId=${encodeURIComponent(selection)}` : ''}`)
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }))
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = `remote-diagnostics-${new Date().toISOString().replaceAll(':', '-')}.json`
      document.body.appendChild(anchor); anchor.click(); anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) { if (mounted.current) setDiagnosticError(failure(err)) }
    finally { if (mounted.current) setExporting(false) }
  }
  const names = new Map(devices.map(device => [device.deviceId, device.name]))
  const deviceName = (id: string) => names.get(id) ?? '未登记或已删除设备'
  const columns: TableColumnsType<ConnectionRecord> = [
    { title: '开始时间', dataIndex: 'connectedAt', key: 'time', render: time },
    { title: '客户端 → Host', key: 'devices', render: (_, record) => <div className="observability-device-pair"><Text>{deviceName(record.client)}</Text><Text type="secondary">→ {deviceName(record.host)}</Text></div> },
    { title: '状态', key: 'state', render: (_, record) => <><Tag>{stageLabels[record.stage]}</Tag>{record.endReason && <div><Text type="secondary">{reasonLabel(record.endReason)}</Text></div>}</> },
    { title: '最后通道', key: 'transport', render: (_, record) => transportLabels[record.hostTransport ?? record.selectedTransport ?? 'unknown'] },
    { title: '握手耗时', key: 'handshake', render: (_, record) => formatDuration(record.handshakeDurationMs) },
    { title: '中继密文', key: 'bytes', render: (_, record) => formatBytes(record.relayBytes) },
    { title: '操作', key: 'action', render: (_, record) => <Button type="link" onClick={() => void diagnose(record.connectionId)}>诊断</Button> },
  ]
  const record = diagnostics?.connection
  return <section className="connection-insights" aria-labelledby="connection-insights-title">
    <header className="observability-header">
      <div><h3 id="connection-insights-title">连接历史与质量</h3><Text type="secondary">保留最近 7 天，最多 1,000 条。每 30 秒更新。</Text></div>
      <Space wrap><Button onClick={() => void load()} loading={loading}>刷新统计</Button><Button onClick={() => void diagnose()}>连接诊断</Button></Space>
    </header>
    {error && <Alert type="error" showIcon message={error} description={history ? '当前显示上次成功获取的数据。' : undefined} />}
    <dl className="observability-stats">
      <div><dt>记录连接</dt><dd>{stats?.totals.connections ?? '—'}</dd></div>
      <div><dt>活动连接</dt><dd>{stats?.totals.active ?? '—'}</dd></div>
      <div><dt>完成握手</dt><dd>{stats?.totals.ready ?? '—'}</dd></div>
      <div><dt>平均握手耗时</dt><dd>{formatDuration(stats?.handshake.averageMs)}</dd></div>
      <div><dt>中继密文总量</dt><dd>{stats ? formatBytes(stats.totals.relayBytes) : '—'}</dd></div>
    </dl>
    {stats && <div className="observability-transports" aria-label="最后通道分布">{Object.entries(stats.transports).map(([name, count]) => <span key={name}>{transportLabels[name as keyof typeof transportLabels]} <strong>{count}</strong></span>)}</div>}
    <Paragraph type="secondary" className="observability-note">统计仅覆盖保留记录。通道以设备上报为准，握手完成不代表业务请求成功。中继流量不含直连及 TURN 流量，端到端延迟和丢包率尚不可测。</Paragraph>
    <Table<ConnectionRecord> rowKey="connectionId" columns={columns} dataSource={history?.items ?? []} loading={loading} size="small" scroll={{ x: 960 }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无连接记录，新连接建立后会在这里显示" /> }}
      pagination={{ current: page, pageSize: PAGE_SIZE, total: history?.total ?? 0, showSizeChanger: false, hideOnSinglePage: true, onChange: setPage, showTotal: total => `共 ${total} 条` }} />
    {stats && <details className="observability-rtt"><summary>服务器与设备的心跳往返时间</summary>
      <Paragraph type="secondary">不是客户端与 Host 之间的端到端延迟。无样本时不显示估算值。</Paragraph>
      {stats.serverPeerRtt.length ? <ul>{stats.serverPeerRtt.map(sample => <li key={sample.deviceId}><span>{deviceName(sample.deviceId)}</span><strong>{formatDuration(sample.rttMs)}</strong><Text type="secondary">采样于 {time(sample.measuredAt)}</Text></li>)}</ul> : <Text type="secondary">暂无有效心跳样本</Text>}
    </details>}
    {stats && <Text type="secondary" className="observability-updated">更新于 {time(stats.generatedAt)}</Text>}
    <Modal title={selection ? '连接诊断' : '服务连接诊断'} open={selection !== null} width={760} centered styles={{ body: { maxHeight: 'calc(100dvh - 200px)', overflowY: 'auto' } }} transitionName="" maskTransitionName="" onCancel={() => { diagnosticVersion.current++; setSelection(null); setDiagnosing(false) }}
      footer={<Space wrap><Button onClick={() => void diagnose(selection ?? '')} loading={diagnosing}>重新检查</Button><Button type="primary" onClick={() => void download()} loading={exporting} disabled={diagnosing || !diagnostics}>下载脱敏诊断包</Button></Space>}>
      <div className="observability-diagnostics" aria-busy={diagnosing}>
        {diagnosing && <Paragraph role="status">正在检查服务状态…</Paragraph>}
        {diagnosticError && <Alert type="error" showIcon message={diagnosticError} />}
        {diagnostics && <>
          <Paragraph type="secondary">{diagnostics.scope}</Paragraph>
          <div className="observability-checks">{diagnostics.checks.map(check => <section key={check.id}><div><Tag color={statusColors[check.status]}>{statusLabels[check.status]}</Tag><Text strong>{check.title}</Text></div><Paragraph>{check.message}</Paragraph></section>)}</div>
          {record && <>
            <Descriptions size="small" column={{ xs: 1, sm: 2 }} title="连接详情" items={[
              { key: 'client', label: '客户端', children: deviceName(record.client) },
              { key: 'host', label: 'Host', children: deviceName(record.host) },
              { key: 'start', label: '开始时间', children: time(record.connectedAt) },
              { key: 'end', label: '结束时间', children: record.endedAt ? time(record.endedAt) : '尚未结束' },
              { key: 'duration', label: '握手耗时', children: formatDuration(record.handshakeDurationMs) },
              { key: 'relay', label: '中继密文', children: `${formatBytes(record.relayBytes)} / ${record.relayFrames} 帧` },
            ]} />
            <h4>连接时间线</h4>
            {!!record.eventsDropped && <Paragraph type="secondary">已省略 {record.eventsDropped} 个较早事件，仅保留首个事件与最近事件。</Paragraph>}
            <Timeline items={record.events.map(event => ({ children: <><Text type="secondary">{time(event.at)}</Text><div>{eventLabel(event)}</div></> }))} />
          </>}
          <h4>观测范围</h4><ul className="observability-limitations">{diagnostics.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>
          <Paragraph type="secondary">诊断包使用临时匿名编号，不含账号、设备名、地址、凭证或会话内容。仍包含时间和连接统计，分享前请确认。</Paragraph>
          <Text type="secondary">检查于 {time(diagnostics.generatedAt)}</Text>
        </>}
      </div>
    </Modal>
  </section>
}
