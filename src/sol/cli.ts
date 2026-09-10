// Solana 进场：计价币（SOL / USDC）-> 代币换币（Jupiter / 池内）、创建 / 复用池子（Meteora DLMM 或 Raydium CLMM）、按现价区间组 LP。撤退见 sol/exit.ts
// 流程和 EVM 的 cli.ts 一致：探测市场价 -> 池价偏离就先在池内校正 -> 按形状配比换币 -> 组仓位 -> 记录 positions.json -> 可选继续监控
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { parseUnits } from 'viem'
import * as v4 from '../v4.ts'
import { num } from '../common.ts'
import { QUOTES, balanceOf, die, env, failFast, feeText, isSolAddress, lamportsToSol, log, makeSolClients, p6, pct, quoteSide, saveSolPosition, sleep, solTxKit, solUsd, tokenMeta, trim, type QuoteName, type TxBundle } from './common.ts'
import type { MintPlan, PoolState, SolPool, Tier } from './lp.ts'
import { discoverQuotePools } from './pools.ts'
import { solExecuteSwap, solSwapDepsFor, solSwapOffers, type SolSwapOffer } from './swap.ts'
import { watchToken } from './monitor.ts'
import * as shapeMath from '../shape.ts'
import type { Shape } from '../shape.ts'

failFast()

const { values: opt } = parseArgs({
  options: {
    chain: { type: 'string' }, protocol: { type: 'string' },
    token: { type: 'string' },
    quote: { type: 'string', default: env('SOL_QUOTE', 'SOL') },                 // 计价币：SOL（Solana 上绝大多数池）| USDC
    usdg: { type: 'string', default: env('USDG_AMOUNT', '25') },                 // LP 总预算（计价币数量）
    fee: { type: 'string', default: env('POOL_FEE', '5') },                      // 池子费率 %（DLMM 是基础费，CLMM 是费率档）
    spacing: { type: 'string', default: env('TICK_SPACING', '') },               // DLMM 的 binStep / CLMM 的 tickSpacing；留空 = 该费率的默认档
    range: { type: 'string', default: env('RANGE', '-50%,+100%') },
    'price-range': { type: 'string', default: env('PRICE_RANGE', '') },
    slippage: { type: 'string', default: env('SWAP_SLIPPAGE', '5') },
    'lp-slippage': { type: 'string', default: env('LP_SLIPPAGE', '5') },
    'max-deviation': { type: 'string', default: env('MAX_DEVIATION', '10') },
    'pool-select': { type: 'string', default: env('POOL_SELECT', 'auto') },
    pool: { type: 'string', default: '' },
    shape: { type: 'string', default: env('LP_SHAPE', 'spot') },
    layers: { type: 'string', default: env('LP_LAYERS', '3') },
    watch: { type: 'boolean', default: false }, yes: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
    from: { type: 'string' }, json: { type: 'boolean', default: false },
  },
})
if (!opt.token || !isSolAddress(opt.token)) die('用法: npm run launch -- --chain solana [--protocol dlmm|clmm] --token <mint> [--quote SOL|USDC] [--usdg 1] [--fee 1] [--spacing 100] [--pool <池地址>] [--range="-50%,+100%" | --price-range="0.006,0.01"] [--shape spot|curve|bidask] [--layers 3] [--slippage 5] [--lp-slippage 5] [--max-deviation 10] [--watch] [--yes] [--dry-run]')
const token = opt.token
const quoteName = opt.quote.toUpperCase() as QuoteName
if (!QUOTES[quoteName]) die('--quote / SOL_QUOTE 只能是 SOL 或 USDC')
const Q = QUOTES[quoteName]
const poolId = opt.pool.trim()
if (poolId && !isSolAddress(poolId)) die(`--pool 必须是池地址，当前 "${opt.pool}"`)
let fee = Math.round(Number(opt.fee) * 10_000)
if (!poolId && !(fee > 0 && fee <= 1_000_000)) die(`POOL_FEE / --fee 必须是 (0, 100] 之间的百分比，当前 "${opt.fee}"`)
if (!['auto', 'exact'].includes(opt['pool-select'])) die('POOL_SELECT / --pool-select 只能是 auto 或 exact')
const shape = opt.shape.toLowerCase().replace('-', '') as Shape
if (!['spot', 'curve', 'bidask'].includes(shape)) die(`LP_SHAPE / --shape 只能是 spot、curve 或 bidask，当前 "${opt.shape}"`)
const layers = Number(opt.layers)
if (!(Number.isInteger(layers) && layers >= 2 && layers <= 8)) die(`LP_LAYERS / --layers 必须是 [2, 8] 的整数，当前 "${opt.layers}"`)
const rangePct = (opt.range.match(/[+-]?\d+(\.\d+)?/g) ?? []).map(Number)
if (rangePct.length === 1) rangePct.push(0)
if (rangePct.length !== 2 || rangePct[0] === rangePct[1]) die(`RANGE / --range 写法：-50%,+100%（双边）、-50%（只做下方）、+100%（只做上方），当前 "${opt.range}"`)
const [pLo, pHi] = [Math.min(...rangePct), Math.max(...rangePct)]
if (pLo <= -100) die('RANGE 下限必须大于 -100%')
const priceRange = (opt['price-range'].match(/\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number)
if (opt['price-range'] && (priceRange.length !== 2 || !(priceRange[0] > 0) || !(priceRange[1] > priceRange[0]))) die(`PRICE_RANGE / --price-range 写法：最低价,最高价（计价币/代币），如 0.006,0.01，当前 "${opt['price-range']}"`)
const swapSlippage = num('SWAP_SLIPPAGE / --slippage', opt.slippage, 0, 50), lpSlippage = num('LP_SLIPPAGE / --lp-slippage', opt['lp-slippage'], 0, 50)
const maxDev = Number(opt['max-deviation']) / 100
if (!(maxDev > 0 && maxDev < 1)) die('MAX_DEVIATION / --max-deviation 必须是 (0, 100) 之间的百分比')
const dryRun = opt['dry-run']

const clients = await makeSolClients({ from: opt.from, needKey: !dryRun, protocol: opt.protocol as any })
const { conn, wallet, cfg, lp } = clients
const QU = 10n ** BigInt(Q.decimals)
const rangeLabel = priceRange.length ? `${priceRange[0]} .. ${priceRange[1]} ${Q.symbol}` : `${pLo > 0 ? '+' : ''}${pLo}% .. ${pHi > 0 ? '+' : ''}${pHi}%`
const usdgBudget = parseUnits(opt.usdg, Q.decimals)
if (usdgBudget <= 0n) die('USDG_AMOUNT / --usdg 必须大于 0')
const shapeLabel = { spot: 'spot（单个仓位）', curve: lp.protocol === 'dlmm' ? 'curve（Meteora 原生 Curve 策略，越靠现价越厚）' : `curve（${layers} 层同心嵌套，越靠现价越厚）`, bidask: lp.protocol === 'dlmm' ? 'bidask（Meteora 原生 Bid-Ask 策略，越远越厚）' : `bidask（现价两侧各 ${layers} 段，越远越厚）` }[shape]

// ---- 费率档 / 池子 ----
let tier: Tier | null = null
if (!poolId) {
  const spacing = opt.spacing ? Number(opt.spacing) : undefined
  if (spacing !== undefined && !(Number.isInteger(spacing) && spacing >= 1)) die(`TICK_SPACING / --spacing 必须是正整数（DLMM 的 binStep / CLMM 的 tickSpacing）`)
  tier = await lp.tierFor(fee, spacing)
  if (!tier) {
    const all = await lp.tiers()
    const msg = `${lp.label} 没有 ${opt.fee}%${spacing ? ` / ${spacing}` : ''} 这一档（可选：${[...new Set(all.map((t) => `${t.fee / 10000}%`))].join(' / ')}）`
    if (opt['pool-select'] === 'exact') die(msg)
    log(`提示: ${msg}，只看已有池`)
  }
}
let pool: SolPool | null = poolId ? await lp.poolById(poolId).then((p) => p ?? die(`池 ${poolId} 读不到（不是 ${lp.label} 的池？）`)) : tier ? await lp.pool(token, Q.mint, tier) : null
if (pool) {
  const q = quoteSide(pool)
  if (!q || (q.tokenIsX ? pool.mintX : pool.mintY) !== token) die(`池 ${pool.id} 不是 ${token} / SOL|USDC 池`)
  if (poolId && q.quote.symbol !== Q.symbol) log(`提示: 指定的池以 ${q.quote.symbol} 计价，按它来`)
}
const [{ symbol, name, decimals }, sol] = await Promise.all([tokenMeta(conn, token), solUsd(conn)])
const quoteOfPool = pool ? quoteSide(pool)!.quote : Q
const usd = (lamports: bigint) => ((Number(lamports) / 1e9) * sol).toFixed(2)
const fmtU = (x: bigint) => trim(x, quoteOfPool.decimals), fmtT = (x: bigint) => trim(x, decimals)
const [usdgStart, tokenStart, solBal] = await Promise.all([balanceOf(conn, wallet, quoteOfPool.mint), balanceOf(conn, wallet, token), conn.getBalance(wallet)])
log(`${cfg.label} / ${lp.label} | 钱包 ${wallet.toBase58()} | ${fmtU(usdgStart)} ${quoteOfPool.symbol}${quoteOfPool.symbol !== 'SOL' ? `, ${lamportsToSol(BigInt(solBal))} SOL` : ''} | SOL $${sol.toFixed(2)}`)
log(`代币 ${symbol} (${name}) 精度=${decimals} 地址 ${token}`)
const holdings = async () => { const [u, t] = await Promise.all([balanceOf(conn, wallet, quoteOfPool.mint), balanceOf(conn, wallet, token)]); return { spent: usdgStart - u, held: t } }

let state: PoolState | null = pool ? await lp.state(pool) : null
let initialized = !!state
// 配置的池不存在：看看这个币已有哪些计价币池（同费率优先，否则流动性够、成交量最大的），都没有才新建
if (!initialized && opt['pool-select'] === 'auto' && !poolId) {
  const pools = (await discoverQuotePools(clients, token, Q.mint)).sort((a, b) => b.volume24h - a.volume24h)
  const usd$ = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`
  if (pools.length) log(`已有 ${symbol}/${Q.symbol} 池: ${pools.slice(0, 4).map((p) => `${feeText(p.pool)}/${p.pool.step} ${p.empty === null ? '流动性未知' : p.empty ? '空池' : `流动性${usd$(p.liquidityUsd)} 日成交${usd$(p.volume24h)}`}`).join('；')}${pools.length > 4 ? '…' : ''}`)
  const minLiq = Math.max(5000, Number(fmtU(usdgBudget)) * (Q.symbol === 'SOL' ? sol : 1))
  const pick = pools.find((p) => p.empty === false && p.pool.fee === fee) ?? pools.find((p) => p.empty === false && p.liquidityUsd >= minLiq)
  if (pick) {
    pool = pick.pool; fee = pool.fee
    state = await lp.state(pool); initialized = true
    log(`复用 ${pick.name}（${feeText(pool)}/${pool.step}${pick.pool.fee !== Math.round(Number(opt.fee) * 10_000) ? '，与配置的费率不同，成交最活跃' : '，同费率'}）；只想用自己配置的费率请设 POOL_SELECT=exact`)
  }
}
if (!pool && !tier) die(`${symbol} 在 ${lp.label} 上没有可复用的 ${Q.symbol} 池，且配置的费率 ${opt.fee}% 没有对应的档，建不了池`)
const tokenIsX = pool ? quoteSide(pool)!.tokenIsX : true
const step = pool ? pool.step : tier!.step
// 池子（未建时按 tier 构造一个占位，只用于 bin / tick 换算）
const poolLike = (): SolPool => pool ?? { id: '', protocol: lp.protocol, mintX: token, mintY: Q.mint, decX: decimals, decY: Q.decimals, step, fee: tier!.fee }
// 计价币 每 代币（UI）<-> Y 每 X
const toYX = (quotePerToken: number) => (tokenIsX ? quotePerToken : 1 / quotePerToken)
const fromYX = (yx: number) => (tokenIsX ? yx : 1 / yx)
const priceOfUnit = (u: number) => fromYX(lp.priceAt(poolLike(), u))
const price = (u: number) => `${p6(priceOfUnit(u))} ${quoteOfPool.symbol}/${symbol}`
const deviation = (poolPrice: number, marketPrice: number) => poolPrice / marketPrice - 1
log(`池子 ${symbol}/${quoteOfPool.symbol} 费率=${pool ? feeText(pool) : `${tier!.fee / 10000}%`} ${lp.protocol === 'dlmm' ? 'binStep' : '间距'}=${step}${poolId ? '（按地址指定）' : ''}: ${initialized ? `已存在，${lp.protocol === 'dlmm' ? 'bin' : 'tick'} ${state!.active} = ${price(state!.active)}` : '不存在，将创建'}`)

// ---- 区间 -> 单位（bin / tick）：先算出 计价币/代币 的价格上下界，换成 Y/X 后取整；远端向外、0% 那端向内（单边仓位不含现价）----
// DLMM 的上界是含现价 bin 的编号（闭区间），CLMM 的上界是 tick（开区间、且是间距的倍数）
function rangeFor(active: number): [number, number] {
  const dlmm = lp.protocol === 'dlmm'
  const cur = priceOfUnit(active)
  let loQ: number, hiQ: number, zeroLo = false, zeroHi = false
  if (priceRange.length) [loQ, hiQ] = priceRange
  else { loQ = cur * (1 + pLo / 100); hiQ = cur * (1 + pHi / 100); zeroLo = pLo === 0; zeroHi = pHi === 0 }
  const yx = [toYX(loQ), toYX(hiQ)].sort((a, b) => a - b)
  let lo = lp.unitAt(poolLike(), yx[0], 'down'), hi = lp.unitAt(poolLike(), yx[1], 'up')
  if (!dlmm) { lo = v4.floorToSpacing(lo, step); hi = v4.ceilToSpacing(hi, step) }
  // 靠着现价的那一端向内取整：token 价格的 0% 端在 Y/X 里是下端还是上端取决于代币在哪一边
  const innerLow = tokenIsX ? zeroLo : zeroHi, innerHigh = tokenIsX ? zeroHi : zeroLo
  if (innerLow) lo = dlmm ? active + 1 : v4.ceilToSpacing(active + 1, step)
  if (innerHigh) hi = dlmm ? active : v4.floorToSpacing(active, step)
  if (priceRange.length) { // 绝对价格整体在现价一侧、取整后却跨过了现价：靠近现价的那端收回一格
    const aboveAll = yx[0] > lp.priceAt(poolLike(), active + (dlmm ? 1 : 0)), belowAll = yx[1] < lp.priceAt(poolLike(), active)
    if (aboveAll && lo <= active) lo = dlmm ? active + 1 : v4.ceilToSpacing(active + 1, step)
    if (belowAll && hi > active) hi = dlmm ? active : v4.floorToSpacing(active, step)
  }
  if (dlmm) hi -= 1 // 闭区间：unitAt(...,'up') 给的是上沿所在 bin 的下一格
  if (hi < lo || (!dlmm && hi <= lo)) die(`区间 ${rangeLabel} 不足一格（${lp.protocol === 'dlmm' ? `binStep ${step}` : `tick 间距 ${step}`}），请放宽区间或换更细的档`)
  return [lo, hi]
}
const rangeText = ([lo, hi]: readonly [number, number]) => { const [a, b] = [priceOfUnit(lo), priceOfUnit(lp.protocol === 'dlmm' ? hi + 1 : hi)].sort((x, y) => x - y); return `${lp.protocol === 'dlmm' ? 'bins' : 'ticks'} [${lo}, ${hi}] = ${p6(a)} .. ${p6(b)} ${quoteOfPool.symbol}/${symbol} (${rangeLabel})` }

// ---- 换币 / 市场价 ----
const swapDeps = solSwapDepsFor(clients, swapSlippage, env('SWAP_VIA', 'best') === 'okx' || env('SWAP_VIA', 'best') === 'uniswap' ? 'best' : env('SWAP_VIA', 'best'), (x: bigint) => trim(x, decimals), symbol)
const buyOffers = (amount: bigint, external = false) => solSwapOffers(swapDeps, quoteOfPool.mint, token, amount, { external })
async function bestBuy(amount: bigint, what: string, external = false) {
  const offers = await buyOffers(amount, external)
  const [o] = offers
  if (!o) die(`${what}：Jupiter${external ? '' : ' 和池内'}都找不到能吃下 ${fmtU(amount)} ${quoteOfPool.symbol} 的路由（代币流动性太薄），把 USDG_AMOUNT 调小再试`)
  if (!external && offers.length > 1) log(`${what}报价: ${offers.map((x) => x.text).join('；')}`)
  return o
}
const probe = await bestBuy(QU, '探测市场价', true)
let rate = Number(probe.out) / Number(QU)                       // 代币基础单位 / 计价币基础单位
const marketOf = (r: number) => (1 / r) * 10 ** (decimals - quoteOfPool.decimals) // 计价币 每 代币（UI）
let marketPrice = marketOf(rate)
const poolPrice = () => fromYX(state!.price)
log(`市场价 ${p6(marketPrice)} ${quoteOfPool.symbol}/${symbol}（${probe.via}）${initialized ? `，池价偏离 ${pct(deviation(poolPrice(), marketPrice))}` : ''}`)
if (initialized) swapDeps.pools = [pool!]

// ---- 形状：由适配器给出这个形状在当前池价下 X:Y 的配比 ----
const refActive = initialized ? state!.active : lp.unitAt(poolLike(), toYX(marketPrice), 'down')
const planRange = rangeFor(refActive)
const mintReq = { lower: planRange[0], upper: planRange[1], active: refActive, shape, layers, lpSlippage, tokenIsX }
let plan: MintPlan | null = pool ? await lp.mintPlan(pool, mintReq) : null
// 每 1 计价币基础单位配多少代币基础单位（Infinity = 全代币，0 = 全计价币）
async function tokenPerQuote(st: PoolState) {
  if (!plan) { // 新池还没建：按区间和现价的位置估（全在上方 = 全代币，全在下方 = 全计价币，跨过现价按 Y/X 几何近似）
    const [lo, hi] = planRange, a = refActive
    if (lo > a) return tokenIsX ? Infinity : 0
    if ((lp.protocol === 'dlmm' ? hi : hi - 1) < a) return tokenIsX ? 0 : Infinity
    const sp = Math.sqrt(lp.priceAt(poolLike(), a)), sa = Math.sqrt(lp.priceAt(poolLike(), lo)), sb = Math.sqrt(lp.priceAt(poolLike(), lp.protocol === 'dlmm' ? hi + 1 : hi))
    const x = (sb - sp) / (sp * sb), y = sp - sa // 每单位流动性的 X / Y
    return tokenIsX ? x / y : y / x
  }
  const r = await plan.yPerX(st) // Y 每 X
  return tokenIsX ? (r === Infinity ? 0 : r === 0 ? Infinity : 1 / r) : r
}
// 预算拆分：已持有 held 个代币、按汇率 rate 换币，换多少计价币能让两边刚好用尽
function swapShare(budget: bigint, held: bigint, tpq: number, r: number) {
  if (tpq === Infinity) return budget
  if (tpq === 0) return 0n
  const V = Number(budget) + Number(held) / r
  const q = V / (1 + tpq / r), t = tpq * q
  const s = (t - Number(held)) / r
  return s <= 0 ? 0n : s >= Number(budget) ? budget : BigInt(Math.floor(s))
}

// ---- 池价校正（只做"在池内交易把价格推回市场价"）：二分投入量，用适配器的报价看终点价 ----
type Correction = { dev: number; devAfter: number; xToY: boolean; amountIn: bigint; minOut: bigint }
async function planCorrection(): Promise<Correction | null> {
  state = await lp.state(pool!)
  const dev = deviation(poolPrice(), marketPrice)
  if (Math.abs(dev) <= maxDev) return null
  const targetYX = toYX(marketPrice)
  const xToY = state.price > targetYX // 池价（Y/X）高于目标就卖 X 压价
  const cin = xToY ? pool!.mintX : pool!.mintY
  const cap = cin === quoteOfPool.mint ? usdgBudget : BigInt(Math.floor(Number(usdgBudget) * rate)) // 最多花一个预算的量
  // 二分：under = 没推过目标的最大投入，over = 推过了的最小投入。两边谁在阈值内用谁；都不在说明池价到市场价之间有一段没流动性（一跳就过）
  type Pt = { amountIn: bigint; out: bigint; end: number }
  let lo = 0n, hi = cap, under: Pt | null = null, over: Pt | null = null, failed = 0
  for (let i = 0; i < 16 && hi - lo > cap / 400n; i++) {
    const mid = i === 0 ? cap : (lo + hi) / 2n
    let q: { out: bigint; endPrice: number }
    try { q = await lp.quoteSwap(pool!, xToY, mid) } catch { hi = mid; failed++; continue }
    const pt = { amountIn: mid, out: q.out, end: q.endPrice }
    if (xToY ? q.endPrice < targetYX : q.endPrice > targetYX) { hi = mid; over = pt } else { lo = mid; under = pt; if (i === 0) break }
  }
  if (!under && !over) die(`池价偏离市场价 ${pct(dev)}，池内报不出价（没有流动性），放弃`)
  const pick = [under, over].filter((x): x is Pt => !!x).map((x) => ({ ...x, devAfter: deviation(fromYX(x.end), marketPrice) })).sort((a, b) => Math.abs(a.devAfter) - Math.abs(b.devAfter))[0]
  if (Math.abs(pick.devAfter) > maxDev) die(`池价偏离市场价 ${pct(dev)}，池内交易${under && !over ? `花一个预算也只能拉到 ${pct(under && deviation(fromYX(under.end), marketPrice))}（流动性太厚）` : `一跳就到 ${pct(pick.devAfter)}（池价到市场价之间没有流动性，要先补一段流动性）`}，放弃`)
  return { dev, devAfter: pick.devAfter, xToY, amountIn: pick.amountIn, minOut: (pick.out * 995n) / 1000n }
}
const correctionText = (c: Correction) => { const cin = c.xToY ? pool!.mintX : pool!.mintY; const f = (x: bigint) => `${trim(x, cin === token ? decimals : quoteOfPool.decimals)} ${cin === token ? symbol : quoteOfPool.symbol}`; return `池价偏离 ${pct(c.dev)} 超过 ${maxDev * 100}%，先在池内卖出 ≈${f(c.amountIn)}，把偏离拉到 ${pct(c.devAfter)}` }
const correctionCost = (c: Correction) => ((c.xToY ? pool!.mintX : pool!.mintY) === token ? BigInt(Math.ceil(Number(c.amountIn) / rate)) : c.amountIn)

// ---- 计划 ----
let usdgSpend = usdgBudget, tokenCap = false
const tokenPart = async (st: PoolState | null) => { const tpq = await tokenPerQuote(st ?? { price: toYX(marketPrice), active: refActive, hasLiquidity: false }); return tpq === Infinity ? BigInt(Math.floor(Number(usdgBudget) * rate)) : tpq === 0 ? 0n : BigInt(Math.floor((Number(usdgBudget) * tpq) / (1 + tpq / rate))) }
if (tokenStart > 0n) {
  const heldValue = BigInt(Math.ceil(Number(tokenStart) / rate))
  if (heldValue >= usdgBudget) { tokenCap = true; const t = await tokenPart(state); usdgSpend = usdgBudget - BigInt(Math.ceil(Number(t) / rate)); log(`钱包已有 ${fmtT(tokenStart)} ${symbol}（≈${fmtU(heldValue)} ${quoteOfPool.symbol}）超过预算 ${fmtU(usdgBudget)}：只投入 ≈${fmtT(t)} ${symbol} + ≈${fmtU(usdgSpend)} ${quoteOfPool.symbol}，其余留在钱包，不换币`) }
  else { usdgSpend = usdgBudget - heldValue; log(`钱包已有 ${fmtT(tokenStart)} ${symbol}（≈${fmtU(heldValue)} ${quoteOfPool.symbol}），计入本次 LP，剩余 ${quoteOfPool.symbol} 预算 ${fmtU(usdgSpend)}`) }
}
const correction = initialized ? await planCorrection() : null
if (correction) { if (correctionCost(correction) > usdgSpend) die(`池价偏离市场价 ${pct(correction.dev)}，校正约需 ${fmtU(correctionCost(correction))} ${quoteOfPool.symbol}，超过预算，放弃`); log(`计划: ${correctionText(correction)}`) }
const tpqPlan = await tokenPerQuote(state ?? { price: toYX(marketPrice), active: refActive, hasLiquidity: false })
const estSwap = swapShare(usdgSpend, tokenStart, tpqPlan, rate)
let planOffer: SolSwapOffer | null = null
if (estSwap > 0n) {
  planOffer = await bestBuy(estSwap, '换币')
  const impact = Number(planOffer.out) / Number(estSwap) / rate - 1
  if (impact < -0.2) die(`换 ${fmtU(estSwap)} ${quoteOfPool.symbol} 的价格冲击 ${pct(impact)}（流动性太薄），把 USDG_AMOUNT 调小再试`)
  if (impact < -0.05) log(`警告: 换 ${fmtU(estSwap)} ${quoteOfPool.symbol} 的价格冲击 ${pct(impact)}`)
}
log(`计划: ${planOffer ? `换币 ≈${fmtU(estSwap)} ${quoteOfPool.symbol} -> ${planOffer.text}` : '无需换币'}，LP ≈${fmtU(usdgSpend - estSwap)} ${quoteOfPool.symbol} + ${tokenCap ? '预算内的' : tokenStart > 0n ? '手里全部的' : '全部拿到的'} ${symbol}${correction ? '（校正开销另计）' : ''}`)
log(`计划: 区间 ${rangeText(planRange)}，形状 ${shapeLabel}，滑点 换币 ${swapSlippage}% / LP ${lpSlippage}%`)
// 新池：建池租金实测 DLMM 约 0.032 SOL、Raydium 约 0.056 SOL（不退），仓位租金建完池才能精确估，先按 0.2 SOL 留
const cost = plan ? await plan.cost().catch((e: any) => ({ text: `费用估算失败: ${String(e?.message).slice(0, 80)}`, solNeeded: 0.2 })) : { text: `新池：建池 1 笔交易（租金约 ${lp.protocol === 'dlmm' ? '0.03' : '0.06'} SOL 不退）+ 组仓位（建完池再估仓位租金，先留 0.2 SOL）`, solNeeded: 0.3 }
const costText = cost.text
log(`计划: ${costText}`)
// 预算之外还要留 SOL：仓位 / bin 数组 / tick 数组租金 + 手续费。SOL 计价时从同一个余额里出
const reserve = BigInt(Math.ceil((cost.solNeeded + 0.01) * 1e9))
const needSol = quoteOfPool.symbol === 'SOL' ? usdgSpend + reserve : reserve
if (BigInt(solBal) < needSol) { const msg = `需要 ${lamportsToSol(needSol)} SOL（${quoteOfPool.symbol === 'SOL' ? `预算 ${fmtU(usdgSpend)} + ` : ''}租金 / 手续费 ${lamportsToSol(reserve)}），钱包只有 ${lamportsToSol(BigInt(solBal))}`; dryRun ? log(`警告: ${msg}`) : die(msg) }
if (quoteOfPool.symbol !== 'SOL' && usdgStart < usdgSpend) { const msg = `需要 ${fmtU(usdgSpend)} ${quoteOfPool.symbol}，钱包只有 ${fmtU(usdgStart)}`; dryRun ? log(`警告: ${msg}`) : die(msg) }
if (opt.json) {
  const [lo, hi] = planRange
  const [a, b] = [priceOfUnit(lo), priceOfUnit(lp.protocol === 'dlmm' ? hi + 1 : hi)].sort((x, y) => x - y)
  console.log('@@plan ' + JSON.stringify({
    kind: 'launch', chain: 'solana', protocol: lp.protocol, quote: quoteOfPool.symbol, native: 'SOL', wallet: wallet.toBase58(), usdg: fmtU(usdgStart), eth: lamportsToSol(BigInt(solBal)), ethPrice: sol.toFixed(2),
    token: { address: token, symbol, name, decimals },
    pool: { id: pool?.id ?? '（新建）', fee: (pool?.fee ?? tier!.fee) / 10000, feeText: pool ? feeText(pool) : `${tier!.fee / 10000}%`, spacing: step, hooks: null, state: initialized ? 'reuse' : 'create', price: initialized ? p6(poolPrice()) : null, deviation: initialized ? pct(deviation(poolPrice(), marketPrice)) : null },
    market: { price: p6(marketPrice), via: probe.via },
    correction: correction ? correctionText(correction) : null, cost: costText,
    swap: planOffer ? { usdgIn: fmtU(estSwap), out: fmtT(planOffer.out), via: planOffer.via, text: planOffer.text } : null,
    lp: { usdg: fmtU(usdgSpend - estSwap), token: tokenCap ? '预算内的' : tokenStart > 0n ? '手里全部的' : '全部换到的', held: fmtT(tokenStart) },
    range: { tickLower: lo, tickUpper: hi, lo: p6(a), hi: p6(b), label: rangeLabel },
    shape: { kind: shape, layers: shape === 'spot' || lp.protocol === 'dlmm' ? 1 : layers, label: shapeLabel },
    legs: (() => {
      const legs = plan?.legs ?? [{ lower: lo, upper: hi, g: 1 }]
      const shares = lp.protocol === 'clmm' ? shapeMath.legShares(legs.map((l) => ({ lo: l.lower, hi: l.upper, g: l.g })), refActive, 1 / rate, !tokenIsX) : legs.map(() => 1)
      // 仓位相对现价：Y/X 里在现价下方 = 全是 Y，上方 = 全是 X；哪个是计价币看代币在哪一边
      const side = (l: { lower: number; upper: number }) => { const top = lp.protocol === 'dlmm' ? l.upper : l.upper - 1; return top < refActive ? (tokenIsX ? 'usdg' : 'token') : l.lower > refActive ? (tokenIsX ? 'token' : 'usdg') : 'both' }
      return legs.map((l, i) => { const [x, y] = [priceOfUnit(l.lower), priceOfUnit(lp.protocol === 'dlmm' ? l.upper + 1 : l.upper)].sort((m, n) => m - n); return { tickLower: l.lower, tickUpper: l.upper, lo: p6(x), hi: p6(y), share: Math.round(shares[i] * 100), side: side(l) } })
    })(),
    slippage: { swap: swapSlippage, lp: lpSlippage }, watch: opt.watch,
  }))
}
if (dryRun) { log('演练模式，到此为止'); await sleep(100); process.exit(0) }
if (!opt.yes) { const rl = createInterface({ input: process.stdin, output: process.stdout }); const ans = await rl.question('确认执行? (y/N) '); rl.close(); if (ans.trim().toLowerCase() !== 'y') die('已取消') }

// ---- 交易 ----
const kit = solTxKit(clients, usd)
const buy = (o: SolSwapOffer, label: string) => solExecuteSwap(o, swapDeps, kit, quoteOfPool.mint, token, label)
async function ensureTokens(need: bigint, label: string) {
  const short = need - (await holdings()).held
  if (short <= 0n) return
  let amountIn = BigInt(Math.ceil((Number(short) / rate) * 1.05)), o: SolSwapOffer | undefined
  for (let i = 0; !o && i < 3; i++) { const [x] = await buyOffers(amountIn); if (!x) break; if (x.out >= short) o = x; else amountIn = (amountIn * short * 103n) / (x.out * 100n) }
  if (!o) die(`买不到 ${fmtT(short)} ${symbol}（找不到路由）`)
  log(`换币完成: 拿到 ${fmtT(await buy(o, label))} ${symbol}`)
}
// 0) 建池
if (!initialized) {
  const { bundles, poolId: newId } = await lp.createPoolTx(token, Q.mint, tier!, toYX(marketPrice), decimals, Q.decimals)
  await kit.sendAll(bundles)
  pool = await lp.poolById(newId)
  if (!pool) die(`建池交易成功但读不到池 ${newId}`)
  state = await lp.state(pool); initialized = true
  plan = await lp.mintPlan(pool, mintReq)
  swapDeps.pools = [pool]
  log(`建池完成: ${pool.id}，初始价 ${price(state.active)}`)
}
// 1) 池价校正（最多 3 轮）
if (correction) {
  for (let round = 1; ; round++) {
    if (round > 1) { rate = Number((await bestBuy(QU, '探测市场价', true)).out) / Number(QU); marketPrice = marketOf(rate) }
    const c = round === 1 ? correction : await planCorrection()
    if (!c) { log(`池价偏离 ${pct(deviation(poolPrice(), marketPrice))}，已在阈值内`); break }
    if (round > 3) die(`3 轮校正后池价仍偏离 ${pct(c.dev)}，放弃`)
    if (correctionCost(c) > usdgSpend - (await holdings()).spent) die(`校正约需 ${fmtU(correctionCost(c))} ${quoteOfPool.symbol}，超过剩余预算，放弃`)
    const cin = c.xToY ? pool!.mintX : pool!.mintY
    if (cin === token) await ensureTokens(c.amountIn, `买入 ${symbol} 用于校正`)
    await kit.send({ ...(await lp.swapTx(pool!, c.xToY, c.amountIn, c.minOut)), label: `校正池价 (卖出 ${trim(c.amountIn, cin === token ? decimals : quoteOfPool.decimals)} ${cin === token ? symbol : quoteOfPool.symbol})` })
    state = await lp.state(pool!)
    log(`池价 ${price(state.active)}，偏离市场价 ${pct(deviation(poolPrice(), marketPrice))}`)
    if (Math.abs(deviation(poolPrice(), marketPrice)) <= maxDev) break
  }
}
// 2) 换币
let { spent, held } = await holdings()
let budgetLeft = usdgSpend - spent
if (budgetLeft > 0n) {
  state = await lp.state(pool!)
  let swapAmount = swapShare(budgetLeft, held, await tokenPerQuote(state), rate)
  if (swapAmount > 0n) {
    let o = planOffer && planOffer.amountIn === swapAmount && Date.now() - planOffer.at < 20_000 ? planOffer : await bestBuy(swapAmount, '换币')
    const resized = swapShare(budgetLeft, held, await tokenPerQuote(state), Number(o.out) / Number(o.amountIn))
    if ((resized > swapAmount ? resized - swapAmount : swapAmount - resized) > swapAmount / 200n) { swapAmount = resized; o = await bestBuy(swapAmount, '换币') }
    const failed = new Set<SolSwapOffer['via']>()
    for (;;) {
      try { const got = await buy(o, '换币'); log(`换币完成: ${fmtU(swapAmount)} ${quoteOfPool.symbol} -> ${fmtT(got)} ${symbol}`); break } catch (e: any) {
        if ((await holdings()).held > held) { log(`换币 (${o.via}) 报错但代币已到账，继续`); break }
        failed.add(o.via)
        const next = failed.size < 2 ? (await buyOffers(swapAmount)).find((x) => !failed.has(x.via)) : undefined
        if (!next) throw e
        log(`换币 (${o.via}) 失败: ${String(e?.shortMessage ?? e?.message).split('\n')[0].slice(0, 160)}，改走 ${next.text}`)
        o = next
      }
    }
    ;({ spent, held } = await holdings())
    budgetLeft = usdgSpend - spent
  }
}
if (budgetLeft < 0n) budgetLeft = 0n
if (quoteOfPool.symbol === 'SOL') { const bal = BigInt(await conn.getBalance(wallet)); if (bal - reserve < budgetLeft) budgetLeft = bal > reserve ? bal - reserve : 0n } // 租金 / 手续费的 SOL 不能投进去
// 3) 组仓位：按手里的币建交易，失败就重读池价重建，最多 5 次
const ids: string[] = []
let firstSig = ''
for (let attempt = 1; ; attempt++) {
  state = await lp.state(pool!)
  log(`LP 价格: ${lp.protocol === 'dlmm' ? 'bin' : 'tick'} ${state.active} = ${price(state.active)}`)
  const heldUse = tokenCap ? (held < (await tokenPart(state)) ? held : await tokenPart(state)) : held
  const [amountX, amountY] = tokenIsX ? [heldUse, budgetLeft] : [budgetLeft, heldUse]
  let built: Awaited<ReturnType<MintPlan['build']>>
  try { built = await plan!.build(amountX, amountY, state) } catch (e: any) {
    if (attempt >= 5) throw e
    log(`组LP: ${String(e?.message).slice(0, 120)}，按新池价重算区间（第 ${attempt} 次）`)
    plan = await lp.mintPlan(pool!, { ...mintReq, lower: rangeFor(state.active)[0], upper: rangeFor(state.active)[1], active: state.active })
    await sleep(3000); continue
  }
  log(`组LP: 投入 ${tokenIsX ? `${fmtT(built.useX)} ${symbol} + ${fmtU(built.useY)} ${quoteOfPool.symbol}` : `${fmtU(built.useX)} ${quoteOfPool.symbol} + ${fmtT(built.useY)} ${symbol}`}（${built.note}），仓位 ${built.ids.map((x) => x.slice(0, 8) + '…').join(', ')}`)
  try {
    const sent = await kit.sendAll(built.bundles as TxBundle[])
    firstSig = sent[0]?.sig ?? ''
    ids.push(...built.ids)
    break
  } catch (e: any) {
    if (attempt >= 5 || e?.onchain) throw e
    log(`组LP 失败: ${String(e?.shortMessage ?? e?.message).split('\n')[0].slice(0, 160)}，等 3 秒按新池价重试（第 ${attempt} 次）`)
    await sleep(3000)
  }
}
const at = new Date().toISOString()
for (const id of ids) saveSolPosition({ id, token, symbol, poolId: pool!.id, kind: 'lp', at, chain: 'solana', protocol: lp.protocol, quote: quoteOfPool.symbol as QuoteName, ...(shape !== 'spot' ? { shape, group: firstSig } : {}) })
log(`完成: 仓位 ${ids.join(', ')}，池 ${pool!.id}（已记录到 positions.json，撤退: npm run exit -- --chain solana --protocol ${lp.protocol} --token ${token}）`)
if (firstSig) log(`      ${cfg.explorer}/tx/${firstSig}`)
log(`手续费合计: ${kit.stats.txCount} 笔，${lamportsToSol(kit.stats.feeTotal)} SOL ($${usd(kit.stats.feeTotal)})`)
if (opt.json) console.log('@@positions ' + JSON.stringify(ids))
if (opt.watch) await watchToken({
  token, positions: ids, clients, interval: Math.max(3, num('WATCH_INTERVAL', env('WATCH_INTERVAL', '10'), 0, 86400)), confirm: Math.max(1, num('WATCH_CONFIRM', env('WATCH_CONFIRM', '2'), 0, 1000)),
  upperGrace: num('WATCH_UPPER_GRACE', env('WATCH_UPPER_GRACE', '600'), 0, 86400 * 30), via: ['jupiter', 'pool', 'best'].includes(env('EXIT_SWAP_VIA', 'best')) ? env('EXIT_SWAP_VIA', 'best') : 'best', slippage: swapSlippage, lpSlippage, dryRun: false, json: opt.json,
})
