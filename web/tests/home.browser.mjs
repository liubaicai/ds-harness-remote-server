// Build first: pnpm build && node web/tests/home.browser.mjs
// Uses an isolated fixture server and local Chromium. No extra dependencies.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'

const browserPath = process.env.BROWSER_PATH ?? [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find(existsSync)
if (!browserPath) throw new Error('Set BROWSER_PATH to a Chromium browser executable.')
const output = mkdtempSync(join(tmpdir(), 'remote-home-ui-'))
const repository = 'https://github.com/liubaicai/ds-harness-remote-server'
let signedIn = true
const requests = []
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  requests.push(url.pathname)
  const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
  if (url.pathname === '/api/v1/auth/me') return signedIn ? json({ account: 'demo@example.test' }) : json({ error: { code: 'ACCOUNT_AUTH_REQUIRED' } }, 401)
  if (url.pathname === '/api/v1/account/devices') return json({ items: [], serverUrl: 'https://remote.example.test', transport: 'auto' })
  if (url.pathname === '/api/v1/account/connections') return json({ items: [] })
  if (url.pathname === '/api/v1/account/connection-history') return json({ items: [], total: 0, limit: 20, offset: 0, retention: { maxRecords: 1000, maxAgeMs: 604800000 } })
  if (url.pathname === '/api/v1/account/connection-stats') return json({ generatedAt: Date.now(), totals: { connections: 0, active: 0, ready: 0, failed: 0, relayBytes: 0, relayFrames: 0 }, transports: { lan: 0, p2p: 0, turn: 0, relay: 0, unknown: 0 }, handshake: { samples: 0, averageMs: null }, serverPeerRtt: [] })
  if (url.pathname.startsWith('/api/')) return json({ error: { code: 'METHOD_NOT_FOUND' } }, 404)
  const root = resolve('dist/public')
  const path = url.pathname.startsWith('/assets/') || url.pathname === '/brand-whale.webp' ? resolve(root, '.' + url.pathname) : join(root, 'index.html')
  if (!path.startsWith(root) || !existsSync(path)) { res.writeHead(404); res.end(); return }
  res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.webp') ? 'image/webp' : 'text/html')
  res.end(readFileSync(path))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
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
  ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  let seq = 0
  const pending = new Map(), exceptions = []
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
  const screenshot = async name => {
    const result = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(join(output, name), Buffer.from(result.data, 'base64'))
  }
  const home = async () => {
    await cdp('Page.navigate', { url: origin + '/' })
    await waitFor(async () => await evaluate('!!document.querySelector("#landing-title")'), 'home page')
    await evaluate('document.fonts.ready')
  }
  const checkDesign = async () => {
    assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), 'page should not overflow horizontally')
    const report = await evaluate(`(() => {
      const root = document.querySelector('.landing-shell');
      const variables = getComputedStyle(root);
      const palette = new Set(['rgba(0, 0, 0, 0)']);
      for (let i = 0; i < variables.length; i++) {
        const key = variables[i];
        if (!/^--(?:slate|indigo|red)-|^--solid-text$/.test(key)) continue;
        const probe = document.createElement('span'); probe.style.color = variables.getPropertyValue(key); root.append(probe);
        palette.add(getComputedStyle(probe).color); probe.remove();
      }
      const textSizes = new Set(), issues = [];
      for (const node of [root, ...root.querySelectorAll('*')]) {
        if (!node.getBoundingClientRect().width || !node.getBoundingClientRect().height) continue;
        const style = getComputedStyle(node);
        if ([...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())) textSizes.add(parseFloat(style.fontSize));
        for (const key of ['color', 'backgroundColor']) if (!palette.has(style[key])) issues.push([node.className, key, style[key]]);
        if (style.animationName !== 'none' || style.transitionDuration.split(',').some(value => parseFloat(value) > 0)) issues.push([node.className, 'motion']);
        if (style.boxShadow !== 'none') issues.push([node.className, 'shadow']);
      }
      return { textSizes: [...textSizes], issues, text: root.innerText };
    })()`)
    assert(report.textSizes.every(size => size >= 12), JSON.stringify(report.textSizes))
    assert(report.textSizes.length <= 3, JSON.stringify(report.textSizes))
    assert(!report.text.includes('·'), 'no middle-dot separators')
    assert.deepEqual(report.issues, [], JSON.stringify(report.issues))
    const links = await evaluate(`({starts: [...document.querySelectorAll('.landing-shell a')].filter(a => a.textContent.trim() === '开始使用').map(a => a.getAttribute('href')), github: [...document.querySelectorAll('.landing-shell a[href*="github.com"]')].map(a => a.href), tabs: document.querySelectorAll('.landing-shell [role="tablist"]').length})`)
    assert.deepEqual(links.starts, ['/app/remote', '/app/remote'])
    assert.deepEqual(links.github, [repository, repository])
    assert.equal(links.tabs, 0)
  }
  await cdp('Runtime.enable')
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await home()
  await checkDesign()
  await screenshot('home-light.png')
  assert(await evaluate('document.querySelector(".landing-brand-mark").getBoundingClientRect().width > 0'))
  // Copy success and rejected clipboard permission are both handled without uncaught promises.
  await evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__copied = value } } }); document.querySelector('.landing-command button').click()`)
  await waitFor(async () => await evaluate('document.querySelector(".landing-command button").getAttribute("aria-label")') === '已复制安装命令', 'copy success')
  assert.equal(await evaluate('window.__copied'), 'dsh plugin --profile web add ds-harness-remote@0.5.2')
  await evaluate(`navigator.clipboard.writeText = async () => { throw new Error('denied') }; document.querySelector('.landing-command button').click()`)
  await waitFor(async () => await evaluate('!!document.querySelector(".landing-copy-error")'), 'copy error feedback')
  // Theme toggle updates immediately and persists across reload.
  await evaluate('document.querySelector(".landing-nav .theme-toggle").click()')
  await waitFor(async () => await evaluate('document.documentElement.dataset.theme') === 'dark', 'dark mode')
  await home(); await checkDesign(); await screenshot('home-dark.png')
  for (const width of [1024, 768, 760, 390, 320]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 768 })
    await checkDesign()
    if (width === 390) await screenshot('home-mobile-dark.png')
  }
  await evaluate('document.querySelector(".landing-nav .theme-toggle").click()')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true })
  await checkDesign(); await screenshot('home-mobile-light.png')
  // Both entry points keep an authenticated user on the remote page.
  for (const selector of ['.landing-nav-start', '.landing-button-primary']) {
    await home()
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await waitFor(async () => await evaluate('location.pathname === "/app/remote" && !!document.querySelector(".hosts-page")'), 'signed-in entry')
    assert.equal(await evaluate('document.querySelector(".product-github-link").href'), repository)
  }
  // Signed-out users follow the remote route through the existing login guard.
  signedIn = false
  for (const selector of ['.landing-nav-start', '.landing-button-primary']) {
    await home()
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await waitFor(async () => await evaluate('location.pathname === "/app/login" && !!document.querySelector(".auth-form")'), 'signed-out entry')
    assert.equal(await evaluate('document.querySelector(".auth-github-link").href'), repository)
  }
  assert(requests.includes('/brand-whale.webp'), 'brand asset should be loaded')
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions))
  console.log(`Homepage browser checks passed. Screenshots: ${output}`)
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.close()
  browser.kill()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
