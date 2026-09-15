// Solana 仓位资金流水：仓位账户（DLMM）/ 仓位 PDA（CLMM）的全部交易，逐笔用适配器解析成 加流动性 / 撤流动性 / 领手续费 事件，每笔按当时的池价折算。
// 网页用它算 盈亏 = 现值 + 未领手续费 + 已领手续费 + 已撤本金 − 存入。价格：事件里有当时的 bin / tick 就用它；没有（纯领手续费、CLMM 仓位不跨现价）
// 退到 GeckoTerminal 的分钟 K 线，再不行用同一仓位最近一次已知的价格。已平仓 = 扫钱包自己的交易找到的、现在已经不在的仓位
import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js'
import { solanaCfg } from '../settings.ts'
import { log, quoteSide, sleep, QUOTES, USDC, WSOL, type SolClients, type SolToken } from './common.ts'
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
// GeckoTerminal 分钟 K 线：某个时刻这个池的价格（Y 每 X 的原始方向，调用方按 quoteSide 换向）；拉不到返回 null
export function geckoPriceAt(c: SolClients, pool: SolPool, time: number): Promise<number | null> {
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
  for (const tx of await fetchTxs(c, fresh)) {
    if (!tx) continue
    const ev = await c.lp.parseLedger(tx, p).catch(() => null)
    if (ev) { ev.fee = tx.transaction.message.accountKeys[0]?.pubkey.equals(c.wallet) ? tx.meta?.fee ?? 0 : 0; events.push(ev) } // 交易费（含优先费）记在付款人是自己钱包的交易上
  }
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
// flows：钱包每笔交易的净变化（现金账用）。sol 是原生 SOL（含交易费和租金），tokens 按 mint 汇总（含 wSOL 代币账户），lp 是这笔动了的本协议仓位
export type SolFlowTx = { sig: string; time: number; sol: bigint; fee: bigint; tokens: Map<string, bigint>; lp: { id: string; poolId: string | null; action: 'add' | 'remove' | 'collect' }[]; lpLike: boolean }
const wallets = new Map<string, { scanned: Set<string>; found: Map<string, Found>; pools: Map<string, SolPool | null>; flows: Map<string, SolFlowTx> }>()
const LP_RE = /Instruction: (AddLiquidity|RemoveLiquidity|ClaimFee|ClosePosition|Rebalance|InitializePosition|OpenPosition|IncreaseLiquidity|DecreaseLiquidity|CollectFee)/
export async function closedPositions(c: SolClients, live: Set<string>, maxSigs = Number(solanaCfg().historyTxs || 800)): Promise<ClosedCandidate[]> {
  const k = `${c.protocol}:${c.wallet.toBase58()}`
  let W = wallets.get(k)
  if (!W) { W = { scanned: new Set(), found: new Map(), pools: new Map(), flows: new Map() }; wallets.set(k, W) }
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
      if (!tx?.meta) continue
      const lpLike = !!tx.meta.logMessages?.some((l) => LP_RE.test(l))
      const hits = lpLike ? await c.lp.positionsInTx(tx).catch(() => []) : []
      // 现金账要每笔交易的钱包净变化：原生 SOL 直接读 pre/post（含交易费和租金），SPL 按 owner 是自己的代币账户汇总
      const keys = tx.transaction.message.accountKeys
      const wi = keys.findIndex((a) => a.pubkey.equals(c.wallet))
      const owner = c.wallet.toBase58()
      const tokens = new Map<string, bigint>()
      const acc = (list: typeof tx.meta.preTokenBalances, sign: bigint) => { for (const b of list ?? []) if (b.owner === owner) tokens.set(b.mint, (tokens.get(b.mint) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount)) }
      acc(tx.meta.postTokenBalances, 1n); acc(tx.meta.preTokenBalances, -1n)
      W.flows.set(sigs[j], { sig: sigs[j], time: (tx.blockTime ?? 0) * 1000, sol: wi >= 0 ? BigInt(tx.meta.postBalances[wi]) - BigInt(tx.meta.preBalances[wi]) : 0n, fee: keys[0]?.pubkey.equals(c.wallet) ? BigInt(tx.meta.fee) : 0n, tokens, lp: hits, lpLike })
      for (const hit of hits) {
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

// ---- 现金账（和 EVM history.ts 的 tokenEpisodes 同一思路）：按代币把 买币 -> 建仓 -> 撤仓 -> 卖币 串成段（episode），
// 段内钱包计价币的净变化（SOL 计价 = 原生 SOL + wSOL，交易费单列；租金随开仓/平仓自然相抵）就是这次操作真实赚亏的钱。
// 只用 closedPositions 扫过的钱包交易（flows），所以必须先调它；别的协议的 LP 交易（有 LP 指令但没有本协议仓位）跳过，归它自己的账
export type SolSwapFlow = { sig: string; time: number; side: 'buy' | 'sell'; tokenAmt: bigint; quoteAmt: bigint } // 都是正数（基础单位）
export type SolEpisode = {
  token: string; quote: SolToken; pool: SolPool | null; start: number; end: number; closedAt: number
  ids: string[]; txs: number; open: boolean // open：仓位没撤完 / 段还没结束，日历不显示
  net: bigint; buys: bigint; sells: bigint; lpIn: bigint; lpOut: bigint; feeLamports: bigint; leftover: bigint; swaps: SolSwapFlow[]
}
export type SolOtherFlow = { time: number; sol: bigint; usdc: bigint; kind: 'transfer' | 'multi' }
export async function solTokenEpisodes(c: SolClients, live: Set<string>): Promise<{ episodes: SolEpisode[]; other: SolOtherFlow[] }> {
  const W = wallets.get(`${c.protocol}:${c.wallet.toBase58()}`)
  if (!W) return { episodes: [], other: [] }
  const flows = [...W.flows.values()].sort((a, b) => a.time - b.time || (a.sig < b.sig ? -1 : 1))
  const poolOf = async (pid: string | null) => { if (!pid) return null; if (!W.pools.has(pid)) W.pools.set(pid, await c.lp.poolById(pid).catch(() => null)); return W.pools.get(pid) ?? null }
  // 每个仓位最后一次撤出的交易：现在不在钱包名下的仓位视为在那笔关闭（DLMM/CLMM 的撤出事件不带"是否清零"，用最终归属判断）
  const lastRemove = new Map<string, string>()
  for (const f of flows) for (const h of f.lp) if (h.action === 'remove') lastRemove.set(h.id, f.sig)
  const byToken = new Map<string, { f: SolFlowTx; tokenDelta: bigint; hits: SolFlowTx['lp'] }[]>()
  const other: SolOtherFlow[] = []
  const tokenQuote = new Map<string, SolToken>() // 代币 -> 它的 LP 池计价币
  const tokenPool = new Map<string, SolPool>()
  for (const f of flows) {
    if (f.lpLike && !f.lp.length) continue // 别的协议（或别人）的 LP 交易
    const moved = [...f.tokens].filter(([m, v]) => v !== 0n && m !== WSOL && m !== USDC).map(([m]) => m)
    const lpTokens: string[] = []
    for (const h of f.lp) {
      const pool = await poolOf(h.poolId); const side = pool && quoteSide(pool)
      if (pool && side) { const tok = side.tokenIsX ? pool.mintX : pool.mintY; lpTokens.push(tok); if (!tokenQuote.has(tok)) tokenQuote.set(tok, side.quote); if (!tokenPool.has(tok)) tokenPool.set(tok, pool) }
    }
    const all = new Set([...moved, ...lpTokens])
    if (all.size !== 1) { // 不归任何代币（SOL<->USDC、转账、纯租金）或一笔动了两种代币：不进段，另列供对账
      const usdc = f.tokens.get(USDC) ?? 0n, sol = f.sol + f.fee + (f.tokens.get(WSOL) ?? 0n)
      if (usdc !== 0n || sol !== 0n) other.push({ time: f.time, sol, usdc, kind: all.size ? 'multi' : 'transfer' })
      continue
    }
    const [tok] = all
    byToken.set(tok, [...(byToken.get(tok) ?? []), { f, tokenDelta: f.tokens.get(tok) ?? 0n, hits: f.lp }])
  }
  const episodes: SolEpisode[] = []
  for (const [token, list] of byToken) {
    const quote = tokenQuote.get(token) ?? (list.some((x) => (x.f.tokens.get(USDC) ?? 0n) !== 0n) ? QUOTES.USDC : QUOTES.SOL)
    let ep: SolEpisode | null = null, bal = 0n, maxBal = 0n
    const opened = new Set<string>()
    const finish = (open: boolean) => { if (!ep) return; ep.open = open; ep.leftover = bal; if (!ep.closedAt) ep.closedAt = ep.end; episodes.push(ep); ep = null; bal = 0n; maxBal = 0n }
    for (let i = 0; i < list.length; i++) {
      const { f, tokenDelta, hits } = list[i]
      const qd = quote.symbol === 'USDC' ? (f.tokens.get(USDC) ?? 0n) : f.sol + f.fee + (f.tokens.get(WSOL) ?? 0n) // 计价币净变化，交易费拿出来单列
      if (!ep) ep = { token, quote, pool: tokenPool.get(token) ?? null, start: f.time, end: f.time, closedAt: 0, ids: [], txs: 0, open: false, net: 0n, buys: 0n, sells: 0n, lpIn: 0n, lpOut: 0n, feeLamports: 0n, leftover: 0n, swaps: [] }
      ep.end = f.time; ep.txs++; ep.feeLamports += f.fee; ep.net += qd
      bal += tokenDelta; if (bal > maxBal) maxBal = bal
      if (hits.length) {
        for (const h of hits) { if (h.action === 'add') opened.add(h.id); if (!ep.ids.includes(h.id)) ep.ids.push(h.id) }
        if (qd < 0n) ep.lpIn += -qd; else ep.lpOut += qd
        for (const h of hits) if (h.action === 'remove' && !live.has(h.id) && lastRemove.get(h.id) === f.sig) opened.delete(h.id)
        if (hits.some((h) => h.action === 'remove') && !opened.size) ep.closedAt = f.time
      } else if (qd < 0n) { ep.buys += -qd; ep.swaps.push({ sig: f.sig, time: f.time, side: 'buy', tokenAmt: tokenDelta, quoteAmt: -qd }) }
      else { ep.sells += qd; ep.swaps.push({ sig: f.sig, time: f.time, side: 'sell', tokenAmt: -tokenDelta, quoteAmt: qd }) }
      if (opened.size) continue
      const next = list[i + 1]
      const dust = bal <= (maxBal * 5n) / 1000n && !(next && next.tokenDelta < 0n && !next.hits.length && bal > 0n) // 粉尘马上要卖的，等卖完一起算
      if (dust || !next || (ep.ids.length && next.tokenDelta > 0n && !next.hits.length)) finish(false)
    }
    finish(true)
  }
  return { episodes: episodes.filter((e) => e.ids.length || e.net !== 0n).sort((a, b) => a.closedAt - b.closedAt), other }
}
