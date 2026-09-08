// 网页界面的本地服务（npm run ui）：表单参数拼成命令行，以子进程跑 cli.ts / exit.ts / monitor.ts，日志用 SSE 实时推到浏览器。
// 只监听 127.0.0.1；私钥仍只在 .env 里、由子进程读取，浏览器看不到。交易逻辑全在原来的命令里，这里不碰链上写操作。
// 多链：每个 链/协议 组合一个上下文（客户端、仓位缓存、流水缓存），页面顶部切换，请求带 chain / protocol 参数
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatEther, isAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as v4 from '../v4.ts'
import { CHAINS, PROTOCOL_LABEL, type ChainName, type ProtocolName } from '../chains.ts'
import { env, erc20Abi, feeText, log, makeClients, nativePriceUsd, p6, tokenMeta, trim, type Clients } from '../common.ts'
import { findPositions, positionFees, same, type Position } from '../exit.ts'
import { closedPositions, positionLedger, refreshLedger, type LedgerEvent } from '../history.ts'
import type { Pool } from '../lp.ts'
import { listTokenPools } from '../pools.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = Number(env('UI_PORT', '3000'))
const hasKey = !!process.env.PRIVATE_KEY

// ---- 脱敏：子进程的 stdout/stderr 原样推到网页并存进 job.lines，未捕获的错误会把完整堆栈打进去。
// viem 的错误信息里带 RPC 地址（errors/request.js），它只清洗 basic-auth 的用户名密码、不动 path，
// 而 Alchemy 的 key 就在 path 里（/v2/<key>）——一次 RPC 失败就会把 key 印在页面上。所有出口统一过一遍这里。
// 只按 .env 里的原值精确替换：不能用「0x+64 位十六进制」这类通配规则，那会把交易哈希一起抹掉。
// RPC 变量名从 chains.ts 推导（RPC_URL / BSC_RPC_URL / …），以后加链不用再回来补这份名单。
const SECRET_ENVS: [string, string][] = [
  ...Object.values(CHAINS).map((c) => [c.rpcEnv, '<RPC>'] as [string, string]),
  ['PRIVATE_KEY', '<私钥>'], ['UNISWAP_API_KEY', '<key>'], ['OKX_API_KEY', '<key>'], ['OKX_SECRET_KEY', '<key>'], ['OKX_API_PASSPHRASE', '<key>'],
  // 代理只在带账号密码时才算秘密，否则 127.0.0.1:7897 这种被抹掉反而看不懂日志
  ...['HTTPS_PROXY', 'HTTP_PROXY'].filter((k) => (process.env[k] ?? '').includes('@')).map((k) => [k, '<代理>'] as [string, string]),
]
const SECRETS = SECRET_ENVS.map(([k, tag]) => [process.env[k] ?? '', tag] as const).filter(([v]) => v.length >= 8)
export const redact = (s: string) => {
  for (const [v, tag] of SECRETS) if (s.includes(v)) s = s.split(v).join(tag)
  return s.replace(/(alchemy\.com\/v2\/)[A-Za-z0-9_-]{8,}/gi, '$1<key>') // 没配 RPC_URL 时的兜底
}

const wallet = hasKey ? privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`).address : null

// ---- 任务：每个子进程一个任务，可同时跑多个（多个仓位各自监控、同时进场/撤退）。
// 唯一限制：同一条链上真发交易的进场/撤退同一时刻只能有一个在"发交易"阶段——两个进程各自缓存 nonce 会互相撞；
// 进场带 --watch 的任务在组完 LP 后进入监控阶段，不再占这个名额。监控触发的撤退在监控进程内发交易，这里管不到（和命令行多开监控一样）。
type Job = {
  id: number; kind: 'launch' | 'exit' | 'watch'; label: string; dryRun: boolean; phase: 'run' | 'watch'; chain: ChainName; protocol: ProtocolName; token?: string; positions: string[]
  startedAt: number; endedAt?: number; exitCode?: number | null; lines: string[]; partial: string; plan?: unknown; proc?: ChildProcess
}
const jobs = new Map<number, Job>()
let seq = 0
const streams = new Set<ServerResponse>()
const emit = (ev: object) => { const s = `data: ${JSON.stringify(ev)}\n\n`; for (const r of streams) r.write(s) }
const summary = (j: Job) => ({ id: j.id, kind: j.kind, label: j.label, dryRun: j.dryRun, phase: j.phase, chain: j.chain, protocol: j.protocol, token: j.token, positions: j.positions, startedAt: j.startedAt, endedAt: j.endedAt, exitCode: j.exitCode, running: j.exitCode === undefined })
const isRunning = (j: Job) => j.exitCode === undefined
const sendingTx = (chain: ChainName) => [...jobs.values()].find((j) => isRunning(j) && j.chain === chain && !j.dryRun && j.kind !== 'watch' && j.phase === 'run')

function startJob(sel: Sel, kind: Job['kind'], label: string, script: string, args: string[], meta: { dryRun: boolean; token?: string; positions?: string[] }) {
  if (!meta.dryRun && kind !== 'watch') { const busy = sendingTx(sel.chain); if (busy) throw new Error(`「${busy.label}」正在发交易，等它完成再开始（避免两个进程的 nonce 互相冲突）`) }
  const job: Job = { id: ++seq, kind, label: `[${sel.chain === 'bsc' ? 'BSC' : 'RHC'}] ${label}`, dryRun: meta.dryRun, phase: 'run', chain: sel.chain, protocol: sel.protocol, token: meta.token, positions: meta.positions ?? [], startedAt: Date.now(), lines: [], partial: '' }
  jobs.set(job.id, job)
  // 只留最近 50 个已结束的任务
  const done = [...jobs.values()].filter((j) => !isRunning(j)).sort((a, b) => a.id - b.id)
  for (const j of done.slice(0, Math.max(0, done.length - 50))) jobs.delete(j.id)
  const full = [`--chain=${sel.chain}`, `--protocol=${sel.protocol}`, ...args, '--json']
  const proc = spawn(process.execPath, ['--env-file=.env', '--env-file=params.env', '--import', 'tsx', script, ...full], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  job.proc = proc
  log(`任务 #${job.id} ${job.label}: ${script} ${full.join(' ')}`)
  const line = (raw: string) => {
    const text = redact(raw)
    if (text.startsWith('@@plan ')) { try { job.plan = JSON.parse(text.slice(7)); emit({ type: 'plan', job: job.id, plan: job.plan }) } catch {} ; return }
    if (text.startsWith('@@positions ')) { // 进场组完 LP：记下仓位；带 --watch 的接下来进入监控阶段
      try { job.positions = JSON.parse(text.slice(12)) } catch {}
      if (args.includes('--watch')) job.phase = 'watch'
      emit({ type: 'status', job: summary(job) }); return
    }
    job.lines.push(text)
    if (job.lines.length > 3000) job.lines.shift()
    emit({ type: 'log', job: job.id, text })
  }
  // 发交易时会先写半行 "标签 hash ..."，等收据再补 " 成功…"：半行也推给页面（partial），补完再作为整行发出
  const feed = (chunk: string) => {
    job.partial += chunk
    const parts = job.partial.split(/\r?\n/)
    job.partial = parts.pop()!
    for (const p of parts) line(p)
    if (job.partial) emit({ type: 'partial', job: job.id, text: redact(job.partial) }) // 累加器保持原样，只脱敏推出去的那份
  }
  // setEncoding 让 Node 按 UTF-8 流解码：一个中文字正好跨在两个 chunk 边界时不会变成 �（按 chunk 各自 toString 会）
  proc.stdout!.setEncoding('utf8').on('data', feed)
  proc.stderr!.setEncoding('utf8').on('data', feed)
  proc.on('close', (code) => {
    if (job.partial) { line(job.partial); job.partial = '' }
    job.exitCode = code; job.endedAt = Date.now()
    log(`任务 #${job.id} 结束，退出码 ${code}`)
    emit({ type: 'status', job: summary(job) })
  })
  proc.on('error', (e) => line(`错误: 无法启动子进程: ${e.message}`))
  emit({ type: 'status', job: summary(job) })
  return job
}

// ---- 链 / 协议上下文 ----
type Sel = { chain: ChainName; protocol: ProtocolName }
function selOf(q: { get(k: string): string | null } | Record<string, unknown>): Sel {
  const g = (k: string) => String('get' in q && typeof q.get === 'function' ? q.get(k) ?? '' : (q as Record<string, unknown>)[k] ?? '').trim().toLowerCase()
  const chain = (g('chain') || 'robinhood') as ChainName
  if (!CHAINS[chain]) throw new Error(`不支持的链 ${chain}`)
  const protocol = (g('protocol') || CHAINS[chain].protocols[0]) as ProtocolName
  if (!CHAINS[chain].protocols.includes(protocol)) throw new Error(`${CHAINS[chain].label} 上没有 ${protocol}`)
  return { chain, protocol }
}
type Ctx = {
  sel: Sel; c: Clients
  meta: Map<string, { symbol: string; decimals: number }>; known: Position[]
  ledgerAt: number; ledgerOk: boolean; ledgerError: string
  depthCache: Map<string, { at: number; data: unknown }>; closedCache: Map<bigint, ClosedRow>; blockTime: Map<bigint, Promise<number>>
}
const ctxs = new Map<string, Promise<Ctx>>()
function ctxOf(sel: Sel): Promise<Ctx> {
  if (!hasKey) throw new Error('.env 里没有 PRIVATE_KEY')
  const k = `${sel.chain}:${sel.protocol}`
  if (!ctxs.has(k)) ctxs.set(k, makeClients({ needKey: false, chain: sel.chain, protocol: sel.protocol }).then((c) => ({ sel, c, meta: new Map(), known: [], ledgerAt: 0, ledgerOk: false, ledgerError: '', depthCache: new Map(), closedCache: new Map(), blockTime: new Map() })))
  return ctxs.get(k)!
}

// ---- 仓位列表：全量 = positions.json + 链上扫描（慢，几秒）；刷新 = 只重读已知仓位的流动性和池价 ----
const tokenOf = (x: Ctx, p: Pick<Position, 'pool'>) => ({ tokenIs1: same(p.pool.currency0, x.c.Q.address), token: (same(p.pool.currency0, x.c.Q.address) ? p.pool.currency1 : p.pool.currency0) as Address })
async function metaOf(x: Ctx, token: Address) { let m = x.meta.get(token.toLowerCase()); if (!m) { m = await tokenMeta(x.c.pub, token); x.meta.set(token.toLowerCase(), m) }; return m }
// 池子原始价格 -> 每个代币多少计价币
const priceFn = (x: Ctx, tokenIs1: boolean, decimals: number) => { const qd = x.c.Q.decimals; const [dec0, dec1] = tokenIs1 ? [qd, decimals] : [decimals, qd]; return (t: number) => { const h = v4.priceAtTick(t) * 10 ** (dec0 - dec1); return tokenIs1 ? 1 / h : h } }
const uncollectedFees = (x: Ctx, p: Position): Promise<[bigint, bigint]> => positionFees(x.c, p).catch((e) => { log(`仓位 ${p.id} 手续费读取失败: ${String(e?.message).slice(0, 120)}`); return [0n, 0n] })

// ---- 资金流水（history.ts）：每个仓位的 存入 / 已领手续费 / 已撤本金，每笔按当时池价折算 ----
// 盈亏 = 现值 + 未领手续费 + 已领手续费 + 已撤本金 − 存入。流水从当前仓位里最早的 mint 区块起扫，全量刷新或距上次超过 1 分钟才重新拉
async function refresh(x: Ctx, since: bigint) {
  try { await refreshLedger(x.c, since); x.ledgerOk = true; x.ledgerAt = Date.now(); x.ledgerError = '' }
  catch (e: any) { x.ledgerOk = false; x.ledgerError = `资金流水读取失败（需要 Alchemy 节点）: ${String(e?.shortMessage ?? e?.message).slice(0, 120)}`; throw new Error(x.ledgerError) }
}
async function ensureLedger(x: Ctx, full: boolean) {
  if (!x.c.rpcIsAlchemy) { x.ledgerError = `资金流水需要 Alchemy 节点（.env 里的 ${x.c.cfg.rpcEnv}）`; return }
  const minted = x.known.filter((p) => p.mint)
  const since = minted.length ? minted.reduce((m, p) => (p.mint!.block < m ? p.mint!.block : m), minted[0].mint!.block) : 0n
  if (!x.known.length || (!full && x.ledgerOk && Date.now() - x.ledgerAt < 60_000)) return
  await refresh(x, since).catch((e) => log(e.message))
}
const usdAt = (qd: number, tokenIs1: boolean, decimals: number, priceAt: (t: number) => number) => (a0: bigint, a1: bigint, tick: number) => { const [u, t] = tokenIs1 ? [a0, a1] : [a1, a0]; return Number(u) / 10 ** qd + (Number(t) / 10 ** decimals) * priceAt(tick) }
function sumLedger(events: LedgerEvent[], usd: ReturnType<typeof usdAt>) {
  let deposits = 0, fees = 0, withdrawn = 0, mintedAt = 0
  for (const e of events) {
    const total = usd(e.amount0, e.amount1, e.tick), principal = usd(e.principal0, e.principal1, e.tick)
    if (e.action === 'add') { deposits += total; if (!mintedAt) mintedAt = e.time }
    else { withdrawn += principal; fees += total - principal }
  }
  return { mintedAt, deposits, fees, withdrawn }
}
async function ledgerSummary(x: Ctx, p: Position, decimals: number, priceAt: (t: number) => number) {
  if (!x.ledgerOk) return null
  const events = await positionLedger(x.c, p)
  return events.length ? sumLedger(events, usdAt(x.c.Q.decimals, tokenOf(x, p).tokenIs1, decimals, priceAt)) : null
}
// 流水不可用（没有 Alchemy 节点）时持仓时间退回用 mint 区块的时间
const mintedAtOf = (x: Ctx, p: Position) => { if (!p.mint) return null; if (!x.blockTime.has(p.mint.block)) x.blockTime.set(p.mint.block, x.c.pub.getBlock({ blockNumber: p.mint.block }).then((b) => Number(b.timestamp) * 1000)); return x.blockTime.get(p.mint.block)! }
async function listPositions(x: Ctx, full: boolean) {
  const { c } = x, { lp } = c
  if (full || x.known.length === 0) x.known = await findPositions(c)
  else {
    const slots = new Map<Hex, Promise<{ sqrtP: bigint; tick: number }>>()
    for (const p of x.known) if (!slots.has(p.pool.id)) slots.set(p.pool.id, lp.slot0(p.pool))
    const fresh = await lp.positions(x.known.map((p) => p.id))
    const liq = new Map(fresh.map((p) => [p.id, p.liquidity]))
    x.known = (await Promise.all(x.known.map(async (p) => {
      const liquidity = liq.get(p.id) ?? 0n
      const { sqrtP, tick } = await slots.get(p.pool.id)!
      const [amount0, amount1] = v4.amountsForLiquidity(sqrtP, v4.getSqrtRatioAtTick(p.tickLower), v4.getSqrtRatioAtTick(p.tickUpper), liquidity)
      return { ...p, liquidity, tick, amount0, amount1 }
    }))).filter((p) => p.liquidity > 0n)
  }
  await ensureLedger(x, full)
  return Promise.all(x.known.map(async (p) => {
    const { tokenIs1, token } = tokenOf(x, p)
    const [m, [f0, f1]] = await Promise.all([metaOf(x, token), uncollectedFees(x, p)])
    const priceAt = priceFn(x, tokenIs1, m.decimals)
    const s = await ledgerSummary(x, p, m.decimals, priceAt).catch((e) => { log(`仓位 ${p.id} 流水读取失败: ${String(e?.message).slice(0, 120)}`); return null })
    const mintedAt = s?.mintedAt || (await mintedAtOf(x, p)?.catch(() => null)) || null
    const [u, t] = tokenIs1 ? [p.amount0, p.amount1] : [p.amount1, p.amount0]
    const [fu, ft] = tokenIs1 ? [f0, f1] : [f1, f0]
    const [lo, hi] = [priceAt(p.tickLower), priceAt(p.tickUpper)].sort((a, b) => a - b)
    const price = priceAt(p.tick)
    const usd = (usdg: bigint, tok: bigint) => (Number(usdg) / 10 ** c.Q.decimals + (Number(tok) / 10 ** m.decimals) * price).toFixed(2)
    const id = p.id.toString()
    // 正在盯着这个仓位的任务：按仓位监控的看 positions；按代币整体监控的（positions 为空）看 token
    const watcher = [...jobs.values()].find((j) => isRunning(j) && j.chain === x.sel.chain && j.protocol === x.sel.protocol && (j.kind === 'watch' || j.phase === 'watch') && (j.positions.length ? j.positions.includes(id) : same(j.token ?? '', token)))
    return {
      id, token, symbol: m.symbol, decimals: m.decimals, fee: p.pool.fee / 10000, feeText: feeText(p.pool), spacing: p.pool.spacing, hooks: p.pool.hooks !== v4.ZERO_ADDRESS ? p.pool.hooks : null, kind: p.kind, shape: p.shape, group: p.group, poolId: p.pool.id,
      tickLower: p.tickLower, tickUpper: p.tickUpper, tick: p.tick, lo: p6(lo), hi: p6(hi), price: p6(price), inRange: p.tick >= p.tickLower && p.tick < p.tickUpper,
      usdg: trim(u, c.Q.decimals), tokenAmount: trim(t, m.decimals), value: usd(u, t), liquidity: p.liquidity.toString(), watchJob: watcher?.id ?? null,
      feesUsdg: trim(fu, c.Q.decimals), feesToken: trim(ft, m.decimals), feesUsd: usd(fu, ft),
      // 持仓时间与盈亏：现值 + 未领手续费 + 已领手续费 + 已撤本金 − 存入（都按各自当时的池价折算；不含进场换币的手续费/滑点）
      mintedAt, entryUsd: s ? s.deposits.toFixed(2) : null, collectedUsd: s ? s.fees.toFixed(2) : null, withdrawnUsd: s ? s.withdrawn.toFixed(2) : null,
      pnlUsd: s ? (Number(usd(u, t)) + Number(usd(fu, ft)) + s.fees + s.withdrawn - s.deposits).toFixed(2) : null,
    }
  }))
}

// ---- 池子深度：仓位所在池、仓位区间向两侧各扩 30% 的范围内，每个 tick 段的流动性折成计价币 / 代币数量 ----
// 做法：适配器给出范围内所有已初始化的 tick 及其 liquidityNet，从当前 tick 的活跃流动性出发向两侧累加得到每段的流动性
async function depth(x: Ctx, idStr: string) {
  const { c } = x, { pub, lp } = c
  const id = BigInt(idStr)
  const p = x.known.find((q) => q.id === id) ?? (await findPositions(c, undefined, [id]))[0]
  if (!p) throw new Error('仓位不存在')
  const spacing = p.pool.spacing
  const { tokenIs1, token } = tokenOf(x, p)
  const m = await metaOf(x, token)
  const priceAt = priceFn(x, tokenIs1, m.decimals)
  const [{ sqrtP, tick }, L] = await Promise.all([lp.slot0(p.pool), lp.liquidity(p.pool)])
  const width = p.tickUpper - p.tickLower
  let lo = p.tickLower - Math.round(width * 0.3), hi = p.tickUpper + Math.round(width * 0.3)
  if (tick < lo) lo = tick - Math.round(width * 0.1)
  if (tick >= hi) hi = tick + Math.round(width * 0.1)
  lo = Math.max(v4.MIN_TICK, v4.floorToSpacing(lo, spacing)); hi = Math.min(v4.MAX_TICK, v4.ceilToSpacing(hi, spacing))
  const cacheKey = `${p.pool.id}:${lo}:${hi}`
  const hit = x.depthCache.get(cacheKey)
  if (hit && Date.now() - hit.at < 8000) return hit.data
  const { inits, net } = await lp.ticks(p.pool, lo, hi)
  void pub
  // 段边界 B，段 j = [B[j], B[j+1])；先定位当前 tick 所在段 = 池子当前活跃流动性，向上每跨一个 tick 加 net，向下每跨一个减 net
  const B = [lo, ...inits, hi]
  const liq: bigint[] = new Array(B.length - 1).fill(0n)
  const cur = B.findIndex((b, k) => k < B.length - 1 && b <= tick && tick < B[k + 1])
  liq[cur] = L
  for (let j = cur + 1; j < liq.length; j++) liq[j] = liq[j - 1] + net.get(B[j])!
  for (let j = cur - 1; j >= 0; j--) liq[j] = liq[j + 1] - net.get(B[j + 1])!
  // 按约 110 根柱子分桶（桶宽是 spacing 的倍数），每根柱子把落在里面的各段按当前价折算成两种币的数量
  const barT = spacing * Math.max(1, Math.ceil((hi - lo) / spacing / 110))
  const bars = []
  for (let a = Math.floor(lo / barT) * barT; a < hi; a += barT) {
    const b = a + barT
    let amt0 = 0n, amt1 = 0n
    for (let j = 0; j < liq.length; j++) {
      const xx = Math.max(a, B[j], v4.MIN_TICK), y = Math.min(b, B[j + 1], v4.MAX_TICK)
      if (y <= xx || liq[j] <= 0n) continue
      const [d0, d1] = v4.amountsForLiquidity(sqrtP, v4.getSqrtRatioAtTick(xx), v4.getSqrtRatioAtTick(y), liq[j])
      amt0 += d0; amt1 += d1
    }
    const [u, t] = tokenIs1 ? [amt0, amt1] : [amt1, amt0]
    const usdg = Number(u) / 10 ** c.Q.decimals, tok = Number(t) / 10 ** m.decimals, price = priceAt(tick)
    const [pLo, pHi] = [priceAt(Math.max(a, v4.MIN_TICK)), priceAt(Math.min(b, v4.MAX_TICK))].sort((q, r) => q - r)
    const mid = (a + b) / 2
    bars.push({ pLo, pHi, usdg, token: tok, usdgUsd: usdg, tokenUsd: tok * price, usd: usdg + tok * price, inPos: mid >= p.tickLower && mid < p.tickUpper })
  }
  bars.sort((q, r) => q.pLo - r.pLo)
  const [posLo, posHi] = [priceAt(p.tickLower), priceAt(p.tickUpper)].sort((q, r) => q - r)
  const data = { id: idStr, symbol: m.symbol, price: priceAt(tick), posLo, posHi, poolLiquidity: L.toString(), initializedTicks: inits.length, bars }
  x.depthCache.set(cacheKey, { at: Date.now(), data })
  return data
}

// ---- 某个仓位的资金明细：每笔交易的动作、两种币数量、按当时池价折算的价值 ----
async function history(x: Ctx, idStr: string) {
  const { c } = x
  const p = x.known.find((q) => q.id.toString() === idStr)
  if (!p) throw new Error('仓位不在列表里，先刷新')
  if (!x.ledgerOk) throw new Error(x.ledgerError || `资金流水需要 Alchemy 节点（${c.cfg.rpcEnv}）`)
  const { tokenIs1, token } = tokenOf(x, p)
  const [m, [f0, f1], events] = await Promise.all([metaOf(x, token), uncollectedFees(x, p), positionLedger(c, p)])
  const priceAt = priceFn(x, tokenIs1, m.decimals)
  const usd = usdAt(c.Q.decimals, tokenIs1, m.decimals, priceAt)
  const split = (a0: bigint, a1: bigint) => (tokenIs1 ? { usdg: a0, token: a1 } : { usdg: a1, token: a0 })
  const rows = events.map((e) => {
    const { usdg, token: tok } = split(e.amount0, e.amount1)
    const total = usd(e.amount0, e.amount1, e.tick), principal = usd(e.principal0, e.principal1, e.tick)
    return { tx: e.tx, time: e.time, action: e.action, usdg: trim(usdg, c.Q.decimals), token: trim(tok, m.decimals), usdgUsd: (Number(usdg) / 10 ** c.Q.decimals).toFixed(2), tokenUsd: (total - Number(usdg) / 10 ** c.Q.decimals).toFixed(2), usd: total.toFixed(2), feeUsd: e.action === 'add' ? null : (total - principal).toFixed(2), price: p6(priceAt(e.tick)) }
  }).reverse()
  const deposits = rows.filter((r) => r.action === 'add').reduce((s, r) => s + Number(r.usd), 0)
  const fees = rows.reduce((s, r) => s + Number(r.feeUsd ?? 0), 0)
  const withdrawn = rows.filter((r) => r.action === 'remove').reduce((s, r) => s + Number(r.usd) - Number(r.feeUsd), 0)
  const value = usd(p.amount0, p.amount1, p.tick), unclaimed = usd(f0, f1, p.tick)
  return { id: idStr, symbol: m.symbol, events: rows, deposits: deposits.toFixed(2), fees: fees.toFixed(2), withdrawn: withdrawn.toFixed(2), value: value.toFixed(2), unclaimed: unclaimed.toFixed(2), pnl: (value + unclaimed + fees + withdrawn - deposits).toFixed(2) }
}

// ---- 盈亏日历：已平仓仓位各自整段的盈亏 = 拿回本金 + 手续费 − 存入（每笔按当时池价折算），按平仓日归类由网页做 ----
// 第一次要从创世块起拉钱包全部 LP 交易的回执、逐笔读当时池价，几十秒；平仓后的数字不会再变，算过一次就缓存
type ClosedRow = { id: string; token: Address; symbol: string; fee: number; feeText: string; openedAt: number; closedAt: number; closedTx: Hex; deposits: number; withdrawn: number; fees: number; pnl: number }
async function closedList(x: Ctx) {
  const { c } = x, { lp } = c
  if (!c.rpcIsAlchemy) throw new Error(`资金流水需要 Alchemy 节点（${c.cfg.rpcEnv}）`)
  await refresh(x, 0n)
  const list = closedPositions(c).filter((q) => !x.closedCache.has(q.id))
  const poolIds = [...new Set(list.map((q) => q.poolId))]
  const keyOf = new Map<Hex, Pool | null>()
  for (const pid of poolIds) keyOf.set(pid, await lp.poolById(pid).catch(() => null))
  const cents = (v: number) => Math.round(v * 100) / 100
  let nonUsdg = 0, failed = 0
  for (const q of list) { // 逐个算：每笔都要按当时的区块读池价（归档调用），并发会撞 Alchemy 的每秒额度
    const pool = keyOf.get(q.poolId)
    if (!pool || ![pool.currency0, pool.currency1].some((a) => same(a, c.Q.address))) { nonUsdg++; continue }
    try {
      const p = { id: q.id, pool, tickLower: q.tickLower, tickUpper: q.tickUpper }
      const { tokenIs1, token } = tokenOf(x, p)
      const m = await metaOf(x, token)
      const s = sumLedger(await positionLedger(c, p), usdAt(c.Q.decimals, tokenIs1, m.decimals, priceFn(x, tokenIs1, m.decimals)))
      x.closedCache.set(q.id, { id: q.id.toString(), token, symbol: m.symbol, fee: pool.fee / 10000, feeText: feeText(pool), openedAt: s.mintedAt, closedAt: q.closed.time, closedTx: q.closed.tx, deposits: cents(s.deposits), withdrawn: cents(s.withdrawn), fees: cents(s.fees), pnl: cents(s.withdrawn + s.fees - s.deposits) })
    } catch (e: any) { failed++; log(`仓位 ${q.id} 平仓盈亏读取失败: ${String(e?.shortMessage ?? e?.message).slice(0, 120)}`) }
  }
  return { closed: [...x.closedCache.values()].sort((a, b) => a.closedAt - b.closedAt), nonUsdg, failed }
}

// ---- 该代币的全部池子（GeckoTerminal 列表，可复用的计价币池再读链上池价）----
async function poolsFor(x: Ctx, token: Address) {
  const { c } = x, { lp } = c
  const [pools, m] = await Promise.all([listTokenPools(c, token), metaOf(x, token)])
  const rows = await Promise.all(pools.map(async (q) => {
    let price: string | null = null
    if (q.usable) {
      const pool = await lp.poolById(q.id).catch(() => null)
      if (pool) { const { sqrtP, tick } = await lp.slot0(pool); if (sqrtP !== 0n) price = p6(priceFn(x, same(pool.currency1, token), m.decimals)(tick)) }
    }
    return { id: q.id, name: q.name, dex: q.dex, fee: q.fee / 10000, feeText: q.feeText, spacing: q.spacing, hooks: q.hooks, usable: q.usable, empty: q.empty, status: q.status, liquidityUsd: Math.round(q.liquidityUsd), volume24h: Math.round(q.volume24h), price }
  }))
  return { symbol: m.symbol, pools: rows }
}

async function state(sel: Sel) {
  const params = Object.fromEntries(['USDG_AMOUNT', 'POOL_FEE', 'POOL_SELECT', 'TICK_SPACING', 'PRICE_RANGE', 'RANGE', 'LP_SHAPE', 'LP_LAYERS', 'SWAP_SLIPPAGE', 'LP_SLIPPAGE', 'MAX_DEVIATION', 'SWAP_VIA', 'EXIT_SWAP_VIA', 'WATCH_INTERVAL', 'WATCH_CONFIRM', 'WATCH_UPPER_GRACE'].map((k) => [k, process.env[k] ?? '']))
  const cfg = CHAINS[sel.chain]
  const chains = Object.values(CHAINS).map((ch) => ({ name: ch.name, label: ch.label, quote: ch.quote.symbol, native: ch.native.symbol, protocols: ch.protocols.map((p) => ({ name: p, label: PROTOCOL_LABEL[p] })), rpc: !!process.env[ch.rpcEnv], rpcEnv: ch.rpcEnv }))
  const base = { wallet, params, chains, chain: sel.chain, protocol: sel.protocol, protocolLabel: PROTOCOL_LABEL[sel.protocol], quote: cfg.quote.symbol, native: cfg.native.symbol, okx: !!process.env.OKX_API_KEY, uniswapKey: !!process.env.UNISWAP_API_KEY, explorer: cfg.explorer, jobs: [...jobs.values()].map(summary) }
  if (!hasKey) return { ...base, usdg: null, eth: null, ethPrice: null, alchemy: false }
  const x = await ctxOf(sel)
  const { pub, Q } = x.c
  const [usdg, eth, ethPrice] = await Promise.all([
    pub.readContract({ address: Q.address, abi: erc20Abi, functionName: 'balanceOf', args: [wallet!] }), pub.getBalance({ address: wallet! }), nativePriceUsd(x.c),
  ])
  return { ...base, usdg: trim(usdg, Q.decimals), eth: trim(eth, 18), ethUsd: (Number(formatEther(eth)) * ethPrice).toFixed(2), ethPrice: ethPrice.toFixed(2), alchemy: x.c.rpcIsAlchemy, tiers: x.c.lp.tiers.map((t) => t.fee / 10000) }
}

// ---- 表单 -> 命令行参数。数值原样透传，合法性由命令本身检查（出错会打印"错误: …"并退出）；一律 --key=value，负数才不会被当成另一个选项 ----
const str = (x: unknown) => String(x ?? '').trim()
const ids = (x: unknown) => str(x).split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s))
const via = (x: unknown) => (['okx', 'uniswap', 'best'].includes(str(x)) ? str(x) : 'best')
function launchArgs(b: any) {
  const token = str(b.token)
  if (!isAddress(token)) throw new Error('代币地址不合法')
  const args = [`--token=${token}`, `--usdg=${str(b.usdg)}`, `--fee=${str(b.fee)}`, `--slippage=${str(b.slippage)}`, `--lp-slippage=${str(b.lpSlippage)}`, `--max-deviation=${str(b.maxDeviation)}`, `--pool-select=${str(b.poolSelect)}`]
  if (str(b.spacing)) args.push(`--spacing=${str(b.spacing)}`)
  if (/^0x[0-9a-fA-F]{64}$|^0x[0-9a-fA-F]{40}$/.test(str(b.pool))) args.push(`--pool=${str(b.pool)}`) // 池子列表里点"用这个池"选中的 id，带 hook 的池只能这样指定
  if (b.rangeMode === 'price') args.push(`--price-range=${str(b.priceRange)}`)
  else args.push(`--range=${str(b.range)}`)
  if (['curve', 'bidask'].includes(str(b.shape))) { args.push(`--shape=${str(b.shape)}`); if (str(b.layers)) args.push(`--layers=${str(b.layers)}`) }
  else args.push('--shape=spot')
  args.push(b.dryRun ? '--dry-run' : '--yes')
  if (b.watch && !b.dryRun) args.push('--watch')
  return args
}
function exitArgs(b: any) {
  const args: string[] = []
  if (ids(b.positions).length) args.push(`--position=${ids(b.positions).join(',')}`)
  else if (isAddress(str(b.token))) args.push(`--token=${str(b.token)}`)
  else throw new Error('要么给仓位 id，要么给代币地址')
  args.push(`--via=${via(b.via)}`)
  if (b.keepTokens) args.push('--keep-tokens')
  else if (b.sellAll) args.push('--sell-all')
  args.push(b.dryRun ? '--dry-run' : '--yes')
  return args
}
function watchArgs(b: any) {
  if (!isAddress(str(b.token))) throw new Error('代币地址不合法')
  const args = [`--token=${str(b.token)}`]
  if (ids(b.positions).length) args.push(`--position=${ids(b.positions).join(',')}`)
  if (b.dryRun) args.push('--dry-run')
  return args
}

// ---- HTTP ----
const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }
const readBody = (req: IncomingMessage) => new Promise<any>((resolve, reject) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}) } catch (e) { reject(e) } }); req.on('error', reject) })
const needKey = () => { if (!hasKey) throw new Error('.env 里没有 PRIVATE_KEY') }

// ---- 跨站防护。服务只听 127.0.0.1，但浏览器里任何网页都能往这里发请求：
// readBody 不看 Content-Type，而 text/plain 属于 CORS 安全列表、不触发预检，
// 所以一个恶意页面能直接 POST /api/launch 拿你的 USDG 去买它指定的币（响应读不到，但交易照发）。
// 三道：Origin 必须是本机（页面自己的请求带的就是它）；自定义头强制跨站预检；Host 必须是本机（防 DNS rebinding）。
const LOCAL = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`])
function guard(req: IncomingMessage) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('只接受本机访问')
  if (req.method !== 'POST') return
  const origin = req.headers.origin
  if (origin && !LOCAL.has(origin)) throw new Error('跨站请求被拒绝')
  if (req.headers['x-rh-ui'] !== '1') throw new Error('缺少 x-rh-ui 头（跨站请求被拒绝）')
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    guard(req)
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(readFileSync(join(ROOT, 'src', 'ui', 'index.html')))
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, await state(selOf(url.searchParams)))
    if (req.method === 'GET' && url.pathname === '/api/positions') return json(res, 200, { positions: await listPositions(await ctxOf(selOf(url.searchParams)), url.searchParams.get('full') === '1') })
    if (req.method === 'GET' && url.pathname === '/api/depth') return json(res, 200, await depth(await ctxOf(selOf(url.searchParams)), str(url.searchParams.get('id'))))
    if (req.method === 'GET' && url.pathname === '/api/history') return json(res, 200, await history(await ctxOf(selOf(url.searchParams)), str(url.searchParams.get('id'))))
    if (req.method === 'GET' && url.pathname === '/api/closed') return json(res, 200, await closedList(await ctxOf(selOf(url.searchParams))))
    if (req.method === 'GET' && url.pathname === '/api/pools') {
      const t = str(url.searchParams.get('token'))
      if (!isAddress(t)) throw new Error('代币地址不合法')
      return json(res, 200, await poolsFor(await ctxOf(selOf(url.searchParams)), t))
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') return json(res, 200, { jobs: [...jobs.values()].map(summary) })
    if (req.method === 'GET' && url.pathname === '/api/job') { // 某个任务的完整日志（页面切换查看时拉一次）
      const j = jobs.get(Number(url.searchParams.get('id')))
      if (!j) throw new Error('任务不存在')
      return json(res, 200, { job: summary(j), lines: j.lines, partial: redact(j.partial), plan: j.plan ?? null })
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      streams.add(res)
      req.on('close', () => streams.delete(res))
      for (const j of jobs.values()) res.write(`data: ${JSON.stringify({ type: 'status', job: summary(j) })}\n\n`)
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/launch') {
      needKey(); const b = await readBody(req); const sel = selOf(b)
      const job = startJob(sel, 'launch', `${b.dryRun ? '进场演练' : '进场'} ${str(b.token).slice(0, 10)}…`, 'src/cli.ts', launchArgs(b), { dryRun: !!b.dryRun, token: str(b.token) })
      return json(res, 200, { job: summary(job) })
    }
    if (req.method === 'POST' && url.pathname === '/api/exit') {
      needKey(); const b = await readBody(req); const sel = selOf(b)
      const job = startJob(sel, 'exit', `${b.dryRun ? '撤退演练' : '撤退'} ${ids(b.positions).length ? '#' + ids(b.positions).join(',#') : str(b.symbol) || str(b.token).slice(0, 10) + '…'}`, 'src/exit.ts', exitArgs(b), { dryRun: !!b.dryRun, token: isAddress(str(b.token)) ? str(b.token) : undefined, positions: ids(b.positions) })
      return json(res, 200, { job: summary(job) })
    }
    if (req.method === 'POST' && url.pathname === '/api/collect') { // 只领手续费：exit.ts --collect（sell = 领到的币顺便卖成计价币）
      needKey(); const b = await readBody(req); const sel = selOf(b)
      if (!ids(b.positions).length) throw new Error('要给仓位 id')
      const args = [`--position=${ids(b.positions).join(',')}`, '--collect', b.dryRun ? '--dry-run' : '--yes']
      if (b.sell) args.push('--sell', `--via=${via(b.via)}`)
      const job = startJob(sel, 'exit', `${b.dryRun ? '领手续费演练' : '领手续费'}${b.sell ? '+卖币' : ''} ${ids(b.positions).length > 3 ? `${ids(b.positions).length} 个仓位` : '#' + ids(b.positions).join(',#')}`, 'src/exit.ts', args, { dryRun: !!b.dryRun, positions: ids(b.positions) })
      return json(res, 200, { job: summary(job) })
    }
    if (req.method === 'POST' && url.pathname === '/api/watch') {
      needKey(); const b = await readBody(req); const sel = selOf(b)
      // 同一个仓位不许两个监控同时盯：触发时会各自撤退、互相撞 nonce
      const watching = [...jobs.values()].filter((j) => isRunning(j) && j.chain === sel.chain && j.protocol === sel.protocol && (j.kind === 'watch' || j.phase === 'watch'))
      const dup = watching.find((j) => same(j.token ?? '', str(b.token)) && (!j.positions.length || !ids(b.positions).length || j.positions.some((p) => ids(b.positions).includes(p))))
      if (dup) throw new Error(`任务 #${dup.id}「${dup.label}」已经在监控这个仓位`)
      const job = startJob(sel, 'watch', `监控 ${ids(b.positions).length ? '#' + ids(b.positions).join(',#') : '全部 ' + (str(b.symbol) || str(b.token).slice(0, 10) + '…')}${b.dryRun ? '（演练）' : ''}`, 'src/monitor.ts', watchArgs(b), { dryRun: !!b.dryRun, token: str(b.token), positions: ids(b.positions) })
      return json(res, 200, { job: summary(job) })
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const b = await readBody(req)
      const j = jobs.get(Number(b.id))
      if (!j) throw new Error('任务不存在')
      if (isRunning(j)) { j.proc!.kill(); j.lines.push('（已手动停止）'); emit({ type: 'log', job: j.id, text: '（已手动停止）' }) }
      return json(res, 200, { job: summary(j) })
    }
    json(res, 404, { error: 'not found' })
  } catch (e: any) {
    json(res, 400, { error: String(e?.message ?? e) })
  }
})
server.listen(PORT, '127.0.0.1', () => {
  log(`网页界面: http://127.0.0.1:${PORT}${hasKey ? `  钱包 ${wallet}` : '  （.env 里没有 PRIVATE_KEY，只能看不能操作）'}`)
})
process.on('SIGINT', () => { for (const j of jobs.values()) if (isRunning(j)) j.proc!.kill(); process.exit(0) })
