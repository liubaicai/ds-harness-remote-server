/**
 * Noise IK transport over the relay link — the browser counterpart of the
 * Android SecureTransport. Plaintext business messages are fragmented
 * (SecureMessageCodec), encrypted (Noise transport messages) and carried as
 * relay ciphertext; the server never sees plaintext.
 */
import { createNoisePrologue, NoiseIkSession, type KeyPair } from './crypto'
import { SecureMessageCodec } from './secure-codec'
import type { RelayLink } from './relay-link'

export interface RemoteTransport {
  connect(): Promise<void>
  send(data: Uint8Array): Promise<void>
  onMessage(cb: (data: Uint8Array) => void): () => void
  onClose?(handler: (error?: Error) => void): () => void
  close(): Promise<void>
  getStats(): { connected: boolean; mode: string }
}

export interface SecureTransportOptions {
  identity: KeyPair & { deviceId: string }
  host: { deviceId: string; identityKey: string }
  onHandshakeStarting?: () => void
}

export class SecureTransport implements RemoteTransport {
  private noise?: NoiseIkSession
  private unsubscribeInner?: () => void
  private readonly incoming = new SecureMessageCodec()
  private readonly outgoing = new SecureMessageCodec()
  private closed = false
  private sendTail: Promise<void> = Promise.resolve()

  constructor(private readonly inner: RelayLink, private readonly options: SecureTransportOptions) {
    if (options.host.identityKey.length === 0) throw new Error('Host identity key is missing.')
  }

  async connect(): Promise<void> {
    this.closed = false
    this.incoming.reset()
    this.outgoing.reset()
    await this.inner.connect()
    const info = this.inner.connectionInfo()
    if (info.localDeviceId !== this.options.identity.deviceId || info.remoteDeviceId !== this.options.host.deviceId) {
      await this.inner.close()
      throw new Error('Relay link negotiated unexpected endpoints.')
    }
    this.options.onHandshakeStarting?.()
    const noise = new NoiseIkSession({
      role: 'initiator',
      localPrivateKey: this.options.identity.privateKey,
      localPublicKey: this.options.identity.publicKey,
      remotePublicKey: this.options.host.identityKey,
      prologue: createNoisePrologue(info.connectionId, this.options.host.deviceId, this.options.identity.deviceId),
    })
    this.noise = noise
    try {
      await waitForResponder(this.inner, noise)
    } catch (error) {
      noise.destroy()
      this.noise = undefined
      await this.inner.close()
      throw error
    }
  }

  async send(data: Uint8Array): Promise<void> {
    const run = this.sendTail.then(() => this.sendNow(data))
    this.sendTail = run.catch(() => undefined)
    return run
  }

  private async sendNow(data: Uint8Array): Promise<void> {
    const plaintextFrames = this.outgoing.encode(data)
    try {
      for (const plaintext of plaintextFrames) {
        await this.inner.send(this.requireNoise().encrypt(plaintext))
      }
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  onMessage(cb: (data: Uint8Array) => void): () => void {
    this.unsubscribeInner?.()
    this.unsubscribeInner = this.inner.onMessage(data => {
      const noise = this.noise
      if (noise === undefined || !noise.complete || this.closed) return
      try {
        const plaintext = noise.decrypt(data)
        const message = this.incoming.decode(plaintext)
        if (message !== undefined) cb(message)
      } catch {
        // Decrypt/reassembly failures mean the carrier is no longer trustworthy.
        void this.close()
      }
    })
    return () => {
      this.unsubscribeInner?.()
      this.unsubscribeInner = undefined
    }
  }

  onClose(handler: (error?: Error) => void): () => void {
    return this.inner.onClose?.(handler) ?? (() => undefined)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.unsubscribeInner?.()
    this.unsubscribeInner = undefined
    this.incoming.reset()
    this.outgoing.reset()
    this.noise?.destroy()
    this.noise = undefined
    await this.inner.close()
  }

  getStats(): { connected: boolean; mode: string } { return this.inner.getStats() }

  private requireNoise(): NoiseIkSession {
    if (this.noise === undefined || !this.noise.complete || this.closed) {
      throw new Error('The secure channel is not connected.')
    }
    return this.noise
  }
}

async function waitForResponder(inner: RelayLink, noise: NoiseIkSession): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finish(new Error('The secure handshake timed out.')), 15_000)
    const unsubscribe = inner.onHandshake((step, data) => {
      if (settled) return
      try {
        if (step !== 2) throw new Error('The secure handshake message arrived out of order.')
        noise.readHandshake(data)
        if (!noise.complete) throw new Error('The secure handshake did not complete.')
        finish()
      } catch (error) {
        finish(error instanceof Error ? error : new Error('The secure handshake failed.'))
      }
    })
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      if (error === undefined) resolve()
      else reject(error)
    }
    void inner.sendHandshake(1, noise.writeHandshake()).catch(error => {
      finish(error instanceof Error ? error : new Error('The secure handshake failed.'))
    })
  })
}
