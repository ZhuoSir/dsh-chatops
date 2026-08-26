// Headless-Chrome CDP screenshot: open the DSH GUI, enter 设置 → IM 通道, capture.
// Zero dependencies: Node 22 built-in WebSocket + Chrome DevTools Protocol.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const GUI = 'http://127.0.0.1:3080'
const OUT = process.argv[2] ?? 'docs/images/settings-page.png'
const DEBUG_PORT = 9333

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-crash-reporter', '--disable-breakpad', '--disable-crashpad',
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--window-size=1440,900', '--hide-scrollbars',
  '--user-data-dir=/tmp/dsh-chatops-chrome-profile',
  'about:blank',
], { stdio: 'ignore' })
process.on('exit', () => chrome.kill('SIGKILL'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch { /* chrome not up yet */ }
    await sleep(500)
  }
  throw new Error('chrome debug endpoint never came up')
}

const target = await getTarget()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })

let seq = 0
const pendingCalls = new Map()
ws.onmessage = (event) => {
  const msg = JSON.parse(String(event.data))
  if (msg.id && pendingCalls.has(msg.id)) {
    pendingCalls.get(msg.id)(msg)
    pendingCalls.delete(msg.id)
  }
}
function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++seq
    pendingCalls.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) console.log('EVAL ERROR:', JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  return r.result?.result?.value
}

function clickByText(text, selector = 'button,[role="tab"],[role="button"],a,div') {
  return evaluate(`(() => {
    const els = [...document.querySelectorAll('${selector}')]
    const el = els.find((e) => (e.innerText || '').trim() === '${text}')
       ?? els.find((e) => (e.innerText || '').trim().startsWith('${text}'))
    if (!el) return false
    el.click()
    return true
  })()`)
}

console.log('navigating…')
await cdp('Page.enable')
await cdp('Page.navigate', { url: GUI })
await sleep(6000) // shell boot + plugin modules

console.log('click 设置:', await clickByText('设置'))
await sleep(2000)

const sections = await evaluate(`[...document.querySelectorAll('button,[role="tab"],[role="link"],a,div,span')]
  .map((el) => (el.innerText || '').trim()).filter((t) => t && t.length < 12)
  .filter((v, i, a) => a.indexOf(v) === i).slice(0, 60)`)
console.log('SECTIONS:', JSON.stringify(sections))

console.log('click IM 通道:', await clickByText('IM 通道'))
await sleep(3000) // panel mount + first status poll

const shot = await cdp('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'))
console.log('saved:', OUT)
chrome.kill('SIGKILL')
process.exit(0)
