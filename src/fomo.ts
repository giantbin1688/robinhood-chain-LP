// fomo.family 账号接入：它没有公开 API，后端 prod-api.fomo.family 认的是 Privy 的登录 token（浏览器 cookie / localStorage 里的 privy-token）。
// 用户在设置页贴一次 token + refresh token，这里负责续期（access token 1 小时过期；refresh token 一次性轮换，换完把新的存回 settings.json），
// 之后可以按 handle 查用户（钱包、头像、id）和拉他的历史交易。refresh token 是一次性的：同一次登录的 token 不能同时在浏览器和这里刷新，
// 否则互相踢下线——所以让用户用无痕窗口单独登一次再拷，拷完关掉。
// 常量来自 fomo 前端包（PublicPrivyProvider chunk 里的 appId / clientId，chains chunk 里的 X-Supported-Chains）
import { log } from './common.ts'
import { saveSettings, settings } from './settings.ts'

const PRIVY = 'https://auth.privy.io'
const APP_ID = 'cm6h485o300n3zj9yl6vpedq7'
const CLIENT_ID = 'client-WY5gFSayQjxnQhG4rP6SnwPAyPZWZpNRhJ6b9rzMnYwqH'
const API = 'https://prod-api.fomo.family'
const CHAINS_HEADER = '56,143,4663,8453,1399811149' // bnb, monad, robinhood, base, solana

export type FomoUser = { id: string; handle: string; name: string; avatar: string; wallet: string; raw: unknown }
export type FomoSwap = { id: string; createdAt: string; inTokenAddress: string; inNetworkId: number; inHumanAmount: string; humanUsdAmountIn: string; outTokenAddress: string; outNetworkId: number; outHumanAmount: string; humanUsdAmountOut: string; status: string }
export type FomoStatus = { configured: boolean; connected: boolean; handle: string; error: string; checkedAt: number; expiresAt: number }

const status: FomoStatus = { configured: false, connected: false, handle: '', error: '', checkedAt: 0, expiresAt: 0 }
let refreshTimer: NodeJS.Timeout | null = null
let refreshing: Promise<void> | null = null
let onChange: (s: FomoStatus) => void = () => {}
export const fomoStatus = () => ({ ...status })
export const onFomoStatus = (fn: (s: FomoStatus) => void) => { onChange = fn }
const push = () => onChange({ ...status })

const jwtExp = (t: string) => { try { return Number(JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).exp ?? 0) * 1000 } catch { return 0 } }

// 用 refresh token 换一对新的（access token 快过期、或接口回 401 时）。换失败 = token 作废（另一边刷过了 / 退出登录 / 过期太久），要用户重贴
async function refresh(): Promise<void> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    const s = settings().fomo
    if (!s.refreshToken) throw new Error('没有 refresh token')
    const r = await fetch(`${PRIVY}/api/v1/sessions`, {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json', 'privy-app-id': APP_ID, 'privy-client-id': CLIENT_ID, origin: 'https://fomo.family', referer: 'https://fomo.family/', ...(s.token ? { authorization: `Bearer ${s.token}` } : {}) }, // Privy 不带 Origin 回 403 Must specify origin
      body: JSON.stringify({ refresh_token: s.refreshToken }),
    })
    const j: any = await r.json().catch(() => ({}))
    if (!r.ok || !j.token) throw new Error(`Privy 续期失败 HTTP ${r.status}: ${j.error ?? j.message ?? '（无说明）'}——token 已失效，请到设置页重新贴`)
    s.token = j.token; if (j.refresh_token) s.refreshToken = j.refresh_token; s.updatedAt = Date.now()
    saveSettings()
    status.expiresAt = jwtExp(s.token)
    schedule()
    log('fomo: Privy token 已续期')
  })().finally(() => { refreshing = null })
  return refreshing
}
// 过期前 10 分钟续；token 里没 exp 就 50 分钟一次
function schedule() {
  if (refreshTimer) clearTimeout(refreshTimer)
  if (!settings().fomo.refreshToken) return
  const ms = status.expiresAt ? Math.max(30_000, status.expiresAt - Date.now() - 10 * 60_000) : 50 * 60_000
  refreshTimer = setTimeout(() => refresh().then(push).catch((e) => { status.connected = false; status.error = String(e?.message).slice(0, 160); push(); log(`fomo: ${status.error}`) }), ms)
  refreshTimer.unref()
}

async function request<T = any>(path: string, retry = true): Promise<T> {
  const s = settings().fomo
  if (!s.token && !s.refreshToken) throw new Error('fomo 账号没配置（设置页贴 Privy token）')
  if (!s.token || (status.expiresAt && status.expiresAt - Date.now() < 60_000)) await refresh()
  const r = await fetch(API + path, { headers: { authorization: `Bearer ${settings().fomo.token}`, 'x-supported-chains': CHAINS_HEADER, 'app-language': 'en', origin: 'https://fomo.family', referer: 'https://fomo.family/' }, signal: AbortSignal.timeout(20_000) })
  const j: any = await r.json().catch(() => ({}))
  // 实测（2026-09-10）：token 有效时 prod-api 也会回 430 {"error":"unauthorized"}——响应只有 Cloudflare 的头、带 __cf_bm cookie，没有应用层的头，
  // 同一个 token 有的连接过有的不过、无头浏览器一律不过：是 fomo 在 Cloudflare 上开的机器人拦截，不是 token 的问题，续期也没用。
  // 431 = 没带 token。真正的 token 失效（Privy 那边）走 401
  if (r.status === 430) throw new Error('fomo 的 Cloudflare 机器人拦截（HTTP 430）：token 有效，但脚本发的请求被边缘节点拒绝，这条路不可靠；链上监控不受影响')
  if (r.status === 401 || r.status === 431 || j.error === 'unauthorized') {
    if (retry) { await refresh(); return request(path, false) }
    throw new Error('fomo 接口回 unauthorized：token 已失效，请到设置页重新贴')
  }
  if (!r.ok || j.success === false) throw new Error(`fomo ${path.split('?')[0]} HTTP ${r.status}: ${j.message ?? j.error ?? ''}`)
  return (j.responseObject ?? j) as T
}

// 用户对象实测字段：id / userHandle / displayName / profilePictureLink / evmAddress / address（Solana）/ createdAt；没有 evmAddress 再递归找一个 EVM 地址兜底
const findEvm = (o: unknown, depth = 0): string => {
  if (depth > 4 || !o || typeof o !== 'object') return ''
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && !/token|contract|pool/i.test(k)) return v
    if (v && typeof v === 'object') { const f = findEvm(v, depth + 1); if (f) return f }
  }
  return ''
}
const toUser = (u: any): FomoUser => ({ id: String(u.id ?? ''), handle: String(u.userHandle ?? u.user_handle ?? ''), name: String(u.displayName ?? u.display_name ?? ''), avatar: String(u.profilePictureLink ?? u.profile_picture_link ?? ''), wallet: String(u.evmAddress ?? '') || findEvm(u), raw: u })

export const userByHandle = async (handle: string) => toUser(await request(`/v2/users/userHandle/${encodeURIComponent(handle)}`))
export const me = async () => toUser(await request('/v2/users/current'))
export async function swapsOf(userId: string, lastSwapId?: string): Promise<{ swaps: FomoSwap[]; hasNextPage: boolean }> {
  const r = await request(`/v2/users/${userId}/swaps${lastSwapId ? `?lastSwapIdV2=${encodeURIComponent(lastSwapId)}` : ''}`)
  return { swaps: r?.swaps ?? [], hasNextPage: !!r?.hasNextPage }
}

// 设置页贴了新 token / 服务启动：验一下（拉当前用户）并把状态推给页面
export async function setTokens(token: string, refreshToken: string) {
  const s = settings().fomo
  s.token = token.trim(); s.refreshToken = refreshToken.trim(); s.updatedAt = Date.now()
  saveSettings()
  status.expiresAt = jwtExp(s.token)
  return verify()
}
export async function verify(): Promise<FomoStatus> {
  const s = settings().fomo
  status.configured = !!(s.token || s.refreshToken)
  status.checkedAt = Date.now()
  if (!status.configured) { status.connected = false; status.handle = ''; status.error = ''; push(); return fomoStatus() }
  try {
    if (!status.expiresAt) status.expiresAt = jwtExp(s.token)
    const u = await me()
    status.connected = true; status.handle = u.handle; status.error = ''
    schedule()
  } catch (e: any) { status.connected = false; status.error = String(e?.message).slice(0, 160) }
  push()
  return fomoStatus()
}
export const fomoConnected = () => status.connected
