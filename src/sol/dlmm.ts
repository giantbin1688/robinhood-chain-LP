// Meteora DLMM（Solana）的适配：池子按 bin 组织（binStep 是每格的万分比，价格 = (1 + binStep/1e4)^binId），一个仓位覆盖连续一段 bin，
// 现价 bin 以下全是 Y、以上全是 X。形状 spot / curve / bidask 是它原生的 StrategyType，超过 70 个 bin 的区间由 SDK 拆成扩展仓位 + 多笔交易。
// 费率是动态的（基础费 + 波动费），费率档来自链上的 presetParameter2 账户。仓位是独立账户（不是 NFT），id = 仓位账户地址，关闭时退还租金
import { Keypair, PublicKey, Transaction, type Connection, type ParsedTransactionWithMeta } from '@solana/web3.js'
import { BorshCoder } from '@coral-xyz/anchor'
import type * as DlmmSdk from '@meteora-ag/dlmm'
import { dlmmSdk } from './dlmm-sdk.ts'
import type { LbPosition, PositionInfo } from '@meteora-ag/dlmm'
import BN from 'bn.js'
import { anchorEvents } from './common.ts'
import type { DepthBar, LedgerEvent, MintPlan, MintReq, PoolState, SolLp, SolLpDeps, SolPool, SolPosition, Tier } from './lp.ts'

// CommonJS 入口直接导出 DLMM 类；类型声明仍按 SDK 的模块声明读取。
// 实例类型从导出函数的参数里取，静态方法只声明用到的几个
const { IDL, LBCLMM_PROGRAM_IDS, StrategyType, autoFillYByStrategy, getBaseFee } = dlmmSdk
type DLMM = Parameters<typeof dlmmSdk.chunkDepositWithRebalanceEndpoint>[0]
type DLMMStatic = {
  create(conn: Connection, pk: PublicKey): Promise<DLMM>
  getAllPresetParameters(conn: Connection): Promise<{ presetParameter: any[]; presetParameter2: any[] }>
  getPairPubkeyIfExists(conn: Connection, tokenX: PublicKey, tokenY: PublicKey, binStep: BN, baseFactor: BN, baseFeePowerFactor: BN): Promise<PublicKey | null>
  getAllLbPairPositionsByUser(conn: Connection, user: PublicKey): Promise<Map<string, PositionInfo>>
  createLbPair2(conn: Connection, funder: PublicKey, tokenX: PublicKey, tokenY: PublicKey, presetParameter: PublicKey, activeId: BN): Promise<Transaction>
}
const DLMM = dlmmSdk as unknown as DLMMStatic
const PROGRAM = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta'])
const STRATEGY: Record<string, DlmmSdk.StrategyType> = { spot: StrategyType.Spot, curve: StrategyType.Curve, bidask: StrategyType.BidAsk }
const bn = (x: bigint) => new BN(x.toString())
const big = (x: BN | string | number) => BigInt(String(x).split('.')[0] || '0')
const feePips = (binStep: number, params: { baseFactor: number; baseFeePowerFactor: number }) => Number(getBaseFee(binStep, params as any).toString()) / 1000 // SDK 给的是 1e9 精度

export async function dlmmLp(d: SolLpDeps): Promise<SolLp> {
  const { conn, wallet } = d
  const instances = new Map<string, Promise<DLMM>>()
  const inst = (id: string) => { if (!instances.has(id)) { const p = DLMM.create(conn, new PublicKey(id)); p.catch(() => instances.delete(id)); instances.set(id, p) } return instances.get(id)! }
  const fromInstance = (x: DLMM): SolPool => ({
    id: x.pubkey.toBase58(), protocol: 'dlmm', mintX: x.tokenX.publicKey.toBase58(), mintY: x.tokenY.publicKey.toBase58(), decX: x.tokenX.mint.decimals, decY: x.tokenY.mint.decimals,
    step: x.lbPair.binStep, fee: feePips(x.lbPair.binStep, x.lbPair.parameters), dynamic: true,
  })
  const base = (p: SolPool) => 1 + p.step / 10_000
  const priceAt = (p: SolPool, bin: number) => base(p) ** bin * 10 ** (p.decX - p.decY)
  const unitAt = (p: SolPool, price: number, round: 'down' | 'up') => { const x = Math.log(price * 10 ** (p.decY - p.decX)) / Math.log(base(p)); return round === 'down' ? Math.floor(x + 1e-9) : Math.ceil(x - 1e-9) }
  let presets: Promise<Tier[]> | null = null
  const tiers = (): Promise<Tier[]> => {
    if (!presets) {
      // 同一 (binStep, baseFactor) 有几个变体（concreteFunctionType / collectFeeMode 不同），取 LiquidityMining + 双币收费的标准档，和 getPairPubkeyIfExists 的默认一致
      const rank = (a: any) => (a.concreteFunctionType === 1 ? 0 : 2) + (a.collectFeeMode === 0 ? 0 : 1)
      const p: Promise<Tier[]> = DLMM.getAllPresetParameters(conn).then((r: any) => {
        const best = new Map<string, any>()
        for (const p of r.presetParameter2 as any[]) { const k = `${p.account.binStep}/${p.account.baseFactor}/${p.account.baseFeePowerFactor ?? 0}`; const cur = best.get(k); if (!cur || rank(p.account) < rank(cur.account)) best.set(k, p) }
        return [...best.values()]
          .map((p: any): Tier => ({ fee: feePips(p.account.binStep, p.account), step: p.account.binStep as number, key: p.publicKey.toBase58(), label: `binStep ${p.account.binStep}` }))
          .filter((t) => t.fee > 0)
          .sort((a, b) => a.fee - b.fee || a.step - b.step)
      })
      p.catch(() => (presets = null))
      presets = p
    }
    return presets
  }
  const toPosition = (pool: SolPool, lp: LbPosition): SolPosition => ({
    id: lp.publicKey.toBase58(), pool, lower: lp.positionData.lowerBinId, upper: lp.positionData.upperBinId,
    amountX: big(lp.positionData.totalXAmount), amountY: big(lp.positionData.totalYAmount), feeX: big(lp.positionData.feeX), feeY: big(lp.positionData.feeY), liquidity: 0n, raw: lp,
  })
  const poolFromInfo = (info: PositionInfo): SolPool => ({
    id: info.publicKey.toBase58(), protocol: 'dlmm', mintX: info.tokenX.publicKey.toBase58(), mintY: info.tokenY.publicKey.toBase58(), decX: info.tokenX.mint.decimals, decY: info.tokenY.mint.decimals,
    step: info.lbPair.binStep, fee: feePips(info.lbPair.binStep, info.lbPair.parameters), dynamic: true,
  })
  const coder = new BorshCoder(IDL as any)

  return {
    protocol: 'dlmm', label: 'Meteora DLMM',
    tiers,
    tierFor: async (fee, step) => (await tiers()).find((t) => t.fee === fee && (step === undefined || t.step === step)) ?? null,
    pool: async (token, quote, tier) => {
      const preset = (await DLMM.getAllPresetParameters(conn)).presetParameter2.find((p: any) => p.publicKey.toBase58() === tier.key)
      if (!preset) return null
      const a: any = preset.account
      const key = await DLMM.getPairPubkeyIfExists(conn, new PublicKey(token), new PublicKey(quote), new BN(a.binStep), new BN(a.baseFactor), new BN(a.baseFeePowerFactor ?? 0))
      return key ? fromInstance(await inst(key.toBase58())) : null
    },
    poolById: async (id) => { try { return fromInstance(await inst(id)) } catch (e: any) { if (/not exist|Invalid|not found|Account does not exist/i.test(String(e?.message))) return null; throw e } },
    state: async (pool) => {
      const x = await inst(pool.id)
      await x.refetchStates()
      const active = x.lbPair.activeId
      const ab = await x.getActiveBin().catch(() => null)
      return { price: priceAt(pool, active), active, hasLiquidity: !!ab && (!ab.xAmount.isZero() || !ab.yAmount.isZero()) }
    },
    priceAt, unitAt,
    edges: (p) => [priceAt(p.pool, p.lower), priceAt(p.pool, p.upper + 1)],
    inRange: (p, active) => active >= p.lower && active <= p.upper,
    ownedPositions: async () => {
      const m = await DLMM.getAllLbPairPositionsByUser(conn, wallet)
      const out: SolPosition[] = []
      for (const info of m.values()) { const pool = poolFromInfo(info); for (const lp of info.lbPairPositionsData) out.push(toPosition(pool, lp)) }
      return out
    },
    positions: async (ids) => {
      if (!ids.length) return []
      const keys = ids.map((s) => new PublicKey(s))
      const accs = await conn.getMultipleAccountsInfo(keys)
      const byPool = new Map<string, PublicKey[]>()
      accs.forEach((a, i) => { // 仓位账户开头：discriminator(8) lbPair(32) owner(32)；已关闭的账户不存在
        if (!a || !a.owner.equals(PROGRAM) || a.data.length < 72) return
        const lbPair = new PublicKey(a.data.subarray(8, 40)).toBase58(), owner = new PublicKey(a.data.subarray(40, 72))
        if (!owner.equals(wallet)) return
        byPool.set(lbPair, [...(byPool.get(lbPair) ?? []), keys[i]])
      })
      const out: SolPosition[] = []
      for (const [poolId, pks] of byPool) {
        const x = await inst(poolId)
        await x.refetchStates()
        const pool = fromInstance(x)
        for (const pk of pks) { const lp = await x.getPosition(pk).catch(() => null); if (lp) out.push(toPosition(pool, lp)) }
      }
      return out
    },
    quoteSwap: async (pool, xToY, amountIn) => {
      const x = await inst(pool.id)
      const q = x.swapQuote(bn(amountIn), xToY, new BN(100), await x.getBinArrayForSwap(xToY), false)
      return { out: big(q.outAmount), endPrice: Number(q.endPrice.toString()) * 10 ** (pool.decX - pool.decY) }
    },
    swapTx: async (pool, xToY, amountIn, minOut) => {
      const x = await inst(pool.id)
      const q = x.swapQuote(bn(amountIn), xToY, new BN(100), await x.getBinArrayForSwap(xToY), false)
      const tx = await x.swap({ inToken: new PublicKey(xToY ? pool.mintX : pool.mintY), outToken: new PublicKey(xToY ? pool.mintY : pool.mintX), inAmount: bn(amountIn), minOutAmount: bn(minOut), lbPair: x.pubkey, user: wallet, binArraysPubkey: q.binArraysPubkey })
      return { label: '池内换币', tx, signers: [] }
    },
    createPoolTx: async (token, quote, tier, price, decX, decY) => {
      const all = await DLMM.getAllPresetParameters(conn)
      const preset = all.presetParameter2.find((p: any) => p.publicKey.toBase58() === tier.key)
      if (!preset) throw new Error(`找不到费率档 ${tier.label}`)
      const [tokenX, tokenY] = [new PublicKey(token), new PublicKey(quote)]
      const pseudo: SolPool = { id: '', protocol: 'dlmm', mintX: token, mintY: quote, decX, decY, step: (preset.account as any).binStep, fee: tier.fee }
      const activeId = unitAt(pseudo, price, 'down')
      const tx = await DLMM.createLbPair2(conn, wallet, tokenX, tokenY, preset.publicKey, new BN(activeId))
      const lbPair = tx.instructions[tx.instructions.length - 1].keys[0].pubkey // initializeLbPair2 的第 1 个账户是 lbPair（IDL 顺序：lb_pair, bin_array_bitmap_extension, token_mint_x, …）
      return { bundles: [{ label: '建池', tx, signers: [] }], poolId: lbPair.toBase58() }
    },
    mintPlan: async (pool, req) => {
      const x = await inst(pool.id)
      const strategyType = STRATEGY[req.shape]
      const { lower, upper } = req
      const bins = upper - lower + 1
      const plan: MintPlan = {
        legs: [{ lower, upper, g: 1 }],
        cost: async () => {
          const q = await x.quoteCreatePosition({ strategy: { minBinId: lower, maxBinId: upper, strategyType } })
          const sol = (n: number) => n.toFixed(3) // SDK 直接给 SOL 数
          const solNeeded = q.positionCost + q.positionReallocCost + q.binArrayCost + q.bitmapExtensionCost
          return { solNeeded, text: `${bins} 个 bin，${q.positionCount} 个仓位账户、约 ${q.transactionCount} 笔交易；租金 ${sol(q.positionCost + q.positionReallocCost)} SOL（关闭时退还）${q.binArraysCount ? `，要新建 ${q.binArraysCount} 个 bin 数组共 ${sol(q.binArrayCost)} SOL（不退）` : ''}${q.bitmapExtensionCost ? `，位图扩展 ${sol(q.bitmapExtensionCost)} SOL` : ''}` }
        },
        yPerX: async (state) => {
          if (upper < state.active) return Infinity
          if (lower > state.active) return 0
          const ab = await x.getActiveBin()
          const X0 = new BN('1000000000000')
          const y = autoFillYByStrategy(state.active, pool.step, X0, ab.xAmount, ab.yAmount, lower, upper, strategyType)
          return Number(y.toString()) / 1e12
        },
        build: async (amountX, amountY, state) => {
          await x.refetchStates()
          const strategy = { minBinId: lower, maxBinId: upper, strategyType, singleSidedX: amountY === 0n && lower > state.active }
          if (bins <= 70) {
            const kp = Keypair.generate()
            const tx = await x.initializePositionAndAddLiquidityByStrategy({ positionPubKey: kp.publicKey, totalXAmount: bn(amountX), totalYAmount: bn(amountY), strategy, user: wallet, slippage: req.lpSlippage })
            return { bundles: [{ label: `建仓位 ${bins} 个 bin`, tx, signers: [kp] }], ids: [kp.publicKey.toBase58()], useX: amountX, useY: amountY, note: '1 笔交易' }
          }
          // 超过 70 个 bin：SDK 拆成扩展仓位（每个最多 1400 bin）+ 分块加流动性，每块一笔交易
          const r = await x.initializeMultiplePositionAndAddLiquidityByStrategy(async (n: number) => Array.from({ length: n }, () => Keypair.generate()), bn(amountX), bn(amountY), strategy, wallet, wallet, req.lpSlippage)
          const bundles = [] as { label: string; tx: Transaction; signers: Keypair[] }[], ids: string[] = []
          for (const p of r.instructionsByPositions) {
            ids.push(p.positionKeypair.publicKey.toBase58())
            bundles.push({ label: `开仓位 ${p.positionKeypair.publicKey.toBase58().slice(0, 6)}…`, tx: new Transaction().add(...p.initializeAtaIxs, p.initializePositionIx), signers: [p.positionKeypair] })
            p.addLiquidityIxs.forEach((ixs: any[], i: number) => bundles.push({ label: `加流动性 ${i + 1}/${p.addLiquidityIxs.length}`, tx: new Transaction().add(...ixs), signers: [] }))
          }
          return { bundles, ids, useX: amountX, useY: amountY, note: `${ids.length} 个仓位、${bundles.length} 笔交易` }
        },
      }
      return plan
    },
    burnTx: async (positions, bps) => {
      const out = [] as { label: string; tx: Transaction; signers: Keypair[] }[]
      for (const p of positions) {
        const x = await inst(p.pool.id)
        await x.refetchStates()
        const full = bps >= 10_000
        const txs = await x.removeLiquidity({ user: wallet, position: new PublicKey(p.id), fromBinId: p.lower, toBinId: p.upper, bps: new BN(full ? 10_000 : bps), shouldClaimAndClose: full })
        for (const tx of Array.isArray(txs) ? txs : [txs]) out.push({ label: `${full ? '撤仓位' : `撤 ${bps / 100}%`} ${p.id.slice(0, 6)}…`, tx, signers: [] })
        if (!full && (p.feeX > 0n || p.feeY > 0n)) for (const tx of await x.claimAllRewardsByPosition({ owner: wallet, position: p.raw as LbPosition })) out.push({ label: `领手续费 ${p.id.slice(0, 6)}…`, tx, signers: [] })
      }
      return out
    },
    collectTx: async (positions) => {
      const out = [] as { label: string; tx: Transaction; signers: Keypair[] }[]
      for (const p of positions) {
        const x = await inst(p.pool.id)
        for (const tx of await x.claimAllRewardsByPosition({ owner: wallet, position: p.raw as LbPosition })) out.push({ label: `领手续费 ${p.id.slice(0, 6)}…`, tx, signers: [] })
      }
      return out
    },
    depth: async (pool, lower, upper) => {
      const x = await inst(pool.id)
      const { bins } = await x.getBinsBetweenLowerAndUpperBound(lower, upper) as { bins: any[] }
      return bins.map((b: any): DepthBar => ({ lo: b.binId, hi: b.binId + 1, amountX: big(b.xAmount), amountY: big(b.yAmount) }))
    },
    ledgerAddress: (p) => p.id,
    positionsInTx: async (tx) => {
      const out: { id: string; poolId: string | null; action: 'add' | 'remove' | 'collect' }[] = []
      for (const ev of anchorEvents(coder, PROGRAM, tx)) {
        const data: any = ev.data
        const pos = data.position?.toBase58?.(), pool = (data.lbPair ?? data.lb_pair)?.toBase58?.() ?? null
        if (!pos) continue
        if (ev.name === 'AddLiquidity' || ev.name === 'Rebalancing' || ev.name === 'PositionCreate') out.push({ id: pos, poolId: pool, action: 'add' })
        else if (ev.name === 'RemoveLiquidity' || ev.name === 'PositionClose') out.push({ id: pos, poolId: pool, action: 'remove' })
        else if (ev.name === 'ClaimFee' || ev.name === 'ClaimFee2') out.push({ id: pos, poolId: pool, action: 'collect' })
      }
      return out
    },
    // 事件：AddLiquidity / RemoveLiquidity { lbPair, from, position, amounts[2], activeBinId }（扩展仓位一笔里可能有几条，求和），ClaimFee { position, feeX, feeY }
    parseLedger: async (tx, p) => {
      let addX = 0n, addY = 0n, remX = 0n, remY = 0n, feeX = 0n, feeY = 0n, bin: number | null = null
      for (const ev of anchorEvents(coder, PROGRAM, tx)) {
        const data: any = ev.data
        const pos = data.position?.toBase58?.() ?? String(data.position)
        if (pos !== p.id) continue
        const g = (k: string) => data[k] ?? data[k.replace(/[A-Z]/g, (c: string) => '_' + c.toLowerCase())]
        if (ev.name === 'AddLiquidity' || ev.name === 'RemoveLiquidity') {
          const [a0, a1] = (g('amounts') as BN[]).map(big)
          if (ev.name === 'AddLiquidity') { addX += a0; addY += a1 } else { remX += a0; remY += a1 }
          bin = Number(g('activeBinId'))
        } else if (ev.name === 'Rebalancing') { // 扩展仓位 / SDK 的分块加流动性走 rebalance 指令：一条事件里同时有加、撤和顺带领走的手续费
          addX += big(g('xAddedAmount')); addY += big(g('yAddedAmount')); remX += big(g('xWithdrawnAmount')); remY += big(g('yWithdrawnAmount')); feeX += big(g('xFeeAmount')); feeY += big(g('yFeeAmount'))
          bin = Number(g('activeBinId'))
        } else if (ev.name === 'ClaimFee' || ev.name === 'ClaimFee2') { feeX += big(g('feeX')); feeY += big(g('feeY')) }
      }
      if (!addX && !addY && !remX && !remY && !feeX && !feeY) return null
      const price = bin === null ? null : priceAt(p.pool, bin)
      const basis = { sig: tx.transaction.signatures[0], time: (tx.blockTime ?? 0) * 1000, block: tx.slot, price }
      // rebalance 一笔里既有加又有撤：按净额算，多出来的那边记成加或撤，手续费照记
      const netX = addX - remX, netY = addY - remY
      if (addX + addY > remX + remY) { const ax = netX > 0n ? netX : 0n, ay = netY > 0n ? netY : 0n; return { ...basis, action: 'add', amountX: ax, amountY: ay, principalX: ax, principalY: ay } }
      if (remX || remY) { const rx = netX < 0n ? -netX : 0n, ry = netY < 0n ? -netY : 0n; return { ...basis, action: 'remove', amountX: rx + feeX, amountY: ry + feeY, principalX: rx, principalY: ry } }
      return { ...basis, action: 'collect', amountX: feeX, amountY: feeY, principalX: 0n, principalY: 0n }
    },
  }
}
