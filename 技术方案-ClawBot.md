# dsh-wechat 技术方案 v2（微信 ClawBot / iLink 方式）

> 参考工程：[xmanrui/dsh-im](https://github.com/xmanrui/dsh-im)（MIT）。
> 放弃 wechaty 个人号协议（文件传输助手方式），改用**腾讯 iLink 官方机器人协议**：
> 微信扫码 → 创建一个官方机器人（ClawBot），它作为一个**独立联系人/会话**出现在用户微信聊天列表里，
> 用户直接和它私聊（或拉群 @它）操控 DSH 全部工作区与会话。

---

## 1. 什么是 ClawBot 方式

dsh-im 的微信渠道逆向确认了腾讯官方机器人平台 **iLink**（`ilinkai.weixin.qq.com`）的完整协议：

- **合规**：这是微信官方提供的 Bot 接入（和 wechaty 个人号协议有本质区别），**无封号风险**；
- **体验**：扫码后微信里出现一个机器人联系人（ClawBot），支持私聊、拉群 @、图片/文件消息、"正在输入"状态；
- **部署零门槛**：和 wechaty 一样**主动出站长轮询**，不需要公网回调/域名/证书；
- **凭据即 token**：扫码确认后拿到 `bot_token`，长期有效，存 DSH 凭据存储，重启自动重连。

### 与 wechaty 方案对比

| | wechaty 个人号（v1 骨架） | ClawBot / iLink（本方案） |
|---|---|---|
| 合规性 | ❌ 违反用户协议，封号风险 | ✅ 微信官方 Bot 平台 |
| 入口 | 文件传输助手/私聊/群 | **独立机器人联系人**，私聊+群@ |
| 扫码含义 | Bot 账号登录（每次掉线重扫） | 一次性绑定，token 长效，重启免扫 |
| 消息能力 | 文本/图片/文件 | 文本/图片/文件 + "正在输入" + 会话上下文 token |
| 依赖 | wechaty + puppet（重，协议易失效） | **纯 HTTPS 长轮询，零原生依赖** |

---

## 2. iLink 协议要点（已从 dsh-im 源码确认）

协议版本 `2.4.6`，全部 HTTPS JSON，无 SDK、无原生依赖。

| 步骤 | 端点 | 说明 |
|---|---|---|
| ① 申请二维码 | `POST https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3` | body: `{local_token_list: []}` → 返回 `qrcode` 令牌 + `qrcode_img_content`（二维码图片内容） |
| ② 长轮询扫码状态 | `GET /ilink/bot/get_qrcode_status?qrcode=...`（35s 长轮询） | 状态机：`wait → scaned → confirmed`；异常态：`expired` / `scaned_but_redirect` / `need_verifycode`（需短信验证码，客户端要支持输入）/ `verify_code_blocked` |
| ③ 绑定成功 | confirmed 响应 | `{ bot_token, ilink_bot_id, ilink_user_id, baseurl }` —— **bot_token 是全部后续调用的凭据**，baseurl 是消息 API 域名 |
| ④ 收消息 | `POST {baseurl}/ilink/bot/getupdates` | 长轮询 35s，body: `{get_updates_buf: <游标>, base_info}`，游标持久化实现断点续传；超时返回空批次 |
| ⑤ 发文本 | `POST {baseurl}/ilink/bot/sendmessage` | `{msg:{to_user_id, client_id: uuid, message_type:2, message_state:2, item_list:[{type:1, text_item:{text}}], context_token?}, base_info}`；`context_token` 来自入站消息，带上可维持会话上下文 |
| ⑥ "正在输入" | `POST {baseurl}/ilink/bot/msg/notifystart` | 执行任务前调用，用户侧看到机器人正在输入 |
| ⑦ 发图片/文件 | `POST {baseurl}/ilink/bot/getuploadurl` → 上传 `novac2c.cdn.weixin.qq.com`（AES-128 加密 + MD5 校验）→ sendmessage 带 `image_item` / `file_item` | 超长输出可直接发 txt 文件 |

鉴权头：`Authorization: Bearer <bot_token>` + `AuthorizationType: ilink_bot_token`。
`base_info` 固定：`{app_id:'bot', client_version: 2.4.6 编码}`。

---

## 3. 方案 A：直接安装 dsh-im（最快，0 开发）

如果目标是"尽快用上"，dsh-im 已经是完整实现（九个 IM 渠道 + AI Office Connector），直接装：

```sh
dsh plugin --profile web add -w @xmanrui/dsh-im
# 重启 dsh web → 设置 → 插件 → IM机器人 → 微信 → 扫码
```

**适用**：只想要功能，不需要自有插件。
**局限**：渠道功能按 dsh-im 的交互设计走（它自己的命令集/工作区绑定逻辑），定制要走它的代码。

## 4. 方案 B：把 dsh-wechat 的 Channel 层换成 iLink（推荐，自有插件）

v1 骨架的分层设计此刻兑现价值：**SessionBridge / AuthStore / Notifier / 配置体系全部保留**，只把 `WechatChannel`（wechaty）换成 `ILinkChannel`。

### 4.1 架构变化

```
微信用户 ──私聊/群@──► ClawBot（iLink 平台）
                          ▲ 出站 HTTPS 长轮询（35s）
              dsh-wechat 插件 (Cordis, DSH 进程内)
              ├─ ILinkChannel   ← 换掉 wechaty：扫码绑定 + getupdates 长轮询 + sendmessage
              │    （纯 fetch，零第三方依赖）
              ├─ SessionBridge  ← 保留：指令路由 + 会话映射 + prompt 投递
              ├─ AuthStore      ← 保留：白名单语义微调（见 4.4）+ 审计
              └─ Notifier       ← 保留：完成推送 + approval answerer
              
GUI 新增: 设置页"微信机器人"卡片（client-plugin）：
          二维码展示、扫码状态机、验证码输入、在线状态、解绑
```

### 4.2 ILinkChannel 模块设计（`src/host/ilink/`）

| 文件 | 职责 | 参考（dsh-im，MIT） |
|---|---|---|
| `api.mjs` | iLink 端点封装：beginLogin / pollLogin / getUpdates / sendText / notifyStart / sendImage / sendFile | `src/channels/weixin/weixin-api.mjs`（可直接移植，~600 行） |
| `channel.ts` | 实现现有 `WechatChannel` 接口：login 生命周期、入站消息归一化为 `InboundMessage`、出站 `say()` 限流分段 | `weixin-runtime.mjs` |
| `login.ts` | 扫码状态机：get_bot_qrcode → pollLogin(wait/scaned/confirmed/expired/need_verifycode) → 存凭据 | `weixin-controller.mjs` |
| `store.ts` | `bot_token` 存 `ctx.credentials`（DSH 凭据存储，不落明文配置）；`get_updates_buf` 游标 + bot 元信息存 `storages/dsh-wechat/ilink.json` | `config-store.mjs` / `state-store.mjs` |

对外接口保持不变，Bridge 零改动：

```ts
interface ChannelEvents {
  onMessage(msg: InboundMessage): void   // windowKey 变为 iLink 会话: `user:{ilink_user_id}` / `room:{chatroom_id}`
  onLogin(userName: string): void        // 绑定成功（拿到 bot_token）
  onLogout(reason: string): void         // token 失效/被解绑
  onScan(qrcodeImgContent: string): void // 二维码图片内容 → GUI 渲染（不再是终端！）
}
```

### 4.3 扫码绑定流程（体验核心升级）

```
用户在 DSH GUI「设置 → 插件 → 微信机器人」点"添加机器人"
  → Host 调 get_bot_qrcode → GUI 展示二维码
  → Host 并行长轮询 get_qrcode_status：
      wait    → GUI 显示"等待扫码"
      scaned  → GUI 显示"已扫码，请在手机确认"
      need_verifycode → GUI 弹输入框，用户填手机收到的验证码，带 verify_code 续 poll
      confirmed → 拿到 {bot_token, ilink_bot_id, ilink_user_id, baseurl}
  → bot_token 写入 ctx.credentials；元信息落盘
  → 启动 getupdates 长轮询循环
  → 用户微信里出现 ClawBot 会话 → 发 /help 即通
掉线恢复：重启插件 → credentials 读 token → 直接从 getupdates 恢复，免扫码
```

二维码在 **GUI 里渲染**（不再是终端角落）——这是比 wechaty 方案体验好的关键点之一。

### 4.4 安全模型调整（比 wechaty 简单）

- iLink Bot 天然只接收"主动找它聊天的人"的消息，没有"被拉群劫持"面；群聊只在被 @ 时产生入站；
- 保留白名单语义：`allowContacts` 改为信任的 `ilink_user_id` 列表（默认第一个扫码绑定的 owner）；`allowRooms` 为群 id；
- `context_token` 只按会话透传，不跨会话泄露；
- 审计日志不变。

### 4.5 指令集与推送（Bridge 完全保留）

`/help /sessions /use /status /log /approve /reject` 原样工作；额外获得两个 iLink 原生能力：

1. **"正在输入"**：prompt 投递后调 `notifystart`，用户感知任务在执行（wechaty 做不到）；
2. **文件回传**：超长输出/生成物直接发 txt/图片原生消息（利用现成 `sendFile/sendImage`）。

### 4.6 工作量估算

| 项 | 内容 | 工作量 |
|---|---|---|
| iLink API 移植 | 从 dsh-im 移植 `weixin-api.mjs`（文本+轮询，文件/图片二期） | 0.5 天 |
| ILinkChannel | 实现 Channel 接口 + 长轮询循环 + 重连退避 + 游标持久化 | 1 天 |
| 扫码登录 + GUI 卡片 | 状态机 + client-plugin 设置页（二维码渲染、验证码输入） | 1-2 天 |
| 凭据存储 | 接 `ctx.credentials` | 0.5 天 |
| 联调打磨 | 断线恢复、过期重扫、群@、审批闭环 | 1 天 |
| **合计** | | **约 4-5 天**（文本链路 2 天可跑通） |

---

## 5. 建议路线

1. **今天就能体验**：先 `dsh plugin --profile web add -w @xmanrui/dsh-im` 扫码跑通，确认 ClawBot 体验符合预期；
2. **自有插件并行**：在 dsh-wechat 里实施 §4（方案 B），先文本链路（扫码+收发+指令+审批），再补 GUI 设置页和文件消息；
3. v1 的 wechaty channel 保留为 `channel: wechaty` 备选实现（配置切换），但默认改为 `ilink`——**默认合规**。

## 6. 风险与注意

- iLink 协议版本（当前 2.4.6）是腾讯内部演进中的接口，未来可能变更——协议层要集中在一个 `api.mjs`，版本号可配置；dsh-im 是活跃的"上游雷达"，跟进它的更新即可；
- `bot_type=3` 与 `base_info` 字段含义来自逆向，移植时保持与 dsh-im 一致；
- 长轮询要正确处理 35s 超时（返回空批次而非报错）和 `get_updates_buf` 游标持久化，否则重启丢消息或重复消费；
- 文件/图片走 CDN + AES，复杂度最高，放二期；
- 多人共用一个 Bot 时，Bridge 的窗口↔会话映射天然支持（每个 ilink 会话一个 windowKey）。
