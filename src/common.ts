// 进场（cli.ts）和撤退（exit.ts）共用：常量、ABI、客户端、Uniswap API、发交易/授权工具、仓位记录
import { createHmac } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import {
  createPublicClient, createWalletClient, defineChain, encodeFunctionData, formatUnits, getAddress, http, maxUint160, maxUint256, parseAbi,
  type Address, type Hex, type PublicClient, type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as v4 from './v4.ts'

if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) setGlobalDispatcher(new EnvHttpProxyAgent())

export const CHAIN_ID = 4663
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168' as Address
export const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address
export const POSM = '0x58daec3116aae6D93017bAAea7749052E8a04fA7' as Address
export const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' as Address
export const QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' as Address
export const UR = '0x8876789976decbfcbbbe364623c63652db8c0904' as Address // UniversalRouter 2.1.1
export const EXPLORER = 'https://robinhoodchain.blockscout.com'
export const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com'

export const erc20Abi = parseAbi([
  'function symbol() view returns (string)', 'function name() view returns (string)', 'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])
export const permit2Abi = parseAbi(['function allowance(address,address,address) view returns (uint160 amount, uint48 expiration, uint48 nonce)'])
export const stateViewAbi = parseAbi([
  'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32) view returns (uint128)',
])
const poolKeyStruct = 'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }'
export const quoterAbi = parseAbi([ // 声明成 view 以便 eth_call；Quoter 内部靠 revert 取数，不改状态
  poolKeyStruct, 'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) view returns (uint256 amountOut, uint256 gasEstimate)',
])
export const posmAbi = parseAbi([
  poolKeyStruct,
  'struct PermitDetails { address token; uint160 amount; uint48 expiration; uint48 nonce; }',
  'struct PermitSingle { PermitDetails details; address spender; uint256 sigDeadline; }',
  'function permit(address owner, PermitSingle permitSingle, bytes signature) payable returns (bytes err)',
  'function initializePool(PoolKey key, uint160 sqrtPriceX96) payable returns (int24)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
  'function multicall(bytes[] data) payable returns (bytes[])',
  'function ownerOf(uint256 id) view returns (address)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (PoolKey poolKey, uint256 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed id)',
])

export const env = (k: string, d: string) => process.env[k] || d
export const ts = () => new Date().toTimeString().slice(0, 8)
export const log = (...a: unknown[]) => console.log(ts(), ...a)
export function die(msg: string): never { console.error('错误:', msg); process.exit(1) }
// 数字压缩显示：数量截到 6 位小数，价格 6 位有效数字
export const trim = (x: bigint, dec: number) => { const [i, f = ''] = formatUnits(x, dec).split('.'); const ff = f.slice(0, 6).replace(/0+$/, ''); return ff ? `${i}.${ff}` : i }
export const p6 = (n: number) => String(Number(n.toPrecision(6)))
export const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`
export const min = (a: bigint, b: bigint) => (a < b ? a : b)
export const abs = (a: bigint) => (a < 0n ? -a : a)
export const now = () => Math.floor(Date.now() / 1000)
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const chain = defineChain({
  id: CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.RPC_URL ?? PUBLIC_RPC] } },
})
// batch: 同一时刻发出的多个请求合并成一个 HTTP 请求；pollingInterval: 等收据时的轮询间隔
export function makeClients(from?: string, needKey = true) {
  const account = process.env.PRIVATE_KEY ? privateKeyToAccount(process.env.PRIVATE_KEY as Hex) : undefined
  const wallet: Address = account?.address ?? (from ? getAddress(from) : die('请在 .env 里设置 PRIVATE_KEY（或 --dry-run 配合 --from <地址>）'))
  if (!account && needKey) die('非 --dry-run 模式必须提供 PRIVATE_KEY')
  const transport = http(undefined, { batch: true })
  const pub = createPublicClient({ chain, transport, pollingInterval: 500 })
  const wc = account ? createWalletClient({ account, chain, transport }) : undefined
  return { account, wallet, pub, wc }
}
export type Clients = ReturnType<typeof makeClients>

export async function tokenMeta(pub: PublicClient, token: Address) {
  const [symbol, name, decimals] = await Promise.all([
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'name' }),
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
  ])
  return { symbol, name, decimals }
}
// ETH 价格：v4 WETH/USDG 0.05% 池（WETH 是 currency0 18 位，USDG 是 currency1 6 位）
export async function ethPriceUsd(pub: PublicClient) {
  const [sqrt] = await pub.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [v4.poolId(v4.makePoolKey(WETH, USDG, 500, 10))] })
  return v4.priceFromSqrtX96(sqrt) * 1e12
}

// ---- Uniswap Trading API ----
export function uniswapApi(wallet: Address, slippage: number) {
  const API_URL = process.env.UNISWAP_API_URL ?? 'https://trade-api.gateway.uniswap.org/v1'
  const API_KEY = process.env.UNISWAP_API_KEY ?? ''
  if (!API_KEY) die('请在 .env 里设置 UNISWAP_API_KEY（developers.uniswap.org/dashboard）')
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
      tokenIn, tokenOut, tokenInChainId: CHAIN_ID, tokenOutChainId: CHAIN_ID, type,
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
export function okxDex(wallet: Address, slippage: number) {
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
  return {
    // 授权给 OKX 的合约地址
    approver: async () => getAddress((await get('/api/v6/dex/aggregator/supported/chain', { chainIndex: String(CHAIN_ID) }))[0].dexTokenApproveAddress),
    // 报价 + 交易数据一次拿齐
    swap: async (from: Address, to: Address, amount: bigint) => {
      const d = (await get('/api/v6/dex/aggregator/swap', { chainIndex: String(CHAIN_ID), amount: amount.toString(), fromTokenAddress: from, toTokenAddress: to, slippagePercent: String(slippage), userWalletAddress: wallet }))[0]
      return { out: BigInt(d.routerResult.toTokenAmount) as bigint, minOut: BigInt(d.tx.minReceiveAmount) as bigint, route: (d.routerResult.dexRouterList ?? []).map((r: any) => `${r.dexProtocol?.dexName ?? '?'} ${r.dexProtocol?.percent ?? ''}%`).join(' + '), honeypot: d.routerResult.fromToken?.isHoneyPot === true, tx: { to: getAddress(d.tx.to), data: d.tx.data as Hex, value: BigInt(d.tx.value ?? 0), gasLimit: BigInt(d.tx.gas ?? 0) } }
    },
  }
}

// ---- 发交易 / 授权 ----
export function txKit(c: Clients, usd: (wei: bigint) => string, symOf: (t: Address) => string) {
  const { pub, wc, wallet } = c
  // nonce 本地递增、gas 价整轮复用（RHC 费率稳定，上限给 3 倍余量，实际只按基础费扣），发交易前不再逐笔查询
  let nonce: number | undefined, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined
  const stats = { txCount: 0, gasTotal: 0n }
  async function send(label: string, tx: { to: Address; data: Hex; value?: bigint; gas: bigint }) {
    if (nonce === undefined || !fees) [nonce, fees] = await Promise.all([pub.getTransactionCount({ address: wallet, blockTag: 'pending' }), pub.estimateFeesPerGas()])
    const hash = await wc!.sendTransaction({ ...tx, account: wc!.account!, chain, nonce: nonce++, maxFeePerGas: fees.maxFeePerGas * 3n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas })
    process.stdout.write(`${ts()} ${label} ${hash} ...`)
    const rc = await pub.waitForTransactionReceipt({ hash, retryDelay: 150, retryCount: 60 })
    const cost = rc.gasUsed * rc.effectiveGasPrice
    stats.txCount++; stats.gasTotal += cost
    process.stdout.write(rc.status === 'success' ? ` 成功，${rc.gasUsed} gas $${usd(cost)}\n` : ' 失败(revert)\n')
    if (rc.status !== 'success') die(`${label} 交易回滚: ${EXPLORER}/tx/${hash}`)
    return rc
  }
  // ERC20 无限额授权给 spender（默认 Permit2），额度够就跳过
  async function ensureErc20Approval(t: Address, need: bigint, spender: Address = PERMIT2, spenderName = 'Permit2') {
    const allowance = await pub.readContract({ address: t, abi: erc20Abi, functionName: 'allowance', args: [wallet, spender] })
    if (allowance >= need) return
    const tx = { to: t, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256] }) }
    await send(`授权 ${symOf(t)} -> ${spenderName}`, { ...tx, gas: ((await pub.estimateGas({ account: wallet, ...tx })) * 13n) / 10n })
  }
  // Permit2 -> spender 的额度用签名授权（塞进用它的那笔交易里，不单独发交易）；额度够且未过期则返回 null
  async function permitFor(t: Address, spender: Address, need: bigint): Promise<v4.SignedPermit | null> {
    const [amount, expiration, pnonce] = await pub.readContract({ address: PERMIT2, abi: permit2Abi, functionName: 'allowance', args: [wallet, t, spender] })
    if (amount >= need && expiration >= now() + 3600) return null
    const permitSingle: v4.PermitSingle = { details: { token: t, amount: maxUint160, expiration: now() + 30 * 86400, nonce: pnonce }, spender, sigDeadline: BigInt(now() + 1800) }
    const signature = await wc!.signTypedData({ account: wc!.account!, domain: { name: 'Permit2', chainId: CHAIN_ID, verifyingContract: PERMIT2 }, types: v4.PERMIT_TYPES, primaryType: 'PermitSingle', message: permitSingle })
    return { permitSingle, signature }
  }
  // 估 gas 后发送，gas 上限 = 估算 × 1.3（可传入 API 给的参考值取较大者）
  async function sendEstimated(label: string, tx: { to: Address; data: Hex; value?: bigint }, refGas = 0n) {
    const est = await pub.estimateGas({ account: wallet, ...tx })
    return send(label, { ...tx, gas: ((est > refGas ? est : refGas) * 13n) / 10n })
  }
  return { send, sendEstimated, ensureErc20Approval, permitFor, stats }
}

// ---- 换币：Uniswap 和 OKX 同时报价，按结果排序（精确输入看产出多少，精确输出看投入多少）----
export type SwapOffer = {
  via: 'uniswap' | 'okx'; amountIn: bigint; amountInMax: bigint; out: bigint; text: string; at: number
  uni?: Awaited<ReturnType<ReturnType<typeof uniswapApi>['quote']>>; okx?: Awaited<ReturnType<NonNullable<ReturnType<typeof okxDex>>['swap']>>
}
export type SwapDeps = { uni: ReturnType<typeof uniswapApi>; okx: ReturnType<typeof okxDex>; via: string; fmtOut: (x: bigint) => string; outSym: string }
export async function swapOffers(d: SwapDeps, tokenIn: Address, tokenOut: Address, type: 'EXACT_INPUT' | 'EXACT_OUTPUT', amount: bigint): Promise<SwapOffer[]> {
  const quiet = (e: any) => (log(`报价失败: ${String(e?.message).slice(0, 100)}`), null)
  const all = await Promise.all([
    d.via !== 'okx' ? d.uni.quote(tokenIn, tokenOut, type, amount).then((q): SwapOffer => ({ via: 'uniswap', amountIn: q.amountIn, amountInMax: q.amountInMax, out: q.out, text: `Uniswap ≈${d.fmtOut(q.out)} ${d.outSym}`, uni: q, at: q.at })).catch(quiet) : null,
    d.via !== 'uniswap' && d.okx && type === 'EXACT_INPUT' // OKX 在 RHC 上只支持精确输入
      ? d.okx.swap(tokenIn, tokenOut, amount).then((s): SwapOffer => ({ via: 'okx', amountIn: amount, amountInMax: amount, out: s.out, text: `OKX ≈${d.fmtOut(s.out)} ${d.outSym} (${s.route})${s.honeypot ? ' 警告: OKX 标记为貔貅币' : ''}`, okx: s, at: Date.now() })).catch(quiet)
      : null,
  ])
  const ok = all.filter((x): x is SwapOffer => !!x)
  return type === 'EXACT_INPUT' ? ok.sort((a, b) => (a.out > b.out ? -1 : 1)) : ok.sort((a, b) => (a.amountIn < b.amountIn ? -1 : 1))
}
// 执行一个报价：授权（Uniswap 走 Permit2 签名，OKX 走它的授权合约）-> 发交易。返回收到的 tokenOut 数量
export async function executeSwap(o: SwapOffer, d: SwapDeps, kit: ReturnType<typeof txKit>, c: Clients, tokenIn: Address, tokenOut: Address, label: string) {
  const balance = () => c.pub.readContract({ address: tokenOut, abi: erc20Abi, functionName: 'balanceOf', args: [c.wallet] })
  const before = await balance()
  if (o.via === 'okx') {
    await kit.ensureErc20Approval(tokenIn, o.amountIn, await d.okx!.approver(), 'OKX DEX')
    await kit.sendEstimated(`${label} (OKX)`, o.okx!.tx, o.okx!.tx.gasLimit)
  } else {
    await kit.ensureErc20Approval(tokenIn, o.amountInMax)
    const tx = await d.uni.swapTx(o.uni!, c.wc!)
    await kit.sendEstimated(`${label} (Uniswap)`, tx, tx.gasLimit)
  }
  const got = (await balance()) - before
  if (got <= 0n) die(`${label}交易成功但没有收到代币?`)
  return got
}

// ---- 本地仓位记录 positions.json（进场时追加，撤退时读取）----
export type PositionRecord = { id: string; token: Address; symbol: string; poolId: Hex; kind: 'lp' | 'bridge'; at: string }
const POSITIONS_FILE = 'positions.json'
export const loadPositions = (): PositionRecord[] => (existsSync(POSITIONS_FILE) ? JSON.parse(readFileSync(POSITIONS_FILE, 'utf8')) : [])
export function savePosition(p: PositionRecord) { writeFileSync(POSITIONS_FILE, JSON.stringify([...loadPositions(), p], null, 2) + '\n') }
