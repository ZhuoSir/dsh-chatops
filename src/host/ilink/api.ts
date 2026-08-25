/**
 * Tencent iLink bot protocol client (微信 ClawBot / 官方机器人平台).
 *
 * Reverse-confirmed from xmanrui/dsh-im (MIT), protocol version 2.4.6.
 * Pure HTTPS JSON over fetch — zero third-party dependencies.
 *
 * Flow: beginLogin → pollLogin(wait→scaned→confirmed) → {bot_token, baseurl}
 *       → getUpdates long-poll (cursor: get_updates_buf) → sendmessage.
 */
import { randomBytes, randomUUID } from 'node:crypto'

export const ILINK_QR_BASE_URL = 'https://ilinkai.weixin.qq.com/'
export const ILINK_PROTOCOL_VERSION = '2.4.6'
export const DEFAULT_BOT_TYPE = '3'

const ILINK_APP_ID = 'bot'
const ILINK_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6)
const LOGIN_TIMEOUT_MS = 10_000
const LONG_POLL_TIMEOUT_MS = 35_000
const SHORT_TIMEOUT_MS = 15_000

/** Login statuses returned by get_qrcode_status. */
export type LoginStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect'

export interface LoginResult {
  status: LoginStatus
  botToken?: string
  botId?: string
  ownerUserId?: string
  baseUrl?: string
}

export interface InboundIlinkMessage {
  messageId: string
  fromUserId: string
  text: string | null
  contextToken?: string
  runId?: string
  raw: any
}

export class ILinkError extends Error {
  code: string
  status?: number
  constructor(code: string, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options)
    this.name = 'ILinkError'
    this.code = code
    this.status = options.status
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function baseInfo() {
  return {
    channel_version: ILINK_PROTOCOL_VERSION,
    bot_agent: 'DeepSeekHarness/dsh-chatops',
  }
}

function commonHeaders() {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_CLIENT_VERSION,
  }
}

function authenticatedHeaders(token: string | null) {
  const headers: Record<string, string> = {
    ...commonHeaders(),
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    // Random UIN header per request, mirroring the reference client.
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function requestJson(options: {
  method: 'GET' | 'POST'
  baseUrl: string
  endpoint: string
  token?: string | null
  body?: unknown
  timeoutMs?: number
  authenticated?: boolean
  signal?: AbortSignal
}): Promise<any> {
  const url = new URL(options.endpoint, options.baseUrl).toString()
  const timeout = AbortSignal.timeout(options.timeoutMs ?? SHORT_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetch(url, {
      method: options.method,
      headers: options.authenticated === false ? commonHeaders() : authenticatedHeaders(options.token ?? null),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    })
  } catch (error: any) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ILinkError('timeout', `iLink request timed out: ${options.endpoint}`, { cause: error })
    }
    // undici's "fetch failed" TypeError hides the real reason on error.cause
    // (ECONNRESET / ENOTFOUND / UND_ERR_* / CERT_*) — surface it explicitly.
    const cause = error?.cause
    const detail = cause
      ? `${cause.code ?? ''}${cause.code ? ' ' : ''}${cause.message ?? cause}`.trim()
      : 'no-cause'
    throw new ILinkError(
      'network-error',
      `iLink request failed: ${error?.message ?? error} [${detail}] (${options.endpoint})`,
      { cause: error },
    )
  }
  if (!response.ok) {
    throw new ILinkError('http-error', `iLink HTTP ${response.status}: ${options.endpoint}`, { status: response.status })
  }
  try {
    return await response.json()
  } catch (error) {
    throw new ILinkError('invalid-response', `iLink returned non-JSON: ${options.endpoint}`, { cause: error })
  }
}

/** Extract first text/voice-transcript item from an inbound message. */
export function extractText(message: any): string | null {
  for (const item of message?.item_list ?? []) {
    if (item?.type === 1 && typeof item.text_item?.text === 'string') {
      const text = item.text_item.text.trim()
      if (text) return text
    }
    if (item?.type === 3 && typeof item.voice_item?.text === 'string') {
      const text = item.voice_item.text.trim()
      if (text) return text
    }
  }
  return null
}

export function messageId(message: any): string | null {
  if (message?.message_id !== undefined && message?.message_id !== null) return String(message.message_id)
  return nonEmpty(message?.client_id)
}

export function createILinkApi() {
  return Object.freeze({
    /** Step ①: request a binding QR. Returns the qrcode token + QR image URL. */
    async beginLogin({ localTokens = [] as string[], botType = DEFAULT_BOT_TYPE, signal }: {
      localTokens?: string[]
      botType?: string
      signal?: AbortSignal
    } = {}) {
      const response = await requestJson({
        method: 'POST',
        baseUrl: ILINK_QR_BASE_URL,
        endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
        body: { local_token_list: localTokens.slice(-10) },
        timeoutMs: LOGIN_TIMEOUT_MS,
        signal,
      })
      const qrcode = nonEmpty(response?.qrcode)
      if (!qrcode) throw new ILinkError('invalid-qr', 'iLink 没有返回二维码令牌')
      return { qrcode, qrcodeUrl: nonEmpty(response?.qrcode_img_content) }
    },

    /** Step ②: long-poll the scan status (35s). */
    async pollLogin({ qrcode, baseUrl = ILINK_QR_BASE_URL, verifyCode, signal }: {
      qrcode: string
      baseUrl?: string
      verifyCode?: string
      signal?: AbortSignal
    }): Promise<LoginResult> {
      let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
      if (nonEmpty(verifyCode)) endpoint += `&verify_code=${encodeURIComponent(verifyCode!.trim())}`
      const response = await requestJson({
        method: 'GET',
        baseUrl,
        endpoint,
        timeoutMs: LONG_POLL_TIMEOUT_MS + 5_000,
        signal,
        authenticated: false,
      })
      const status = response?.status as LoginStatus
      const result: LoginResult = { status }
      if (status === 'confirmed') {
        result.botToken = nonEmpty(response?.bot_token) ?? undefined
        result.botId = nonEmpty(response?.ilink_bot_id) ?? undefined
        result.ownerUserId = nonEmpty(response?.ilink_user_id) ?? undefined
        result.baseUrl = nonEmpty(response?.baseurl) ?? undefined
      }
      // Redirect statuses carry a new baseurl to continue polling against.
      const redirectBase = nonEmpty(response?.baseurl)
      if (redirectBase && !result.baseUrl) result.baseUrl = redirectBase
      return result
    },

    /** Step ④: long-poll inbound messages. Timeout returns an empty batch. */
    async getUpdates({ baseUrl, token, getUpdatesBuf = '', signal }: {
      baseUrl: string
      token: string
      getUpdatesBuf?: string
      signal?: AbortSignal
    }) {
      try {
        return await requestJson({
          method: 'POST',
          baseUrl,
          endpoint: 'ilink/bot/getupdates',
          body: { get_updates_buf: getUpdatesBuf, base_info: baseInfo() },
          token,
          timeoutMs: LONG_POLL_TIMEOUT_MS + 5_000,
          signal,
        })
      } catch (error) {
        // A long-poll timeout is a normal idle beat, not a failure.
        if (error instanceof ILinkError && error.code === 'timeout') {
          return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf }
        }
        throw error
      }
    },

    /** Step ⑤: send a text message. contextToken keeps the conversation context. */
    async sendText({ baseUrl, token, toUserId, text, contextToken, runId, signal }: {
      baseUrl: string
      token: string
      toUserId: string
      text: string
      contextToken?: string
      runId?: string
      signal?: AbortSignal
    }) {
      const response = await requestJson({
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/sendmessage',
        token,
        signal,
        body: {
          msg: {
            from_user_id: '',
            to_user_id: toUserId,
            client_id: `dsh-chatops-${randomUUID()}`,
            message_type: 2,
            message_state: 2,
            item_list: [{ type: 1, text_item: { text } }],
            ...(nonEmpty(contextToken) ? { context_token: contextToken!.trim() } : {}),
            ...(nonEmpty(runId) ? { run_id: runId!.trim() } : {}),
          },
          base_info: baseInfo(),
        },
      })
      if (response?.ret !== undefined && response.ret !== 0) {
        throw new ILinkError('send-rejected', 'iLink 拒绝了回复消息')
      }
      return true
    },

    /** Bot-online notification, called once when the poll loop starts. */
    async notifyStart({ baseUrl, token, signal }: { baseUrl: string; token: string; signal?: AbortSignal }) {
      return requestJson({
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/msg/notifystart',
        token,
        signal,
        timeoutMs: LOGIN_TIMEOUT_MS,
        body: { base_info: baseInfo() },
      })
    },

    /** Bot-offline notification, best-effort on shutdown. */
    async notifyStop({ baseUrl, token, signal }: { baseUrl: string; token: string; signal?: AbortSignal }) {
      return requestJson({
        method: 'POST',
        baseUrl,
        endpoint: 'ilink/bot/msg/notifystop',
        token,
        signal,
        timeoutMs: LOGIN_TIMEOUT_MS,
        body: { base_info: baseInfo() },
      })
    },
  })
}

export type ILinkApi = ReturnType<typeof createILinkApi>
