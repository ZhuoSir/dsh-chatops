/**
 * WecomChannel: 企业微信智能机器人通道（官方 @wecom/aibot-node-sdk）。
 *
 * - 收消息：WSClient WebSocket 长连接（botId + secret 鉴权），主动出站、
 *   零公网回调；私聊直接响应，群聊靠投递即 @（群回调文本自带 @机器人 前缀，
 *   剥离后入桥）。
 * - 发消息：client.sendMessage(chatId, {msgtype:'text', text:{content}})；
 *   文件/图片：client.uploadMedia → client.sendMediaMessage。
 * - 流式（replyStream：正在思考中/进度/流式回答）是企微独有原生能力，二期接入。
 * - SDK 为可选依赖：未安装时插件照常加载并给出安装指引。
 *
 * windowKey 命名：`wsu:{userid}` 私聊，`wsc:{chatid}` 群聊。
 * 注意：企微智能机器人仅面向企业内部成员，个人微信不可见。
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { ChannelEvents, InboundMessage } from '../channel'
import { chunkText } from '../channel'

export type WecomConnState = 'idle' | 'connecting' | 'connected' | 'error'

const SEND_INTERVAL_MS = 300

export class WecomChannel {
  private client: any = null
  private state: WecomConnState = 'idle'
  private lastError: string | null = null
  private outQueue: Promise<void> = Promise.resolve()
  private lastSentAt = 0

  constructor(
    private config: any,
    private events: ChannelEvents,
    private logger: { info: (m: string) => void; warn: (m: string) => void },
  ) {}

  get online(): boolean {
    return this.state === 'connected'
  }

  statusSnapshot() {
    return { state: this.state, online: this.online, lastError: this.lastError }
  }

  async start(): Promise<void> {
    const botId = this.config.wecom?.botId
    const secret = this.config.wecom?.secret
    if (!botId || !secret) {
      this.logger.warn('dsh-chatops: wecom.botId / wecom.secret 未配置，企业微信通道未启动')
      this.state = 'idle'
      this.lastError = 'missing botId/secret'
      return
    }
    let WSClient: any
    try {
      ;({ WSClient } = await import('@wecom/aibot-node-sdk'))
    } catch {
      this.logger.warn('dsh-chatops: 未安装 @wecom/aibot-node-sdk。在插件目录执行：pnpm add @wecom/aibot-node-sdk')
      this.state = 'error'
      this.lastError = 'wecom sdk not installed'
      return
    }

    this.state = 'connecting'
    const silent = { debug() {}, info() {}, warn() {}, error() {} }
    const client = new WSClient({ botId, secret, logger: silent })

    client.on('message', (frame: any) => {
      Promise.resolve()
        .then(() => this.handleMessage(frame))
        .catch((error) => this.logger.warn(`dsh-chatops: 企微消息处理失败: ${error?.message ?? error}`))
    })
    client.on('authenticated', () => {
      this.state = 'connected'
      this.lastError = null
      this.logger.info('dsh-chatops: 企业微信长连接已建立')
    })
    client.on('disconnected', () => {
      if (this.state === 'connected') this.state = 'connecting'
    })
    client.on('error', (error: any) => {
      this.lastError = error?.message ?? String(error)
      this.logger.warn(`dsh-chatops: 企微连接错误: ${this.lastError}`)
    })

    this.client = client
    // connect 在后台运行；SDK 自管重连（失败在 error 事件里可见）。
    Promise.resolve()
      .then(() => client.connect())
      .catch((error: any) => {
        this.state = 'error'
        this.lastError = error?.message ?? String(error)
        this.logger.warn(`dsh-chatops: 企微 WSClient 启动失败: ${this.lastError}`)
      })
  }

  async stop(): Promise<void> {
    this.state = 'idle'
    try {
      this.client?.disconnect?.()
    } catch {
      /* already down */
    }
    this.client = null
  }

  // -------------------------------------------------------------- inbound --

  /** Frame body: { msgtype, chattype: 'single'|'group', chatid, from: {userid}, text/voice/mixed }. */
  private handleMessage(frame: any): void {
    const body = frame?.body ?? frame
    let text = ''
    if (body?.msgtype === 'text') {
      text = String(body?.text?.content ?? '').trim()
    } else if (body?.msgtype === 'voice') {
      text = String(body?.voice?.content ?? '').trim()
    } else if (body?.msgtype === 'mixed' && Array.isArray(body?.mixed?.msg_item)) {
      text = body.mixed.msg_item
        .filter((item: any) => item?.msgtype === 'text' && typeof item?.text?.content === 'string')
        .map((item: any) => item.text.content)
        .join('\n')
        .trim()
    } else {
      return // images/files land in a later iteration
    }
    if (!text) return

    const userId: string = body?.from?.userid ?? ''
    if (!userId) return

    if (body.chattype === 'group') {
      // Group callbacks only fire when the bot is @-mentioned; the mention
      // prefix is routing metadata, strip it.
      const stripped = text.replace(/^\s*@\S+(?:\s+|$)/u, '').trim()
      if (!stripped) return
      this.events.onMessage({
        windowKey: `wsc:${body.chatid}`,
        kind: 'room',
        talkerId: userId,
        talkerName: userId,
        text: stripped,
      })
      return
    }

    this.events.onMessage({
      windowKey: `wsu:${userId}`,
      kind: 'contact',
      talkerId: userId,
      talkerName: userId,
      text,
    })
  }

  // ------------------------------------------------------------- outbound --

  say(windowKey: string, text: string, _opts?: { bulk?: boolean }): Promise<void> {
    const chunks = chunkText(text, this.config.reply?.maxChunkBytes ?? 6000)
    this.outQueue = this.outQueue.then(async () => {
      for (const chunk of chunks) {
        await this.throttle()
        await this.sendText(windowKey, chunk)
      }
    })
    return this.outQueue
  }

  /** Native file/image delivery: uploadMedia → sendMediaMessage. */
  async sendFile(windowKey: string, filePath: string, caption?: string): Promise<void> {
    if (!this.client) throw new Error('企业微信通道未连接')
    const maxMB = this.config.reply?.maxFileMB ?? 100
    const info = await stat(filePath)
    if (info.size > maxMB * 1024 * 1024) {
      throw new Error(`文件超过 ${maxMB}MB 上限（${(info.size / 1048576).toFixed(1)}MB）`)
    }
    const fileName = basename(filePath)
    const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extname(fileName).toLowerCase())

    this.outQueue = this.outQueue.then(async () => {
      try {
        const bytes = await readFile(filePath)
        // TODO(verify): uploadMedia/sendMediaMessage 参数形状以 SDK 真机为准
        const mediaId = await this.client.uploadMedia(bytes, {
          type: isImage ? 'image' : 'file',
          filename: fileName,
        })
        await this.client.sendMediaMessage(this.chatIdOf(windowKey), isImage ? 'image' : 'file', mediaId)
        if (caption) await this.say(windowKey, caption)
      } catch (error: any) {
        this.logger.warn(`dsh-chatops: 企微文件发送失败 ${fileName}: ${error?.message ?? error}`)
        await this.say(windowKey, `❌ 文件「${fileName}」发送失败：${error?.message ?? error}`)
      }
    })
    return this.outQueue
  }

  // ------------------------------------------------------------- protocol --

  private chatIdOf(windowKey: string): string {
    // TODO(verify): 单聊会话标识是 userid 还是 chatid，以 SDK 真机为准
    return windowKey.replace(/^(wsu|wsc):/, '')
  }

  private async sendText(windowKey: string, text: string): Promise<void> {
    if (!this.client) return
    try {
      await this.client.sendMessage(this.chatIdOf(windowKey), {
        msgtype: 'text',
        text: { content: text },
      })
    } catch (error: any) {
      this.logger.warn(`dsh-chatops: 企微发送失败: ${error?.message ?? error}`)
    }
  }

  private async throttle(): Promise<void> {
    const wait = this.lastSentAt + SEND_INTERVAL_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.lastSentAt = Date.now()
  }
}
