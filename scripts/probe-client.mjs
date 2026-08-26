// Probe: load the GUI, capture console errors/exceptions mentioning our plugin.
import { spawn } from 'node:child_process'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DEBUG_PORT = 9334

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-crash-reporter', '--disable-breakpad', '--disable-crashpad',
  `--remote-debugging-port=${DEBUG_PORT}`, '--window-size=1440,900',
  '--user-data-dir=/tmp/dsh-chatops-chrome-profile2', 'about:blank',
], { stdio: 'ignore' })
process.on('exit', () => chrome.kill('SIGKILL'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target
for (let i = 0; i < 30; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()
    target = list.find((t) => t.type === 'page')
    if (target) break
  } catch { /* wait */ }
  await sleep(500)
}
if (!target) throw new Error('no debug target')

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 0
const pending = new Map()
ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data))
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  if (msg.method === 'Runtime.exceptionThrown') {
    console.log('EXCEPTION:', JSON.stringify(msg.params.exceptionDetails).slice(0, 500))
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    console.log('CONSOLE', msg.params.type + ':', text.slice(0, 300))
  }
}
const cdp = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})

await cdp('Runtime.enable')
await cdp('Page.enable')
await cdp('Page.navigate', { url: 'http://127.0.0.1:3080' })
await sleep(8000)

// Is our module factory registered with the loader? Does the DOM know us?
const r = await cdp('Runtime.evaluate', {
  expression: `(async () => {
    const out = { hasIMText: document.body.innerText.includes('IM 通道') }
    try {
      const src = await (await fetch('/plugins/dsh-chatops/client.js')).text()
      out.fetched = src.length
      // Eval in page context; capture module factory errors
      try {
        // eslint-disable-next-line no-eval
        (0, eval)(src)
        out.eval = 'ok'
      } catch (e) {
        out.eval = 'THROW: ' + (e?.message ?? e)
      }
    } catch (e) {
      out.fetch = 'FAIL: ' + (e?.message ?? e)
    }
    return out
  })()`,
  awaitPromise: true,
  returnByValue: true,
})
console.log('PROBE:', JSON.stringify(r.result?.result?.value))

// open settings and dump dialog structure
await cdp('Runtime.evaluate', { expression: `[...document.querySelectorAll('button')].find((b) => (b.innerText||'').trim() === '设置')?.click()` })
await sleep(2500)
const r2 = await cdp('Runtime.evaluate', {
  expression: `(() => {
    const dialog = document.querySelector('[role="dialog"], .modal, [data-slot="dialog-content"], dialog')
    const scope = dialog ?? document.body
    return {
      dialogFound: Boolean(dialog),
      tabs: [...scope.querySelectorAll('[role="tab"],button,[role="link"]')].map((e) => (e.innerText||'').trim()).filter(Boolean).slice(0, 40),
      hasIM: scope.innerText.includes('IM 通道'),
    }
  })()`,
  returnByValue: true,
})
console.log('DIALOG:', JSON.stringify(r2.result?.result?.value))
chrome.kill('SIGKILL')
process.exit(0)
