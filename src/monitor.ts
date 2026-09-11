// 监控：盯着某个代币的 LP 仓位，池价跳出区间就自动撤退并卖币；开了止损的改按整组本金算盈亏，亏到线才撤、不再看区间；你手动撤掉仓位则自动停止
// 既是命令行入口（npm run watch），也导出 watchToken() 给进场命令的 --watch 用
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { getAddress, type Address, type Hex } from 'viem'
import * as v4 from './v4.ts'
import { die, env, failFast, log, makeClients, num, p6, pct, sleep, tokenMeta, type Clients } from './common.ts'
import { findPositions, positionFees, same, withdraw, type Position } from './exit.ts'
import { ledgerTotals } from './history.ts'

// positions 给了就只盯这些仓位、触发时也只撤这些（同一代币可以开多个进程各管各的）；否则盯钱包里该代币的全部仓位。
// stopLoss > 0 = 止损：盯的这些仓位当成一组，(现值 + 未领手续费 + 已领手续费 + 已撤本金 − 存入本金) / 存入本金 跌到 −stopLoss% 就整组撤退并卖币。
// 开了止损就只看这一个条件，"跳出区间"整个不看：bidask / curve 贴着现价的那一段价格稍动就进出区间，按区间规则会在亏 1% 时就把整组撤了，止损形同虚设。存入本金优先用 entry（启动时手填 / 进场时的预算），没给才从链上流水读（要 Alchemy），两个都没有则拒绝启动，不能默默变成没止损
export type WatchOptions = { token: Address; positions?: bigint[]; clients: Clients; interval: number; confirm: number; upperGrace: number; stopLoss?: number; entry?: number; via: string; slippage: number; lpSlippage: number; dryRun: boolean; json?: boolean }
export async function watchToken(o: WatchOptions) {
  const { pub, lp, Q } = o.clients
  const { symbol, decimals } = await tokenMeta(pub, o.token)
  const all = await findPositions(o.clients, o.token, o.positions)
  if (all.length === 0) { log(o.positions ? `仓位 ${o.positions.join(',')} 不在钱包名下或已没有流动性，不监控` : `钱包名下没有 ${symbol}/${Q.symbol} 的有效仓位，不监控`); return }
  const tokenIs1 = same(all[0].pool.currency1, o.token)
  const [dec0, dec1] = tokenIs1 ? [Q.decimals, decimals] : [decimals, Q.decimals]
  const usdgPerTokenAtTick = (t: number) => { const h = v4.priceAtTick(t) * 10 ** (dec0 - dec1); return tokenIs1 ? 1 / h : h }
  // 只盯主要仓位：忽略过渡仓位和价值不到总量 2% 的粉尘
  const usdgOf = (a0: bigint, a1: bigint, tick: number) => { const [u, t] = tokenIs1 ? [a0, a1] : [a1, a0]; return Number(u) / 10 ** Q.decimals + (Number(t) / 10 ** decimals) * usdgPerTokenAtTick(tick) }
  const value = (p: Position) => usdgOf(p.amount0, p.amount1, p.tick)
  const total = all.reduce((s, p) => s + value(p), 0)
  let main = all.filter((p) => p.kind !== 'bridge' && value(p) >= total * 0.02)
  if (main.length === 0) { log('没有可监控的主要仓位'); return }
  const edges = (p: Position) => [usdgPerTokenAtTick(p.tickLower), usdgPerTokenAtTick(p.tickUpper)].sort((a, b) => a - b)
  // 止损的基准：整组的本金和历史上已经拿回来的部分。bidask / curve 是几个仓位合成一组，只看其中一段会把组打散，所以全部合起来算
  const stopLoss = o.stopLoss ?? 0
  let base: { deposits: number; withdrawn: number; fees: number } | null = null, baseManual = false
  if (stopLoss > 0) {
    const since = main.every((p) => p.mint) ? main.reduce((m, p) => (p.mint!.block < m ? p.mint!.block : m), main[0].mint!.block) : 0n
    base = await ledgerTotals(o.clients, main, decimals, since)
    if (base && !(base.deposits > 0)) base = null
    if (o.entry && o.entry > 0) { base = { deposits: o.entry, withdrawn: base?.withdrawn ?? 0, fees: base?.fees ?? 0 }; baseManual = true }
    if (!base) die(`开了止损 ${stopLoss}% 但算不出进场本金：${o.clients.rpcIsAlchemy ? '链上流水里没有这些仓位的存入记录' : '资金流水需要 Alchemy 节点'}；请用 --entry 手填进场时的 ${Q.symbol} 金额，或去掉止损`)
  }
  const fmtQ = (x: number) => x.toFixed(2)
  const stopText = base ? `止损 ${stopLoss}%：整组本金 ${fmtQ(base.deposits)} ${Q.symbol}${baseManual ? '（手填）' : ''}${base.fees + base.withdrawn > 0 ? `，已领手续费 ${fmtQ(base.fees)}，已撤本金 ${fmtQ(base.withdrawn)}` : ''}，价值（含手续费）跌到 ${fmtQ(base.deposits * (1 - stopLoss / 100))} 以下即撤退` : ''
  log(`监控 ${symbol}/${Q.symbol}: ${main.map((p) => `仓位 ${p.id} 区间 ${edges(p).map(p6).join(' .. ')}`).join('；')}，每 ${o.interval}s 检查，${base ? `只按止损撤退（不看区间）：连续 ${o.confirm} 次${stopText}` : `连续 ${o.confirm} 次跳出区间即撤退${o.upperGrace > 0 ? `（涨破上沿时仓位已全是 ${Q.symbol}，多等 ${Math.round(o.upperGrace / 60)} 分钟没回来才撤）` : ''}`}（Ctrl+C 停止）`)

  // 只有"进入过区间后又离开"才算跳出：一开始就在区间外的是等待型仓位（挂在现价一侧等价格来），不触发
  const armed = new Set<bigint>()
  let outStreak = 0, lossStreak = 0, aboveSince: number | null = null, lastStatus = '', lastBeat = 0, errors = 0, polls = 0
  for (;;) {
    try {
      const slots = new Map<Hex, { sqrtP: bigint; tick: number }>()
      for (const p of main) if (!slots.has(p.pool.id)) slots.set(p.pool.id, await lp.slot0(p.pool))
      const tickOf = (p: Position) => slots.get(p.pool.id)!.tick
      // 止损：按最新池价重算每个仓位的现值，加未领手续费（每轮读链；手续费读失败按 0 算，只会让估值偏低、更早触发，不会漏）
      let loss: { value: number; pnl: number } | null = null
      if (base) {
        const fees = await Promise.all(main.map((p) => positionFees(o.clients, p).catch(() => [0n, 0n] as [bigint, bigint])))
        let value = base.fees + base.withdrawn
        main.forEach((p, i) => {
          const s = slots.get(p.pool.id)!
          const [a0, a1] = v4.amountsForLiquidity(s.sqrtP, v4.getSqrtRatioAtTick(p.tickLower), v4.getSqrtRatioAtTick(p.tickUpper), p.liquidity)
          value += usdgOf(a0 + fees[i][0], a1 + fees[i][1], s.tick)
        })
        loss = { value, pnl: value / base.deposits - 1 }
        lossStreak = loss.pnl <= -stopLoss / 100 ? lossStreak + 1 : 0
      }
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
          : base ? `在区间${cur > hi ? '上' : '下'}方` // 止损模式下区间只是信息，不是触发条件
          : !armed.has(p.id) ? `等待进入区间（现价在区间${cur > hi ? '上' : '下'}方）`
          : above(p) && graceLeft > 0 ? `已涨破上沿（全是 ${Q.symbol}，再等 ${Math.ceil(graceLeft / 60_000)} 分钟没回来就撤退）`
          : '已跳出区间'
        return `仓位 ${p.id} 区间 ${p6(lo)} .. ${p6(hi)}（距下沿 ${pct(lo / cur - 1)}，距上沿 ${pct(hi / cur - 1)}）${state}`
      }
      const status = `价格 ${p6(usdgPerTokenAtTick(tickOf(main[0])))} ${Q.symbol}/${symbol}；${main.map(one).join('；')}${loss && base ? `；整组价值 ${fmtQ(loss.value)} / 本金 ${fmtQ(base.deposits)} ${Q.symbol}（${pct(loss.pnl)}，止损线 ${pct(-stopLoss / 100)}）` : ''}`
      if (status !== lastStatus || Date.now() - lastBeat > 5 * 60_000) { log(status); lastStatus = status; lastBeat = Date.now() }
      // 开了止损只看亏损（连续 confirm 次，防单次坏报价）；没开才看跳出区间（按确认次数 / 上沿宽限）
      const byLoss = lossStreak >= o.confirm, byRange = !base && outStreak >= o.confirm && (outBelow.length > 0 || graceLeft <= 0)
      if (byLoss || byRange) {
        log(byLoss ? `触发止损: 连续 ${lossStreak} 次检查整组亏损 ${pct(loss!.pnl)}（价值 ${fmtQ(loss!.value)} / 本金 ${fmtQ(base!.deposits)} ${Q.symbol}），超过止损线 ${stopLoss}%` : `触发撤退: 连续 ${outStreak} 次检查跳出区间${outBelow.length ? '' : `，涨破上沿已超过 ${Math.round(o.upperGrace / 60)} 分钟`}`)
        await withdraw({ token: o.token, positions: o.positions, via: o.via, slippage: o.slippage, lpSlippage: o.lpSlippage, keepTokens: false, yes: true, dryRun: o.dryRun, clients: o.clients, json: o.json })
        return
      }
      // 每分钟核对一次仓位还在不在（手动撤了就停止监控）
      if (++polls % Math.max(1, Math.round(60 / o.interval)) === 0) {
        const alive = await lp.positions(main.map((p) => p.id)).catch(() => null)
        if (alive) {
          const liq = new Map(alive.map((p) => [p.id, p.liquidity]))
          for (const p of main) p.liquidity = liq.get(p.id) ?? 0n // 你中途手动撤了一部分，止损估值要按剩下的算
          main = main.filter((p) => p.liquidity > 0n)
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
if (process.env.RH_MAIN === 'watch' || import.meta.url === pathToFileURL(process.argv[1]).href) { // 直接运行，或经 run.ts 分派
  failFast()
  const { values: opt } = parseArgs({
    options: {
      chain: { type: 'string' }, protocol: { type: 'string' },              // 链 / 协议（common.ts 里解析）
      token: { type: 'string' },
      position: { type: 'string' },                                        // 只盯这些仓位 id（逗号分隔），触发时也只撤这些
      interval: { type: 'string', default: env('WATCH_INTERVAL', '10') },  // 检查间隔（秒）
      confirm: { type: 'string', default: env('WATCH_CONFIRM', '2') },     // 连续几次跳出区间才撤退
      'upper-grace': { type: 'string', default: env('WATCH_UPPER_GRACE', '600') }, // 涨破上沿后多等几秒没回来才撤（0 = 不等）
      'stop-loss': { type: 'string', default: env('WATCH_STOP_LOSS', '0') },      // 整组亏到本金的百分之几就撤（0 = 不开）
      entry: { type: 'string' },                                           // 止损用的进场本金（计价币）；不给就从链上流水读
      via: { type: 'string', default: env('EXIT_SWAP_VIA', 'best') },
      slippage: { type: 'string', default: env('SWAP_SLIPPAGE', '5') },
      'lp-slippage': { type: 'string', default: env('LP_SLIPPAGE', '5') },
      'dry-run': { type: 'boolean', default: false },                      // 触发时只演练撤退，不发交易
      from: { type: 'string' },
      json: { type: 'boolean', default: false },                           // 给网页界面用：触发撤退时打印一行 "@@plan {json}"
    },
  })
  if (!opt.token) die('用法: npm run watch -- [--chain robinhood|bsc|ethereum] [--protocol v4|infinity|v3] --token <代币地址> [--position <仓位id,仓位id>] [--interval 10] [--confirm 2] [--upper-grace 600] [--stop-loss 30 [--entry 500]] [--via okx|uniswap|best] [--dry-run]')
  await watchToken({
    token: getAddress(opt.token), positions: opt.position ? opt.position.split(',').map((x) => BigInt(x.trim())) : undefined,
    clients: await makeClients({ from: opt.from, needKey: !opt['dry-run'] }), interval: Math.max(3, num('--interval', opt.interval, 0, 86400)), confirm: Math.max(1, num('--confirm', opt.confirm, 0, 1000)),
    upperGrace: num('--upper-grace', opt['upper-grace'], 0, 86400 * 30), stopLoss: num('--stop-loss', opt['stop-loss'], 0, 99), entry: opt.entry ? num('--entry', opt.entry, 0, 1e12) : undefined, via: opt.via, slippage: num('--slippage', opt.slippage, 0, 50), lpSlippage: num('--lp-slippage', opt['lp-slippage'], 0, 50), dryRun: opt['dry-run'], json: opt.json,
  })
  await sleep(100); process.exit(0)
}
