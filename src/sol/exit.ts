// Solana 撤退：撤掉某个代币的全部 LP 仓位（本金 + 手续费），再把代币换回计价币（Jupiter / 池内比价）；--percent 只撤一部分，仓位保留
// 既是命令行入口（npm run exit -- --chain solana），也导出 withdraw() / collectFees() 给监控和网页用
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { balanceOf, die, env, failFast, feeText, isSolAddress, lamportsToSol, log, makeSolClients, quoteSide, sleep, solPositionsOf, solTxKit, solUsd, tokenMeta, trim, type SolClients, type SolPositionRecord, type SolToken, type TxBundle } from './common.ts'
import type { SolPool, SolPosition } from './lp.ts'
import { solExecuteSwap, solPrepareSwap, solSwapDepsFor, solSwapOffers, type SolSwapOffer } from './swap.ts'
import { num } from '../common.ts'

export type Position = SolPosition & { kind: 'lp' | 'bridge'; shape: string; group: string | null; quote: SolToken; tokenIsX: boolean; token: string; at: string | null; candidates: number }

// 钱包名下、以 SOL / USDC 计价、还有本金或未领手续费的仓位：只给了 explicit 就只看这些 id；否则 positions.json 记录的 + 链上扫到的（全部池）。
// token 不给 = 全部（网页列表用）
export async function findPositions(c: SolClients, token?: string, explicit?: string[]): Promise<Position[]> {
  const { lp } = c
  const recs = new Map<string, SolPositionRecord>()
  for (const p of solPositionsOf(c.protocol)) if (!token || p.token === token) recs.set(p.id, p)
  let raw: SolPosition[]
  if (explicit) raw = await lp.positions(explicit)
  else {
    const owned = await lp.ownedPositions()
    const seen = new Set(owned.map((p) => p.id))
    const missing = [...recs.keys()].filter((id) => !seen.has(id))
    raw = [...owned, ...(missing.length ? await lp.positions(missing) : [])]
  }
  const out: Position[] = []
  for (const p of raw) {
    const q = quoteSide(p.pool)
    if (!q) continue
    const tok = q.tokenIsX ? p.pool.mintX : p.pool.mintY
    if (token && tok !== token) continue
    if (p.amountX === 0n && p.amountY === 0n && p.feeX === 0n && p.feeY === 0n) continue
    const r = recs.get(p.id)
    out.push({ ...p, kind: r?.kind ?? 'lp', shape: r?.shape ?? 'spot', group: r?.group ?? null, quote: q.quote, tokenIsX: q.tokenIsX, token: tok, at: r?.at ?? null, candidates: raw.length })
  }
  return out
}
// 仓位里的 计价币 / 代币 数量（本金）和手续费
export const split = (p: Position) => ({ usdg: p.tokenIsX ? p.amountY : p.amountX, token: p.tokenIsX ? p.amountX : p.amountY, feeUsdg: p.tokenIsX ? p.feeY : p.feeX, feeToken: p.tokenIsX ? p.feeX : p.feeY })
// 计价币 每 代币（UI 单位）
export const quotePerToken = (p: Pick<Position, 'pool' | 'tokenIsX'>, priceYperX: number) => (p.tokenIsX ? priceYperX : 1 / priceYperX)

// 把代币卖成计价币：Jupiter 和仓位所在的池同时报价。plan 在计划阶段报价并打印，sell 按实际数量重新报价再执行（卖不掉就一直重试）
export function seller(c: SolClients, token: string, symbol: string, fmtT: (x: bigint) => string, quote: SolToken, via: string, slippage: number, pools: SolPool[] = []) {
  const deps = solSwapDepsFor(c, slippage, via, (x: bigint) => trim(x, quote.decimals), quote.symbol, pools)
  const offers = (amount: bigint) => solSwapOffers(deps, token, quote.mint, amount)
  return {
    plan: async (amount: bigint, soft = false) => {
      const got = await offers(amount)
      if (got.length === 0) { if (!soft) die('拿不到卖币报价，放弃'); log(`${symbol} 现在拿不到卖币报价，领完再重试卖出`); return got }
      log(`计划: 卖出 ≈${fmtT(amount)} ${symbol}：${got.map((x) => x.text).join('；')}${got.length > 1 ? `，走 ${got[0].via}` : ''}`)
      return got
    },
    sell: async (amount: bigint, kit: ReturnType<typeof solTxKit>) => {
      let reverts = 0
      for (let attempt = 1; ; attempt++) {
        const wait = Math.min(3 * attempt, 30)
        const bal = await balanceOf(c.conn, c.wallet, token)
        if (bal === 0n) { log(`钱包里已没有 ${symbol}，视为已卖出`); return }
        if (bal < amount) amount = bal
        const [best] = await offers(amount)
        if (!best) { log(`卖币报价失败，${wait} 秒后重试（第 ${attempt} 次；停止任务 / Ctrl+C 可放弃，${symbol} 还在钱包里）`); await sleep(wait * 1000); continue }
        log(`卖出 ${fmtT(amount)} ${symbol} -> ${best.text}`)
        try { await solExecuteSwap(best, deps, kit, token, quote.mint, '卖币'); return } catch (e: any) {
          if (e?.onchain && ++reverts >= 3) die(`卖币连续 ${reverts} 次上链失败，停止重试（${symbol} 还在钱包里）: ${e.shortMessage}`)
          log(`卖币失败: ${String(e?.shortMessage ?? e?.message).split('\n')[0].slice(0, 160)}，${wait} 秒后重新报价（第 ${attempt} 次）`)
          await sleep(wait * 1000)
        }
      }
    },
    prepare: async (amount: bigint): Promise<TxBundle | null> => {
      const [best] = await offers(amount)
      if (!best) { log(`${symbol} 卖币报价失败，留在钱包里`); return null }
      log(`卖出 ${fmtT(amount)} ${symbol} -> ${best.text}`)
      const b = await solPrepareSwap(best, deps, token, quote.mint)
      return { ...b, label: `卖币 ${symbol} (${best.via === 'jupiter' ? 'Jupiter' : '池内'})` }
    },
  }
}

const confirm = async (q: string) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); const ans = await rl.question(q); rl.close(); if (ans.trim().toLowerCase() !== 'y') die('已取消') }
// 一串交易：演练就逐笔模拟，否则逐笔发送
async function run(kit: ReturnType<typeof solTxKit>, bundles: TxBundle[], dryRun: boolean) {
  for (const b of bundles) { if (dryRun) log(`模拟 ${b.label}: OK，${await kit.simulate(b)} CU`); else await kit.send(b) }
}

// 只领手续费，本金不动。仓位可以跨代币（网页"全部领取"）：按代币分组各自报价，领完把各代币卖成各自的计价币
export type CollectOptions = { positions: string[]; sell?: boolean; via: string; slippage: number; yes: boolean; dryRun: boolean; clients: SolClients; json?: boolean }
export async function collectFees(o: CollectOptions) {
  const { conn, wallet, lp } = o.clients
  const [sol, all] = await Promise.all([solUsd(conn), findPositions(o.clients, undefined, o.positions)])
  if (all.length === 0) die(`仓位 ${o.positions.join(',')} 不在钱包名下或已没有流动性`)
  const usd = (lamports: bigint) => ((Number(lamports) / 1e9) * sol).toFixed(2)
  type Group = { token: string; symbol: string; decimals: number; quote: SolToken; fmtT: (x: bigint) => string; positions: Position[]; usdg: bigint; tokens: bigint; start: bigint; sell: ReturnType<typeof seller> | null; offers: SolSwapOffer[] }
  const byToken = new Map<string, Position[]>()
  for (const p of all) byToken.set(`${p.token}/${p.quote.symbol}`, [...(byToken.get(`${p.token}/${p.quote.symbol}`) ?? []), p])
  const groups: Group[] = []
  for (const [, ps] of byToken) {
    const token = ps[0].token, quote = ps[0].quote
    const [{ symbol, decimals }, start] = await Promise.all([tokenMeta(conn, token), balanceOf(conn, wallet, token)])
    const fmtT = (x: bigint) => trim(x, decimals), fmtU = (x: bigint) => trim(x, quote.decimals)
    const g: Group = { token, symbol, decimals, quote, fmtT, positions: [], usdg: 0n, tokens: 0n, start, sell: null, offers: [] }
    for (const p of ps) {
      const s = split(p)
      if (s.feeUsdg === 0n && s.feeToken === 0n) { log(`仓位 ${p.id}: ${symbol}/${quote.symbol} ${feeText(p.pool)} 没有未领手续费，跳过`); continue }
      g.usdg += s.feeUsdg; g.tokens += s.feeToken; g.positions.push(p)
      log(`仓位 ${p.id}: ${symbol}/${quote.symbol} ${feeText(p.pool)} 未领手续费 ≈${fmtU(s.feeUsdg)} ${quote.symbol} + ${fmtT(s.feeToken)} ${symbol}`)
    }
    if (!g.positions.length) continue
    if (o.sell && g.tokens > 0n) { g.sell = seller(o.clients, token, symbol, fmtT, quote, o.via, o.slippage, [...new Map(g.positions.map((p) => [p.pool.id, p.pool])).values()]); g.offers = await g.sell.plan(g.tokens, byToken.size > 1) }
    groups.push(g)
  }
  if (!groups.length) die('这些仓位都没有未领手续费')
  const bundles = await lp.collectTx(groups.flatMap((g) => g.positions))
  const nPos = groups.reduce((n, g) => n + g.positions.length, 0)
  log(`计划: 领取 ${nPos} 个仓位的手续费（${bundles.length} 笔交易${groups.some((g) => g.sell) ? '，再卖币' : ''}），${groups.map((g) => `≈${trim(g.usdg, g.quote.decimals)} ${g.quote.symbol} + ${g.fmtT(g.tokens)} ${g.symbol}`).join('；')}，本金不动`)
  if (o.json) console.log('@@plan ' + JSON.stringify({
    kind: 'collect', chain: 'solana', protocol: lp.protocol, quote: groups[0].quote.symbol, wallet: wallet.toBase58(), txCount: bundles.length, sellCount: groups.filter((g) => g.sell).length, expectUsdg: trim(groups.reduce((s, g) => s + g.usdg, 0n), groups[0].quote.decimals), sell: !!o.sell,
    tokens: groups.map((g) => ({ token: { address: g.token, symbol: g.symbol, decimals: g.decimals }, quote: g.quote.symbol, positions: g.positions.map((p) => p.id), txCount: g.positions.length, expectUsdg: trim(g.usdg, g.quote.decimals), expectToken: g.fmtT(g.tokens), sell: !!g.sell, offers: g.offers.map((x) => ({ via: x.via, out: trim(x.out, g.quote.decimals), text: x.text })) })),
  }))
  const kit = solTxKit(o.clients, usd)
  if (o.dryRun) { await run(kit, bundles, true); log('演练模式，到此为止'); return }
  if (!o.yes) await confirm('确认领取? (y/N) ')
  await run(kit, bundles, false)
  const got = await Promise.all(groups.map(async (g) => (await balanceOf(conn, wallet, g.token)) - g.start))
  log(`领取完成: ${groups.map((g, i) => `≈${trim(g.usdg, g.quote.decimals)} ${g.quote.symbol}${got[i] > 0n ? ` + ${g.fmtT(got[i])} ${g.symbol}` : ''}`).join('；')}`)
  for (const [i, g] of groups.entries()) if (g.sell && got[i] > 0n) await g.sell.sell(got[i], kit)
  log(`完成${groups.some((g) => g.tokens > 0n && !g.sell) ? '，未卖的代币留在钱包' : ''}`)
  log(`手续费合计: ${kit.stats.txCount} 笔，${lamportsToSol(kit.stats.feeTotal)} SOL ($${usd(kit.stats.feeTotal)})`)
}

// positions 给了就只撤这些仓位、只卖撤出来的币（sellAll 则连钱包里原有的一起卖光）；否则撤该代币全部仓位、卖光钱包里的币。percent < 100 = 部分撤出
export type WithdrawOptions = { token?: string; positions?: string[]; via: string; slippage: number; lpSlippage: number; keepTokens: boolean; sellAll?: boolean; percent?: number; yes: boolean; dryRun: boolean; clients: SolClients; json?: boolean }
export async function withdraw(o: WithdrawOptions) {
  const { conn, wallet, lp, cfg } = o.clients
  let found = await findPositions(o.clients, o.token, o.positions)
  if (found.length === 0) die(o.positions ? `仓位 ${o.positions.join(',')} 不在钱包名下或已没有流动性` : `钱包名下没有这个代币的有效仓位`)
  if (!o.token && new Set(found.map((p) => p.token)).size > 1) die('指定的仓位属于不同代币，请分开撤')
  const token = o.token ?? found[0].token
  found = found.filter((p) => p.token === token)
  const quote = found[0].quote
  const [{ symbol, decimals }, sol, usdgStart, tokenStart] = await Promise.all([tokenMeta(conn, token), solUsd(conn), balanceOf(conn, wallet, quote.mint), balanceOf(conn, wallet, token)])
  const usd = (lamports: bigint) => ((Number(lamports) / 1e9) * sol).toFixed(2)
  const fmtU = (x: bigint) => trim(x, quote.decimals), fmtT = (x: bigint) => trim(x, decimals)
  log(`${cfg.label} / ${lp.label} | 钱包 ${wallet.toBase58()} | ${fmtU(usdgStart)} ${quote.symbol}, ${fmtT(tokenStart)} ${symbol} | SOL $${sol.toFixed(2)}`)
  const pct = o.percent ?? 100, partial = pct < 100
  if (!(pct > 0 && pct <= 100)) die(`撤出比例必须在 (0, 100] 之间，当前 ${pct}`)
  const bps = Math.round(pct * 100)
  const sellHeld = o.positions && !o.sellAll ? 0n : tokenStart
  let expectUsdg = 0n, expectToken = 0n
  for (const p of found) {
    const s = split(p)
    const [u, t] = partial ? [(s.usdg * BigInt(bps)) / 10_000n + s.feeUsdg, (s.token * BigInt(bps)) / 10_000n + s.feeToken] : [s.usdg + s.feeUsdg, s.token + s.feeToken]
    expectUsdg += u; expectToken += t
    log(`仓位 ${p.id}: ${symbol}/${quote.symbol} ${feeText(p.pool)} 区间 [${p.lower}, ${p.upper}]，${partial ? `撤 ${pct}% ` : ''}≈${fmtU(u)} ${quote.symbol} + ${fmtT(t)} ${symbol}（含手续费）`)
  }
  const sellAmount = sellHeld + expectToken
  const bundles = await lp.burnTx(found, bps, o.lpSlippage)
  log(`计划: 撤 ${found.length} 个仓位${partial ? `的 ${pct}% 流动性（手续费全领，仓位保留）` : '（关闭仓位、退还租金）'}（${bundles.length} 笔交易），拿回 ≈${fmtU(expectUsdg)} ${quote.symbol} + ${fmtT(expectToken)} ${symbol}`)
  const s = o.keepTokens ? null : seller(o.clients, token, symbol, fmtT, quote, o.via, o.slippage, [...new Map(found.map((p) => [p.pool.id, p.pool])).values()])
  const sellOffers = s && sellAmount > 0n ? await s.plan(sellAmount) : []
  if (o.json) console.log('@@plan ' + JSON.stringify({
    kind: 'exit', chain: 'solana', protocol: lp.protocol, quote: quote.symbol, wallet: wallet.toBase58(), token: { address: token, symbol, decimals }, usdg: fmtU(usdgStart), held: fmtT(tokenStart), ethPrice: sol.toFixed(2), percent: pct,
    positions: found.map((p) => { const x = split(p); return { id: p.id, fee: p.pool.fee / 10000, feeText: feeText(p.pool), tickLower: p.lower, tickUpper: p.upper, usdg: fmtU(x.usdg), token: fmtT(x.token), kind: p.kind } }),
    txCount: bundles.length, expectUsdg: fmtU(expectUsdg), expectToken: fmtT(expectToken), sellAmount: fmtT(sellAmount), keepTokens: o.keepTokens,
    offers: sellOffers.map((x) => ({ via: x.via, out: fmtU(x.out), text: x.text })), lpSlippage: o.lpSlippage,
  }))
  const kit = solTxKit(o.clients, usd)
  if (o.dryRun) { await run(kit, bundles, true); log('演练模式，到此为止'); return { usdgGained: 0n, tokenLeft: tokenStart } }
  if (!o.yes) await confirm(partial ? `确认撤出 ${pct}%? (y/N) ` : '确认撤退? (y/N) ')
  // 1) 撤仓位：发送前按最新状态重建交易（等确认期间池价可能变了）；失败就等几秒重读重试，最多 5 次
  for (let attempt = 1; ; attempt++) {
    try {
      const fresh = attempt === 1 ? bundles : await lp.burnTx(await findPositions(o.clients, token, found.map((p) => p.id)), bps, o.lpSlippage)
      if (!fresh.length) { log('仓位已不在（可能已被撤掉），跳过撤仓'); break }
      await run(kit, fresh, false); break
    } catch (e: any) {
      if (attempt >= 5) throw e
      log(`撤仓失败: ${String(e?.shortMessage ?? e?.message).split('\n')[0].slice(0, 160)}，等 3 秒重试（第 ${attempt} 次）`)
      await sleep(3000)
    }
  }
  const [usdgAfter, tokenBal] = await Promise.all([balanceOf(conn, wallet, quote.mint), balanceOf(conn, wallet, token)])
  log(`撤仓完成: 拿回 ${fmtU(usdgAfter - usdgStart)} ${quote.symbol} + ${fmtT(tokenBal - tokenStart)} ${symbol}（含手续费${partial ? `；剩下 ${100 - pct}% 还在仓位里` : ''}）`)
  // 2) 卖币
  const toSell = sellHeld + (tokenBal - tokenStart)
  if (s && toSell > 0n) await s.sell(toSell, kit)
  const [usdgEnd, tokenEnd] = await Promise.all([balanceOf(conn, wallet, quote.mint), balanceOf(conn, wallet, token)])
  log(`完成: 共收回 ${fmtU(usdgEnd - usdgStart)} ${quote.symbol}${tokenEnd > 0n ? `，钱包还剩 ${fmtT(tokenEnd)} ${symbol}` : ''}`)
  log(`手续费合计: ${kit.stats.txCount} 笔，${lamportsToSol(kit.stats.feeTotal)} SOL ($${usd(kit.stats.feeTotal)})`)
  return { usdgGained: usdgEnd - usdgStart, tokenLeft: tokenEnd }
}

// ---- 命令行入口 ----
if (process.env.RH_MAIN === 'exit' || import.meta.url === pathToFileURL(process.argv[1]).href) { // 直接运行，或经 run.ts 分派
  failFast()
  const { values: opt } = parseArgs({
    options: {
      chain: { type: 'string' }, protocol: { type: 'string' },
      token: { type: 'string' }, position: { type: 'string' },
      via: { type: 'string', default: env('EXIT_SWAP_VIA', 'best') },
      slippage: { type: 'string', default: env('SWAP_SLIPPAGE', '5') }, 'lp-slippage': { type: 'string', default: env('LP_SLIPPAGE', '5') },
      'keep-tokens': { type: 'boolean', default: false }, 'sell-all': { type: 'boolean', default: false },
      percent: { type: 'string' }, collect: { type: 'boolean', default: false }, sell: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, from: { type: 'string' }, json: { type: 'boolean', default: false },
    },
  })
  if (!opt.token && !opt.position) die('用法: npm run exit -- --chain solana [--protocol dlmm|clmm] --token <mint> [--position <仓位,仓位>] [--percent <1-100>] [--via jupiter|pool|best] [--keep-tokens] [--sell-all] [--collect [--sell]] [--yes] [--dry-run]')
  if (opt.token && !isSolAddress(opt.token)) die('--token 必须是 Solana 的代币 mint 地址')
  const via = opt.via === 'okx' || opt.via === 'uniswap' ? 'best' : opt.via // EVM 的默认值在 Solana 上不存在，按 best 处理
  if (!['jupiter', 'pool', 'best'].includes(via)) die('--via 只能是 jupiter / pool / best')
  if (opt.collect && opt.percent !== undefined) die('--collect 只领手续费，不能和 --percent 一起用')
  const positions = opt.position ? opt.position.split(',').map((x) => x.trim()).filter(Boolean) : undefined
  if (positions?.some((x) => !isSolAddress(x))) die('--position 必须是仓位地址（DLMM 仓位账户 / CLMM 的 NFT mint）')
  const clients = await makeSolClients({ from: opt.from, needKey: !opt['dry-run'], protocol: opt.protocol as any })
  if (opt.collect) {
    if (!positions) die('--collect 需要 --position 指定仓位')
    await collectFees({ positions, sell: opt.sell, via, slippage: num('--slippage', opt.slippage, 0, 50), yes: opt.yes, dryRun: opt['dry-run'], json: opt.json, clients })
    await sleep(100); process.exit(0)
  }
  await withdraw({ token: opt.token, positions, via, slippage: num('--slippage', opt.slippage, 0, 50), lpSlippage: num('--lp-slippage', opt['lp-slippage'], 0, 50), keepTokens: opt['keep-tokens'], sellAll: opt['sell-all'], yes: opt.yes, dryRun: opt['dry-run'], json: opt.json, percent: opt.percent === undefined ? undefined : num('--percent', opt.percent, 1, 100), clients })
  await sleep(100); process.exit(0)
}
