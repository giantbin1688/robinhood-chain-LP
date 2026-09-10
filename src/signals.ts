// 信号：盯 FOMO（fomo.family）交易者的钱包，链上抓到买入 / 卖出就记一条信号，买入顺手做一遍代币安全检查，再推到网页 / Telegram。
// fomo.family 没有公开 API（后端 prod-api.fomo.family 要登录态的 Privy token），所以数据源只有链：
//   fomo 的交易是 ERC-4337 UserOp（bundler 代发，tx.to = EntryPoint，钱包本身不发交易），要按「钱包地址出现在 ERC-20 Transfer 的 from / to」抓；
//   买入 = 代币从 fomo router 转进钱包（USDG / ETH 由 fomo 资金池垫付，同一笔里能看到），卖出 = 代币从钱包转给 router（USDG 回 fomo vault，不回钱包）；
//   来源不是 router 的转入基本都是别人空投的碎币（同一地址反复打同样数量），记成 dust 不提醒。
// 金额：同一笔交易里 USDG 的最大一段转账（同一笔钱经过好几手，取最大值就是本金），没有 USDG 就看 WETH（含从 0 地址 mint 的那段）按 ETH 价折算。
// 第二个来源 rhtrenches.com（rht.ts）：第三方公开的 fomo 交易者成交流，能分出「别人买了塞进钱包」（planted / transferred / spoofed / airdropped）和本人买入——
//   这两种在链上一模一样（都是中继代付、代币经 router 进钱包），只有付款方不同，靠我们自己分不出来。同一笔交易两边都抓到就合并，rht 的真假标记优先；
//   链上先抓到的买入在 rht 在线时等它 8 秒再提醒，免得给一笔塞币弹提醒。
// 交易者的钱包地址：只填 handle 时先查 rhtrenches 的名单（免费），再查 FomoScan（付费），都没有就手填（fomo 个人页头像旁）。fomo 自己的后端在 Cloudflare 机器人拦截后面，脚本调不了，试过、放弃了。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { formatUnits, getAddress, isAddress, parseAbi, parseAbiItem, parseEventLogs, parseUnits, type Address, type Hex } from 'viem'
import { CHAINS, type ChainName } from './chains.ts'
import { erc20Abi, log, makeClients, nativePriceUsd, sleep, tokenMeta, type Clients } from './common.ts'
import { listTokenPools } from './pools.ts'
import { fomoscanKey, tgConfig } from './settings.ts'
import * as rht from './rht.ts'

export type Trader = { handle: string; wallet: Address; chain: ChainName; on: boolean; muted: boolean; addedAt: number }
export type SignalKind = 'buy' | 'sell' | 'fund' | 'dust' | 'out'
export type SignalSource = 'chain' | 'rht' | 'both'
export type Safety = { status: 'ok' | 'warn' | 'bad' | 'pending' | 'error'; reasons: string[]; facts: Record<string, string | number | null>; at: number }
export type Signal = {
  id: number; time: number; block: number; chain: ChainName; handle: string; wallet: Address; kind: SignalKind
  token: Address; symbol: string; decimals: number; amount: string; sizeUsd: number | null; price: number | null // price = 每枚多少美元（按这笔成交算）
  tx: Hex; text: string; safety: Safety | null
  source?: SignalSource; flags?: string[] // rhtrenches 的标记（planted = 别人塞的，few sellers、pool 3m old…）
}
type Store = { traders: Trader[]; signals: Signal[]; seq: number; cursor: Partial<Record<ChainName, number>> }
type TLog = { address: Address; transactionHash: Hex; logIndex: number; blockNumber: bigint | null; args: { from: Address; to: Address; value: bigint } }
export type WatcherStatus = { chain: ChainName; running: boolean; supported: boolean; head: number; cursor: number; lag: number; lastAt: number; error: string; backfilling: boolean; watched: number }

const FILE = new URL('../signals.json', import.meta.url)
const MAX_SIGNALS = 1000
const BACKFILL_BLOCKS = 36_000  // 首次 / 落后太久时从最近这么多块开始扫（Robinhood 0.1 秒一块 ≈ 1 小时）
const CHUNK = 2_000             // 一次 getLogs 的区块跨度（公共节点）；Alchemy 一次 10k 也只要几百毫秒
const TICK_MS = 2_000
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

const store: Store = existsSync(FILE) ? { traders: [], signals: [], seq: 0, cursor: {}, ...JSON.parse(readFileSync(FILE, 'utf8')) } : { traders: [], signals: [], seq: 0, cursor: {} }
let saveTimer: NodeJS.Timeout | null = null
const save = () => { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; writeFileSync(FILE, JSON.stringify(store, null, 1) + '\n') }, 500) } // 攒 0.5 秒再落盘，一笔交易几条信号不用写几次

// ---- 交易者名单 ----
export const traders = () => store.traders
export const signals = (chain?: ChainName) => (chain ? store.signals.filter((s) => s.chain === chain) : store.signals)
export async function addTrader(o: { handle: string; wallet?: string; chain: ChainName }): Promise<Trader> {
  const handle = o.handle.trim().replace(/^@/, '')
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(handle)) throw new Error('handle 只能是字母 / 数字 / _ . -')
  if (!CHAINS[o.chain]?.fomo) throw new Error(`${CHAINS[o.chain]?.label ?? o.chain} 上还没核对过 fomo 的合约地址，暂时只能盯 Robinhood Chain`)
  let wallet = o.wallet?.trim() ?? ''
  if (!wallet) wallet = await lookupWallet(handle)
  if (!isAddress(wallet)) throw new Error('钱包地址不合法')
  const w = getAddress(wallet)
  if (store.traders.some((t) => t.chain === o.chain && same(t.wallet, w))) throw new Error(`这个钱包已经在盯着了（@${store.traders.find((t) => same(t.wallet, w))!.handle}）`)
  const t: Trader = { handle, wallet: w, chain: o.chain, on: true, muted: false, addedAt: Date.now() }
  store.traders.push(t); save()
  watcherOf(o.chain).kick()
  return t
}
export function updateTrader(chain: ChainName, wallet: string, patch: Partial<Pick<Trader, 'on' | 'muted' | 'handle'>>) {
  const t = store.traders.find((x) => x.chain === chain && same(x.wallet, wallet))
  if (!t) throw new Error('交易者不存在')
  Object.assign(t, patch); save()
  return t
}
export function removeTrader(chain: ChainName, wallet: string) {
  const i = store.traders.findIndex((x) => x.chain === chain && same(x.wallet, wallet))
  if (i < 0) throw new Error('交易者不存在')
  store.traders.splice(i, 1); save()
}
export function clearSignals(chain: ChainName) { store.signals = store.signals.filter((s) => s.chain !== chain); save() }

// FomoScan（https://api.fomoscan.sh，独立的第三方，handle ↔ 钱包映射，每次查询扣 credits）
async function lookupWallet(handle: string): Promise<string> {
  const hit = await rht.lookupHandle(handle)
  if (hit) return hit.address
  const key = fomoscanKey()
  if (!key) throw new Error(`@${handle} 不在 rhtrenches 的名单里，也没配 FomoScan key，查不到钱包。fomo 个人页（fomo.family/profile/${handle}）头像旁的地址可以直接复制`)
  const r = await fetch(`https://api.fomoscan.sh/v2/user/handle/${encodeURIComponent(handle)}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`FomoScan ${r.status}: ${j.message ?? j.error ?? '查询失败'}`)
  if (!j.evmAddress) throw new Error(`FomoScan 没有 @${handle} 的 EVM 钱包`)
  return j.evmAddress
}

// ---- 链上监控：每条链一个循环 ----
// signal 事件带 alert=true 表示该弹提醒（新的、确认过的买卖）；更新 / 补标记 / 回填的不弹
type Emit = (ev: { type: 'signal'; signal: Signal; alert?: boolean } | { type: 'watcher'; status: WatcherStatus } | { type: 'rht'; status: rht.RhtStatus }) => void
let emit: Emit = () => {}
export const onEvent = (fn: Emit) => { emit = fn }

class Watcher {
  status: WatcherStatus
  private c: Clients | null = null
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private metaCache = new Map<string, Promise<{ symbol: string; decimals: number }>>()
  private ethPrice = { at: 0, v: 0 }
  private blockTimes = new Map<number, Promise<number>>()
  constructor(readonly chain: ChainName) {
    this.status = { chain, running: false, supported: !!CHAINS[chain].fomo, head: 0, cursor: store.cursor[chain] ?? 0, lag: 0, lastAt: 0, error: '', backfilling: false, watched: 0 }
  }
  private myTraders() { return store.traders.filter((t) => t.chain === this.chain && t.on) }
  kick() { if (!this.timer) this.loop() }
  private async loop() {
    this.timer = setTimeout(() => this.loop(), TICK_MS)
    if (this.busy) return
    this.busy = true
    try { await this.tick() } catch (e: any) {
      const msg = `${e?.shortMessage ?? e?.message ?? e}${e?.details ? `（${String(e.details).slice(0, 80)}）` : ''}`.slice(0, 160)
      if (msg !== this.status.error) log(`信号 ${this.chain} 读链失败，2 秒后重试: ${msg}`)
      this.status.error = msg; this.push()
    } finally { this.busy = false }
  }
  private push() { emit({ type: 'watcher', status: { ...this.status } }) }
  async client() {
    // 没有 PRIVATE_KEY 也能盯：from 随便给一个地址，这里只读
    if (!this.c) this.c = await makeClients({ needKey: false, from: '0x0000000000000000000000000000000000000001', chain: this.chain })
    return this.c
  }
  private async tick() {
    const ts = this.myTraders()
    this.status.watched = ts.length
    if (!ts.length || !this.status.supported) { if (this.status.running) { this.status.running = false; this.push() }; return }
    const c = await this.client()
    const head = Number(await c.pub.getBlockNumber())
    this.status.head = head; this.status.running = true; this.status.error = ''
    if (!this.status.cursor || head - this.status.cursor > BACKFILL_BLOCKS * 2) this.status.cursor = head - BACKFILL_BLOCKS
    this.status.backfilling = head - this.status.cursor > CHUNK * 2
    const wallets = ts.map((t) => t.wallet)
    while (this.status.cursor < head) {
      const chunk = c.rpcIsAlchemy ? CHUNK * 5 : CHUNK
      const from = BigInt(this.status.cursor + 1), to = BigInt(Math.min(head, this.status.cursor + chunk))
      // 两个方向串行发：并行会被 viem 合成一个 JSON-RPC batch，Alchemy 对 getLogs 的 batch 时不时回非数组，viem 解析就炸（Cannot read properties of undefined）
      const outs = await c.pub.getLogs({ event: transferEvent, args: { from: wallets }, fromBlock: from, toBlock: to })
      const ins = await c.pub.getLogs({ event: transferEvent, args: { to: wallets }, fromBlock: from, toBlock: to })
      const byTx = new Map<Hex, TLog[]>()
      for (const l of [...outs, ...ins] as TLog[]) { const arr = byTx.get(l.transactionHash) ?? []; if (!arr.some((x) => x.logIndex === l.logIndex)) arr.push(l); byTx.set(l.transactionHash, arr) }
      for (const [tx, logs] of byTx) await this.handleTx(c, tx, logs, ts).catch((e) => log(`信号 ${tx.slice(0, 10)}… 解析失败: ${String(e?.shortMessage ?? e?.message).slice(0, 120)}`))
      this.status.cursor = Number(to); store.cursor[this.chain] = this.status.cursor; save()
      this.status.lastAt = Date.now(); this.status.lag = head - this.status.cursor
      this.status.backfilling = head - this.status.cursor > CHUNK * 2
      if (this.status.backfilling) this.push()
    }
    this.status.lag = 0; this.status.backfilling = false
    this.push()
  }
  private meta(c: Clients, token: Address) {
    const k = token.toLowerCase()
    if (!this.metaCache.has(k)) { const p = tokenMeta(c.pub, token).then((m) => ({ symbol: m.symbol, decimals: m.decimals })); p.catch(() => this.metaCache.delete(k)); this.metaCache.set(k, p) }
    return this.metaCache.get(k)!
  }
  private blockTime(c: Clients, block: number) {
    if (!this.blockTimes.has(block)) {
      if (this.blockTimes.size > 500) this.blockTimes.clear()
      const p = c.pub.getBlock({ blockNumber: BigInt(block) }).then((b) => Number(b.timestamp) * 1000); p.catch(() => this.blockTimes.delete(block)); this.blockTimes.set(block, p)
    }
    return this.blockTimes.get(block)!
  }
  private async nativeUsd(c: Clients) {
    if (Date.now() - this.ethPrice.at > 60_000) { this.ethPrice = { at: Date.now(), v: await nativePriceUsd(c).catch(() => this.ethPrice.v) } }
    return this.ethPrice.v
  }
  // 一笔交易里某个交易者的转账 -> 信号。同一笔可能既卖 A 又买 B（两条信号）
  private async handleTx(c: Clients, tx: Hex, logs: TLog[], ts: Trader[]) {
    const { fomo } = c.cfg
    if (!fomo) return
    const isQuote = (t: Address) => same(t, c.cfg.quote.address) || same(t, c.cfg.wnative)
    const isFomo = (a: Address) => same(a, fomo.router) || same(a, fomo.vault)
    if (store.signals.some((s) => s.tx === tx)) return // 重启后重扫到的
    const block = Number(logs[0].blockNumber)
    const time = await this.blockTime(c, block)
    let receipt: { usdgMax: bigint; wethMax: bigint } | null = null
    const sizeOf = async () => {
      if (!receipt) {
        const rc = await c.pub.getTransactionReceipt({ hash: tx })
        let usdgMax = 0n, wethMax = 0n
        for (const l of parseEventLogs({ abi: [transferEvent], logs: rc.logs })) {
          if (same(l.address, c.cfg.quote.address) && l.args.value > usdgMax) usdgMax = l.args.value
          if (same(l.address, c.cfg.wnative) && l.args.value > wethMax) wethMax = l.args.value
        }
        receipt = { usdgMax, wethMax }
      }
      // 用 ETH 买时 USDG 只是路由中间跳的一段，比本金小；两条腿都算、取大的
      const usdg = Number(formatUnits(receipt.usdgMax, c.cfg.quote.decimals))
      const weth = receipt.wethMax > 0n ? Number(formatUnits(receipt.wethMax, 18)) * (await this.nativeUsd(c)) : 0
      return usdg > 0 || weth > 0 ? Math.max(usdg, weth) : null
    }
    for (const t of ts) {
      // 该交易者在这笔里的进出，按代币汇总
      const sums = new Map<string, { token: Address; in: bigint; out: bigint; fromFomo: boolean; toFomo: boolean; peer: Address }>()
      for (const l of logs) {
        const toMe = same(l.args.to, t.wallet), fromMe = same(l.args.from, t.wallet)
        if (!toMe && !fromMe) continue
        const k = l.address.toLowerCase()
        const s = sums.get(k) ?? { token: getAddress(l.address), in: 0n, out: 0n, fromFomo: false, toFomo: false, peer: toMe ? l.args.from : l.args.to }
        if (toMe) { s.in += l.args.value; if (isFomo(l.args.from)) s.fromFomo = true }
        if (fromMe) { s.out += l.args.value; if (isFomo(l.args.to)) s.toFomo = true }
        sums.set(k, s)
      }
      for (const s of sums.values()) {
        const net = s.in - s.out
        if (net === 0n) continue
        let kind: SignalKind
        if (isQuote(s.token)) kind = 'fund'
        else if (net > 0n) kind = s.fromFomo ? 'buy' : 'dust'
        else kind = s.toFomo ? 'sell' : 'out'
        const m = await this.meta(c, s.token).catch(() => ({ symbol: short(s.token), decimals: 18 }))
        const amountRaw = net > 0n ? net : -net
        const amount = formatUnits(amountRaw, m.decimals)
        const sizeUsd = kind === 'buy' || kind === 'sell' ? await sizeOf().catch(() => null) : null
        const price = sizeUsd && Number(amount) > 0 ? sizeUsd / Number(amount) : null
        const usd = sizeUsd === null ? '' : ` $${sizeUsd >= 100 ? Math.round(sizeUsd).toLocaleString('en-US') : sizeUsd.toFixed(2)}`
        const amt = fmtAmt(Number(amount))
        const text = kind === 'buy' ? `${t.handle} 买入 ${m.symbol}${usd}（${amt} 枚）` : kind === 'sell' ? `${t.handle} 卖出 ${m.symbol}${usd}（${amt} 枚）`
          : kind === 'fund' ? `${t.handle} ${net > 0n ? '收到' : '转出'} ${amt} ${m.symbol}（${isFomo(s.peer) ? 'fomo 资金进出' : short(s.peer)}）`
          : kind === 'dust' ? `${t.handle} 收到 ${amt} ${m.symbol}，来自 ${short(s.peer)}（不是 fomo 路由，疑似空投 / 碎币）` : `${t.handle} 转出 ${amt} ${m.symbol} 到 ${short(s.peer)}`
        const sig: Signal = { id: ++store.seq, time, block, chain: this.chain, handle: t.handle, wallet: t.wallet, kind, token: s.token, symbol: m.symbol, decimals: m.decimals, amount, sizeUsd, price, tx, text, safety: kind === 'buy' ? { status: 'pending', reasons: [], facts: {}, at: Date.now() } : null }
        store.signals.push(sig)
        if (store.signals.length > MAX_SIGNALS) store.signals.splice(0, store.signals.length - MAX_SIGNALS)
        save()
        if (!this.status.backfilling) log(`信号: ${text}`)
        emit({ type: 'signal', signal: sig })
        if (kind === 'buy') void runSafety(sig, !this.status.backfilling)
        if ((kind === 'buy' || kind === 'sell') && !this.status.backfilling) {
          // rht 在线：等它 8 秒——它会把「别人塞的」标出来，标了就不提醒；不在线只能按链上的判断提醒
          if (rht.rhtLive()) setTimeout(() => { if ((sig.kind === 'buy' || sig.kind === 'sell') && !sig.flags?.some(isPlantedFlag)) alertSignal(sig) }, 8_000).unref()
          else alertSignal(sig)
        }
      }
    }
  }
}
// 提醒 = 推给页面（弹 toast / 桌面通知）+ Telegram；静音的交易者只记录
function alertSignal(sig: Signal) {
  const t = store.traders.find((x) => x.chain === sig.chain && same(x.wallet, sig.wallet))
  emit({ type: 'signal', signal: sig, alert: !t?.muted })
  if (!t?.muted) telegram(`${sig.kind === 'buy' ? '🟢' : '🔴'} ${sig.text}` + String.fromCharCode(10) + `${CHAINS[sig.chain].explorer}/tx/${sig.tx}`).catch(() => {})
}
// 安全检查排队做、间隔 2.5 秒：每次要打一下 GeckoTerminal（免费档约 30 次/分），启动补回一批买入时并发去查会 429、全被误判成「没有池」
const safetyQueue: (() => Promise<void>)[] = []
let safetyBusy = false
function runSafety(sig: Signal, notify: boolean) {
  safetyQueue.push(() => runSafetyNow(sig, notify))
  if (safetyBusy) return
  safetyBusy = true
  void (async () => { while (safetyQueue.length) { await safetyQueue.shift()!().catch(() => {}); if (safetyQueue.length) await sleep(2_500) }; safetyBusy = false })()
}
async function runSafetyNow(sig: Signal, notify: boolean) {
  const c = await watcherOf(sig.chain).client()
  const r = await checkToken(c, sig.token).catch((e): Safety => ({ status: 'error', reasons: [`检查失败: ${String(e?.shortMessage ?? e?.message).slice(0, 120)}`], facts: {}, at: Date.now() }))
  if (sig.kind !== 'buy') return // 检查期间被 rht 改判成塞币了
  sig.safety = r; save()
  emit({ type: 'signal', signal: sig })
  if (notify && r.status !== 'ok' && r.status !== 'error') {
    const t = store.traders.find((x) => x.chain === sig.chain && same(x.wallet, sig.wallet))
    if (t && !t.muted) telegram(`${r.status === 'bad' ? '⛔ 风险' : '⚠️ 注意'} ${sig.symbol}: ${r.reasons.join('；')}`).catch(() => {})
  }
}

// ---- rhtrenches 的成交 -> 信号（只收我们盯着的钱包）。同一笔交易链上已经记过就合并，它的真假标记优先 ----
const isPlantedFlag = (f: string) => /planted|transferred|spoofed|airdropped/i.test(f)
const usdText = (v: number | null) => (v === null || v === undefined ? '' : ` $${v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2)}`)
function ingestFill(f: rht.Fill, live: boolean) {
  const chain: ChainName = 'robinhood'
  const t = store.traders.find((x) => x.chain === chain && same(x.wallet, f.wallet))
  if (!t || !isAddress(f.token) || !isAddress(f.wallet)) return
  const planted = f.flags.filter(isPlantedFlag)
  const kind: SignalKind = planted.length ? 'dust' : f.side
  const amt = fmtAmt(f.amount)
  const note = f.flags.length ? `［rhtrenches: ${f.flags.join('；')}］` : ''
  const text = planted.length
    ? `${t.handle} 钱包${f.side === 'buy' ? '收到' : '转出'} ${f.symbol}${usdText(f.usd)}（${amt} 枚）——不是本人${f.side === 'buy' ? '买入' : '卖出'}：${planted.join('；')}（别人买了塞进来 / 转进来的）`
    : `${t.handle} ${f.side === 'buy' ? '买入' : '卖出'} ${f.symbol}${usdText(f.usd)}（${amt} 枚）${note}`
  const existing = store.signals.find((s) => same(s.tx, f.tx) && same(s.token, f.token) && same(s.wallet, f.wallet))
  if (existing) {
    existing.source = 'both'; existing.flags = f.flags
    if (existing.kind !== kind) {
      existing.kind = kind; existing.text = text
      if (kind === 'dust') existing.safety = null
      // 链上判成空投（代币不是从 router 来的）但 rht 说是真买入：fomo 还有别的执行路径，以 rht 为准，补做安全检查
      else if (kind === 'buy' && !existing.safety) { existing.safety = { status: 'pending', reasons: [], facts: {}, at: Date.now() }; void runSafety(existing, live) }
      if (live && (kind === 'buy' || kind === 'sell')) alertSignal(existing)
    }
    else if (f.flags.length && !existing.text.includes('rhtrenches')) existing.text = text
    if (f.usd) { existing.sizeUsd = f.usd; existing.price = f.price } // rht 按现金腿定价，比我们「取最大一段」准
    save(); emit({ type: 'signal', signal: existing })
    return
  }
  const sig: Signal = { id: ++store.seq, time: f.ts * 1000, block: f.block, chain, handle: t.handle, wallet: t.wallet, kind, token: getAddress(f.token), symbol: f.symbol, decimals: 0, amount: String(f.amount), sizeUsd: f.usd, price: f.price, tx: f.tx, text, safety: kind === 'buy' ? { status: 'pending', reasons: [], facts: {}, at: Date.now() } : null, source: 'rht', flags: f.flags }
  store.signals.push(sig)
  if (store.signals.length > MAX_SIGNALS) store.signals.splice(0, store.signals.length - MAX_SIGNALS)
  save()
  if (live) log(`信号(rht): ${text}`)
  emit({ type: 'signal', signal: sig })
  if (kind === 'buy') void runSafety(sig, live)
  if (live && (kind === 'buy' || kind === 'sell')) alertSignal(sig)
}
export const rhtStatus = rht.rhtStatus
const fmtAmt = (v: number) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v >= 1 ? v.toFixed(2) : v.toPrecision(3))

const watchers = new Map<ChainName, Watcher>()
export const watcherOf = (chain: ChainName) => { let w = watchers.get(chain); if (!w) { w = new Watcher(chain); watchers.set(chain, w) }; return w }
export const watcherStatus = (chain: ChainName) => watcherOf(chain).status
// 网页上手动点「重新检查」：绕过缓存
export async function recheckToken(chain: ChainName, token: Address) {
  safetyCache.delete(`${chain}:${token.toLowerCase()}`)
  const r = await checkToken(await watcherOf(chain).client(), token)
  for (const s of store.signals) if (s.chain === chain && same(s.token, token) && s.kind === 'buy') { s.safety = r; emit({ type: 'signal', signal: s }) }
  save()
  return r
}
export function startWatchers() {
  for (const ch of Object.keys(CHAINS) as ChainName[]) if (CHAINS[ch].fomo) watcherOf(ch).kick()
  void rht.start({ onFill: ingestFill, onStatus: (status) => emit({ type: 'rht', status }) })
  // 上次没查完 / 查失败（Gecko 限流之类）的买入，排队再查一遍
  for (const sig of store.signals) if (sig.kind === 'buy' && (!sig.safety || sig.safety.status === 'pending' || sig.safety.status === 'error')) runSafety(sig, false)
}

// ---- 代币安全检查：池子（流动性 / 池龄 / 成交）、合约（代理 / owner / mint / 黑名单）、能否转账（貔貅）、报价往返损耗（hook 税 / 深度）----
// 只做链上能查的，不接第三方风控（GoPlus 等不支持 Robinhood Chain）。结论：ok = 没发现问题，warn = 有可疑点，bad = 别碰
const SUSPICIOUS: [string, string][] = [
  ['40c10f19', 'mint(address,uint256)'], ['8456cb59', 'pause()'], ['f9f92be4', 'blacklist(address)'], ['0ecb93c0', 'addBlackList(address)'], ['fe575a87', 'isBlacklisted(address)'],
]
const EXTRA_ABI = parseAbi(['function owner() view returns (address)', 'function totalSupply() view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)'])
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex // EIP-1967 实现槽
const safetyCache = new Map<string, { at: number; p: Promise<Safety> }>()
export function checkToken(c: Clients, token: Address): Promise<Safety> {
  const k = `${c.cfg.name}:${token.toLowerCase()}`
  const hit = safetyCache.get(k)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.p
  const p = checkTokenNow(c, token); p.catch(() => safetyCache.delete(k))
  safetyCache.set(k, { at: Date.now(), p })
  return p
}
async function checkTokenNow(c: Clients, token: Address): Promise<Safety> {
  const { pub, cfg, lp } = c
  const reasons: string[] = [], facts: Safety['facts'] = {}
  let bad = false, warn = false
  const flag = (level: 'bad' | 'warn', why: string) => { reasons.push(why); if (level === 'bad') bad = true; else warn = true }
  const usd$ = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`
  const [m, code, pools] = await Promise.all([tokenMeta(pub, token), pub.getCode({ address: token }), listTokenPools(c, token, true)]) // Gecko 失败直接抛：限流不能当成「没有池」
  facts.symbol = m.symbol; facts.name = m.name
  // 池子：所有 DEX、所有计价币里流动性最大的那个
  const live = pools.filter((p) => !p.empty)
  const best = live.sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0]
  facts.pools = live.length
  if (!best) flag('bad', 'GeckoTerminal 上没有这个币的池子（太新或没人交易）')
  else {
    facts.bestPool = best.name; facts.liquidityUsd = Math.round(best.liquidityUsd); facts.volume24h = Math.round(best.volume24h); facts.fdvUsd = best.fdvUsd; facts.change24h = best.change24h
    facts.buyers24h = best.buyers24h; facts.sellers24h = best.sellers24h
    const oldest = live.reduce((o, p) => (p.createdAt && (!o || p.createdAt < o) ? p.createdAt : o), 0)
    if (oldest) { facts.ageMin = Math.round((Date.now() - oldest) / 60_000); facts.createdAt = oldest }
    if (best.liquidityUsd < 2_000) flag('bad', `最大的池流动性只有 ${usd$(best.liquidityUsd)}`)
    else if (best.liquidityUsd < 10_000) flag('warn', `最大的池流动性 ${usd$(best.liquidityUsd)}，很薄`)
    if (oldest && Date.now() - oldest < 60 * 60_000) flag('warn', `池龄 ${facts.ageMin} 分钟`)
    if (best.change24h !== null && best.change24h > 500) flag('warn', `24h 涨了 ${Math.round(best.change24h)}%`)
    if (best.buyers24h >= 20 && best.sellers24h <= 1) flag('warn', `24h ${best.buyers24h} 人买、${best.sellers24h} 人卖，还没人卖出过`)
    if (best.fdvUsd !== null && best.fdvUsd > 0 && best.liquidityUsd / best.fdvUsd < 0.01) flag('warn', `流动性只占 FDV 的 ${(best.liquidityUsd / best.fdvUsd * 100).toFixed(2)}%`)
  }
  // 合约
  const bytes = (code ?? '0x').slice(2)
  facts.codeSize = bytes.length / 2
  if (!bytes) flag('bad', '地址上没有合约代码')
  const impl = await pub.getStorageAt({ address: token, slot: IMPL_SLOT }).catch(() => null)
  const proxy = (impl && !/^0x0+$/.test(impl)) || bytes.includes('363d3d373d3d3d363d73')
  facts.proxy = proxy ? 1 : 0
  if (proxy) flag('warn', '可升级代理合约，逻辑随时能换')
  const selectors = new Set<string>()
  for (const mm of bytes.matchAll(/63([0-9a-f]{8})/g)) selectors.add(mm[1]) // PUSH4 后面的 4 字节，绝大多数是函数选择器
  const found = SUSPICIOUS.filter(([sel]) => selectors.has(sel)).map(([, name]) => name)
  facts.suspicious = found.join(', ') || null
  const owner = await pub.readContract({ address: token, abi: EXTRA_ABI, functionName: 'owner' }).catch(() => null)
  facts.owner = owner ?? null
  const renounced = !owner || /^0x0+$/.test(owner)
  if (found.length) flag(renounced ? 'warn' : 'bad', `合约带 ${found.join(' / ')}${renounced ? '（owner 已放弃）' : `，owner ${short(owner!)} 还在`}`)
  else if (!renounced) flag('warn', `owner ${short(owner!)} 还没放弃`)
  // 供应：多少在 v4 PoolManager 里（这条链所有 v4 池的币都在它名下）
  const pm = cfg.contracts[c.protocol]?.poolManager as Address | undefined
  try {
    const [supply, inPool] = await Promise.all([
      pub.readContract({ address: token, abi: EXTRA_ABI, functionName: 'totalSupply' }),
      pm ? pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [pm] }) : Promise.resolve(0n),
    ])
    facts.supply = formatUnits(supply, m.decimals)
    if (supply > 0n && pm) facts.inPoolPct = Number((inPool * 10_000n) / supply) / 100
  } catch {}
  // 能否转账：池 -> 任意地址（买了能不能拿到）、钱包 -> 池（能不能卖）。eth_call 可以任意指定 from，PoolManager 名下肯定有币
  if (pm) {
    const probe = '0x0000000000000000000000000000000000000001' as Address
    const t1 = await pub.simulateContract({ address: token, abi: EXTRA_ABI, functionName: 'transfer', args: [probe, 1n], account: pm }).then(() => '', (e) => String(e?.shortMessage ?? e?.message).slice(0, 80))
    facts.transferOut = t1 ? `失败: ${t1}` : '正常'
    if (t1) flag('bad', `代币从池子转出会失败（${t1}）`)
  }
  // 报价往返：用最大的 v4 计价币 / WETH 池，100 USDG（或等值 WETH）买进再卖出，损耗 = 费率 ×2 + 冲击 + hook 税
  const v4pool = live.find((p) => p.usable) ?? live.find((p) => p.dex.startsWith('uniswap-v4') && p.id.length === 66)
  if (v4pool) {
    const pool = await lp.poolById(v4pool.id).catch(() => null)
    const qIn = pool && [pool.currency0, pool.currency1].find((a) => same(a, cfg.quote.address)) ? cfg.quote.address : pool && [pool.currency0, pool.currency1].find((a) => same(a, cfg.wnative)) ? cfg.wnative : null
    if (pool && qIn) {
      const quoteIs0 = same(pool.currency0, qIn)
      const amountIn = same(qIn, cfg.quote.address) ? parseUnits('100', cfg.quote.decimals) : parseUnits((100 / Math.max(1, await nativePriceUsd(c).catch(() => 2500))).toFixed(8), 18)
      try {
        const got = await lp.quoteExactIn(pool, quoteIs0, amountIn)
        const back = await lp.quoteExactIn(pool, !quoteIs0, got)
        const loss = 1 - Number(back) / Number(amountIn)
        facts.roundTripLoss = `${(loss * 100).toFixed(1)}%`
        if (loss > 0.5) flag('bad', `100 美元买进再卖出亏 ${(loss * 100).toFixed(0)}%（税或深度极差）`)
        else if (loss > 0.2) flag('warn', `100 美元买进再卖出亏 ${(loss * 100).toFixed(0)}%`)
      } catch (e: any) { facts.roundTripLoss = '报价失败'; flag('warn', `池内报价失败（${String(e?.shortMessage ?? e?.message).slice(0, 60)}）`) }
    }
  }
  return { status: bad ? 'bad' : warn ? 'warn' : 'ok', reasons, facts, at: Date.now() }
}

// ---- Telegram 推送（可选：.env 里 TG_BOT_TOKEN + TG_CHAT_ID）----
export async function telegram(text: string) {
  const { botToken: token, chatId: chat } = tgConfig()
  if (!token || !chat) return
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(15_000) })
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.json().catch(() => ({}))).description ?? ''}`)
  } catch (e: any) { log(`Telegram 推送失败: ${String(e?.message).slice(0, 80)}`); throw e }
}
export const telegramConfigured = () => { const t = tgConfig(); return !!(t.botToken && t.chatId) }
export const fomoscanConfigured = () => !!fomoscanKey()
