// Uniswap v3（Ethereum）/ PancakeSwap v3（BSC）。每个池是独立合约（CREATE2），仓位 NFT 由 NonfungiblePositionManager 管理。
// 直接 ERC20 授权给 NPM / SwapRouter；费率和 init code hash 按链选择。协议费从 LP 费里分、不改变总费率。
import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, maxUint128, parseAbi, parseAbiItem, parseEventLogs, type Address, type Hex, type Log } from 'viem'
import * as v4 from './v4.ts'
import { protocolLabel, type ChainName } from './chains.ts'
import type { DirectEvent, Lp, LpDeps, Mod, Pool, RawPosition, Slot0 } from './lp.ts'

const ZERO = v4.ZERO_ADDRESS
const POOL_INIT_CODE_HASH = '0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2'
export const UNI_POOL_INIT_CODE_HASH = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54'
const TIERS = [{ fee: 100, spacing: 1 }, { fee: 500, spacing: 10 }, { fee: 2500, spacing: 50 }, { fee: 10000, spacing: 200 }]
export const v3Tiers = (chain: ChainName) => chain === 'ethereum' ? [{ fee: 100, spacing: 1 }, { fee: 500, spacing: 10 }, { fee: 3000, spacing: 60 }, { fee: 10000, spacing: 200 }] : TIERS

const factoryAbi = parseAbi(['function getPool(address, address, uint24) view returns (address)'])
const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)', 'function fee() view returns (uint24)', 'function tickSpacing() view returns (int24)',
  'function token0() view returns (address)', 'function token1() view returns (address)',
  'function feeGrowthGlobal0X128() view returns (uint256)', 'function feeGrowthGlobal1X128() view returns (uint256)',
  'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
  'function tickBitmap(int16) view returns (uint256)',
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount0, uint128 amount1)',
])
const npmAbi = parseAbi([
  'struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }',
  'struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }',
  'struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }',
  'function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)',
  'function decreaseLiquidity(DecreaseLiquidityParams params) payable returns (uint256 amount0, uint256 amount1)',
  'function collect(CollectParams params) payable returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId) payable',
  'function multicall(bytes[] data) payable returns (bytes[])',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)',
])
const quoterAbi = parseAbi([ // 声明成 view 以便 eth_call
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])
const routerAbi = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'struct ExactOutputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountOut; uint256 amountInMaximum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
  'function exactOutputSingle(ExactOutputSingleParams params) payable returns (uint256 amountIn)',
])
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600)

// 池地址 = create2(deployer, keccak(token0, token1, fee), initCodeHash)：池还没建时也能算出来当 id 用
export function computePoolAddress(deployer: Address, token0: Address, token1: Address, fee: number, initCodeHash: Hex = POOL_INIT_CODE_HASH): Address {
  const salt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], [token0, token1, fee]))
  return getAddress(`0x${keccak256(`0xff${deployer.slice(2)}${salt.slice(2)}${initCodeHash.slice(2)}`).slice(26)}`)
}

export async function v3Lp(d: LpDeps): Promise<Lp> {
  const { pub, archive, wallet, cfg } = d
  const label = protocolLabel(cfg.name, 'v3')
  const tiers = v3Tiers(cfg.name)
  const A = cfg.contracts.v3! as unknown as Record<string, Address>
  const NPM = A.positionManager, FACTORY = A.factory, ROUTER = A.swapRouter, QUOTER = A.quoter
  const poolCache = new Map<string, Pool>()

  const spacingFor = (fee: number) => tiers.find((t) => t.fee === fee)?.spacing ?? null
  async function pool(a: Address, b: Address, fee: number): Promise<Pool> {
    const [token0, token1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a]
    const k = `${token0}:${token1}:${fee}`.toLowerCase()
    let p = poolCache.get(k)
    if (p) return p
    const spacing = spacingFor(fee)
    if (spacing === null) throw new Error(`${label} 支持 ${tiers.map((t) => t.fee / 10000 + '%').join(' / ')}，没有 ${fee / 10000}%`)
    const onchain = await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'getPool', args: [token0, token1, fee] })
    const address = same(onchain, ZERO) ? computePoolAddress(A.deployer, token0, token1, fee, cfg.name === 'ethereum' ? UNI_POOL_INIT_CODE_HASH : POOL_INIT_CODE_HASH) : onchain
    p = { id: address, key: { token0, token1, fee }, currency0: token0, currency1: token1, fee, spacing, hooks: ZERO }
    poolCache.set(k, p)
    return p
  }
  async function slot0(p: Pool, blockNumber?: bigint): Promise<Slot0> {
    try {
      const [sqrtP, tick, , , , feeProtocol] = await (blockNumber ? archive : pub).readContract({ address: p.id as Address, abi: poolAbi, functionName: 'slot0', args: [], ...(blockNumber ? { blockNumber } : {}) })
      return { sqrtP, tick, protocolFee: feeProtocol, lpFee: p.fee }
    } catch (e: any) {
      if (!blockNumber && (await pub.getCode({ address: p.id as Address })) === undefined) return { sqrtP: 0n, tick: 0, protocolFee: 0, lpFee: p.fee } // 池合约还不存在
      throw e
    }
  }
  const poolOf = (p: RawPosition) => p.pool.id as Address

  async function ownedIds() {
    const n = await pub.readContract({ address: NPM, abi: npmAbi, functionName: 'balanceOf', args: [wallet] })
    const ids = n === 0n ? [] : await pub.multicall({ allowFailure: false, batchSize: 0, contracts: Array.from({ length: Number(n) }, (_, i) => ({ address: NPM, abi: npmAbi, functionName: 'tokenOfOwnerByIndex', args: [wallet, BigInt(i)] }) as const) })
    return { ids: [...ids], mints: new Map(), complete: true } // ERC721Enumerable 列全了；mint 区块要看流水
  }
  async function positions(ids: bigint[]): Promise<RawPosition[]> {
    if (!ids.length) return []
    const owners = await pub.multicall({ allowFailure: true, batchSize: 0, contracts: ids.map((id) => ({ address: NPM, abi: npmAbi, functionName: 'ownerOf', args: [id] }) as const) })
    const owned = ids.filter((_, i) => owners[i].status === 'success' && same(owners[i].result as string, wallet))
    if (!owned.length) return []
    const infos = await pub.multicall({ allowFailure: false, batchSize: 0, contracts: owned.map((id) => ({ address: NPM, abi: npmAbi, functionName: 'positions', args: [id] }) as const) })
    const out: RawPosition[] = []
    for (let i = 0; i < owned.length; i++) {
      const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = infos[i]
      out.push({ id: owned[i], pool: await pool(token0, token1, fee), tickLower, tickUpper, liquidity })
    }
    return out
  }
  // 未领手续费 = 已结算的 tokensOwed + 流动性 × (区间内手续费增长 − 上次结算值) / 2^128
  async function fees(p: RawPosition): Promise<[bigint, bigint]> {
    const addr = poolOf(p)
    const [pos, s, g0, g1, lo, hi] = await Promise.all([
      pub.readContract({ address: NPM, abi: npmAbi, functionName: 'positions', args: [p.id] }),
      slot0(p.pool),
      pub.readContract({ address: addr, abi: poolAbi, functionName: 'feeGrowthGlobal0X128' }), pub.readContract({ address: addr, abi: poolAbi, functionName: 'feeGrowthGlobal1X128' }),
      pub.readContract({ address: addr, abi: poolAbi, functionName: 'ticks', args: [p.tickLower] }), pub.readContract({ address: addr, abi: poolAbi, functionName: 'ticks', args: [p.tickUpper] }),
    ])
    const [, , , , , , , liquidity, last0, last1, owed0, owed1] = pos
    if (liquidity !== p.liquidity) throw new Error(`仓位 ${p.id}: 流动性已变化（${liquidity} ≠ ${p.liquidity}），请刷新`)
    const inside = v4.feeGrowthInside(s.tick, p.tickLower, p.tickUpper, [g0, g1], [lo[2], lo[3]], [hi[2], hi[3]])
    const [f0, f1] = v4.feesOwed(liquidity, inside, [last0, last1])
    return [owed0 + f0, owed1 + f1]
  }
  // 从回执里把 NPM 事件和它前面最近的池事件配对（NPM 的 IncreaseLiquidity 紧跟池的 Mint、DecreaseLiquidity 跟 Burn、Collect 跟 Collect），拿到池地址和 tick 区间
  function parsePoolEvents(logs: Log[]) {
    const npmEvents = parseEventLogs({ abi: npmAbi, logs }).filter((l) => same(l.address, NPM) && ['IncreaseLiquidity', 'DecreaseLiquidity', 'Collect'].includes(l.eventName))
    const poolEvents = parseEventLogs({ abi: poolAbi, logs }).filter((l) => !same(l.address, NPM))
    return npmEvents.map((e) => {
      const before = poolEvents.filter((p) => p.logIndex < e.logIndex && (e.eventName === 'IncreaseLiquidity' ? p.eventName === 'Mint' : e.eventName === 'DecreaseLiquidity' ? p.eventName === 'Burn' : p.eventName === 'Collect'))
      const p = before[before.length - 1]
      return p ? { e, pool: p.address, tickLower: (p.args as any).tickLower as number, tickUpper: (p.args as any).tickUpper as number } : null
    }).filter((x): x is NonNullable<typeof x> => !!x)
  }

  return {
    protocol: 'v3', label, manager: NPM, permit2: A.permit2, tiers, spacingFor,
    pool: (token, fee) => pool(cfg.quote.address, token, fee),
    poolById: async (id) => {
      try {
        const addr = getAddress(id)
        const [t0, t1, fee] = await Promise.all([
          pub.readContract({ address: addr, abi: poolAbi, functionName: 'token0' }), pub.readContract({ address: addr, abi: poolAbi, functionName: 'token1' }), pub.readContract({ address: addr, abi: poolAbi, functionName: 'fee' }),
        ])
        const p = await pool(t0, t1, fee)
        return same(p.id, addr) ? p : null // 只接受当前链配置的工厂创建的池
      } catch { return null }
    },
    slot0,
    slot0At: (p, block) => slot0(p, block),
    liquidityAt: (id, blockNumber) => archive.readContract({ address: NPM, abi: npmAbi, functionName: 'positions', args: [id], blockNumber }).then((r) => r[7], (e) => { if (/Invalid token ID/i.test(String(e?.message))) return 0n; throw e }), // 已销毁的 NFT 会 revert 'Invalid token ID' = 0；读链失败照常抛出
    liquidity: (p) => pub.readContract({ address: p.id as Address, abi: poolAbi, functionName: 'liquidity' }),
    swapFee: (_s, _z, p) => p.fee, // 协议费从 LP 费里分，交易者付的就是池费率
    ownedIds, positions, fees,
    quoteExactIn: async (p, zeroForOne, amountIn) => {
      const [tokenIn, tokenOut] = zeroForOne ? [p.currency0, p.currency1] : [p.currency1, p.currency0]
      const [out] = await pub.readContract({ address: QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn, tokenOut, amountIn, fee: p.fee, sqrtPriceLimitX96: 0n }] })
      return out
    },
    // NPM.multicall([createAndInitializePoolIfNecessary?, mint ×n])：NPM 按 amountDesired 自己算流动性，我们把含余量的上限当 desired、按计划量的下限做滑点检查
    mintTx: async (kit, p, specs, owner, init) => {
      const [max0, max1] = specs.reduce(([a, b], s) => [a + s.amount0Max, b + s.amount1Max], [0n, 0n])
      for (const [cur, max] of [[p.currency0, max0], [p.currency1, max1]] as const) if (max > 0n) await kit.ensureErc20Approval(cur, max, NPM, 'PositionManager')
      const calls: Hex[] = []
      if (init) calls.push(encodeFunctionData({ abi: npmAbi, functionName: 'createAndInitializePoolIfNecessary', args: [p.currency0, p.currency1, p.fee, init] }))
      for (const s of specs) calls.push(encodeFunctionData({ abi: npmAbi, functionName: 'mint', args: [{
        token0: p.currency0, token1: p.currency1, fee: p.fee, tickLower: s.tickLower, tickUpper: s.tickUpper,
        amount0Desired: s.amount0Max, amount1Desired: s.amount1Max, amount0Min: s.amount0Min, amount1Min: s.amount1Min, recipient: owner, deadline: deadline(),
      }] }))
      return { to: NPM, data: encodeFunctionData({ abi: npmAbi, functionName: 'multicall', args: [calls] }) }
    },
    mintIds: (logs) => parseEventLogs({ abi: npmAbi, eventName: 'Transfer', logs }).filter((l) => same(l.address, NPM) && same(l.args.from!, ZERO)).map((l) => l.args.tokenId!),
    // 每个仓位：撤全部流动性 -> 领走本金+手续费 -> 销毁 NFT，所有仓位合成一笔 multicall
    burnTx: (_p, ps, recipient) => ({ to: NPM, data: encodeFunctionData({ abi: npmAbi, functionName: 'multicall', args: [ps.flatMap((x) => [
      encodeFunctionData({ abi: npmAbi, functionName: 'decreaseLiquidity', args: [{ tokenId: x.id, liquidity: x.liquidity, amount0Min: x.amount0Min, amount1Min: x.amount1Min, deadline: deadline() }] }),
      encodeFunctionData({ abi: npmAbi, functionName: 'collect', args: [{ tokenId: x.id, recipient, amount0Max: maxUint128, amount1Max: maxUint128 }] }),
      encodeFunctionData({ abi: npmAbi, functionName: 'burn', args: [x.id] }),
    ])] }) }),
    // 撤一部分：decreaseLiquidity 指定数量 -> collect 领走撤出的本金 + 全部手续费，不 burn
    decreaseTx: (_p, ps, recipient) => ({ to: NPM, data: encodeFunctionData({ abi: npmAbi, functionName: 'multicall', args: [ps.flatMap((x) => [
      encodeFunctionData({ abi: npmAbi, functionName: 'decreaseLiquidity', args: [{ tokenId: x.id, liquidity: x.liquidity, amount0Min: x.amount0Min, amount1Min: x.amount1Min, deadline: deadline() }] }),
      encodeFunctionData({ abi: npmAbi, functionName: 'collect', args: [{ tokenId: x.id, recipient, amount0Max: maxUint128, amount1Max: maxUint128 }] }),
    ])] }) }),
    collectTx: (groups, recipient) => ({ to: NPM, data: encodeFunctionData({ abi: npmAbi, functionName: 'multicall', args: [groups.flatMap((g) => g.ids.map((id) =>
      encodeFunctionData({ abi: npmAbi, functionName: 'collect', args: [{ tokenId: id, recipient, amount0Max: maxUint128, amount1Max: maxUint128 }] })))] }) }),
    poolSwapTx: async (kit, p, zeroForOne, amount, dl) => {
      const [tokenIn, tokenOut] = zeroForOne ? [p.currency0, p.currency1] : [p.currency1, p.currency0]
      const maxIn = 'exactIn' in amount ? amount.exactIn : amount.maxIn
      await kit.ensureErc20Approval(tokenIn, maxIn, ROUTER, 'SwapRouter')
      const data = 'exactIn' in amount
        ? encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [{ tokenIn, tokenOut, fee: p.fee, recipient: wallet, deadline: dl, amountIn: amount.exactIn, amountOutMinimum: amount.minOut, sqrtPriceLimitX96: 0n }] })
        : encodeFunctionData({ abi: routerAbi, functionName: 'exactOutputSingle', args: [{ tokenIn, tokenOut, fee: p.fee, recipient: wallet, deadline: dl, amountOut: amount.exactOut, amountInMaximum: amount.maxIn, sqrtPriceLimitX96: 0n }] })
      return { to: ROUTER, data }
    },
    // v3 的滑点回滚是字符串原因：NPM 的 'Price slippage check'、SwapRouter 的 'Too little received' / 'Too much requested'，没有数量
    slippageRevert: (e) => {
      for (let x: any = e; x; x = x.cause) {
        const s = `${x.reason ?? ''} ${x.shortMessage ?? ''} ${x.message ?? ''}`
        if (/Price slippage check/.test(s)) return { kind: 'max' }
        if (/Too little received/.test(s)) return { kind: 'min' }
        if (/Too much requested/.test(s)) return { kind: 'max' }
      }
      return null
    },
    ticks: async (p, lo, hi) => {
      const addr = p.id as Address, spacing = p.spacing, comp = (t: number) => Math.floor(t / spacing)
      const w0 = Math.floor(comp(lo) / 256), w1 = Math.floor(comp(hi) / 256)
      if (w1 - w0 > 120) throw new Error('区间太宽，暂不画深度图')
      const words = Array.from({ length: w1 - w0 + 1 }, (_, i) => w0 + i)
      const bitmaps = await pub.multicall({ allowFailure: false, batchSize: 0, contracts: words.map((w) => ({ address: addr, abi: poolAbi, functionName: 'tickBitmap', args: [w] }) as const) })
      const inits: number[] = []
      bitmaps.forEach((bm, i) => { for (let b = 0; b < 256; b++) if ((bm >> BigInt(b)) & 1n) { const t = (words[i] * 256 + b) * spacing; if (t > lo && t < hi) inits.push(t) } })
      const r = await pub.multicall({ allowFailure: false, batchSize: 0, contracts: inits.map((t) => ({ address: addr, abi: poolAbi, functionName: 'ticks', args: [t] }) as const) })
      return { inits, net: new Map(inits.map((t, i) => [t, r[i][1]])) }
    },
    // 资金流水：钱包直接和各个池合约转账（NPM 只是代跑），所以对手方不固定；数量直接取 NPM 事件
    ledger: {
      counterparty: null,
      parseMods: (logs): Mod[] => parsePoolEvents(logs).map(({ e, pool, tickLower, tickUpper }) => ({
        id: e.args.tokenId, poolId: pool, tickLower, tickUpper,
        delta: e.eventName === 'IncreaseLiquidity' ? e.args.liquidity : e.eventName === 'DecreaseLiquidity' ? -e.args.liquidity : 0n,
      })),
      parseDirect: (logs): DirectEvent[] => {
        const byId = new Map<bigint, DirectEvent>()
        for (const { e, pool, tickLower, tickUpper } of parsePoolEvents(logs)) {
          const cur = byId.get(e.args.tokenId) ?? { id: e.args.tokenId, poolId: pool, tickLower, tickUpper, action: 'collect' as const, amount0: 0n, amount1: 0n, principal0: 0n, principal1: 0n }
          if (e.eventName === 'IncreaseLiquidity') Object.assign(cur, { action: 'add', amount0: cur.amount0 + e.args.amount0, amount1: cur.amount1 + e.args.amount1, principal0: cur.principal0 + e.args.amount0, principal1: cur.principal1 + e.args.amount1 })
          else if (e.eventName === 'DecreaseLiquidity') Object.assign(cur, { action: 'remove', principal0: cur.principal0 + e.args.amount0, principal1: cur.principal1 + e.args.amount1 })
          else if (e.eventName === 'Collect') Object.assign(cur, { amount0: cur.amount0 + e.args.amount0, amount1: cur.amount1 + e.args.amount1 }) // Collect：本金 + 手续费一起到账
          byId.set(e.args.tokenId, cur)
        }
        return [...byId.values()]
      },
    },
  }
}
