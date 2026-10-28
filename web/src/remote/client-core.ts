/**
 * Port of the shared RemoteClientCore (upstream packages/client-core): RPC
 * correlation and event fan-out over an encrypted transport.
 */
import {
  createRpcRequest,
  decodeMessage,
  encodeMessage,
  type EventPayload,
  type RemoteMessage,
  type RpcErrorPayload,
  type RpcResponsePayload,
} from './protocol'
import type { RemoteTransport } from './secure-transport'

export type RemoteClientErrorCode = 'RPC_TIMEOUT' | 'RPC_ABORTED' | 'TRANSPORT_CLOSED' | 'CLIENT_CLOSED'

export class RemoteClientError extends Error {
  constructor(readonly code: RemoteClientErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemoteClientError'
  }
}

export class RemoteRpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RemoteRpcError'
  }
}

interface PendingCall {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  removeAbort?: () => void
}

export interface RemoteRpcOptions {
  timeoutMs?: number
}

export class RemoteClientCore {
  private readonly pending = new Map<string, PendingCall>()
  private readonly eventHandlers = new Set<(event: EventPayload) => void>()
  private unsubscribeTransport?: () => void
  private unsubscribeClose?: () => void
  private readonly closeHandlers = new Set<(error?: Error) => void>()
  private closeNotified = false

  constructor(private readonly transport: RemoteTransport, private readonly timeoutMs = 30_000) {}

  async connect(): Promise<void> {
    if (this.unsubscribeTransport !== undefined) return
    this.closeNotified = false
    this.unsubscribeTransport = this.transport.onMessage(data => this.handleMessage(data))
    this.unsubscribeClose = this.transport.onClose?.(error => this.handleTransportClose(error))
    try {
      await this.transport.connect()
    } catch (error) {
      this.unsubscribeTransport()
      this.unsubscribeTransport = undefined
      this.unsubscribeClose?.()
      this.unsubscribeClose = undefined
      throw error
    }
  }

  async rpc<TResult = unknown, TParams = unknown>(
    method: string,
    params: TParams,
    signal?: AbortSignal,
    options?: RemoteRpcOptions | number,
  ): Promise<TResult> {
    if (signal?.aborted) throw new RemoteClientError('RPC_ABORTED', `RPC ${method} was aborted`)

    const timeoutMs = typeof options === 'number' ? options : callTimeoutMs(this.timeoutMs, options)
    const request = createRpcRequest(method, params)
    const result = new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPending(request.id, new RemoteClientError('RPC_TIMEOUT', `RPC ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const pending: PendingCall = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      }
      if (signal !== undefined) {
        const onAbort = () => {
          if (this.pending.get(request.id) !== pending) return
          this.rejectPending(request.id, new RemoteClientError('RPC_ABORTED', `RPC ${method} was aborted`))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        pending.removeAbort = () => signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(request.id, pending)
    })

    try {
      const send = this.transport.send(encodeMessage(request))
      void send.catch(error => {
        this.rejectPending(request.id, error instanceof Error ? error : new Error('Transport send failed.'))
      })
    } catch (error) {
      this.rejectPending(request.id, error instanceof Error ? error : new Error('Transport send failed.'))
    }

    return result
  }

  onEvent(handler: (event: EventPayload) => void): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onClose(handler: (error?: Error) => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  getStats(): { connected: boolean; mode: string } {
    return this.transport.getStats()
  }

  async close(): Promise<void> {
    this.unsubscribeTransport?.()
    this.unsubscribeTransport = undefined
    this.unsubscribeClose?.()
    this.unsubscribeClose = undefined
    this.rejectAllPending(
      pending => new RemoteClientError('CLIENT_CLOSED', `RPC ${pending.method} terminated because the remote client closed`),
    )
    this.notifyClose(new RemoteClientError('CLIENT_CLOSED', 'The remote client was closed.'))
    await this.transport.close()
  }

  private handleTransportClose(error?: Error): void {
    this.rejectAllPending(
      pending => new RemoteClientError('TRANSPORT_CLOSED', `RPC ${pending.method} terminated because the remote transport closed`),
    )
    this.notifyClose(error)
  }

  private handleMessage(data: Uint8Array): void {
    const message = decodeMessage(data)
    if (message.type === 'rpc.response') this.handleResponse(message as RemoteMessage<RpcResponsePayload>)
    if (message.type === 'rpc.error') this.handleError(message as RemoteMessage<RpcErrorPayload>)
    if (message.type === 'event') {
      const event = message.payload as EventPayload
      for (const handler of this.eventHandlers) handler(event)
    }
  }

  private handleResponse(message: RemoteMessage<RpcResponsePayload>): void {
    const pending = this.takePending(message.payload.requestId)
    if (pending === undefined) return
    pending.resolve(message.payload.result)
  }

  private handleError(message: RemoteMessage<RpcErrorPayload>): void {
    const pending = this.takePending(message.payload.requestId)
    if (pending === undefined) return
    pending.reject(new RemoteRpcError(message.payload.code, message.payload.message))
  }

  private takePending(requestId: string): PendingCall | undefined {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return undefined
    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.removeAbort?.()
    return pending
  }

  private rejectPending(requestId: string, error: Error): boolean {
    const pending = this.takePending(requestId)
    if (pending === undefined) return false
    pending.reject(error)
    return true
  }

  private rejectAllPending(createError: (pending: PendingCall) => Error): void {
    for (const requestId of [...this.pending.keys()]) {
      const pending = this.takePending(requestId)
      if (pending !== undefined) pending.reject(createError(pending))
    }
  }

  private notifyClose(error?: Error): void {
    if (this.closeNotified) return
    this.closeNotified = true
    for (const handler of this.closeHandlers) handler(error)
  }
}

function callTimeoutMs(fallback: number, options: RemoteRpcOptions | undefined): number {
  const timeoutMs = options?.timeoutMs
  if (typeof timeoutMs !== 'number') return fallback
  return Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647 ? timeoutMs : fallback
}
