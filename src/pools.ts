// 发现某个代币已有的 计价币 池：GeckoTerminal 列出池子（名字里带费率），再由 PositionManager 的 poolKeys 反查出完整 PoolKey（v4 / Infinity，含带 hook 的池）
// 或直接读池合约（v3）
import type { Address, Hex } from 'viem'
import * as v4 from './v4.ts'
import { feeText, log, tokenMeta, type Clients } from './common.ts'
import type { Pool } from './lp.ts'

export type FoundPool = { pool: Pool; liquidityUsd: number; volume24h: number; name: string; empty: boolean }
// GeckoTerminal 的 dex id（/networks/{net}/dexes 里的原值，按链带不同后缀）：Robinhood 上 Uniswap v4 是 uniswap-v4-robinhood，BSC 上是 uniswap-v4-bsc
const GECKO_DEX: Record<string, Record<string, string>> = { robinhood: { v4: 'uniswap-v4-robinhood' }, bsc: { v4: 'uniswap-v4-bsc', infinity: 'pancakeswap-infinity-clmm', v3: 'pancakeswap-v3-bsc' } }

// GeckoTerminal 上这个代币的全部池子（任何 DEX、任何计价币），失败返回 []
async function fetchGeckoPools(network: string, token: Address): Promise<any[]> {
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${token}/pools?page=1`, { signal: AbortSignal.timeout(15_000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return (await r.json()).data ?? []
  } catch (e: any) { log(`查询已有池失败（GeckoTerminal ${String(e?.message).slice(0, 80)}），按配置的费率处理`); return [] }
}
const feeFromName = (name: string) => { const m = name.match(/([\d.]+)%/); return m ? Math.round(Number(m[1]) * 10_000) : null }
// GeckoTerminal 的流动性 / 成交量会滞后：流动性全撤走的池它还照旧显示旧数字。以链上现价处的活跃流动性为准，为 0 就当空池、旧数字作废
const isEmpty = async (c: Clients, pool: Pool) => (await c.lp.liquidity(pool).catch(() => 0n)) === 0n

export async function discoverQuotePools(c: Clients, token: Address): Promise<FoundPool[]> {
  const { lp, cfg } = c
  const out: FoundPool[] = []
  for (const p of await fetchGeckoPools(cfg.gecko, token)) {
    const a = p.attributes ?? {}
    if (String(p.relationships?.dex?.data?.id ?? '') !== GECKO_DEX[cfg.name]?.[c.protocol] || !new RegExp(cfg.quote.symbol).test(a.name ?? '')) continue
    const pool = await lp.poolById(String(a.address).toLowerCase() as Hex).catch(() => null)
    if (!pool || ![pool.currency0, pool.currency1].some((x) => x.toLowerCase() === cfg.quote.address.toLowerCase())) continue
    const hint = feeFromName(String(a.name ?? ''))
    const empty = await isEmpty(c, pool)
    out.push({ pool: hint ? { ...pool, feeHint: hint } : pool, liquidityUsd: empty ? 0 : Number(a.reserve_in_usd ?? 0), volume24h: empty ? 0 : Number(a.volume_usd?.h24 ?? 0), name: a.name, empty })
  }
  // GeckoTerminal 漏掉的（比如 BSC 上 Uniswap v4 的池常常不在它的列表里）：标准费率档直接在链上查，流动性按现价 ±10% 内的深度折成美元估算，成交量未知记 0
  const seen = new Set(out.map((x) => x.pool.id.toLowerCase()))
  const { symbol, decimals } = await tokenMeta(c.pub, token)
  for (const t of lp.tiers) {
    const pool = await lp.pool(token, t.fee, t.spacing).catch(() => null)
    if (!pool || seen.has(pool.id.toLowerCase())) continue
    const s = await lp.slot0(pool)
    if (s.sqrtP === 0n) continue
    const L = await lp.liquidity(pool)
    if (L === 0n) continue
    // 1.0001^953 ≈ 1.1；归零的币 tick 会贴着 MIN/MAX_TICK，越界会抛错，钳一下
    const [a0, a1] = v4.amountsForLiquidity(s.sqrtP, v4.getSqrtRatioAtTick(Math.max(v4.MIN_TICK, s.tick - 953)), v4.getSqrtRatioAtTick(Math.min(v4.MAX_TICK, s.tick + 953)), L)
    const quoteIs0 = pool.currency0.toLowerCase() === cfg.quote.address.toLowerCase()
    const [qAmt, tAmt] = quoteIs0 ? [a0, a1] : [a1, a0]
    const raw = v4.priceAtTick(s.tick) * 10 ** ((quoteIs0 ? cfg.quote.decimals : decimals) - (quoteIs0 ? decimals : cfg.quote.decimals))
    const price = quoteIs0 ? 1 / raw : raw // 每个代币多少计价币
    const liquidityUsd = Number(qAmt) / 10 ** cfg.quote.decimals + (Number(tAmt) / 10 ** decimals) * price
    out.push({ pool, liquidityUsd, volume24h: 0, name: `${symbol} / ${cfg.quote.symbol} ${t.fee / 10000}%（链上）`, empty: false })
  }
  return out
}

// 网页界面用：该代币的全部池子，每个标出能不能被本工具复用及原因
export type TokenPool = { id: Hex; name: string; dex: string; liquidityUsd: number; volume24h: number; fee: number; feeText: string; spacing: number; hooks: Address | null; usable: boolean; empty: boolean; status: string }
export async function listTokenPools(c: Clients, token: Address): Promise<TokenPool[]> {
  const { lp, cfg } = c
  const out: TokenPool[] = []
  const usd$ = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`
  for (const p of await fetchGeckoPools(cfg.gecko, token)) {
    const a = p.attributes ?? {}
    const dex = String(p.relationships?.dex?.data?.id ?? '').replace(new RegExp(`-${cfg.gecko}$`), '')
    const name = String(a.name ?? ''), id = String(a.address).toLowerCase() as Hex
    const feeN = feeFromName(name) ?? 0
    const base: TokenPool = { id, name, dex, liquidityUsd: Number(a.reserve_in_usd ?? 0), volume24h: Number(a.volume_usd?.h24 ?? 0), fee: feeN, feeText: feeN ? `${feeN / 10000}%` : '—', spacing: 0, hooks: null, usable: false, empty: false, status: '' }
    if (String(p.relationships?.dex?.data?.id ?? '') !== GECKO_DEX[cfg.name]?.[c.protocol]) out.push({ ...base, status: `不是 ${lp.label}（${dex}）` })
    else if (!new RegExp(cfg.quote.symbol).test(name)) out.push({ ...base, status: `计价不是 ${cfg.quote.symbol}（${name.split('/')[1]?.trim().split(' ')[0] ?? '?'}）` })
    else {
      const pool = await lp.poolById(id).catch(() => null)
      if (!pool) out.push({ ...base, status: c.protocol === 'v3' ? '不是 PancakeSwap 工厂建的池' : '查不到 PoolKey（没人通过 PositionManager 建过仓），不复用' })
      else {
        const hasHook = pool.hooks !== '0x0000000000000000000000000000000000000000'
        const row = { ...base, fee: pool.fee, feeText: feeText(pool) + (pool.dynamic && feeN ? `≈${feeN / 10000}%` : ''), spacing: pool.spacing, hooks: hasHook ? pool.hooks : null, usable: true }
        if (await isEmpty(c, pool)) out.push({ ...row, liquidityUsd: 0, volume24h: 0, empty: true, status: `空池：链上没有流动性，Gecko 的 ${usd$(base.liquidityUsd)} / 日成交 ${usd$(base.volume24h)} 是旧数据；进场要先花预算 1% 纠价，之后也没人来成交` })
        else {
          const warn = base.liquidityUsd < 5000 ? '，流动性 < $5k（auto 不会自动选）' : ''
          out.push({ ...row, status: (hasHook ? '可用，带 hook（费率由 hook 决定）' : '可用') + warn })
        }
      }
    }
  }
  return out.sort((a, b) => b.liquidityUsd - a.liquidityUsd)
}
