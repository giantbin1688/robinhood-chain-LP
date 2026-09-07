// 进场：USDG -> 代币换币（Uniswap Trading API 路由）、创建/复用 v4 池、按现价区间组 LP。撤退见 exit.ts
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { encodeFunctionData, formatEther, getAddress, parseEventLogs, parseUnits, type Address, type Hex } from 'viem'
import * as v4 from './v4.ts'
import {
  POSM, QUOTER, STATE_VIEW, UR, USDG, EXPLORER, abs, die, env, erc20Abi, ethPriceUsd, log, makeClients, min, now, p6, pct, posmAbi,
  quoterAbi, savePosition, sleep, slippageRevert, stateViewAbi, tokenMeta, trim, txKit, uniswapApi, okxDex, swapOffers, executeSwap, type SwapOffer,
} from './common.ts'
import { watchToken } from './monitor.ts'
import { discoverUsdgPools } from './pools.ts'

// 默认值来自 params.env，命令行参数可临时覆盖
const { values: opt } = parseArgs({
  options: {
    token: { type: 'string' },
    usdg: { type: 'string', default: env('USDG_AMOUNT', '25') },              // LP 总预算（USDG）
    fee: { type: 'string', default: env('POOL_FEE', '5') },                   // 池子费率 %
    spacing: { type: 'string', default: env('TICK_SPACING', '') },            // 留空 = fee/50
    range: { type: 'string', default: env('RANGE', '-50%,+100%') },          // 区间：相对现价的百分比
    'price-range': { type: 'string', default: env('PRICE_RANGE', '') },      // 区间：绝对价格（USDG/代币）"最低价,最高价"，设置了就优先于 RANGE
    slippage: { type: 'string', default: env('SWAP_SLIPPAGE', '5') },         // 换币滑点 %
    'lp-slippage': { type: 'string', default: env('LP_SLIPPAGE', '5') },      // mint amountMax 余量 %
    'max-deviation': { type: 'string', default: env('MAX_DEVIATION', '10') },// 池价与市场价最大偏离 %
    'pool-select': { type: 'string', default: env('POOL_SELECT', 'auto') },  // auto: 配置的池不存在时复用该币已有的 USDG 池；exact: 只用配置的费率/间距
    watch: { type: 'boolean', default: false },     // 组完 LP 后继续监控，跳出区间自动撤退
    yes: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },   // 只看计划，不发交易
    from: { type: 'string' },                         // --dry-run 时可用地址代替私钥
  },
})
if (!opt.token) die('用法: npm run launch -- --token <地址> [--usdg 25] [--fee 5] [--spacing 1000] [--range="-50%,+100%" | --price-range="0.006,0.01"] [--slippage 5] [--lp-slippage 5] [--max-deviation 10] [--watch] [--yes] [--dry-run]')
const token = getAddress(opt.token)
const usdgBudget = parseUnits(opt.usdg, 6)
if (usdgBudget <= 0n) die('USDG_AMOUNT / --usdg 必须大于 0')
let fee = Math.round(Number(opt.fee) * 10_000) // pips
if (!(fee > 0 && fee <= 1_000_000)) die(`POOL_FEE / --fee 必须是 (0, 100] 之间的百分比，当前 "${opt.fee}"`)
let spacing = opt.spacing ? Number(opt.spacing) : Math.max(1, Math.round(fee / 50))
if (!(Number.isInteger(spacing) && spacing >= 1 && spacing <= 32767)) die(`TICK_SPACING / --spacing 必须是 [1, 32767] 的整数，当前 "${opt.spacing}"`)
if (!['auto', 'exact'].includes(opt['pool-select'])) die('POOL_SELECT / --pool-select 只能是 auto 或 exact')
// 区间写法：两个百分比 "-50%,+100%"（也接受空格 / ~ / " - " 分隔）；只写一个则是单边：负数 = 现价往下，正数 = 现价往上
const rangePct = (opt.range.match(/[+-]?\d+(\.\d+)?/g) ?? []).map(Number)
if (rangePct.length === 1) rangePct.push(0)
if (rangePct.length !== 2 || rangePct[0] === rangePct[1]) die(`RANGE / --range 写法：-50%,+100%（双边）、-50%（只做下方）、+100%（只做上方），当前 "${opt.range}"`)
const [pLo, pHi] = [Math.min(...rangePct), Math.max(...rangePct)]
if (pLo <= -100) die('RANGE 下限必须大于 -100%')
const [mLo, mHi] = [1 + pLo / 100, 1 + pHi / 100] // 代币价格倍数
// 绝对价格区间（USDG/代币）：设置了就用它，不看 RANGE
const priceRange = (opt['price-range'].match(/\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number)
if (opt['price-range'] && (priceRange.length !== 2 || !(priceRange[0] > 0) || !(priceRange[1] > priceRange[0]))) die(`PRICE_RANGE / --price-range 写法：最低价,最高价（USDG/代币），如 0.006,0.01，当前 "${opt['price-range']}"`)
const rangeLabel = priceRange.length ? `${priceRange[0]} .. ${priceRange[1]} USDG` : `${pLo > 0 ? '+' : ''}${pLo}% .. ${pHi > 0 ? '+' : ''}${pHi}%`
const swapSlippage = Number(opt.slippage), lpSlippage = Number(opt['lp-slippage'])
if (!(swapSlippage >= 0 && swapSlippage <= 50 && lpSlippage >= 0 && lpSlippage <= 50)) die('滑点必须是 [0, 50] 之间的百分比')
const maxDev = Number(opt['max-deviation']) / 100
if (!(maxDev > 0 && maxDev < 1)) die('MAX_DEVIATION / --max-deviation 必须是 (0, 100) 之间的百分比')
const dryRun = opt['dry-run']

const clients = makeClients(opt.from, !dryRun)
const { wallet, pub, wc } = clients
const balanceOf = (t: Address) => pub.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })
const slot0 = (id: Hex) => pub.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [id] })

// ---- 钱包 / 代币 / 余额 / 池子（一次批量读取）----
let key = v4.makePoolKey(USDG, token, fee, spacing)
let id = v4.poolId(key)
let [{ symbol, name, decimals }, usdgStart, ethBal, tokenStart, ethPrice, poolSlot] = await Promise.all([
  tokenMeta(pub, token), balanceOf(USDG), pub.getBalance({ address: wallet }), balanceOf(token), ethPriceUsd(pub), slot0(id),
])
const usd = (wei: bigint) => (Number(formatEther(wei)) * ethPrice).toFixed(2)
const fmtU = (x: bigint) => trim(x, 6), fmtT = (x: bigint) => trim(x, decimals)
const symOf = (t: Address) => (t === USDG ? 'USDG' : symbol)
// 买币报价：Uniswap 和 OKX 同时问，取产出多的；Uniswap 常常只认一个薄池报不出大单，OKX 能找到更深的路
const swapDeps = { uni: uniswapApi(wallet, swapSlippage), okx: okxDex(wallet, swapSlippage), via: env('SWAP_VIA', 'best'), fmtOut: (x: bigint) => trim(x, decimals), outSym: symbol }
const buyOffers = (type: 'EXACT_INPUT' | 'EXACT_OUTPUT', amount: bigint) => swapOffers(swapDeps, USDG, token, type, amount)
async function bestBuy(amount: bigint, what: string) {
  const [o] = await buyOffers('EXACT_INPUT', amount)
  if (!o) die(`${what}：Uniswap 和 OKX 都找不到能吃下 ${fmtU(amount)} USDG 的路由（代币流动性太薄），把 USDG_AMOUNT 调小再试`)
  return o
}
log(`钱包 ${wallet} | ${fmtU(usdgStart)} USDG, ${trim(ethBal, 18)} ETH | ETH $${ethPrice.toFixed(2)}`)
log(`代币 ${symbol} (${name}) 精度=${decimals} 地址 ${token}`)
// 本次已花掉的 USDG（卖币收回则为负）和手里的代币。钱包里原有的代币（比如上次换完币没组成 LP）一并计入，
// 按市场价折成 USDG 从预算里扣掉（见下方"计划"处），重跑时就不会再换一遍
const holdings = async () => { const [u, t] = await Promise.all([balanceOf(USDG), balanceOf(token)]); return { spent: usdgStart - u, held: t } }

const tokenIs1 = key.currency1 === token
const [dec0, dec1] = tokenIs1 ? [6, decimals] : [decimals, 6]
const [sym0, sym1] = tokenIs1 ? ['USDG', symbol] : [symbol, 'USDG']
// 池子原始价格（currency1 基础单位 / currency0 基础单位）<-> 每个代币多少 USDG
const usdgPerTokenAtTick = (t: number) => { const h = v4.priceAtTick(t) * 10 ** (dec0 - dec1); return tokenIs1 ? 1 / h : h }
const tickFromProbe = (tokenOutPer1Usdg: bigint) => v4.tickFromPrice(tokenIs1 ? Number(tokenOutPer1Usdg) / 1e6 : 1e6 / Number(tokenOutPer1Usdg))
const tokensForUsdg = (usdgBase: bigint, usdgPerToken: number) => BigInt(Math.floor((Number(usdgBase) / usdgPerToken) * 10 ** (decimals - 6)))
const price = (t: number) => `${p6(usdgPerTokenAtTick(t))} USDG/${symbol}`
const deviation = (poolTick: number, marketTick: number) => usdgPerTokenAtTick(poolTick) / usdgPerTokenAtTick(marketTick) - 1 // 池价相对市场价
let [sqrtP, tick] = poolSlot
let initialized = sqrtP !== 0n
// 配置的池不存在：看看这个币已有哪些 USDG 池。同费率的直接复用（间距以链上为准）；否则选流动性够、成交量最大的；都没有才新建
if (!initialized && opt['pool-select'] === 'auto') {
  const pools = (await discoverUsdgPools(token)).sort((a, b) => b.volume24h - a.volume24h)
  const usd$ = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`
  if (pools.length) log(`已有 ${symbol}/USDG 池: ${pools.slice(0, 4).map((p) => `${p.fee / 10000}%/${p.spacing} 流动性${usd$(p.liquidityUsd)} 日成交${usd$(p.volume24h)}`).join('；')}${pools.length > 4 ? '…' : ''}`)
  const minLiq = Math.max(5000, Number(fmtU(usdgBudget)))
  const pick = pools.find((p) => p.fee === fee) ?? pools.find((p) => p.liquidityUsd >= minLiq)
  if (pick) {
    ;[fee, spacing, key, id] = [pick.fee, pick.spacing, v4.makePoolKey(USDG, token, pick.fee, pick.spacing), pick.id]
    ;[sqrtP, tick] = await slot0(id)
    initialized = sqrtP !== 0n
    log(`复用 ${pick.name}（${pick.fee / 10000}%/${pick.spacing}${pick.fee !== Math.round(Number(opt.fee) * 10_000) ? '，与配置的费率不同，成交最活跃' : '，同费率'}）；只想用自己配置的费率请设 POOL_SELECT=exact`)
  }
}
log(`池子 ${symbol}/USDG 费率=${fee / 10000}% 间距=${spacing}: ${initialized ? `已存在，tick ${tick} = ${price(tick)}` : '不存在，将创建'}`)

// ---- 区间 ----
// 代币价格 × m  <=>  代币是 currency0 时原始价格 × m，是 currency1 时原始价格 ÷ m
const tickDelta = (m: number) => Math.log(m) / Math.log(1.0001)
const [dLo, dHi] = tokenIs1 ? [-tickDelta(mHi), -tickDelta(mLo)] : [tickDelta(mLo), tickDelta(mHi)]
// USDG/代币 的价格 -> 池子 tick（usdgPerTokenAtTick 的反函数）
const tickAtUsdgPerToken = (p: number) => v4.tickFromPrice((tokenIs1 ? 1 / p : p) * 10 ** (dec1 - dec0))
// 远端边界向外取整（保证覆盖要求的范围）；0% 那条边向内取整（单边仓位不包含现价，保持纯单边）
const rangeFor = (t: number) => {
  let lo: number, hi: number
  if (priceRange.length) {
    // 绝对价格：两端向外取整；若本来整体在现价一侧、取整后却跨过了现价，把靠近现价的那端收回一格，保持纯单边
    const ticks = priceRange.map(tickAtUsdgPerToken).sort((a, b) => a - b)
    ;[lo, hi] = [v4.floorToSpacing(ticks[0], spacing), v4.ceilToSpacing(ticks[1], spacing)]
    if (ticks[1] < t && hi > t) hi -= spacing
    if (ticks[0] > t && lo <= t) lo += spacing
  } else {
    lo = dLo === 0 ? v4.ceilToSpacing(t + 1, spacing) : v4.floorToSpacing(t + dLo, spacing)
    hi = dHi === 0 ? v4.floorToSpacing(t, spacing) : v4.ceilToSpacing(t + dHi, spacing)
  }
  if (hi <= lo) die(`区间 ${rangeLabel} 不足一个 tick 间距（${spacing}），请放宽区间或减小 TICK_SPACING`)
  if (lo < v4.MIN_TICK || hi > v4.MAX_TICK) die(`区间 ${rangeLabel} 超出可用价格范围`)
  return [lo, hi] as const
}
const rangeText = ([lo, hi]: readonly [number, number]) => {
  const [a, b] = [usdgPerTokenAtTick(lo), usdgPerTokenAtTick(hi)].sort((x, y) => x - y)
  return `ticks [${lo}, ${hi}] = ${p6(a)} .. ${p6(b)} USDG/${symbol} (${rangeLabel})`
}
// 在 tick t 处、区间 [lo, hi] 组 LP 时，每个代币基础单位需要搭配多少 USDG 基础单位（Infinity = 只要 USDG，0 = 只要代币）
function usdgPerTokenNeeded(t: number, lo: number, hi: number) {
  const sp = Math.sqrt(v4.priceAtTick(t)), sa = Math.sqrt(v4.priceAtTick(lo)), sb = Math.sqrt(v4.priceAtTick(hi))
  const a0 = sp >= sb ? 0 : (sb - Math.max(sp, sa)) / (Math.max(sp, sa) * sb) // 每单位流动性需要的 currency0
  const a1 = sp <= sa ? 0 : Math.min(sp, sb) - sa                             // 每单位流动性需要的 currency1
  return tokenIs1 ? a0 / a1 : a1 / a0
}
// 预算拆分：已持有 held 个代币、按市场汇率 rate（代币基础单位 / USDG 基础单位）换币，换多少 USDG 能让 mint 两边刚好用尽
function swapShare(budget: bigint, held: bigint, refTick: number, rate: number) {
  const need = usdgPerTokenNeeded(refTick, ...rangeFor(refTick))
  if (need === Infinity) return 0n   // 区间全在现价下方：只要 USDG
  if (need === 0) return budget      // 区间全在现价上方：只要代币
  const s = (Number(budget) - need * Number(held)) / (1 + need * rate)
  return s <= 0 ? 0n : s >= Number(budget) ? budget : BigInt(Math.floor(s))
}

// ---- 池价校正：池价偏离市场价超过阈值时，直接在这个池里交易把价格推回市场价 ----
// 方案 A（swap）：当前 tick 附近流动性够用 —— 按恒定流动性算出精确投入量，用 Quoter 真实模拟核对（走不通就二分缩量）
// 方案 B（bridge）：池价到市场价之间没有流动性 —— 先建一个很小的单边"过渡仓位"覆盖这段空隙，再通过它做精确输出 swap 把价格推到市场价
type Correction =
  | { kind: 'swap'; dev: number; devAfter: number; zeroForOne: boolean; amountIn: bigint; minOut: bigint; sqrtNext: bigint }
  | { kind: 'bridge'; dev: number; zeroForOne: boolean; lo: number; hi: number; liquidity: bigint; need0: bigint; need1: bigint; exactOut: bigint; maxIn: bigint; sqrtNext: bigint }
async function planCorrection(marketTick: number, marketPrice: number): Promise<Correction | null> {
  const [[sp, t, protocolFee, lpFee], L] = await Promise.all([slot0(id), pub.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getLiquidity', args: [id] })])
  const dev = deviation(t, marketTick)
  if (Math.abs(dev) <= maxDev) return null
  const sqrtT = v4.getSqrtRatioAtTick(marketTick)
  const zeroForOne = sqrtT < sp
  const pf = zeroForOne ? protocolFee & 0xfff : protocolFee >> 12
  const swapFee = BigInt(pf + lpFee - Math.floor((pf * lpFee) / 1_000_000)) // pips，v4 的 calculateSwapFee
  const gross = (net: bigint) => (net * 1_000_000n + 1_000_000n - swapFee - 1n) / (1_000_000n - swapFee) // 加上手续费的实际投入

  // 方案 A
  if (L > 0n) {
    const simulate = async (net: bigint) => { // Quoter 真实模拟；null = 走不通（流动性用尽，或与恒定流动性模型差超过 1%）
      const { out } = v4.swapConstantL(L, sp, zeroForOne, { amountInNet: net })
      try {
        const [quoted] = await pub.readContract({ address: QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne, exactAmount: gross(net), hookData: '0x' }] })
        return Math.abs(Number(quoted) / Number(out) - 1) <= 0.01 ? quoted : null
      } catch (e: any) { if (e?.name === 'ContractFunctionExecutionError') return null; throw e }
    }
    const target = v4.swapConstantL(L, sp, zeroForOne, { sqrtTarget: sqrtT }).amountInNet
    let lo = 0n, hi = target, best: { net: bigint; quoted: bigint } | null = null
    for (let i = 0; i < 12 && hi - lo > target / 50n; i++) { // 先试全量，不行就二分（2% 精度）
      const net = i === 0 ? target : (lo + hi) / 2n
      const quoted = await simulate(net)
      if (quoted !== null) { best = { net, quoted }; lo = net; if (net === target) break } else hi = net
    }
    if (best) {
      const sqrtNext = v4.swapConstantL(L, sp, zeroForOne, { amountInNet: best.net }).sqrtNext
      const devAfter = deviation(v4.tickFromPrice(v4.priceFromSqrtX96(sqrtNext)), marketTick)
      if (Math.abs(devAfter) <= maxDev) return { kind: 'swap', dev, devAfter, zeroForOne, amountIn: gross(best.net), minOut: (best.quoted * 995n) / 1000n, sqrtNext }
    }
  }

  // 方案 B：过渡仓位在当前 tick 的一侧、覆盖到市场 tick；价格往下走(zeroForOne)时它只装 currency1，往上走时只装 currency0
  const [lo, hi] = zeroForOne ? [v4.floorToSpacing(marketTick, spacing), v4.floorToSpacing(t, spacing)] : [v4.ceilToSpacing(t + 1, spacing), v4.ceilToSpacing(marketTick, spacing)]
  if (hi <= lo) die(`池价偏离市场价 ${pct(dev)}，但差距不足一个 tick 间距（${spacing}），无法用过渡仓位校正，放弃`)
  const value = usdgBudget / 100n > 200_000n ? usdgBudget / 100n : 200_000n // 过渡仓位价值：预算 1%，至少 0.2 USDG
  const bridgeCurrency = zeroForOne ? key.currency1 : key.currency0
  const amount = bridgeCurrency === USDG ? value : tokensForUsdg(value, marketPrice)
  const sqrtA = v4.getSqrtRatioAtTick(lo), sqrtB = v4.getSqrtRatioAtTick(hi)
  const liquidity = v4.liquidityForAmounts(sp, sqrtA, sqrtB, zeroForOne ? 0n : amount, zeroForOne ? amount : 0n)
  if (liquidity === 0n) die('过渡仓位流动性为 0，放弃')
  const [need0, need1] = v4.amountsForLiquidity(sp, sqrtA, sqrtB, liquidity)
  // 精确输出 = 过渡仓位在市场价与靠近现价一端之间的那部分币；把它全买走，价格就停在市场价
  const exactOut = zeroForOne ? v4.amount1Delta(sqrtT, sqrtB, liquidity, false) : v4.amount0Delta(sqrtA, sqrtT, liquidity, false)
  const maxIn = (gross(zeroForOne ? v4.amount0Delta(sqrtT, sqrtB, liquidity, true) : v4.amount1Delta(sqrtA, sqrtT, liquidity, true)) * 103n) / 100n
  if (exactOut === 0n) die('过渡仓位太小，放弃')
  return { kind: 'bridge', dev, zeroForOne, lo, hi, liquidity, need0, need1, exactOut, maxIn, sqrtNext: sqrtT }
}
// 校正需要临时占用的 USDG（要卖代币的话先按市价买入，按市场价折算）
const correctionCost = (c: Correction, marketPrice: number) => {
  const usdgOf = (x: bigint, cur: Address) => (cur === USDG ? x : BigInt(Math.ceil(Number(x) * marketPrice * 10 ** (6 - decimals))))
  const cin = c.zeroForOne ? key.currency0 : key.currency1
  return c.kind === 'swap' ? usdgOf(c.amountIn, cin) : usdgOf(c.need0, key.currency0) + usdgOf(c.need1, key.currency1) + usdgOf(c.maxIn, cin)
}
const correctionText = (c: Correction) => {
  const [cin, cout] = c.zeroForOne ? [key.currency0, key.currency1] : [key.currency1, key.currency0]
  const f = (x: bigint, cur: Address) => `${trim(x, cur === USDG ? 6 : decimals)} ${symOf(cur)}`
  const head = `池价偏离 ${pct(c.dev)} 超过 ${maxDev * 100}%，`
  if (c.kind === 'swap') return head + `先在池内卖出 ≈${f(c.amountIn, cin)} 换 ≈${f(c.minOut, cout)}，把偏离拉到 ${pct(c.devAfter)}`
  const held = c.zeroForOne ? f(c.need1, key.currency1) : f(c.need0, key.currency0)
  return head + `池内到市场价之间没有流动性：先建 ≈${held} 的过渡仓位 [${c.lo}, ${c.hi}]，再通过它用最多 ${f(c.maxIn, cin)} 买回 ${f(c.exactOut, cout)}，把价格推到市场价`
}

// ---- 计划 ----
const probe = await bestBuy(1_000_000n, '探测市场价') // 1 USDG 探测市场价
let marketTick = tickFromProbe(probe.out)
let marketPrice = usdgPerTokenAtTick(marketTick)
const rate = Number(probe.out) / 1e6
log(`市场价 ${p6(marketPrice)} USDG/${symbol}（${probe.via}）${initialized ? `，池价偏离 ${pct(deviation(tick, marketTick))}` : ''}`)
// 钱包原有代币按市场价折算，算作预算里已经换好的那部分；超过预算就只用预算能装下的那部分（其余留在钱包），USDG 一侧按配比从钱包出
let usdgSpend = usdgBudget // 本次可动用的 USDG（换币 + LP）
let tokenCap = false       // 持有代币超过预算：组 LP 时代币侧按预算截断
const tokenPart = (t: number) => { // 预算在 tick t 的区间配比下，代币侧应占多少（基础单位）
  const need = usdgPerTokenNeeded(t, ...rangeFor(t)), p = 1 / rate // p = 每个代币基础单位值多少 USDG 基础单位
  return need === Infinity ? 0n : BigInt(Math.floor(Number(usdgBudget) / (p + need)))
}
if (tokenStart > 0n) {
  const heldValue = BigInt(Math.ceil(Number(tokenStart) / rate))
  if (heldValue >= usdgBudget) {
    tokenCap = true
    const t = tokenPart(initialized ? tick : marketTick)
    usdgSpend = usdgBudget - BigInt(Math.ceil(Number(t) / rate))
    log(`钱包已有 ${fmtT(tokenStart)} ${symbol}（≈${fmtU(heldValue)} USDG）超过预算 ${fmtU(usdgBudget)}：只投入 ≈${fmtT(t)} ${symbol} + ≈${fmtU(usdgSpend)} USDG，其余留在钱包，不换币`)
  } else {
    usdgSpend = usdgBudget - heldValue
    log(`钱包已有 ${fmtT(tokenStart)} ${symbol}（≈${fmtU(heldValue)} USDG），计入本次 LP，剩余 USDG 预算 ${fmtU(usdgSpend)}`)
  }
}
if (usdgStart < usdgSpend) {
  const msg = `需要 ${fmtU(usdgSpend)} USDG，钱包只有 ${fmtU(usdgStart)}`
  dryRun ? log(`警告: ${msg}`) : die(msg)
}
const correction = initialized ? await planCorrection(marketTick, marketPrice) : null
if (correction) {
  if (correctionCost(correction, marketPrice) > usdgSpend) die(`池价偏离市场价 ${pct(correction.dev)}，校正约需 ${fmtU(correctionCost(correction, marketPrice))} USDG，超过预算，放弃`)
  log(`计划: ${correctionText(correction)}`)
}
const refTick = correction ? v4.tickFromPrice(v4.priceFromSqrtX96(correction.sqrtNext)) : initialized ? tick : marketTick
const estSwap = swapShare(usdgSpend, tokenStart, refTick, rate)
// 用真实数量报一次价：找不到路、或大单冲击太大，都在确认前拦住
let planOffer: SwapOffer | null = null
if (estSwap > 0n) {
  planOffer = await bestBuy(estSwap, '换币')
  const impact = Number(planOffer.out) / Number(estSwap) / rate - 1
  if (impact < -0.2) die(`换 ${fmtU(estSwap)} USDG 的价格冲击 ${pct(impact)}（流动性太薄），把 USDG_AMOUNT 调小再试`)
  if (impact < -0.05) log(`警告: 换 ${fmtU(estSwap)} USDG 的价格冲击 ${pct(impact)}`)
}
log(`计划: ${planOffer ? `换币 ≈${fmtU(estSwap)} USDG -> ${planOffer.text}` : '无需换币'}，LP ≈${fmtU(usdgSpend - estSwap)} USDG + ${tokenCap ? '预算内的' : tokenStart > 0n ? '手里全部的' : '全部拿到的'} ${symbol}${correction ? '（校正开销另计）' : ''}`)
log(`计划: 区间 ${rangeText(rangeFor(refTick))}，滑点 换币 ${swapSlippage}% / LP ${lpSlippage}%`)
if (dryRun) { log('演练模式，到此为止'); await sleep(100); process.exit(0) } // 稍等让批量请求的句柄关闭，避免 Windows 上退出时的 libuv 断言
if (!opt.yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ans = await rl.question('确认执行? (y/N) ')
  rl.close()
  if (ans.trim().toLowerCase() !== 'y') die('已取消')
}

// ---- 交易 ----
const kit = txKit(clients, usd, symOf)
const { sendEstimated, ensureErc20Approval, permitFor, stats } = kit
const buy = (o: SwapOffer, label: string) => executeSwap(o, swapDeps, kit, clients, USDG, token, label)
// 手里的代币不够 need 时按市价买齐：先试 Uniswap 精确输出；不行就按市场价折算投入量走精确输入（OKX），不够再按比例加量
async function ensureTokens(need: bigint, label: string) {
  const short = need - (await holdings()).held
  if (short <= 0n) return
  let [o] = await buyOffers('EXACT_OUTPUT', short)
  let amountIn = BigInt(Math.ceil((Number(short) / 10 ** decimals) * marketPrice * 1e6 * 1.05))
  for (let i = 0; !o && i < 3; i++) {
    const [x] = await buyOffers('EXACT_INPUT', amountIn)
    if (!x) break
    if (x.out >= short) o = x; else amountIn = (amountIn * short * 103n) / (x.out * 100n)
  }
  if (!o) die(`买不到 ${fmtT(short)} ${symbol}（找不到路由）`)
  log(`换币完成: 拿到 ${fmtT(await buy(o, label))} ${symbol}`)
}
// PositionManager.multicall([permit…, initializePool?, modifyLiquidities(MINT)])，返回仓位 id 并记录到 positions.json；本次建的仓位 id 都收进 minted 供 --watch 只盯自己的
const minted: bigint[] = []
async function mint(label: string, kind: 'lp' | 'bridge', lo: number, hi: number, liquidity: bigint, max0: bigint, max1: bigint, init?: bigint) {
  const calls: Hex[] = []
  for (const [cur, max] of [[key.currency0, max0], [key.currency1, max1]] as const) {
    if (max === 0n) continue
    await ensureErc20Approval(cur, max)
    const p = await permitFor(cur, POSM, max)
    if (p) calls.push(encodeFunctionData({ abi: posmAbi, functionName: 'permit', args: [wallet, p.permitSingle, p.signature] }))
  }
  const unlockData = v4.encodeMintUnlockData(key, lo, hi, liquidity, max0, max1, wallet)
  if (init) calls.push(encodeFunctionData({ abi: posmAbi, functionName: 'initializePool', args: [key, init] }))
  calls.push(encodeFunctionData({ abi: posmAbi, functionName: 'modifyLiquidities', args: [unlockData, BigInt(now() + 600)] }))
  const rc = await sendEstimated(label, { to: POSM, data: encodeFunctionData({ abi: posmAbi, functionName: 'multicall', args: [calls] }) })
  const positionId = parseEventLogs({ abi: posmAbi, eventName: 'Transfer', logs: rc.logs }).find((l) => l.address.toLowerCase() === POSM.toLowerCase())?.args.id
  if (positionId !== undefined) { minted.push(positionId); savePosition({ id: positionId.toString(), token, symbol, poolId: id, kind, at: new Date().toISOString() }) }
  return { rc, positionId }
}
const withHeadroom = (x: bigint, avail: bigint) => min((x * BigInt(Math.round((100 + lpSlippage) * 100))) / 10_000n, avail)

// 1) 池价校正（最多 3 轮，每轮重新探测市场价）
if (correction) {
  for (let round = 1; ; round++) {
    if (round > 1) { marketTick = tickFromProbe((await bestBuy(1_000_000n, '探测市场价')).out); marketPrice = usdgPerTokenAtTick(marketTick) }
    const c = round === 1 ? correction : await planCorrection(marketTick, marketPrice)
    if (!c) { log(`池价偏离 ${pct(deviation(tick, marketTick))}，已在阈值内`); break }
    if (round > 3) die(`3 轮校正后池价仍偏离 ${pct(c.dev)}，放弃`)
    if (correctionCost(c, marketPrice) > usdgSpend - (await holdings()).spent) die(`校正约需 ${fmtU(correctionCost(c, marketPrice))} USDG，超过剩余预算，放弃`)
    const [cin, cout] = c.zeroForOne ? [key.currency0, key.currency1] : [key.currency1, key.currency0]
    const fmt = (x: bigint, cur: Address) => `${trim(x, cur === USDG ? 6 : decimals)} ${symOf(cur)}`
    if (c.kind === 'bridge') {
      const tokenNeed = tokenIs1 ? c.need1 : c.need0
      if (tokenNeed > 0n) await ensureTokens(tokenNeed, `买入 ${symbol} 用于过渡仓位`)
      const { positionId } = await mint(`过渡仓位 [${c.lo}, ${c.hi}]`, 'bridge', c.lo, c.hi, c.liquidity, c.need0, c.need1)
      log(`过渡仓位 id ${positionId ?? '?'}（用完即弃，撤退时一并回收）`)
    }
    const maxIn = c.kind === 'swap' ? c.amountIn : c.maxIn
    if (cin === token) await ensureTokens(maxIn, `买入 ${symbol} 用于校正`)
    await ensureErc20Approval(cin, maxIn)
    const amount = c.kind === 'swap' ? { exactIn: c.amountIn, minOut: c.minOut } : { exactOut: c.exactOut, maxIn: c.maxIn }
    const data = v4.encodeV4SwapCalldata(key, c.zeroForOne, amount, BigInt(now() + 600), await permitFor(cin, UR, maxIn))
    const label = c.kind === 'swap' ? `校正池价 (卖出 ${fmt(c.amountIn, cin)})` : `校正池价 (买回 ${fmt(c.exactOut, cout)})`
    await sendEstimated(label, { to: UR, data })
    ;[sqrtP, tick] = await slot0(id)
    log(`池价 tick ${tick} = ${price(tick)}，偏离市场价 ${pct(deviation(tick, marketTick))}`)
    if (Math.abs(deviation(tick, marketTick)) <= maxDev) break
  }
}

// 2) 按市价换币：先按探测汇率算份额报价（计划阶段的报价没过期就直接用）；大单实际汇率与探测价有差（价格冲击）就按新汇率重算再报一次，减少 LP 配比失衡留下的剩余
let { spent, held } = await holdings()
let budgetLeft = usdgSpend - spent
if (budgetLeft > 0n) {
  const ref = initialized ? tick : marketTick
  let swapAmount = swapShare(budgetLeft, held, ref, rate)
  if (swapAmount > 0n) {
    let o = planOffer && planOffer.amountIn === swapAmount && Date.now() - planOffer.at < 20_000 ? planOffer : await bestBuy(swapAmount, '换币')
    const resized = swapShare(budgetLeft, held, ref, Number(o.out) / Number(o.amountIn))
    if (abs(resized - swapAmount) > swapAmount / 200n) { swapAmount = resized; o = await bestBuy(swapAmount, '换币') } // 差 0.5% 以上就按大单实际汇率重算
    const got = await buy(o, '换币')
    log(`换币完成: ${fmtU(swapAmount)} USDG -> ${fmtT(got)} ${symbol}`)
    ;({ spent, held } = await holdings())
    budgetLeft = usdgSpend - spent
  }
}
if (budgetLeft < 0n) budgetLeft = 0n

// 3) LP 价格：池子已存在用池价（重新读取），否则用换币后的市场探测价作为新池初始价
// 换币本身会把池价推开，套利者随后又拉回来；按瞬时价算的流动性到上链时可能超出 amountMax（MaximumAmountExceeded），
// 遇到就重读池价、按手里的币重算再试
const f0 = (x: bigint) => trim(x, dec0), f1 = (x: bigint) => trim(x, dec1)
let mintResult: Awaited<ReturnType<typeof mint>> | undefined
for (let attempt = 1; !mintResult; attempt++) {
  ;[sqrtP, tick] = await slot0(id)
  initialized = sqrtP !== 0n
  if (initialized) {
    log(`LP 价格: 池 tick ${tick} = ${price(tick)}`)
  } else {
    tick = tickFromProbe((await bestBuy(1_000_000n, '探测市场价')).out)
    sqrtP = v4.getSqrtRatioAtTick(tick)
    log(`LP 价格: 新池初始价 tick ${tick} = ${price(tick)}（市场探测价）`)
  }
  const [tickLower, tickUpper] = rangeFor(tick)

  // 4) 由预算算流动性；amountMax = 实际扣款 + 余量，且不超过持有量（持有代币超过预算时代币侧按预算截断）
  const heldUse = tokenCap ? min(held, tokenPart(tick)) : held
  const [avail0, avail1] = tokenIs1 ? [budgetLeft, heldUse] : [heldUse, budgetLeft]
  const sqrtA = v4.getSqrtRatioAtTick(tickLower), sqrtB = v4.getSqrtRatioAtTick(tickUpper)
  const liquidity = v4.liquidityForAmounts(sqrtP, sqrtA, sqrtB, avail0, avail1)
  if (liquidity === 0n) die('算出的流动性为 0')
  const [amount0, amount1] = v4.amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity)
  const [max0, max1] = [withHeadroom(amount0, avail0), withHeadroom(amount1, avail1)]
  log(`组LP: ticks [${tickLower}, ${tickUpper}]，liquidity ${liquidity}，投入 ${f0(amount0)} ${sym0} + ${f1(amount1)} ${sym1}（上限 ${f0(max0)} / ${f1(max1)}），剩余 ${f0(avail0 - amount0)} ${sym0} + ${f1(avail1 - amount1)} ${sym1}`)

  // 5) 建池（如需）+ mint
  try {
    mintResult = await mint(initialized ? '组LP' : '建池+组LP', 'lp', tickLower, tickUpper, liquidity, max0, max1, initialized ? undefined : sqrtP)
  } catch (e) {
    const r = slippageRevert(e)
    if (r?.kind !== 'max' || attempt >= 5) throw e
    const cur = r.limit === max0 ? key.currency0 : key.currency1
    const f = cur === key.currency0 ? f0 : f1
    log(`组LP 回滚: 池价变动，需要 ${f(r.actual)} ${symOf(cur)} 超过上限 ${f(r.limit)}，等 3 秒按新池价重算（第 ${attempt} 次）`)
    await sleep(3000)
  }
}
const { rc: mintRc, positionId } = mintResult
log(`完成: 仓位 ${positionId ?? '?'}，池 ${id}（已记录到 positions.json，撤退: npm run exit -- --token ${token}）`)
log(`      ${EXPLORER}/tx/${mintRc.transactionHash}`)
log(`gas 合计: ${stats.txCount} 笔，${trim(stats.gasTotal, 18)} ETH ($${usd(stats.gasTotal)})`)

// 6) 可选：继续监控本次建的仓位，跳出区间自动撤退（同一代币的其他仓位不管，可以再开一个进程做别的区间）
if (opt.watch) await watchToken({
  token, positions: minted.length ? minted : undefined, clients, interval: Math.max(3, Number(env('WATCH_INTERVAL', '10'))), confirm: Math.max(1, Number(env('WATCH_CONFIRM', '2'))),
  upperGrace: Math.max(0, Number(env('WATCH_UPPER_GRACE', '600'))),
  via: env('EXIT_SWAP_VIA', 'best'), slippage: swapSlippage, lpSlippage, dryRun: false,
})
