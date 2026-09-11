// 协议适配层：进场 / 撤退 / 监控 / 网页只跟这个接口打交道，链上细节（PoolKey 结构、仓位 NFT 合约、报价器、池内换币路由）在各实现里
//   Uniswap v4（Robinhood）和 PancakeSwap Infinity CLAMM（BSC）是同一套 singleton 架构：lp-singleton.ts
//   PancakeSwap v3（BSC）：lp-v3.ts
import type { Address, Hex, Log, PublicClient } from 'viem'
import type { ChainConfig, ProtocolName } from './chains.ts'
import type { SignedPermit } from './v4.ts'

// id：v4 / Infinity 是 poolId（bytes32）；v3 是池合约地址。dynamic：动态费率池（key 里的 fee 是 0x800000 标志位，fee 取 slot0 的 lpFee，hook 不写入时为 0）；
// feeHint：从池名拿到的估计费率（pips），动态费率池换币估算用
export type Pool = { id: Hex; key: unknown; currency0: Address; currency1: Address; fee: number; spacing: number; hooks: Address; dynamic?: boolean; feeHint?: number }
export type Slot0 = { sqrtP: bigint; tick: number; protocolFee: number; lpFee: number } // sqrtP = 0 表示池子不存在
export type RawPosition = { id: bigint; pool: Pool; tickLower: number; tickUpper: number; liquidity: bigint }
// amount0/1 是按 liquidity 算出的精确投入；Max 是含余量的上限（v4/Infinity 用）；Min 是最少投入（v3 的 NPM 用它做滑点检查）
export type MintSpec = { tickLower: number; tickUpper: number; liquidity: bigint; amount0: bigint; amount1: bigint; amount0Max: bigint; amount1Max: bigint; amount0Min: bigint; amount1Min: bigint }
export type Tx = { to: Address; data: Hex; value?: bigint }
export type Kit = {
  ensureErc20Approval(t: Address, need: bigint, spender?: Address, spenderName?: string): Promise<void>
  permitFor(t: Address, spender: Address, need: bigint): Promise<SignedPermit | null>
}
export type Mod = { id: bigint; poolId: Hex; tickLower: number; tickUpper: number; delta: bigint; logIndex?: number }
// v3 的 NPM 事件直接给出每个仓位进出的数量，不需要按对手方转账再分摊
export type DirectEvent = { id: bigint; poolId: Hex; tickLower: number; tickUpper: number; action: 'add' | 'collect' | 'remove'; amount0: bigint; amount1: bigint; principal0: bigint; principal1: bigint }
export type LedgerSpec = {
  counterparty: Address | null                       // 代币进出的对手方合约（v4: PoolManager；Infinity: Vault；v3: null = 钱包直接和各池转账）
  parseMods(logs: Log[]): Mod[]                      // 该交易里本协议仓位的流动性变化
  parseDirect?(logs: Log[]): DirectEvent[]           // v3：从 NPM 事件直接得到每个仓位的数量
  priceEventsAt?(pool: Pool, block: bigint): Promise<{ index: number; sqrtP: bigint; tick: number }[]> // 该区块内改变池价的事件（Swap / Initialize）按 logIndex 升序；流水用它还原操作当时的价格
}
export type SlipRevert = { kind: 'max' | 'min'; limit?: bigint; actual?: bigint }

export interface Lp {
  protocol: ProtocolName; label: string
  manager: Address                                   // 仓位 NFT 合约（PositionManager）
  permit2: Address                                   // 这个协议用的 Permit2（v3 不用，填 Uniswap 的占位）
  tiers: { fee: number; spacing: number }[]          // 标准费率档
  spacingFor(fee: number): number | null             // 该费率的默认间距（v3 固定四档，其它 null 表示不允许）
  pool(token: Address, fee: number, spacing: number): Promise<Pool>     // 计价币/代币 池（不一定存在）
  poolById(id: Hex): Promise<Pool | null>            // 从 poolId / 池地址反查（复用已有池，Infinity 含 hook 池）
  slot0(pool: Pool): Promise<Slot0>
  slot0At(pool: Pool, block: bigint): Promise<Slot0>   // 历史区块的池价（资金流水按当时价格折算；需要归档节点）
  liquidityAt(id: bigint, block: bigint): Promise<bigint> // 仓位在某区块的流动性（已销毁 / 不存在返回 0；读链失败抛错，不要当成 0）
  liquidity(pool: Pool): Promise<bigint>
  swapFee(s: Slot0, zeroForOne: boolean, pool: Pool): number           // 这一方向的总换币费率（pips）
  ownedIds(): Promise<{ ids: bigint[]; mints: Map<string, { block: bigint; tx: Hex }>; complete: boolean }> // 链上扫到的钱包仓位；complete=false 表示只能靠 positions.json 补
  positions(ids: bigint[]): Promise<RawPosition[]>   // 其中钱包名下的（已销毁 / 不属于钱包的剔除）
  fees(p: RawPosition): Promise<[bigint, bigint]>    // 未领手续费
  quoteExactIn(pool: Pool, zeroForOne: boolean, amountIn: bigint): Promise<bigint> // 池内精确输入报价，走不通抛错
  mintTx(kit: Kit, pool: Pool, specs: MintSpec[], owner: Address, init?: bigint): Promise<Tx> // 一笔交易 mint 多个仓位（init 给了先建池）；内部先做好授权
  mintIds(logs: Log[]): bigint[]
  burnTx(pool: Pool, positions: { id: bigint; liquidity: bigint; amount0Min: bigint; amount1Min: bigint }[], recipient: Address): Tx
  decreaseTx(pool: Pool, positions: { id: bigint; liquidity: bigint; amount0Min: bigint; amount1Min: bigint }[], recipient: Address): Tx // 撤一部分流动性 + 全部手续费，NFT 保留
  collectTx(groups: { pool: Pool; ids: bigint[] }[], recipient: Address): Tx
  poolSwapTx(kit: Kit, pool: Pool, zeroForOne: boolean, amount: { exactIn: bigint; minOut: bigint } | { exactOut: bigint; maxIn: bigint }, deadline: bigint): Promise<Tx>
  slippageRevert(e: unknown): SlipRevert | null
  ticks(pool: Pool, lo: number, hi: number): Promise<{ inits: number[]; net: Map<number, bigint> }> // (lo, hi) 内已初始化的 tick 及其 liquidityNet
  ledger: LedgerSpec
}

export type LpDeps = { pub: PublicClient; wallet: Address; cfg: ChainConfig; rpcIsAlchemy: boolean; log: (...a: unknown[]) => void }

export async function makeLp(protocol: ProtocolName, d: LpDeps): Promise<Lp> {
  if (protocol === 'v3') return (await import('./lp-v3.ts')).v3Lp(d)
  return (await import('./lp-singleton.ts')).singletonLp(protocol, d)
}
