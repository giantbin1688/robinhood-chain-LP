// 信号：盯 FOMO（fomo.family）交易者的买入 / 卖出，记一条信号并提醒，买入的币顺手做一遍代币安全检查，推到网页 / Telegram。
// 数据源：Robinhood 用 rhtrenches.com，BSC 用 bsctrenches.com；公开 API + WebSocket，按链独立监听。
//   它还标出「别人买了塞进钱包」（planted / transferred / spoofed / airdropped）——这种在链上和本人买入一模一样，只有付款方不同；标了的记成 dust，不提醒、不查安全。
//   fomo.family 自己没有公开 API（后端要登录态的 Privy token，且在 Cloudflare 机器人拦截后面），试过、放弃了。
//   自己盯链（按钱包地址扫 ERC-20 Transfer 日志）也做过：公共节点前面是 Cloudflare 动不动 429 / 人机验证，Alchemy 免费档 eth_getLogs 一次只给 10 块，
//   而且抓到的真实买卖 rhtrenches 全都有、多出来的只是空投碎币和资金进出，所以拆掉了（git 历史里有）。代价：只能盯它名单里的人，添加交易者时会校验。
// 链只用于安全检查（读合约 / 报价），走 makeClients 的 Alchemy 优先 fallback。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { formatUnits, getAddress, isAddress, parseAbi, parseUnits, type Address, type Hex } from 'viem'
import { CHAINS, type ChainName } from './chains.ts'
import { erc20Abi, log, makeClients, nativePriceUsd, sleep, tokenMeta, type Clients } from './common.ts'
import { listTokenPools } from './pools.ts'
import { tgConfig } from './settings.ts'
import * as rht from './rht.ts'

export type Trader = { handle: string; wallet: Address; chain: ChainName; on: boolean; muted: boolean; addedAt: number }
export type SignalKind = 'buy' | 'sell' | 'fund' | 'dust' | 'out' // fund / out 是早期盯链时期的类型，旧数据里可能还有
export type SignalSource = 'chain' | 'rht' | 'both'
export type Safety = { status: 'ok' | 'warn' | 'bad' | 'pending' | 'error'; reasons: string[]; facts: Record<string, string | number | null>; at: number }
export type Signal = {
  id: number; time: number; block: number; chain: ChainName; handle: string; wallet: Address; kind: SignalKind
  token: Address; symbol: string; decimals: number; amount: string; sizeUsd: number | null; price: number | null // price = 每枚多少美元（按这笔成交算）
  tx: Hex; text: string; safety: Safety | null
  source?: SignalSource; flags?: string[] // rhtrenches 的标记（planted = 别人塞的，few sellers、pool 3m old…）
}
type Store = { traders: Trader[]; signals: Signal[]; seq: number }

const FILE = new URL('../signals.json', import.meta.url)
const MAX_SIGNALS = 1000
const feeds = { robinhood: rht.createFeed('robinhood'), bsc: rht.createFeed('bsc') }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

const store: Store = existsSync(FILE) ? { traders: [], signals: [], seq: 0, ...JSON.parse(readFileSync(FILE, 'utf8')) } : { traders: [], signals: [], seq: 0 }
delete (store as any).cursor // 盯链时期的游标
let saveTimer: NodeJS.Timeout | null = null
const save = () => { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; writeFileSync(FILE, JSON.stringify(store, null, 1) + '\n') }, 500) } // 攒 0.5 秒再落盘，一笔交易几条信号不用写几次

// ---- 交易者名单 ----
export const traders = () => store.traders
export const signals = (chain?: ChainName) => (chain ? store.signals.filter((s) => s.chain === chain) : store.signals)
// 只能加对应链数据源名单里的人：信号全靠它推，名单外的钱包永远收不到。只填 handle 就从名单里取钱包；填了钱包也要在名单里
export async function addTrader(o: { handle: string; wallet?: string; chain: ChainName }): Promise<Trader> {
  const handle = o.handle.trim().replace(/^@/, '')
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(handle)) throw new Error('handle 只能是字母 / 数字 / _ . -')
  if (o.chain !== 'robinhood' && o.chain !== 'bsc') throw new Error('这条链暂无 FOMO 信号源')
  const chain = o.chain
  const feed = feeds[o.chain]
  if (!feed) throw new Error('信号支持 Robinhood Chain / BSC')
  const source = new URL(rht.SOURCES[o.chain]).hostname
  const list = await feed.traders().catch(() => null)
  if (!list) throw new Error(`${source} 名单拉不下来（它挂了或网络不通），稍后再试`)
  const given = o.wallet?.trim() ?? ''
  const hit = given ? list.find((t) => same(t.address, given)) : list.find((t) => t.handle.toLowerCase() === handle.toLowerCase())
  if (!hit) throw new Error(given ? `这个钱包不在 ${source} 的名单（${list.length} 人）里，收不到它的信号` : `@${handle} 不在 ${source} 的名单（${list.length} 人）里，收不到他的信号。名单：${source} 的 Traders 页`)
  if (!isAddress(hit.address)) throw new Error(`${source} 返回的钱包地址不合法`)
  const w = getAddress(hit.address)
  if (store.traders.some((t) => t.chain === o.chain && same(t.wallet, w))) throw new Error(`这个钱包已经在盯着了（@${store.traders.find((t) => same(t.wallet, w))!.handle}）`)
  const t: Trader = { handle: hit.handle || handle, wallet: w, chain: o.chain, on: true, muted: false, addedAt: Date.now() }
  store.traders.push(t); save()
  // 把数据源 最近的成交里这个人的补进来（静默，不提醒），不用等他下一笔
  feed.tape(400).then((rows) => { for (const f of rows) if (same(f.wallet, w)) ingestFill(chain, f, false) }).catch(() => {})
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

// signal 事件带 alert=true 表示该弹提醒（新的、确认过的买卖）；更新 / 补标记 / 回填的不弹
type Emit = (ev: { type: 'signal'; signal: Signal; alert?: boolean } | { type: 'rht'; chain: ChainName; status: rht.RhtStatus }) => void
let emit: Emit = () => {}
export const onEvent = (fn: Emit) => { emit = fn }

// 链只用于安全检查；没有 PRIVATE_KEY 也能查：from 随便给一个地址，只读
const clients = new Map<ChainName, Promise<Clients>>()
function clientOf(chain: ChainName) {
  if (!clients.has(chain)) { const p = makeClients({ needKey: false, from: '0x0000000000000000000000000000000000000001', chain }); p.catch(() => clients.delete(chain)); clients.set(chain, p) }
  return clients.get(chain)!
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
  const c = await clientOf(sig.chain)
  const r = await checkToken(c, sig.token).catch((e): Safety => ({ status: 'error', reasons: [`检查失败: ${String(e?.shortMessage ?? e?.message).slice(0, 120)}`], facts: {}, at: Date.now() }))
  if (sig.kind !== 'buy') return // 检查期间被改判成塞币了
  sig.safety = r; save()
  emit({ type: 'signal', signal: sig })
  if (notify && r.status !== 'ok' && r.status !== 'error') {
    const t = store.traders.find((x) => x.chain === sig.chain && same(x.wallet, sig.wallet))
    if (t && !t.muted) telegram(`${r.status === 'bad' ? '⛔ 风险' : '⚠️ 注意'} ${sig.symbol}: ${r.reasons.join('；')}`).catch(() => {})
  }
}

// ---- 对应链数据源的成交 -> 信号（只收我们盯着的、开着的钱包）。同一笔（tx + 代币 + 钱包）再推一次就更新标记 ----
const isPlantedFlag = (f: string) => /planted|transferred|spoofed|airdropped/i.test(f)
const usdText = (v: number | null) => (v === null || v === undefined ? '' : ` $${v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2)}`)
const fmtAmt = (v: number) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v >= 1 ? v.toFixed(2) : v.toPrecision(3))
function ingestFill(chain: rht.FeedChain, f: rht.Fill, live: boolean) {
  const t = store.traders.find((x) => x.chain === chain && same(x.wallet, f.wallet))
  if (!t || !t.on || !isAddress(f.token) || !isAddress(f.wallet)) return
  const planted = f.flags.filter(isPlantedFlag)
  const kind: SignalKind = planted.length ? 'dust' : f.side
  const amt = fmtAmt(f.amount)
  const note = f.flags.length ? `［${new URL(rht.SOURCES[chain]).hostname}: ${f.flags.join('；')}］` : ''
  const text = planted.length
    ? `${t.handle} 钱包${f.side === 'buy' ? '收到' : '转出'} ${f.symbol}${usdText(f.usd)}（${amt} 枚）——不是本人${f.side === 'buy' ? '买入' : '卖出'}：${planted.join('；')}（别人买了塞进来 / 转进来的）`
    : `${t.handle} ${f.side === 'buy' ? '买入' : '卖出'} ${f.symbol}${usdText(f.usd)}（${amt} 枚）${note}`
  const existing = store.signals.find((s) => s.chain === chain && same(s.tx, f.tx) && same(s.token, f.token) && same(s.wallet, f.wallet))
  if (existing) {
    existing.flags = f.flags
    if (existing.kind !== kind) {
      existing.kind = kind; existing.text = text
      if (kind === 'dust') existing.safety = null
      else if (kind === 'buy' && !existing.safety) { existing.safety = { status: 'pending', reasons: [], facts: {}, at: Date.now() }; void runSafety(existing, live) }
      if (live && (kind === 'buy' || kind === 'sell')) alertSignal(existing)
    }
    else if (f.flags.length && !existing.text.includes(new URL(rht.SOURCES[chain]).hostname)) existing.text = text
    if (f.usd) { existing.sizeUsd = f.usd; existing.price = f.price }
    save(); emit({ type: 'signal', signal: existing })
    return
  }
  const sig: Signal = { id: ++store.seq, time: f.ts * 1000, block: f.block, chain, handle: t.handle, wallet: t.wallet, kind, token: getAddress(f.token), symbol: f.symbol, decimals: 0, amount: String(f.amount), sizeUsd: f.usd, price: f.price, tx: f.tx, text, safety: kind === 'buy' ? { status: 'pending', reasons: [], facts: {}, at: Date.now() } : null, source: 'rht', flags: f.flags }
  store.signals.push(sig)
  if (store.signals.length > MAX_SIGNALS) store.signals.splice(0, store.signals.length - MAX_SIGNALS)
  save()
  if (live) log(`信号: ${text}`)
  emit({ type: 'signal', signal: sig })
  if (kind === 'buy') void runSafety(sig, live)
  if (live && (kind === 'buy' || kind === 'sell')) alertSignal(sig)
}
export const rhtStatus = (chain: ChainName = 'robinhood') => chain === 'ethereum' ? null : feeds[chain].rhtStatus()

// 网页上手动点「重新检查」：绕过缓存
export async function recheckToken(chain: ChainName, token: Address) {
  safetyCache.delete(`${chain}:${token.toLowerCase()}`)
  const r = await checkToken(await clientOf(chain), token)
  for (const s of store.signals) if (s.chain === chain && same(s.token, token) && s.kind === 'buy') { s.safety = r; emit({ type: 'signal', signal: s }) }
  save()
  return r
}
export function start() {
  for (const chain of Object.keys(feeds) as rht.FeedChain[]) void feeds[chain].start({ onFill: (f, live) => ingestFill(chain, f, live), onStatus: (status) => emit({ type: 'rht', chain, status }) })
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
