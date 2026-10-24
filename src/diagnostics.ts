import { connectionStats, exportRecords, retention, type ConnectionRecord } from './connection-history.js'
import type { IceConfig } from './ice.js'
import { modernHost } from './gateway.js'

export type ProbeObservation = { state: 'disabled' | 'pending' | 'complete' | 'failed'; observedAt?: number; results: { reachable: boolean; rttMs?: number }[] }
export type DiagnosticDevice = { deviceId: string; online: boolean; clientVersion: string; harnessVersion?: string; role?: 'host' | 'client' }
type Check = { id: string; status: 'ok' | 'warning' | 'unknown' | 'error'; title: string; message: string }
export function diagnose(input: { webrtc: boolean; ice: IceConfig; probe: ProbeObservation; devices: DiagnosticDevice[]; connection: ConnectionRecord | null; persistenceHealthy: boolean }) {
  const { webrtc, ice, probe, devices, connection, persistenceHealthy } = input
  const readiness = { webrtcEnabled: webrtc, stunConfigured: ice.stunUrls.length > 0, stunEndpointCount: ice.stunUrls.length, turnConfigured: ice.turnUrls.length > 0, turnCredentialsConfigured: Boolean(ice.turnSecret || (ice.turnUsername && ice.turnPassword)), turnEndpointCount: ice.turnUrls.length }
  const checks: Check[] = [
    { id: 'webrtc', status: webrtc ? 'ok' : 'warning', title: '直连协商配置', message: webrtc ? '服务器已允许 LAN、P2P 和 TURN 协商；实际通道取决于双方能力和网络。' : '当前仅启用服务器中继；如需直连，请启用 WebRTC 配置并重启服务。' },
    { id: 'stun-config', status: readiness.stunConfigured ? 'ok' : 'warning', title: 'STUN 配置', message: readiness.stunConfigured ? '已配置 STUN；配置存在不代表客户端可以访问。' : '未配置 STUN；跨公网直连可能受限，请配置可用的 STUN 服务。' },
    { id: 'turn-config', status: readiness.turnConfigured && readiness.turnCredentialsConfigured ? 'ok' : 'warning', title: 'TURN 配置', message: readiness.turnConfigured && readiness.turnCredentialsConfigured ? '已配置 TURN 及认证信息；尚未验证网络可达性或认证是否成功。' : 'TURN 未完整配置；严格 NAT 或企业网络下可配置 TURN，并保留服务器中继作为回退。' },
    { id: 'startup-stun', status: probe.state === 'complete' ? probe.results.some(r => r.reachable) ? 'ok' : 'warning' : 'unknown', title: '服务器启动时 STUN 探测', message: probe.state === 'complete' ? probe.results.some(r => r.reachable) ? '启动时服务器曾收到 STUN 响应；这不是当前健康检查，也不能证明客户端可达。' : '启动时服务器未收到 STUN 响应；请检查服务器 DNS、出站 UDP 和 STUN 配置，客户端可达性仍未知。' : probe.state === 'pending' ? '启动探测尚未完成，请稍后刷新。' : probe.state === 'failed' ? '启动探测未完成；请检查服务器网络，不能据此判断客户端网络。' : '启动探测未启用或未配置 STUN，暂无观测结果。' },
    { id: 'client-reachability', status: 'unknown', title: '客户端网络可达性', message: '服务器无法推断 Host 或客户端的 STUN、TURN、直连可达性；请在两端检查网络与连接日志。' },
    { id: 'turn-reachability', status: 'unknown', title: 'TURN 可达性', message: '未执行 TURN 分配或端到端连通测试；请从使用端验证端口、TLS 证书和认证配置。' },
    { id: 'persistence', status: persistenceHealthy ? 'ok' : 'error', title: '历史记录存储', message: persistenceHealthy ? '历史记录按容量和保留期限制保存。' : '历史记录读取或写入失败；请检查数据目录权限和磁盘空间。' },
  ]
  const relevant = connection ? devices.filter(d => d.deviceId === connection.host || d.deviceId === connection.client) : devices
  checks.push({ id: 'presence', status: relevant.length > 0 && relevant.every(d => d.online) && (!connection || relevant.length === 2) ? 'ok' : 'warning', title: '设备当前状态', message: relevant.length > 0 && relevant.every(d => d.online) && (!connection || relevant.length === 2) ? '相关设备当前已连接服务器；在线不代表两端可以直连。' : '部分设备离线、已删除或尚未注册；请启动 Host 并确认账号授权和网络连接。' })
  const hosts = relevant.filter(d => d.role === 'host' || d.deviceId === connection?.host)
  checks.push({ id: 'host-version', status: hosts.length === 0 ? 'unknown' : hosts.every(d => modernHost(d.clientVersion)) ? 'ok' : 'warning', title: 'Host 信令版本', message: hosts.length === 0 ? '暂无相关 Host 版本信息；请启动并注册 Host。' : hosts.every(d => modernHost(d.clientVersion)) ? '相关 Host 版本满足服务器的直连信令最低条件；尚未验证客户端能力或完整协议兼容性。' : '部分 Host 版本低于 0.2.15 或无法识别，服务器仅为这些 Host 协商中继；请升级插件并重新连接。' })
  if (connection) {
    const selected = connection.hostTransport ?? connection.selectedTransport
    const transportMessages = { lan: 'Host 或客户端报告 LAN 直连；服务器未测量该路径的实际吞吐或丢包。', p2p: 'Host 或客户端报告 P2P 直连；服务器未测量该路径的实际吞吐或丢包。', turn: 'Host 或客户端报告 TURN 中继；配置存在和路径声明不等于服务器验证了 TURN 可达性。', relay: 'Host 或客户端报告服务器中继。仅凭服务端元数据无法确定回退原因，不能据此断言 NAT、STUN 或 TURN 失败；请结合两端日志排查。' }
    const differs = connection.hostTransport !== undefined && connection.selectedTransport !== undefined && connection.hostTransport !== connection.selectedTransport
    checks.push({ id: 'transport', status: selected === undefined ? 'unknown' : 'ok', title: '连接通道', message: (selected === undefined ? '暂无传输选择或 Host 通道报告，连接可能仍在协商。' : transportMessages[selected]) + (differs ? ' 客户端选择与 Host 报告不同；这本身不代表失败，请结合时间线和两端日志确认当前通道。' : '') })
    const reasons: Record<string, string> = { HOST_OFFLINE: '请求时 Host 不在线，请启动 Host 并确认其连接到同一服务。', CAPABILITY_NOT_SUPPORTED: '双方没有可用的共同能力，或选择了未协商的通道；请检查插件版本和传输配置。', REJECTED: 'Host 拒绝了连接请求；请检查 Host 授权设置。', SERVER_RESTART: '服务器重启前未记录正常结束；请重新连接。', SERVER_SHUTDOWN: '服务器关闭导致连接结束；服务恢复后可重新连接。', AUTH_INVALID: '设备授权失效，请重新授权。', SLOW_CONSUMER: '目标 WebSocket 写入积压，请检查目标设备网络和负载。', CONNECTION_REPLACED: '连接被新的设备会话或连接请求替换；请检查是否重复登录。' }
    checks.push({ id: 'connection', status: connection.endedAt !== undefined ? connection.readyAt !== undefined ? 'warning' : 'error' : connection.readyAt !== undefined ? 'ok' : 'unknown', title: '连接过程', message: connection.endReason ? reasons[connection.endReason] ?? '连接已结束，请结合时间线检查两端网络和插件日志。' : connection.readyAt !== undefined ? '服务器已观察到握手交换完成；无法验证端到端解密或应用状态。' : '连接仍在协商，请稍后刷新；持续等待时检查双方网络和版本。' })
  }
  return { generatedAt: Date.now(), scope: '服务器可观测元数据，不包含端到端业务内容。', limitations: ['服务器与单个设备的 ping RTT 不是端到端延迟。', '直连吞吐量、丢包和实际客户端网络可达性未知。', '握手完成只表示服务器观察到握手交换，不代表应用成功。', '历史最多保留 1000 条、7 天；单条时间线最多 64 个事件。超过 7 天仍未结束的连接可能不在历史中，活动连接列表不受影响。'], readiness, startupStun: probe, checks, devices: relevant, connection }
}
export function sanitizedDiagnosticExport(diagnostics: ReturnType<typeof diagnose>, records: ConnectionRecord[]) {
  // No raw checks, messages, versions or arbitrary strings are copied. All keys are explicit.
  const r = diagnostics.readiness, p = diagnostics.startupStun
  return { schemaVersion: 1, generatedAt: diagnostics.generatedAt, retention, readiness: { webrtcEnabled: r.webrtcEnabled, stunConfigured: r.stunConfigured, stunEndpointCount: r.stunEndpointCount, turnConfigured: r.turnConfigured, turnCredentialsConfigured: r.turnCredentialsConfigured, turnEndpointCount: r.turnEndpointCount }, startupStun: { state: p.state, observedAt: p.observedAt, results: p.results.map(x => ({ reachable: x.reachable, rttMs: x.rttMs })) }, devicePresence: { total: diagnostics.devices.length, online: diagnostics.devices.filter(d => d.online).length }, statistics: (() => { const s = connectionStats(records); return { totals: s.totals, transports: s.transports, handshake: s.handshake } })(), connections: exportRecords(records), unknown: ['clientReachability', 'turnReachability', 'directThroughput', 'directLoss', 'endToEndLatency'] }
}
