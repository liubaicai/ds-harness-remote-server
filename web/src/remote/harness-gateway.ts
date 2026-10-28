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

  async open(
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
    options?: { transferFrames?: boolean },
  ): Promise<RemoteGatewayStream> {
    const streamId = createRemoteId()
    const queue = new AsyncValueQueue()
    const rawQueue = new AsyncValueQueue()
    const remoteClose = { enabled: true }
    const unsubscribe = this.client.onEvent(event => {
      if (event.event === 'harness.remote.frame') {
        const data = event.data as {
          streamId?: string
          hasValue?: boolean
          value?: unknown
          transfer?: { kind?: string; transferId: string; totalBytes: number; totalChunks: number }
        }
        if (data.streamId !== streamId || data.hasValue !== true) return
        rawQueue.push(data)
        return
      }
      if (event.event === 'harness.remote.stream.closed') {
        const data = event.data as { streamId?: string; reason?: string; failure?: { code?: string; message?: string } }
        if (data.streamId !== streamId) return
        if (data.reason === 'failed') {
          rawQueue.fail(new RemoteGatewayError(
            typeof data.failure?.code === 'string' ? data.failure.code : 'STREAM_FAILED',
            typeof data.failure?.message === 'string' ? data.failure.message : 'The Harness stream failed.',
          ))
        } else {
          rawQueue.close()
        }
      }
    })
    const unsubscribeClose = this.client.onClose(() => {
      rawQueue.fail(new RemoteGatewayError('TRANSPORT_CLOSED', 'The Harness stream transport closed.'))
    })
    // Oversized frames arrive as transfer descriptors (when the Host is told it
    // may chunk them): reassemble before handing values to the consumer.
    void (async () => {
      try {
        for await (const raw of rawQueue) {
          const data = raw as { value?: unknown; transfer?: { transferId: string; totalBytes: number; totalChunks: number } }
          if (data.transfer) queue.push(await this.readTransferredFrame(data.transfer, signal))
          else queue.push(data.value)
        }
      } catch (error) {
        queue.fail(error instanceof Error ? error : new Error(String(error)))
      } finally {
        queue.close()
      }
    })()
    const onAbort = () => rawQueue.close()
    signal?.addEventListener('abort', onAbort, { once: true })
    const openParams = { streamId, endpoint, payload, ...(options?.transferFrames ? { transferFrames: true } : {}) }
    try {
      await this.client.rpc('harness.remote.stream.open', openParams, signal)
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
        rawQueue.close()
        queue.close()
        if (remoteClose.enabled) await this.client.rpc('harness.remote.stream.close', { streamId }).catch(() => undefined)
      }
    }.bind(this)
    return {
      [Symbol.asyncIterator]: () => iterate(),
      close: async (notifyRemote = true) => {
        remoteClose.enabled = notifyRemote
        rawQueue.close()
        queue.close()
        await iterate().return(undefined)
      },
    }
  }

  private async readTransferredFrame(
    transfer: { transferId: string; totalBytes: number; totalChunks: number },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const chunks: Uint8Array[] = []
    try {
      for (let index = 0; index < transfer.totalChunks; index += 1) {
        const part = await this.client.rpc<{ transferId: string; index: number; data: string }>(
          'harness.remote.transfer.read', { transferId: transfer.transferId, index }, signal,
        )
        chunks.push(canonicalBase64ToBytes(part.data))
      }
      const bytes = concat(chunks, transfer.totalBytes)
      const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as { value?: unknown }
      return frame.value
    } finally {
      await this.client.rpc('harness.remote.transfer.close', { transferId: transfer.transferId }).catch(() => undefined)
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

function canonicalBase64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function concat(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const output = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
