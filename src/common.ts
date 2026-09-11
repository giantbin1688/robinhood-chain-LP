// 进场（cli.ts）和撤退（exit.ts）共用：链选择与客户端、ABI、Uniswap API / OKX 聚合器、发交易/授权工具、仓位记录
import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import {
  createPublicClient, createWalletClient, defineChain, encodeFunctionData, fallback, formatUnits, getAddress, http, maxUint160, maxUint256, parseAbi,
  type Address, type Hex, type PublicClient, type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { rpcUrl as settingsRpcUrl, uniswapApiUrl } from './settings.ts'
import * as v4 from './v4.ts'
import { CHAINS, selectChain, type ChainConfig, type ChainName, type ProtocolName } from './chains.ts'
import { makeLp, type Lp, type Pool } from './lp.ts'

if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) setGlobalDispatcher(new EnvHttpProxyAgent())

export const erc20Abi = parseAbi([
  'function symbol() view returns (string)', 'function name() view returns (string)', 'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])
export const permit2Abi = parseAbi(['function allowance(address,address,address) view returns (uint160 amount, uint48 expiration, uint48 nonce)'])

export const env = (k: string, d: string) => process.env[k] || d
export const ts = () => new Date().toTimeString().slice(0, 8)
export const log = (...a: unknown[]) => console.log(ts(), ...a)
export function die(msg: string): never { console.error('错误:', msg); process.exit(1) }
// 命令行 / 环境变量里的数字参数：Number('5s') 是 NaN，Math.max(3, NaN) 还是 NaN——监控会变成无间隔死循环且永远不触发撤退，所以不是范围内的有限数字就直接报错
export const num = (label: string, v: string, lo: number, hi: number) => { const n = Number(v); if (!(Number.isFinite(n) && n >= lo && n <= hi)) die(`${label} 必须是 [${lo}, ${hi}] 之间的数字，当前 "${v}"`); return n }
// 顶层 await 里抛出的错误默认打整段堆栈，而网页把子进程输出原样显示——又长又带着 RPC 地址。
// viem 的网络/合约错误收敛成一行；没有 shortMessage 的多半是真的代码 bug，保留堆栈方便查。（网页那侧另有脱敏兜底）
export const failFast = () => {
  const bail = (e: any) => {
    if (e?.shortMessage) die(String(e.shortMessage).slice(0, 300))
    console.error(e)
    process.exit(1)
  }
  process.on('unhandledRejection', bail)
  process.on('uncaughtException', bail)
}
// 数字压缩显示：数量截到 6 位小数，价格 6 位有效数字
export const trim = (x: bigint, dec: number) => { const [i, f = ''] = formatUnits(x, dec).split('.'); const ff = f.slice(0, 6).replace(/0+$/, ''); return ff ? `${i}.${ff}` : i }
export const p6 = (n: number) => String(Number(n.toPrecision(6)))
export const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`
export const min = (a: bigint, b: bigint) => (a < b ? a : b)
export const abs = (a: bigint) => (a < 0n ? -a : a)
export const now = () => Math.floor(Date.now() / 1000)
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const viemChain = (cfg: ChainConfig, rpc: string) => defineChain({
  id: cfg.id, name: cfg.label, nativeCurrency: { name: cfg.native.symbol, symbol: cfg.native.symbol, decimals: cfg.native.decimals },
  rpcUrls: { default: { http: [rpc] } },
  contracts: { multicall3: { address: cfg.multicall3 } }, // 标准 Multicall3，pub.multicall 把成批只读调用合成一个 eth_call
})
// batch: 同一时刻发出的多个请求合并成一个 HTTP 请求；pollingInterval: 等收据时的轮询间隔
// 配了自己的节点时公共节点作备用：Alchemy 免费档每秒 500 计算单元，一批几十个 eth_call 就会被 429（JSON-RPC 里的 429 viem 不重试），
// 出错的请求自动改走公共节点；合约 revert 不会回落（fallback 对 execution reverted 直接抛出），报价/滑点那些靠 revert 数据的逻辑不受影响
export type ClientsOptions = { from?: string; needKey?: boolean; chain?: ChainName; protocol?: ProtocolName }
export async function makeClients(o: ClientsOptions = {}) {
  const needKey = o.needKey ?? true
  const sel = o.chain ? selectChain([`--chain=${o.chain}`, `--protocol=${o.protocol ?? CHAINS[o.chain]?.protocols[0]}`], {}) : selectChain()
  const cfg = sel.cfg, protocol = sel.protocol
  const account = process.env.PRIVATE_KEY ? privateKeyToAccount(process.env.PRIVATE_KEY as Hex) : undefined
  const wallet: Address = account?.address ?? (o.from ? getAddress(o.from) : die('请在 .env 里设置 PRIVATE_KEY（或 --dry-run 配合 --from <地址>）'))
  if (!account && needKey) die('非 --dry-run 模式必须提供 PRIVATE_KEY')
  const rpc = settingsRpcUrl(cfg.name, cfg.rpcEnv) || undefined // 设置页优先，其次 .env
  const own = !!rpc && rpc !== cfg.publicRpc
  const chain = viemChain(cfg, rpc ?? cfg.publicRpc)
  const transport = own
    ? fallback([http(rpc, { batch: true }), http(cfg.publicRpc, { batch: true, methods: { exclude: ['alchemy_getAssetTransfers'] } })])
    : http(cfg.publicRpc, { batch: true })
  const pub = createPublicClient({ chain, transport, pollingInterval: 500 })
  const wc = account ? createWalletClient({ account, chain, transport }) : undefined
  const rpcIsAlchemy = own && /alchemy\.com/.test(rpc!)
  // 历史区块的读取（流水估值用的 slot0At / liquidityAt）只能问自己的归档节点：公共节点没有历史状态，对带 blockNumber 的 eth_call
  // 一律回 "Missing or invalid parameters"。让它们走 fallback 的话，Alchemy 一限流就会落到公共节点、拿一个误导人的错误回来（不会再回 Alchemy 重试）。
  // 所以单独给一个不带备用的客户端，限流靠 http 传输层自己的退避重试（默认 3 次，429 会重试）
  const archive = own ? createPublicClient({ chain, transport: http(rpc, { batch: true, retryCount: 5, retryDelay: 400 }), pollingInterval: 500 }) : pub
  const deps = { pub, archive, wallet, cfg, rpcIsAlchemy, log }
  const lp = await makeLp(protocol, deps)
  const priceLp = cfg.nativePrice.protocol === protocol ? lp : await makeLp(cfg.nativePrice.protocol, deps)
  return { account, wallet, pub, wc, cfg, protocol, chain, lp, priceLp, Q: cfg.quote, rpcIsAlchemy }
}
export type Clients = Awaited<ReturnType<typeof makeClients>>

export async function tokenMeta(pub: PublicClient, token: Address) {
  const [symbol, name, decimals] = await Promise.all([
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'name' }),
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
  ])
  return { symbol, name, decimals }
}
// 原生币（ETH / BNB）的美元价：读一个稳定的 包装原生币/计价币 池的 tick（Robinhood: v4 WETH/USDG 0.05%；BSC: v3 WBNB/USDT 0.05%）
export async function nativePriceUsd(c: Clients) {
  const { cfg } = c
  const pool = await c.priceLp.pool(cfg.wnative, cfg.nativePrice.fee, cfg.nativePrice.spacing)
  const { tick } = await c.priceLp.slot0(pool)
  const raw = v4.priceAtTick(tick) // currency1 基础单位 / currency0 基础单位
  const quoteIs1 = pool.currency1.toLowerCase() === cfg.quote.address.toLowerCase()
  return quoteIs1 ? raw * 10 ** (cfg.native.decimals - cfg.quote.decimals) : 10 ** (cfg.native.decimals - cfg.quote.decimals) / raw
}

// ---- Uniswap Trading API（聚合路由；BSC 上它只走 Uniswap 自家的池，Pancake 的深度看不到，所以 BSC 主要靠 OKX）----
export function uniswapApi(c: Pick<Clients, 'wallet' | 'cfg'>, slippage: number) {
  const { wallet, cfg } = c
  const API_URL = uniswapApiUrl() || 'https://trade-api.gateway.uniswap.org/v1'
  const API_KEY = process.env.UNISWAP_API_KEY ?? ''
  if (!API_KEY) return null
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
      await sleep(1000 * attempt)
    }
  }
  // EXACT_INPUT: amount 是投入的 tokenIn；EXACT_OUTPUT: amount 是要拿到的 tokenOut
  async function quote(tokenIn: Address, tokenOut: Address, type: 'EXACT_INPUT' | 'EXACT_OUTPUT', amount: bigint) {
    const q = await api('/quote', {
      tokenIn, tokenOut, tokenInChainId: cfg.id, tokenOutChainId: cfg.id, type,
      amount: amount.toString(), swapper: wallet, slippageTolerance: slippage, protocols: ['V2', 'V3', 'V4'], urgency: 'normal',
    })
    if (q.routing !== 'CLASSIC') die(`API 返回了非 CLASSIC 路由: ${q.routing}`)
    return { ...q, tokenIn, tokenOut, amountIn: BigInt(q.quote.input.amount) as bigint, amountInMax: BigInt(q.quote.input.maximumAmount ?? q.quote.input.amount) as bigint, out: BigInt(q.quote.output.amount) as bigint, at: Date.now() }
  }
  type Quote = Awaited<ReturnType<typeof quote>>
  // 报价 -> 可发送的交易（过期则重新报价；需要时签 Permit2 消息，路由的额度就在这笔交易里生效）
  async function swapTx(q: Quote, wc: WalletClient) {
    if (Date.now() - q.at > 20_000) q = await quote(q.tokenIn, q.tokenOut, q.quote.tradeType, BigInt(q.quote.tradeType === 'EXACT_INPUT' ? q.quote.input.amount : q.quote.output.amount))
    const signature = q.permitData
      ? await wc.signTypedData({ account: wc.account!, domain: q.permitData.domain, types: q.permitData.types, primaryType: 'PermitSingle', message: q.permitData.values })
      : undefined
    const res = await api('/swap', { quote: q.quote, ...(signature ? { permitData: q.permitData, signature } : {}), refreshGasPrice: true, deadline: now() + 600 })
    return { to: getAddress(res.swap.to), data: res.swap.data as Hex, value: BigInt(res.swap.value ?? 0), gasLimit: BigInt(res.swap.gasLimit ?? 0) }
  }
  return { quote, swapTx }
}

// ---- OKX DEX 聚合器（web3.okx.com Onchain OS，v6）。没配 OKX_API_KEY 时返回 null ----
export function okxDex(c: Pick<Clients, 'wallet' | 'cfg'>, slippage: number) {
  const { wallet, cfg } = c
  const key = env('OKX_API_KEY', ''), secret = env('OKX_SECRET_KEY', ''), pass = env('OKX_API_PASSPHRASE', '')
  if (!key || !secret || !pass) return null
  async function get(path: string, params: Record<string, string>): Promise<any[]> {
    const qs = '?' + new URLSearchParams(params).toString()
    const timestamp = new Date().toISOString()
    const sign = createHmac('sha256', secret).update(timestamp + 'GET' + path + qs).digest('base64')
    const r = await fetch('https://web3.okx.com' + path + qs, { headers: { 'OK-ACCESS-KEY': key, 'OK-ACCESS-SIGN': sign, 'OK-ACCESS-TIMESTAMP': timestamp, 'OK-ACCESS-PASSPHRASE': pass, 'Content-Type': 'application/json' } })
    const j: any = await r.json().catch(() => ({}))
    if (j.code !== '0') throw new Error(`OKX ${path} -> ${j.code ?? r.status}: ${j.msg ?? ''}`)
    return j.data
  }
  let approverCache: Promise<Address> | null = null
  return {
    // 授权给 OKX 的合约地址
    approver: () => { if (!approverCache) { approverCache = get('/api/v6/dex/aggregator/supported/chain', { chainIndex: String(cfg.okxChainIndex) }).then((r) => getAddress(r[0].dexTokenApproveAddress)); approverCache.catch(() => { approverCache = null }) } return approverCache },
    // 报价 + 交易数据一次拿齐
    swap: async (from: Address, to: Address, amount: bigint) => {
      // 貔貅标记：卖出时目标在 fromToken，进场买币时在 toToken，两头都看
      const d = (await get('/api/v6/dex/aggregator/swap', { chainIndex: String(cfg.okxChainIndex), amount: amount.toString(), fromTokenAddress: from, toTokenAddress: to, slippagePercent: String(slippage), userWalletAddress: wallet }))[0]
      return { out: BigInt(d.routerResult.toTokenAmount) as bigint, minOut: BigInt(d.tx.minReceiveAmount) as bigint, route: (d.routerResult.dexRouterList ?? []).map((r: any) => `${r.dexProtocol?.dexName ?? '?'} ${r.dexProtocol?.percent ?? ''}%`).join(' + '), honeypot: d.routerResult.fromToken?.isHoneyPot === true || d.routerResult.toToken?.isHoneyPot === true, tx: { to: getAddress(d.tx.to), data: d.tx.data as Hex, value: BigInt(d.tx.value ?? 0), gasLimit: BigInt(d.tx.gas ?? 0) } }
    },
  }
}

// ---- 发交易 / 授权 ----
export function txKit(c: Clients, usd: (wei: bigint) => string, symOf: (t: Address) => string) {
  const { pub, wc, wallet, chain, cfg, lp } = c
  // nonce 本地递增、gas 价整轮复用（费率稳定的链上够用，上限给 3 倍余量，实际只按基础费扣），发交易前不再逐笔查询
  let nonce: number | undefined, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined
  const stats = { txCount: 0, gasTotal: 0n, lastBlock: 0n } // lastBlock: 最后一笔已确认交易所在的区块，之后读余额要求节点至少到这一块（见 balanceFresh）
  async function send(label: string, tx: { to: Address; data: Hex; value?: bigint; gas: bigint }) {
    if (nonce === undefined || !fees) [nonce, fees] = await Promise.all([pub.getTransactionCount({ address: wallet, blockTag: 'pending' }), pub.estimateFeesPerGas()])
    // 广播失败（RPC 出错、被节点拒收）时 nonce 退回去，否则重试的下一笔会用到跳号的 nonce 卡住
    const hash = await wc!.sendTransaction({ ...tx, account: wc!.account!, chain, nonce: nonce++, maxFeePerGas: fees.maxFeePerGas * 3n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }).catch((e) => { nonce!--; throw e })
    process.stdout.write(`${ts()} ${label} ${hash} ...`)
    const rc = await pub.waitForTransactionReceipt({ hash, retryDelay: 150, retryCount: 60 })
    const cost = rc.gasUsed * rc.effectiveGasPrice
    stats.txCount++; stats.gasTotal += cost
    if (rc.blockNumber > stats.lastBlock) stats.lastBlock = rc.blockNumber
    process.stdout.write(rc.status === 'success' ? ` 成功，${rc.gasUsed} gas $${usd(cost)}\n` : ' 失败(revert)\n')
    // 抛出而不是直接退出：卖币那层要接住重试；没人接的照样由 failFast 打印 shortMessage 后退出。onchain 标记这次是真花了 gas 的回滚
    if (rc.status !== 'success') throw Object.assign(new Error(`${label} 交易回滚`), { shortMessage: `${label} 交易回滚: ${cfg.explorer}/tx/${hash}`, onchain: true })
    return rc
  }
  // ERC20 无限额授权给 spender（默认这个协议的 Permit2），额度够就跳过
  async function ensureErc20Approval(t: Address, need: bigint, spender: Address = lp.permit2, spenderName = 'Permit2') {
    const allowance = await pub.readContract({ address: t, abi: erc20Abi, functionName: 'allowance', args: [wallet, spender] })
    if (allowance >= need) return
    const tx = { to: t, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256] }) }
    await send(`授权 ${symOf(t)} -> ${spenderName}`, { ...tx, gas: ((await pub.estimateGas({ account: wallet, ...tx })) * 13n) / 10n })
  }
  // Permit2 -> spender 的额度用签名授权（塞进用它的那笔交易里，不单独发交易）；额度够且未过期则返回 null
  async function permitFor(t: Address, spender: Address, need: bigint): Promise<v4.SignedPermit | null> {
    const [amount, expiration, pnonce] = await pub.readContract({ address: lp.permit2, abi: permit2Abi, functionName: 'allowance', args: [wallet, t, spender] })
    if (amount >= need && expiration >= now() + 3600) return null
    const permitSingle: v4.PermitSingle = { details: { token: t, amount: maxUint160, expiration: now() + 30 * 86400, nonce: pnonce }, spender, sigDeadline: BigInt(now() + 1800) }
    const signature = await wc!.signTypedData({ account: wc!.account!, domain: { name: 'Permit2', chainId: cfg.id, verifyingContract: lp.permit2 }, types: v4.PERMIT_TYPES, primaryType: 'PermitSingle', message: permitSingle })
    return { permitSingle, signature }
  }
  // 估 gas 后发送，gas 上限 = 估算 × 1.3（可传入 API 给的参考值取较大者）
  async function sendEstimated(label: string, tx: { to: Address; data: Hex; value?: bigint }, refGas = 0n) {
    const est = await pub.estimateGas({ account: wallet, ...tx })
    return send(label, { ...tx, gas: ((est > refGas ? est : refGas) * 13n) / 10n })
  }
  // 一批互不依赖的交易同时广播（同一区块内按 nonce 顺序执行），一起等回执。先逐笔估 gas，估不过的剔除——它不占 nonce，不会留下空洞卡住后面的；
  // 上链后回滚的交易照样消耗 nonce，也不影响其他。广播本身失败（RPC 出错）的把 nonce 退回去再跳过。返回每笔成败，不因为个别失败退出
  async function sendBatch(items: { label: string; tx: { to: Address; data: Hex; value?: bigint }; refGas?: bigint }[]) {
    const est = await Promise.all(items.map((it) => pub.estimateGas({ account: wallet, ...it.tx }).then((g) => g as bigint | null, (e: any) => { log(`${it.label} 模拟失败，跳过: ${String(e?.shortMessage ?? e?.message).slice(0, 120)}`); return null })))
    const ready = items.map((it, i) => ({ ...it, gas: est[i] })).filter((x): x is typeof x & { gas: bigint } => x.gas !== null)
    if (ready.length === 0) return []
    if (nonce === undefined || !fees) [nonce, fees] = await Promise.all([pub.getTransactionCount({ address: wallet, blockTag: 'pending' }), pub.estimateFeesPerGas()])
    const sent: (typeof ready[number] & { hash: Hex })[] = []
    for (const it of ready) {
      const ref = it.refGas ?? 0n, gas = ((it.gas > ref ? it.gas : ref) * 13n) / 10n
      try {
        const hash = await wc!.sendTransaction({ ...it.tx, gas, account: wc!.account!, chain, nonce: nonce++, maxFeePerGas: fees.maxFeePerGas * 3n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas })
        sent.push({ ...it, hash })
      } catch (e: any) { nonce--; log(`${it.label} 广播失败，跳过: ${String(e?.shortMessage ?? e?.message).slice(0, 120)}`) }
    }
    log(`同时广播 ${sent.length} 笔交易，等待上链…`)
    const rcs = await Promise.all(sent.map((s) => pub.waitForTransactionReceipt({ hash: s.hash, retryDelay: 150, retryCount: 60 })))
    return sent.map((s, i) => {
      const rc = rcs[i], cost = rc.gasUsed * rc.effectiveGasPrice, ok = rc.status === 'success'
      stats.txCount++; stats.gasTotal += cost
      if (rc.blockNumber > stats.lastBlock) stats.lastBlock = rc.blockNumber
      log(`${s.label} ${s.hash} ${ok ? `成功，${rc.gasUsed} gas $${usd(cost)}` : `失败(revert) ${cfg.explorer}/tx/${s.hash}`}`)
      return { label: s.label, hash: s.hash, ok, block: rc.blockNumber }
    })
  }
  return { send, sendEstimated, sendBatch, ensureErc20Approval, permitFor, stats }
}

// 交易确认后读余额，要求节点至少已经到了那笔交易的区块（minBlock，一般传 kit.stats.lastBlock）。
// 备用的公共节点常比 Alchemy 慢几秒；Alchemy 被限流时读请求会落到它那里，读回来的是交易之前的旧余额——
// 撤仓后就发生过：按旧余额只卖了钱包里原有的 14 个币，撤出来的 43 万个原样留在钱包。余额和区块号放在同一批请求里问同一个节点，落后就等一秒再读
export async function balanceFresh(c: Pick<Clients, 'pub' | 'wallet'>, token: Address, minBlock: bigint) {
  for (let i = 1; ; i++) {
    const [bal, head] = await Promise.all([c.pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [c.wallet] }), c.pub.getBlockNumber({ cacheTime: 0 })])
    if (head >= minBlock || i >= 30) return bal
    if (i === 1) log(`节点区块 ${head} 还没到交易区块 ${minBlock}，等它跟上再读余额…`)
    await sleep(1000)
  }
}

// ---- 换币：Uniswap、OKX 和「要做 LP 的那个池」同时报价，按结果排序（精确输入看产出多少，精确输出看投入多少）----
// 池内直换（via=pool）：报价来自协议自己的 Quoter，交易走协议的换币路由（v3 SwapRouter / v4、Infinity 的 UR），最低回报 = 报价 × (1 − 滑点)。
// 聚合器的路线不一定比这个池好：OKX 在 BSC 上给 BNC4 报过一条经 RFQ 做市商和 Uniswap v4 hook 池的多跳路线，报价比池价高 0.5%，
// 链上实际却少给 4–7%、被它自己的最低回报打回，而 Pancake 池本身（190 万美元流动性）直接换只差 0.3%。三家报价放一起比，谁给的多走谁
export type SwapOffer = {
  via: 'uniswap' | 'okx' | 'pool'; amountIn: bigint; amountInMax: bigint; out: bigint; text: string; at: number
  uni?: Awaited<ReturnType<NonNullable<ReturnType<typeof uniswapApi>>['quote']>>; okx?: Awaited<ReturnType<NonNullable<ReturnType<typeof okxDex>>['swap']>>
  pool?: { pool: Pool; zeroForOne: boolean; minOut: bigint }
}
// pools：可以直接在里面换的池（进场 = 要做 LP 的池，撤退 = 仓位所在的池），报价时逐个问；池子还不存在 / 没流动性的报价会失败，自动略过
export type SwapDeps = { uni: ReturnType<typeof uniswapApi>; okx: ReturnType<typeof okxDex>; via: string; fmtOut: (x: bigint) => string; outSym: string; lp: Lp; slippage: number; pools: Pool[]; pub: PublicClient; wallet: Address }
// 聚合器一家都没配也能走池内直换，但探测市场价就只能拿池价当市场价（池价偏离校正等于没有）
export function swapDepsFor(c: Clients, slippage: number, via: string, fmtOut: (x: bigint) => string, outSym: string, pools: Pool[] = []): SwapDeps {
  const d: SwapDeps = { uni: uniswapApi(c, slippage), okx: okxDex(c, slippage), via, fmtOut, outSym, lp: c.lp, slippage, pools, pub: c.pub, wallet: c.wallet }
  if (via === 'okx' && !d.okx) die('--via okx 需要在 .env 里配置 OKX_API_KEY / OKX_SECRET_KEY / OKX_API_PASSPHRASE')
  if (via === 'uniswap' && !d.uni) die('--via uniswap 需要在 .env 里配置 UNISWAP_API_KEY')
  if (!d.uni && !d.okx) log('提示: 没配置聚合器（UNISWAP_API_KEY / OKX_API_KEY），换币只能在 LP 的池里直换，市场价也按池价算')
  else if (c.cfg.name === 'bsc' && !d.okx && via !== 'uniswap') log('提示: BSC 上 Uniswap API 只看 Uniswap 自家的池，PancakeSwap 的深度要配 OKX_API_KEY 才能用到')
  return d
}
// external = 只问聚合器（探测市场价用：拿要做 LP 的池自己当市场价，就查不出它偏离市场）；聚合器都报不出才退回池价
export async function swapOffers(d: SwapDeps, tokenIn: Address, tokenOut: Address, type: 'EXACT_INPUT' | 'EXACT_OUTPUT', amount: bigint, o: { external?: boolean } = {}): Promise<SwapOffer[]> {
  const quiet = (e: any) => (log(`报价失败: ${String(e?.shortMessage ?? e?.message).slice(0, 100)}`), null)
  const aggregators = o.external || d.via !== 'pool'
  const inPool = (p: Pool) => { const has = (t: Address) => p.currency0.toLowerCase() === t.toLowerCase() || p.currency1.toLowerCase() === t.toLowerCase(); return has(tokenIn) && has(tokenOut) }
  const poolOffer = (p: Pool) => { // 池内报价失败（池不存在、没流动性、hook 拒绝）只是这个池不能用，不打日志
    const zeroForOne = p.currency0.toLowerCase() === tokenIn.toLowerCase()
    return d.lp.quoteExactIn(p, zeroForOne, amount).then((out): SwapOffer => ({ via: 'pool', amountIn: amount, amountInMax: amount, out, text: `池内 ≈${d.fmtOut(out)} ${d.outSym} (${feeText(p)} 池直换)`, pool: { pool: p, zeroForOne, minOut: (out * BigInt(Math.round((100 - d.slippage) * 100))) / 10_000n }, at: Date.now() })).catch(() => null)
  }
  const poolOffers = () => (type === 'EXACT_INPUT' ? Promise.all(d.pools.filter(inPool).map(poolOffer)) : Promise.resolve([])) // 池内只做精确输入
  // OKX 报的 toTokenAmount 是它自己估的，多跳路线（RFQ 做市商、hook 池）链上常常给不到：钱包里币和授权都够的话把它的 calldata 用 eth_call 跑一遍，按实得排序；模拟就回滚的路线直接弃用。
  // （撤退的计划阶段币还在 LP 里、余额不够，模拟必然失败，这时只能先信它，撤完真卖时再验）它的换币函数都返回 uint256 returnAmount；返回值不是这个形状、或 RPC 出错，就还按它报的算
  const verifyOkx = async (o: SwapOffer): Promise<SwapOffer | null> => {
    const s = o.okx!
    try {
      const [allowance, balance] = await Promise.all([
        d.pub.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'allowance', args: [d.wallet, await d.okx!.approver()] }),
        d.pub.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'balanceOf', args: [d.wallet] }),
      ])
      if (allowance < o.amountIn || balance < o.amountIn) return o
      const { data } = await d.pub.call({ account: d.wallet, to: s.tx.to, data: s.tx.data, value: s.tx.value })
      if (!data || data.length !== 66 || BigInt(data) === 0n) return o
      const got = BigInt(data)
      return got < o.out - o.out / 200n ? { ...o, out: got, text: `${o.text}，模拟实得只有 ≈${d.fmtOut(got)}` } : o
    } catch (e: any) {
      const msg = String(e?.shortMessage ?? e?.message)
      if (/revert/i.test(msg)) { log(`OKX 路线模拟回滚（${msg.replace(/\s+/g, ' ').slice(0, 100)}），弃用`); return null }
      return o
    }
  }
  const all = await Promise.all([
    aggregators && d.via !== 'okx' && d.uni ? d.uni.quote(tokenIn, tokenOut, type, amount).then((q): SwapOffer => ({ via: 'uniswap', amountIn: q.amountIn, amountInMax: q.amountInMax, out: q.out, text: `Uniswap ≈${d.fmtOut(q.out)} ${d.outSym}`, uni: q, at: q.at })).catch(quiet) : null,
    aggregators && d.via !== 'uniswap' && d.okx && type === 'EXACT_INPUT' // OKX 只支持精确输入
      ? d.okx.swap(tokenIn, tokenOut, amount).then((s): SwapOffer => ({ via: 'okx', amountIn: amount, amountInMax: amount, out: s.out, text: `OKX ≈${d.fmtOut(s.out)} ${d.outSym} (${s.route})${s.honeypot ? ' 警告: OKX 标记为貔貅币' : ''}`, okx: s, at: Date.now() })).then(verifyOkx).catch(quiet)
      : null,
    !o.external && (d.via === 'best' || d.via === 'pool') ? poolOffers() : [],
  ])
  let ok = all.flat().filter((x): x is SwapOffer => !!x)
  if (ok.length === 0 && o.external) ok = (await poolOffers()).filter((x): x is SwapOffer => !!x)
  return type === 'EXACT_INPUT' ? ok.sort((a, b) => (a.out > b.out ? -1 : 1)) : ok.sort((a, b) => (a.amountIn < b.amountIn ? -1 : 1))
}
// 把一个报价变成可发送的交易：先做 ERC20 授权（Uniswap 给 Permit2，OKX 给它的授权合约，池内直换给协议路由；额度够就不发），Uniswap 再签 Permit2 消息拿到路由的 calldata
export async function prepareSwap(o: SwapOffer, d: SwapDeps, kit: ReturnType<typeof txKit>, c: Clients, tokenIn: Address) {
  if (o.via === 'okx') {
    await kit.ensureErc20Approval(tokenIn, o.amountIn, await d.okx!.approver(), 'OKX DEX')
    return { via: 'OKX', tx: o.okx!.tx, refGas: o.okx!.tx.gasLimit }
  }
  if (o.via === 'pool') {
    const tx = await d.lp.poolSwapTx(kit, o.pool!.pool, o.pool!.zeroForOne, { exactIn: o.amountIn, minOut: o.pool!.minOut }, BigInt(now() + 600))
    return { via: '池内', tx, refGas: 0n }
  }
  await kit.ensureErc20Approval(tokenIn, o.amountInMax, '0x000000000022D473030F116dDEE9F6B43aC78BA3', 'Permit2') // Uniswap 路由用 Uniswap 的 Permit2（BSC 上 Pancake 的是另一个）
  const tx = await d.uni!.swapTx(o.uni!, c.wc!)
  return { via: 'Uniswap', tx, refGas: tx.gasLimit }
}
// 执行一个报价：授权 -> 发交易。返回收到的 tokenOut 数量
export async function executeSwap(o: SwapOffer, d: SwapDeps, kit: ReturnType<typeof txKit>, c: Clients, tokenIn: Address, tokenOut: Address, label: string) {
  const before = await balanceFresh(c, tokenOut, kit.stats.lastBlock)
  const p = await prepareSwap(o, d, kit, c, tokenIn)
  await kit.sendEstimated(`${label} (${p.via})`, p.tx, p.refGas)
  const got = (await balanceFresh(c, tokenOut, kit.stats.lastBlock)) - before
  if (got <= 0n) die(`${label}交易成功但没有收到代币?`)
  return got
}

// ---- 本地仓位记录 positions.json（进场时追加，撤退时读取）----
// shape / group：本地分类和建仓交易分组。链上只能恢复分组，没有本地记录的仓位显示未分类，不猜成 Spot。
// chain / protocol 没写的是早期记录 = robinhood / v4
export type Shape = 'spot' | 'curve' | 'bidask'
export type PositionRecord = { id: string; token: Address; symbol: string; poolId: Hex; kind: 'lp' | 'bridge'; at: string; shape?: Shape; group?: Hex; chain?: ChainName; protocol?: ProtocolName }
const POSITIONS_FILE = 'positions.json'
export const loadPositions = (): PositionRecord[] => (existsSync(POSITIONS_FILE) ? JSON.parse(readFileSync(POSITIONS_FILE, 'utf8')) : [])
export const positionsOf = (c: Pick<Clients, 'cfg' | 'protocol'>) => loadPositions().filter((p) => (p.chain ?? 'robinhood') === c.cfg.name && (p.protocol ?? 'v4') === c.protocol)
// 网页服务和进场子进程会同时改这个文件（mint 后 savePosition、网页里改分类 updatePositionRecords）：读改写不是原子的，后写的会把先写的覆盖掉。
// 用目录锁串行（mkdir 本身是原子的），超过 10 秒的锁当作崩溃进程的遗留；写入先落临时文件再 rename，别让另一边读到半个文件。
// 删锁只能用 rmdirSync：Node 24.12 的 rmSync 在 Windows 上遇到含非 ASCII 字符的路径会静默什么都不做（nodejs/node#61067），
// 本项目目录名带中文，曾因此把锁永远留在磁盘上，之后每次进场都在写记录这一步死循环（过期分支删不掉又立刻重试，绕过了超时检查）
const POSITIONS_LOCK = POSITIONS_FILE + '.lock'
const unlock = () => { try { rmdirSync(POSITIONS_LOCK) } catch (e: any) { if (e?.code !== 'ENOENT') throw e } }
function withPositionsLock<T>(fn: () => T): T {
  const deadline = Date.now() + 5000
  let stuck: unknown // 过期的锁删不掉时的错误，超时时一起报出来
  for (;;) {
    try { mkdirSync(POSITIONS_LOCK); break } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e
      let age = 0
      try { age = Date.now() - statSync(POSITIONS_LOCK).mtimeMs } catch {} // 刚被对方删掉，下一轮 mkdir 就能成功
      if (age > 10_000) try { unlock() } catch (e) { stuck = e } // 删掉后也不立刻重试，照样经过下面的超时检查：删不掉时不会原地空转
      if (Date.now() > deadline) throw new Error(`${POSITIONS_FILE} 被其他进程锁住超过 5 秒，本次没有写入${stuck ? `（过期的锁删不掉: ${String((stuck as any)?.message ?? stuck)}）` : ''}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try { return fn() } finally { unlock() }
}
function writePositions(list: PositionRecord[]) { const tmp = `${POSITIONS_FILE}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n'); renameSync(tmp, POSITIONS_FILE) }
export function savePosition(p: PositionRecord) { withPositionsLock(() => writePositions([...loadPositions(), p])) }
// 只更新指定链 / 协议 / NFT 的标签，保留其他仓位和已有记录字段。
export function mergePositionRecords(existing: PositionRecord[], updates: PositionRecord[]): PositionRecord[] {
  const key = (p: PositionRecord) => `${p.chain ?? 'robinhood'}:${p.protocol ?? 'v4'}:${p.id}`
  const byId = new Map(updates.map(p => [key(p), p]))
  const seen = new Set<string>()
  const result = existing.flatMap(p => { const k=key(p), update=byId.get(k); if(!update) return [p]; if(seen.has(k)) return []; seen.add(k); return [{...p,...update,at:p.at,kind:p.kind}] })
  for (const k of seen) byId.delete(k)
  return [...result,...byId.values()]
}
export function updatePositionRecords(updates: PositionRecord[]) { withPositionsLock(() => writePositions(mergePositionRecords(loadPositions(), updates))) }

// 池子的费率文字：动态费率池标出来
export const feeText = (p: Pool) => (p.dynamic ? `动态${p.fee ? `(${p.fee / 10000}%)` : ''}` : `${p.fee / 10000}%`)
