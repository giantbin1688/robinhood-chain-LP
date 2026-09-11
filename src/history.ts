// 仓位资金流水：钱包和池子之间的计价币 / 代币转账按交易归并，再归到各个仓位（liquidityDelta 正 = 加流动性、负 = 撤流动性、零 = 只领手续费）。
// 网页用它算 盈亏 = 现值 + 未领手续费 + 已领手续费 + 已撤本金 − 存入（每笔按当时的池价折算），以及点开 uPNL 看到的明细。
//   v4 / Infinity：代币在钱包和 PoolManager（Infinity 是 Vault）之间转，同一笔里多个仓位要按各自的 liquidityDelta 分摊
//   v3：NPM 的 IncreaseLiquidity / DecreaseLiquidity / Collect 事件直接给出每个仓位的数量
// 需要 RPC 是 Alchemy（alchemy_getAssetTransfers + 历史状态）；不是的话 refreshLedger 抛错，网页显示"—"
import { parseEventLogs, type Hex } from 'viem'
import * as v4 from './v4.ts'
import { abs, min, sleep, type Clients } from './common.ts'
import type { Mod, Pool, RawPosition } from './lp.ts'
import { same } from './exit.ts'
import { exitValuation, transferEvent } from './exit-valuation.ts'

// in: 钱包 -> 池 的每种币数量（地址小写），out: 反向；direct: v3 由事件直接得到的每仓位数量
type Direct = { action: 'add' | 'collect' | 'remove'; amount0: bigint; amount1: bigint; principal0: bigint; principal1: bigint }
type ParsedTx = { block: bigint; time: number; mods: Mod[]; in: Map<string, bigint>; out: Map<string, bigint>; direct: Map<bigint, Direct> }
export type LedgerEvent = {
  tx: Hex; block: bigint; time: number; action: 'add' | 'collect' | 'remove'
  amount0: bigint; amount1: bigint; principal0: bigint; principal1: bigint // 本仓位在这笔交易里进/出的两种币；principal = 其中的本金部分（其余是手续费）
  tick: number // 当时池价
  valuationTx?: Hex // 极限池价时，改用紧随撤仓的实际卖币价格；tick 为成交价对应的小数 tick
}

// 每条链 / 协议各自一份缓存（网页服务同时开着多条链时不串）
type Store = { txs: Map<Hex, ParsedTx>; slot0Cache: Map<string, Promise<readonly [bigint, number]>>; preLiqCache: Map<string, Promise<bigint>>; scannedFrom: bigint | null }
const stores = new Map<string, Store>()
const exitPrices = new Map<string, Promise<Awaited<ReturnType<typeof exitValuation>>>>()
const operationPrices = new Map<string,Promise<{index:number;sqrtP:bigint;tick:number}[]>>()
const storeOf = (c: Clients) => { const k = `${c.cfg.name}:${c.protocol}`; let s = stores.get(k); if (!s) { s = { txs: new Map(), slot0Cache: new Map(), preLiqCache: new Map(), scannedFrom: null }; stores.set(k, s) }; return s }

// 缓存的是 Promise：失败（Alchemy 限流溢出到没有归档数据的公共节点、超时）就从缓存里删掉，下次再读；否则一次失败会把这个池/区块永久卡死
const cached = <T>(m: Map<string, Promise<T>>, k: string, make: () => Promise<T>) => {
  if (!m.has(k)) { const p = make(); p.catch(() => m.delete(k)); m.set(k, p) }
  return m.get(k)!
}
// 结果不会再变的失败（e.permanent）也留在缓存里：每次刷新列表 / 打开日历都重查一遍 Alchemy 只是白烧额度、刷屏日志
const cachedKeepPermanent = <T>(m: Map<string, Promise<T>>, k: string, make: () => Promise<T>) => {
  if (!m.has(k)) { const p = make(); p.catch((e: any) => { if (!e?.permanent) m.delete(k) }); m.set(k, p) }
  return m.get(k)!
}
const slot0At = (c: Clients, pool: Pool, block: bigint) => cached(storeOf(c).slot0Cache, `${pool.id}:${block}`, () => c.lp.slot0At(pool, block).then(({ sqrtP, tick }) => [sqrtP, tick] as const))
// 区块末极限价可能来自撤仓之后的另一笔 swap，先按事件顺序还原操作当时的价格（适配器给出该区块的改价事件；没给的协议用不上）。
async function operationSlot(c:Clients,pool:Pool,block:bigint,logIndex:number) {
  const prices=await cached(operationPrices,`${c.cfg.name}:${c.protocol}:${pool.id}:${block}`,()=>c.lp.ledger.priceEventsAt!(pool,block))
  const before=prices.filter(p=>p.index<logIndex).at(-1)
  return before?[before.sqrtP,before.tick] as const:slot0At(c,pool,block-1n)
}
// 交易前一个区块时该仓位的流动性（多仓位同笔交易分手续费用）
const preLiquidity = (c: Clients, id: bigint, block: bigint) => cached(storeOf(c).preLiqCache, `${id}:${block}`, () => c.lp.liquidityAt(id, block - 1n))

// 从 since 区块起钱包和池之间的转账 -> 交易哈希（两个方向）；同时拿到区块时间。
// v4/Infinity 对手方固定是 PoolManager/Vault；v3 是各个池合约，改为查钱包与 NPM 相关的全部 ERC20 转账再按回执过滤
async function transferTxs(c: Clients, since: bigint) {
  const out = new Map<Hex, { block: bigint; time: number }>()
  const cp = c.lp.ledger.counterparty
  const dirs = cp ? [{ fromAddress: c.wallet, toAddress: cp }, { fromAddress: cp, toAddress: c.wallet }] : [{ fromAddress: c.wallet }, { toAddress: c.wallet }]
  for (const dir of dirs) {
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
  const S = storeOf(c)
  if (S.scannedFrom !== null && S.scannedFrom < since) since = S.scannedFrom // 已经扫过更早的，就继续从那里扫（新交易只会在后面出现）
  const list = [...(await transferTxs(c, since))].filter(([h]) => !S.txs.has(h))
  const cp = c.lp.ledger.counterparty
  for (let i = 0; i < list.length; i += 15) {
    if (i) await sleep(300)
    await Promise.all(list.slice(i, i + 15).map(async ([hash, meta]) => {
      const rc = await c.pub.getTransactionReceipt({ hash })
      const mods = c.lp.ledger.parseMods(rc.logs)
      const inb = new Map<string, bigint>(), outb = new Map<string, bigint>()
      if (cp) for (const t of parseEventLogs({ abi: [transferEvent], logs: rc.logs })) {
        const k = t.address.toLowerCase()
        if (same(t.args.from, c.wallet) && same(t.args.to, cp)) inb.set(k, (inb.get(k) ?? 0n) + t.args.value)
        if (same(t.args.from, cp) && same(t.args.to, c.wallet)) outb.set(k, (outb.get(k) ?? 0n) + t.args.value)
      }
      const direct = new Map<bigint, Direct>()
      for (const e of c.lp.ledger.parseDirect?.(rc.logs) ?? []) direct.set(e.id, e)
      if (mods.length || direct.size) S.txs.set(hash, { block: meta.block, time: meta.time, mods, in: inb, out: outb, direct })
      else S.txs.set(hash, { block: meta.block, time: meta.time, mods: [], in: inb, out: outb, direct }) // 无关交易也记下，免得每次重拉回执
    }))
  }
  S.scannedFrom = since
}

// 某个仓位的流水（按区块升序）。一笔交易动了同池多个仓位时（本工具按池批量撤仓/领取）：本金按各自 liquidityDelta 在当时池价下应得的数量算，
// 手续费按各仓位交易前的流动性比例分；存入则按本金比例分
export async function positionLedger(c: Clients, p: Pick<RawPosition, 'id' | 'pool' | 'tickLower' | 'tickUpper'>): Promise<LedgerEvent[]> {
  const S = storeOf(c)
  const pid = p.pool.id
  const c0 = p.pool.currency0.toLowerCase(), c1 = p.pool.currency1.toLowerCase()
  const events: LedgerEvent[] = []
  for (const [tx, t] of S.txs) {
    const mine = t.mods.filter((m) => m.id === p.id && same(m.poolId, pid))
    if (!mine.length) continue
    const delta = mine.reduce((s, m) => s + m.delta, 0n)
    let [sqrtP, poolTick] = await slot0At(c, p.pool, t.block)
    const extreme = (tk: number) => tk <= v4.MIN_TICK + 1 || tk >= v4.MAX_TICK - 1
    if (extreme(poolTick) && c.lp.ledger.priceEventsAt && mine[0].logIndex !== undefined) [sqrtP, poolTick] = await operationSlot(c, p.pool, t.block, mine[0].logIndex)
    let tick = poolTick, valuationTx: Hex | undefined
    // 操作时池价仍在极限（币被砸到归零 / 无穷）：撤出的代币按池价估会把本金记成 0，撤仓那笔改按紧随其后的实际卖币价。
    // 加仓 / 只领手续费 / 只撤出计价币的按池价估本来就对（崩盘币 ≈ 0、计价币按面值），别抛错把整份流水弄丢
    const quoteIs0 = same(p.pool.currency0, c.Q.address), quoteIs1 = same(p.pool.currency1, c.Q.address)
    const token = quoteIs0 ? p.pool.currency1 : p.pool.currency0, withdrawnToken = t.out.get(token.toLowerCase()) ?? 0n
    if (extreme(poolTick) && delta < 0n && (quoteIs0 || quoteIs1) && withdrawnToken > 0n) {
      const price = await cachedKeepPermanent(exitPrices, `${c.cfg.name}:${c.protocol}:${c.wallet}:${tx}:${token}`, () => exitValuation(c, { tx, block: t.block, time: t.time, token, tokenIs0: quoteIs1, withdrawnToken }))
      tick = price.tick; valuationTx = price.tx
    }
    const d = t.direct.get(p.id)
    if (d) { events.push({ tx, block: t.block, time: t.time, action: d.action, amount0: d.amount0, amount1: d.amount1, principal0: min(d.principal0, d.amount0), principal1: min(d.principal1, d.amount1), tick, valuationTx }); continue }
    const action = delta > 0n ? 'add' : delta < 0n ? 'remove' : 'collect'
    const flow = action === 'add' ? t.in : t.out
    const total: [bigint, bigint] = [flow.get(c0) ?? 0n, flow.get(c1) ?? 0n]
    const principalOf = (m: { tickLower: number; tickUpper: number; delta: bigint }) => m.delta === 0n ? [0n, 0n] as const : v4.amountsForLiquidity(sqrtP, v4.getSqrtRatioAtTick(m.tickLower), v4.getSqrtRatioAtTick(m.tickUpper), abs(m.delta))
    const [principal0, principal1] = principalOf({ tickLower: p.tickLower, tickUpper: p.tickUpper, delta })
    // 同池其他仓位也在这笔交易里？按上面的规则分
    const others = new Map<bigint, Mod[]>()
    for (const m of t.mods) if (same(m.poolId, pid) && m.id !== p.id) others.set(m.id, [...(others.get(m.id) ?? []), m])
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
    events.push({ tx, block: t.block, time: t.time, action, amount0, amount1, principal0: min(principal0, amount0), principal1: min(principal1, amount1), tick, valuationTx })
  }
  return events.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0))
}

// 一组仓位的资金流水合计（计价币，每笔按当时池价折算，和网页 uPNL 同一口径）：deposits 存入本金、withdrawn 已撤本金、fees 已领手续费。
// 撤退日志里给"共收回"配参照，监控的止损用它算盈亏。需要 Alchemy；拿不到（公共节点、限流、极限价估值失败）返回 null，调用方自己决定退路。
// since = 最早的 mint 区块，不知道就从创世块扫（慢，几十秒）
export async function ledgerTotals(c: Clients, positions: Pick<RawPosition, 'id' | 'pool' | 'tickLower' | 'tickUpper'>[], tokenDecimals: number, since: bigint): Promise<{ deposits: number; withdrawn: number; fees: number } | null> {
  if (!c.rpcIsAlchemy || !positions.length) return null
  try {
    await refreshLedger(c, since)
    const t = { deposits: 0, withdrawn: 0, fees: 0 }
    for (const p of positions) {
      const quoteIs0 = same(p.pool.currency0, c.Q.address)
      const [d0, d1] = quoteIs0 ? [c.Q.decimals, tokenDecimals] : [tokenDecimals, c.Q.decimals]
      for (const e of await positionLedger(c, p)) {
        const price = v4.priceAtTick(e.tick) * 10 ** (d0 - d1) // 1 个 currency0 = price 个 currency1（人类单位）
        const usd = (a0: bigint, a1: bigint) => (quoteIs0 ? Number(a0) / 10 ** d0 + Number(a1) / 10 ** d1 / price : Number(a1) / 10 ** d1 + (Number(a0) / 10 ** d0) * price)
        const total = usd(e.amount0, e.amount1), principal = usd(e.principal0, e.principal1)
        if (e.action === 'add') t.deposits += total
        else { t.withdrawn += principal; t.fees += total - principal }
      }
    }
    return t
  } catch { return null }
}

// 已平仓 = 流水里出现过、liquidityDelta 累计归零的仓位（全部撤出；销毁 NFT 前也必先撤完，网页撤完不销毁的也算）。
// 要求流水从创世块扫起（refreshLedger(c, 0n)），否则早期的加流动性看不到、累计不归零。池子由调用方按 poolId 查（lp.poolById）
export function closedPositions(c: Clients) {
  const acc = new Map<bigint, { poolId: Hex; tickLower: number; tickUpper: number; delta: bigint; closed: { block: bigint; time: number; tx: Hex } }>()
  for (const [tx, t] of storeOf(c).txs) for (const m of t.mods) {
    const a = acc.get(m.id) ?? { poolId: m.poolId, tickLower: m.tickLower, tickUpper: m.tickUpper, delta: 0n, closed: { block: 0n, time: 0, tx } }
    a.delta += m.delta
    if (m.delta < 0n && t.block >= a.closed.block) a.closed = { block: t.block, time: t.time, tx }
    acc.set(m.id, a)
  }
  return [...acc].filter(([, a]) => a.delta === 0n && a.closed.block > 0n).map(([id, { poolId, tickLower, tickUpper, closed }]) => ({ id, poolId, tickLower, tickUpper, closed }))
}
