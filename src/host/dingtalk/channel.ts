/**
 * DingTalkChannel: 钉钉企业内部应用机器人通道（官方开放平台）。
 *
 * - 收消息：dingtalk-stream SDK 的 DWClient（Stream 长连接，topic TOPIC_ROBOT），
 *   主动出站、零公网回调；私聊直接响应，群聊需 @机器人（isInAtList）。
 * - 发消息：REST（api.dingtalk.com），access_token 自管缓存（2h-60s 刷新）。
 *   文本：sampleText；图片/文件：oapi media/upload 拿 media_id 后发
 *   sampleImageMsg / sampleFile。
 * - SDK 为可选依赖：未安装时插件照常加载并给出安装指引。
 *
 * windowKey 命名：`dsu:{senderStaffId}` 私聊，`dsc:{conversationId}` 群聊。
 * 审批/进度卡片（互动卡片、AI Card 流式）留待二期——文字指令兜底已可用。
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { ChannelEvents, InboundMessage } from '../channel'
import { chunkText } from '../channel'

export type DingTalkConnState = 'idle' | 'connecting' | 'connected' | 'error'

const API_BASE = 'https://api.dingtalk.com/'
const OAPI_BASE = 'https://oapi.dingtalk.com/'
const SEND_INTERVAL_MS = 300

export class DingTalkChannel {
  private client: any = null // DWClient
  private state: DingTalkConnState = 'idle'
  private lastError: string | null = null
  private tokenCache: { token: string; expiresAt: number } | null = null
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
    const clientId = this.config.dingtalk?.clientId
    const clientSecret = this.config.dingtalk?.clientSecret
    if (!clientId || !clientSecret) {
      this.logger.warn('dsh-chatops: dingtalk.clientId / clientSecret 未配置，钉钉通道未启动')
      this.state = 'idle'
      this.lastError = 'missing clientId/clientSecret'
      return
    }
    let DWClient: any, TOPIC_ROBOT: string
    try {
      ;({ DWClient, TOPIC_ROBOT } = await import('dingtalk-stream'))
    } catch {
      this.logger.warn('dsh-chatops: 未安装 dingtalk-stream。在插件目录执行：pnpm add dingtalk-stream')
      this.state = 'error'
      this.lastError = 'dingtalk-stream not installed'
      return
    }

    // Fail fast on bad credentials before opening the stream.
    try {
      await this.accessToken()
    } catch (error: any) {
      this.state = 'error'
      this.lastError = error?.message ?? String(error)
      this.logger.warn(`dsh-chatops: 钉钉凭据校验失败: ${this.lastError}`)
      return
    }

    this.state = 'connecting'
    const client = new DWClient({
      clientId,
      clientSecret,
      endpoint: API_BASE.replace(/\/$/, ''),
      autoReconnect: true,
      keepAlive: true,
      debug: false,
    })
    this.client = client

    client.registerCallbackListener(TOPIC_ROBOT, (response: any) => {
      // Ack the callback first — DingTalk retries unacked deliveries.
      const messageId = response?.headers?.messageId
      if (messageId) {
        try {
          client.socketCallBackResponse(messageId, { success: true })
        } catch {
          /* ack is best-effort */
        }
      }
      Promise.resolve()
        .then(async () => {
          const message = typeof response?.data === 'string' ? JSON.parse(response.data) : response?.data
          if (message) this.handleMessage(message)
        })
        .catch((error) => this.logger.warn(`dsh-chatops: 钉钉消息处理失败: ${error?.message ?? error}`))
    })

    try {
      await client.connect()
      this.state = 'connected'
      this.lastError = null
      this.logger.info('dsh-chatops: 钉钉 Stream 长连接已建立')
    } catch (error: any) {
      this.state = 'error'
      this.lastError = error?.message ?? String(error)
      this.logger.warn(`dsh-chatops: 钉钉连接失败: ${this.lastError}`)
    }
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

  /** Robot callback payload (Stream TOPIC_ROBOT). */
  private handleMessage(message: any): void {
    if (message?.msgtype !== 'text') return // images/files land in a later iteration
    const text: string = String(message?.text?.content ?? '').trim()
    if (!text) return
    const staffId: string = message?.senderStaffId ?? ''
    if (!staffId) return

    if (String(message?.conversationType) === '2') {
      // Group chat: only when the bot is @-mentioned.
      if (message?.isInAtList !== true) return
      const stripped = text.replace(/@\S+/g, '').trim()
      if (!stripped) return
      this.events.onMessage({
        windowKey: `dsc:${message.conversationId}`,
        kind: 'room',
        talkerId: staffId,
        talkerName: message?.senderNick ?? staffId,
        text: stripped,
      })
      return
    }

    this.events.onMessage({
      windowKey: `dsu:${staffId}`,
      kind: 'contact',
      talkerId: staffId,
      talkerName: message?.senderNick ?? staffId,
      text,
    })
  }

  // ------------------------------------------------------------- outbound --

  say(windowKey: string, text: string, _opts?: { bulk?: boolean }): Promise<void> {
    this.outQueue = this.outQueue.then(() => this.sayInline(windowKey, text))
    return this.outQueue
  }

  /** 队列任务内内联发送文本：直接循环发送，不重新挂链 outQueue，
   *  避免 sendFile 在队列任务内 await say() 造成自引用 Promise 死锁。 */
  private async sayInline(windowKey: string, text: string): Promise<void> {
    for (const chunk of chunkText(text, this.config.reply?.maxChunkBytes ?? 6000)) {
      await this.throttle()
      await this.sendRobotMessage(windowKey, 'sampleText', { content: chunk })
    }
  }

  /** Native file/image delivery: oapi media/upload → sampleFile / sampleImageMsg. */
  async sendFile(windowKey: string, filePath: string, caption?: string): Promise<void> {
    const maxMB = this.config.reply?.maxFileMB ?? 100
    const info = await stat(filePath)
    if (info.size > maxMB * 1024 * 1024) {
      throw new Error(`文件超过 ${maxMB}MB 上限（${(info.size / 1048576).toFixed(1)}MB）`)
    }
    const fileName = basename(filePath)
    const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extname(fileName).toLowerCase())

    this.outQueue = this.outQueue.then(async () => {
      try {
        const mediaId = await this.uploadMedia(filePath, isImage ? 'image' : 'file')
        // TODO(verify): sampleImageMsg/sampleFile msgParam 字段名以钉钉真机返回为准
        if (isImage) {
          await this.sendRobotMessage(windowKey, 'sampleImageMsg', { photoURL: mediaId })
        } else {
          await this.sendRobotMessage(windowKey, 'sampleFile', {
            mediaId,
            fileName,
            fileType: extname(fileName).replace('.', ''),
          })
        }
        if (caption) await this.sayInline(windowKey, caption)
      } catch (error: any) {
        this.logger.warn(`dsh-chatops: 钉钉文件发送失败 ${fileName}: ${error?.message ?? error}`)
        await this.sayInline(windowKey, `❌ 文件「${fileName}」发送失败：${error?.message ?? error}`)
      }
    })
    return this.outQueue
  }

  // ------------------------------------------------------------- protocol --

  private async accessToken(): Promise<string> {
    const clientId = this.config.dingtalk?.clientId
    const clientSecret = this.config.dingtalk?.clientSecret
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) return this.tokenCache.token
    const response = await fetch(new URL('v1.0/oauth2/accessToken', API_BASE), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
      signal: AbortSignal.timeout(15_000),
    })
    const value: any = await response.json().catch(() => null)
    const token = value?.accessToken
    if (!token) throw new Error(`钉钉未返回 accessToken（HTTP ${response.status}）`)
    const expireIn = Number(value?.expireIn ?? value?.expiresIn ?? 7200)
    this.tokenCache = { token, expiresAt: Date.now() + Math.max(60, expireIn - 60) * 1000 }
    return token
  }

  private async sendRobotMessage(windowKey: string, msgKey: string, msgParam: object): Promise<void> {
    const token = await this.accessToken()
    const robotCode = this.config.dingtalk?.clientId
    const isGroup = windowKey.startsWith('dsc:')
    const body: any = {
      robotCode,
      msgKey,
      msgParam: JSON.stringify(msgParam),
      ...(isGroup
        ? { openConversationId: windowKey.slice('dsc:'.length) }
        : { userIds: [windowKey.slice('dsu:'.length)] }),
    }
    const pathname = isGroup ? 'v1.0/robot/groupMessages/send' : 'v1.0/robot/oToMessages/batchSend'
    const response = await fetch(new URL(pathname, API_BASE), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const value: any = await response.json().catch(() => null)
    // DingTalk signals failures via errcode/errmessage or a non-2xx status.
    const code = value?.errcode ?? value?.code
    if (!response.ok || (code !== undefined && code !== 0 && code !== '0')) {
      throw new Error(`钉钉发送被拒: HTTP ${response.status} ${value?.errmessage ?? value?.message ?? ''}`)
    }
  }

  private async uploadMedia(filePath: string, type: 'image' | 'file'): Promise<string> {
    const token = await this.accessToken()
    const url = new URL('media/upload', OAPI_BASE)
    url.searchParams.set('access_token', token)
    url.searchParams.set('type', type)
    const form = new FormData()
    const bytes = await stat(filePath).then(async () => {
      const { readFile } = await import('node:fs/promises')
      return readFile(filePath)
    })
    form.append('media', new Blob([new Uint8Array(bytes)]), basename(filePath))
    const response = await fetch(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    const value: any = await response.json().catch(() => null)
    const mediaId = value?.media_id
    if (!mediaId) throw new Error(`钉钉媒体上传被拒: ${value?.errmsg ?? `HTTP ${response.status}`}`)
    return String(mediaId)
  }

  private async throttle(): Promise<void> {
    const wait = this.lastSentAt + SEND_INTERVAL_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.lastSentAt = Date.now()
  }
}
