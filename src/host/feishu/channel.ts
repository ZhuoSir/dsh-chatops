/**
 * FeishuChannel: 飞书自建应用机器人通道（官方开放平台，lark-oapi SDK）。
 *
 * - 收消息：WSClient WebSocket 长连接 + EventDispatcher（无需公网回调）；
 *   事件 im.message.receive_v1（私聊直接响应 / 群聊需 @机器人）。
 * - 发消息：im.message.create REST；单队列轻节流（300ms，API 配额宽裕）。
 * - 审批：交互卡片 + card.action.trigger 按钮回调（decision 路由到 bridge）。
 * - 进度：任务状态卡原地更新（create → patch）。
 *
 * windowKey 命名：`fsu:{open_id}` 私聊，`fsc:{chat_id}` 群聊。
 * SDK 是可选依赖：未安装时插件照常加载并给出安装指引。
 */
import type { ChannelEvents, InboundMessage } from '../channel'
import { chunkText } from '../channel'
import {
  approvalCard,
  approvalResultCard,
  progressCard,
  progressResultCard,
  type ApprovalCardData,
} from './cards'

export type FeishuConnState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface CardAction {
  approvalId: string
  outcome: 'allowed-once' | 'rejected'
  operatorOpenId: string
  messageId: string | null
}

export interface FeishuEvents extends ChannelEvents {
  /** Card button pressed; returns the terminal card to swap in, or null. */
  onCardAction: (action: CardAction) => Promise<object | null>
}

const SEND_INTERVAL_MS = 300

export class FeishuChannel {
  private client: any = null
  private wsClient: any = null
  private state: FeishuConnState = 'idle'
  private lastError: string | null = null
  private botOpenId: string | null = null
  private botName: string | null = null
  private outQueue: Promise<void> = Promise.resolve()
  private lastSentAt = 0

  constructor(
    private config: any,
    private events: FeishuEvents,
    private logger: { info: (m: string) => void; warn: (m: string) => void },
  ) {}

  get online(): boolean {
    return this.state === 'connected'
  }

  statusSnapshot() {
    return {
      state: this.state,
      online: this.online,
      botName: this.botName,
      botOpenId: this.botOpenId,
      lastError: this.lastError,
    }
  }

  async start(): Promise<void> {
    const appId = this.config.feishu?.appId
    const appSecret = this.config.feishu?.appSecret
    if (!appId || !appSecret) {
      this.logger.warn('dsh-chatops: feishu.appId / feishu.appSecret 未配置，飞书通道未启动（在插件设置中填写自建应用凭据）')
      this.state = 'idle'
      this.lastError = 'missing appId/appSecret'
      return
    }
    let lark: any
    try {
      lark = await import('@larksuiteoapi/node-sdk')
    } catch {
      this.logger.warn('dsh-chatops: 未安装 @larksuiteoapi/node-sdk。在插件目录执行：\n  pnpm add @larksuiteoapi/node-sdk')
      this.state = 'error'
      this.lastError = 'lark sdk not installed'
      return
    }

    const domain = this.config.feishu?.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu
    this.client = new lark.Client({ appId, appSecret, domain, loggerLevel: lark.LoggerLevel.warn })

    // Bot identity: needed to detect @mentions in groups.
    try {
      const info = await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })
      this.botOpenId = info?.data?.bot?.open_id ?? info?.bot?.open_id ?? null
      this.botName = info?.data?.bot?.app_name ?? info?.bot?.app_name ?? null
      this.logger.info(`dsh-chatops: feishu bot = ${this.botName} (${this.botOpenId})`)
    } catch (error: any) {
      this.logger.warn(`dsh-chatops: 获取飞书机器人信息失败（群@检测可能失效）: ${error?.message ?? error}`)
    }

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (event: any) => {
        Promise.resolve()
          .then(() => this.handleMessage(event))
          .catch((error) => this.logger.warn(`dsh-chatops: feishu message handling failed: ${error?.message ?? error}`))
      },
      'card.action.trigger': async (event: any) => {
        try {
          await this.handleCardAction(event)
        } catch (error: any) {
          this.logger.warn(`dsh-chatops: feishu card action failed: ${error?.message ?? error}`)
        }
      },
    })

    this.state = 'connecting'
    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.warn,
      onReady: () => {
        this.state = 'connected'
        this.lastError = null
        this.logger.info('dsh-chatops: 飞书长连接已建立')
      },
      onError: (error: any) => {
        this.lastError = error?.message ?? String(error)
        this.logger.warn(`dsh-chatops: 飞书长连接错误: ${this.lastError}`)
      },
      onReconnecting: () => {
        this.state = 'reconnecting'
      },
      onReconnected: () => {
        this.state = 'connected'
        this.lastError = null
      },
    })
    // start() returns after the handshake; the SDK auto-reconnects afterwards.
    this.wsClient.start({ eventDispatcher: dispatcher }).catch((error: any) => {
      this.state = 'error'
      this.lastError = error?.message ?? String(error)
      this.logger.warn(`dsh-chatops: 飞书 WSClient 启动失败: ${this.lastError}`)
    })
  }

  async stop(): Promise<void> {
    this.state = 'idle'
    try {
      this.wsClient?.close?.()
    } catch {
      /* already down */
    }
    this.wsClient = null
    this.client = null
  }

  // -------------------------------------------------------------- inbound --

  private async handleMessage(event: any): Promise<void> {
    const sender = event?.sender
    const message = event?.message
    if (!message || sender?.sender_type !== 'user') return // ignore bots/self echoes
    if (message.message_type !== 'text') return // images/files land in a later iteration

    let text: string
    try {
      text = String(JSON.parse(message.content)?.text ?? '').trim()
    } catch {
      return
    }
    if (!text) return

    const openId: string = sender?.sender_id?.open_id ?? ''
    if (!openId) return

    if (message.chat_type === 'p2p') {
      this.events.onMessage({
        windowKey: `fsu:${openId}`,
        kind: 'contact',
        talkerId: openId,
        talkerName: openId,
        text,
      })
      return
    }

    // Group chat: only respond when the bot is @-mentioned; strip placeholders.
    const mentions: any[] = message.mentions ?? []
    const mentioned =
      mentions.some((m) => m?.id?.open_id && m.id.open_id === this.botOpenId) ||
      (this.botOpenId == null && mentions.length > 0) // bot info failed: any mention counts
    if (!mentioned) return
    const stripped = text.replace(/@_user_\d+/g, '').trim()
    if (!stripped) return
    this.events.onMessage({
      windowKey: `fsc:${message.chat_id}`,
      kind: 'room',
      talkerId: openId,
      talkerName: openId,
      text: stripped,
    })
  }

  private async handleCardAction(event: any): Promise<void> {
    const value = event?.action?.value
    const approvalId = typeof value?.dshApproval === 'string' ? value.dshApproval : null
    const outcome = value?.outcome
    if (!approvalId || (outcome !== 'allowed-once' && outcome !== 'rejected')) return
    const operatorOpenId: string = event?.operator?.open_id ?? 'unknown'
    const messageId: string | null = event?.context?.open_message_id ?? null

    const resultCard = await this.events.onCardAction({ approvalId, outcome, operatorOpenId, messageId })
    if (resultCard && messageId && this.client) {
      try {
        await this.client.im.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(resultCard) },
        })
      } catch (error: any) {
        this.logger.warn(`dsh-chatops: 审批卡更新失败: ${error?.message ?? error}`)
      }
    }
  }

  // ------------------------------------------------------------- outbound --

  say(windowKey: string, text: string, _opts?: { bulk?: boolean }): Promise<void> {
    const chunks = chunkText(text, this.config.reply?.maxChunkBytes ?? 6000)
    this.outQueue = this.outQueue.then(async () => {
      for (const chunk of chunks) {
        await this.throttle()
        await this.sendMessage(windowKey, 'text', JSON.stringify({ text: chunk }))
      }
    })
    return this.outQueue
  }

  /** Approval card; part of the channel card capability probed by the bridge. */
  async sendApprovalCard(windowKey: string, data: ApprovalCardData): Promise<void> {
    await this.sendMessage(windowKey, 'interactive', JSON.stringify(approvalCard(data)))
  }

  /** Streaming task card: create now, patch on completion. */
  async sendProgressCard(windowKey: string, sessionTitle: string, prompt: string): Promise<string | null> {
    const messageId = await this.sendMessage(windowKey, 'interactive', JSON.stringify(progressCard(sessionTitle, prompt)))
    return messageId
  }

  async completeProgressCard(
    messageId: string,
    sessionTitle: string,
    prompt: string,
    kind: string,
    excerpt: string,
  ): Promise<void> {
    if (!this.client) return
    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(progressResultCard(sessionTitle, prompt, kind, excerpt)) },
      })
    } catch (error: any) {
      this.logger.warn(`dsh-chatops: 进度卡更新失败: ${error?.message ?? error}`)
    }
  }

  /** Returns the created message id when available. */
  private async sendMessage(windowKey: string, msgType: string, content: string): Promise<string | null> {
    if (!this.client) return null
    const p2p = windowKey.startsWith('fsu:')
    const group = windowKey.startsWith('fsc:')
    if (!p2p && !group) return null
    try {
      const response = await this.client.im.message.create({
        params: { receive_id_type: p2p ? 'open_id' : 'chat_id' },
        data: {
          receive_id: windowKey.replace(/^(fsu|fsc):/, ''),
          msg_type: msgType,
          content,
        },
      })
      if (response?.code !== undefined && response.code !== 0) {
        this.logger.warn(`dsh-chatops: 飞书发送被拒: code=${response.code} ${response.msg ?? ''}`)
        return null
      }
      return response?.data?.message_id ?? null
    } catch (error: any) {
      this.logger.warn(`dsh-chatops: 飞书发送失败: ${error?.message ?? error}`)
      return null
    }
  }

  private async throttle(): Promise<void> {
    const wait = this.lastSentAt + SEND_INTERVAL_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    this.lastSentAt = Date.now()
  }
}
