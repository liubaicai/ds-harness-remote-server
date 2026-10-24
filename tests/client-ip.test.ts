import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createClientIpResolver } from '../src/client-ip.js'

function request(remoteAddress?: string, forwarded?: string | string[]): Pick<IncomingMessage, 'socket' | 'headers'> {
  return { socket: { remoteAddress } as IncomingMessage['socket'], headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } }
}

describe('trusted proxy client IP resolver', () => {
  it('does not trust forwarded headers by default or from an untrusted peer', () => {
    expect(createClientIpResolver()(request('203.0.113.9', '192.0.2.1'))).toBe('203.0.113.9')
    expect(createClientIpResolver(['10.0.0.0/8'])(request('203.0.113.9', '192.0.2.1'))).toBe('203.0.113.9')
    expect(createClientIpResolver(['0.0.0.0/0'])(request(undefined, '192.0.2.1'))).toBe('unknown')
  })

  it('uses a trusted proxy header and strips trusted hops from right to left', () => {
    const resolve = createClientIpResolver(['10.0.0.0/8', '192.168.1.2'])
    expect(resolve(request('10.0.0.4', '198.51.100.1'))).toBe('198.51.100.1')
    expect(resolve(request('10.0.0.4', '203.0.113.99, 198.51.100.1, 192.168.1.2'))).toBe('198.51.100.1')
    expect(resolve(request('10.0.0.4', '10.1.2.3, 192.168.1.2'))).toBe('10.1.2.3')
    expect(resolve(request('10.0.0.4'))).toBe('10.0.0.4')
  })

  it('matches exact addresses and IPv4 CIDR boundaries', () => {
    const resolve = createClientIpResolver(['192.0.2.128/25', '198.51.100.10'])
    for (const ip of ['192.0.2.128', '192.0.2.255', '198.51.100.10']) expect(resolve(request(ip, '203.0.113.9'))).toBe('203.0.113.9')
    for (const ip of ['192.0.2.127', '192.0.3.0', '198.51.100.11']) expect(resolve(request(ip, '203.0.113.9'))).toBe(ip)
  })

  it('matches IPv6 CIDRs and canonicalizes equivalent spellings', () => {
    const resolve = createClientIpResolver(['2001:db8:abcd::/48', '::1'])
    expect(resolve(request('2001:db8:abcd:ffff::1', '2001:0DB8:0000:0000:0000:0000:0000:0009'))).toBe('2001:db8::9')
    expect(resolve(request('2001:db8:abce::1', '198.51.100.1'))).toBe('2001:db8:abce::1')
    expect(resolve(request('0:0:0:0:0:0:0:1', '198.51.100.1'))).toBe('198.51.100.1')
    expect(createClientIpResolver()(request('0:0:0:0:0:0:0:0'))).toBe('::')
  })

  it('normalizes IPv4-mapped peers, headers, exact entries and mapped CIDRs', () => {
    const resolve = createClientIpResolver(['10.0.0.0/8'])
    expect(resolve(request('::ffff:10.0.0.1', '::ffff:c000:201'))).toBe('192.0.2.1')
    expect(createClientIpResolver(['::ffff:10.0.0.0/104'])(request('10.1.2.3', '192.0.2.1'))).toBe('192.0.2.1')
    expect(createClientIpResolver(['::ffff:10.0.0.1'])(request('10.0.0.1', '192.0.2.1'))).toBe('192.0.2.1')
    expect(createClientIpResolver(['::/0'])(request('::ffff:10.0.0.1', '192.0.2.1'))).toBe('10.0.0.1')
    expect(resolve(request('::10.0.0.1', '192.0.2.1'))).toBe('::a00:1')
  })

  it.each(['', 'unknown', '198.51.100.1,', '198.51.100.1, bad', '[::1]', '192.0.2.1:443', 'fe80::1%eth0', '010.0.0.1', '192.0.2.1,,10.0.0.2'])('fails closed for malformed XFF %j', forwarded => {
    expect(createClientIpResolver(['10.0.0.0/8'])(request('10.0.0.1', forwarded))).toBe('10.0.0.1')
  })

  it('ignores ambiguous array headers and other forwarding header formats', () => {
    const resolve = createClientIpResolver(['127.0.0.1'])
    expect(resolve(request('127.0.0.1', ['192.0.2.1', '192.0.2.2']))).toBe('127.0.0.1')
    const req = request('127.0.0.1')
    req.headers.forwarded = 'for=192.0.2.1'
    req.headers['x-real-ip'] = '192.0.2.1'
    expect(resolve(req)).toBe('127.0.0.1')
  })

  it.each(['*', 'localhost', '', '10.0.0.1/', '10.0.0.0/33', '::1/129', '::1/-1', '10.0.0.0/8/1', '10.0.0.0/08', 'fe80::1%eth0', '::ffff:0:0/95', '[::1]'])('rejects invalid configuration %j', entry => {
    expect(() => createClientIpResolver([entry])).toThrow('Invalid trusted proxy IP/CIDR')
  })
})
