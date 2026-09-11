// 撤退：撤掉某个代币的全部 LP 仓位（本金 + 手续费），再把代币全部换回计价币（OKX DEX / Uniswap 取报价更好的一个）；--percent 只撤一部分，NFT 保留
// 既是命令行入口（npm run exit），也导出 withdraw() 给监控（monitor.ts）调用
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { formatEther, getAddress, type Address, type Hex } from 'viem'
import * as v4 from './v4.ts'
import { die, env, erc20Abi, failFast, feeText, log, makeClients, nativePriceUsd, num, positionsOf, sleep, swapDepsFor, tokenMeta, trim, txKit, swapOffers, executeSwap, prepareSwap, type Clients, type PositionRecord, type SwapOffer } from './common.ts'
import type { Pool, RawPosition } from './lp.ts'
import { ledgerTotals } from './history.ts'

export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase() // 合约返回的是校验和大小写地址，比较时忽略大小写

// 钱包名下、属于 代币/计价币 池、还有流动性的仓位：只给了 explicit 就只看这些 id；否则 positions.json 记录的 + 链上扫到的（lp.ownedIds）。
// token 不给 = 所有计价币池的仓位（网页界面列表用）。mint = 这个 NFT 铸造时的区块/交易（扫不到时为 null）
export async function findPositions(c: Clients, token?: Address, explicit?: bigint[]) {
  const { pub, lp, Q } = c
  const candidates = new Set<bigint>(explicit ?? [])
  const recs = new Map<string, PositionRecord>() // positions.json 里的记录：kind（lp / 过渡）、shape / group（curve、bidask 的成组信息）
  let mints = new Map<string, { block: bigint; tx: Hex }>()
  for (const p of positionsOf(c)) if (!token || same(p.token, token)) { if (!explicit) candidates.add(BigInt(p.id)); recs.set(p.id, p) }
  if (!explicit) {
    const owned = await lp.ownedIds()
    for (const id of owned.ids) candidates.add(id)
    mints = owned.mints
  }
  const raw = await lp.positions([...candidates])
  const found = raw
    .map((p) => ({ ...p, kind: recs.get(p.id.toString())?.kind ?? 'lp', shape: recs.get(p.id.toString())?.shape ?? (recs.has(p.id.toString()) ? 'spot' : 'unknown'), group: recs.get(p.id.toString())?.group ?? mints.get(p.id.toString())?.tx ?? null, mint: mints.get(p.id.toString()) ?? null }))
    .filter((p) => p.liquidity > 0n && [p.pool.currency0, p.pool.currency1].some((x) => same(x, Q.address)) && (!token || [p.pool.currency0, p.pool.currency1].some((x) => same(x, token))))
  // 按当前池价折算每个仓位能拿回多少（手续费另计）；同一个池只读一次
  const slots = new Map<Hex, Promise<{ sqrtP: bigint; tick: number }>>()
  return Promise.all(found.map(async (p) => {
    if (!slots.has(p.pool.id)) slots.set(p.pool.id, lp.slot0(p.pool))
    const { sqrtP, tick } = await slots.get(p.pool.id)!
    const [amount0, amount1] = v4.amountsForLiquidity(sqrtP, v4.getSqrtRatioAtTick(p.tickLower), v4.getSqrtRatioAtTick(p.tickUpper), p.liquidity)
    return { ...p, tick, sqrtP, amount0, amount1, candidates: candidates.size }
  }))
}
export type Position = Awaited<ReturnType<typeof findPositions>>[number]
export const positionFees = (c: Clients, p: RawPosition) => c.lp.fees(p)

// 把代币卖成计价币：Uniswap、OKX 和仓位所在的池（pools）同时报价，能换回更多的排前面。plan 在计划阶段报价并打印（拿不到报价就放弃，还没发任何交易），sell 按实际数量重新报价再执行
export function seller(c: Clients, token: Address, symbol: string, fmtT: (x: bigint) => string, via: string, slippage: number, pools: Pool[] = []) {
  const { Q } = c
  const deps = swapDepsFor(c, slippage, via, (x: bigint) => trim(x, Q.decimals), Q.symbol, pools)
  const offers = (amount: bigint) => swapOffers(deps, token, Q.address, 'EXACT_INPUT', amount)
  return {
    plan: async (amount: bigint, soft = false) => { // soft = 报不出价只警告并返回空（批量领取时别的币照常）
      const got = await offers(amount)
      if (got.length === 0) { if (!soft) die('拿不到卖币报价，放弃'); log(`${symbol} 现在拿不到卖币报价，领完再重试卖出`); return got }
      log(`计划: 卖出 ≈${fmtT(amount)} ${symbol}：${got.map((x) => x.text).join('；')}${got.length > 1 ? `，走 ${got[0].via}` : ''}${!deps.okx && via !== 'uniswap' ? '（未配置 OKX_API_KEY）' : ''}`)
      return got
    },
    // 卖不掉就一直重试，直到卖出为止：报价失败、发送前模拟不过（典型是"Min return not reached"= 报价已过期）都不花钱，等几秒按最新行情重新报价再来。
    // 行情急跌时 OKX 的索引常常滞后几分钟，报出来的"更高价"其实是旧价，按它设的最低回报必然达不到；它的多跳路线也虚报过（进场买 BNC4 少给 4–7%）——
    // 哪家的报价因此失败过一次，它再比别家高出超过滑点一半就不信它，改走别家（只在这种失败后才切，因为 OKX 常常真的能找到更好的路，别的原因失败不该放弃它）。
    // 每次都按钱包实际余额卖（上一次可能已经成交只是没等到回执）；真正上链后回滚的是花了 gas 的，连续 3 次就停，那多半是貔貅币或路由问题，不是价格问题
    sell: async (amount: bigint, kit: ReturnType<typeof txKit>) => {
      const balance = () => c.pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [c.wallet] })
      let reverts = 0
      const distrust = new Set<SwapOffer['via']>()
      for (let attempt = 1; ; attempt++) {
        const wait = Math.min(3 * attempt, 30)
        const bal = await balance()
        if (bal === 0n) { log(`钱包里已没有 ${symbol}，视为已卖出`); return }
        if (bal < amount) amount = bal
        const got = await offers(amount)
        let best: SwapOffer | undefined = got[0]
        if (best && distrust.has(best.via)) {
          const alt = got.find((x) => !distrust.has(x.via))
          if (alt && best.out > alt.out + (alt.out * BigInt(Math.round(slippage * 50))) / 10000n) { log(`${best.via} 报价比 ${alt.via} 高 ${((Number(best.out) / Number(alt.out) - 1) * 100).toFixed(1)}%，超过滑点的一半，多半是过期行情或虚报，改走 ${alt.via}`); best = alt }
        }
        if (!best) { log(`卖币报价失败，${wait} 秒后重试（第 ${attempt} 次；停止任务 / Ctrl+C 可放弃，${symbol} 还在钱包里）`); await sleep(wait * 1000); continue }
        log(`卖出 ${fmtT(amount)} ${symbol} -> ${best.text}`)
        try { await executeSwap(best, deps, kit, c, token, Q.address, '卖币'); return } catch (e: any) {
          if (e?.onchain && ++reverts >= 3) die(`卖币连续 ${reverts} 次上链回滚，停止重试（${symbol} 还在钱包里）: ${e.shortMessage}`)
          const msg = String(e?.shortMessage ?? e?.message).split('\n')[0].slice(0, 160)
          if (/min return|return amount|too little|slippage|insufficient output/i.test(msg)) distrust.add(best.via)
          log(`卖币失败: ${msg}，${wait} 秒后重新报价（第 ${attempt} 次）`)
          await sleep(wait * 1000)
        }
      }
    },
    // 只准备不发送（批量同时广播用）：按实际数量重新报价、补授权、拿到 calldata；报不出价返回 null 并留在钱包
    prepare: async (amount: bigint, kit: ReturnType<typeof txKit>) => {
      const [best] = await offers(amount)
      if (!best) { log(`${symbol} 卖币报价失败，留在钱包里`); return null }
      log(`卖出 ${fmtT(amount)} ${symbol} -> ${best.text}`)
      const p = await prepareSwap(best, deps, kit, c, token)
      return { label: `卖币 ${symbol} (${p.via})`, tx: p.tx, refGas: p.refGas }
    },
  }
}

// 只领手续费，不动本金：同一个池的仓位合并、所有池合成 1 笔交易；sell = 领完把领到的代币卖成计价币
// 仓位可以跨代币（网页"全部领取"）：按代币分组各自算手续费、报价，一次确认后所有池的领取合成 1 笔交易，再把各代币的卖币交易同时广播（同一区块）。没有手续费的仓位跳过，不白花 gas
export type CollectOptions = { positions: bigint[]; sell?: boolean; via: string; slippage: number; yes: boolean; dryRun: boolean; clients: Clients; json?: boolean }
export async function collectFees(o: CollectOptions) {
  const { wallet, pub, lp, Q } = o.clients
  const balanceOf = (t: Address) => pub.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })
  const [ethPrice, usdgStart, all] = await Promise.all([nativePriceUsd(o.clients), balanceOf(Q.address), findPositions(o.clients, undefined, o.positions)])
  if (all.length === 0) die(`仓位 ${o.positions.join(',')} 不在钱包名下或已没有流动性`)
  const usd = (wei: bigint) => (Number(formatEther(wei)) * ethPrice).toFixed(2)
  const fmtU = (x: bigint) => trim(x, Q.decimals)
  const tokenOf = (p: Position): Address => (same(p.pool.currency0, Q.address) ? p.pool.currency1 : p.pool.currency0)
  const byToken = new Map<string, Position[]>()
  for (const p of all) byToken.set(tokenOf(p).toLowerCase(), [...(byToken.get(tokenOf(p).toLowerCase()) ?? []), p])
  const multi = byToken.size > 1

  // 每个代币：手续费、按池分组的交易、卖币报价
  type Group = { token: Address; symbol: string; decimals: number; fmtT: (x: bigint) => string; positions: Position[]; pools: Map<Hex, { pool: Pool; ids: bigint[] }>; usdg: bigint; tokens: bigint; start: bigint; sell: ReturnType<typeof seller> | null; offers: SwapOffer[] }
  const groups: Group[] = []
  let totalUsdg = 0n
  for (const [, ps] of byToken) {
    const token = tokenOf(ps[0])
    const [{ symbol, decimals }, start] = await Promise.all([tokenMeta(pub, token), balanceOf(token)])
    const fmtT = (x: bigint) => trim(x, decimals)
    const g: Group = { token, symbol, decimals, fmtT, positions: [], pools: new Map(), usdg: 0n, tokens: 0n, start, sell: null, offers: [] }
    for (const p of ps) {
      const [f0, f1] = await lp.fees(p)
      const [u, t] = same(p.pool.currency1, token) ? [f0, f1] : [f1, f0]
      if (u === 0n && t === 0n) { log(`仓位 ${p.id}: ${symbol}/${Q.symbol} ${feeText(p.pool)} 没有未领手续费，跳过`); continue }
      g.usdg += u; g.tokens += t; g.positions.push(p)
      const grp = g.pools.get(p.pool.id) ?? { pool: p.pool, ids: [] }
      grp.ids.push(p.id); g.pools.set(p.pool.id, grp)
      log(`仓位 ${p.id}: ${symbol}/${Q.symbol} ${feeText(p.pool)} 未领手续费 ≈${fmtU(u)} ${Q.symbol} + ${fmtT(t)} ${symbol}`)
    }
    if (g.positions.length === 0) continue
    if (o.sell && g.tokens > 0n) {
      g.sell = seller(o.clients, token, symbol, fmtT, o.via, o.slippage, [...g.pools.values()].map((x) => x.pool))
      // 批量时某个币现在报不出价（比如数量太小）不拦着别的币，先领；领完卖币那步会重试报价直到卖出。单个币则直接停下
      g.offers = await g.sell.plan(g.tokens, multi)
    }
    totalUsdg += g.usdg
    groups.push(g)
  }
  if (groups.length === 0) die('这些仓位都没有未领手续费')
  const pools = groups.flatMap((g) => [...g.pools.values()])
  const collectTx = lp.collectTx(pools, wallet)
  const nPos = groups.reduce((n, g) => n + g.positions.length, 0)
  const tokensText = groups.filter((g) => g.tokens > 0n).map((g) => `${g.fmtT(g.tokens)} ${g.symbol}`).join(' + ')
  const nSell = groups.filter((g) => g.sell).length
  log(`计划: 领取 ${nPos} 个仓位的手续费（${pools.length} 个池合成 1 笔交易${nSell ? `，再同时广播 ${nSell} 笔卖币` : ''}），≈${fmtU(totalUsdg)} ${Q.symbol}${tokensText ? ' + ' + tokensText : ''}，本金不动`)
  if (o.json) console.log('@@plan ' + JSON.stringify({
    kind: 'collect', chain: o.clients.cfg.name, protocol: lp.protocol, quote: Q.symbol, wallet, txCount: 1, sellCount: nSell, expectUsdg: fmtU(totalUsdg), sell: !!o.sell,
    tokens: groups.map((g) => ({ token: { address: g.token, symbol: g.symbol, decimals: g.decimals }, positions: g.positions.map((p) => p.id.toString()), txCount: g.pools.size, expectUsdg: fmtU(g.usdg), expectToken: g.fmtT(g.tokens), sell: !!g.sell, offers: g.offers.map((x) => ({ via: x.via, out: fmtU(x.out), text: x.text })) })),
  }))
  if (o.dryRun) {
    log(`模拟领取 ${pools.map((g) => g.ids.join(',')).join(' + ')}（1 笔）: OK，gas ${await pub.estimateGas({ account: wallet, ...collectTx })}`)
    log('演练模式，到此为止')
    return
  }
  if (!o.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const ans = await rl.question('确认领取? (y/N) ')
    rl.close()
    if (ans.trim().toLowerCase() !== 'y') die('已取消')
  }
  const symOf = (t: Address) => (same(t, Q.address) ? Q.symbol : groups.find((g) => same(g.token, t))?.symbol ?? t)
  const kit = txKit(o.clients, usd, symOf)
  await kit.sendEstimated(`领手续费 ${pools.map((g) => g.ids.join(',')).join(' + ')}`, collectTx)
  const balances = await Promise.all(groups.map((g) => balanceOf(g.token)))
  const got = groups.map((g, i) => balances[i] - g.start)
  log(`领取完成: 领到 ≈${fmtU(totalUsdg)} ${Q.symbol}${groups.map((g, i) => (got[i] > 0n ? ` + ${g.fmtT(got[i])} ${g.symbol}` : '')).join('')}`)
  // 卖币：每种币按实际到账数量重新报价（并行），授权按需串行补，然后所有卖币交易同时广播、落在同一个区块
  const selling = groups.map((g, i) => ({ g, amount: got[i] })).filter((x) => x.g.sell && x.amount > 0n)
  if (selling.length) {
    const prepared = []
    for (const { g, amount } of selling) { const p = await g.sell!.prepare(amount, kit); if (p) prepared.push(p) }
    const results = await kit.sendBatch(prepared)
    const failed = results.filter((r) => !r.ok)
    if (failed.length) log(`${failed.length} 笔卖币上链回滚: ${failed.map((r) => r.label).join('、')}`)
    // 同时广播只是争取一次搞定：报不出价、模拟不过（报价过期）、上链回滚的币不能就这么留在钱包，逐个转入"卖出为止"的重试循环
    for (const { g, amount } of selling) {
      const i = groups.indexOf(g)
      if ((await balanceOf(g.token)) < balances[i]) continue // 余额少了 = 这一笔已经卖掉
      log(`${g.symbol} 没卖出去，改为逐笔重试直到卖出`)
      await g.sell!.sell(amount, kit)
    }
  }
  log(`完成: 共收回 ${fmtU((await balanceOf(Q.address)) - usdgStart)} ${Q.symbol}${groups.some((g) => g.tokens > 0n && !g.sell) ? '，未卖的代币留在钱包' : ''}`)
  log(`gas 合计: ${kit.stats.txCount} 笔，${trim(kit.stats.gasTotal, 18)} ${o.clients.cfg.native.symbol} ($${usd(kit.stats.gasTotal)})`)
}

// positions 给了就只撤这些仓位、只卖撤出来的币（同一代币可能还有别的进程在管的仓位；sellAll 则连钱包里原有的一起卖光）；否则撤该代币全部仓位、卖光钱包里的币
// percent < 100 = 部分撤出：每个仓位只撤这个比例的流动性（本金按比例，手续费不分比例、一并全领走），NFT 保留、剩下的继续做 LP
export type WithdrawOptions = {
  token?: Address; positions?: bigint[]; via: string; slippage: number; lpSlippage: number; keepTokens: boolean; sellAll?: boolean; percent?: number; yes: boolean; dryRun: boolean; clients: Clients
  json?: boolean // 计划确定后额外打印一行 "@@plan {json}" 给网页界面用
}
export async function withdraw(o: WithdrawOptions) {
  const { wallet, pub, lp, Q, cfg } = o.clients
  const balanceOf = (t: Address) => pub.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })
  const token: Address = o.token ?? await (async () => {
    const [p] = await lp.positions([o.positions![0]])
    if (!p) die(`仓位 ${o.positions![0]} 不存在、已被撤销或不在钱包名下`)
    return same(p.pool.currency0, Q.address) ? p.pool.currency1 : p.pool.currency0
  })()
  const [{ symbol, decimals }, ethPrice, usdgStart, tokenStart, found] = await Promise.all([tokenMeta(pub, token), nativePriceUsd(o.clients), balanceOf(Q.address), balanceOf(token), findPositions(o.clients, token, o.positions)])
  const usd = (wei: bigint) => (Number(formatEther(wei)) * ethPrice).toFixed(2)
  const fmtU = (x: bigint) => trim(x, Q.decimals), fmtT = (x: bigint) => trim(x, decimals)
  const symOf = (t: Address) => (same(t, Q.address) ? Q.symbol : symbol)
  log(`${cfg.label} / ${lp.label} | 钱包 ${wallet} | ${fmtU(usdgStart)} ${Q.symbol}, ${fmtT(tokenStart)} ${symbol} | ${cfg.native.symbol} $${ethPrice.toFixed(2)}`)
  if (found.length === 0) die(o.positions ? `仓位 ${o.positions.join(',')} 不在钱包名下或已没有流动性` : `钱包名下没有 ${symbol}/${Q.symbol} 的有效仓位`)
  const pct = o.percent ?? 100, partial = pct < 100
  if (!(pct > 0 && pct <= 100)) die(`撤出比例必须在 (0, 100] 之间，当前 ${pct}`)
  // 部分撤出：把每个仓位的流动性按比例截下来、本金按截后的流动性精确重算（不能拿全量本金按比例缩：流动性取整后能差好几 wei，滑点 0 时必回滚），后面的计划 / 发送都只看这一份
  const bp = BigInt(Math.round(pct * 100))
  const cut = (p: Position) => { const liquidity = (p.liquidity * bp) / 10_000n; const [amount0, amount1] = v4.amountsForLiquidity(p.sqrtP, v4.getSqrtRatioAtTick(p.tickLower), v4.getSqrtRatioAtTick(p.tickUpper), liquidity); return { ...p, liquidity, amount0, amount1 } }
  const positions = partial ? found.map(cut).filter((p) => p.liquidity > 0n) : found
  if (positions.length === 0) die(`按 ${pct}% 截下来的流动性为 0，仓位太小，直接全撤吧`)
  const sellHeld = o.positions && !o.sellAll ? 0n : tokenStart // 钱包里原有的币要不要一起卖
  // 进场金额：全撤时在最后一行和"共收回"对照着看。后台并行读流水（Alchemy），撤仓 / 卖币不等它；演练不读
  const deposits = partial || o.dryRun ? Promise.resolve(null) : ledgerTotals(o.clients, found, decimals, found.every((p) => p.mint) ? found.reduce((m, p) => (p.mint!.block < m ? p.mint!.block : m), found[0].mint!.block) : 0n).then((t) => t?.deposits ?? null)
  deposits.catch(() => {})

  // ---- 计划 ----
  let expectUsdg = 0n, expectToken = 0n
  const groups = new Map<Hex, Position[]>() // 同一个池的仓位合并成一笔交易
  for (const p of positions) {
    const [u, t] = same(p.pool.currency1, token) ? [p.amount0, p.amount1] : [p.amount1, p.amount0]
    expectUsdg += u; expectToken += t
    groups.set(p.pool.id, [...(groups.get(p.pool.id) ?? []), p])
    log(`仓位 ${p.id}: ${symbol}/${Q.symbol} ${feeText(p.pool)} ticks [${p.tickLower}, ${p.tickUpper}]，${partial ? `撤 ${pct}% ` : ''}≈${fmtU(u)} ${Q.symbol} + ${fmtT(t)} ${symbol}`)
  }
  const sellAmount = sellHeld + expectToken
  log(`计划: 撤 ${positions.length} 个仓位${partial ? `的 ${pct}% 流动性（手续费全领，NFT 保留）` : ''}（${groups.size} 笔交易），拿回 ≈${fmtU(expectUsdg)} ${Q.symbol} + ${fmtT(expectToken)} ${symbol}`)

  // 卖币报价：Uniswap、OKX 和仓位所在的池同时报价，能换回更多计价币的排前面（不卖币就不碰聚合器，没配 key 也能撤）
  const s = o.keepTokens ? null : seller(o.clients, token, symbol, fmtT, o.via, o.slippage, [...new Map(positions.map((p) => [p.pool.id, p.pool])).values()])
  const sellOffers: SwapOffer[] = s && sellAmount > 0n ? await s.plan(sellAmount) : []
  if (o.json) console.log('@@plan ' + JSON.stringify({
    kind: 'exit', chain: cfg.name, protocol: lp.protocol, quote: Q.symbol, wallet, token: { address: token, symbol, decimals }, usdg: fmtU(usdgStart), held: fmtT(tokenStart), ethPrice: ethPrice.toFixed(2), percent: pct,
    positions: positions.map((p) => { const [u, t] = same(p.pool.currency1, token) ? [p.amount0, p.amount1] : [p.amount1, p.amount0]; return { id: p.id.toString(), fee: p.pool.fee / 10000, feeText: feeText(p.pool), tickLower: p.tickLower, tickUpper: p.tickUpper, usdg: fmtU(u), token: fmtT(t), kind: p.kind } }),
    txCount: groups.size, expectUsdg: fmtU(expectUsdg), expectToken: fmtT(expectToken), sellAmount: fmtT(sellAmount), keepTokens: o.keepTokens,
    offers: sellOffers.map((x) => ({ via: x.via, out: fmtU(x.out), text: x.text })), lpSlippage: o.lpSlippage,
  }))
  // 撤仓交易：最少拿回量 = 预估 × (1 - LP_SLIPPAGE)。预估（amountsForLiquidity）向上取整、链上返还向下取整，最多差 1 wei，
  // 所以滑点为 0 时最少量得比预估再少 1 wei，否则必然回滚 MinimumAmountInsufficient
  const floor = (x: bigint) => { const y = (x * BigInt(Math.round((100 - o.lpSlippage) * 100))) / 10_000n; return y === x && x > 0n ? x - 1n : y }
  const burnTx = (ps: Position[]) => (partial ? lp.decreaseTx : lp.burnTx)(ps[0].pool, ps.map((p) => ({ id: p.id, liquidity: p.liquidity, amount0Min: floor(p.amount0), amount1Min: floor(p.amount1) })), wallet)
  if (o.dryRun) {
    for (const [, ps] of groups) log(`模拟撤仓 ${ps.map((p) => p.id).join(',')}${partial ? ` ${pct}%` : ''}: OK，gas ${await pub.estimateGas({ account: wallet, ...burnTx(ps) })}`)
    log('演练模式，到此为止')
    return { usdgGained: 0n, tokenLeft: tokenStart }
  }
  if (!o.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const ans = await rl.question(partial ? `确认撤出 ${pct}%? (y/N) ` : '确认撤退? (y/N) ')
    rl.close()
    if (ans.trim().toLowerCase() !== 'y') die('已取消')
  }

  // ---- 1) 撤仓位 ----
  // 最少拿回量按池价算，等确认的这段时间价格可能已经变了：发送前按最新池价重算；上链时仍回滚（滑点检查）就再重读重试
  const refresh = async (ps: Position[]) => {
    const { sqrtP, tick } = await lp.slot0(ps[0].pool)
    return ps.map((p) => { const [amount0, amount1] = v4.amountsForLiquidity(sqrtP, v4.getSqrtRatioAtTick(p.tickLower), v4.getSqrtRatioAtTick(p.tickUpper), p.liquidity); return { ...p, tick, amount0, amount1 } })
  }
  const kit = txKit(o.clients, usd, symOf)
  for (const [, ps0] of groups) {
    let ps = await refresh(ps0)
    const label = `撤仓位 ${ps.map((p) => p.id).join(',')}${partial ? ` ${pct}%` : ''}`
    for (let attempt = 1; ; attempt++) {
      try { await kit.sendEstimated(label, burnTx(ps)); break } catch (e: any) {
        const r = lp.slippageRevert(e)
        if (!(r || e?.onchain) || attempt >= 5) throw e
        if (r?.limit !== undefined && r.actual !== undefined) {
          const hit = ps.find((p) => floor(p.amount0) === r.limit || floor(p.amount1) === r.limit)
          const cur = hit && floor(hit.amount1) === r.limit ? hit.pool.currency1 : ps[0].pool.currency0
          const f = (x: bigint) => trim(x, same(cur, Q.address) ? Q.decimals : decimals)
          log(`${label} 回滚: 池价变动，能拿回 ${f(r.actual)} ${symOf(cur)} 低于最少 ${f(r.limit)}，等 3 秒按新池价重算（第 ${attempt} 次）`)
        } else log(`${label} ${e?.onchain ? '上链后回滚（模拟时还能过，多半是同一区块里池价被推过了滑点）' : '回滚: 池价变动超出滑点'}，等 3 秒按新池价重算（第 ${attempt} 次）`)
        await sleep(3000)
        ps = await refresh(ps)
      }
    }
  }
  const [usdgAfterBurn, tokenBal] = await Promise.all([balanceOf(Q.address), balanceOf(token)])
  log(`撤仓完成: 拿回 ${fmtU(usdgAfterBurn - usdgStart)} ${Q.symbol} + ${fmtT(tokenBal - tokenStart)} ${symbol}（含手续费${partial ? `；剩下 ${100 - pct}% 还在仓位里` : ''}）`)

  // ---- 2) 卖币：按实际余额重新报价，走更好的一家 ----
  const toSell = sellHeld + (tokenBal - tokenStart)
  if (s && toSell > 0n) await s.sell(toSell, kit)
  const [usdgEnd, tokenEnd] = await Promise.all([balanceOf(Q.address), balanceOf(token)])
  const gained = Number(usdgEnd - usdgStart) / 10 ** Q.decimals, dep = await deposits.catch(() => null)
  const vs = dep && dep > 0 ? `，进场 ${dep.toFixed(Q.decimals > 6 ? 6 : Q.decimals)} ${Q.symbol}，盈亏 ${gained - dep >= 0 ? '+' : ''}${(gained - dep).toFixed(2)} (${gained - dep >= 0 ? '+' : ''}${(((gained - dep) / dep) * 100).toFixed(1)}%)` : ''
  log(`完成: 共收回 ${fmtU(usdgEnd - usdgStart)} ${Q.symbol}${vs}${tokenEnd > 0n ? `，钱包还剩 ${fmtT(tokenEnd)} ${symbol}` : ''}`)
  log(`gas 合计: ${kit.stats.txCount} 笔，${trim(kit.stats.gasTotal, 18)} ${cfg.native.symbol} ($${usd(kit.stats.gasTotal)})`)
  return { usdgGained: usdgEnd - usdgStart, tokenLeft: tokenEnd }
}

// ---- 命令行入口 ----
if (process.env.RH_MAIN === 'exit' || import.meta.url === pathToFileURL(process.argv[1]).href) { // 直接运行，或经 run.ts 分派
  failFast()
  const { values: opt } = parseArgs({
    options: {
      chain: { type: 'string' }, protocol: { type: 'string' },               // 链 / 协议（common.ts 里解析）
      token: { type: 'string' },                                            // 代币地址：撤掉它的全部仓位
      position: { type: 'string' },                                         // 只撤这些仓位 id（逗号分隔，可代替 --token），只卖撤出来的币
      via: { type: 'string', default: env('EXIT_SWAP_VIA', 'best') },       // 卖币走哪家: okx | uniswap | pool（仓位所在的池直换）| best（都报价取高者）
      slippage: { type: 'string', default: env('SWAP_SLIPPAGE', '5') },     // 卖币滑点 %
      'lp-slippage': { type: 'string', default: env('LP_SLIPPAGE', '5') },  // 撤仓最少拿回量的余量 %
      'keep-tokens': { type: 'boolean', default: false },                   // 只撤仓位，不卖币
      'sell-all': { type: 'boolean', default: false },                      // --position 模式下也把钱包里原有的币一起卖光
      percent: { type: 'string' },                                          // 只撤这个百分比的流动性（手续费全领，NFT 保留）；不给 = 全撤并销毁 NFT
      collect: { type: 'boolean', default: false },                         // 只领手续费，本金不动（需要 --position）
      sell: { type: 'boolean', default: false },                            // --collect 时把领到的代币卖成计价币
      yes: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      from: { type: 'string' },
      json: { type: 'boolean', default: false },                            // 给网页界面用：计划确定后打印一行 "@@plan {json}"
    },
  })
  if (!opt.token && !opt.position) die('用法: npm run exit -- [--chain robinhood|bsc|ethereum] [--protocol v4|infinity|v3] --token <代币地址> [--position <仓位id,仓位id>] [--percent <1-100>] [--via okx|uniswap|pool|best] [--keep-tokens] [--sell-all] [--collect [--sell]] [--yes] [--dry-run]')
  if (!['okx', 'uniswap', 'pool', 'best'].includes(opt.via)) die('--via 只能是 okx / uniswap / pool / best')
  if (opt.collect && opt.percent !== undefined) die('--collect 只领手续费，不能和 --percent 一起用')
  const positions = opt.position ? opt.position.split(',').map((x) => BigInt(x.trim())) : undefined
  const clients = await makeClients({ from: opt.from, needKey: !opt['dry-run'] })
  if (opt.collect) {
    if (!positions) die('--collect 需要 --position 指定仓位')
    await collectFees({ positions, sell: opt.sell, via: opt.via, slippage: num('--slippage', opt.slippage, 0, 50), yes: opt.yes, dryRun: opt['dry-run'], json: opt.json, clients })
    await sleep(100); process.exit(0)
  }
  await withdraw({
    token: opt.token ? getAddress(opt.token) : undefined, positions, via: opt.via,
    slippage: num('--slippage', opt.slippage, 0, 50), lpSlippage: num('--lp-slippage', opt['lp-slippage'], 0, 50), keepTokens: opt['keep-tokens'], sellAll: opt['sell-all'], yes: opt.yes, dryRun: opt['dry-run'], json: opt.json,
    percent: opt.percent === undefined ? undefined : num('--percent', opt.percent, 1, 100),
    clients,
  })
  await sleep(100); process.exit(0)
}
