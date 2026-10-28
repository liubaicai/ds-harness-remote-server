/** Wire envelope helpers for the DSH Remote control channel and business RPC. */

export const PROTOCOL_VERSION = 1

export type ControlFrameType =
  | 'hello' | 'hello.ack' | 'connect.request' | 'connect.incoming' | 'connect.accepted' | 'connect.rejected'
  | 'secure.handshake' | 'relay' | 'signal.offer' | 'signal.answer' | 'signal.ice'
  | 'transport.selected' | 'ping' | 'pong' | 'error'

export interface ControlFrame<TPayload = unknown> {
  v: typeof PROTOCOL_VERSION
  id: string
  type: ControlFrameType
  timestamp: number
  payload: TPayload
}

export interface RemoteMessage<TPayload = unknown> {
  v: typeof PROTOCOL_VERSION
  id: string
  type: 'rpc.request' | 'rpc.response' | 'rpc.error' | 'event'
  timestamp: number
  payload: TPayload
}

export interface HelloPayload {
  role: 'host' | 'client'
  deviceId: string
  accessToken: string
  protocols: number[]
  capabilities: string[]
  clientVersion?: string
}

export interface HelloAckPayload {
  protocol: number
  serverVersion: string
  connectionSessionId: string
  heartbeatIntervalMs: number
  maxControlFrameBytes: number
  maxRelayFrameBytes: number
  capabilities?: string[]
  webrtcEnabled?: boolean
  webrtcFallbackTimeoutMs?: number
}

export interface ConnectAcceptedPayload { connectionId: string }
export interface ConnectRejectedPayload { connectionId: string; code?: string; message?: string }
export interface SecureHandshakePayload { connectionId: string; targetDeviceId: string; step: number; data: string }
export interface RelayPayload { connectionId: string; targetDeviceId: string; counter: number; ciphertext: string }
export interface TransportSelectedPayload { connectionId: string; targetDeviceId: string; transport: 'lan' | 'p2p' | 'turn' | 'relay' }
export interface ControlErrorPayload { code: string; message: string; retryable?: boolean; connectionId?: string }

export interface RpcRequestPayload<TParams = unknown> { method: string; params: TParams }
export interface RpcResponsePayload<TResult = unknown> { requestId: string; result: TResult }
export interface RpcErrorPayload { requestId: string; code: string; message: string; retryable?: boolean; details?: unknown }
export interface EventPayload<TData = unknown> { seq?: number; event: string; sessionId?: string; data: TData }

let sequence = 0
export function createId(): string {
  const g = globalThis.crypto
  if (g?.randomUUID) return g.randomUUID()
  sequence += 1
  return `msg_${Date.now().toString(36)}_${sequence}`
}

export function createControlFrame<TPayload>(type: ControlFrameType, payload: TPayload): ControlFrame<TPayload> {
  return { v: PROTOCOL_VERSION, id: createId(), type, timestamp: Date.now(), payload }
}

export function createMessage<TPayload>(type: RemoteMessage['type'], payload: TPayload): RemoteMessage<TPayload> {
  return { v: PROTOCOL_VERSION, id: createId(), type, timestamp: Date.now(), payload }
}

export function createRpcRequest<TParams>(method: string, params: TParams): RemoteMessage<RpcRequestPayload<TParams>> {
  return createMessage('rpc.request', { method, params })
}

export function encodeControlFrame(frame: ControlFrame): string {
  return JSON.stringify(frame)
}

export function decodeControlFrame(text: string): ControlFrame {
  const frame = JSON.parse(text) as ControlFrame
  if (frame?.v !== PROTOCOL_VERSION || typeof frame.type !== 'string' || typeof frame.id !== 'string') {
    throw new Error('Control frame is invalid.')
  }
  return frame
}

export function encodeMessage(message: RemoteMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message))
}

export function decodeMessage(data: Uint8Array): RemoteMessage {
  const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as RemoteMessage
  if (message?.v !== PROTOCOL_VERSION || typeof message.type !== 'string' || typeof message.id !== 'string') {
    throw new Error('Remote message is invalid.')
  }
  return message
}
