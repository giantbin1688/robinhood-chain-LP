// Solana 监控：盯着某个代币的 LP 仓位，池价跳出区间就自动撤退并卖币；你手动撤掉仓位则自动停止
// 既是命令行入口（npm run watch -- --chain solana），也导出 watchToken() 给进场命令的 --watch 用。逻辑和 EVM 的 monitor.ts 一样，只是仓位 / 价格来自 sol/lp.ts
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { die, env, failFast, isSolAddress, log, makeSolClients, p6, pct, sleep, tokenMeta, type SolClients } from './common.ts'
import { findPositions, quotePerToken, split, withdraw, type Position } from './exit.ts'
import { num } from '../common.ts'

export type WatchOptions = { token: string; positions?: string[]; clients: SolClients; interval: number; confirm: number; upperGrace: number; via: string; slippage: number; lpSlippage: number; dryRun: boolean; json?: boolean }
export async function watchToken(o: WatchOptions) {
  const { conn, lp } = o.clients
  const { symbol, decimals } = await tokenMeta(conn, o.token)
  const all = await findPositions(o.clients, o.token, o.positions)
  if (all.length === 0) { log(o.positions ? `仓位 ${o.positions.join(',')} 不在钱包名下或已没有流动性，不监控` : `钱包名下没有 ${symbol} 的有效仓位，不监控`); return }
  const Q = all[0].quote
  // 只盯主要仓位：忽略价值不到总量 2% 的粉尘
  const states = new Map<string, { price: number; active: number }>()
  for (const p of all) if (!states.has(p.pool.id)) states.set(p.pool.id, await lp.state(p.pool))
  const value = (p: Position) => { const s = split(p); return Number(s.usdg) / 10 ** Q.decimals + (Number(s.token) / 10 ** decimals) * quotePerToken(p, states.get(p.pool.id)!.price) }
  const total = all.reduce((s, p) => s + value(p), 0)
  let main = all.filter((p) => value(p) >= total * 0.02)
  if (main.length === 0) { log('没有可监控的主要仓位'); return }
  const edges = (p: Position) => lp.edges(p).map((x) => quotePerToken(p, x)).sort((a, b) => a - b)
  log(`监控 ${symbol}/${Q.symbol}: ${main.map((p) => `仓位 ${p.id.slice(0, 8)}… 区间 ${edges(p).map(p6).join(' .. ')}`).join('；')}，每 ${o.interval}s 检查，连续 ${o.confirm} 次跳出区间即撤退${o.upperGrace > 0 ? `（涨破上沿时仓位已全是 ${Q.symbol}，多等 ${Math.round(o.upperGrace / 60)} 分钟没回来才撤）` : ''}（Ctrl+C 停止）`)
  const armed = new Set<string>()
  let outStreak = 0, aboveSince: number | null = null, lastStatus = '', lastBeat = 0, errors = 0, polls = 0
  for (;;) {
    try {
      const st = new Map<string, { price: number; active: number }>()
      for (const p of main) if (!st.has(p.pool.id)) st.set(p.pool.id, await lp.state(p.pool))
      const priceOf = (p: Position) => quotePerToken(p, st.get(p.pool.id)!.price)
      const inRange = (p: Position) => lp.inRange(p, st.get(p.pool.id)!.active)
      const above = (p: Position) => priceOf(p) > edges(p)[1]
      for (const p of main) if (inRange(p)) armed.add(p.id)
      const out = main.filter((p) => !inRange(p) && armed.has(p.id))
      const outBelow = out.filter((p) => !above(p))
      outStreak = out.length ? outStreak + 1 : 0
      aboveSince = out.length > outBelow.length ? (aboveSince ?? Date.now()) : null
      const graceLeft = aboveSince === null ? 0 : o.upperGrace * 1000 - (Date.now() - aboveSince)
      const one = (p: Position) => {
        const cur = priceOf(p), [lo, hi] = edges(p)
        const state = inRange(p) ? '区间内' : !armed.has(p.id) ? `等待进入区间（现价在区间${cur > hi ? '上' : '下'}方）` : above(p) && graceLeft > 0 ? `已涨破上沿（全是 ${Q.symbol}，再等 ${Math.ceil(graceLeft / 60_000)} 分钟没回来就撤退）` : '已跳出区间'
        return `仓位 ${p.id.slice(0, 8)}… 区间 ${p6(lo)} .. ${p6(hi)}（距下沿 ${pct(lo / cur - 1)}，距上沿 ${pct(hi / cur - 1)}）${state}`
      }
      const status = `价格 ${p6(priceOf(main[0]))} ${Q.symbol}/${symbol}；${main.map(one).join('；')}`
      if (status !== lastStatus || Date.now() - lastBeat > 5 * 60_000) { log(status); lastStatus = status; lastBeat = Date.now() }
      if (outStreak >= o.confirm && (outBelow.length > 0 || graceLeft <= 0)) {
        log(`触发撤退: 连续 ${outStreak} 次检查跳出区间${outBelow.length ? '' : `，涨破上沿已超过 ${Math.round(o.upperGrace / 60)} 分钟`}`)
        await withdraw({ token: o.token, positions: o.positions, via: o.via, slippage: o.slippage, lpSlippage: o.lpSlippage, keepTokens: false, yes: true, dryRun: o.dryRun, clients: o.clients, json: o.json })
        return
      }
      if (++polls % Math.max(1, Math.round(60 / o.interval)) === 0) { // 每分钟核对一次仓位还在不在
        const alive = await lp.positions(main.map((p) => p.id)).catch(() => null)
        if (alive) {
          const ok = new Set(alive.filter((p) => p.amountX > 0n || p.amountY > 0n).map((p) => p.id))
          main = main.filter((p) => ok.has(p.id))
          if (main.length === 0) { log('仓位已被撤销（手动操作？），停止监控'); return }
        }
      }
      errors = 0
    } catch (e: any) {
      if (++errors >= 30) die(`监控连续出错 ${errors} 次，退出: ${String(e?.message).slice(0, 200)}`)
      log(`监控出错（第 ${errors} 次，继续）: ${String(e?.message).slice(0, 120)}`)
    }
    await sleep(o.interval * 1000)
  }
}

if (process.env.RH_MAIN === 'watch' || import.meta.url === pathToFileURL(process.argv[1]).href) { // 直接运行，或经 run.ts 分派
  failFast()
  const { values: opt } = parseArgs({
    options: {
      chain: { type: 'string' }, protocol: { type: 'string' }, token: { type: 'string' }, position: { type: 'string' },
      interval: { type: 'string', default: env('WATCH_INTERVAL', '10') }, confirm: { type: 'string', default: env('WATCH_CONFIRM', '2') }, 'upper-grace': { type: 'string', default: env('WATCH_UPPER_GRACE', '600') },
      via: { type: 'string', default: env('EXIT_SWAP_VIA', 'best') }, slippage: { type: 'string', default: env('SWAP_SLIPPAGE', '5') }, 'lp-slippage': { type: 'string', default: env('LP_SLIPPAGE', '5') },
      'dry-run': { type: 'boolean', default: false }, from: { type: 'string' }, json: { type: 'boolean', default: false },
    },
  })
  if (!opt.token || !isSolAddress(opt.token)) die('用法: npm run watch -- --chain solana [--protocol dlmm|clmm] --token <mint> [--position <仓位,仓位>] [--interval 10] [--confirm 2] [--upper-grace 600] [--via jupiter|pool|best] [--dry-run]')
  const via = ['jupiter', 'pool', 'best'].includes(opt.via) ? opt.via : 'best'
  await watchToken({
    token: opt.token, positions: opt.position ? opt.position.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
    clients: await makeSolClients({ from: opt.from, needKey: !opt['dry-run'], protocol: opt.protocol as any }), interval: Math.max(3, num('--interval', opt.interval, 0, 86400)), confirm: Math.max(1, num('--confirm', opt.confirm, 0, 1000)),
    upperGrace: num('--upper-grace', opt['upper-grace'], 0, 86400 * 30), via, slippage: num('--slippage', opt.slippage, 0, 50), lpSlippage: num('--lp-slippage', opt['lp-slippage'], 0, 50), dryRun: opt['dry-run'], json: opt.json,
  })
  await sleep(100); process.exit(0)
}
