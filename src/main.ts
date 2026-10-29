import { resolve } from 'node:path'
import { createRemoteServer } from './server.js'
import { DEFAULT_STUN_URLS, splitUrlList, type IceConfig } from './ice.js'

const port = Number(process.env.DSH_SERVER_PORT ?? '8080')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DSH_SERVER_PORT.')
const rawTtl = process.env.DSH_SERVER_TURN_TTL
const ice: Partial<IceConfig> = {
  // An unset variable keeps the built-in STUN default; an empty value disables STUN.
  stunUrls: process.env.DSH_SERVER_STUN_URLS === undefined
    ? DEFAULT_STUN_URLS
    : splitUrlList(process.env.DSH_SERVER_STUN_URLS),
  // Order the endpoints by what this deployment can actually reach. Turn it off
  // for networks that must not emit diagnostics traffic (DSH_SERVER_STUN_PROBE=0).
  probeStun: !['0', 'false', 'off', 'no'].includes((process.env.DSH_SERVER_STUN_PROBE ?? '').trim().toLowerCase()),
  turnUrls: splitUrlList(process.env.DSH_SERVER_TURN_URLS),
  ...(process.env.DSH_SERVER_TURN_SECRET ? { turnSecret: process.env.DSH_SERVER_TURN_SECRET } : {}),
  ...(process.env.DSH_SERVER_TURN_USERNAME ? { turnUsername: process.env.DSH_SERVER_TURN_USERNAME } : {}),
  ...(process.env.DSH_SERVER_TURN_PASSWORD ? { turnPassword: process.env.DSH_SERVER_TURN_PASSWORD } : {}),
  ...(rawTtl === undefined || rawTtl.trim() === '' ? {} : { turnTtlSeconds: Number(rawTtl) }),
}
const app = createRemoteServer({
  account: process.env.DSH_SERVER_ACCOUNT ?? '',
  password: process.env.DSH_SERVER_PASSWORD ?? '',
  publicUrl: process.env.DSH_SERVER_PUBLIC_URL ?? `http://localhost:${port}`,
  dataFile: resolve(process.env.DSH_SERVER_DATA_FILE ?? 'data/state.json'),
  webrtc: !['0', 'false', 'off', 'no'].includes((process.env.DSH_SERVER_WEBRTC ?? '').trim().toLowerCase()),
  androidLoginCompat: !['0', 'false', 'off', 'no'].includes((process.env.DSH_SERVER_ANDROID_LOGIN_COMPAT ?? '').trim().toLowerCase()),
  ice,
  trustedProxies: (process.env.DSH_SERVER_TRUSTED_PROXIES ?? '').split(',').map(value => value.trim()).filter(Boolean),
})
app.server.listen(port, process.env.DSH_SERVER_HOST ?? '127.0.0.1', () => console.info(`Remote Server listening on port ${port}`))
app.server.on('error', () => { console.error('Remote Server could not listen. Check address and port.'); process.exitCode = 1; app.gateway.close(); app.history.close() })
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return
  stopping = true
  void app.close().then(() => { process.exitCode = 0 }, () => { process.exitCode = 1 })
})
