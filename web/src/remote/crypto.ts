/**
 * Browser port of the DSH Remote Noise IK wrapper (upstream packages/crypto).
 *
 * The suite is fixed to Noise_IK_25519_ChaChaPoly_SHA256 and the transcript's
 * remote static key is verified before any transport message is accepted —
 * identical trust rules to every other DSH client.
 */
import {
  NqHandshake,
  chachaPoly,
  noiseIk,
  sha256H,
  x25519Keygen,
  type TransportState,
} from '@lukeburns/clatterjs'
import { fromBase64Url, toBase64Url } from './base64'

export const NOISE_IK_PROTOCOL = 'Noise_IK_25519_ChaChaPoly_SHA256' as const

export interface KeyPair {
  publicKey: string
  privateKey: string
}

export interface NoiseIkSessionOptions {
  role: 'initiator' | 'responder'
  localPrivateKey: string
  localPublicKey: string
  remotePublicKey: string
  prologue: Uint8Array
  random?: (length: number) => Uint8Array
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

/** Fresh X25519 identity in the base64url encoding every DSH peer exchanges. */
export function generateKeyPair(): KeyPair {
  const { publicKey, secretKey } = x25519Keygen(randomBytes)
  return { publicKey: toBase64Url(publicKey), privateKey: toBase64Url(secretKey) }
}

export class NoiseIkSession {
  private readonly handshake: NqHandshake
  private readonly expectedRemoteStatic: Uint8Array
  private transport?: TransportState
  private destroyed = false

  constructor(options: NoiseIkSessionOptions) {
    const localPrivate = requireKey(options.localPrivateKey, 'local private key')
    const localPublic = requireKey(options.localPublicKey, 'local public key')
    this.expectedRemoteStatic = requireKey(options.remotePublicKey, 'remote public key')
    const initiator = options.role === 'initiator'
    this.handshake = new NqHandshake(noiseIk(), {
      prologue: Uint8Array.from(options.prologue),
      initiator,
      s: { secretKey: localPrivate, publicKey: localPublic },
      ...(initiator ? { rs: Uint8Array.from(this.expectedRemoteStatic) } : {}),
      cipher: chachaPoly,
      hash: sha256H,
      rng: options.random ?? randomBytes,
    })
    if (this.handshake.getName() !== NOISE_IK_PROTOCOL) {
      throw new NoiseSessionError('NOISE_SUITE_MISMATCH', 'The Noise provider selected an unexpected cipher suite.')
    }
  }

  get protocol(): typeof NOISE_IK_PROTOCOL { return NOISE_IK_PROTOCOL }

  get complete(): boolean { return this.transport !== undefined }

  writeHandshake(payload = new Uint8Array()): Uint8Array {
    this.assertHandshake(false)
    const output = new Uint8Array(payload.byteLength + this.handshake.getNextMessageOverhead())
    const length = this.handshake.writeMessage(payload, output)
    this.finishIfReady()
    return output.slice(0, length)
  }

  readHandshake(message: Uint8Array): Uint8Array {
    this.assertHandshake(true)
    const output = new Uint8Array(message.byteLength)
    const length = this.handshake.readMessage(message, output)
    this.verifyRemoteStatic()
    this.finishIfReady()
    return output.slice(0, length)
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    this.assertLive()
    if (this.transport === undefined) throw new NoiseSessionError('NOISE_NOT_READY', 'The Noise handshake is not complete.')
    return this.transport.sendVec(plaintext)
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    this.assertLive()
    if (this.transport === undefined) throw new NoiseSessionError('NOISE_NOT_READY', 'The Noise handshake is not complete.')
    return this.transport.receiveVec(ciphertext)
  }

  destroy(): void {
    this.destroyed = true
    this.expectedRemoteStatic.fill(0)
    this.transport = undefined
  }

  private finishIfReady(): void {
    if (!this.handshake.isFinished()) return
    this.verifyRemoteStatic()
    this.transport = this.handshake.finalize()
  }

  private verifyRemoteStatic(): void {
    const actual = this.handshake.getRemoteStatic()
    if (actual === undefined || !constantTimeEqual(actual, this.expectedRemoteStatic)) {
      this.destroy()
      throw new NoiseSessionError('PEER_IDENTITY_MISMATCH', 'The Noise peer static key does not match local trust.')
    }
  }

  private assertHandshake(reading: boolean): void {
    this.assertLive()
    if (this.complete) throw new NoiseSessionError('NOISE_ALREADY_READY', 'The Noise handshake is already complete.')
    if (this.handshake.isWriteTurn() === reading) {
      throw new NoiseSessionError('NOISE_HANDSHAKE_ORDER', 'The Noise handshake message arrived out of order.')
    }
  }

  private assertLive(): void {
    if (this.destroyed) throw new NoiseSessionError('NOISE_DESTROYED', 'The Noise session is closed.')
  }
}

export class NoiseSessionError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export function createNoisePrologue(connectionId: string, hostDeviceId: string, clientDeviceId: string): Uint8Array {
  for (const [name, value] of Object.entries({ connectionId, hostDeviceId, clientDeviceId })) {
    if (value.length === 0 || value.includes('\0')) throw new TypeError(`${name} is not safe for a Noise prologue`)
  }
  return new TextEncoder().encode(
    `DSH-REMOTE\0v=1\0connection=${connectionId}\0host=${hostDeviceId}\0client=${clientDeviceId}`,
  )
}

function requireKey(value: string, label: string): Uint8Array {
  const key = fromBase64Url(value)
  if (key.byteLength !== 32) throw new NoiseSessionError('INVALID_KEY', `${label} must be a 32-byte X25519 key.`)
  return Uint8Array.from(key)
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let different = 0
  for (let index = 0; index < left.byteLength; index += 1) different |= left[index]! ^ right[index]!
  return different === 0
}
