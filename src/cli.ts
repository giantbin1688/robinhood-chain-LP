// Robinhood Chain 一键：USDG -> 代币换币（Uniswap Trading API 路由）、创建/复用 v4 池、按现价区间组 LP。
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import {
  createPublicClient, createWalletClient, defineChain, encodeFunctionData, formatEther, formatUnits, getAddress, http,
  maxUint160, maxUint256, parseAbi, parseEventLogs, parseUnits, type Address, type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as v4 from './v4.ts'

if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) setGlobalDispatcher(new EnvHttpProxyAgent())

const CHAIN_ID = 4663
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address
const POSM = '0x58daec3116aae6D93017bAAea7749052E8a04fA7' as Address
const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' as Address
const QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' as Address
const UR = '0x8876789976decbfcbbbe364623c63652db8c0904' as Address // UniversalRouter 2.1.1
const EXPLORER = 'https://robinhoodchain.blockscout.com'
const API_URL = process.env.UNISWAP_API_URL ?? 'https://trade-api.gateway.uniswap.org/v1'
const API_KEY = process.env.UNISWAP_API_KEY ?? ''

const erc20Abi = parseAbi([
  'function symbol() view returns (string)', 'function name() view returns (string)', 'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])
const permit2Abi = parseAbi(['function allowance(address,address,address) view returns (uint160 amount, uint48 expiration, uint48 nonce)'])
const stateViewAbi = parseAbi([
  'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32) view returns (uint128)',
])
const poolKeyStruct = 'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }'
const quoterAbi = parseAbi([ // 声明成 view 以便 eth_call；Quoter 内部靠 revert 取数，不改状态
  poolKeyStruct, 'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) view returns (uint256 amountOut, uint256 gasEstimate)',
])
const posmAbi = parseAbi([
  poolKeyStruct,
  'struct PermitDetails { address token; uint160 amount; uint48 expiration; uint48 nonce; }',
  'struct PermitSingle { PermitDetails details; address spender; uint256 sigDeadline; }',
  'function permit(address owner, PermitSingle permitSingle, bytes signature) payable returns (bytes err)',
  'function initializePool(PoolKey key, uint160 sqrtPriceX96) payable returns (int24)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
  'function multicall(bytes[] data) payable returns (bytes[])',
  'event Transfer(address indexed from, address indexed to, uint256 indexed id)',
])

// 默认值来自 params.env，命令行参数可临时覆盖
const env = (k: string, d: string) => process.env[k] || d
const { values: opt } = parseArgs({
  options: {
    token: { type: 'string' },
    usdg: { type: 'string', default: env('USDG_AMOUNT', '25') },              // LP 总预算（USDG）
    fee: { type: 'string', default: env('POOL_FEE', '5') },                   // 池子费率 %
    spacing: { type: 'string', default: env('TICK_SPACING', '') },            // 留空 = fee/50
    range: { type: 'string', default: env('RANGE', '-50%,+100%') },          // 区间：相对现价的百分比
    slippage: { type: 'string', default: env('SWAP_SLIPPAGE', '5') },         // 换币滑点 %
    'lp-slippage': { type: 'string', default: env('LP_SLIPPAGE', '5') },      // mint amountMax 余量 %
    'max-deviation': { type: 'string', default: env('MAX_DEVIATION', '10') },// 池价与市场价最大偏离 %
    yes: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },   // 只看计划，不发交易
    from: { type: 'string' },                         // --dry-run 时可用地址代替私钥
  },
})
const ts = () => new Date().toTimeString().slice(0, 8)
const log = (...a: unknown[]) => console.log(ts(), ...a)
function die(msg: string): never { console.error('错误:', msg); process.exit(1) }

if (!opt.token) die('用法: npm run launch -- --token <地址> [--usdg 25] [--fee 5] [--spacing 1000] [--range="-50%,+100%"] [--slippage 5] [--lp-slippage 5] [--max-deviation 10] [--yes] [--dry-run]')
const token = getAddress(opt.token)
const usdgBudget = parseUnits(opt.usdg, 6)
if (usdgBudget <= 0n) die('USDG_AMOUNT / --usdg 必须大于 0')
const fee = Math.round(Number(opt.fee) * 10_000) // pips
if (!(fee > 0 && fee <= 1_000_000)) die(`POOL_FEE / --fee 必须是 (0, 100] 之间的百分比，当前 "${opt.fee}"`)
const spacing = opt.spacing ? Number(opt.spacing) : Math.max(1, Math.round(fee / 50))
if (!(Number.isInteger(spacing) && spacing >= 1 && spacing <= 32767)) die(`TICK_SPACING / --spacing 必须是 [1, 32767] 的整数，当前 "${opt.spacing}"`)
// 区间写法：两个百分比 "-50%,+100%"（也接受空格 / ~ / " - " 分隔）；只写一个则是单边：负数 = 现价往下，正数 = 现价往上
const rangePct = (opt.range.match(/[+-]?\d+(\.\d+)?/g) ?? []).map(Number)
if (rangePct.length === 1) rangePct.push(0)
if (rangePct.length !== 2 || rangePct[0] === rangePct[1]) die(`RANGE / --range 写法：-50%,+100%（双边）、-50%（只做下方）、+100%（只做上方），当前 "${opt.range}"`)
const [pLo, pHi] = [Math.min(...rangePct), Math.max(...rangePct)]
if (pLo <= -100) die('RANGE 下限必须大于 -100%')
const [mLo, mHi] = [1 + pLo / 100, 1 + pHi / 100] // 代币价格倍数
const rangeLabel = `${pLo > 0 ? '+' : ''}${pLo}% .. ${pHi > 0 ? '+' : ''}${pHi}%`
const swapSlippage = Number(opt.slippage), lpSlippage = Number(opt['lp-slippage'])
if (!(swapSlippage >= 0 && swapSlippage <= 50 && lpSlippage >= 0 && lpSlippage <= 50)) die('滑点必须是 [0, 50] 之间的百分比')
const maxDev = Number(opt['max-deviation']) / 100
if (!(maxDev > 0 && maxDev < 1)) die('MAX_DEVIATION / --max-deviation 必须是 (0, 100) 之间的百分比')
const dryRun = opt['dry-run']

const account = process.env.PRIVATE_KEY ? privateKeyToAccount(process.env.PRIVATE_KEY as Hex) : undefined
const wallet: Address = account?.address ?? (opt.from ? getAddress(opt.from) : die('请在 .env 里设置 PRIVATE_KEY（或 --dry-run 配合 --from <地址>）'))
if (!account && !dryRun) die('非 --dry-run 模式必须提供 PRIVATE_KEY')
if (!API_KEY) die('请在 .env 里设置 UNISWAP_API_KEY（developers.uniswap.org/dashboard）')

const chain = defineChain({
  id: CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com'] } },
})
// batch: 同一时刻发出的多个请求合并成一个 HTTP 请求；pollingInterval: 等收据时的轮询间隔
const transport = http(undefined, { batch: true })
const pub = createPublicClient({ chain, transport, pollingInterval: 500 })
const wc = account ? createWalletClient({ account, chain, transport }) : undefined

const balanceOf = (t: Address) => pub.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })
const slot0 = (id: Hex) => pub.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [id] })
// 数字压缩显示：数量截到 6 位小数，价格 6 位有效数字
const trim = (x: bigint, dec: number) => { const [i, f = ''] = formatUnits(x, dec).split('.'); const ff = f.slice(0, 6).replace(/0+$/, ''); return ff ? `${i}.${ff}` : i }
const p6 = (n: number) => String(Number(n.toPrecision(6)))
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`
const min = (a: bigint, b: bigint) => (a < b ? a : b)
const abs = (a: bigint) => (a < 0n ? -a : a)
const now = () => Math.floor(Date.now() / 1000)

async function api(path: string, body: unknown): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(API_URL + path, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    })
    const j = await r.json().catch(() => ({}))
    if (r.ok) return j
    const transient = r.status === 429 || r.status >= 500 || j.errorCode === 'UpstreamTimeoutError'
    if (!transient || attempt >= 4) throw new Error(`${path} -> HTTP ${r.status}: ${JSON.stringify(j).slice(0, 600)}`)
    log(`${path} ${j.errorCode ?? r.status}，重试 (${attempt}/3)`)
    await new Promise((res) => setTimeout(res, 1000 * attempt))
  }
}
// USDG -> 代币报价。EXACT_INPUT: amount 是投入的 USDG；EXACT_OUTPUT: amount 是要拿到的代币数量
async function apiQuote(type: 'EXACT_INPUT' | 'EXACT_OUTPUT', amount: bigint) {
  const q = await api('/quote', {
    tokenIn: USDG, tokenOut: token, tokenInChainId: CHAIN_ID, tokenOutChainId: CHAIN_ID, type,
    amount: amount.toString(), swapper: wallet, slippageTolerance: swapSlippage, protocols: ['V2', 'V3', 'V4'], urgency: 'normal',
  })
  if (q.routing !== 'CLASSIC') die(`API 返回了非 CLASSIC 路由: ${q.routing}`)
  return { ...q, usdgIn: BigInt(q.quote.input.amount) as bigint, usdgMax: BigInt(q.quote.input.maximumAmount ?? q.quote.input.amount) as bigint, out: BigInt(q.quote.output.amount) as bigint, at: Date.now() }
}

// ---- 钱包 / 代币 / 余额 / 池子（一次批量读取）----
const key = v4.makePoolKey(USDG, token, fee, spacing)
const id = v4.poolId(key)
const [symbol, name, decimals, usdgStart, ethBal, tokenStart, ethSlot, poolSlot] = await Promise.all([
  pub.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
  pub.readContract({ address: token, abi: erc20Abi, functionName: 'name' }),
  pub.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
  balanceOf(USDG), pub.getBalance({ address: wallet }), balanceOf(token),
  slot0(v4.poolId(v4.makePoolKey(WETH, USDG, 500, 10))), slot0(id),
])
const ethPrice = v4.priceFromSqrtX96(ethSlot[0]) * 1e12 // WETH 是 currency0 (18 位), USDG 是 currency1 (6 位)
const usd = (wei: bigint) => (Number(formatEther(wei)) * ethPrice).toFixed(2)
const fmtU = (x: bigint) => trim(x, 6), fmtT = (x: bigint) => trim(x, decimals)
log(`钱包 ${wallet} | ${fmtU(usdgStart)} USDG, ${trim(ethBal, 18)} ETH | ETH $${ethPrice.toFixed(2)}`)
log(`代币 ${symbol} (${name}) 精度=${decimals} 地址 ${token}`)
if (usdgStart < usdgBudget) {
  const msg = `预算 ${fmtU(usdgBudget)} USDG，钱包只有 ${fmtU(usdgStart)}`
  dryRun ? log(`警告: ${msg}`) : die(msg)
}
// 本次已花掉的 USDG（卖币收回则为负）和本次拿到的代币
const holdings = async () => { const [u, t] = await Promise.all([balanceOf(USDG), balanceOf(token)]); return { spent: usdgStart - u, held: t - tokenStart } }

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
log(`池子 ${symbol}/USDG 费率=${fee / 10000}% 间距=${spacing}: ${initialized ? `已存在，tick ${tick} = ${price(tick)}` : '不存在，将创建'}`)

// ---- 区间 ----
// 代币价格 × m  <=>  代币是 currency0 时原始价格 × m，是 currency1 时原始价格 ÷ m
const tickDelta = (m: number) => Math.log(m) / Math.log(1.0001)
const [dLo, dHi] = tokenIs1 ? [-tickDelta(mHi), -tickDelta(mLo)] : [tickDelta(mLo), tickDelta(mHi)]
// 远端边界向外取整（保证覆盖要求的范围）；0% 那条边向内取整（单边仓位不包含现价，保持纯单边）
const rangeFor = (t: number) => {
  const lo = dLo === 0 ? v4.ceilToSpacing(t + 1, spacing) : v4.floorToSpacing(t + dLo, spacing)
  const hi = dHi === 0 ? v4.floorToSpacing(t, spacing) : v4.ceilToSpacing(t + dHi, spacing)
  if (hi <= lo) die(`区间 ${rangeLabel} 不足一个 tick 间距（${spacing}），请放宽区间或减小 TICK_SPACING`)
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
  const f = (x: bigint, cur: Address) => `${trim(x, cur === USDG ? 6 : decimals)} ${cur === USDG ? 'USDG' : symbol}`
  const head = `池价偏离 ${pct(c.dev)} 超过 ${maxDev * 100}%，`
  if (c.kind === 'swap') return head + `先在池内卖出 ≈${f(c.amountIn, cin)} 换 ≈${f(c.minOut, cout)}，把偏离拉到 ${pct(c.devAfter)}`
  const held = c.zeroForOne ? f(c.need1, key.currency1) : f(c.need0, key.currency0)
  return head + `池内到市场价之间没有流动性：先建 ≈${held} 的过渡仓位 [${c.lo}, ${c.hi}]，再通过它用最多 ${f(c.maxIn, cin)} 买回 ${f(c.exactOut, cout)}，把价格推到市场价`
}

// ---- 计划 ----
const probe = await apiQuote('EXACT_INPUT', 1_000_000n) // 1 USDG 探测市场价
let marketTick = tickFromProbe(probe.out)
let marketPrice = usdgPerTokenAtTick(marketTick)
const rate = Number(probe.out) / 1e6
log(`市场价 ${p6(marketPrice)} USDG/${symbol}${initialized ? `，池价偏离 ${pct(deviation(tick, marketTick))}` : ''}`)
const correction = initialized ? await planCorrection(marketTick, marketPrice) : null
if (correction) {
  if (correctionCost(correction, marketPrice) > usdgBudget) die(`池价偏离市场价 ${pct(correction.dev)}，校正约需 ${fmtU(correctionCost(correction, marketPrice))} USDG，超过预算，放弃`)
  log(`计划: ${correctionText(correction)}`)
}
const refTick = correction ? v4.tickFromPrice(v4.priceFromSqrtX96(correction.sqrtNext)) : initialized ? tick : marketTick
const estSwap = swapShare(usdgBudget, 0n, refTick, rate)
log(`计划: ${estSwap > 0n ? `换币 ≈${fmtU(estSwap)} USDG -> ≈${fmtT(BigInt(Math.floor(Number(estSwap) * rate)))} ${symbol}` : '无需换币'}，LP ≈${fmtU(usdgBudget - estSwap)} USDG + 全部拿到的 ${symbol}${correction ? '（校正开销另计）' : ''}`)
log(`计划: 区间 ${rangeText(rangeFor(refTick))}，滑点 换币 ${swapSlippage}% / LP ${lpSlippage}%`)
if (dryRun) { log('演练模式，到此为止'); process.exit(0) }
if (!opt.yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ans = await rl.question('确认执行? (y/N) ')
  rl.close()
  if (ans.trim().toLowerCase() !== 'y') die('已取消')
}

// ---- 交易 ----
// nonce 本地递增、gas 价整轮复用（RHC 费率稳定，上限给 3 倍余量，实际只按基础费扣），发交易前不再逐笔查询
let [nonce, fees] = await Promise.all([pub.getTransactionCount({ address: wallet, blockTag: 'pending' }), pub.estimateFeesPerGas()])
let txCount = 0, gasTotal = 0n
async function send(label: string, tx: { to: Address; data: Hex; value?: bigint; gas: bigint }) {
  const hash = await wc!.sendTransaction({ ...tx, nonce: nonce++, maxFeePerGas: fees.maxFeePerGas * 3n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas })
  process.stdout.write(`${ts()} ${label} ${hash} ...`)
  const rc = await pub.waitForTransactionReceipt({ hash, retryDelay: 150, retryCount: 60 })
  const cost = rc.gasUsed * rc.effectiveGasPrice
  txCount++; gasTotal += cost
  process.stdout.write(rc.status === 'success' ? ` 成功，${rc.gasUsed} gas $${usd(cost)}\n` : ' 失败(revert)\n')
  if (rc.status !== 'success') die(`${label} 交易回滚: ${EXPLORER}/tx/${hash}`)
  return rc
}
const symOf = (t: Address) => (t === USDG ? 'USDG' : symbol)
// ERC20 -> Permit2 无限额授权（每个币种每个钱包只需一次，链上交易）
async function ensureErc20Approval(t: Address, need: bigint) {
  const allowance = await pub.readContract({ address: t, abi: erc20Abi, functionName: 'allowance', args: [wallet, PERMIT2] })
  if (allowance >= need) return
  const tx = { to: t, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, maxUint256] }) }
  await send(`授权 ${symOf(t)} -> Permit2`, { ...tx, gas: ((await pub.estimateGas({ account: wallet, ...tx })) * 13n) / 10n })
}
// Permit2 -> spender 的额度用签名授权（塞进用它的那笔交易里，不单独发交易）；额度够且未过期则返回 null
async function permitFor(t: Address, spender: Address, need: bigint): Promise<v4.SignedPermit | null> {
  const [amount, expiration, pnonce] = await pub.readContract({ address: PERMIT2, abi: permit2Abi, functionName: 'allowance', args: [wallet, t, spender] })
  if (amount >= need && expiration >= now() + 3600) return null
  const permitSingle: v4.PermitSingle = { details: { token: t, amount: maxUint160, expiration: now() + 30 * 86400, nonce: pnonce }, spender, sigDeadline: BigInt(now() + 1800) }
  const signature = await wc!.signTypedData({ domain: { name: 'Permit2', chainId: CHAIN_ID, verifyingContract: PERMIT2 }, types: v4.PERMIT_TYPES, primaryType: 'PermitSingle', message: permitSingle })
  return { permitSingle, signature }
}
// 用 API 报价换币：签 Permit2 消息 -> /swap 拿 calldata -> 发送。返回本次拿到的代币数量
async function apiSwap(q: Awaited<ReturnType<typeof apiQuote>>, label: string) {
  await ensureErc20Approval(USDG, q.usdgMax)
  if (Date.now() - q.at > 20_000) q = await apiQuote(q.quote.tradeType, BigInt(q.quote.tradeType === 'EXACT_INPUT' ? q.quote.input.amount : q.quote.output.amount))
  const signature = q.permitData
    ? await wc!.signTypedData({ domain: q.permitData.domain, types: q.permitData.types, primaryType: 'PermitSingle', message: q.permitData.values })
    : undefined
  const res = await api('/swap', {
    quote: q.quote, ...(signature ? { permitData: q.permitData, signature } : {}),
    refreshGasPrice: true, deadline: now() + 600,
  })
  const tx = { to: getAddress(res.swap.to), data: res.swap.data as Hex, value: BigInt(res.swap.value ?? 0) }
  const [before, est] = await Promise.all([balanceOf(token), pub.estimateGas({ account: wallet, ...tx })])
  const apiGas = BigInt(res.swap.gasLimit ?? 0)
  await send(label, { ...tx, gas: ((est > apiGas ? est : apiGas) * 13n) / 10n })
  const got = (await balanceOf(token)) - before
  if (got <= 0n) die('换币交易成功但没有收到代币?')
  return got
}
// 手里的代币不够 need 时按市价买齐（精确输出）
async function ensureTokens(need: bigint, label: string) {
  const short = need - (await holdings()).held
  if (short > 0n) { const got = await apiSwap(await apiQuote('EXACT_OUTPUT', short), label); log(`换币完成: 拿到 ${fmtT(got)} ${symbol}`) }
}
// PositionManager.multicall([permit…, initializePool?, modifyLiquidities(MINT)])，返回仓位 id
async function mint(label: string, lo: number, hi: number, liquidity: bigint, max0: bigint, max1: bigint, init?: bigint) {
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
  const tx = { to: POSM, data: encodeFunctionData({ abi: posmAbi, functionName: 'multicall', args: [calls] }) }
  const est = await pub.estimateGas({ account: wallet, ...tx })
  const rc = await send(label, { ...tx, gas: (est * 13n) / 10n })
  return { rc, positionId: parseEventLogs({ abi: posmAbi, eventName: 'Transfer', logs: rc.logs }).find((l) => l.address.toLowerCase() === POSM.toLowerCase())?.args.id }
}
const withHeadroom = (x: bigint, avail: bigint) => min((x * BigInt(Math.round((100 + lpSlippage) * 100))) / 10_000n, avail)

// 1) 池价校正（最多 3 轮，每轮重新探测市场价）
if (correction) {
  for (let round = 1; ; round++) {
    if (round > 1) { marketTick = tickFromProbe((await apiQuote('EXACT_INPUT', 1_000_000n)).out); marketPrice = usdgPerTokenAtTick(marketTick) }
    const c = round === 1 ? correction : await planCorrection(marketTick, marketPrice)
    if (!c) { log(`池价偏离 ${pct(deviation(tick, marketTick))}，已在阈值内`); break }
    if (round > 3) die(`3 轮校正后池价仍偏离 ${pct(c.dev)}，放弃`)
    if (correctionCost(c, marketPrice) > usdgBudget - (await holdings()).spent) die(`校正约需 ${fmtU(correctionCost(c, marketPrice))} USDG，超过剩余预算，放弃`)
    const [cin, cout] = c.zeroForOne ? [key.currency0, key.currency1] : [key.currency1, key.currency0]
    const fmt = (x: bigint, cur: Address) => `${trim(x, cur === USDG ? 6 : decimals)} ${symOf(cur)}`
    if (c.kind === 'bridge') {
      const tokenNeed = tokenIs1 ? c.need1 : c.need0
      if (tokenNeed > 0n) await ensureTokens(tokenNeed, `买入 ${symbol} 用于过渡仓位`)
      const { positionId } = await mint(`过渡仓位 [${c.lo}, ${c.hi}]`, c.lo, c.hi, c.liquidity, c.need0, c.need1)
      log(`过渡仓位 id ${positionId ?? '?'}（用完即弃，剩几美分粉尘）`)
    }
    const maxIn = c.kind === 'swap' ? c.amountIn : c.maxIn
    if (cin === token) await ensureTokens(maxIn, `买入 ${symbol} 用于校正`)
    await ensureErc20Approval(cin, maxIn)
    const amount = c.kind === 'swap' ? { exactIn: c.amountIn, minOut: c.minOut } : { exactOut: c.exactOut, maxIn: c.maxIn }
    const data = v4.encodeV4SwapCalldata(key, c.zeroForOne, amount, BigInt(now() + 600), await permitFor(cin, UR, maxIn))
    const est = await pub.estimateGas({ account: wallet, to: UR, data })
    const label = c.kind === 'swap' ? `校正池价 (卖出 ${fmt(c.amountIn, cin)})` : `校正池价 (买回 ${fmt(c.exactOut, cout)})`
    await send(label, { to: UR, data, gas: (est * 13n) / 10n })
    ;[sqrtP, tick] = await slot0(id)
    log(`池价 tick ${tick} = ${price(tick)}，偏离市场价 ${pct(deviation(tick, marketTick))}`)
    if (Math.abs(deviation(tick, marketTick)) <= maxDev) break
  }
}

// 2) 按市价换币：先按探测汇率算份额报价；报价汇率与探测差得多（大单价格冲击）就按新汇率重算再报一次
let { spent, held } = await holdings()
let budgetLeft = usdgBudget - spent
if (budgetLeft > 0n) {
  const ref = initialized ? tick : marketTick
  let swapAmount = swapShare(budgetLeft, held, ref, rate)
  if (swapAmount > 0n) {
    let q = await apiQuote('EXACT_INPUT', swapAmount)
    const resized = swapShare(budgetLeft, held, ref, Number(q.out) / Number(q.usdgIn))
    if (abs(resized - swapAmount) > swapAmount / 50n) { swapAmount = resized; q = await apiQuote('EXACT_INPUT', swapAmount) }
    const got = await apiSwap(q, '换币')
    log(`换币完成: ${fmtU(swapAmount)} USDG -> ${fmtT(got)} ${symbol}`)
    ;({ spent, held } = await holdings())
    budgetLeft = usdgBudget - spent
  }
}
if (budgetLeft < 0n) budgetLeft = 0n

// 3) LP 价格：池子已存在用池价（重新读取），否则用换币后的市场探测价作为新池初始价
;[sqrtP, tick] = await slot0(id)
initialized = sqrtP !== 0n
if (initialized) {
  log(`LP 价格: 池 tick ${tick} = ${price(tick)}`)
} else {
  tick = tickFromProbe((await apiQuote('EXACT_INPUT', 1_000_000n)).out)
  sqrtP = v4.getSqrtRatioAtTick(tick)
  log(`LP 价格: 新池初始价 tick ${tick} = ${price(tick)}（市场探测价）`)
}
const [tickLower, tickUpper] = rangeFor(tick)

// 4) 由预算算流动性；amountMax = 实际扣款 + 余量，且不超过持有量
const [avail0, avail1] = tokenIs1 ? [budgetLeft, held] : [held, budgetLeft]
const sqrtA = v4.getSqrtRatioAtTick(tickLower), sqrtB = v4.getSqrtRatioAtTick(tickUpper)
const liquidity = v4.liquidityForAmounts(sqrtP, sqrtA, sqrtB, avail0, avail1)
if (liquidity === 0n) die('算出的流动性为 0')
const [amount0, amount1] = v4.amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity)
const [max0, max1] = [withHeadroom(amount0, avail0), withHeadroom(amount1, avail1)]
const f0 = (x: bigint) => trim(x, dec0), f1 = (x: bigint) => trim(x, dec1)
log(`组LP: ticks [${tickLower}, ${tickUpper}]，liquidity ${liquidity}，投入 ${f0(amount0)} ${sym0} + ${f1(amount1)} ${sym1}（上限 ${f0(max0)} / ${f1(max1)}），剩余 ${f0(avail0 - amount0)} ${sym0} + ${f1(avail1 - amount1)} ${sym1}`)

// 5) 建池（如需）+ mint
const { rc: mintRc, positionId } = await mint(initialized ? '组LP' : '建池+组LP', tickLower, tickUpper, liquidity, max0, max1, initialized ? undefined : sqrtP)
log(`完成: 仓位 ${positionId ?? '?'}，池 ${id}`)
log(`      ${EXPLORER}/tx/${mintRc.transactionHash}`)
log(`gas 合计: ${txCount} 笔，${trim(gasTotal, 18)} ETH ($${usd(gasTotal)})`)
