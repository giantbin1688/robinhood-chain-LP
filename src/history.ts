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
type ParsedTx = { block: bigint; time: number; mods: Mod[]; in: Map<string, bigint>; out: Map<string, bigint>; direct: Map<bigint, Direct>; gas: bigint; wallet: Map<string, bigint> } // gas：钱包自己发的这笔交易花的原生币（wei）；别人发的算 0。wallet：这笔交易里钱包每种币的净变化（地址小写，正 = 收到），换币、转账也算——现金账用
export type LedgerEvent = {
  tx: Hex; block: bigint; time: number; action: 'add' | 'collect' | 'remove'
  amount0: bigint; amount1: bigint; principal0: bigint; principal1: bigint // 本仓位在这笔交易里进/出的两种币；principal = 其中的本金部分（其余是手续费）
  tick: number // 当时池价
  gas: bigint // 这笔交易的 gas 里分给本仓位的那份（wei）：同笔交易动了几个仓位就均分。只含建仓 / 撤仓 / 领取，换币和授权那几笔不在流水里
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

// 从 since 区块起钱包的全部 ERC20 转账 -> 交易哈希（两个方向）；同时拿到区块时间。
// 不只看和 PoolManager 之间的：进出场的换币（UniversalRouter / 聚合器）、转账也要进现金账（tokenEpisodes），回执里再按事件区分
async function transferTxs(c: Clients, since: bigint) {
  const out = new Map<Hex, { block: bigint; time: number }>()
  for (const dir of [{ fromAddress: c.wallet }, { toAddress: c.wallet }]) {
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
      const gas = same(rc.from, c.wallet) ? rc.gasUsed * rc.effectiveGasPrice : 0n
      const mods = c.lp.ledger.parseMods(rc.logs)
      const inb = new Map<string, bigint>(), outb = new Map<string, bigint>(), wallet = new Map<string, bigint>()
      for (const t of parseEventLogs({ abi: [transferEvent], logs: rc.logs })) {
        const k = t.address.toLowerCase()
        if (same(t.args.from, c.wallet)) wallet.set(k, (wallet.get(k) ?? 0n) - t.args.value)
        if (same(t.args.to, c.wallet)) wallet.set(k, (wallet.get(k) ?? 0n) + t.args.value)
        if (!cp) continue
        if (same(t.args.from, c.wallet) && same(t.args.to, cp)) inb.set(k, (inb.get(k) ?? 0n) + t.args.value)
        if (same(t.args.from, cp) && same(t.args.to, c.wallet)) outb.set(k, (outb.get(k) ?? 0n) + t.args.value)
      }
      const direct = new Map<bigint, Direct>()
      for (const e of c.lp.ledger.parseDirect?.(rc.logs) ?? []) direct.set(e.id, e)
      S.txs.set(hash, { block: meta.block, time: meta.time, mods, in: inb, out: outb, direct, gas, wallet }) // 换币、转账也记下：现金账要用，也免得每次重拉回执
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
    const gas = t.gas / BigInt(new Set([...t.mods.map((m) => m.id), ...t.direct.keys()]).size || 1)
    // 操作时池价仍在极限（币被砸到归零 / 无穷）：撤出的代币按池价估会把本金记成 0，撤仓那笔改按紧随其后的实际卖币价。
    // 加仓 / 只领手续费 / 只撤出计价币的按池价估本来就对（崩盘币 ≈ 0、计价币按面值），别抛错把整份流水弄丢
    const quoteIs0 = same(p.pool.currency0, c.Q.address), quoteIs1 = same(p.pool.currency1, c.Q.address)
    const token = quoteIs0 ? p.pool.currency1 : p.pool.currency0, withdrawnToken = t.out.get(token.toLowerCase()) ?? 0n
    if (extreme(poolTick) && delta < 0n && (quoteIs0 || quoteIs1) && withdrawnToken > 0n) {
      const price = await cachedKeepPermanent(exitPrices, `${c.cfg.name}:${c.protocol}:${c.wallet}:${tx}:${token}`, () => exitValuation(c, { tx, block: t.block, time: t.time, token, tokenIs0: quoteIs1, withdrawnToken }))
      tick = price.tick; valuationTx = price.tx
    }
    const d = t.direct.get(p.id)
    if (d) { events.push({ tx, block: t.block, time: t.time, action: d.action, amount0: d.amount0, amount1: d.amount1, principal0: min(d.principal0, d.amount0), principal1: min(d.principal1, d.amount1), tick, valuationTx, gas }); continue }
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
    events.push({ tx, block: t.block, time: t.time, action, amount0, amount1, principal0: min(principal0, amount0), principal1: min(principal1, amount1), tick, valuationTx, gas })
  }
  return events.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0))
}

// 一组仓位的资金流水合计（计价币，每笔按当时池价折算，和网页 uPNL 同一口径）：deposits 存入本金、withdrawn 已撤本金、fees 已领手续费。
// 撤退日志里给"共收回"配参照，监控的止损用它算盈亏。需要 Alchemy。读不到时抛错并说清原因（公共节点、限流、极限价估值失败、
// 转账索引还没跟上刚建的仓位），调用方决定是重试、报一行还是拒绝启动——以前这里静默返回 null，用户只看到日志少了半句，查不出为什么。
// since = 最早的 mint 区块，不知道就从创世块扫（慢，几十秒）
export async function ledgerTotals(c: Clients, positions: Pick<RawPosition, 'id' | 'pool' | 'tickLower' | 'tickUpper'>[], tokenDecimals: number, since: bigint): Promise<{ deposits: number; withdrawn: number; fees: number }> {
  if (!c.rpcIsAlchemy) throw new Error('资金流水需要 Alchemy 节点')
  if (!positions.length) throw new Error('没有仓位')
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
    if (!(t.deposits > 0)) throw new Error('链上流水里没有这些仓位的存入记录（刚建的仓位 Alchemy 索引可能还没跟上，过几分钟再读）')
    return t
  } catch (e: any) { throw new Error(`读资金流水失败：${e?.shortMessage ?? e?.message ?? e}`) }
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

// ---- 现金账：按代币把 买币 -> 建仓 -> 撤仓 -> 卖币 串成一段（episode），这一段里钱包计价币的净变化就是这次操作真正赚 / 亏的钱 ----
// 盈亏日历原来只算 LP 那段（存入 / 撤出 / 手续费按池价折算），进出场把计价币换成代币、再换回来的手续费和滑点不在里面，
// 于是日历和钱包余额对不上（曾有一天余额 −774、日历 −357）。这里不估值：只数钱包里计价币进出了多少，和余额变化同一口径。
// 一段的划分：同一代币的交易按区块排；仓位全部撤完且代币只剩粉尘（≤ 最大持有量的 0.5%，紧接着就卖粉尘的等它卖完）就结束；
// 做过 LP 的代币撤完仓没卖光、下一笔又是买入，也算结束（剩的币记 0，卖掉时算进下一段）。
// 不属于任何代币的计价币变动（换原生币 / 包装币、和外部地址的转账、一笔里动了两种代币）不进段，另外按类返回，网页对账时列出来
export type Episode = {
  token: string; start: number; end: number; closedAt: number // closedAt：最后一笔撤仓的时间（没有仓位就是最后一笔）；日历按它归日
  ids: bigint[]; txs: number; open: boolean // open：仓位还没撤完，日历不显示
  quote: bigint; buys: bigint; sells: bigint; lpIn: bigint; lpOut: bigint; gasWei: bigint // 计价币原始单位：quote 净变化 = sells + lpOut − buys − lpIn
  leftover: bigint // 结束时钱包里还剩的代币（原始单位），按 0 计
}
export type OtherFlow = { time: number; quote: bigint; kind: 'native' | 'transfer' | 'multi' }
const max = (a: bigint, b: bigint) => (a > b ? a : b)
export async function tokenEpisodes(c: Clients, poolToken: (poolId: Hex) => Promise<string | null>, skip: string[]): Promise<{ episodes: Episode[]; other: OtherFlow[] }> {
  const S = storeOf(c)
  const q = c.Q.address.toLowerCase(), ignore = new Set([q, ...skip.map((a) => a.toLowerCase())])
  type Ev = ParsedTx & { hash: Hex; token: bigint; mine: Mod[] }
  const byToken = new Map<string, Ev[]>()
  const other: OtherFlow[] = []
  for (const [hash, t] of S.txs) {
    const tokens = new Set([...t.wallet].filter(([a, v]) => v !== 0n && !ignore.has(a)).map(([a]) => a))
    const modToken = new Map<Mod, string>()
    for (const m of t.mods) { const tk = await poolToken(m.poolId); if (tk) { modToken.set(m, tk.toLowerCase()); tokens.add(tk.toLowerCase()) } }
    if (tokens.size !== 1) {
      const dq = t.wallet.get(q) ?? 0n
      if (dq !== 0n) other.push({ time: t.time, quote: dq, kind: [...t.wallet].some(([a, v]) => v !== 0n && a !== q && ignore.has(a)) ? 'native' : tokens.size ? 'multi' : 'transfer' })
      continue
    }
    const [tk] = tokens
    byToken.set(tk, [...(byToken.get(tk) ?? []), { ...t, hash, token: t.wallet.get(tk) ?? 0n, mine: t.mods.filter((m) => modToken.get(m) === tk) }])
  }
  const out: Episode[] = []
  for (const [token, list] of byToken) {
    list.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0))
    let ep: Episode | null = null, bal = 0n, maxBal = 0n
    const liq = new Map<bigint, bigint>()
    const openCount = () => [...liq.values()].filter((v) => v !== 0n).length
    const finish = (open: boolean) => { if (!ep) return; ep.open = open; ep.leftover = bal; if (!ep.closedAt) ep.closedAt = ep.end; out.push(ep); ep = null; bal = 0n; maxBal = 0n }
    for (let i = 0; i < list.length; i++) {
      const t = list[i], dq = t.wallet.get(q) ?? 0n
      if (!ep) ep = { token, start: t.time, end: t.time, closedAt: 0, ids: [], txs: 0, open: false, quote: 0n, buys: 0n, sells: 0n, lpIn: 0n, lpOut: 0n, gasWei: 0n, leftover: 0n }
      ep.end = t.time; ep.txs++; ep.gasWei += t.gas; ep.quote += dq
      bal += t.token; maxBal = max(maxBal, bal)
      if (t.mine.length) {
        for (const m of t.mine) { liq.set(m.id, (liq.get(m.id) ?? 0n) + m.delta); if (!ep.ids.includes(m.id)) ep.ids.push(m.id) }
        if (dq < 0n) ep.lpIn += -dq; else ep.lpOut += dq
        if (t.mine.some((m) => m.delta < 0n) && !openCount()) ep.closedAt = t.time
      } else if (dq < 0n) ep.buys += -dq
      else ep.sells += dq
      if (openCount()) continue
      const next = list[i + 1]
      const dust = bal <= (maxBal * 5n) / 1000n && !(next && next.token < 0n && !next.mine.length && bal > 0n) // 粉尘马上要卖的，等卖完一起算
      if (dust || !next || (ep.ids.length && next.token > 0n && !next.mine.length)) finish(false)
    }
    finish(true)
  }
  return { episodes: out.filter((e) => e.ids.length || e.quote !== 0n).sort((a, b) => a.closedAt - b.closedAt), other } // 只收到币没动过钱的（空投、别人塞的）不算一段
}
