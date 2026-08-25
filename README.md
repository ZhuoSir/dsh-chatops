# dsh-chatops

> **用微信和飞书远程操控 DeepSeek Harness——IM 机器人直连全部工作区与会话，任务完成推送，危险操作远程审批。**
>
> Drive DeepSeek Harness from WeChat and Feishu — IM bots bridged to every workspace and session, with completion push and remote approval.

用 IM 操控 DeepSeek Harness：**微信（官方 ClawBot / iLink）+ 飞书（自建应用）双通道并行**，机器人和你私聊（或群 @）即可操作所有工作区和会话——任务完成自动推送，危险操作远程审批。

> ✅ 微信走**官方机器人平台（iLink）**，合规、无封号风险、纯 HTTPS 长轮询。
> ✅ 飞书走**官方开放平台自建应用**，WS 长连接，支持**审批卡片按钮**和**流式进度卡**。
> ⚠️ 备选通道 wechaty（个人号协议）违反微信用户协议，仅供自用、务必小号。

## 功能

- 🔀 多通道并行：`channels: [ilink, feishu]` 微信飞书同时在线，指令集完全一致
- 📱 微信：浏览器打开 `/wechat/qr` 扫码绑定一次，`bot_token` 长效，重启免扫码
- 🐦 飞书：填 App ID/Secret 即用，私聊直聊、群里 @机器人、首个私聊用户自动成为管理员
- 🗂 指令：`/sessions`（含 📦 冷会话自动唤醒）、`/use`、`/status`、`/log`（完整输出）、`/approve` `/reject`
- 🚀 普通文字直接作为 prompt 发给绑定会话（首次自动绑定最近活跃会话）
- 🃏 飞书专属：审批发**交互卡片**（点【批准】【拒绝】按钮，卡片原地变终态）；任务发**进度卡**，完成后原地更新为结果
- 🔐 微信 bot_token 存 DSH 凭据存储；owner/白名单模型，陌生人消息静默忽略 + 审计
- 🛡 微信发送双通道队列（交互消息优先，长输出不堵回执）；掉线自动重连；全量审计日志

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-chatops
# 重启 dsh web
```

改代码后：`pnpm build` + 重启 `dsh web`（link 安装，产物即时生效）。

## 使用（ilink 通道，默认）

1. 重启 `dsh web` 后，浏览器打开 **http://127.0.0.1:3080/wechat/qr**；
2. 用微信扫描二维码，手机上确认绑定（如提示短信验证码，在同一页面输入）；
3. 微信聊天列表出现机器人（ClawBot），它会发一条上线通知；
4. 和机器人聊天：

```
/help            → 查看指令
/sessions        → 1. 修复登录bug 💤空闲  2. 写周报 🔄运行中 …
/use 1           → ✅ 已绑定会话：修复登录bug
把 README 翻译成英文  → 🚀 已发送…  →（完成后）✅ 任务完成：…
```

安全模型：只有**扫码绑定的 owner**（和 `security.allowContacts` 白名单）能操控 DSH，其他人给机器人发消息一律静默忽略并记审计。

## 使用（feishu 通道）

1. [飞书开发者后台](https://open.feishu.cn/app)创建**企业自建应用** → 添加**机器人**能力（没有租户可免费创建团队）；
2. 权限：`im:message`、`im:message:send_as_bot`（图片/文件再加 `im:resource`）；
3. 事件订阅：订阅方式选**使用长连接接收事件**，添加 `接收消息 im.message.receive_v1` 和 `卡片回传交互 card.action.trigger`（审批按钮必须）；
4. 创建版本并发布（自用可用范围选自己）；
5. 配置 `channels: [ilink, feishu]` + `feishu.appId/appSecret`，重启 `dsh web`；
6. 飞书里搜到机器人直接私聊——**首个私聊用户自动成为管理员**（审计日志记录，可在 `security.allowContacts` 改白名单模型）。

群聊：把机器人拉进群，`security.allowRooms` 填群 `chat_id`，群里 @机器人 下指令。

## 使用（wechaty 通道，备选）

`cordis.patch.yml` 里把 `channel` 改为 `'wechaty'`，按需配置 `puppet` / `puppetToken`，重启后终端出现登录二维码（小号扫）。文件传输助手就是遥控器。

## 配置

见 `cordis.patch.yml`（每个键都有注释）。关键项：

| 键 | 说明 |
|---|---|
| `channel` | `'ilink'`（默认）/ `'wechaty'` |
| `security.allowContacts` / `allowRooms` | 额外信任的用户/群（owner 始终受信） |
| `push.onApproval` / `approvalTimeoutSec` | 审批推送与超时（超时转 GUI 处理） |
| `reply.rateLimitMs` | 发送节流（默认 1.2s+抖动） |

## 架构

```
微信用户 ──私聊──► ClawBot（iLink 平台，35s 长轮询）
飞书用户 ──私聊/群@──► 飞书开放平台（WS 长连接）
                          ▲ 均为主动出站，零公网部署
src/host/
├─ index.ts          apply(ctx)：多通道装配 + 生命周期 + /wechat/qr 绑定页
├─ manager.ts        ChannelManager：windowKey 前缀路由（多通道并行）
├─ ilink/            微信 iLink 通道（api / store / channel / qrimg）
├─ feishu/           飞书通道（channel: WSClient+事件+发送；cards: 审批/进度卡）
├─ channel.ts        [备选] wechaty 个人号通道
├─ auth.ts           来源过滤(owner/白名单) + 窗口↔会话绑定 + 审计
├─ bridge.ts         SessionBridge：指令路由、prompt 投递、审批 answerer、进度卡钩子
└─ qrcode.ts         [wechaty] 终端二维码渲染
```

已标注的 TODO（接入前需对照 DSH 运行时确认 API）：

- `/new` 会话创建 API、`/stop` 会话中断 API
- `approval/request` waterfall 的"放行给下一个 answerer"语义
- 会话标题字段名（`sessionTitle` 兜底逻辑）
- 二期：群聊 @、图片/文件消息（CDN+AES）、GUI 设置页卡片

## 协议说明

iLink 协议细节（端点、状态机、消息格式）逆向确认自 [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im)（MIT），协议版本 2.4.6。腾讯可能演进该协议——所有端点集中在 `src/host/ilink/api.ts`，跟进 dsh-im 更新即可。
