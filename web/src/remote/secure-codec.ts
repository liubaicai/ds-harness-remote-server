/**
 * Port of the protocol SecureMessageCodec (upstream packages/protocol).
 *
 * Noise transport messages have a 65,535-byte ceiling, so large application
 * messages are split before encryption and reassembled after decryption.
 */

const SECURE_FRAGMENT_MAGIC = new Uint8Array([0x44, 0x53, 0x48, 0x46]) // DSHF
const SECURE_FRAGMENT_VERSION = 1
const SECURE_FRAGMENT_HEADER_BYTES = 17
export const SECURE_FRAGMENT_CHUNK_BYTES = 48 * 1024
export const MAX_SECURE_MESSAGE_BYTES = 4 * 1024 * 1024
const MAX_IN_FLIGHT_SECURE_MESSAGES = 8

interface FragmentAssembly {
  total: number
  totalBytes: number
  receivedBytes: number
  chunks: Uint8Array[]
}

export class SecureMessageCodec {
  private nextMessageId = 1
  private readonly assemblies = new Map<number, FragmentAssembly>()

  encode(message: Uint8Array): Uint8Array[] {
    if (message.byteLength > MAX_SECURE_MESSAGE_BYTES) {
      throw new Error('Secure message exceeds the reassembly limit.')
    }
    if (message.byteLength <= SECURE_FRAGMENT_CHUNK_BYTES) return [message]

    const messageId = this.nextMessageId
    this.nextMessageId = messageId === 0xffff_ffff ? 1 : messageId + 1
    const total = Math.ceil(message.byteLength / SECURE_FRAGMENT_CHUNK_BYTES)
    const frames: Uint8Array[] = []
    for (let index = 0; index < total; index += 1) {
      const start = index * SECURE_FRAGMENT_CHUNK_BYTES
      const chunk = message.subarray(start, Math.min(message.byteLength, start + SECURE_FRAGMENT_CHUNK_BYTES))
      const frame = new Uint8Array(SECURE_FRAGMENT_HEADER_BYTES + chunk.byteLength)
      frame.set(SECURE_FRAGMENT_MAGIC)
      frame[4] = SECURE_FRAGMENT_VERSION
      const view = new DataView(frame.buffer)
      view.setUint32(5, messageId)
      view.setUint16(9, index)
      view.setUint16(11, total)
      view.setUint32(13, message.byteLength)
      frame.set(chunk, SECURE_FRAGMENT_HEADER_BYTES)
      frames.push(frame)
    }
    return frames
  }

  decode(frame: Uint8Array): Uint8Array | undefined {
    if (!isSecureFragment(frame)) return frame
    if (frame.byteLength < SECURE_FRAGMENT_HEADER_BYTES || frame[4] !== SECURE_FRAGMENT_VERSION) {
      throw new Error('Secure fragment header is invalid.')
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const messageId = view.getUint32(5)
    const index = view.getUint16(9)
    const total = view.getUint16(11)
    const totalBytes = view.getUint32(13)
    if (messageId === 0 || total < 2 || index >= total || totalBytes <= SECURE_FRAGMENT_CHUNK_BYTES
      || totalBytes > MAX_SECURE_MESSAGE_BYTES
      || total !== Math.ceil(totalBytes / SECURE_FRAGMENT_CHUNK_BYTES)) {
      throw new Error('Secure fragment metadata is invalid.')
    }
    const expectedChunkBytes = Math.min(
      SECURE_FRAGMENT_CHUNK_BYTES,
      totalBytes - index * SECURE_FRAGMENT_CHUNK_BYTES,
    )
    const chunk = frame.subarray(SECURE_FRAGMENT_HEADER_BYTES)
    if (chunk.byteLength !== expectedChunkBytes) throw new Error('Secure fragment length is invalid.')

    let assembly = this.assemblies.get(messageId)
    if (assembly === undefined) {
      if (index !== 0 || this.assemblies.size >= MAX_IN_FLIGHT_SECURE_MESSAGES) {
        throw new Error('Secure fragment sequence is invalid.')
      }
      assembly = { total, totalBytes, receivedBytes: 0, chunks: [] }
      this.assemblies.set(messageId, assembly)
    }
    if (assembly.total !== total || assembly.totalBytes !== totalBytes || index !== assembly.chunks.length) {
      this.assemblies.delete(messageId)
      throw new Error('Secure fragment sequence is invalid.')
    }
    assembly.chunks.push(Uint8Array.from(chunk))
    assembly.receivedBytes += chunk.byteLength
    if (assembly.chunks.length < total) return undefined
    this.assemblies.delete(messageId)
    if (assembly.receivedBytes !== totalBytes) throw new Error('Secure message length is invalid.')
    const message = new Uint8Array(totalBytes)
    let offset = 0
    for (const part of assembly.chunks) {
      message.set(part, offset)
      offset += part.byteLength
    }
    return message
  }

  reset(): void {
    this.nextMessageId = 1
    this.assemblies.clear()
  }
}

function isSecureFragment(frame: Uint8Array): boolean {
  if (frame.byteLength < SECURE_FRAGMENT_MAGIC.byteLength) return false
  for (let index = 0; index < SECURE_FRAGMENT_MAGIC.byteLength; index += 1) {
    if (frame[index] !== SECURE_FRAGMENT_MAGIC[index]) return false
  }
  return true
}
