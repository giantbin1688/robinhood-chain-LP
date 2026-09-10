// 网页服务的 Solana 部分：仓位列表 / 深度 / 资金明细 / 已平仓 / 池子列表 / 顶栏状态，返回的字段和 EVM 的一致（index.html 不区分链）。
// 美元一律按 计价币 × 计价币美元价（USDC = 1，SOL = 现价）折算；每行带 quote 字段，页面按行显示计价币符号
import { balanceOf, feeText, lamportsToSol, log, makeSolClients, p6, quoteSide, quoteUsd, solUsd, tokenMeta, trim, type SolClients } from './common.ts'
import { findPositions, quotePerToken, split, type Position } from './exit.ts'
import { closedPositions, positionLedger } from './history.ts'
import type { LedgerEvent, SolPool } from './lp.ts'
import { listTokenPools } from './pools.ts'

export type SolCtx = { c: SolClients; meta: Map<string, { symbol: string; decimals: number }>; known: Position[]; states: Map<string, { price: number; active: number; at: number }>; closedCache: Map<string, ClosedRow>; depthCache: Map<string, { at: number; data: unknown }> }
export async function makeSolCtx(protocol: 'dlmm' | 'clmm', from: string): Promise<SolCtx> {
  const c = await makeSolClients({ needKey: false, from, protocol, quiet: true })
  return { c, meta: new Map(), known: [], states: new Map(), closedCache: new Map(), depthCache: new Map() }
}
async function metaOf(x: SolCtx, mint: string) { let m = x.meta.get(mint); if (!m) { m = await tokenMeta(x.c.conn, mint); x.meta.set(mint, m) }; return m }
async function poolState(x: SolCtx, pool: SolPool, maxAge = 4000) {
  const hit = x.states.get(pool.id)
  if (hit && Date.now() - hit.at < maxAge) return hit
  const s = await x.c.lp.state(pool)
  const v = { price: s.price, active: s.active, at: Date.now() }
  x.states.set(pool.id, v)
  return v
}
const sumLedger = (events: LedgerEvent[], p: Pick<Position, 'tokenIsX' | 'quote'>, decimals: number, qUsd: number) => {
  const usdOf = (x: bigint, tok: bigint, price: number | null) => (Number(x) / 10 ** p.quote.decimals + (price === null ? 0 : (Number(tok) / 10 ** decimals) * price)) * qUsd
  let deposits = 0, fees = 0, withdrawn = 0, mintedAt = 0
  for (const e of events) {
    const [u, t] = p.tokenIsX ? [e.amountY, e.amountX] : [e.amountX, e.amountY]
    const [pu, pt] = p.tokenIsX ? [e.principalY, e.principalX] : [e.principalX, e.principalY]
    const total = usdOf(u, t, e.price), principal = usdOf(pu, pt, e.price)
    if (e.action === 'add') { deposits += total; if (!mintedAt) mintedAt = e.time }
    else { withdrawn += principal; fees += total - principal }
  }
  return { mintedAt, deposits, fees, withdrawn }
}

export async function listPositions(x: SolCtx, full: boolean, watcherOf: (id: string, token: string) => number | null) {
  const { c } = x
  if (full || x.known.length === 0) x.known = await findPositions(c)
  else {
    const fresh = await c.lp.positions(x.known.map((p) => p.id))
    const byId = new Map(fresh.map((p) => [p.id, p]))
    x.known = x.known.map((p) => { const f = byId.get(p.id); return f ? { ...p, ...f, pool: p.pool } : null }).filter((p): p is Position => !!p && (p.amountX > 0n || p.amountY > 0n || p.feeX > 0n || p.feeY > 0n))
  }
  const sol = await solUsd(c.conn)
  return Promise.all(x.known.map(async (p) => {
    const m = await metaOf(x, p.token)
    const st = await poolState(x, p.pool)
    const qUsd = p.quote.symbol === 'USDC' ? 1 : sol
    const price = quotePerToken(p, st.price)
    const s = split(p)
    const usd = (usdg: bigint, tok: bigint) => ((Number(usdg) / 10 ** p.quote.decimals + (Number(tok) / 10 ** m.decimals) * price) * qUsd).toFixed(2)
    const [lo, hi] = c.lp.edges(p).map((v) => quotePerToken(p, v)).sort((a, b) => a - b)
    let led: ReturnType<typeof sumLedger> | null = null
    try { const ev = await positionLedger(c, p); if (ev.length) led = sumLedger(ev, p, m.decimals, qUsd) } catch (e: any) { log(`仓位 ${p.id.slice(0, 8)}… 流水读取失败: ${String(e?.message).slice(0, 100)}`) }
    const mintedAt = led?.mintedAt || (p.at ? Date.parse(p.at) : null) || null
    return {
      id: p.id, token: p.token, symbol: m.symbol, decimals: m.decimals, fee: p.pool.fee / 10000, feeText: feeText(p.pool), spacing: p.pool.step, hooks: null, kind: p.kind, shape: p.shape, group: p.group, poolId: p.pool.id, quote: p.quote.symbol,
      tickLower: p.lower, tickUpper: p.upper, tick: st.active, lo: p6(lo), hi: p6(hi), price: p6(price), inRange: c.lp.inRange(p, st.active),
      usdg: trim(s.usdg, p.quote.decimals), tokenAmount: trim(s.token, m.decimals), value: usd(s.usdg, s.token), liquidity: p.liquidity.toString(), watchJob: watcherOf(p.id, p.token),
      feesUsdg: trim(s.feeUsdg, p.quote.decimals), feesToken: trim(s.feeToken, m.decimals), feesUsd: usd(s.feeUsdg, s.feeToken),
      mintedAt, entryUsd: led ? led.deposits.toFixed(2) : null, collectedUsd: led ? led.fees.toFixed(2) : null, withdrawnUsd: led ? led.withdrawn.toFixed(2) : null,
      pnlUsd: led ? (Number(usd(s.usdg, s.token)) + Number(usd(s.feeUsdg, s.feeToken)) + led.fees + led.withdrawn - led.deposits).toFixed(2) : null,
    }
  }))
}

// 深度：仓位区间向两侧各扩 30%，每段折成两种币的数量和美元
export async function depth(x: SolCtx, id: string) {
  const { c } = x
  const p = x.known.find((q) => q.id === id) ?? (await findPositions(c, undefined, [id]))[0]
  if (!p) throw new Error('仓位不存在')
  const m = await metaOf(x, p.token)
  const st = await poolState(x, p.pool)
  const width = p.upper - p.lower + 1
  let lo = p.lower - Math.round(width * 0.3), hi = p.upper + Math.round(width * 0.3)
  if (st.active < lo) lo = st.active - Math.round(width * 0.1)
  if (st.active > hi) hi = st.active + Math.round(width * 0.1)
  const key = `${p.pool.id}:${lo}:${hi}`
  const hit = x.depthCache.get(key)
  if (hit && Date.now() - hit.at < 8000) return hit.data
  const bars0 = await c.lp.depth(p.pool, lo, hi)
  const sol = await solUsd(c.conn), qUsd = p.quote.symbol === 'USDC' ? 1 : sol
  const price = quotePerToken(p, st.price)
  const priceAt = (u: number) => quotePerToken(p, c.lp.priceAt(p.pool, u))
  // 按约 110 根柱子合并
  const per = Math.max(1, Math.ceil(bars0.length / 110))
  const bars = []
  for (let i = 0; i < bars0.length; i += per) {
    const grp = bars0.slice(i, i + per)
    let u = 0n, t = 0n
    for (const b of grp) { u += p.tokenIsX ? b.amountY : b.amountX; t += p.tokenIsX ? b.amountX : b.amountY }
    const usdg = Number(u) / 10 ** p.quote.decimals, tok = Number(t) / 10 ** m.decimals
    const [pLo, pHi] = [priceAt(grp[0].lo), priceAt(grp[grp.length - 1].hi)].sort((a, b) => a - b)
    const mid = (grp[0].lo + grp[grp.length - 1].hi) / 2
    bars.push({ pLo, pHi, usdg, token: tok, usdgUsd: usdg * qUsd, tokenUsd: tok * price * qUsd, usd: (usdg + tok * price) * qUsd, inPos: mid >= p.lower && mid < p.upper + (c.protocol === 'dlmm' ? 1 : 0) })
  }
  bars.sort((a, b) => a.pLo - b.pLo)
  const [posLo, posHi] = c.lp.edges(p).map((v) => quotePerToken(p, v)).sort((a, b) => a - b)
  const data = { id, symbol: m.symbol, quote: p.quote.symbol, price, posLo, posHi, poolLiquidity: '0', initializedTicks: bars0.filter((b) => b.amountX > 0n || b.amountY > 0n).length, bars }
  x.depthCache.set(key, { at: Date.now(), data })
  return data
}

export async function history(x: SolCtx, id: string) {
  const { c } = x
  const p = x.known.find((q) => q.id === id)
  if (!p) throw new Error('仓位不在列表里，先刷新')
  const m = await metaOf(x, p.token)
  const st = await poolState(x, p.pool)
  const sol = await solUsd(c.conn), qUsd = p.quote.symbol === 'USDC' ? 1 : sol
  const events = await positionLedger(c, p, true)
  const rows = events.map((e) => {
    const [u, t] = p.tokenIsX ? [e.amountY, e.amountX] : [e.amountX, e.amountY]
    const [pu, pt] = p.tokenIsX ? [e.principalY, e.principalX] : [e.principalX, e.principalY]
    const usdOf = (a: bigint, b: bigint) => (Number(a) / 10 ** p.quote.decimals + (e.price === null ? 0 : (Number(b) / 10 ** m.decimals) * e.price)) * qUsd
    const total = usdOf(u, t), principal = usdOf(pu, pt)
    return { tx: e.sig, time: e.time, action: e.action, usdg: trim(u, p.quote.decimals), token: trim(t, m.decimals), usdgUsd: ((Number(u) / 10 ** p.quote.decimals) * qUsd).toFixed(2), tokenUsd: (total - (Number(u) / 10 ** p.quote.decimals) * qUsd).toFixed(2), usd: total.toFixed(2), feeUsd: e.action === 'add' ? null : (total - principal).toFixed(2), price: e.price === null ? '?' : p6(e.price) }
  }).reverse()
  const deposits = rows.filter((r) => r.action === 'add').reduce((s, r) => s + Number(r.usd), 0)
  const fees = rows.reduce((s, r) => s + Number(r.feeUsd ?? 0), 0)
  const withdrawn = rows.filter((r) => r.action === 'remove').reduce((s, r) => s + Number(r.usd) - Number(r.feeUsd), 0)
  const s = split(p), price = quotePerToken(p, st.price)
  const usd = (a: bigint, b: bigint) => (Number(a) / 10 ** p.quote.decimals + (Number(b) / 10 ** m.decimals) * price) * qUsd
  const value = usd(s.usdg, s.token), unclaimed = usd(s.feeUsdg, s.feeToken)
  return { id, symbol: m.symbol, quote: p.quote.symbol, events: rows, deposits: deposits.toFixed(2), fees: fees.toFixed(2), withdrawn: withdrawn.toFixed(2), value: value.toFixed(2), unclaimed: unclaimed.toFixed(2), pnl: (value + unclaimed + fees + withdrawn - deposits).toFixed(2) }
}

type ClosedRow = { id: string; token: string; symbol: string; fee: number; feeText: string; openedAt: number; closedAt: number; closedTx: string; deposits: number; withdrawn: number; fees: number; pnl: number; quote: string }
export async function closedList(x: SolCtx) {
  const { c } = x
  if (!x.known.length) x.known = await findPositions(c).catch(() => x.known)
  const list = await closedPositions(c, new Set(x.known.map((p) => p.id)))
  const sol = await solUsd(c.conn)
  let nonUsdg = 0, failed = 0
  const cents = (v: number) => Math.round(v * 100) / 100
  for (const q of list) {
    if (x.closedCache.has(q.id)) continue
    const side = quoteSide(q.pool)
    if (!side) { nonUsdg++; continue }
    try {
      const token = side.tokenIsX ? q.pool.mintX : q.pool.mintY
      const m = await metaOf(x, token)
      const events = await positionLedger(c, { id: q.id, pool: q.pool })
      if (!events.some((e) => e.action === 'add')) continue
      const s = sumLedger(events, { tokenIsX: side.tokenIsX, quote: side.quote }, m.decimals, side.quote.symbol === 'USDC' ? 1 : sol)
      x.closedCache.set(q.id, { id: q.id, token, symbol: m.symbol, fee: q.pool.fee / 10000, feeText: feeText(q.pool), openedAt: s.mintedAt, closedAt: q.closed.time, closedTx: q.closed.tx, deposits: cents(s.deposits), withdrawn: cents(s.withdrawn), fees: cents(s.fees), pnl: cents(s.withdrawn + s.fees - s.deposits), quote: side.quote.symbol })
    } catch (e: any) { failed++; log(`仓位 ${q.id.slice(0, 8)}… 平仓盈亏读取失败: ${String(e?.message).slice(0, 120)}`) }
  }
  return { closed: [...x.closedCache.values()].sort((a, b) => a.closedAt - b.closedAt), nonUsdg, failed }
}

export async function poolsFor(x: SolCtx, token: string) {
  const { c } = x
  const [pools, m] = await Promise.all([listTokenPools(c, token), metaOf(x, token)])
  const rows = await Promise.all(pools.map(async (q) => {
    let price: string | null = null
    if (q.usable) { const pool = await c.lp.poolById(q.id).catch(() => null); if (pool) { const s = await c.lp.state(pool).catch(() => null); const side = s && quoteSide(pool); if (s && side) price = p6(side.tokenIsX ? s.price : 1 / s.price) } }
    return { ...q, fee: q.fee / 10000, liquidityUsd: Math.round(q.liquidityUsd), volume24h: Math.round(q.volume24h), fee24h: q.fee24h === null ? null : Math.round(q.fee24h), price }
  }))
  return { symbol: m.symbol, pools: rows }
}

// 顶栏：余额（计价币 + SOL）、SOL 价、费率档
export async function stateOf(x: SolCtx, quote: 'SOL' | 'USDC') {
  const { c } = x
  const q = quote === 'USDC' ? { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 } : { mint: 'So11111111111111111111111111111111111111112', decimals: 9 }
  const [usdg, lamports, sol, tiers] = await Promise.all([balanceOf(c.conn, c.wallet, q.mint), c.conn.getBalance(c.wallet), solUsd(c.conn), c.lp.tiers().catch(() => [])])
  return { usdg: trim(usdg, q.decimals), eth: lamportsToSol(BigInt(lamports)), ethUsd: ((lamports / 1e9) * sol).toFixed(2), ethPrice: sol.toFixed(2), alchemy: c.rpcIsOwn, tiers: [...new Set(tiers.map((t) => t.fee / 10000))], quoteUsd: quote === 'USDC' ? 1 : sol }
}
export { quoteUsd }
