// Debug harness: start the wechaty bot exactly like WechatChannel does,
// with every event printed, so we can see why no scan QR is emitted.
import { WechatyBuilder } from 'wechaty'

console.log('[debug] importing puppet...')
const mod = await import('wechaty-puppet-wechat4u')
const PuppetImpl = mod.default ?? mod
const puppet = new PuppetImpl({})
console.log('[debug] puppet instantiated:', puppet.constructor?.name)

const bot = WechatyBuilder.build({
  name: '/tmp/dsh-chatops-debug/debug-bot',
  puppet,
})

bot
  .on('scan', (qrcode, status) => {
    console.log('[debug] SCAN event, status =', status)
    console.log('[debug] qrcode string:', qrcode)
  })
  .on('login', (user) => console.log('[debug] LOGIN:', user?.name?.()))
  .on('logout', (user, reason) => console.log('[debug] LOGOUT:', reason))
  .on('error', (error) => console.log('[debug] ERROR event:', error?.message ?? error))
  .on('message', (msg) => console.log('[debug] message:', msg.text?.()))

console.log('[debug] starting bot...')
try {
  await bot.start()
  console.log('[debug] bot.start() resolved')
} catch (error) {
  console.error('[debug] bot.start() THREW:', error)
  process.exit(1)
}

setTimeout(() => {
  console.log('[debug] 60s timeout, no scan/login observed. isLoggedIn =', bot.isLoggedIn)
  process.exit(2)
}, 60000)
