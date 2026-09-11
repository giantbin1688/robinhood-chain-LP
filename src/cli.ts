// 进场：计价币 -> 代币换币（Uniswap API / OKX 聚合路由）、创建/复用池子、按现价区间组 LP。撤退见 exit.ts
// 链 / 协议由 --chain / --protocol（或 CHAIN / PROTOCOL 环境变量）决定：robinhood/v4、bsc/infinity、bsc/v3；链上细节都在 lp.ts 的适配器里
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { formatEther, getAddress, parseUnits, type Address, type Hex } from 'viem'
import * as v4 from './v4.ts'
import * as shapeMath from './shape.ts'
import { exactTickRange } from './tick-detail.ts'
import { abs, die, env, erc20Abi, failFast, feeText, log, makeClients, min, nativePriceUsd, now, num, p6, pct, savePosition, sleep, swapDepsFor, tokenMeta, trim, txKit, swapOffers, executeSwap, type SwapOffer } from './common.ts'
import type { MintSpec, Pool } from './lp.ts'
import { watchToken } from './monitor.ts'
import { discoverQuotePools } from './pools.ts'

failFast()

// 默认值来自 params.env，命令行参数可临时覆盖
const { values: opt } = parseArgs({
  options: {
    chain: { type: 'string' }, protocol: { type: 'string' },                 // 链 / 协议（common.ts 里解析）
    token: { type: 'string' },
    usdg: { type: 'string', default: env('USDG_AMOUNT', '25') },              // LP 总预算（计价币：USDG / USDT）
    fee: { type: 'string', default: env('POOL_FEE', '5') },                   // 池子费率 %
    spacing: { type: 'string', default: env('TICK_SPACING', '') },            // 留空 = 协议默认（v4/Infinity 为 fee/50，v3 固定四档）
    range: { type: 'string', default: env('RANGE', '-50%,+100%') },          // 区间：相对现价的百分比
    'price-range': { type: 'string', default: env('PRICE_RANGE', '') },      // 区间：绝对价格（计价币/代币）"最低价,最高价"，设置了就优先于 RANGE
    'tick-range': { type: 'string' }, // Robinhood v4：精确池 tick 边界，优先于价格 / 百分比，不经过价格取整
    slippage: { type: 'string', default: env('SWAP_SLIPPAGE', '5') },         // 换币滑点 %
    'lp-slippage': { type: 'string', default: env('LP_SLIPPAGE', '5') },      // mint amountMax 余量 %
    'max-deviation': { type: 'string', default: env('MAX_DEVIATION', '10') },// 池价与市场价最大偏离 %
    'pool-select': { type: 'string', default: env('POOL_SELECT', 'auto') },  // auto: 配置的池不存在时复用该币已有的计价币池；exact: 只用配置的费率/间距
    pool: { type: 'string', default: '' },          // 直接指定池 id（网页"用这个池"传来；带 hook 的池只能这样指定），费率/间距以链上为准，不看 --fee/--spacing/--pool-select
    shape: { type: 'string', default: env('LP_SHAPE', 'spot') },             // 流动性形状：spot 一个仓位 | curve 同心嵌套、越靠现价越厚 | bidask 两侧分段、越远越厚
    layers: { type: 'string', default: env('LP_LAYERS', '3') },              // curve 的层数 / bidask 每侧的段数
    watch: { type: 'boolean', default: false },     // 组完 LP 后继续监控，跳出区间自动撤退
    'stop-loss': { type: 'string', default: env('WATCH_STOP_LOSS', '0') }, // --watch 时：整组亏到本金的百分之几就撤（0 = 不开）
    yes: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },   // 只看计划，不发交易
    from: { type: 'string' },                         // --dry-run 时可用地址代替私钥
    json: { type: 'boolean', default: false },        // 计划确定后额外打印一行 "@@plan {json}" 给网页界面用
  },
})
if (!opt.token) die('用法: npm run launch -- [--chain robinhood|bsc|ethereum] [--protocol v4|infinity|v3] --token <地址> [--usdg 25] [--fee 5] [--spacing 1000] [--pool <池id>] [--range="-50%,+100%" | --price-range="0.006,0.01"] [--shape spot|curve|bidask] [--layers 3] [--slippage 5] [--lp-slippage 5] [--max-deviation 10] [--watch] [--yes] [--dry-run]')
const token = getAddress(opt.token)
const poolId = opt.pool.trim()
if (poolId && !/^0x[0-9a-fA-F]{40}$|^0x[0-9a-fA-F]{64}$/.test(poolId)) die(`--pool 必须是池 id（v4/Infinity 为 32 字节 hex，v3 为池地址），当前 "${opt.pool}"`)
let fee = Math.round(Number(opt.fee) * 10_000) // pips
if (!poolId && !(fee > 0 && fee <= 1_000_000)) die(`POOL_FEE / --fee 必须是 (0, 100] 之间的百分比，当前 "${opt.fee}"`)
if (!['auto', 'exact'].includes(opt['pool-select'])) die('POOL_SELECT / --pool-select 只能是 auto 或 exact')
const shape = opt.shape.toLowerCase().replace('-', '') as shapeMath.Shape
if (!['spot', 'curve', 'bidask'].includes(shape)) die(`LP_SHAPE / --shape 只能是 spot、curve 或 bidask，当前 "${opt.shape}"`)
const layers = Number(opt.layers)
if (!(Number.isInteger(layers) && layers >= 2 && layers <= 8)) die(`LP_LAYERS / --layers 必须是 [2, 8] 的整数，当前 "${opt.layers}"`)
const shapeLabel = { spot: 'spot（单个仓位）', curve: `curve（${layers} 层同心嵌套，越靠现价越厚）`, bidask: `bidask（现价两侧各 ${layers} 段，越远越厚）` }[shape]
// 区间写法：两个百分比 "-50%,+100%"（也接受空格 / ~ / " - " 分隔）；只写一个则是单边：负数 = 现价往下，正数 = 现价往上
const rangePct = (opt.range.match(/[+-]?\d+(\.\d+)?/g) ?? []).map(Number)
if (rangePct.length === 1) rangePct.push(0)
if (rangePct.length !== 2 || rangePct[0] === rangePct[1]) die(`RANGE / --range 写法：-50%,+100%（双边）、-50%（只做下方）、+100%（只做上方），当前 "${opt.range}"`)
const [pLo, pHi] = [Math.min(...rangePct), Math.max(...rangePct)]
if (pLo <= -100) die('RANGE 下限必须大于 -100%')
const [mLo, mHi] = [1 + pLo / 100, 1 + pHi / 100] // 代币价格倍数
// 绝对价格区间（计价币/代币）：设置了就用它，不看 RANGE
const priceRange = (opt['price-range'].match(/\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number)
if (opt['price-range'] && (priceRange.length !== 2 || !(priceRange[0] > 0) || !(priceRange[1] > priceRange[0]))) die(`PRICE_RANGE / --price-range 写法：最低价,最高价（计价币/代币），如 0.006,0.01，当前 "${opt['price-range']}"`)
const swapSlippage = num('SWAP_SLIPPAGE / --slippage', opt.slippage, 0, 50), lpSlippage = num('LP_SLIPPAGE / --lp-slippage', opt['lp-slippage'], 0, 50)
const maxDev = Number(opt['max-deviation']) / 100
if (!(maxDev > 0 && maxDev < 1)) die('MAX_DEVIATION / --max-deviation 必须是 (0, 100) 之间的百分比')
const dryRun = opt['dry-run']

const clients = await makeClients({ from: opt.from, needKey: !dryRun })
const { wallet, pub, cfg, lp, Q } = clients
const QU = 10n ** BigInt(Q.decimals) // 1 个计价币的基础单位
if (opt['tick-range'] && (cfg.name !== 'robinhood' || clients.protocol !== 'v4')) die('精确 tick 区间目前仅支持 Robinhood Uniswap v4')
const rangeLabel = opt['tick-range'] ? `ticks ${opt['tick-range']}` : priceRange.length ? `${priceRange[0]} .. ${priceRange[1]} ${Q.symbol}` : `${pLo > 0 ? '+' : ''}${pLo}% .. ${pHi > 0 ? '+' : ''}${pHi}%`
const usdgBudget = parseUnits(opt.usdg, Q.decimals)
if (usdgBudget <= 0n) die('USDG_AMOUNT / --usdg 必须大于 0')
let spacing = opt.spacing ? Number(opt.spacing) : lp.spacingFor(fee) ?? 0
if (opt.spacing && !(Number.isInteger(spacing) && spacing >= 1 && spacing <= 32767)) die(`TICK_SPACING / --spacing 必须是 [1, 32767] 的整数，当前 "${opt.spacing}"`)
const balanceOf = (t: Address) => pub.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })

// ---- 钱包 / 代币 / 余额 / 池子（一次批量读取）----
// 指定了池 id 就直接反查 PoolKey（带 hook 的池只能这样找到），费率/间距以链上为准；
// 否则按配置的费率/间距。配置的费率这个协议不支持（v3 只有四档）：auto 模式下跳过它去找已有池，exact 模式直接报错
let pool: Pool | null = poolId
  ? await lp.poolById(poolId as Hex).then((p) => p ?? die(`池 ${poolId} 查不到 PoolKey（PositionManager 没记录，链上也没有它的 Initialize 事件）`))
  : await lp.pool(token, fee, spacing).catch((e) => (opt['pool-select'] === 'exact' ? die(String(e?.message)) : (log(`提示: ${String(e?.message)}，只看已有池`), null)))
if (poolId && pool) {
  const has = (a: Address) => [pool!.currency0, pool!.currency1].some((x) => x.toLowerCase() === a.toLowerCase())
  if (!has(token) || !has(Q.address)) die(`池 ${poolId} 不是 ${token} / ${Q.symbol} 池`)
  fee = pool.fee; spacing = pool.spacing
}
let [{ symbol, name, decimals }, usdgStart, ethBal, tokenStart, ethPrice, poolSlot] = await Promise.all([
  tokenMeta(pub, token), balanceOf(Q.address), pub.getBalance({ address: wallet }), balanceOf(token), nativePriceUsd(clients), pool ? lp.slot0(pool) : { sqrtP: 0n, tick: 0, protocolFee: 0, lpFee: 0 },
])
const usd = (wei: bigint) => (Number(formatEther(wei)) * ethPrice).toFixed(2)
const fmtU = (x: bigint) => trim(x, Q.decimals), fmtT = (x: bigint) => trim(x, decimals)
const symOf = (t: Address) => (t === Q.address ? Q.symbol : symbol)
// 买币报价：Uniswap、OKX 和要做 LP 的池（选定后填进 swapDeps.pools）同时问，取产出多的；Uniswap 常常只认一个薄池报不出大单，OKX 能找到更深的路，但它的多跳路线也虚报过
const swapDeps = swapDepsFor(clients, swapSlippage, env('SWAP_VIA', 'best'), (x: bigint) => trim(x, decimals), symbol)
if (!['best', 'okx', 'uniswap', 'pool'].includes(swapDeps.via)) die('SWAP_VIA 只能是 best / okx / uniswap / pool')
const buyOffers = (type: 'EXACT_INPUT' | 'EXACT_OUTPUT', amount: bigint, external = false) => swapOffers(swapDeps, Q.address, token, type, amount, { external })
// external = 探测市场价：只问聚合器，别拿池子自己当市场
async function bestBuy(amount: bigint, what: string, external = false) {
  const offers = await buyOffers('EXACT_INPUT', amount, external)
  const [o] = offers
  if (!o) die(`${what}：Uniswap、OKX${external ? '' : ' 和池内'}都找不到能吃下 ${fmtU(amount)} ${Q.symbol} 的路由（代币流动性太薄），把 USDG_AMOUNT 调小再试`)
  if (!external && offers.length > 1) log(`${what}报价: ${offers.map((x) => x.text).join('；')}`)
  return o
}
log(`${cfg.label} / ${lp.label} | 钱包 ${wallet} | ${fmtU(usdgStart)} ${Q.symbol}, ${trim(ethBal, 18)} ${cfg.native.symbol} | ${cfg.native.symbol} $${ethPrice.toFixed(2)}`)
log(`代币 ${symbol} (${name}) 精度=${decimals} 地址 ${token}`)
// 本次已花掉的计价币（卖币收回则为负）和手里的代币。钱包里原有的代币（比如上次换完币没组成 LP）一并计入，
// 按市场价折成计价币从预算里扣掉（见下方"计划"处），重跑时就不会再换一遍
const holdings = async () => { const [u, t] = await Promise.all([balanceOf(Q.address), balanceOf(token)]); return { spent: usdgStart - u, held: t } }

let [sqrtP, tick] = [poolSlot.sqrtP, poolSlot.tick]
let initialized = sqrtP !== 0n
if (initialized && (tick <= v4.MIN_TICK || tick >= v4.MAX_TICK)) {
  die(`池子处于不可用边界 tick ${tick}；请更换 fee/spacing 创建新池，或先在原池补回覆盖现价的流动性`)
}
// 配置的池不存在：看看这个币已有哪些计价币池。同费率的直接复用（间距以链上为准）；否则选流动性够、成交量最大的；都没有才新建
if (!initialized && opt['pool-select'] === 'auto' && !poolId) {
  const pools = (await discoverQuotePools(clients, token)).sort((a, b) => b.volume24h - a.volume24h)
  const usd$ = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`
  if (pools.length) log(`已有 ${symbol}/${Q.symbol} 池: ${pools.slice(0, 4).map((p) => `${feeText(p.pool)}/${p.pool.spacing}${p.pool.hooks !== v4.ZERO_ADDRESS ? '(hook)' : ''} ${p.empty === null ? '流动性未知(读链失败)' : p.empty ? '空池' : `流动性${usd$(p.liquidityUsd)} 日成交${usd$(p.volume24h)}`}`).join('；')}${pools.length > 4 ? '…' : ''}`)
  const minLiq = Math.max(5000, Number(fmtU(usdgBudget)))
  // 空池不复用：复用要先花钱纠价，新建一个不同间距的池反而是免费的。流动性没读到的（empty=null）也不自动选，别拿真金白银赌一个未知状态
  const pick = pools.find((p) => p.empty === false && p.pool.fee === fee) ?? pools.find((p) => p.empty === false && p.liquidityUsd >= minLiq)
  if (pick) {
    pool = pick.pool; fee = pool.fee; spacing = pool.spacing
    ;({ sqrtP, tick } = await lp.slot0(pool))
    initialized = sqrtP !== 0n
    log(`复用 ${pick.name}（${feeText(pool)}/${spacing}${pick.pool.fee !== Math.round(Number(opt.fee) * 10_000) ? '，与配置的费率不同，成交最活跃' : '，同费率'}${pool.hooks !== v4.ZERO_ADDRESS ? `，带 hook ${pool.hooks}` : ''}）；只想用自己配置的费率请设 POOL_SELECT=exact`)
  }
}
if (!pool) die(`${symbol} 在 ${lp.label} 上没有可复用的 ${Q.symbol} 池，且配置的费率 ${opt.fee}% 建不了池（${lp.tiers.map((t) => t.fee / 10000 + '%').join(' / ')} 可选）`)
if (!(Number.isInteger(spacing) && spacing >= 1)) die('tick 间距无效')
if (initialized) swapDeps.pools = [pool] // 池已存在才有价可报；新建的池换币只能靠聚合器

const tokenIs1 = pool.currency1 === token
const [dec0, dec1] = tokenIs1 ? [Q.decimals, decimals] : [decimals, Q.decimals]
const [sym0, sym1] = tokenIs1 ? [Q.symbol, symbol] : [symbol, Q.symbol]
// 池子原始价格（currency1 基础单位 / currency0 基础单位）<-> 每个代币多少计价币
const usdgPerTokenAtTick = (t: number) => { const h = v4.priceAtTick(t) * 10 ** (dec0 - dec1); return tokenIs1 ? 1 / h : h }
const tickFromProbe = (tokenOutPer1Usdg: bigint) => v4.tickFromPrice(tokenIs1 ? Number(tokenOutPer1Usdg) / Number(QU) : Number(QU) / Number(tokenOutPer1Usdg))
const tokensForUsdg = (usdgBase: bigint, usdgPerToken: number) => BigInt(Math.floor((Number(usdgBase) / usdgPerToken) * 10 ** (decimals - Q.decimals)))
const price = (t: number) => `${p6(usdgPerTokenAtTick(t))} ${Q.symbol}/${symbol}`
const deviation = (poolTick: number, marketTick: number) => usdgPerTokenAtTick(poolTick) / usdgPerTokenAtTick(marketTick) - 1 // 池价相对市场价
log(`池子 ${symbol}/${Q.symbol} 费率=${feeText(pool)} 间距=${spacing}${pool.hooks !== v4.ZERO_ADDRESS ? ` hook=${pool.hooks}` : ''}${poolId ? '（按 id 指定）' : ''}: ${initialized ? `已存在，tick ${tick} = ${price(tick)}` : '不存在，将创建'}`)

// ---- 区间 ----
// 代币价格 × m  <=>  代币是 currency0 时原始价格 × m，是 currency1 时原始价格 ÷ m
const tickDelta = (m: number) => Math.log(m) / Math.log(1.0001)
const [dLo, dHi] = tokenIs1 ? [-tickDelta(mHi), -tickDelta(mLo)] : [tickDelta(mLo), tickDelta(mHi)]
// 计价币/代币 的价格 -> 池子 tick（usdgPerTokenAtTick 的反函数）
const tickAtUsdgPerToken = (p: number) => v4.tickFromPrice((tokenIs1 ? 1 / p : p) * 10 ** (dec1 - dec0))
// 远端边界向外取整（保证覆盖要求的范围）；0% 那条边向内取整（单边仓位不包含现价，保持纯单边）
const rangeFor = (t: number) => {
  if (opt['tick-range']) return exactTickRange(opt['tick-range'], spacing)
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
  return `ticks [${lo}, ${hi}] = ${p6(a)} .. ${p6(b)} ${Q.symbol}/${symbol} (${rangeLabel})`
}
// 形状 = 把一个区间拆成几个仓位（数学在 shape.ts，和 Solana 的 Raydium CLMM 共用），g 是各仓位的流动性权重
type Leg = shapeMath.Leg
function legsFor(t: number): Leg[] {
  const [lo, hi] = rangeFor(t)
  const legs = shapeMath.shapeLegs({ lo, hi, t, spacing, shape, layers, tokenIs1 })
  if (!legs.length) die(`区间 ${rangeLabel} 太窄，拆不出 ${shapeLabel} 的仓位`)
  return legs
}
const legSide = (l: Leg, t: number) => shapeMath.legSide(l, t, tokenIs1)
const legText = (l: Leg) => { const [a, b] = [usdgPerTokenAtTick(l.lo), usdgPerTokenAtTick(l.hi)].sort((x, y) => x - y); return `ticks [${l.lo}, ${l.hi}] = ${p6(a)} .. ${p6(b)}` }
// 每 1 计价币基础单位的预算要配多少代币基础单位（p = 每个代币基础单位值多少计价币基础单位）：0 = 只要计价币，1/p = 只要代币
const tokenPerUsdg = (t: number, p: number) => shapeMath.tokenPerUsdg(legsFor(t), t, p, tokenIs1)
// 预算拆分：已持有 held 个代币、按市场汇率 rate（代币基础单位 / 计价币基础单位）换币，换多少计价币能让各仓位 mint 后两边刚好用尽
function swapShare(budget: bigint, held: bigint, refTick: number, rate: number) {
  const p = 1 / rate
  const s = (tokenPerUsdg(refTick, p) * (Number(budget) + Number(held) * p) - Number(held)) * p
  return s <= 0 ? 0n : s >= Number(budget) ? budget : BigInt(Math.floor(s))
}

// ---- 池价校正：池价偏离市场价超过阈值时，直接在这个池里交易把价格推回市场价 ----
// 方案 A（swap）：当前 tick 附近流动性够用 —— 按恒定流动性算出精确投入量，用 Quoter 真实模拟核对（走不通就二分缩量）
// 方案 B（bridge）：池价到市场价之间没有流动性 —— 先建一个很小的单边"过渡仓位"覆盖这段空隙，再通过它做精确输出 swap 把价格推到市场价
type Correction =
  | { kind: 'swap'; dev: number; devAfter: number; zeroForOne: boolean; amountIn: bigint; minOut: bigint; sqrtNext: bigint }
  | { kind: 'bridge'; dev: number; zeroForOne: boolean; lo: number; hi: number; liquidity: bigint; need0: bigint; need1: bigint; exactOut: bigint; maxIn: bigint; sqrtNext: bigint }
async function planCorrection(marketTick: number, marketPrice: number): Promise<Correction | null> {
  const [s, L] = await Promise.all([lp.slot0(pool!), lp.liquidity(pool!)])
  const { sqrtP: sp, tick: t } = s
  const dev = deviation(t, marketTick)
  if (Math.abs(dev) <= maxDev) return null
  const sqrtT = v4.getSqrtRatioAtTick(marketTick)
  const zeroForOne = sqrtT < sp
  const swapFee = BigInt(lp.swapFee(s, zeroForOne, pool!)) // pips
  const gross = (net: bigint) => (net * 1_000_000n + 1_000_000n - swapFee - 1n) / (1_000_000n - swapFee) // 加上手续费的实际投入

  // 方案 A
  if (L > 0n) {
    const simulate = async (net: bigint) => { // Quoter 真实模拟；null = 走不通（流动性用尽，或与恒定流动性模型差超过 1%）
      const { out } = v4.swapConstantL(L, sp, zeroForOne, { amountInNet: net })
      try {
        const quoted = await lp.quoteExactIn(pool!, zeroForOne, gross(net))
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
  const value = usdgBudget / 100n > QU / 5n ? usdgBudget / 100n : QU / 5n // 过渡仓位价值：预算 1%，至少 0.2 个计价币
  const bridgeCurrency = zeroForOne ? pool!.currency1 : pool!.currency0
  const amount = bridgeCurrency === Q.address ? value : tokensForUsdg(value, marketPrice)
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
// 校正需要临时占用的计价币（要卖代币的话先按市价买入，按市场价折算）
const correctionCost = (c: Correction, marketPrice: number) => {
  const usdgOf = (x: bigint, cur: Address) => (cur === Q.address ? x : BigInt(Math.ceil(Number(x) * marketPrice * 10 ** (Q.decimals - decimals))))
  const cin = c.zeroForOne ? pool!.currency0 : pool!.currency1
  return c.kind === 'swap' ? usdgOf(c.amountIn, cin) : usdgOf(c.need0, pool!.currency0) + usdgOf(c.need1, pool!.currency1) + usdgOf(c.maxIn, cin)
}
const correctionText = (c: Correction) => {
  const [cin, cout] = c.zeroForOne ? [pool!.currency0, pool!.currency1] : [pool!.currency1, pool!.currency0]
  const f = (x: bigint, cur: Address) => `${trim(x, cur === Q.address ? Q.decimals : decimals)} ${symOf(cur)}`
  const head = `池价偏离 ${pct(c.dev)} 超过 ${maxDev * 100}%，`
  if (c.kind === 'swap') return head + `先在池内卖出 ≈${f(c.amountIn, cin)} 换 ≈${f(c.minOut, cout)}，把偏离拉到 ${pct(c.devAfter)}`
  const held = c.zeroForOne ? f(c.need1, pool!.currency1) : f(c.need0, pool!.currency0)
  return head + `池内到市场价之间没有流动性：先建 ≈${held} 的过渡仓位 [${c.lo}, ${c.hi}]，再通过它用最多 ${f(c.maxIn, cin)} 买回 ${f(c.exactOut, cout)}，把价格推到市场价`
}

// ---- 计划 ----
const probe = await bestBuy(QU, '探测市场价', true) // 1 个计价币探测市场价
let marketTick = tickFromProbe(probe.out)
let marketPrice = usdgPerTokenAtTick(marketTick)
const rate = Number(probe.out) / Number(QU)
log(`市场价 ${p6(marketPrice)} ${Q.symbol}/${symbol}（${probe.via}）${initialized ? `，池价偏离 ${pct(deviation(tick, marketTick))}` : ''}`)
// 钱包原有代币按市场价折算，算作预算里已经换好的那部分；超过预算就只用预算能装下的那部分（其余留在钱包），计价币一侧按配比从钱包出
let usdgSpend = usdgBudget // 本次可动用的计价币（换币 + LP）
let tokenCap = false       // 持有代币超过预算：组 LP 时代币侧按预算截断
const tokenPart = (t: number) => BigInt(Math.floor(tokenPerUsdg(t, 1 / rate) * Number(usdgBudget))) // 预算在 tick t 的形状配比下，代币侧应占多少（基础单位）
if (tokenStart > 0n) {
  const heldValue = BigInt(Math.ceil(Number(tokenStart) / rate))
  if (heldValue >= usdgBudget) {
    tokenCap = true
    const t = tokenPart(initialized ? tick : marketTick)
    usdgSpend = usdgBudget - BigInt(Math.ceil(Number(t) / rate))
    log(`钱包已有 ${fmtT(tokenStart)} ${symbol}（≈${fmtU(heldValue)} ${Q.symbol}）超过预算 ${fmtU(usdgBudget)}：只投入 ≈${fmtT(t)} ${symbol} + ≈${fmtU(usdgSpend)} ${Q.symbol}，其余留在钱包，不换币`)
  } else {
    usdgSpend = usdgBudget - heldValue
    log(`钱包已有 ${fmtT(tokenStart)} ${symbol}（≈${fmtU(heldValue)} ${Q.symbol}），计入本次 LP，剩余 ${Q.symbol} 预算 ${fmtU(usdgSpend)}`)
  }
}
if (usdgStart < usdgSpend) {
  const msg = `需要 ${fmtU(usdgSpend)} ${Q.symbol}，钱包只有 ${fmtU(usdgStart)}`
  dryRun ? log(`警告: ${msg}`) : die(msg)
}
const correction = initialized ? await planCorrection(marketTick, marketPrice) : null
if (correction) {
  if (correctionCost(correction, marketPrice) > usdgSpend) die(`池价偏离市场价 ${pct(correction.dev)}，校正约需 ${fmtU(correctionCost(correction, marketPrice))} ${Q.symbol}，超过预算，放弃`)
  log(`计划: ${correctionText(correction)}`)
}
const refTick = correction ? v4.tickFromPrice(v4.priceFromSqrtX96(correction.sqrtNext)) : initialized ? tick : marketTick
const estSwap = swapShare(usdgSpend, tokenStart, refTick, rate)
// 用真实数量报一次价：找不到路、或大单冲击太大，都在确认前拦住
let planOffer: SwapOffer | null = null
if (estSwap > 0n) {
  planOffer = await bestBuy(estSwap, '换币')
  const impact = Number(planOffer.out) / Number(estSwap) / rate - 1
  if (impact < -0.2) die(`换 ${fmtU(estSwap)} ${Q.symbol} 的价格冲击 ${pct(impact)}（流动性太薄），把 USDG_AMOUNT 调小再试`)
  if (impact < -0.05) log(`警告: 换 ${fmtU(estSwap)} ${Q.symbol} 的价格冲击 ${pct(impact)}`)
}
log(`计划: ${planOffer ? `换币 ≈${fmtU(estSwap)} ${Q.symbol} -> ${planOffer.text}` : '无需换币'}，LP ≈${fmtU(usdgSpend - estSwap)} ${Q.symbol} + ${tokenCap ? '预算内的' : tokenStart > 0n ? '手里全部的' : '全部拿到的'} ${symbol}${correction ? '（校正开销另计）' : ''}`)
log(`计划: 区间 ${rangeText(rangeFor(refTick))}，滑点 换币 ${swapSlippage}% / LP ${lpSlippage}%`)
// 各仓位按当前配比占预算的份额（按市场价折成计价币）
const planLegs = legsFor(refTick)
const legShares = shapeMath.legShares(planLegs, refTick, 1 / rate, tokenIs1)
if (shape !== 'spot') {
  log(`计划: 形状 ${shapeLabel}，共 ${planLegs.length} 个仓位（同一笔交易创建）:`)
  planLegs.forEach((l, i) => log(`  #${i + 1} ${legText(l)} ${Q.symbol}/${symbol}，≈${(legShares[i] * 100).toFixed(0)}% 资金${{ usdg: `（全 ${Q.symbol}）`, token: '（全代币）', both: '' }[legSide(l, refTick)]}`))
}
if (opt.json) {
  const [lo, hi] = rangeFor(refTick)
  const [a, b] = [usdgPerTokenAtTick(lo), usdgPerTokenAtTick(hi)].sort((x, y) => x - y)
  console.log('@@plan ' + JSON.stringify({
    kind: 'launch', chain: cfg.name, protocol: lp.protocol, quote: Q.symbol, native: cfg.native.symbol, wallet, usdg: fmtU(usdgStart), eth: trim(ethBal, 18), ethPrice: ethPrice.toFixed(2),
    token: { address: token, symbol, name, decimals },
    pool: { id: pool.id, fee: pool.fee / 10000, feeText: feeText(pool), spacing, hooks: pool.hooks !== v4.ZERO_ADDRESS ? pool.hooks : null, state: initialized ? 'reuse' : 'create', price: initialized ? p6(usdgPerTokenAtTick(tick)) : null, deviation: initialized ? pct(deviation(tick, marketTick)) : null },
    market: { price: p6(marketPrice), via: probe.via },
    correction: correction ? correctionText(correction) : null,
    swap: planOffer ? { usdgIn: fmtU(estSwap), out: fmtT(planOffer.out), via: planOffer.via, text: planOffer.text } : null,
    lp: { usdg: fmtU(usdgSpend - estSwap), token: tokenCap ? '预算内的' : tokenStart > 0n ? '手里全部的' : '全部换到的', held: fmtT(tokenStart) },
    range: { tickLower: lo, tickUpper: hi, lo: p6(a), hi: p6(b), label: rangeLabel },
    shape: { kind: shape, layers: shape === 'spot' ? 1 : layers, label: shapeLabel },
    legs: planLegs.map((l, i) => { const [x, y] = [usdgPerTokenAtTick(l.lo), usdgPerTokenAtTick(l.hi)].sort((m, n) => m - n); return { tickLower: l.lo, tickUpper: l.hi, lo: p6(x), hi: p6(y), share: Math.round(legShares[i] * 100), side: legSide(l, refTick) } }),
    slippage: { swap: swapSlippage, lp: lpSlippage }, watch: opt.watch,
  }))
}
if (dryRun) { log('演练模式，到此为止'); await sleep(100); process.exit(0) } // 稍等让批量请求的句柄关闭，避免 Windows 上退出时的 libuv 断言
if (!opt.yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ans = await rl.question('确认执行? (y/N) ')
  rl.close()
  if (ans.trim().toLowerCase() !== 'y') die('已取消')
}

// ---- 交易 ----
const kit = txKit(clients, usd, symOf)
const { sendEstimated, stats } = kit
const buy = (o: SwapOffer, label: string) => executeSwap(o, swapDeps, kit, clients, Q.address, token, label)
// 手里的代币不够 need 时按市价买齐：先试 Uniswap 精确输出；不行就按市场价折算投入量走精确输入（OKX），不够再按比例加量
async function ensureTokens(need: bigint, label: string) {
  const short = need - (await holdings()).held
  if (short <= 0n) return
  let [o] = await buyOffers('EXACT_OUTPUT', short)
  let amountIn = BigInt(Math.ceil((Number(short) / 10 ** decimals) * marketPrice * 10 ** Q.decimals * 1.05))
  for (let i = 0; !o && i < 3; i++) {
    const [x] = await buyOffers('EXACT_INPUT', amountIn)
    if (!x) break
    if (x.out >= short) o = x; else amountIn = (amountIn * short * 103n) / (x.out * 100n)
  }
  if (!o) die(`买不到 ${fmtT(short)} ${symbol}（找不到路由）`)
  log(`换币完成: 拿到 ${fmtT(await buy(o, label))} ${symbol}`)
}
// 同一个池的几个仓位在一笔交易里原子创建（适配器负责授权与编码）。返回仓位 id（按 mint 顺序）并记录到 positions.json；本次建的仓位 id 都收进 minted 供 --watch 只盯自己的
const minted: bigint[] = []
async function mint(label: string, kind: 'lp' | 'bridge', specs: MintSpec[], init?: bigint) {
  const tx = await lp.mintTx(kit, pool!, specs, wallet, init)
  const rc = await sendEstimated(label, tx)
  const ids = lp.mintIds(rc.logs)
  const at = new Date().toISOString()
  for (const positionId of ids) {
    minted.push(positionId)
    savePosition({ id: positionId.toString(), token, symbol, poolId: pool!.id, kind, at, chain: cfg.name, protocol: lp.protocol, ...(kind === 'lp' && shape !== 'spot' ? { shape, group: rc.transactionHash } : {}) })
  }
  return { rc, ids }
}
const floorSlip = (x: bigint) => (x * BigInt(Math.round((100 - lpSlippage) * 100))) / 10_000n

// 1) 池价校正（最多 3 轮，每轮重新探测市场价）
if (correction) {
  for (let round = 1; ; round++) {
    if (round > 1) { marketTick = tickFromProbe((await bestBuy(QU, '探测市场价', true)).out); marketPrice = usdgPerTokenAtTick(marketTick) }
    const c = round === 1 ? correction : await planCorrection(marketTick, marketPrice)
    if (!c) { log(`池价偏离 ${pct(deviation(tick, marketTick))}，已在阈值内`); break }
    if (round > 3) die(`3 轮校正后池价仍偏离 ${pct(c.dev)}，放弃`)
    if (correctionCost(c, marketPrice) > usdgSpend - (await holdings()).spent) die(`校正约需 ${fmtU(correctionCost(c, marketPrice))} ${Q.symbol}，超过剩余预算，放弃`)
    const [cin, cout] = c.zeroForOne ? [pool.currency0, pool.currency1] : [pool.currency1, pool.currency0]
    const fmt = (x: bigint, cur: Address) => `${trim(x, cur === Q.address ? Q.decimals : decimals)} ${symOf(cur)}`
    if (c.kind === 'bridge') {
      const tokenNeed = tokenIs1 ? c.need1 : c.need0
      if (tokenNeed > 0n) await ensureTokens(tokenNeed, `买入 ${symbol} 用于过渡仓位`)
      const { ids } = await mint(`过渡仓位 [${c.lo}, ${c.hi}]`, 'bridge', [{ tickLower: c.lo, tickUpper: c.hi, liquidity: c.liquidity, amount0: c.need0, amount1: c.need1, amount0Max: c.need0, amount1Max: c.need1, amount0Min: floorSlip(c.need0), amount1Min: floorSlip(c.need1) }])
      log(`过渡仓位 id ${ids[0] ?? '?'}（用完即弃，撤退时一并回收）`)
    }
    const maxIn = c.kind === 'swap' ? c.amountIn : c.maxIn
    if (cin === token) await ensureTokens(maxIn, `买入 ${symbol} 用于校正`)
    const amount = c.kind === 'swap' ? { exactIn: c.amountIn, minOut: c.minOut } : { exactOut: c.exactOut, maxIn: c.maxIn }
    const tx = await lp.poolSwapTx(kit, pool, c.zeroForOne, amount, BigInt(now() + 600))
    const label = c.kind === 'swap' ? `校正池价 (卖出 ${fmt(c.amountIn, cin)})` : `校正池价 (买回 ${fmt(c.exactOut, cout)})`
    await sendEstimated(label, tx)
    ;({ sqrtP, tick } = await lp.slot0(pool))
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
    // 发送前模拟不过 / 上链回滚：多半是这家的报价虚高（OKX 的多跳路线实际给不到它报的数，自己的最低回报就把交易打回），换下一家再试，最多换 2 次；都不行才停
    const failed = new Set<SwapOffer['via']>()
    for (;;) {
      try { const got = await buy(o, '换币'); log(`换币完成: ${fmtU(swapAmount)} ${Q.symbol} -> ${fmtT(got)} ${symbol}`); break } catch (e: any) {
        if ((await holdings()).held > held) { log(`换币 (${o.via}) 报错但代币已到账，继续`); break } // 比如等回执超时，别再买一遍
        failed.add(o.via)
        const next = failed.size < 3 ? (await buyOffers('EXACT_INPUT', swapAmount)).find((x) => !failed.has(x.via)) : undefined
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

// 3) LP 价格：池子已存在用池价（重新读取），否则用换币后的市场探测价作为新池初始价
// 换币本身会把池价推开，套利者随后又拉回来；按瞬时价算的流动性到上链时可能超出 amountMax（MaximumAmountExceeded），
// 遇到就重读池价、按手里的币重算再试
const f0 = (x: bigint) => trim(x, dec0), f1 = (x: bigint) => trim(x, dec1)
async function readPrice() {
  ;({ sqrtP, tick } = await lp.slot0(pool!))
  initialized = sqrtP !== 0n
  if (initialized) {
    log(`LP 价格: 池 tick ${tick} = ${price(tick)}`)
  } else {
    tick = tickFromProbe((await bestBuy(QU, '探测市场价', true)).out)
    sqrtP = v4.getSqrtRatioAtTick(tick)
    log(`LP 价格: 新池初始价 tick ${tick} = ${price(tick)}（市场探测价）`)
  }
}
await readPrice()
let legs = legsFor(tick)
// 4) 由持有量算各仓位的流动性（shape.ts）：单仓按余额精确算；多仓共用一份流动性 L，全部放进同一笔交易
const planMints = (avail0: bigint, avail1: bigint) => shapeMath.planMints(legs, sqrtP, avail0, avail1, lpSlippage)
let result: Awaited<ReturnType<typeof mint>> | undefined
for (let attempt = 1; !result; attempt++) {
  if (attempt > 1) await readPrice()
  const heldUse = tokenCap ? min(held, tokenPart(tick)) : held // 持有代币超过预算时代币侧按预算截断
  const [avail0, avail1] = tokenIs1 ? [budgetLeft, heldUse] : [heldUse, budgetLeft]
  const plan = planMints(avail0, avail1)
  const tag = legs.length > 1 ? `组LP ×${legs.length}` : '组LP'
  if (!plan) {
    // 价格移到了仓位的另一侧、手里没有它需要的那种币（单边仓位常见）：按新池价重算区间
    if (attempt >= 5) die('算出的流动性为 0')
    legs = legsFor(tick)
    log(`${tag}: 池价已移出区间，按新池价重算区间（第 ${attempt} 次）`)
    await sleep(3000)
    continue
  }
  const { specs, amounts, sum0, sum1 } = plan
  specs.forEach((s, j) => log(`${tag}${specs.length > 1 ? ` #${j + 1}` : ''}: ticks [${s.tickLower}, ${s.tickUpper}]，liquidity ${s.liquidity}，投入 ${f0(amounts[j][0])} ${sym0} + ${f1(amounts[j][1])} ${sym1}（上限 ${f0(s.amount0Max)} / ${f1(s.amount1Max)}）`))
  log(`${tag}: ${specs.length > 1 ? `${specs.length} 个仓位一笔交易，合计投入 ${f0(sum0)} ${sym0} + ${f1(sum1)} ${sym1}，` : ''}剩余 ${f0(avail0 - sum0)} ${sym0} + ${f1(avail1 - sum1)} ${sym1}`)

  // 5) 建池（如需）+ mint
  try {
    result = await mint(initialized ? tag : `建池+${tag}`, 'lp', specs, initialized ? undefined : sqrtP)
  } catch (e) {
    const r = lp.slippageRevert(e)
    if (!r || attempt >= 5) throw e
    if (r.limit !== undefined && r.actual !== undefined) {
      const cur = specs.some((s) => s.amount0Max === r.limit) ? pool.currency0 : pool.currency1
      const f = cur === pool.currency0 ? f0 : f1
      log(`${tag} 回滚: 池价变动，需要 ${f(r.actual)} ${symOf(cur)} 超过上限 ${f(r.limit)}，等 3 秒按新池价重算（第 ${attempt} 次）`)
    } else log(`${tag} 回滚: 池价变动超出滑点，等 3 秒按新池价重算（第 ${attempt} 次）`)
    await sleep(3000)
  }
}
log(`完成: 仓位 ${result.ids.join(', ') || '?'}，池 ${pool.id}（已记录到 positions.json，撤退: npm run exit -- --chain ${cfg.name} --protocol ${lp.protocol} --token ${token}）`)
log(`      ${cfg.explorer}/tx/${result.rc.transactionHash}`)
log(`gas 合计: ${stats.txCount} 笔，${trim(stats.gasTotal, 18)} ${cfg.native.symbol} ($${usd(stats.gasTotal)})`)
if (opt.json) console.log('@@positions ' + JSON.stringify(minted.map(String))) // 网页界面：本次建的仓位（--watch 时接下来就盯这些）

// 6) 可选：继续监控本次建的仓位，跳出区间自动撤退（同一代币的其他仓位不管，可以再开一个进程做别的区间）
if (opt.watch) await watchToken({
  token, positions: minted.length ? minted : undefined, clients, interval: Math.max(3, num('WATCH_INTERVAL', env('WATCH_INTERVAL', '10'), 0, 86400)), confirm: Math.max(1, num('WATCH_CONFIRM', env('WATCH_CONFIRM', '2'), 0, 1000)),
  upperGrace: num('WATCH_UPPER_GRACE', env('WATCH_UPPER_GRACE', '600'), 0, 86400 * 30),
  stopLoss: num('--stop-loss', opt['stop-loss'], 0, 99), entry: Number(fmtU(usdgBudget)), // 刚建的仓位流水可能还没同步到，本金退回用本次预算
  via: env('EXIT_SWAP_VIA', 'best'), slippage: swapSlippage, lpSlippage, dryRun: false, json: opt.json,
})
