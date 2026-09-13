// squeeze 的数据面拼装：GMGN 快照（代币全部池的 5 分钟成交、买卖分开、K 线、安全）+ 我们要做 LP 的那个计价币池的链上储备。
// 换手的分母不用 GMGN 的"主池"：它在同一个币的 v3/WETH 池和 v4/USDG 池之间跳，还可能是 RWA 股票计价的池；我们只关心自己进的那个 v4 token/USDG 池里有多少 USDG。
import type { Address } from 'viem'
import * as v4 from './v4.ts'
import { tokenMeta, type Clients } from './common.ts'
import { snapshot, type GmgnChain, type PoolDepth, type Snapshot } from './gmgn.ts'
import type { Lp, Pool } from './lp.ts'
import { discoverQuotePools } from './pools.ts'
import { HOUR_BARS, evaluateSqueeze, squeezeParamsFromEnv, type Evaluation } from './strategy.ts'

// 池内两侧储备：从现价向两侧各扫约 ±99.9%（ln 1000 / ln 1.0001 ≈ 69078 tick；间距很小的池受 bitmap 读取上限约束时收窄并标记 truncated），
// 每段流动性按 v4 公式换成数量。计价币侧（现价下方）就是"池里有多少 USDG"。
export async function poolReserves(lp: Lp, pool: Pool, tokenIs1: boolean, tokenDecimals: number, quoteDecimals: number) {
  const [slot, L] = await Promise.all([lp.slot0(pool), lp.liquidity(pool)])
  if (!slot.sqrtP) throw new Error('池子尚未初始化')
  const full = 69078, cap = Math.floor((118 * 256 * pool.spacing) / 2) // ticks() 最多读 120 个 bitmap 字（每字 256 个压缩 tick）
  const span = Math.min(full, cap)
  const lo = Math.max(v4.MIN_TICK, v4.floorToSpacing(slot.tick - span, pool.spacing)), hi = Math.min(v4.MAX_TICK, v4.ceilToSpacing(slot.tick + span, pool.spacing) + pool.spacing)
  const { net } = await lp.ticks(pool, lo, hi)
  const B = [lo, ...[...net.keys()].filter((t) => t > lo && t < hi).sort((a, b) => a - b), hi]
  const Ls = v4.segmentLiquidity(B, slot.tick, L, net)
  let a0 = 0n, a1 = 0n
  for (let j = 0; j < Ls.length; j++) {
    if (Ls[j] <= 0n) continue
    const [u, v] = v4.amountsForLiquidity(slot.sqrtP, v4.getSqrtRatioAtTick(B[j]), v4.getSqrtRatioAtTick(B[j + 1]), Ls[j])
    a0 += u; a1 += v
  }
  const [q, t] = tokenIs1 ? [a0, a1] : [a1, a0]
  const [d0, d1] = tokenIs1 ? [quoteDecimals, tokenDecimals] : [tokenDecimals, quoteDecimals]
  const h = v4.priceAtTick(slot.tick) * 10 ** (d0 - d1), quotePerToken = tokenIs1 ? 1 / h : h
  return { quote: Number(q) / 10 ** quoteDecimals, token: Number(t) / 10 ** tokenDecimals, quotePerToken, tick: slot.tick, truncated: span < full }
}

// 把目标池的链上储备挂到 GMGN 快照上（计价币按 1 美元计：USDG / USDT / USDC）。读链失败不算致命：记 warning，闸门退回 GMGN 主池的计价币侧
export async function attachPoolDepth(c: Clients, snap: Snapshot, pool: Pool, token: Address): Promise<Snapshot> {
  const { Q } = c
  try {
    const { decimals } = await tokenMeta(c.pub, token)
    const tokenIs1 = pool.currency1.toLowerCase() === token.toLowerCase()
    const r = await poolReserves(c.lp, pool, tokenIs1, decimals, Q.decimals)
    const depth: PoolDepth = { id: pool.id, label: `${c.lp.label} ${pool.fee / 10000}% ${Q.symbol} 池`, quoteSymbol: Q.symbol, quoteUsd: r.quote, tokenUsd: r.token * r.quotePerToken, source: 'chain', truncated: r.truncated, feePips: pool.fee, spacing: pool.spacing }
    return { ...snap, poolDepth: depth }
  } catch (e: any) {
    return { ...snap, warnings: [...snap.warnings, `目标池链上储备读取失败，换手 / 深度暂按 GMGN 主池的计价币侧算: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 100)}`] }
  }
}

// 选目标池：给了 pool id 就用它；否则按进场的 auto 规则——该币已有的计价币池里，同费率优先，其次流动性 ≥ max($5k, 预算) 中日成交最大的
export async function pickQuotePool(c: Clients, token: Address, budgetUsd: number, poolId?: string, fee?: number): Promise<Pool | null> {
  if (poolId) return c.lp.poolById(poolId as `0x${string}`)
  const pools = (await discoverQuotePools(c, token)).filter((p) => p.empty === false).sort((a, b) => b.volume24h - a.volume24h)
  const minLiq = Math.max(5000, budgetUsd)
  return (fee ? pools.find((p) => p.pool.fee === fee) : undefined)?.pool ?? pools.find((p) => p.liquidityUsd >= minLiq)?.pool ?? pools[0]?.pool ?? null
}

export type ScanResult = Evaluation & { symbol: string; pool: { id: string; label: string; quoteUsd: number; tokenUsd: number; truncated: boolean } | null; gmgnPool: { exchange: string; quote: string } | null; at: number }
export async function scanSqueeze(c: Clients, token: Address, budgetUsd: number, o: { poolId?: string; fee?: number } = {}): Promise<ScanResult> {
  const chain = c.cfg.name as GmgnChain
  const params = squeezeParamsFromEnv()
  const [snap0, pool] = await Promise.all([snapshot(chain, token, HOUR_BARS), pickQuotePool(c, token, budgetUsd, o.poolId, o.fee)])
  const snap = pool ? await attachPoolDepth(c, snap0, pool, token) : { ...snap0, warnings: [...snap0.warnings, `${c.Q.symbol} 池不存在或都是空池：换手 / 深度按 GMGN 主池的计价币侧算`] }
  const ev = evaluateSqueeze(snap, budgetUsd, params)
  const pd = snap.poolDepth
  return { ...ev, symbol: snap.info.symbol, pool: pd ? { id: pd.id, label: pd.label, quoteUsd: pd.quoteUsd, tokenUsd: pd.tokenUsd, truncated: !!pd.truncated } : null, gmgnPool: snap.info.pool ? { exchange: snap.info.pool.exchange, quote: snap.info.pool.quoteSymbol } : null, at: snap.at }
}
