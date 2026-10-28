/**
 * Trimmed port of the shared RemoteTypertGateway (upstream packages/client-core):
 * the typed Harness business carrier over `harness.remote.call` / stream.
 */
import type { RemoteClientCore } from './client-core'

const DIRECT_REMOTE_CALL_BYTES = 2 * 1024 * 1024

export class RemoteGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'RemoteGatewayError'
  }
}

export interface RemoteGatewayStream extends AsyncIterable<unknown> {
  close(notifyRemote?: boolean): Promise<void>
}

export class RemoteTypertGateway {
  constructor(private readonly client: RemoteClientCore) {}

  /** Typed endpoint call: `endpoint` with `{ args }`, unwrapping `{ok,value}` results. */
  async call<T = unknown>(endpoint: string, payload: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    const request = { endpoint, payload }
    const encoded = new TextEncoder().encode(JSON.stringify(request))
    if (encoded.byteLength > DIRECT_REMOTE_CALL_BYTES) {
      throw new RemoteGatewayError('REQUEST_TOO_LARGE', 'The Harness request exceeds the direct call limit.')
    }
    const response = await this.client.rpc<unknown>('harness.remote.call', request, signal, timeoutMs === undefined ? undefined : { timeoutMs })
    return unwrapResult<T>(response)
  }

  async open(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RemoteGatewayStream> {
    const streamId = createRemoteId()
    const queue = new AsyncValueQueue()
    const remoteClose = { enabled: true }
    const unsubscribe = this.client.onEvent(event => {
      if (event.event !== 'harness.remote.frame') return
      const data = event.data as { streamId?: string; hasValue?: boolean; value?: unknown }
      if (data.streamId === streamId && data.hasValue === true) queue.push(data.value)
    })
    const unsubscribeClose = this.client.onClose(() => {
      queue.fail(new RemoteGatewayError('TRANSPORT_CLOSED', 'The Harness stream transport closed.'))
    })
    const onAbort = () => queue.close()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await this.client.rpc('harness.remote.stream.open', { streamId, endpoint, payload }, signal)
    } catch (error) {
      signal?.removeEventListener('abort', onAbort)
      unsubscribe()
      unsubscribeClose()
      void this.client.rpc('harness.remote.stream.close', { streamId }).catch(() => undefined)
      throw error
    }
    const iterate = async function* (this: RemoteTypertGateway): AsyncGenerator<unknown> {
      try {
        yield* queue
      } finally {
        signal?.removeEventListener('abort', onAbort)
        unsubscribe()
        unsubscribeClose()
        queue.close()
        if (remoteClose.enabled) await this.client.rpc('harness.remote.stream.close', { streamId }).catch(() => undefined)
      }
    }.bind(this)
    return {
      [Symbol.asyncIterator]: () => iterate(),
      close: async (notifyRemote = true) => {
        remoteClose.enabled = notifyRemote
        queue.close()
        await iterate().return(undefined)
      },
    }
  }
}

function unwrapResult<T>(value: unknown): T {
  if (isRecord(value) && value.ok === true) return value.value as T
  if (isRecord(value) && value.ok === false && isRecord(value.error)) {
    throw new RemoteGatewayError(
      typeof value.error.code === 'string' ? value.error.code : 'internal',
      typeof value.error.message === 'string' ? value.error.message : 'The Host rejected the Remote request.',
      isRecord(value.error.details) ? value.error.details : {},
    )
  }
  return value as T
}

class AsyncValueQueue implements AsyncIterable<unknown> {
  private readonly values: unknown[] = []
  private readonly waiters: Array<(result: IteratorResult<unknown>) => void> = []
  private closed = false
  private error?: Error

  push(value: unknown): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(value)
    else waiter({ done: false, value })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  fail(error: Error): void {
    if (this.closed) return
    this.error = error
    this.close()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift()
        continue
      }
      if (this.closed) {
        if (this.error !== undefined) throw this.error
        return
      }
      const next = await new Promise<IteratorResult<unknown>>(resolve => this.waiters.push(resolve))
      if (next.done) {
        if (this.error !== undefined) throw this.error
        return
      }
      yield next.value
    }
  }
}

export function createRemoteId(): string {
  if (globalThis.crypto?.randomUUID !== undefined) return globalThis.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
