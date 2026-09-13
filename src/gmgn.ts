// GMGN OpenAPI（https://openapi.gmgn.ai）只读客户端：代币概况（5 分钟成交额 / 买卖分开 / 主池两侧美元储备）、安全检查、1 分钟 K 线。
// 实测（2026-09，Robinhood 上的 UBIK）：token/info、token/security、token/pool_info、market/token_kline 四个接口 robinhood 链都通。
//   认证：请求头 X-APIKEY，query 里 timestamp（秒）+ client_id（每次请求必须是新的 uuid，重复会 401 AUTH_CLIENT_ID_REPLAYED）。
//   K 线的 from / to 是毫秒（文档写秒，CLI 源码乘了 1000 才发；传秒会返回空 list）。
//   限频：漏桶 20 次/秒，这几个接口各计 1；429 会封 5 分钟且重试加时，所以每个 (接口, 链, 代币) 缓存 10 秒、429 期间直接报错不再发。
// key 来自设置页（settings.json），其次 .env 的 GMGN_API_KEY。免费 key 只有读权限，不能交易。
import { gmgnApiKey } from './settings.ts'

export type GmgnChain = 'robinhood' | 'bsc' | 'ethereum'
const CHAIN_ID: Record<GmgnChain, string> = { robinhood: 'robinhood', bsc: 'bsc', ethereum: 'eth' }
const HOST = 'https://openapi.gmgn.ai'
const CACHE_MS = 10_000
const cache = new Map<string, { at: number; data: unknown }>()
let bannedUntil = 0 // 429 给的 reset_at（毫秒）

export class GmgnError extends Error { constructor(msg: string, readonly status: number, readonly resetAt?: number) { super(msg) } }
export const gmgnConfigured = () => !!gmgnApiKey()

async function get(path: string, query: Record<string, string | number>): Promise<unknown> {
  const key = gmgnApiKey()
  if (!key) throw new GmgnError('没有配置 GMGN API key（设置页填，或 .env 的 GMGN_API_KEY）', 0)
  const ck = path + '?' + JSON.stringify(query)
  const hit = cache.get(ck)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data
  if (Date.now() < bannedUntil) throw new GmgnError(`GMGN 限频封禁中，${Math.ceil((bannedUntil - Date.now()) / 1000)} 秒后再试`, 429, bannedUntil)
  const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])), timestamp: String(Math.floor(Date.now() / 1000)), client_id: crypto.randomUUID() })
  const res = await fetch(`${HOST}${path}?${q}`, { headers: { 'X-APIKEY': key, 'User-Agent': 'rh-uni' }, signal: AbortSignal.timeout(15_000) })
  const text = await res.text()
  let body: any = null
  try { body = JSON.parse(text) } catch {}
  if (res.status === 429 || body?.code === 429) {
    const reset = Number(body?.reset_at || res.headers.get('x-ratelimit-reset') || 0) * 1000
    bannedUntil = reset > Date.now() ? reset : Date.now() + 60_000
    throw new GmgnError(`GMGN 限频（${body?.error ?? 429}），${Math.ceil((bannedUntil - Date.now()) / 1000)} 秒后解除`, 429, bannedUntil)
  }
  if (!res.ok || !body || body.code !== 0) throw new GmgnError(`GMGN ${path} 失败: HTTP ${res.status} ${body?.error ?? ''} ${body?.message ?? text.slice(0, 120)}`.trim(), res.status)
  cache.set(ck, { at: Date.now(), data: body.data })
  return body.data
}

// 原始返回里我们用到的字段（数字字符串一律转成 number）
export type TokenInfo = {
  symbol: string; holderCount: number; liquidityUsd: number
  price: number; price1m: number; price5m: number; price1h: number; price24h: number
  volume1m: number; volume5m: number; volume1h: number; volume24h: number
  buyVolume5m: number; sellVolume5m: number; buyVolume1h: number; sellVolume1h: number
  buys5m: number; sells5m: number; sells24h: number; swaps5m: number; swaps1h: number
  pool: { address: string; exchange: string; quoteSymbol: string; baseReserveUsd: number; quoteReserveUsd: number; liquidityUsd: number; createdAt: number } | null
  top10Rate: number | null
}
const n = (x: unknown) => { const v = Number(x); return Number.isFinite(v) ? v : 0 }
export async function tokenInfo(chain: GmgnChain, address: string): Promise<TokenInfo> {
  const d: any = await get('/v1/token/info', { chain: CHAIN_ID[chain], address })
  const p = d?.price ?? {}, pool = d?.pool
  return {
    symbol: String(d?.symbol ?? ''), holderCount: n(d?.holder_count), liquidityUsd: n(d?.liquidity),
    price: n(p.price), price1m: n(p.price_1m), price5m: n(p.price_5m), price1h: n(p.price_1h), price24h: n(p.price_24h),
    volume1m: n(p.volume_1m), volume5m: n(p.volume_5m), volume1h: n(p.volume_1h), volume24h: n(p.volume_24h),
    buyVolume5m: n(p.buy_volume_5m), sellVolume5m: n(p.sell_volume_5m), buyVolume1h: n(p.buy_volume_1h), sellVolume1h: n(p.sell_volume_1h),
    buys5m: n(p.buys_5m), sells5m: n(p.sells_5m), sells24h: n(p.sells_24h), swaps5m: n(p.swaps_5m), swaps1h: n(p.swaps_1h),
    pool: pool?.pool_address ? { address: String(pool.pool_address), exchange: String(pool.exchange ?? ''), quoteSymbol: String(pool.quote_symbol ?? ''), baseReserveUsd: n(pool.base_reserve_value), quoteReserveUsd: n(pool.quote_reserve_value), liquidityUsd: n(pool.liquidity), createdAt: n(pool.creation_timestamp) } : null,
    top10Rate: d?.dev?.top_10_holder_rate != null ? n(d.dev.top_10_holder_rate) : null,
  }
}
export type TokenSecurity = { honeypot: boolean | null; canNotSell: boolean; buyTax: number; sellTax: number; renounced: boolean | null; top10Rate: number | null }
export async function tokenSecurity(chain: GmgnChain, address: string): Promise<TokenSecurity> {
  const d: any = await get('/v1/token/security', { chain: CHAIN_ID[chain], address })
  // 蜜罐判据（官方 skill 文档的四层）：is_honeypot -> honeypot 整数(0 安全 / 1 蜜罐 / -1 未测) -> can_not_sell；第四层 sells_24h>0 在 strategy 里合
  const hp = typeof d?.is_honeypot === 'boolean' ? d.is_honeypot : d?.honeypot === 1 ? true : d?.honeypot === 0 ? false : null
  return { honeypot: hp, canNotSell: n(d?.can_not_sell) === 1, buyTax: n(d?.buy_tax), sellTax: n(d?.sell_tax), renounced: typeof d?.is_renounced === 'boolean' ? d.is_renounced : null, top10Rate: d?.top_10_holder_rate != null ? n(d.top_10_holder_rate) : null }
}
export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number } // time 毫秒，volume 美元
export async function kline(chain: GmgnChain, address: string, resolution: '1m' | '5m' | '15m' | '1h', minutes: number): Promise<Bar[]> {
  const to = Date.now()
  const d: any = await get('/v1/market/token_kline', { chain: CHAIN_ID[chain], address, resolution, from: to - minutes * 60_000, to })
  const list: any[] = Array.isArray(d?.list) ? d.list : []
  return list.map((b) => ({ time: n(b.time), open: n(b.open), high: n(b.high), low: n(b.low), close: n(b.close), volume: n(b.volume) })).filter((b) => b.close > 0).sort((a, b) => a.time - b.time)
}

// squeeze 形状要的一整份快照：概况 + 安全 + 最近 30 根 1 分钟 K 线（安全 / K 线拉不到不算失败，记进 warnings；σ / 振幅按缺失处理，闸门会因此不过）
// 目标池（我们要进的那个计价币池）的链上储备，由 squeeze-scan.ts 挂上；有它就不看 GMGN 的主池
export type PoolDepth = { id: string; label: string; quoteSymbol: string; quoteUsd: number; tokenUsd: number; source: 'chain'; truncated?: boolean; feePips?: number; spacing?: number }
export type Snapshot = { info: TokenInfo; security: TokenSecurity | null; bars: Bar[]; at: number; warnings: string[]; poolDepth?: PoolDepth }
export async function snapshot(chain: GmgnChain, address: string, barMinutes = 30): Promise<Snapshot> {
  const warnings: string[] = []
  const [info, security, bars] = await Promise.all([
    tokenInfo(chain, address),
    tokenSecurity(chain, address).catch((e) => { warnings.push(`安全检查拉不到: ${String(e?.message ?? e).slice(0, 100)}`); return null }),
    kline(chain, address, '1m', barMinutes + 1).catch((e) => { warnings.push(`K 线拉不到: ${String(e?.message ?? e).slice(0, 100)}`); return [] as Bar[] }),
  ])
  return { info, security, bars: bars.slice(-barMinutes), at: Date.now(), warnings }
}
