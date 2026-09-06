// 监控：盯着某个代币的 LP 仓位，池价跳出区间就自动撤退并卖币；你手动撤掉仓位则自动停止
// 既是命令行入口（npm run watch），也导出 watchToken() 给进场命令的 --watch 用
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { getAddress, type Address, type Hex } from 'viem'
import * as v4 from './v4.ts'
import { POSM, STATE_VIEW, die, env, log, makeClients, p6, pct, posmAbi, sleep, stateViewAbi, tokenMeta, type Clients } from './common.ts'
import { findPositions, same, withdraw, type Position } from './exit.ts'

export type WatchOptions = { token: Address; clients: Clients; interval: number; confirm: number; via: string; slippage: number; lpSlippage: number; dryRun: boolean }
export async function watchToken(o: WatchOptions) {
  const { pub, wallet } = o.clients
  const { symbol, decimals } = await tokenMeta(pub, o.token)
  const all = await findPositions(o.clients, o.token)
  if (all.length === 0) { log(`钱包名下没有 ${symbol}/USDG 的有效仓位，不监控`); return }
  const tokenIs1 = same(all[0].key.currency1, o.token)
  const [dec0, dec1] = tokenIs1 ? [6, decimals] : [decimals, 6]
  const usdgPerTokenAtTick = (t: number) => { const h = v4.priceAtTick(t) * 10 ** (dec0 - dec1); return tokenIs1 ? 1 / h : h }
  // 只盯主要仓位：忽略过渡仓位和价值不到总量 2% 的粉尘
  const value = (p: Position) => { const [u, t] = tokenIs1 ? [p.amount0, p.amount1] : [p.amount1, p.amount0]; return Number(u) / 1e6 + (Number(t) / 10 ** decimals) * usdgPerTokenAtTick(p.tick) }
  const total = all.reduce((s, p) => s + value(p), 0)
  let main = all.filter((p) => p.kind !== 'bridge' && value(p) >= total * 0.02)
  if (main.length === 0) { log('没有可监控的主要仓位'); return }
  const edges = (p: Position) => [usdgPerTokenAtTick(p.tickLower), usdgPerTokenAtTick(p.tickUpper)].sort((a, b) => a - b)
  log(`监控 ${symbol}/USDG: ${main.map((p) => `仓位 ${p.id} 区间 ${edges(p).map(p6).join(' .. ')}`).join('；')}，每 ${o.interval}s 检查，连续 ${o.confirm} 次跳出区间即撤退（Ctrl+C 停止）`)

  let outStreak = 0, lastStatus = '', lastBeat = 0, errors = 0, polls = 0
  for (;;) {
    try {
      const ticks = new Map<Hex, number>()
      for (const id of new Set(main.map((p) => v4.poolId(p.key)))) ticks.set(id, (await pub.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [id] }))[1])
      const tickOf = (p: Position) => ticks.get(v4.poolId(p.key))!
      const out = main.filter((p) => tickOf(p) < p.tickLower || tickOf(p) >= p.tickUpper)
      const cur = usdgPerTokenAtTick(tickOf(main[0]))
      const [lo, hi] = [Math.min(...main.map((p) => edges(p)[0])), Math.max(...main.map((p) => edges(p)[1]))]
      const status = `价格 ${p6(cur)} USDG/${symbol}，区间 ${p6(lo)} .. ${p6(hi)}（距下沿 ${pct(lo / cur - 1)}，距上沿 ${pct(hi / cur - 1)}）${out.length ? `，仓位 ${out.map((p) => p.id).join(',')} 已跳出区间` : '，区间内'}`
      if (status !== lastStatus || Date.now() - lastBeat > 5 * 60_000) { log(status); lastStatus = status; lastBeat = Date.now() }
      outStreak = out.length ? outStreak + 1 : 0
      if (outStreak >= o.confirm) {
        log(`触发撤退: 连续 ${outStreak} 次检查跳出区间`)
        await withdraw({ token: o.token, via: o.via, slippage: o.slippage, lpSlippage: o.lpSlippage, keepTokens: false, yes: true, dryRun: o.dryRun, clients: o.clients })
        return
      }
      // 每分钟核对一次仓位还在不在（手动撤了就停止监控）
      if (++polls % Math.max(1, Math.round(60 / o.interval)) === 0) {
        const alive = await Promise.all(main.map(async (p) => {
          const [owner, liq] = await Promise.all([
            pub.readContract({ address: POSM, abi: posmAbi, functionName: 'ownerOf', args: [p.id] }).catch(() => ''),
            pub.readContract({ address: POSM, abi: posmAbi, functionName: 'getPositionLiquidity', args: [p.id] }).catch(() => 0n),
          ])
          return same(owner, wallet) && liq > 0n
        }))
        main = main.filter((_, i) => alive[i])
        if (main.length === 0) { log('仓位已被撤销（手动操作？），停止监控'); return }
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
      token: { type: 'string' },
      interval: { type: 'string', default: env('WATCH_INTERVAL', '10') },  // 检查间隔（秒）
      confirm: { type: 'string', default: env('WATCH_CONFIRM', '2') },     // 连续几次跳出区间才撤退
      via: { type: 'string', default: env('EXIT_SWAP_VIA', 'best') },
      slippage: { type: 'string', default: env('SWAP_SLIPPAGE', '5') },
      'lp-slippage': { type: 'string', default: env('LP_SLIPPAGE', '5') },
      'dry-run': { type: 'boolean', default: false },                      // 触发时只演练撤退，不发交易
      from: { type: 'string' },
    },
  })
  if (!opt.token) die('用法: npm run watch -- --token <代币地址> [--interval 10] [--confirm 2] [--via okx|uniswap|best] [--dry-run]')
  await watchToken({
    token: getAddress(opt.token), clients: makeClients(opt.from, !opt['dry-run']), interval: Math.max(3, Number(opt.interval)), confirm: Math.max(1, Number(opt.confirm)),
    via: opt.via, slippage: Number(opt.slippage), lpSlippage: Number(opt['lp-slippage']), dryRun: opt['dry-run'],
  })
  await sleep(100); process.exit(0)
}
