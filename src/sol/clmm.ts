// Raydium CLMM（Solana）的适配：Uniswap v3 式的 tick 集中流动性（sqrtPriceX64、tickSpacing、费率档来自 AmmConfig），仓位是 NFT（id = NFT mint），
// 数学直接复用 v4.ts（sqrtPriceX64 左移 32 位就是 X96，取整误差被滑点余量盖住），形状用 shape.ts 的多层拆分（每个仓位一笔交易）。
// 读链走 SDK 的 getPoolInfoFromRpc（约 4 秒，拉全部 tick 数组，缓存 1 分钟）；池价 / 现价只读池账户（快）
import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js'
import { AnchorProvider, BorshCoder, Program } from '@coral-xyz/anchor'
import { CLMM_PROGRAM_ID, ClmmConfigLayout, Raydium, PoolUtils, PositionUtils, TickArrayLayout, TickArrayUtil, TxVersion, getPdaPersonalPositionAddress, getPdaPoolId, getPdaTickArrayAddress, type ApiV3Token, type ClmmConfigInfo } from '@raydium-io/raydium-sdk-v2'
import BN from 'bn.js'
import { Decimal } from 'decimal.js'
import * as v4 from '../v4.ts'
import * as shapeMath from '../shape.ts'
import { anchorEvents } from './common.ts'
import type { DepthBar, LedgerEvent, MintPlan, MintReq, PoolState, SolLp, SolLpDeps, SolPool, SolPosition, Tier } from './lp.ts'

const PROGRAM = CLMM_PROGRAM_ID
const bn = (x: bigint) => new BN(x.toString())
const big = (x: BN | string | number) => BigInt(String(x))
// 官方费率档（api-v3.raydium.io/main/clmm-config，2026-09 抓取）；启动时再问一次接口，问不到用这份
const KNOWN_CONFIGS: { index: number; id: string; fee: number; step: number }[] = [
  { index: 4, id: '9iFER3bpjf1PTTCQCfTRu17EJgvsxo9pVyA9QWwEuX4x', fee: 100, step: 1 }, { index: 6, id: 'EdPxg8QaeFSrTYqdWJn6Kezwy9McWncTYueD9eMGCuzR', fee: 200, step: 1 },
  { index: 7, id: '9EeWRCL8CJnikDFCDzG8rtmBs5KQR1jEYKCR5rRZ2NEi', fee: 300, step: 1 }, { index: 8, id: '3h2e43PunVA5K34vwKCLHWhZF4aZpyaC9RmxvshGAQpL', fee: 400, step: 1 },
  { index: 5, id: '3XCQJQryqpDvvZBfGxR7CLAw5dpGJ9aa7kt1jRLdyxuZ', fee: 500, step: 1 }, { index: 10, id: 'DrdecJVzkaRsf1TQu1g7iFncaokikVTHqpzPjenjRySY', fee: 1000, step: 10 },
  { index: 11, id: 'J8u7HvA1g1p2CdhBFdsnTxDzGkekRpdw4GrL9MKU2D3U', fee: 1500, step: 10 }, { index: 12, id: 'RPxHtdN5V7ajwkoG6NnwSBAeaX5k9giY37dpp98xTjD', fee: 1600, step: 10 },
  { index: 13, id: '9WjDVMHWCirG9jkchbetHTnSzdXbAPnD9bsoGRcz1xUw', fee: 1800, step: 10 }, { index: 14, id: 'FMrUDGjEe1izXPbn8SZPNjMfB5JvvhVq5ymmpZDebB5R', fee: 2000, step: 10 },
  { index: 1, id: 'E64NGkDLLCdQ2yFNPcavaKptrEgmiQaNykUuLC1Qgwyp', fee: 2500, step: 60 }, { index: 15, id: 'Y6YhgJbt9FRk3JVjwdZtsioVCJwCKhy1hum8HMDYyB1', fee: 4000, step: 60 },
  { index: 16, id: '47Nq74YtwjVeTQF6KFKRKU4cY1Vd5AXBHpYRkubkDLZi', fee: 6000, step: 60 }, { index: 17, id: 'DQeN7dZyQvXKT7YwmgqyuC7AYFkwMoP7RwtucsDEdfYZ', fee: 8000, step: 60 },
  { index: 3, id: 'A1BBtTYJd4i3xU8D6Tc2FzU6ZN4oXZWXKZnCxwbHXr8x', fee: 10000, step: 120 }, { index: 9, id: 'Gex2NJRS3jVLPfbzSFM5d5DRsNoL5ynnwT1TXoDEhanz', fee: 20000, step: 120 },
  { index: 18, id: 'CDpiwv9eLsRvvuzZEJ8CBtK14wdvkSnkub4vmGtzzdK8', fee: 30000, step: 120 }, { index: 19, id: '6tBc3ABLaYTTWu94DiRD5PWi92HML34UpAQ8pPTYgudw', fee: 40000, step: 120 },
]
const sortMints = (a: PublicKey, b: PublicKey) => (Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a])
const apiToken = (mint: string, decimals: number, program: PublicKey): ApiV3Token => ({ chainId: 101, address: mint, programId: program.toBase58(), logoURI: '', symbol: '', name: '', decimals, tags: [], extensions: {} } as ApiV3Token)

export async function clmmLp(d: SolLpDeps): Promise<SolLp> {
  const { conn, wallet } = d
  let rayP: Promise<Raydium> | null = null
  const ray = () => { if (!rayP) { rayP = Raydium.load({ connection: conn, owner: wallet, disableLoadToken: true, disableFeatureCheck: true }); rayP.catch(() => (rayP = null)) } return rayP }
  let configsP: Promise<Tier[]> | null = null
  const tiers = () => {
    if (!configsP) {
      configsP = (async () => {
        let list = KNOWN_CONFIGS
        try { const r: any[] = await (await ray()).api.getClmmConfigs(); if (r?.length) list = r.map((c) => ({ index: c.index, id: c.id, fee: c.tradeFeeRate, step: c.tickSpacing })) } catch { /* 用内置 */ }
        return list.map((c): Tier => ({ fee: c.fee, step: c.step, key: c.id, label: `间距 ${c.step}` })).sort((a, b) => a.fee - b.fee || a.step - b.step)
      })()
      configsP.catch(() => (configsP = null))
    }
    return configsP
  }
  const configInfo = async (id: string): Promise<ClmmConfigInfo> => {
    const t = (await tiers()).find((x) => x.key === id)
    const acc = await conn.getAccountInfo(new PublicKey(id))
    const c: any = acc ? ClmmConfigLayout.decode(acc.data) : null
    return { id: new PublicKey(id), index: c?.index ?? 0, protocolFeeRate: c?.protocolFeeRate ?? 120000, tradeFeeRate: c?.tradeFeeRate ?? t?.fee ?? 0, tickSpacing: c?.tickSpacing ?? t?.step ?? 1, fundFeeRate: c?.fundFeeRate ?? 40000, fundOwner: '', description: '' }
  }
  // 池的完整信息（SDK 的 poolInfo / poolKeys / computePoolInfo / tickData）：慢，缓存 1 分钟；发交易前用 fresh 强制刷新
  const fullCache = new Map<string, { at: number; p: Promise<Awaited<ReturnType<Raydium['clmm']['getPoolInfoFromRpc']>>> }>()
  const full = async (id: string, fresh = false) => {
    const hit = fullCache.get(id)
    if (hit && !fresh && Date.now() - hit.at < 60_000) return hit.p
    const p = ray().then((r) => r.clmm.getPoolInfoFromRpc(id))
    p.catch(() => fullCache.delete(id))
    fullCache.set(id, { at: Date.now(), p })
    return p
  }
  const rpcInfo = async (id: string) => (await ray()).clmm.getRpcClmmPoolInfo({ poolId: id })
  const feeOfConfig = new Map<string, number>()
  const fromRpc = async (id: string, r: any): Promise<SolPool> => {
    const cid = (r.ammConfig ?? r.configId).toBase58()
    if (!feeOfConfig.has(cid)) feeOfConfig.set(cid, (await configInfo(cid)).tradeFeeRate)
    return { id, protocol: 'clmm', mintX: r.mintA.toBase58(), mintY: r.mintB.toBase58(), decX: r.mintDecimalsA, decY: r.mintDecimalsB, step: r.tickSpacing, fee: feeOfConfig.get(cid)!, raw: r }
  }
  const priceAt = (p: SolPool, tick: number) => v4.priceAtTick(tick) * 10 ** (p.decX - p.decY)
  const unitAt = (p: SolPool, price: number, round: 'down' | 'up') => { const x = Math.log(price * 10 ** (p.decY - p.decX)) / Math.log(1.0001); return round === 'down' ? Math.floor(x + 1e-9) : Math.ceil(x - 1e-9) }
  const sqrt96 = (sqrtX64: BN) => BigInt(sqrtX64.toString()) << 32n
  const amounts = (sqrtP: bigint, lower: number, upper: number, L: bigint) => v4.amountsForLiquidity(sqrtP, v4.getSqrtRatioAtTick(lower), v4.getSqrtRatioAtTick(upper), L)
  // tick 状态（手续费增长）：仓位上下沿所在的 tick 数组
  const tickState = async (poolId: string, spacing: number, tick: number) => {
    const addr = getPdaTickArrayAddress(PROGRAM, new PublicKey(poolId), TickArrayUtil.getTickArrayStartIndex(tick, spacing)).publicKey
    const acc = await conn.getAccountInfo(addr)
    if (!acc) return null
    return TickArrayLayout.decode(acc.data).ticks[TickArrayUtil.getTickOffsetInArray(tick, spacing)]
  }
  const toPositions = async (raws: any[]): Promise<SolPosition[]> => {
    if (!raws.length) return []
    const poolIds = [...new Set(raws.map((r) => r.poolId.toBase58() as string))]
    const infos = await (await ray()).clmm.getRpcClmmPoolInfos({ poolIds })
    const out: SolPosition[] = []
    for (const r of raws) {
      const pid = r.poolId.toBase58(), info: any = infos[pid]
      if (!info) continue
      const pool = await fromRpc(pid, info)
      const sqrtP = sqrt96(info.sqrtPriceX64), L = big(r.liquidity)
      const [amountX, amountY] = amounts(sqrtP, r.tickLowerIndex, r.tickUpperIndex, L)
      let feeX = big(r.tokenFeesOwedA), feeY = big(r.tokenFeesOwedB)
      try {
        const [lo, hi] = await Promise.all([tickState(pid, pool.step, r.tickLowerIndex), tickState(pid, pool.step, r.tickUpperIndex)])
        if (lo && hi) { const f = PositionUtils.GetPositionFees(info, r, lo, hi); feeX = big(f.tokenFeeAmountA); feeY = big(f.tokenFeeAmountB) }
      } catch { /* 读不到 tick 数组就只按已结算的 tokensOwed */ }
      out.push({ id: r.nftMint.toBase58(), pool, lower: r.tickLowerIndex, upper: r.tickUpperIndex, amountX, amountY, feeX, feeY, liquidity: L, raw: r })
    }
    return out
  }
  let idlCoder: Promise<BorshCoder | null> | null = null
  const coder = () => { if (!idlCoder) { idlCoder = Program.fetchIdl(PROGRAM, new AnchorProvider(conn, {} as any, {})).then((idl) => (idl ? new BorshCoder(idl as any) : null)).catch(() => null) } return idlCoder }

  return {
    protocol: 'clmm', label: 'Raydium CLMM',
    tiers,
    tierFor: async (fee, step) => (await tiers()).find((t) => t.fee === fee && (step === undefined || t.step === step)) ?? null,
    pool: async (token, quote, tier) => {
      const [a, b] = sortMints(new PublicKey(token), new PublicKey(quote))
      const id = getPdaPoolId(PROGRAM, new PublicKey(tier.key), a, b).publicKey
      const acc = await conn.getAccountInfo(id)
      if (!acc) return null
      return fromRpc(id.toBase58(), await rpcInfo(id.toBase58()))
    },
    poolById: async (id) => { try { new PublicKey(id); const acc = await conn.getAccountInfo(new PublicKey(id)); if (!acc || !acc.owner.equals(PROGRAM)) return null; return fromRpc(id, await rpcInfo(id)) } catch { return null } },
    state: async (pool) => { const r: any = await rpcInfo(pool.id); const sqrtP = sqrt96(r.sqrtPriceX64); return { price: v4.priceFromSqrtX96(sqrtP) * 10 ** (pool.decX - pool.decY), active: r.tickCurrent, hasLiquidity: !new BN(r.liquidity).isZero(), sqrtP } },
    priceAt, unitAt,
    edges: (p) => [priceAt(p.pool, p.lower), priceAt(p.pool, p.upper)],
    inRange: (p, tick) => tick >= p.lower && tick < p.upper,
    ownedPositions: async () => toPositions(await (await ray()).clmm.getOwnerPositionInfo({ programId: PROGRAM })),
    positions: async (ids) => {
      if (!ids.length) return []
      const want = new Set(ids)
      return toPositions((await (await ray()).clmm.getOwnerPositionInfo({ programId: PROGRAM })).filter((r: any) => want.has(r.nftMint.toBase58())))
    },
    quoteSwap: async (pool, xToY, amountIn) => {
      const f = await full(pool.id)
      const r = PoolUtils.computeAmountOut({ poolInfo: f.computePoolInfo, tickarrayBitmapExtension: f.computePoolInfo.exBitmapInfo, tickArrayCache: f.tickData[pool.id], baseMint: new PublicKey(xToY ? pool.mintX : pool.mintY), epochInfo: await conn.getEpochInfo(), amountIn: bn(amountIn), slippage: 0, blockTimestamp: Math.floor(Date.now() / 1000) } as any)
      return { out: big(r.amountOut.amount), endPrice: Number(r.executionPrice.toString()) }
    },
    swapTx: async (pool, xToY, amountIn, minOut) => {
      const f = await full(pool.id, true)
      const r = PoolUtils.computeAmountOut({ poolInfo: f.computePoolInfo, tickarrayBitmapExtension: f.computePoolInfo.exBitmapInfo, tickArrayCache: f.tickData[pool.id], baseMint: new PublicKey(xToY ? pool.mintX : pool.mintY), epochInfo: await conn.getEpochInfo(), amountIn: bn(amountIn), slippage: 0, blockTimestamp: Math.floor(Date.now() / 1000) } as any)
      const { transaction, signers } = await (await ray()).clmm.swap({ poolInfo: f.poolInfo, poolKeys: f.poolKeys, inputMint: xToY ? pool.mintX : pool.mintY, amountIn: bn(amountIn), amountOutMin: bn(minOut), observationId: f.computePoolInfo.observationId, ownerInfo: { useSOLBalance: true }, remainingAccounts: r.remainingAccounts, txVersion: TxVersion.LEGACY })
      return { label: '池内换币', tx: transaction, signers }
    },
    createPoolTx: async (token, quote, tier, price, decX, decY) => {
      const [tm, qm] = await Promise.all([conn.getAccountInfo(new PublicKey(token)), conn.getAccountInfo(new PublicKey(quote))])
      if (!tm || !qm) throw new Error('代币 mint 读不到')
      const r = await (await ray()).clmm.createPool({ programId: PROGRAM, mint1: apiToken(token, decX, tm.owner), mint2: apiToken(quote, decY, qm.owner), ammConfig: await configInfo(tier.key), initialPrice: new Decimal(price), txVersion: TxVersion.LEGACY })
      return { bundles: [{ label: '建池', tx: r.transaction, signers: r.signers }], poolId: r.extInfo.mockPoolInfo.id }
    },
    mintPlan: async (pool, req) => {
      const tokenIs1 = !req.tokenIsX
      // shapeLegs 以现价 tick 为锚点拆层：展示用计划时的现价，真正 build 时按那一刻的池价重拆
      const legsAt = (t: number) => { const l = shapeMath.shapeLegs({ lo: req.lower, hi: req.upper, t, spacing: pool.step, shape: req.shape, layers: req.layers, tokenIs1 }); if (!l.length) throw new Error('区间太窄，拆不出这个形状的仓位'); return l }
      const legs = legsAt(req.active)
      return {
        legs: legs.map((l) => ({ lower: l.lo, upper: l.hi, g: l.g })),
        cost: async () => {
          // 仓位上下沿所在的 tick 数组还没初始化的要付租金（约 0.07 SOL 一个，不退）
          const starts = new Set(legs.flatMap((l) => [TickArrayUtil.getTickArrayStartIndex(l.lo, pool.step), TickArrayUtil.getTickArrayStartIndex(l.hi, pool.step)]))
          const addrs = [...starts].map((st) => getPdaTickArrayAddress(PROGRAM, new PublicKey(pool.id), st).publicKey)
          const missing = (await conn.getMultipleAccountsInfo(addrs)).filter((a) => !a).length
          return { solNeeded: legs.length * 0.012 + missing * 0.072, text: `${legs.length} 个仓位，每个 1 笔交易（铸 NFT）、租金约 0.01 SOL（关闭时退还）${missing ? `；要新建 ${missing} 个 tick 数组，各约 0.07 SOL（不退）` : ''}` }
        },
        yPerX: async (state) => { const { tok, usdg } = shapeMath.mixAt(state.active, legsAt(state.active), tokenIs1); const [x, y] = tokenIs1 ? [usdg, tok] : [tok, usdg]; return x === 0 ? Infinity : y / x },
        build: async (amountX, amountY, state) => {
          const f = await full(pool.id, true)
          const ls = legsAt(state.active)
          const plan = shapeMath.planMints(ls, state.sqrtP!, amountX, amountY, req.lpSlippage)
          if (!plan) throw new Error('算出的流动性为 0（价格在仓位另一侧、手里没有它需要的币）')
          const bundles = [] as { label: string; tx: any; signers: any[] }[], ids: string[] = []
          for (const s of plan.specs) {
            const r = await (await ray()).clmm.openPositionFromLiquidity({ poolInfo: f.poolInfo, poolKeys: f.poolKeys, ownerInfo: { useSOLBalance: true }, amountMaxA: bn(s.amount0Max), amountMaxB: bn(s.amount1Max), tickLower: s.tickLower, tickUpper: s.tickUpper, liquidity: bn(s.liquidity), txVersion: TxVersion.LEGACY, computeBudgetConfig: undefined, nft2022: true, withMetadata: 'no-create' })
            bundles.push({ label: `建仓位 ticks [${s.tickLower}, ${s.tickUpper}]`, tx: r.transaction, signers: r.signers })
            ids.push(r.extInfo.address.nftMint.toBase58())
          }
          return { bundles, ids, useX: plan.sum0, useY: plan.sum1, note: `${ids.length} 个仓位、${bundles.length} 笔交易` }
        },
      } satisfies MintPlan
    },
    burnTx: async (positions, bps, lpSlippage) => {
      const out = [] as { label: string; tx: any; signers: any[] }[]
      const floor = (x: bigint) => { const y = (x * BigInt(Math.round((100 - lpSlippage) * 100))) / 10_000n; return y === x && x > 0n ? x - 1n : y }
      for (const p of positions) {
        const f = await full(p.pool.id, true)
        const st: any = f.rpcPoolInfo
        const fullBurn = bps >= 10_000
        const L = fullBurn ? p.liquidity : (p.liquidity * BigInt(bps)) / 10_000n
        const [a0, a1] = amounts(sqrt96(st.sqrtPriceX64), p.lower, p.upper, L)
        const r = await (await ray()).clmm.decreaseLiquidity({ poolInfo: f.poolInfo, poolKeys: f.poolKeys, ownerPosition: p.raw as any, ownerInfo: { useSOLBalance: true, closePosition: fullBurn }, liquidity: bn(L), amountMinA: bn(floor(a0)), amountMinB: bn(floor(a1)), txVersion: TxVersion.LEGACY })
        out.push({ label: `${fullBurn ? '撤仓位' : `撤 ${bps / 100}%`} ${p.id.slice(0, 6)}…`, tx: r.transaction, signers: r.signers })
      }
      return out
    },
    collectTx: async (positions) => {
      const out = [] as { label: string; tx: any; signers: any[] }[]
      for (const p of positions) {
        const f = await full(p.pool.id, true)
        const r = await (await ray()).clmm.decreaseLiquidity({ poolInfo: f.poolInfo, poolKeys: f.poolKeys, ownerPosition: p.raw as any, ownerInfo: { useSOLBalance: true, closePosition: false }, liquidity: new BN(0), amountMinA: new BN(0), amountMinB: new BN(0), txVersion: TxVersion.LEGACY })
        out.push({ label: `领手续费 ${p.id.slice(0, 6)}…`, tx: r.transaction, signers: r.signers })
      }
      return out
    },
    // 深度：已初始化的 tick 及其 liquidityNet，从现价的活跃流动性向两侧累加得到每段流动性，再折成两种币数量
    depth: async (pool, lower, upper) => {
      const f = await full(pool.id)
      const st: any = f.rpcPoolInfo
      const tick = st.tickCurrent as number, sqrtP = sqrt96(st.sqrtPriceX64)
      const net = new Map<number, bigint>()
      for (const ta of f.tickArrays) for (const t of ta.ticks) if (!new BN(t.liquidityGross).isZero()) net.set(t.tick, big(t.liquidityNet))
      const inits = [...net.keys()].filter((t) => t > lower && t < upper).sort((a, b) => a - b)
      const B = [lower, ...inits, upper]
      const liq: bigint[] = new Array(B.length - 1).fill(0n)
      let cur = B.findIndex((b, k) => k < B.length - 1 && b <= tick && tick < B[k + 1])
      if (cur < 0) cur = tick < lower ? 0 : liq.length - 1
      // 现价在范围外时先把活跃流动性推到边界
      let L = big(st.liquidity)
      if (tick < lower) for (const t of [...net.keys()].filter((t) => t > tick && t <= lower)) L += net.get(t)!
      if (tick >= upper) for (const t of [...net.keys()].filter((t) => t > upper && t <= tick).reverse()) L -= net.get(t)!
      liq[cur] = L
      for (let j = cur + 1; j < liq.length; j++) liq[j] = liq[j - 1] + (net.get(B[j]) ?? 0n)
      for (let j = cur - 1; j >= 0; j--) liq[j] = liq[j + 1] - (net.get(B[j + 1]) ?? 0n)
      return liq.map((l, j): DepthBar => { const [x, y] = l > 0n ? v4.amountsForLiquidity(sqrtP, v4.getSqrtRatioAtTick(Math.max(B[j], v4.MIN_TICK)), v4.getSqrtRatioAtTick(Math.min(B[j + 1], v4.MAX_TICK)), l) : [0n, 0n]; return { lo: B[j], hi: B[j + 1], amountX: x, amountY: y } })
    },
    ledgerAddress: (p) => getPdaPersonalPositionAddress(PROGRAM, new PublicKey(p.id)).publicKey.toBase58(),
    // 开仓交易里 NFT mint 是除钱包外唯一的签名者；之后的事件都带 positionNftMint
    positionsInTx: async (tx) => {
      const cd = await coder()
      if (!cd) return []
      const out: { id: string; poolId: string | null; action: 'add' | 'remove' | 'collect' }[] = []
      const g = (data: any, k: string) => data[k] ?? data[k.replace(/[A-Z0-9]/g, (c: string) => '_' + c.toLowerCase())]
      const signers = tx.transaction.message.accountKeys.filter((a) => a.signer && !a.pubkey.equals(wallet)).map((a) => a.pubkey.toBase58())
      for (const ev of anchorEvents(cd, PROGRAM, tx)) {
        const data: any = ev.data
        const mint = g(data, 'positionNftMint')?.toBase58?.()
        if (ev.name === 'CreatePersonalPositionEvent' && signers.length === 1 && g(data, 'nftOwner')?.toBase58?.() === wallet.toBase58()) out.push({ id: signers[0], poolId: g(data, 'poolState')?.toBase58?.() ?? null, action: 'add' })
        else if (ev.name === 'IncreaseLiquidityEvent' && mint) out.push({ id: mint, poolId: null, action: 'add' })
        else if (ev.name === 'DecreaseLiquidityEvent' && mint) out.push({ id: mint, poolId: null, action: big(g(data, 'liquidity')) > 0n ? 'remove' : 'collect' })
        else if (ev.name === 'CollectPersonalFeeEvent' && mint) out.push({ id: mint, poolId: null, action: 'collect' })
      }
      return out
    },
    // 事件（链上 IDL）：CreatePersonalPositionEvent / IncreaseLiquidityEvent = 加；DecreaseLiquidityEvent = 撤（liquidity 为 0 时是纯领手续费，本金 0）；
    // CollectPersonalFeeEvent = 领；LiquidityChangeEvent 带当时的池 tick（只在仓位跨现价时有）
    parseLedger: async (tx, p) => {
      const cd = await coder()
      if (!cd) return null
      let addX = 0n, addY = 0n, remX = 0n, remY = 0n, feeX = 0n, feeY = 0n, tick: number | null = null, mine = false
      const g = (data: any, k: string) => data[k] ?? data[k.replace(/[A-Z0-9]/g, (c: string) => '_' + c.toLowerCase())]
      for (const ev of anchorEvents(cd, PROGRAM, tx)) {
        const data: any = ev.data
        const mint = g(data, 'positionNftMint')?.toBase58?.()
        if (ev.name === 'CreatePersonalPositionEvent') { if (Number(g(data, 'tickLowerIndex')) !== (p as any).lower && (p as any).lower !== undefined) continue; mine = true; addX += big(g(data, 'depositAmount0')); addY += big(g(data, 'depositAmount1')) }
        else if (ev.name === 'IncreaseLiquidityEvent') { if (mint !== p.id) continue; mine = true; addX += big(g(data, 'amount0')); addY += big(g(data, 'amount1')) }
        else if (ev.name === 'DecreaseLiquidityEvent') { if (mint !== p.id) continue; mine = true; remX += big(g(data, 'decreaseAmount0')); remY += big(g(data, 'decreaseAmount1')); feeX += big(g(data, 'feeAmount0')); feeY += big(g(data, 'feeAmount1')) }
        else if (ev.name === 'CollectPersonalFeeEvent') { if (mint !== p.id) continue; mine = true; feeX += big(g(data, 'amount0')); feeY += big(g(data, 'amount1')) }
        else if (ev.name === 'LiquidityChangeEvent' && g(data, 'poolState')?.toBase58?.() === p.pool.id) tick = Number(g(data, 'tick'))
      }
      if (!mine) return null
      const basis = { sig: tx.transaction.signatures[0], time: (tx.blockTime ?? 0) * 1000, block: tx.slot, price: tick === null ? null : priceAt(p.pool, tick) }
      if (addX || addY) return { ...basis, action: 'add', amountX: addX, amountY: addY, principalX: addX, principalY: addY }
      if (remX || remY) return { ...basis, action: 'remove', amountX: remX + feeX, amountY: remY + feeY, principalX: remX, principalY: remY }
      if (feeX || feeY) return { ...basis, action: 'collect', amountX: feeX, amountY: feeY, principalX: 0n, principalY: 0n }
      return null
    },
  }
}
