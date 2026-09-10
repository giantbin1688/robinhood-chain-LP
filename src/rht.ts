// rhtrenches.com：第三方、只读、免登录的 fomo.family 交易者链上成交流（BSC 使用相同协议的 bsctrenches.com），公开 API + WebSocket。
// 它已经做了我们在链上做不到的事：把「别人买了塞进大 V 钱包」和「本人买入」分开（flags: planted / transferred / spoofed / airdropped）——
// 这两种在链上结构一模一样（都是中继代付、代币经 fomo router 进钱包），区别只在付款方是不是 fomo 自己的现金账户。
// 协议（来自它的 app.js）：wss://rhtrenches.com/ws 推 {type:'hello'|'fills'|'labels', data}，每 20 秒发 'p' 心跳；断了退回每 5 秒 GET /api/tape?limit=60 按 id 去重。
// 字段：/api/tape 一行 = 一笔成交 {id, ts, tx, side, usd, amount, price, funding, payer, handle, wallet, token, symbol, liquidity, mcap, pair_created_at, buys24, sells24, flags[]}
import type { ChainName } from './chains.ts'
import { log } from './common.ts'

export type Fill = {
  id: number; ts: number; tx: `0x${string}`; block: number; side: 'buy' | 'sell'; usd: number | null; amount: number; price: number | null
  funding: string | null; payer: string | null; handle: string; display_name: string; followers: number; wallet: string
  token: string; symbol: string; name: string; liquidity: number | null; mcap: number | null; pair_created_at: number | null; buys24: number; sells24: number; flags: string[]
}
export type RhtTrader = { address: string; handle: string; display_name: string; followers: number; volume: number; fills: number; net_pnl: number; active: boolean }
export type RhtStatus = { state: 'off' | 'connecting' | 'live' | 'polling' | 'down'; wallets: number; lastFillAt: number; lastOkAt: number; lastId: number; error: string }

export type FeedChain = Extract<ChainName, 'robinhood' | 'bsc'>
export const SOURCES: Record<FeedChain, string> = { robinhood: 'https://rhtrenches.com', bsc: 'https://bsctrenches.com' }

// 每条链独立持有连接、游标和名单缓存。
export function createFeed(chain: FeedChain) {
  const BASE = SOURCES[chain]
  const name = new URL(BASE).hostname.replace('.com', '')
  const UA = { 'user-agent': 'rh-uni (local LP tool; https://github.com/giantbin1688/robinhood-chain-LP)' }
  const STALE_MS = 90_000 // 超过这么久没从它拿到任何回应就算失联（状态灯变红；ws 在线时每 60 秒也会补拉一次 tape 兜底）
  const status: RhtStatus = { state: 'off', wallets: 0, lastFillAt: 0, lastOkAt: 0, lastId: 0, error: '' }
  const rhtStatus = () => ({ ...status })
  let onFill: (f: Fill, live: boolean) => void = () => {}
  let onStatus: (s: RhtStatus) => void = () => {}
  const push = () => onStatus({ ...status })
  const ok = () => { status.lastOkAt = Date.now(); if (status.state === 'down') { status.state = 'polling'; push() } }

  async function getJson<T>(path: string): Promise<T> {
    const r = await fetch(BASE + path, { headers: UA, signal: AbortSignal.timeout(20_000) })
    if (!r.ok) throw new Error(`${name} ${path.split('?')[0]} HTTP ${r.status}`)
    return r.json() as Promise<T>
  }
  const tape = (limit = 400) => getJson<Fill[]>(`/api/tape?limit=${limit}&stocks=true`)

  // 交易者名单（handle ↔ 钱包），10 分钟缓存；添加交易者时从这里取钱包、并校验在不在名单里
  let tradersCache: { at: number; p: Promise<RhtTrader[]> } | null = null
  function traders(): Promise<RhtTrader[]> {
    if (!tradersCache || Date.now() - tradersCache.at > 10 * 60_000) { const p = getJson<RhtTrader[]>('/api/traders'); p.catch(() => { tradersCache = null }); tradersCache = { at: Date.now(), p } }
    return tradersCache.p
  }

  // 每条成交只处理一次：按 id 单调推进。ws 和轮询可能重叠，轮询也可能补回 ws 断线期间漏掉的
  function ingest(rows: Fill[], live: boolean) {
    ok()
    for (const f of [...rows].sort((a, b) => a.id - b.id)) {
      if (f.id <= status.lastId) continue
      status.lastId = f.id; status.lastFillAt = Date.now()
      try { onFill(f, live) } catch (e: any) { log(`${name} 成交 #${f.id} 处理失败: ${String(e?.message).slice(0, 100)}`) }
    }
  }

  let ws: WebSocket | null = null
  let pollTimer: NodeJS.Timeout | null = null
  let pingTimer: NodeJS.Timeout | null = null
  let started = false
  const pull = (n: number) => tape(n).then((rows) => ingest(rows, true)).catch((e) => {
    status.error = String(e?.message).slice(0, 120)
    if (Date.now() - status.lastOkAt > STALE_MS && status.state !== 'down') { status.state = 'down'; push(); log(`${name}: 失联（${status.error}），恢复前收不到信号`) }
  })
  function startPolling() {
    if (pollTimer) return
    if (status.state !== 'down') { status.state = 'polling'; push() }
    pull(60); pollTimer = setInterval(() => pull(60), 5_000); pollTimer.unref()
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } }
  function connect() {
    if (status.state === 'off') status.state = 'connecting'
    push()
    let opened = false
    try { ws = new WebSocket(BASE.replace('https:', 'wss:') + '/ws') } catch (e: any) { status.error = String(e?.message).slice(0, 120); startPolling(); setTimeout(connect, 30_000).unref(); return }
    const openTimeout = setTimeout(() => { if (!opened) startPolling() }, 8_000); openTimeout.unref()
    ws.onopen = () => {
      opened = true; clearTimeout(openTimeout); stopPolling()
      status.state = 'live'; status.error = ''; ok(); push()
      // 心跳；每 60 秒顺手拉一次 tape：ws 没成交时也能确认它还活着（lastOkAt），ws 悄悄卡死也能靠 id 去重补上
      let n = 0
      pingTimer = setInterval(() => { if (ws?.readyState === 1) ws.send('p'); if (++n % 3 === 0) void pull(60) }, 20_000); pingTimer.unref()
    }
    ws.onmessage = (ev) => {
      ok()
      let m: any; try { m = JSON.parse(String(ev.data)) } catch { return }
      if (m.type === 'fills') ingest(m.data ?? [], true)
      else if (m.type === 'hello') { status.wallets = Number(m.data?.wallets ?? 0); push() }
    }
    ws.onerror = () => { try { ws?.close() } catch {} }
    ws.onclose = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
      clearTimeout(openTimeout)
      if (status.state === 'live') { status.state = 'polling'; push() }
      startPolling() // 断线期间靠轮询顶上，5 秒一次，按 id 去重不会重复
      setTimeout(connect, 5_000 + Math.random() * 5_000).unref()
    }
  }
  // 启动：先把最近 400 笔拉一遍（静默，不提醒，只为了把已有信号的真假标记补上 / 补漏），再连 ws
  async function start(o: { onFill: typeof onFill; onStatus: typeof onStatus }) {
    if (started) return
    started = true; onFill = o.onFill; onStatus = o.onStatus
    try {
      const rows = await tape(400)
      status.state = 'polling'
      ingest(rows, false)
      log(`${name}: 已同步最近 ${rows.length} 笔成交，连接实时流`)
    } catch (e: any) { status.error = String(e?.message).slice(0, 120); status.state = 'down'; log(`${name}: 初始同步失败 ${status.error}，会每 5 秒重试`) }
    connect()
  }

  return { rhtStatus, tape, traders, start }
}
