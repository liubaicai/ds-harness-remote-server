/**
 * Relay-only control channel over `/ws/v1/connect`.
 *
 * This is the browser-side counterpart of the Android AdaptiveTransport
 * restricted to the `relay` data plane: hello → connect.request →
 * connect.accepted → Noise handshake frames → relayed ciphertext. WebRTC
 * upgrade paths (LAN/P2P/TURN) are intentionally out of scope for the web
 * MVP — the server always accepts `transport.relay`.
 */
import { fromBase64Url, toBase64Url } from './base64'
import {
  createControlFrame,
  decodeControlFrame,
  encodeControlFrame,
  type ConnectAcceptedPayload,
  type ConnectRejectedPayload,
  type ControlErrorPayload,
  type ControlFrame,
  type HelloAckPayload,
  type RelayPayload,
  type SecureHandshakePayload,
} from './protocol'

export interface RelayLinkOptions {
  deviceId: string
  accessToken: string
  hostDeviceId: string
  hostIdentityKey: string
  clientIdentityKey: string
  clientVersion: string
  onClose?: (event: { code?: number; reason?: string }) => void
}

export interface LinkConnectionInfo {
  connectionId: string
  localDeviceId: string
  remoteDeviceId: string
  serverVersion: string
  heartbeatIntervalMs: number
}

type HandshakeHandler = (step: number, data: Uint8Array) => void

/** Inner transport consumed by the Noise wrapper (SecureTransport). */
export class RelayLink {
  private ws?: WebSocket
  private connection?: LinkConnectionInfo
  private relayCounter = -1
  private messageHandler?: (data: Uint8Array) => void
  private handshakeHandler?: HandshakeHandler
  private closeHandler?: (error?: Error) => void
  private closed = false
  private pingTimer?: ReturnType<typeof setInterval>
  /** Noise + counter state is not re-entrant; serialize sends like Android does. */
  private sendTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: RelayLinkOptions) {}

  async connect(): Promise<void> {
    this.closed = false
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${scheme}//${window.location.host}/ws/v1/connect`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error('WebSocket connection timed out.'))
      }, 15_000)
      const fail = (error: Error) => { clearTimeout(timer); reject(error) }
      ws.onerror = () => fail(new Error('WebSocket connection failed.'))
      ws.onclose = event => fail(new Error(`WebSocket closed before hello.ack (${event.code}).`))
      // Browsers reject send() until the socket is OPEN (Node's ws buffers
      // silently, which is why this only shows up in real browser runs).
      ws.onopen = () => {
        ws.send(encodeControlFrame(createControlFrame('hello', {
          role: 'client',
          deviceId: this.options.deviceId,
          accessToken: this.options.accessToken,
          protocols: [1],
          capabilities: ['transport.relay'],
          clientVersion: this.options.clientVersion,
        })))
      }
      ws.onmessage = event => {
        try {
          const frame = decodeControlFrame(String(event.data))
          if (frame.type === 'error') {
            const payload = frame.payload as ControlErrorPayload
            fail(new Error(`${payload.code}: ${payload.message}`))
            return
          }
          if (frame.type !== 'hello.ack') return
          clearTimeout(timer)
          const ack = frame.payload as HelloAckPayload
          this.connection = {
            connectionId: ack.connectionSessionId,
            localDeviceId: this.options.deviceId,
            remoteDeviceId: this.options.hostDeviceId,
            serverVersion: ack.serverVersion,
            heartbeatIntervalMs: ack.heartbeatIntervalMs,
          }
          // connectionSessionId identifies the socket; the link id arrives with
          // connect.accepted. Keep the socket session until then.
          ws.onmessage = event => this.dispatch(String(event.data))
          ws.onclose = event => this.handleClose(event.code, event.reason)
          ws.onerror = () => this.handleClose(4001, 'WebSocket error')
          resolve()
        } catch (error) {
          fail(error instanceof Error ? error : new Error('hello.ack was invalid.'))
        }
      }
    })
    await this.requestConnection()
    this.scheduleHeartbeat()
  }

  /** connect.request → connect.accepted handshake, relay-only. */
  private async requestConnection(): Promise<void> {
    const ws = this.requireSocket()
    const accepted = new Promise<ConnectAcceptedPayload>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Host did not accept the connection in time.')), 30_000)
      this.pendingConnect = payload => { clearTimeout(timer); resolve(payload) }
      this.pendingConnectError = payload => { clearTimeout(timer); reject(new Error(`${payload.code}: ${payload.message}`)) }
    })
    ws.send(encodeControlFrame(createControlFrame('connect.request', {
      hostDeviceId: this.options.hostDeviceId,
      preferredTransports: ['relay'],
    })))
    const payload = await accepted
    this.connection = {
      ...(this.connection as LinkConnectionInfo),
      connectionId: payload.connectionId,
    }
    this.pendingConnect = undefined
    this.pendingConnectError = undefined
    // Announce the data plane decision so history/diagnostics record Relay.
    this.sendControl('transport.selected', {
      connectionId: payload.connectionId,
      targetDeviceId: this.options.hostDeviceId,
      transport: 'relay',
    })
  }

  private pendingConnect?: (payload: ConnectAcceptedPayload) => void
  private pendingConnectError?: (payload: ControlErrorPayload) => void

  connectionInfo(): LinkConnectionInfo {
    if (!this.connection) throw new Error('Relay link is not connected.')
    return this.connection
  }

  /** Noise handshake step carried over `secure.handshake` frames. */
  sendHandshake(step: number, data: Uint8Array): Promise<void> {
    const info = this.connectionInfo()
    this.sendControl('secure.handshake', {
      connectionId: info.connectionId,
      targetDeviceId: info.remoteDeviceId,
      step,
      data: toBase64Url(data),
    })
    return Promise.resolve()
  }

  onHandshake(handler: HandshakeHandler): () => void {
    this.handshakeHandler = handler
    return () => { if (this.handshakeHandler === handler) this.handshakeHandler = undefined }
  }

  /** Send Noise ciphertext as one relay frame (strictly increasing counter). */
  async send(ciphertext: Uint8Array): Promise<void> {
    const run = this.sendTail.then(() => this.sendNow(ciphertext))
    this.sendTail = run.catch(() => undefined)
    return run
  }

  private async sendNow(ciphertext: Uint8Array): Promise<void> {
    const info = this.connectionInfo()
    const ws = this.requireSocket()
    this.relayCounter += 1
    const payload: RelayPayload = {
      connectionId: info.connectionId,
      targetDeviceId: info.remoteDeviceId,
      counter: this.relayCounter,
      ciphertext: toBase64Url(ciphertext),
    }
    ws.send(encodeControlFrame(createControlFrame('relay', payload)))
  }

  onMessage(handler: (data: Uint8Array) => void): () => void {
    this.messageHandler = handler
    return () => { if (this.messageHandler === handler) this.messageHandler = undefined }
  }

  onClose(handler: (error?: Error) => void): () => void {
    this.closeHandler = handler
    return () => { if (this.closeHandler === handler) this.closeHandler = undefined }
  }

  getStats(): { connected: boolean; mode: 'Relay' | 'Disconnected' } {
    return { connected: this.ws?.readyState === WebSocket.OPEN && !this.closed, mode: this.ws?.readyState === WebSocket.OPEN && !this.closed ? 'Relay' : 'Disconnected' }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.clearHeartbeat()
    const ws = this.ws
    this.ws = undefined
    this.connection = undefined
    try { ws?.close(1000, 'client close') } catch { /* already closed */ }
    this.notifyClose()
  }

  private dispatch(text: string): void {
    let frame: ControlFrame
    try {
      frame = decodeControlFrame(text)
    } catch {
      void this.close()
      return
    }
    switch (frame.type) {
      case 'ping': {
        const nonce = (frame.payload as { nonce?: string }).nonce
        this.sendControl('pong', { nonce })
        return
      }
      case 'pong':
        return
      case 'connect.accepted': {
        this.pendingConnect?.(frame.payload as ConnectAcceptedPayload)
        return
      }
      case 'connect.rejected': {
        const payload = frame.payload as ConnectRejectedPayload
        this.pendingConnectError?.({ code: payload.code ?? 'CONNECTION_REJECTED', message: payload.message ?? 'Host rejected the connection.' })
        return
      }
      case 'secure.handshake': {
        const payload = frame.payload as SecureHandshakePayload
        this.handshakeHandler?.(payload.step, fromBase64Url(payload.data))
        return
      }
      case 'relay': {
        const payload = frame.payload as RelayPayload
        this.messageHandler?.(fromBase64Url(payload.ciphertext))
        return
      }
      case 'error': {
        const payload = frame.payload as ControlErrorPayload
        if (payload.connectionId === undefined || payload.connectionId === this.connection?.connectionId) {
          this.options.onClose?.({ code: undefined, reason: `${payload.code}: ${payload.message}` })
          void this.close()
        }
        return
      }
      default:
        return
    }
  }

  private sendControl(type: Parameters<typeof createControlFrame>[0], payload: unknown): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(encodeControlFrame(createControlFrame(type, payload)))
  }

  private scheduleHeartbeat(): void {
    this.clearHeartbeat()
    // The server pings every 25s and drops silent peers after 75s; answering
    // server pings (above) is sufficient, this timer is a cheap liveness probe.
    this.pingTimer = setInterval(() => this.sendControl('ping', { nonce: crypto.randomUUID() }), 25_000)
  }

  private clearHeartbeat(): void {
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer)
    this.pingTimer = undefined
  }

  private handleClose(code: number, reason: string): void {
    this.options.onClose?.({ code, reason })
    void this.close()
  }

  private notifyClose(): void {
    const handler = this.closeHandler
    this.closeHandler = undefined
    handler?.(new Error('Relay link closed.'))
  }

  private requireSocket(): WebSocket {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Relay link is not connected.')
    return this.ws
  }
}
