// 仓位资金流水：钱包和 PoolManager 之间的 USDG / 代币转账（Alchemy 转账记录）按交易归并，再按 PoolManager 的
// ModifyLiquidity 事件（salt = 仓位 id）归到各个仓位，liquidityDelta 正 = 加流动性、负 = 撤流动性、零 = 只领手续费。
// 网页用它算 盈亏 = 现值 + 未领手续费 + 已领手续费 + 已撤本金 − 存入（每笔按当时的池价折算），以及点开 uPNL 看到的明细。
// 需要 RPC_URL 是 Alchemy（alchemy_getAssetTransfers + 历史状态）；不是的话 refreshLedger 抛错，网页显示"—"
import { parseAbiItem, parseEventLogs, type Hex } from 'viem'
import * as v4 from './v4.ts'
import { POOL_MANAGER, POSM, STATE_VIEW, abs, min, posmAbi, sleep, stateViewAbi, type Clients } from './common.ts'
import { same, type Position } from './exit.ts'

const modifyLiquidityEvent = parseAbiItem('event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)')
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')

type Mod = { id: bigint; poolId: Hex; tickLower: number; tickUpper: number; delta: bigint }
// in: 钱包 -> PoolManager 的每种币数量（地址小写），out: 反向
type ParsedTx = { block: bigint; time: number; mods: Mod[]; in: Map<string, bigint>; out: Map<string, bigint> }
export type LedgerEvent = {
  tx: Hex; block: bigint; time: number; action: 'add' | 'collect' | 'remove'
  amount0: bigint; amount1: bigint; principal0: bigint; principal1: bigint // 本仓位在这笔交易里进/出的两种币；principal = 其中的本金部分（其余是手续费）
  tick: number // 当时池价
}

const txs = new Map<Hex, ParsedTx>()
const slot0Cache = new Map<string, Promise<readonly [bigint, number]>>()
const preLiqCache = new Map<string, Promise<bigint>>()
let scannedFrom: bigint | null = null

const slot0At = (c: Clients, poolId: Hex, block: bigint) => {
  const k = `${poolId}:${block}`
  if (!slot0Cache.has(k)) slot0Cache.set(k, c.pub.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [poolId], blockNumber: block }).then(([sqrtP, tick]) => [sqrtP, tick] as const))
  return slot0Cache.get(k)!
}
// 交易前一个区块时该仓位的流动性（多仓位同笔交易分手续费用）
const preLiquidity = (c: Clients, id: bigint, block: bigint) => {
  const k = `${id}:${block}`
  if (!preLiqCache.has(k)) preLiqCache.set(k, c.pub.readContract({ address: POSM, abi: posmAbi, functionName: 'getPositionLiquidity', args: [id], blockNumber: block - 1n }))
  return preLiqCache.get(k)!
}

// 从 since 区块起钱包和 PoolManager 之间的转账 -> 交易哈希（两个方向）；同时拿到区块时间
async function transferTxs(c: Clients, since: bigint) {
  const out = new Map<Hex, { block: bigint; time: number }>()
  for (const dir of [{ fromAddress: c.wallet, toAddress: POOL_MANAGER }, { fromAddress: POOL_MANAGER, toAddress: c.wallet }]) {
    for (let pageKey: string | undefined; ; ) {
      const r: any = await c.pub.request({ method: 'alchemy_getAssetTransfers', params: [{ fromBlock: `0x${since.toString(16)}`, toBlock: 'latest', ...dir, category: ['erc20'], withMetadata: true, maxCount: '0x3e8', ...(pageKey ? { pageKey } : {}) }] } as any)
      for (const t of r.transfers) out.set(t.hash, { block: BigInt(t.blockNum), time: Date.parse(t.metadata?.blockTimestamp ?? '') || 0 })
      if (!(pageKey = r.pageKey)) break
    }
  }
  return out
}

// 拉 since 区块以来的新交易回执并解析（已解析过的不重复拉）；回执按 15 笔一批，避免撞节点的每秒额度
export async function refreshLedger(c: Clients, since: bigint) {
  if (scannedFrom !== null && scannedFrom < since) since = scannedFrom // 已经扫过更早的，就继续从那里扫（新交易只会在后面出现）
  const list = [...(await transferTxs(c, since))].filter(([h]) => !txs.has(h))
  for (let i = 0; i < list.length; i += 15) {
    if (i) await sleep(300)
    await Promise.all(list.slice(i, i + 15).map(async ([hash, meta]) => {
      const rc = await c.pub.getTransactionReceipt({ hash })
      const mods: Mod[] = parseEventLogs({ abi: [modifyLiquidityEvent], logs: rc.logs })
        .filter((l) => same(l.address, POOL_MANAGER) && same(l.args.sender, POSM))
        .map((l) => ({ id: BigInt(l.args.salt), poolId: l.args.id, tickLower: l.args.tickLower, tickUpper: l.args.tickUpper, delta: l.args.liquidityDelta }))
      const inb = new Map<string, bigint>(), outb = new Map<string, bigint>()
      for (const t of parseEventLogs({ abi: [transferEvent], logs: rc.logs })) {
        const k = t.address.toLowerCase()
        if (same(t.args.from, c.wallet) && same(t.args.to, POOL_MANAGER)) inb.set(k, (inb.get(k) ?? 0n) + t.args.value)
        if (same(t.args.from, POOL_MANAGER) && same(t.args.to, c.wallet)) outb.set(k, (outb.get(k) ?? 0n) + t.args.value)
      }
      txs.set(hash, { block: meta.block, time: meta.time, mods, in: inb, out: outb })
    }))
  }
  scannedFrom = since
}

// 某个仓位的流水（按区块升序）。一笔交易动了同池多个仓位时（本工具按池批量撤仓/领取）：本金按各自 liquidityDelta 在当时池价下应得的数量算，
// 手续费按各仓位交易前的流动性比例分；存入则按本金比例分
export async function positionLedger(c: Clients, p: Position): Promise<LedgerEvent[]> {
  const pid = v4.poolId(p.key)
  const c0 = p.key.currency0.toLowerCase(), c1 = p.key.currency1.toLowerCase()
  const events: LedgerEvent[] = []
  for (const [tx, t] of txs) {
    const mine = t.mods.filter((m) => m.id === p.id && m.poolId === pid)
    if (!mine.length) continue
    const delta = mine.reduce((s, m) => s + m.delta, 0n)
    const action = delta > 0n ? 'add' : delta < 0n ? 'remove' : 'collect'
    const [sqrtP, tick] = await slot0At(c, pid, t.block)
    const flow = action === 'add' ? t.in : t.out
    const total: [bigint, bigint] = [flow.get(c0) ?? 0n, flow.get(c1) ?? 0n]
    const principalOf = (m: { tickLower: number; tickUpper: number; delta: bigint }) => m.delta === 0n ? [0n, 0n] as const : v4.amountsForLiquidity(sqrtP, v4.getSqrtRatioAtTick(m.tickLower), v4.getSqrtRatioAtTick(m.tickUpper), abs(m.delta))
    const [principal0, principal1] = principalOf({ tickLower: p.tickLower, tickUpper: p.tickUpper, delta })
    // 同池其他仓位也在这笔交易里？按上面的规则分
    const others = new Map<bigint, Mod[]>()
    for (const m of t.mods) if (m.poolId === pid && m.id !== p.id) others.set(m.id, [...(others.get(m.id) ?? []), m])
    let amount0 = total[0], amount1 = total[1]
    if (others.size) {
      const groups = [{ id: p.id, tickLower: p.tickLower, tickUpper: p.tickUpper, delta }, ...[...others].map(([id, ms]) => ({ id, tickLower: ms[0].tickLower, tickUpper: ms[0].tickUpper, delta: ms.reduce((s, m) => s + m.delta, 0n) }))]
      const principals = groups.map(principalOf)
      const sumP = principals.reduce((s, x) => [s[0] + x[0], s[1] + x[1]] as const, [0n, 0n] as const)
      if (action === 'add') {
        amount0 = sumP[0] ? (total[0] * principal0) / sumP[0] : 0n
        amount1 = sumP[1] ? (total[1] * principal1) / sumP[1] : 0n
      } else {
        const liqs = await Promise.all(groups.map((g) => preLiquidity(c, g.id, t.block)))
        const sumL = liqs.reduce((s, x) => s + x, 0n)
        const fee = (tot: bigint, sp: bigint) => (tot > sp ? tot - sp : 0n)
        amount0 = principal0 + (sumL ? (fee(total[0], sumP[0]) * liqs[0]) / sumL : 0n)
        amount1 = principal1 + (sumL ? (fee(total[1], sumP[1]) * liqs[0]) / sumL : 0n)
      }
    }
    // amountsForLiquidity 向上取整，没有手续费时本金可能比实际多 1 wei：本金不超过实际数量
    events.push({ tx, block: t.block, time: t.time, action, amount0, amount1, principal0: min(principal0, amount0), principal1: min(principal1, amount1), tick })
  }
  return events.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0))
}
