import type { TransportName } from './api'

export interface ConnectionEvent {
  at: number
  type: 'stage' | 'transport' | 'ended'
  stage?: string
  transport?: TransportName
  source?: 'host' | 'client'
  reason?: string
}
export interface ConnectionRecord {
  connectionId: string
  host: string
  client: string
  stage: 'pending' | 'accepted' | 'handshake' | 'ready' | 'closed' | 'rejected' | 'failed' | 'interrupted'
  connectedAt: number
  readyAt?: number
  endedAt?: number
  endReason?: string
  selectedTransport?: TransportName
  hostTransport?: TransportName
  handshakeDurationMs?: number
  relayBytes: number
  relayFrames: number
  events: ConnectionEvent[]
  eventsDropped?: number
}
export interface ConnectionHistory {
  items: ConnectionRecord[]; total: number; limit: number; offset: number
  retention: { maxRecords: number; maxAgeMs: number }
}
export interface ConnectionStats {
  generatedAt: number
  retention: { maxRecords: number; maxAgeMs: number }
  totals: { connections: number; active: number; ready: number; failed: number; relayBytes: number; relayFrames: number }
  transports: Record<TransportName | 'unknown', number>
  handshake: { samples: number; averageMs: number | null }
  semantics: { relay: string; handshake: string; directPath: string }
  serverPeerRtt: { deviceId: string; rttMs: number; measuredAt: number }[]
}
export interface Diagnostics {
  generatedAt: number
  scope: string
  checks: { id: string; status: 'ok' | 'warning' | 'unknown' | 'error'; title: string; message: string }[]
  limitations: string[]
  devices: { deviceId: string; online: boolean; clientVersion: string; harnessVersion?: string }[]
  connection: ConnectionRecord | null
}
export const transportLabels: Record<TransportName | 'unknown', string> = { lan: 'LAN 直连', p2p: 'P2P', turn: 'TURN 中继', relay: '服务器中继', unknown: '未选择' }
export const stageLabels: Record<ConnectionRecord['stage'], string> = {
  pending: '等待接受', accepted: '已接受', handshake: '加密握手中', ready: '握手完成',
  closed: '已结束', rejected: '已拒绝', failed: '未建立', interrupted: '服务中断',
}
const reasonLabels: Record<string, string> = {
  HOST_OFFLINE: 'Host 不在线', CAPABILITY_NOT_SUPPORTED: '没有兼容的通道',
  CONNECTION_FAILED: '连接断开或超时', CONNECTION_REPLACED: '被新连接替换',
  AUTH_INVALID: '设备授权失效', SLOW_CONSUMER: '接收端积压',
  INVALID_MESSAGE: '协议消息无效', RATE_LIMITED: '请求超过限制',
  CONNECTION_REJECTED: 'Host 拒绝连接', REJECTED: 'Host 拒绝连接', SERVER_SHUTDOWN: '服务停止',
  CONNECTION_NOT_FOUND: '连接已不可用', OTHER: '其他原因',
  SERVER_RESTART: '服务重启', SERVER_INTERRUPTED: '服务中断',
}
export function reasonLabel(reason?: string): string { return reason ? reasonLabels[reason] ?? reason : '—' }
export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let amount = value / 1024, unit = 0
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++ }
  return `${amount.toFixed(1)} ${units[unit]}`
}
export function formatDuration(ms?: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)} 分 ${Math.floor(ms % 60_000 / 1000)} 秒`
  return `${Math.floor(ms / 3600_000)} 小时 ${Math.floor(ms % 3600_000 / 60_000)} 分`
}
export function eventLabel(event: ConnectionEvent): string {
  if (event.type === 'transport') return `${event.source === 'host' ? 'Host 上报' : '客户端选择'}：${event.transport ? transportLabels[event.transport] : '未选择'}`
  if (event.type === 'ended') return `连接结束：${reasonLabel(event.reason)}`
  return stageLabels[event.stage as ConnectionRecord['stage']] ?? '状态更新'
}
