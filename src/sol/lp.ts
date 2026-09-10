// Solana 协议适配层：进场 / 撤退 / 监控 / 网页只跟这个接口打交道；Meteora DLMM（bin）和 Raydium CLMM（tick）各自实现
//   unit = DLMM 的 binId / CLMM 的 tick；价格一律是 "Y 每 X"（UI 单位，已按精度折算），代币在哪一边由 quoteSide() 判断
import type { ParsedTransactionWithMeta } from '@solana/web3.js'
import type { Shape } from '../shape.ts'
import type { SolProtocol, TxBundle } from './common.ts'

export type SolPool = { id: string; protocol: SolProtocol; mintX: string; mintY: string; decX: number; decY: number; step: number; fee: number; dynamic?: boolean; feeHint?: number; raw?: unknown }
export type PoolState = { price: number; active: number; hasLiquidity: boolean; sqrtP?: bigint } // price = Y 每 X；sqrtP：CLMM 的 sqrtPriceX96（由 X64 左移 32 位，直接用 v4.ts 的数学）
export type Tier = { fee: number; step: number; key: string; label: string } // fee 用 pips（1e6 = 100%），step = binStep / tickSpacing；key = preset / config 账户
export type SolPosition = { id: string; pool: SolPool; lower: number; upper: number; amountX: bigint; amountY: bigint; feeX: bigint; feeY: bigint; liquidity: bigint; raw: unknown }
export type MintReq = { lower: number; upper: number; active: number; shape: Shape; layers: number; lpSlippage: number; tokenIsX: boolean } // active = 计划时的现价 unit（CLMM 按它拆层）
export type MintPlan = {
  legs: { lower: number; upper: number; g: number }[]          // 拆出来的仓位（DLMM 一个策略仓位 = 一段；CLMM 每层一段）
  yPerX(state: PoolState): Promise<number>                      // 这个形状在当前池价下每 1 个 X（基础单位）要配多少 Y（基础单位）；Infinity = 只要 Y，0 = 只要 X
  cost(): Promise<{ text: string; solNeeded: number }>           // 要几笔交易、租金多少（DLMM 的仓位 / bin 数组租金，CLMM 的 NFT / tick 数组租金）；solNeeded = 预算之外还要留多少 SOL
  build(amountX: bigint, amountY: bigint, state: PoolState): Promise<{ bundles: TxBundle[]; ids: string[]; useX: bigint; useY: bigint; note: string }>
}
export type LedgerEvent = { sig: string; time: number; action: 'add' | 'remove' | 'collect'; amountX: bigint; amountY: bigint; principalX: bigint; principalY: bigint; price: number | null; block: number }
export type DepthBar = { lo: number; hi: number; amountX: bigint; amountY: bigint } // [lo, hi) 单位区间里的两种币数量

export interface SolLp {
  protocol: SolProtocol; label: string
  tiers(): Promise<Tier[]>
  tierFor(fee: number, step?: number): Promise<Tier | null>       // 精确匹配费率（和间距）的标准档；没有返回 null
  pool(token: string, quote: string, tier: Tier): Promise<SolPool | null> // 已存在的 代币/计价币 池；没建过返回 null
  poolById(id: string): Promise<SolPool | null>
  state(pool: SolPool): Promise<PoolState>
  priceAt(pool: SolPool, unit: number): number                    // unit 下沿的价格（Y 每 X）
  unitAt(pool: SolPool, price: number, round: 'down' | 'up'): number
  edges(p: SolPosition): [number, number]                         // 仓位覆盖的价格区间（Y 每 X）
  inRange(p: SolPosition, active: number): boolean
  ownedPositions(): Promise<SolPosition[]>                        // 钱包名下全部仓位（所有池）
  positions(ids: string[]): Promise<SolPosition[]>                // 其中仍归钱包所有、还存在的
  quoteSwap(pool: SolPool, xToY: boolean, amountIn: bigint): Promise<{ out: bigint; endPrice: number }>
  swapTx(pool: SolPool, xToY: boolean, amountIn: bigint, minOut: bigint): Promise<TxBundle>
  createPoolTx(token: string, quote: string, tier: Tier, price: number, decX: number, decY: number): Promise<{ bundles: TxBundle[]; poolId: string }> // price = Y 每 X（UI 单位，token 为 X）
  mintPlan(pool: SolPool, req: MintReq): Promise<MintPlan>
  burnTx(positions: SolPosition[], bps: number, lpSlippage: number): Promise<TxBundle[]> // 10000 = 全撤 + 领手续费 + 关闭仓位（退租金）；否则撤这个比例、手续费全领、仓位保留。lpSlippage 只有 CLMM 用（最少拿回量）
  collectTx(positions: SolPosition[]): Promise<TxBundle[]>
  depth(pool: SolPool, lower: number, upper: number): Promise<DepthBar[]>
  ledgerAddress(p: Pick<SolPosition, 'id'>): string              // 查交易历史用的账户（DLMM 仓位账户；CLMM 仓位 PDA）
  parseLedger(tx: ParsedTransactionWithMeta, p: Pick<SolPosition, 'id' | 'pool'>): Promise<LedgerEvent | null>
  positionsInTx(tx: ParsedTransactionWithMeta): Promise<{ id: string; poolId: string | null; action: 'add' | 'remove' | 'collect' }[]> // 这笔交易动了钱包的哪些仓位（扫已平仓用）
}

export type SolLpDeps = { conn: import('@solana/web3.js').Connection; wallet: import('@solana/web3.js').PublicKey; log: (...a: unknown[]) => void }
export async function makeSolLp(protocol: SolProtocol, d: SolLpDeps): Promise<SolLp> {
  if (protocol === 'clmm') return (await import('./clmm.ts')).clmmLp(d)
  return (await import('./dlmm.ts')).dlmmLp(d)
}
