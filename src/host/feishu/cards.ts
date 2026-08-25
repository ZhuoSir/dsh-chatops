/**
 * Feishu interactive-message cards (legacy card JSON schema — supported by
 * both Feishu and Lark, and by the WS long-connection callback flow).
 *
 * Three cards:
 *  - approvalCard:    ⚠️ 审批请求，带【批准】【拒绝】按钮（value 携带审批 id）
 *  - approvalResultCard: 决策后原地替换的终态卡
 *  - progressCard / progressResultCard: 任务执行中的流式状态卡
 */

export interface ApprovalCardData {
  approvalId: string
  sessionTitle: string
  toolName: string
  reason: string
  timeoutMin: number
}

export function approvalCard(d: ApprovalCardData): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '⚠️ DSH 审批请求' },
      template: 'orange',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**会话**：${escapeMd(d.sessionTitle)}\n**工具**：\`${d.toolName}\`\n**原因**：${escapeMd(d.reason)}`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 批准' },
            type: 'primary',
            value: { dshApproval: d.approvalId, outcome: 'allowed-once' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 拒绝' },
            type: 'danger',
            value: { dshApproval: d.approvalId, outcome: 'rejected' },
          },
        ],
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `${d.timeoutMin} 分钟内有效，超时转 GUI 处理；也可回复 /approve 或 /reject` }],
      },
    ],
  }
}

export function approvalResultCard(d: ApprovalCardData, outcome: 'allowed-once' | 'rejected', operator: string): object {
  const approved = outcome === 'allowed-once'
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: approved ? '✅ 已批准' : '❌ 已拒绝' },
      template: approved ? 'green' : 'red',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**会话**：${escapeMd(d.sessionTitle)}\n**工具**：\`${d.toolName}\`\n**原因**：${escapeMd(d.reason)}`,
        },
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `由 ${operator} 操作` }],
      },
    ],
  }
}

export function progressCard(sessionTitle: string, prompt: string): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🔄 DSH 任务执行中' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**会话**：${escapeMd(sessionTitle)}\n**指令**：${escapeMd(prompt.slice(0, 200))}`,
        },
      },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '执行中，完成后此卡片自动更新…' }] },
    ],
  }
}

export function progressResultCard(sessionTitle: string, prompt: string, kind: string, excerpt: string): object {
  const ok = kind === 'completed'
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: ok ? '✅ DSH 任务完成' : `⚠️ 任务结束（${kind}）` },
      template: ok ? 'green' : 'red',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**会话**：${escapeMd(sessionTitle)}\n**指令**：${escapeMd(prompt.slice(0, 200))}`,
        },
      },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: escapeMd(excerpt.slice(0, 1500)) } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '回复 /log 1 查看完整输出' }] },
    ],
  }
}

/** lark_md treats some chars specially; keep it minimal. */
function escapeMd(text: string): string {
  return String(text ?? '')
}
