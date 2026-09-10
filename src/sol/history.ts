// Solana 仓位资金流水：仓位账户（DLMM）/ 仓位 PDA（CLMM）的全部交易，逐笔用适配器解析成 加流动性 / 撤流动性 / 领手续费 事件，每笔按当时的池价折算。
// 网页用它算 盈亏 = 现值 + 未领手续费 + 已领手续费 + 已撤本金 − 存入。价格：事件里有当时的 bin / tick 就用它；没有（纯领手续费、CLMM 仓位不跨现价）
// 退到 GeckoTerminal 的分钟 K 线，再不行用同一仓位最近一次已知的价格。已平仓 = 扫钱包自己的交易找到的、现在已经不在的仓位
import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js'
import { solanaCfg } from '../settings.ts'
import { log, quoteSide, sleep, type SolClients } from './common.ts'
import type { LedgerEvent, SolPool, SolPosition } from './lp.ts'

type PosKey = Pick<SolPosition, 'id' | 'pool'> & { lower?: number }
type Store = { ledgers: Map<string, { at: number; events: LedgerEvent[]; sigs: Set<string> }>; txCache: Map<string, ParsedTransactionWithMeta | null>; ohlcv: Map<string, Promise<number | null>> }
const stores = new Map<string, Store>()
const storeOf = (c: SolClients) => { const k = `solana:${c.protocol}`; let s = stores.get(k); if (!s) { s = { ledgers: new Map(), txCache: new Map(), ohlcv: new Map() }; stores.set(k, s) }; return s }

// 一批签名一次 JSON-RPC batch 拿回（getParsedTransactions），比逐笔快几倍；已拿过的不再拉
async function fetchTxs(c: SolClients, sigs: string[]) {
  const S = storeOf(c)
  const need = sigs.filter((s) => !S.txCache.has(s))
  const one = async (chunk: string[]) => {
    let got: (ParsedTransactionWithMeta | null)[] | null = null
    for (let attempt = 1; !got; attempt++) {
      try { got = await c.conn.getParsedTransactions(chunk, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }) }
      catch (e: any) { if (attempt >= 6) throw e; await sleep(1500 * attempt) } // 两个节点都在限流：多等一会儿再来
    }
    chunk.forEach((s, j) => S.txCache.set(s, got![j]))
  }
  // 25 笔一批、串行：Alchemy 免费档对 getTransaction 限流很紧（一批约 3 秒），并发只会把公共节点也打到 429
  for (let i = 0; i < need.length; i += 25) await one(need.slice(i, i + 25))
  return sigs.map((s) => S.txCache.get(s) ?? null)
}
// GeckoTerminal 分钟 K 线：某个时刻这个池的价格（计价币 每 代币）；拉不到返回 null
function geckoPriceAt(c: SolClients, pool: SolPool, time: number): Promise<number | null> {
  const S = storeOf(c), minute = Math.floor(time / 60_000) * 60
  const k = `${pool.id}:${minute}`
  if (!S.ohlcv.has(k)) {
    S.ohlcv.set(k, (async () => {
      try {
        const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool.id}/ohlcv/minute?before_timestamp=${minute + 60}&limit=1&currency=token`, { signal: AbortSignal.timeout(10_000) })
        if (!r.ok) return null
        const list: any[] = (await r.json())?.data?.attributes?.ohlcv_list ?? []
        return list.length ? Number(list[0][4]) : null // [ts, o, h, l, c, v]
      } catch { return null }
    })())
  }
  return S.ohlcv.get(k)!
}

// 某个仓位的流水（按时间升序），增量：只拉上次之后的新签名
export async function positionLedger(c: SolClients, p: PosKey, full = false): Promise<LedgerEvent[]> {
  const S = storeOf(c)
  const addr = new PublicKey(c.lp.ledgerAddress(p))
  const cur = S.ledgers.get(p.id)
  if (cur && !full && Date.now() - cur.at < 60_000) return cur.events
  const known = cur?.sigs ?? new Set<string>()
  const fresh: string[] = []
  for (let before: string | undefined; ; ) {
    const page = await c.conn.getSignaturesForAddress(addr, { limit: 100, before }, 'confirmed')
    let hitKnown = false
    for (const s of page) { if (known.has(s.signature)) { hitKnown = true; break } if (!s.err) fresh.push(s.signature) }
    if (hitKnown || page.length < 100) break
    before = page[page.length - 1].signature
  }
  const events = [...(cur?.events ?? [])]
  for (const tx of await fetchTxs(c, fresh)) { if (!tx) continue; const ev = await c.lp.parseLedger(tx, p).catch(() => null); if (ev) events.push(ev) }
  events.sort((a, b) => a.time - b.time || a.block - b.block)
  // 补价格：先 Gecko，再用邻近事件的价格
  const q = quoteSide(p.pool)
  for (const e of events) if (e.price === null) { const g = await geckoPriceAt(c, p.pool, e.time); if (g !== null && q) e.price = q.tokenIsX ? g : 1 / g }
  for (let i = 0; i < events.length; i++) if (events[i].price === null) { const near = events.slice(0, i).reverse().find((x) => x.price !== null) ?? events.slice(i + 1).find((x) => x.price !== null); if (near) events[i].price = near.price }
  S.ledgers.set(p.id, { at: Date.now(), events, sigs: new Set([...known, ...fresh]) })
  return events
}

// 已平仓：扫钱包最近的交易（最多 maxSigs 笔），找到本协议里出现过 加流动性 事件、而现在不在 live 里的仓位
export type ClosedCandidate = { id: string; pool: SolPool; closed: { time: number; tx: string } }
type Found = { id: string; poolId: string | null; closed: { time: number; tx: string } }
const wallets = new Map<string, { scanned: Set<string>; found: Map<string, Found>; pools: Map<string, SolPool | null> }>()
export async function closedPositions(c: SolClients, live: Set<string>, maxSigs = Number(solanaCfg().historyTxs || 800)): Promise<ClosedCandidate[]> {
  const k = `${c.protocol}:${c.wallet.toBase58()}`
  let W = wallets.get(k)
  if (!W) { W = { scanned: new Set(), found: new Map(), pools: new Map() }; wallets.set(k, W) }
  const fresh: string[] = []
  for (let before: string | undefined; fresh.length < maxSigs; ) {
    const page = await c.conn.getSignaturesForAddress(c.wallet, { limit: 100, before }, 'confirmed')
    let hit = false
    for (const s of page) { if (W.scanned.has(s.signature)) { hit = true; break } if (!s.err) fresh.push(s.signature) }
    if (hit || page.length < 100) break
    before = page[page.length - 1].signature
  }
  let n = 0
  for (let i = 0; i < fresh.length; i += 100) {
    const sigs = fresh.slice(i, i + 100)
    const txs = await fetchTxs(c, sigs)
    for (const [j, tx] of txs.entries()) {
      W.scanned.add(sigs[j])
      if (!tx?.meta?.logMessages?.some((l) => /Instruction: (AddLiquidity|RemoveLiquidity|ClaimFee|ClosePosition|Rebalance|InitializePosition|OpenPosition|IncreaseLiquidity|DecreaseLiquidity|CollectFee)/.test(l))) continue
      for (const hit of await c.lp.positionsInTx(tx).catch(() => [])) {
        const cur = W.found.get(hit.id) ?? { id: hit.id, poolId: null, closed: { time: 0, tx: '' } }
        if (hit.poolId) cur.poolId = hit.poolId
        if (hit.action === 'remove' && (tx.blockTime ?? 0) * 1000 >= cur.closed.time) cur.closed = { time: (tx.blockTime ?? 0) * 1000, tx: sigs[j] }
        W.found.set(hit.id, cur); n++
      }
    }
  }
  if (fresh.length) log(`已平仓扫描: 钱包最近 ${fresh.length} 笔交易，${n} 条仓位事件`)
  const out: ClosedCandidate[] = []
  for (const f of W.found.values()) {
    if (live.has(f.id) || !f.closed.time || !f.poolId) continue
    if (!W.pools.has(f.poolId)) W.pools.set(f.poolId, await c.lp.poolById(f.poolId).catch(() => null))
    const pool = W.pools.get(f.poolId)
    if (pool) out.push({ id: f.id, pool, closed: f.closed })
  }
  return out
}
