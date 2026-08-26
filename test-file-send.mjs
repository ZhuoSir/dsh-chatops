// E2E test: send a real txt file to the bound WeChat owner via iLink CDN.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createILinkApi } from '/tmp/dsh-chatops-api-build/api.js'

const state = JSON.parse(readFileSync(process.env.HOME + '/.dsh/storages/dsh-chatops/ilink-state.json', 'utf8'))
const token = state.fileToken
const { baseUrl, ownerUserId } = state.state
if (!token || !baseUrl || !ownerUserId) {
  console.log('missing token/baseUrl/owner')
  process.exit(1)
}
console.log('token loaded, owner =', ownerUserId)

const api = createILinkApi()
const bytes = Buffer.from(
  'dsh-chatops 文件回传端到端测试 ✅\n如果你在微信里收到这个 txt 文件，说明 DSH → 微信文件发送链路已打通。\n时间: ' + new Date().toISOString(),
  'utf8',
)
const file = { fileName: 'dsh-chatops-test.txt', bytes }
const aesKey = randomBytes(16)
const fileKey = randomBytes(16).toString('hex')
const upload = await api.getUploadUrl({ baseUrl, token, toUserId: ownerUserId, file, mediaType: 3, aesKey, fileKey })
console.log('① getUploadUrl OK:', Object.keys(upload))
const downloadParam = await api.uploadCdn({ upload, fileKey, bytes, aesKey })
console.log('②③ CDN upload OK, downloadParam len:', downloadParam.length)
await api.sendArtifact({
  baseUrl, token, toUserId: ownerUserId, file, mediaType: 3,
  downloadParam, aesKey, ciphertextSize: Math.ceil((bytes.byteLength + 1) / 16) * 16,
})
console.log('④ sendArtifact OK — 文件已发出')
