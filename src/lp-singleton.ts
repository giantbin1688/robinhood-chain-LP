// Uniswap v4（Robinhood）和 PancakeSwap Infinity CLAMM（BSC）的适配：同一套 singleton 架构（PoolManager 记账、PositionManager 发 NFT、
// Permit2 授权、UniversalRouter 池内换币、动作字节完全相同），差别只在 PoolKey 结构、状态读取合约和几个字段：
//   v4        PoolKey{currency0,currency1,fee,tickSpacing,hooks}                  状态读 StateView          换币参数多一个 minHopPriceX36（Robinhood 的 UR 2.1.1）
//   Infinity  PoolKey{currency0,currency1,hooks,poolManager,fee,parameters}       状态读 CLPoolManager 本身   parameters 第 16 位起是 tickSpacing，低 16 位是 hook 回调位图
import { createPublicClient, encodeAbiParameters, encodeFunctionData, getAddress, http, keccak256, numberToHex, parseAbi, parseAbiItem, parseEventLogs, type Address, type Hex, type Log } from 'viem'
import * as v4 from './v4.ts'
import type { ProtocolName } from './chains.ts'
import type { Kit, Lp, LpDeps, MintSpec, Mod, Pool, RawPosition, Slot0, Tx } from './lp.ts'

const DYNAMIC_FEE_FLAG = 0x800000
const ZERO = v4.ZERO_ADDRESS

const V4_KEY = 'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }'
const INFI_KEY = 'struct PoolKey { address currency0; address currency1; address hooks; address poolManager; uint24 fee; bytes32 parameters; }'
const INFI_KEY_ABI = {
  type: 'tuple', components: [
    { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'hooks', type: 'address' },
    { name: 'poolManager', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'parameters', type: 'bytes32' },
  ],
} as const
type InfiKey = { currency0: Address; currency1: Address; hooks: Address; poolManager: Address; fee: number; parameters: Hex }

const posmAbiOf = (keyStruct: string) => parseAbi([
  keyStruct,
  'struct PermitDetails { address token; uint160 amount; uint48 expiration; uint48 nonce; }',
  'struct PermitSingle { PermitDetails details; address spender; uint256 sigDeadline; }',
  'function permit(address owner, PermitSingle permitSingle, bytes signature) payable returns (bytes err)',
  'function initializePool(PoolKey key, uint160 sqrtPriceX96) payable returns (int24)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
  'function multicall(bytes[] data) payable returns (bytes[])',
  'function ownerOf(uint256 id) view returns (address)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (PoolKey poolKey, uint256 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)',
  'function poolKeys(bytes25 poolId) view returns (PoolKey key)', // 只要有人通过 PositionManager 在这个池建过仓就有记录；带 hook 的池也能由此拿到完整 key
  'event Transfer(address indexed from, address indexed to, uint256 indexed id)',
])
const quoterAbiOf = (keyStruct: string) => parseAbi([ // 声明成 view 以便 eth_call；Quoter 内部靠 revert 取数，不改状态
  keyStruct, 'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) view returns (uint256 amountOut, uint256 gasEstimate)',
])
// 状态读取：v4 走 StateView；Infinity 的 CLPoolManager 自带同名 getter，只是 tick / 仓位信息是结构体
const stateViewAbi = parseAbi([
  'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32) view returns (uint128)',
  'function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)',
  'function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
  'function getTickBitmap(bytes32 poolId, int16 tick) view returns (uint256 tickBitmap)',
  'function getTickLiquidity(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)',
])
const clpmAbi = parseAbi([
  'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32) view returns (uint128)',
  'function getFeeGrowthGlobals(bytes32) view returns (uint256 feeGrowthGlobal0x128, uint256 feeGrowthGlobal1x128)',
  'function getPoolTickInfo(bytes32 id, int24 tick) view returns ((uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128))',
  'function getPoolBitmapInfo(bytes32 id, int16 word) view returns (uint256 tickBitmap)',
  'function getPosition(bytes32 id, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns ((uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128))',
])
const modifyLiquidityEvent = parseAbiItem('event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)')
// v4 PoolManager 建池事件，字段就是完整 PoolKey（Infinity 的同名事件布局不同，这里不用）
const v4InitializeEvent = parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)')
const v4SwapEvent = parseAbiItem('event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)')
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export async function singletonLp(protocol: ProtocolName, d: LpDeps): Promise<Lp> {
  const { pub, wallet, cfg } = d
  const infi = protocol === 'infinity'
  const A = cfg.contracts[protocol]! as unknown as Record<string, Address>
  const minHop = cfg.contracts[protocol]!.urMinHop === true
  const POSM = A.positionManager, PM = A.poolManager, QUOTER = A.quoter, UR = A.universalRouter, STATE = infi ? PM : A.stateView
  const keyStruct = infi ? INFI_KEY : V4_KEY
  const keyAbi = infi ? INFI_KEY_ABI : v4.POOL_KEY_ABI
  const posmAbi = posmAbiOf(keyStruct), quoterAbi = quoterAbiOf(keyStruct)
  const label = infi ? 'PancakeSwap Infinity' : 'Uniswap v4'

  // ---- PoolKey ----
  const makeKey = (a: Address, b: Address, fee: number, spacing: number): unknown => {
    if (!infi) return v4.makePoolKey(a, b, fee, spacing)
    const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a]
    return { currency0, currency1, hooks: ZERO, poolManager: PM, fee, parameters: numberToHex(BigInt(spacing) << 16n, { size: 32 }) } satisfies InfiKey
  }
  const idOf = (key: unknown): Hex => (infi ? keccak256(encodeAbiParameters([INFI_KEY_ABI], [key as InfiKey])) : v4.poolId(key as v4.PoolKey))
  const fromKey = (key: unknown): Omit<Pool, 'dynamic'> => {
    if (infi) {
      const k = key as InfiKey
      return { id: idOf(k), key: k, currency0: k.currency0, currency1: k.currency1, fee: k.fee, spacing: Number((BigInt(k.parameters) >> 16n) & 0xffffffn), hooks: k.hooks }
    }
    const k = key as v4.PoolKey
    return { id: idOf(k), key: k, currency0: k.currency0, currency1: k.currency1, fee: k.fee, spacing: k.tickSpacing, hooks: k.hooks }
  }
  // 动态费率池：key 里的 fee 是标志位，实际费率看 slot0.lpFee（hook 不写入池状态时为 0，界面标"动态"）
  const withDynamic = async (p: Omit<Pool, 'dynamic'>): Promise<Pool> => {
    if (!(p.fee & DYNAMIC_FEE_FLAG)) return p
    const s = await slot0(p as Pool)
    return { ...p, fee: s.lpFee, dynamic: true }
  }

  async function slot0(pool: Pool, blockNumber?: bigint): Promise<Slot0> {
    const [sqrtP, tick, protocolFee, lpFee] = await pub.readContract({ address: STATE, abi: stateViewAbi, functionName: 'getSlot0', args: [pool.id], ...(blockNumber ? { blockNumber } : {}) })
    return { sqrtP, tick, protocolFee, lpFee }
  }
  const liquidity = (pool: Pool) => pub.readContract({ address: STATE, abi: stateViewAbi, functionName: 'getLiquidity', args: [pool.id] })

  // 仓位在 PoolManager 里的 key：owner = PositionManager，salt = tokenId
  const salt = (id: bigint) => numberToHex(id, { size: 32 })
  async function fees(p: RawPosition): Promise<[bigint, bigint]> {
    const pid = p.pool.id
    let inside: [bigint, bigint], liq: bigint, last: [bigint, bigint]
    if (!infi) {
      const [[in0, in1], [l, last0, last1]] = await Promise.all([
        pub.readContract({ address: STATE, abi: stateViewAbi, functionName: 'getFeeGrowthInside', args: [pid, p.tickLower, p.tickUpper] }),
        pub.readContract({ address: STATE, abi: stateViewAbi, functionName: 'getPositionInfo', args: [pid, POSM, p.tickLower, p.tickUpper, salt(p.id)] }),
      ])
      inside = [in0, in1]; liq = l; last = [last0, last1]
    } else {
      const [[g0, g1], lo, hi, pos, s] = await Promise.all([
        pub.readContract({ address: PM, abi: clpmAbi, functionName: 'getFeeGrowthGlobals', args: [pid] }),
        pub.readContract({ address: PM, abi: clpmAbi, functionName: 'getPoolTickInfo', args: [pid, p.tickLower] }),
        pub.readContract({ address: PM, abi: clpmAbi, functionName: 'getPoolTickInfo', args: [pid, p.tickUpper] }),
        pub.readContract({ address: PM, abi: clpmAbi, functionName: 'getPosition', args: [pid, POSM, p.tickLower, p.tickUpper, salt(p.id)] }),
        slot0(p.pool),
      ])
      inside = v4.feeGrowthInside(s.tick, p.tickLower, p.tickUpper, [g0, g1], [lo.feeGrowthOutside0X128, lo.feeGrowthOutside1X128], [hi.feeGrowthOutside0X128, hi.feeGrowthOutside1X128])
      liq = pos.liquidity; last = [pos.feeGrowthInside0LastX128, pos.feeGrowthInside1LastX128]
    }
    if (liq !== p.liquidity) throw new Error(`仓位 ${p.id}: PoolManager 里的流动性 ${liq} 与 PositionManager 的 ${p.liquidity} 不一致`)
    return v4.feesOwed(liq, inside, last)
  }

  // 钱包名下 PositionManager NFT 的转入/转出记录：优先 alchemy_getAssetTransfers（两个方向并发）；Robinhood 没有 Alchemy 时退回公共节点全链 eth_getLogs
  // （只扫转入方向，失败隔几秒再试）；BSC 链太长扫不动，没有 Alchemy 就只能靠 positions.json
  async function ownedIds() {
    const mints = new Map<string, { block: bigint; tx: Hex }>()
    const held = new Map<string, number>()
    const note = (id: bigint, from: Address, to: Address, block: bigint, tx: Hex) => {
      const k = id.toString()
      if (same(to, wallet)) { held.set(k, (held.get(k) ?? 0) + 1); if (same(from, ZERO)) mints.set(k, { block, tx }) }
      if (same(from, wallet)) held.set(k, (held.get(k) ?? 0) - 1)
    }
    const ids = () => [...held].filter(([, n]) => n > 0).map(([k]) => BigInt(k))
    if (d.rpcIsAlchemy) {
      const page = async (dir: 'toAddress' | 'fromAddress') => {
        for (let pageKey: string | undefined; ; ) {
          const r: any = await pub.request({ method: 'alchemy_getAssetTransfers', params: [{ fromBlock: '0x0', toBlock: 'latest', [dir]: wallet, contractAddresses: [POSM], category: ['erc721'], maxCount: '0x3e8', ...(pageKey ? { pageKey } : {}) }] } as any)
          for (const t of r.transfers) note(BigInt(t.erc721TokenId), getAddress(t.from), getAddress(t.to ?? ZERO), BigInt(t.blockNum), t.hash)
          if (!(pageKey = r.pageKey)) return
        }
      }
      try { await Promise.all([page('toAddress'), page('fromAddress')]); return { ids: ids(), mints, complete: true } }
      catch (e: any) { d.log(`alchemy_getAssetTransfers 失败${cfg.name === 'robinhood' ? '，改用公共节点扫描' : '，只看 positions.json 记录的仓位'}: ${String(e?.shortMessage ?? e?.message).slice(0, 80)}`) }
    }
    if (cfg.name !== 'robinhood') return { ids: [], mints, complete: false }
    const scan = createPublicClient({ transport: http(cfg.publicRpc) })
    for (let attempt = 1; ; attempt++) {
      try {
        const logs = await scan.getLogs({ address: POSM, event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed id)'), args: { to: wallet }, fromBlock: 0n })
        for (const l of logs) note(l.args.id!, l.args.from!, l.args.to!, l.blockNumber, l.transactionHash)
        return { ids: ids(), mints, complete: true }
      } catch (e: any) {
        if (attempt >= 3) throw e
        d.log(`公共节点扫描失败 (${String(e?.shortMessage ?? e?.message).slice(0, 60)})，${3 * attempt}s 后重试`)
        await new Promise((r) => setTimeout(r, 3000 * attempt))
      }
    }
  }

  // 逐个 NFT 的只读调用用 multicall 合成一个 eth_call：网页撤流动性不销毁 NFT，钱包里会攒下几十个空仓位，逐个查会撞节点的每秒额度
  async function positions(ids: bigint[]): Promise<RawPosition[]> {
    if (!ids.length) return []
    const owners = await pub.multicall({ allowFailure: true, batchSize: 0, contracts: ids.map((id) => ({ address: POSM, abi: posmAbi, functionName: 'ownerOf', args: [id] }) as const) })
    const owned = ids.filter((_, i) => owners[i].status === 'success' && same(owners[i].result as string, wallet)) // 已销毁的 ownerOf 会 revert
    if (!owned.length) return []
    const infos = await pub.multicall({ allowFailure: false, batchSize: 0, contracts: owned.flatMap((id) => [
      { address: POSM, abi: posmAbi, functionName: 'getPoolAndPositionInfo', args: [id] } as const,
      { address: POSM, abi: posmAbi, functionName: 'getPositionLiquidity', args: [id] } as const,
    ]) })
    const out: RawPosition[] = []
    for (let i = 0; i < owned.length; i++) {
      const [key, info] = infos[2 * i] as readonly [unknown, bigint]
      out.push({ id: owned[i], pool: await withDynamic(fromKey(key)), liquidity: infos[2 * i + 1] as bigint, ...v4.decodePositionInfo(info) })
    }
    return out
  }

  const permitCall = async (kit: Kit, cur: Address, max: bigint, owner: Address) => {
    await kit.ensureErc20Approval(cur, max)
    const p = await kit.permitFor(cur, POSM, max)
    return p ? encodeFunctionData({ abi: posmAbi, functionName: 'permit', args: [owner, p.permitSingle, p.signature] }) : null
  }

  return {
    protocol, label, manager: POSM, permit2: A.permit2,
    tiers: infi ? [{ fee: 100, spacing: 1 }, { fee: 500, spacing: 10 }, { fee: 2500, spacing: 50 }, { fee: 10000, spacing: 200 }] : [{ fee: 500, spacing: 10 }, { fee: 3000, spacing: 60 }, { fee: 10000, spacing: 200 }],
    spacingFor: (fee) => Math.max(1, Math.round(fee / 50)),
    pool: async (token, fee, spacing) => fromKey(makeKey(cfg.quote.address, token, fee, spacing)) as Pool,
    // poolKeys 只记录有人通过 PositionManager 建过仓的池；发行平台直接调 PoolManager 建的池查不到，
    // 退到公共节点按 topics[1]=poolId 全链查 Initialize 事件——过滤够窄，Robinhood 公共节点几百毫秒能返回；Alchemy 免费档 eth_getLogs 只给 10 个区块，BSC 公共节点全链扫不动
    poolById: async (id) => {
      const key = await pub.readContract({ address: POSM, abi: posmAbi, functionName: 'poolKeys', args: [id.slice(0, 52) as Hex] })
      if (BigInt((key as { currency1: Address }).currency1) !== 0n) {
        const p = fromKey(key)
        return p.id === id ? withDynamic(p) : null
      }
      if (infi || cfg.name !== 'robinhood') return null
      const scan = createPublicClient({ transport: http(cfg.publicRpc) })
      // 公共节点偶发 "log query timed out" / 429，隔几秒重试；三次都不行就抛错，别把读链失败说成"没有这个池"
      let logs: { args: { currency0?: Address; currency1?: Address; fee?: number; tickSpacing?: number; hooks?: Address } }[] = []
      for (let attempt = 1; ; attempt++) {
        try { logs = await scan.getLogs({ address: PM, event: v4InitializeEvent, args: { id }, fromBlock: 0n }); break }
        catch (e: any) {
          if (attempt >= 3) throw new Error(`查 Initialize 事件失败: ${String(e?.details ?? e?.shortMessage ?? e?.message).slice(0, 80)}`)
          await new Promise((r) => setTimeout(r, 3000 * attempt))
        }
      }
      const [l] = logs
      if (!l) return null
      const p = fromKey({ currency0: l.args.currency0!, currency1: l.args.currency1!, fee: l.args.fee!, tickSpacing: l.args.tickSpacing!, hooks: l.args.hooks! } satisfies v4.PoolKey)
      return p.id === id ? withDynamic(p) : null
    },
    slot0, liquidity,
    slot0At: (pool, block) => slot0(pool, block),
    liquidityAt: (id, blockNumber) => pub.readContract({ address: POSM, abi: posmAbi, functionName: 'getPositionLiquidity', args: [id], blockNumber }), // 不存在 / 已销毁的仓位合约本身就返回 0；读链失败要抛出去，不能当成 0
    // v4 的 calculateSwapFee：协议费按方向取 12 位，与 LP 费合成
    swapFee: (s, zeroForOne, pool) => {
      const pf = zeroForOne ? s.protocolFee & 0xfff : s.protocolFee >> 12
      const lp = pool.dynamic && s.lpFee === 0 ? pool.feeHint ?? 0 : s.lpFee
      return pf + lp - Math.floor((pf * lp) / 1_000_000)
    },
    ownedIds, positions, fees,
    quoteExactIn: async (pool, zeroForOne, amountIn) => {
      const [out] = await pub.readContract({ address: QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: pool.key as any, zeroForOne, exactAmount: amountIn, hookData: '0x' }] })
      return out
    },
    // PositionManager.multicall([permit…, initializePool?, modifyLiquidities(MINT ×n)])：同一个池的几个仓位在一笔交易里原子创建，各自有 amountMax、最后合并结算
    mintTx: async (kit, pool, specs, owner, init) => {
      const calls: Hex[] = []
      const [max0, max1] = specs.reduce(([a, b], s) => [a + s.amount0Max, b + s.amount1Max], [0n, 0n])
      for (const [cur, max] of [[pool.currency0, max0], [pool.currency1, max1]] as const) {
        if (max === 0n) continue
        const c = await permitCall(kit, cur, max, owner)
        if (c) calls.push(c)
      }
      if (init) calls.push(encodeFunctionData({ abi: posmAbi, functionName: 'initializePool', args: [pool.key as any, init] }))
      const unlockData = v4.encodeMintUnlockData(pool.key, specs, owner, keyAbi)
      calls.push(encodeFunctionData({ abi: posmAbi, functionName: 'modifyLiquidities', args: [unlockData, BigInt(Math.floor(Date.now() / 1000) + 600)] }))
      return { to: POSM, data: encodeFunctionData({ abi: posmAbi, functionName: 'multicall', args: [calls] }) }
    },
    mintIds: (logs) => parseEventLogs({ abi: posmAbi, eventName: 'Transfer', logs }).filter((l) => same(l.address, POSM) && same(l.args.from!, ZERO)).map((l) => l.args.id!),
    burnTx: (pool, ps, recipient) => ({ to: POSM, data: encodeFunctionData({ abi: posmAbi, functionName: 'modifyLiquidities', args: [v4.encodeBurnUnlockData(pool, ps, recipient), BigInt(Math.floor(Date.now() / 1000) + 600)] }) }),
    decreaseTx: (pool, ps, recipient) => ({ to: POSM, data: encodeFunctionData({ abi: posmAbi, functionName: 'modifyLiquidities', args: [v4.encodeDecreaseUnlockData(pool, ps, recipient), BigInt(Math.floor(Date.now() / 1000) + 600)] }) }),
    // 所有池的领取合成 1 笔：multicall([modifyLiquidities(池1), modifyLiquidities(池2), …])；只有一个池就直接调
    collectTx: (groups, recipient) => {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
      const calls = groups.map((g) => encodeFunctionData({ abi: posmAbi, functionName: 'modifyLiquidities', args: [v4.encodeCollectUnlockData(g.pool, g.ids, recipient), deadline] }))
      return { to: POSM, data: calls.length === 1 ? calls[0] : encodeFunctionData({ abi: posmAbi, functionName: 'multicall', args: [calls] }) }
    },
    poolSwapTx: async (kit, pool, zeroForOne, amount, deadline) => {
      const cin = zeroForOne ? pool.currency0 : pool.currency1
      const maxIn = 'exactIn' in amount ? amount.exactIn : amount.maxIn
      await kit.ensureErc20Approval(cin, maxIn)
      const permit = await kit.permitFor(cin, UR, maxIn)
      return { to: UR, data: v4.encodeV4SwapCalldata(pool.key, zeroForOne, amount, deadline, permit, { keyAbi, minHop }) }
    },
    // PositionManager 的滑点回滚：MaximumAmountExceeded(uint128 max, uint128 requested) / MinimumAmountInsufficient(uint128 min, uint128 received)，从 viem 错误链里取 revert data 解出来
    slippageRevert: (e) => {
      for (let x: any = e; x; x = x.cause) {
        const data: unknown = x.data
        if (typeof data !== 'string' || data.length !== 10 + 128) continue
        const kind = data.startsWith('0x31e30ad0') ? 'max' : data.startsWith('0x12816f22') ? 'min' : null
        if (kind) return { kind, limit: BigInt('0x' + data.slice(10, 74)), actual: BigInt('0x' + data.slice(74, 138)) }
      }
      return null
    },
    // tick 位图找出范围内所有已初始化的 tick，再读各自的 liquidityNet（两轮 multicall）
    ticks: async (pool, lo, hi) => {
      const spacing = pool.spacing, comp = (t: number) => Math.floor(t / spacing)
      const w0 = Math.floor(comp(lo) / 256), w1 = Math.floor(comp(hi) / 256)
      if (w1 - w0 > 120) throw new Error('区间太宽，暂不画深度图')
      const words = Array.from({ length: w1 - w0 + 1 }, (_, i) => w0 + i)
      const bitmaps = infi
        ? await pub.multicall({ allowFailure: false, batchSize: 0, contracts: words.map((w) => ({ address: PM, abi: clpmAbi, functionName: 'getPoolBitmapInfo', args: [pool.id, w] }) as const) })
        : await pub.multicall({ allowFailure: false, batchSize: 0, contracts: words.map((w) => ({ address: STATE, abi: stateViewAbi, functionName: 'getTickBitmap', args: [pool.id, w] }) as const) })
      const inits: number[] = []
      bitmaps.forEach((bm, i) => { for (let b = 0; b < 256; b++) if ((bm >> BigInt(b)) & 1n) { const t = (words[i] * 256 + b) * spacing; if (t > lo && t < hi) inits.push(t) } })
      const net = new Map<number, bigint>()
      if (infi) {
        const r = await pub.multicall({ allowFailure: false, batchSize: 0, contracts: inits.map((t) => ({ address: PM, abi: clpmAbi, functionName: 'getPoolTickInfo', args: [pool.id, t] }) as const) })
        inits.forEach((t, i) => net.set(t, r[i].liquidityNet))
      } else {
        const r = await pub.multicall({ allowFailure: false, batchSize: 0, contracts: inits.map((t) => ({ address: STATE, abi: stateViewAbi, functionName: 'getTickLiquidity', args: [pool.id, t] }) as const) })
        inits.forEach((t, i) => net.set(t, r[i][1]))
      }
      return { inits, net }
    },
    // 资金流水：代币在钱包和 PoolManager（Infinity 是 Vault）之间转；PoolManager 的 ModifyLiquidity(salt = 仓位 id) 且 sender = PositionManager 的是本工具能管的仓位
    ledger: {
      counterparty: infi ? A.vault : PM,
      parseMods: (logs): Mod[] => parseEventLogs({ abi: [modifyLiquidityEvent], logs })
        .filter((l) => same(l.address, PM) && same(l.args.sender!, POSM))
        .map((l) => ({ id: BigInt(l.args.salt!), poolId: l.args.id!, tickLower: l.args.tickLower!, tickUpper: l.args.tickUpper!, delta: l.args.liquidityDelta!, logIndex:l.logIndex })),
      // 区块末的池价可能来自撤仓之后同区块的另一笔 swap：给出该区块里本池所有改价事件，流水按 logIndex 取操作前一刻的价格。Infinity 的 Swap / Initialize 事件布局不同，暂不提供
      ...(infi ? {} : {
        priceEventsAt: async (pool: Pool, block: bigint) => {
          const [swaps, inits] = await Promise.all([
            pub.getLogs({ address: PM, event: v4SwapEvent, args: { id: pool.id }, fromBlock: block, toBlock: block }),
            pub.getLogs({ address: PM, event: v4InitializeEvent, args: { id: pool.id }, fromBlock: block, toBlock: block }),
          ])
          return [...swaps, ...inits].map((l) => ({ index: l.logIndex, sqrtP: l.args.sqrtPriceX96!, tick: l.args.tick! })).sort((a, b) => a.index - b.index)
        },
      }),
    },
  }
}
