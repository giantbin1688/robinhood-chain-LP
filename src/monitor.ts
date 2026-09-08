// 监控：盯着某个代币的 LP 仓位，池价跳出区间就自动撤退并卖币；你手动撤掉仓位则自动停止
// 既是命令行入口（npm run watch），也导出 watchToken() 给进场命令的 --watch 用
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { getAddress, type Address, type Hex } from 'viem'
import * as v4 from './v4.ts'
import { die, env, log, makeClients, p6, pct, sleep, tokenMeta, type Clients } from './common.ts'
import { findPositions, same, withdraw, type Position } from './exit.ts'

// positions 给了就只盯这些仓位、触发时也只撤这些（同一代币可以开多个进程各管各的）；否则盯钱包里该代币的全部仓位
export type WatchOptions = { token: Address; positions?: bigint[]; clients: Clients; interval: number; confirm: number; upperGrace: number; via: string; slippage: number; lpSlippage: number; dryRun: boolean; json?: boolean }
export async function watchToken(o: WatchOptions) {
  const { pub, lp, Q } = o.clients
  const { symbol, decimals } = await tokenMeta(pub, o.token)
  const all = await findPositions(o.clients, o.token, o.positions)
  if (all.length === 0) { log(o.positions ? `仓位 ${o.positions.join(',')} 不在钱包名下或已没有流动性，不监控` : `钱包名下没有 ${symbol}/${Q.symbol} 的有效仓位，不监控`); return }
  const tokenIs1 = same(all[0].pool.currency1, o.token)
  const [dec0, dec1] = tokenIs1 ? [Q.decimals, decimals] : [decimals, Q.decimals]
  const usdgPerTokenAtTick = (t: number) => { const h = v4.priceAtTick(t) * 10 ** (dec0 - dec1); return tokenIs1 ? 1 / h : h }
  // 只盯主要仓位：忽略过渡仓位和价值不到总量 2% 的粉尘
  const value = (p: Position) => { const [u, t] = tokenIs1 ? [p.amount0, p.amount1] : [p.amount1, p.amount0]; return Number(u) / 10 ** Q.decimals + (Number(t) / 10 ** decimals) * usdgPerTokenAtTick(p.tick) }
  const total = all.reduce((s, p) => s + value(p), 0)
  let main = all.filter((p) => p.kind !== 'bridge' && value(p) >= total * 0.02)
  if (main.length === 0) { log('没有可监控的主要仓位'); return }
  const edges = (p: Position) => [usdgPerTokenAtTick(p.tickLower), usdgPerTokenAtTick(p.tickUpper)].sort((a, b) => a - b)
  log(`监控 ${symbol}/${Q.symbol}: ${main.map((p) => `仓位 ${p.id} 区间 ${edges(p).map(p6).join(' .. ')}`).join('；')}，每 ${o.interval}s 检查，连续 ${o.confirm} 次跳出区间即撤退${o.upperGrace > 0 ? `（涨破上沿时仓位已全是 ${Q.symbol}，多等 ${Math.round(o.upperGrace / 60)} 分钟没回来才撤）` : ''}（Ctrl+C 停止）`)

  // 只有"进入过区间后又离开"才算跳出：一开始就在区间外的是等待型仓位（挂在现价一侧等价格来），不触发
  const armed = new Set<bigint>()
  let outStreak = 0, aboveSince: number | null = null, lastStatus = '', lastBeat = 0, errors = 0, polls = 0
  for (;;) {
    try {
      const ticks = new Map<Hex, number>()
      for (const p of main) if (!ticks.has(p.pool.id)) ticks.set(p.pool.id, (await lp.slot0(p.pool)).tick)
      const tickOf = (p: Position) => ticks.get(p.pool.id)!
      const inRange = (p: Position) => tickOf(p) >= p.tickLower && tickOf(p) < p.tickUpper
      const above = (p: Position) => usdgPerTokenAtTick(tickOf(p)) > edges(p)[1]
      for (const p of main) if (inRange(p)) armed.add(p.id)
      const out = main.filter((p) => !inRange(p) && armed.has(p.id))
      const outBelow = out.filter((p) => !above(p))
      // 涨破上沿：仓位已全是计价币，等一段宽限期，价格回到区间就重新计时；跌破下沿：满仓代币，按确认次数尽快止损
      outStreak = out.length ? outStreak + 1 : 0
      aboveSince = out.length > outBelow.length ? (aboveSince ?? Date.now()) : null
      const graceLeft = aboveSince === null ? 0 : o.upperGrace * 1000 - (Date.now() - aboveSince)
      // 每个仓位各报各的区间和状态（多个仓位可能在不同池，价格也各取各池的）
      const one = (p: Position) => {
        const cur = usdgPerTokenAtTick(tickOf(p)), [lo, hi] = edges(p)
        const state = inRange(p) ? '区间内'
          : !armed.has(p.id) ? `等待进入区间（现价在区间${cur > hi ? '上' : '下'}方）`
          : above(p) && graceLeft > 0 ? `已涨破上沿（全是 ${Q.symbol}，再等 ${Math.ceil(graceLeft / 60_000)} 分钟没回来就撤退）`
          : '已跳出区间'
        return `仓位 ${p.id} 区间 ${p6(lo)} .. ${p6(hi)}（距下沿 ${pct(lo / cur - 1)}，距上沿 ${pct(hi / cur - 1)}）${state}`
      }
      const status = `价格 ${p6(usdgPerTokenAtTick(tickOf(main[0])))} ${Q.symbol}/${symbol}；${main.map(one).join('；')}`
      if (status !== lastStatus || Date.now() - lastBeat > 5 * 60_000) { log(status); lastStatus = status; lastBeat = Date.now() }
      if (outStreak >= o.confirm && (outBelow.length > 0 || graceLeft <= 0)) {
        log(`触发撤退: 连续 ${outStreak} 次检查跳出区间${outBelow.length ? '' : `，涨破上沿已超过 ${Math.round(o.upperGrace / 60)} 分钟`}`)
        await withdraw({ token: o.token, positions: o.positions, via: o.via, slippage: o.slippage, lpSlippage: o.lpSlippage, keepTokens: false, yes: true, dryRun: o.dryRun, clients: o.clients, json: o.json })
        return
      }
      // 每分钟核对一次仓位还在不在（手动撤了就停止监控）
      if (++polls % Math.max(1, Math.round(60 / o.interval)) === 0) {
        const alive = await lp.positions(main.map((p) => p.id)).catch(() => null)
        if (alive) {
          const ok = new Set(alive.filter((p) => p.liquidity > 0n).map((p) => p.id))
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

// ---- 命令行入口 ----
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values: opt } = parseArgs({
    options: {
      chain: { type: 'string' }, protocol: { type: 'string' },              // 链 / 协议（common.ts 里解析）
      token: { type: 'string' },
      position: { type: 'string' },                                        // 只盯这些仓位 id（逗号分隔），触发时也只撤这些
      interval: { type: 'string', default: env('WATCH_INTERVAL', '10') },  // 检查间隔（秒）
      confirm: { type: 'string', default: env('WATCH_CONFIRM', '2') },     // 连续几次跳出区间才撤退
      'upper-grace': { type: 'string', default: env('WATCH_UPPER_GRACE', '600') }, // 涨破上沿后多等几秒没回来才撤（0 = 不等）
      via: { type: 'string', default: env('EXIT_SWAP_VIA', 'best') },
      slippage: { type: 'string', default: env('SWAP_SLIPPAGE', '5') },
      'lp-slippage': { type: 'string', default: env('LP_SLIPPAGE', '5') },
      'dry-run': { type: 'boolean', default: false },                      // 触发时只演练撤退，不发交易
      from: { type: 'string' },
      json: { type: 'boolean', default: false },                           // 给网页界面用：触发撤退时打印一行 "@@plan {json}"
    },
  })
  if (!opt.token) die('用法: npm run watch -- [--chain robinhood|bsc] [--protocol v4|infinity|v3] --token <代币地址> [--position <仓位id,仓位id>] [--interval 10] [--confirm 2] [--upper-grace 600] [--via okx|uniswap|best] [--dry-run]')
  await watchToken({
    token: getAddress(opt.token), positions: opt.position ? opt.position.split(',').map((x) => BigInt(x.trim())) : undefined,
    clients: await makeClients({ from: opt.from, needKey: !opt['dry-run'] }), interval: Math.max(3, Number(opt.interval)), confirm: Math.max(1, Number(opt.confirm)),
    upperGrace: Math.max(0, Number(opt['upper-grace'])), via: opt.via, slippage: Number(opt.slippage), lpSlippage: Number(opt['lp-slippage']), dryRun: opt['dry-run'], json: opt.json,
  })
  await sleep(100); process.exit(0)
}
