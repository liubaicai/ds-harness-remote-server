// Simplified upstream HostsPage + product AppHeader. No remote/open/admin actions.
import { Alert, Button, Card, Empty, Layout, Popconfirm, Space, Table, Tag, Typography } from 'antd'
import { GithubOutlined } from '@ant-design/icons'
import type { TableColumnsType } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, RequestError, type Connection, type ConnectionList, type Device, type DeviceList, type TransportName } from './api'
import { ThemeToggle } from './ThemeToggle'
import { SiteFooter } from './SiteFooter'
import { REPOSITORY_URL } from './links'
import { ConnectionInsights } from './ConnectionInsights'
const { Paragraph, Text, Title } = Typography
const transportText: Record<TransportName, string> = { lan: 'LAN 直连', p2p: 'P2P', turn: 'TURN 中继', relay: '服务器中继' }
const transportColor: Record<TransportName, string> = { lan: 'green', p2p: 'blue', turn: 'orange', relay: 'default' }
export function DevicesPage({ account, onSignedOut }: { account: string; onSignedOut: () => void }) {
  const [result, setResult] = useState<DeviceList>()
  const [connections, setConnections] = useState<ConnectionList>()
  const [loading, setLoading] = useState(true)
  const [loggingOut, setLoggingOut] = useState(false)
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState('')
  const deletingRef = useRef(new Set<string>())
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set())
  const load = useCallback(async () => {
    if (deletingRef.current.size) return
    setLoading(true); setError('')
    try {
      const [devices, links] = await Promise.all([api<DeviceList>('/account/devices'), api<ConnectionList>('/account/connections')])
      setResult(devices); setConnections(links); setUpdated(new Date().toLocaleTimeString('zh-CN'))
    }
    catch (err) { if (err instanceof RequestError && err.status === 401) onSignedOut(); else setError(err instanceof Error ? err.message : '加载失败，请重试。') }
    finally { setLoading(false) }
  }, [onSignedOut])
  const loadConnections = useCallback(async () => {
    try { setConnections(await api<ConnectionList>('/account/connections')) } catch { /* 连接面板静默失败，主列表负责报错 */ }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => { const timer = setInterval(() => { void loadConnections() }, 30_000); return () => { clearInterval(timer) } }, [loadConnections])
  async function logout() {
    setLoggingOut(true)
    try { await api('/auth/logout', {}); onSignedOut() }
    catch (err) { setError(err instanceof Error ? err.message : '退出失败，请重试。') }
    finally { setLoggingOut(false) }
  }
  async function deleteDevice(deviceId: string) {
    if (loading || deletingRef.current.has(deviceId)) return
    deletingRef.current.add(deviceId)
    setDeleting(new Set(deletingRef.current)); setError('')
    try {
      await api<{ status: 'deleted' }>(`/account/devices/${encodeURIComponent(deviceId)}`, undefined, 'DELETE')
      setResult(current => current ? { ...current, items: current.items.filter(device => device.deviceId !== deviceId) } : current)
      setUpdated(new Date().toLocaleTimeString('zh-CN'))
    } catch (err) {
      if (err instanceof RequestError && err.status === 401) onSignedOut()
      else setError(err instanceof Error ? err.message : '删除失败，请重试。')
    } finally {
      deletingRef.current.delete(deviceId)
      setDeleting(new Set(deletingRef.current))
    }
  }
  const devices = [...(result?.items ?? [])].sort((a, b) => Number(b.online) - Number(a.online))
  const links = [...(connections?.items ?? [])].sort((a, b) => b.connectedAt - a.connectedAt)
  const connectionColumns: TableColumnsType<Connection> = [
    { title: '客户端', key: 'client', render: (_, c) => <Text strong>{c.client.name}</Text> },
    { title: 'Host', key: 'host', render: (_, c) => <Text strong>{c.host.name}</Text> },
    { title: '通道', key: 'transport', render: (_, c) => {
      const transport = c.hostTransport ?? c.selectedTransport
      return transport ? <Tag color={transportColor[transport]}>{transportText[transport]}</Tag> : <Text type="secondary">协商中</Text>
    } },
    { title: '状态', dataIndex: 'stage', key: 'stage', render: (stage: Connection['stage']) => stage === 'ready' ? <Tag color="green">已连接</Tag> : <Tag>协商中</Tag> },
    { title: '建立时间', dataIndex: 'connectedAt', key: 'connectedAt', render: (value: number) => new Date(value).toLocaleTimeString('zh-CN') },
  ]
  const columns: TableColumnsType<Device> = [
    { title: '设备名称', dataIndex: 'name', key: 'name', render: (name: string, d) => <Space size={10}><span className={`host-status-dot ${d.online ? 'is-online' : ''}`} /><Text strong className="selfhost-device-name">{name}</Text></Space> },
    { title: '状态', dataIndex: 'online', key: 'online', render: (online: boolean) => online ? <Tag color="green">在线</Tag> : <Tag>离线</Tag> },
    { title: '角色', dataIndex: 'role', key: 'role', render: (role: string) => role === 'host' ? 'Host' : '客户端' },
    { title: '系统', dataIndex: 'platform', key: 'platform', render: (platform: string) => ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux', android: 'Android' })[platform] ?? platform },
    { title: '插件版本', dataIndex: 'clientVersion', key: 'clientVersion' },
    { title: 'Harness 版本', dataIndex: 'harnessVersion', key: 'harnessVersion', render: (value?: string) => value || '—' },
    { title: '操作', key: 'actions', render: (_, device) => <Popconfirm
      title="删除此设备？"
      description={device.online ? '设备在线，删除后将立即断开连接。' : '删除后将从设备列表移除。'}
      okText="删除" cancelText="取消"
      okButtonProps={{ danger: true, loading: deleting.has(device.deviceId) }}
      cancelButtonProps={{ disabled: deleting.has(device.deviceId) }}
      disabled={loading || deleting.has(device.deviceId)}
      onConfirm={() => deleteDevice(device.deviceId)}
    ><Button type="text" danger size="small" loading={deleting.has(device.deviceId)} disabled={loading} aria-label={`删除设备 ${device.name}`}>删除</Button></Popconfirm> },
  ]
  return <>
    <Layout.Header className="topbar product-topbar"><div className="topbar-inner"><div className="topbar-brand-group is-product"><a className="topbar-brand" href="/" aria-label="返回首页"><img className="topbar-brand-mark" src="/brand-whale.webp" alt="" width="40" height="40" /><span className="topbar-brand-copy"><Title level={3}>DeepSeek Harness Remote</Title><small>安全远程访问</small></span></a></div><div className="topbar-actions"><a className="topbar-github-link product-github-link" href={REPOSITORY_URL} target="_blank" rel="noreferrer" aria-label="GitHub"><GithubOutlined /> GitHub</a><ThemeToggle /><Button type="text" loading={loggingOut} onClick={() => void logout()}>退出登录</Button></div></div></Layout.Header>
    <Layout.Content className="product-content selfhost-content" id="main-content">
      <div className="app-area"><div className="workspace-view"><div className="hosts-page">
        <header className="workspace-page-header"><div><Title level={2}>我的设备</Title><Paragraph className="selfhost-account">{account}</Paragraph></div><Space className="workspace-page-actions" wrap><Button onClick={() => void load()} loading={loading} disabled={deleting.size > 0}>刷新</Button></Space></header>
        {error && <Alert className="selfhost-error" type="error" showIcon message={error} />}
        <Card className="page-card selfhost-connection" title="服务地址"><Paragraph><Text code className="selfhost-address">{result?.serverUrl ?? '加载中…'}</Text></Paragraph><Paragraph>Host 和客户端使用此地址。</Paragraph></Card>
        <Card className="page-card hosts-list-card" title="设备状态" extra={result ? <Text type="secondary">{devices.filter(d => d.online).length} / {devices.length} 台在线</Text> : undefined}>
          {!error && !loading && !devices.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无设备" /> : <Table<Device> rowKey="deviceId" columns={columns} dataSource={devices} loading={loading} pagination={false} scroll={{ x: 'max-content' }} />}
        </Card>
        <Card className="page-card hosts-list-card" title="活动连接" extra={connections ? <Text type="secondary">{links.length} 个连接</Text> : undefined}>
          {!error && !loading && !links.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无活动连接" /> : <Table<Connection> rowKey="connectionId" columns={connectionColumns} dataSource={links} loading={loading} pagination={false} scroll={{ x: 'max-content' }} size="small" />}
        </Card>
        {updated && <Paragraph className="selfhost-caption" type="secondary">设备更新于 {updated}</Paragraph>}
        <ConnectionInsights devices={devices} onSignedOut={onSignedOut} />
      </div></div></div>
    </Layout.Content><SiteFooter />
  </>
}
