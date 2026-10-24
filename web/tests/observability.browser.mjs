// Optional real-browser UI smoke test. Build first, then run with Node 22.
// BROWSER_PATH may point to Chromium, Chrome or Edge. No browser automation dependency.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'

const browserPath = process.env.BROWSER_PATH ?? [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find(existsSync)
if (!browserPath) throw new Error('Set BROWSER_PATH to a Chromium browser executable.')
const output = mkdtempSync(join(tmpdir(), 'remote-observability-ui-'))
const now = Date.now()
const retention = { maxRecords: 1000, maxAgeMs: 604800000 }
const device = (deviceId, role) => ({ deviceId, role, name: role === 'host' ? '办公电脑' : '手机', platform: 'win32', clientVersion: '0.5.19', online: true })
const records = Array.from({ length: 21 }, (_, i) => ({ connectionId: `connection-${i}`, host: 'host', client: 'client', stage: 'closed', connectedAt: now - 60_000 - i * 60_000, readyAt: now - 59_950 - i * 60_000, endedAt: now - 30_000 - i * 60_000, endReason: 'CONNECTION_REPLACED', selectedTransport: 'relay', handshakeDurationMs: 50, relayBytes: 4096, relayFrames: 4, events: [{ at: now - 60_000 - i * 60_000, type: 'stage', stage: 'pending' }, { at: now - 59_950 - i * 60_000, type: 'stage', stage: 'ready' }, { at: now - 30_000 - i * 60_000, type: 'ended', reason: 'CONNECTION_REPLACED' }] }))
const stats = { generatedAt: now, retention, totals: { connections: 21, active: 0, ready: 21, failed: 0, relayBytes: 86016, relayFrames: 84 }, transports: { lan: 0, p2p: 0, turn: 0, relay: 21, unknown: 0 }, handshake: { samples: 21, averageMs: 50 }, semantics: {}, serverPeerRtt: [{ deviceId: 'host', rttMs: 12, measuredAt: now }] }
let historyMode = 'normal'
const requests = []
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  requests.push(url.pathname + url.search)
  const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
  if (url.pathname === '/api/v1/auth/me') return json({ account: 'demo@example.test' })
  if (url.pathname === '/api/v1/account/devices') return json({ items: [device('host', 'host'), device('client', 'client')], serverUrl: 'https://remote.example.test', transport: 'auto' })
  if (url.pathname === '/api/v1/account/connections') return json({ items: [] })
  if (url.pathname === '/api/v1/account/connection-stats') return json(stats)
  if (url.pathname === '/api/v1/account/connection-history') {
    if (historyMode === 'error') return json({ error: { code: 'INTERNAL_ERROR' } }, 500)
    if (historyMode === 'unauthorized') return json({ error: { code: 'ACCOUNT_AUTH_REQUIRED' } }, 401)
    const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'))
    const available = historyMode === 'empty' ? [] : historyMode === 'single' ? records.slice(0, 1) : records
    return json({ items: available.slice(offset, offset + limit), total: available.length, offset, limit, retention })
  }
  if (url.pathname === '/api/v1/account/diagnostics/export') return json({ schemaVersion: 1, connections: [{ connectionId: 'anonymous-1' }] })
  if (url.pathname === '/api/v1/account/diagnostics') return json({ generatedAt: now, scope: '服务端观测，不主动扫描客户端网络。', checks: [{ id: 'stun', status: 'unknown', title: 'STUN 可达性', message: '未启用启动探测，无法判断客户端可达性。' }, { id: 'relay', status: 'ok', title: '服务器中继', message: '已启用。' }], limitations: ['没有端到端延迟和丢包测量。'], devices: [], connection: url.searchParams.has('connectionId') ? records.find(r => r.connectionId === url.searchParams.get('connectionId')) : null })
  if (url.pathname.startsWith('/api/')) return json({ error: { code: 'METHOD_NOT_FOUND' } }, 404)
  const path = url.pathname.startsWith('/assets/') ? resolve('dist/public', '.' + url.pathname) : resolve('dist/public/index.html')
  if (!existsSync(path)) { res.writeHead(404); res.end(); return }
  res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html')
  res.end(readFileSync(path))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(output, 'profile')}`, 'about:blank'], { stdio: 'ignore' })
const pause = () => new Promise(resolve => setTimeout(resolve, 100))
async function waitFor(check, message) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) { if (await check()) return; await pause() }
  throw new Error(`Timed out: ${message}`)
}
let ws
try {
  const activePort = join(output, 'profile', 'DevToolsActivePort')
  await waitFor(() => existsSync(activePort), 'browser debugger')
  const debugPort = readFileSync(activePort, 'utf8').split('\n')[0]
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  let seq = 0
  const pending = new Map()
  const exceptions = []
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString())
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
    if (message.id) {
      const task = pending.get(message.id); pending.delete(message.id)
      if (message.error) task?.reject(new Error(message.error.message)); else task?.resolve(message.result)
    }
  })
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const text = () => evaluate('document.body.innerText')
  const click = label => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(e => e.innerText.replace(/\\s/g, '') === ${JSON.stringify(label)}); if (!button) throw new Error('Missing button'); button.click(); })()`)
  const screenshot = async name => { const result = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); writeFileSync(join(output, name), Buffer.from(result.data, 'base64')) }
  await cdp('Runtime.enable')
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false })
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output })
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/app/remote` })
  await waitFor(async () => (await text()).includes('50 ms'), 'history and stats')
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light')
  assert.equal(await evaluate('document.querySelectorAll(".connection-insights .ant-table-tbody tr.ant-table-row").length'), 20)
  await evaluate('document.querySelector(".connection-insights").scrollIntoView()')
  await screenshot('history-light.png')
  assert.equal(await evaluate('document.querySelector(".product-github-link").href'), 'https://github.com/liubaicai/ds-harness-remote-server')
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".site-footer-links a")].map(a => a.textContent.trim())'), ['返回首页'])
  assert(await evaluate('document.querySelector(".observability-pagination button[aria-label=上一页]").disabled'))
  assert((await text()).includes('1–20 / 共 21 条'))
  // A failed page request keeps both the previous rows and their page number.
  historyMode = 'error'; await click('下一页')
  await waitFor(async () => (await text()).includes('当前显示上次成功获取的数据'), 'failed page request feedback')
  assert.equal(await evaluate('document.querySelector(".observability-pagination .ant-pagination-item-active").textContent'), '1')
  assert.equal(await evaluate('document.querySelectorAll(".connection-insights .ant-table-tbody tr.ant-table-row").length'), 20)
  historyMode = 'normal'; await click('下一页')
  await waitFor(() => requests.some(path => path.includes('offset=20')), 'pagination request')
  await waitFor(async () => await evaluate('document.querySelectorAll(".connection-insights .ant-table-tbody tr.ant-table-row").length') === 1, 'second history page')
  assert((await text()).includes('21–21 / 共 21 条'))
  assert(await evaluate('document.querySelector(".observability-pagination button[aria-label=下一页]").disabled'))
  await evaluate('document.querySelector(".observability-pagination").scrollIntoView({block: "center"})')
  await screenshot('pagination-light.png')
  await click('上一页')
  await waitFor(async () => await evaluate('document.querySelectorAll(".connection-insights .ant-table-tbody tr.ant-table-row").length') === 20, 'previous history page')
  await evaluate('document.querySelector(".ant-pagination-item-2").click()')
  await waitFor(async () => await evaluate('document.querySelectorAll(".connection-insights .ant-table-tbody tr.ant-table-row").length') === 1, 'page number navigation')
  await click('诊断')
  await waitFor(async () => (await text()).includes('连接时间线'), 'connection diagnostics')
  await screenshot('diagnostics-light.png')
  await click('下载脱敏诊断包')
  await waitFor(() => readdirSync(output).some(name => name.endsWith('.json')), 'diagnostic download')
  const bundle = JSON.parse(readFileSync(join(output, readdirSync(output).find(name => name.endsWith('.json'))), 'utf8'))
  assert.equal(bundle.schemaVersion, 1)
  assert(requests.some(path => path.includes('/diagnostics/export?connectionId=connection-20')))
  await evaluate('document.querySelector(".ant-modal-close").click()')
  await click('连接诊断')
  await waitFor(async () => (await text()).includes('STUN 可达性') && !(await text()).includes('连接时间线'), 'service diagnostics')
  await evaluate('document.querySelector(".ant-modal-close").click()')
  await evaluate("localStorage.setItem('dsh.remote.theme','dark'); location.reload()")
  await waitFor(async () => (await text()).includes('50 ms'), 'dark mode reload')
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark')
  await evaluate('document.querySelector(".connection-insights").scrollIntoView()')
  await screenshot('history-dark.png')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await screenshot('history-mobile.png')
  // The table scrolls horizontally inside its container, not the whole page.
  assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
  await evaluate('document.querySelector(".observability-pagination").scrollIntoView({block: "center"})')
  assert(await evaluate('[...document.querySelectorAll(".observability-pagination .ant-pagination-prev, .observability-pagination .ant-pagination-next")].every(item => item.getBoundingClientRect().width >= 64)'))
  await screenshot('pagination-mobile.png')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true })
  assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await click('诊断')
  await waitFor(async () => (await text()).includes('连接时间线'), 'mobile diagnostics')
  assert(await evaluate('(() => { const r = document.querySelector(".ant-modal-footer").getBoundingClientRect(); return r.bottom <= window.innerHeight && r.top >= 0; })()'))
  await screenshot('diagnostics-mobile.png')
  await evaluate('document.querySelector(".ant-modal-close").click()')
  await click('下一页')
  await waitFor(async () => await evaluate('document.querySelectorAll(".connection-insights .ant-table-tbody tr.ant-table-row").length') === 1, 'last page before retention shrink')
  historyMode = 'error'; await click('刷新统计')
  await waitFor(async () => (await text()).includes('当前显示上次成功获取的数据'), 'stale error feedback')
  historyMode = 'empty'; await click('刷新统计')
  await waitFor(async () => (await text()).includes('暂无连接记录'), 'empty state')
  assert(await evaluate('!!document.querySelector(".observability-pagination")'))
  assert.equal(await evaluate('document.querySelector(".observability-pagination").innerText.includes("共 0 条")'), true)
  assert(await evaluate('[...document.querySelectorAll(".observability-pagination button")].every(button => button.disabled)'))
  historyMode = 'single'; await click('刷新统计')
  await waitFor(async () => await evaluate('document.querySelectorAll(".connection-insights .ant-table-tbody tr.ant-table-row").length') === 1, 'single-page state')
  assert((await text()).includes('1–1 / 共 1 条'))
  assert(await evaluate('[...document.querySelectorAll(".observability-pagination button")].every(button => button.disabled)'))
  historyMode = 'unauthorized'; await click('刷新统计')
  await waitFor(async () => await evaluate('location.pathname') === '/', 'expired account sign-out')
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions))
  console.log(`Browser UI checks passed. Screenshots: ${output}`)
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.close()
  browser.kill()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
