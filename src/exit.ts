// 撤退：撤掉某个代币的全部 LP 仓位（本金 + 手续费），再把代币全部换回 USDG（OKX DEX / Uniswap 取报价更好的一个）
// 既是命令行入口（npm run exit），也导出 withdraw() 给监控（monitor.ts）调用
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { encodeFunctionData, formatEther, getAddress, numberToHex, parseAbi, type Address, type Hex } from 'viem'
import * as v4 from './v4.ts'
import {
  POSM, STATE_VIEW, USDG, die, env, erc20Abi, ethPriceUsd, loadPositions, log, makeClients, now, okxDex, posmAbi, positionTransfers,
  sleep, slippageRevert, stateViewAbi, tokenMeta, trim, txKit, uniswapApi, swapOffers, executeSwap, prepareSwap, type Clients, type PositionRecord, type SwapOffer,
} from './common.ts'

export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase() // 合约返回的是校验和大小写地址，比较时忽略大小写

// 钱包名下、属于 代币/USDG 池、还有流动性的仓位：只给了 explicit 就只看这些 id；否则 positions.json 记录的 + 链上转入记录（positionTransfers）。
// token 不给 = 所有 USDG 池的仓位（网页界面列表用）。mint = 这个 NFT 铸造时的区块/交易（别处转进来的或 explicit 查询时为 null）。
// 逐个 NFT 的只读调用用 multicall 合成一个 eth_call：Uniswap 网页撤流动性不销毁 NFT，钱包里会攒下几十个空仓位，逐个查会撞 Alchemy 的每秒额度
export async function findPositions(c: Clients, token?: Address, explicit?: bigint[]) {
  const { wallet, pub } = c
  const candidates = new Set<bigint>(explicit ?? [])
  const recs = new Map<string, PositionRecord>() // positions.json 里的记录：kind（lp / 过渡）、shape / group（curve、bidask 的成组信息）
  const mints = new Map<string, { block: bigint; tx: Hex }>()
  for (const p of loadPositions()) if (!token || same(p.token, token)) { if (!explicit) candidates.add(BigInt(p.id)); recs.set(p.id, p) }
  if (!explicit) { // 转入次数 > 转出次数的才可能还在钱包里（销毁 = 转给 0x0）
    const held = new Map<string, number>()
    for (const t of await positionTransfers(c)) {
      const k = t.id.toString()
      if (same(t.to, wallet)) { held.set(k, (held.get(k) ?? 0) + 1); if (same(t.from, v4.ZERO_ADDRESS)) mints.set(k, { block: t.block, tx: t.tx }) }
      if (same(t.from, wallet)) held.set(k, (held.get(k) ?? 0) - 1)
    }
    for (const [k, n] of held) if (n > 0) candidates.add(BigInt(k))
  }
  const ids = [...candidates]
  const owners = await pub.multicall({ allowFailure: true, batchSize: 0, contracts: ids.map((id) => ({ address: POSM, abi: posmAbi, functionName: 'ownerOf', args: [id] }) as const) })
  const owned = ids.filter((_, i) => owners[i].status === 'success' && same(owners[i].result as string, wallet)) // 已销毁的 ownerOf 会 revert
  const infos = await pub.multicall({ allowFailure: false, batchSize: 0, contracts: owned.flatMap((id) => [
    { address: POSM, abi: posmAbi, functionName: 'getPoolAndPositionInfo', args: [id] } as const,
    { address: POSM, abi: posmAbi, functionName: 'getPositionLiquidity', args: [id] } as const,
  ]) })
  const found = owned.map((id, i) => {
    const [key, info] = infos[2 * i] as readonly [v4.PoolKey, bigint]
    return { id, key, liquidity: infos[2 * i + 1] as bigint, kind: recs.get(id.toString())?.kind ?? 'lp', shape: recs.get(id.toString())?.shape ?? 'spot', group: recs.get(id.toString())?.group ?? null, mint: mints.get(id.toString()) ?? null, ...v4.decodePositionInfo(info) }
  }).filter((p) => p.liquidity > 0n && [p.key.currency0, p.key.currency1].some((x) => same(x, USDG)) && (!token || [p.key.currency0, p.key.currency1].some((x) => same(x, token))))
  // 按当前池价折算每个仓位能拿回多少（手续费另计）
  return Promise.all(found.map(async (p) => {
    const [sqrtP, tick] = await pub.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [v4.poolId(p.key)] })
    const [amount0, amount1] = v4.amountsForLiquidity(sqrtP, v4.getSqrtRatioAtTick(p.tickLower), v4.getSqrtRatioAtTick(p.tickUpper), p.liquidity)
    return { ...p, tick, amount0, amount1, candidates: candidates.size }
  }))
}
export type Position = Awaited<ReturnType<typeof findPositions>>[number]

// 未领手续费 = 仓位流动性 × (区间内手续费增长 − 上次结算时的值) / 2^128，差值按 uint256 回绕。PositionManager 在 PoolManager 里的仓位 key：owner = POSM，salt = tokenId
const feeAbi = parseAbi([
  'function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)',
  'function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
])
const Q128 = 1n << 128n, U256 = (1n << 256n) - 1n
export async function positionFees(pub: Clients['pub'], p: Position): Promise<[bigint, bigint]> {
  const pid = v4.poolId(p.key)
  const [[in0, in1], [liq, last0, last1]] = await Promise.all([
    pub.readContract({ address: STATE_VIEW, abi: feeAbi, functionName: 'getFeeGrowthInside', args: [pid, p.tickLower, p.tickUpper] }),
    pub.readContract({ address: STATE_VIEW, abi: feeAbi, functionName: 'getPositionInfo', args: [pid, POSM, p.tickLower, p.tickUpper, numberToHex(p.id, { size: 32 })] }),
  ])
  if (liq !== p.liquidity) throw new Error(`仓位 ${p.id}: PoolManager 里的流动性 ${liq} 与 PositionManager 的 ${p.liquidity} 不一致`)
  return [(((in0 - last0) & U256) * liq) / Q128, (((in1 - last1) & U256) * liq) / Q128]
}

// 把代币卖成 USDG：Uniswap 和 OKX 同时报价，能换回更多 USDG 的排前面。plan 在计划阶段报价并打印（拿不到报价就放弃，还没发任何交易），sell 按实际数量重新报价再执行
function seller(c: Clients, token: Address, symbol: string, fmtT: (x: bigint) => string, via: string, slippage: number) {
  const deps = { uni: uniswapApi(c.wallet, slippage), okx: okxDex(c.wallet, slippage), via, fmtOut: (x: bigint) => trim(x, 6), outSym: 'USDG' }
  if (via === 'okx' && !deps.okx) die('--via okx 需要在 .env 里配置 OKX_API_KEY / OKX_SECRET_KEY / OKX_API_PASSPHRASE')
  const offers = (amount: bigint) => swapOffers(deps, token, USDG, 'EXACT_INPUT', amount)
  return {
    plan: async (amount: bigint, soft = false) => { // soft = 报不出价只警告并返回空（批量领取时别的币照常）
      const got = await offers(amount)
      if (got.length === 0) { if (!soft) die('拿不到卖币报价，放弃'); log(`${symbol} 拿不到卖币报价，领到的 ${symbol} 留在钱包`); return got }
      log(`计划: 卖出 ≈${fmtT(amount)} ${symbol}：${got.map((x) => x.text).join('；')}${got.length > 1 ? `，走 ${got[0].via}` : ''}${!deps.okx && via !== 'uniswap' ? '（未配置 OKX_API_KEY，只有 Uniswap）' : ''}`)
      return got
    },
    sell: async (amount: bigint, kit: ReturnType<typeof txKit>) => {
      const [best] = await offers(amount)
      if (!best) die('卖币报价失败，代币留在钱包里')
      log(`卖出 ${fmtT(amount)} ${symbol} -> ${best.text}`)
      await executeSwap(best, deps, kit, c, token, USDG, '卖币')
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

// 只领手续费，不动本金：同一个池的仓位合并成一笔 DECREASE_LIQUIDITY(0) ×n + TAKE_PAIR；sell = 领完把领到的代币卖成 USDG（USDG 那部分本来就是 USDG）
// 仓位可以跨代币（网页"全部领取"）：按代币分组各自算手续费、报价，一次确认后所有池的领取合成 1 笔交易，再把各代币的卖币交易同时广播（同一区块）。没有手续费的仓位跳过，不白花 gas
export type CollectOptions = { positions: bigint[]; sell?: boolean; via: string; slippage: number; yes: boolean; dryRun: boolean; clients: Clients; json?: boolean }
export async function collectFees(o: CollectOptions) {
  const { wallet, pub } = o.clients
  const balanceOf = (t: Address) => pub.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })
  const [ethPrice, usdgStart, all] = await Promise.all([ethPriceUsd(pub), balanceOf(USDG), findPositions(o.clients, undefined, o.positions)])
  if (all.length === 0) die(`仓位 ${o.positions.join(',')} 不在钱包名下或已没有流动性`)
  const usd = (wei: bigint) => (Number(formatEther(wei)) * ethPrice).toFixed(2)
  const fmtU = (x: bigint) => trim(x, 6)
  const tokenOf = (p: Position): Address => (same(p.key.currency0, USDG) ? p.key.currency1 : p.key.currency0)
  const byToken = new Map<string, Position[]>()
  for (const p of all) byToken.set(tokenOf(p).toLowerCase(), [...(byToken.get(tokenOf(p).toLowerCase()) ?? []), p])
  const multi = byToken.size > 1

  // 每个代币：手续费、按池分组的交易、卖币报价
  type Group = { token: Address; symbol: string; decimals: number; fmtT: (x: bigint) => string; positions: Position[]; pools: Map<Hex, Position[]>; usdg: bigint; tokens: bigint; start: bigint; sell: ReturnType<typeof seller> | null; offers: SwapOffer[] }
  const groups: Group[] = []
  let totalUsdg = 0n
  for (const [, ps] of byToken) {
    const token = tokenOf(ps[0])
    const [{ symbol, decimals }, start] = await Promise.all([tokenMeta(pub, token), balanceOf(token)])
    const fmtT = (x: bigint) => trim(x, decimals)
    const g: Group = { token, symbol, decimals, fmtT, positions: [], pools: new Map(), usdg: 0n, tokens: 0n, start, sell: null, offers: [] }
    for (const p of ps) {
      const [f0, f1] = await positionFees(pub, p)
      const [u, t] = same(p.key.currency1, token) ? [f0, f1] : [f1, f0]
      if (u === 0n && t === 0n) { log(`仓位 ${p.id}: ${symbol}/USDG ${p.key.fee / 10000}% 没有未领手续费，跳过`); continue }
      g.usdg += u; g.tokens += t; g.positions.push(p)
      g.pools.set(v4.poolId(p.key), [...(g.pools.get(v4.poolId(p.key)) ?? []), p])
      log(`仓位 ${p.id}: ${symbol}/USDG ${p.key.fee / 10000}% 未领手续费 ≈${fmtU(u)} USDG + ${fmtT(t)} ${symbol}`)
    }
    if (g.positions.length === 0) continue
    if (o.sell && g.tokens > 0n) {
      g.sell = seller(o.clients, token, symbol, fmtT, o.via, o.slippage)
      // 批量时某个币报不出价（比如数量太小）只跳过它的卖出，别的照常；单个币则直接停下
      g.offers = await g.sell.plan(g.tokens, multi)
      if (g.offers.length === 0) g.sell = null
    }
    totalUsdg += g.usdg
    groups.push(g)
  }
  if (groups.length === 0) die('这些仓位都没有未领手续费')
  // 所有池的领取合成 1 笔：PositionManager.multicall([modifyLiquidities(池1), modifyLiquidities(池2), …])，一次上链；只有一个池就直接调
  const pools = groups.flatMap((g) => [...g.pools.values()])
  const calls = pools.map((ps) => encodeFunctionData({ abi: posmAbi, functionName: 'modifyLiquidities', args: [v4.encodeCollectUnlockData(ps[0].key, ps.map((p) => p.id), wallet), BigInt(now() + 600)] }))
  const collectTx = { to: POSM, data: calls.length === 1 ? calls[0] : encodeFunctionData({ abi: posmAbi, functionName: 'multicall', args: [calls] }) }
  const nPos = groups.reduce((n, g) => n + g.positions.length, 0)
  const tokensText = groups.filter((g) => g.tokens > 0n).map((g) => `${g.fmtT(g.tokens)} ${g.symbol}`).join(' + ')
  const nSell = groups.filter((g) => g.sell).length
  log(`计划: 领取 ${nPos} 个仓位的手续费（${pools.length} 个池合成 1 笔交易${nSell ? `，再同时广播 ${nSell} 笔卖币` : ''}），≈${fmtU(totalUsdg)} USDG${tokensText ? ' + ' + tokensText : ''}，本金不动`)
  if (o.json) console.log('@@plan ' + JSON.stringify({
    kind: 'collect', wallet, txCount: 1, sellCount: nSell, expectUsdg: fmtU(totalUsdg), sell: !!o.sell,
    tokens: groups.map((g) => ({ token: { address: g.token, symbol: g.symbol, decimals: g.decimals }, positions: g.positions.map((p) => p.id.toString()), txCount: g.pools.size, expectUsdg: fmtU(g.usdg), expectToken: g.fmtT(g.tokens), sell: !!g.sell, offers: g.offers.map((x) => ({ via: x.via, out: fmtU(x.out), text: x.text })) })),
  }))
  if (o.dryRun) {
    log(`模拟领取 ${pools.map((ps) => ps.map((p) => p.id).join(',')).join(' + ')}（1 笔）: OK，gas ${await pub.estimateGas({ account: wallet, ...collectTx })}`)
    log('演练模式，到此为止')
    return
  }
  if (!o.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const ans = await rl.question('确认领取? (y/N) ')
    rl.close()
    if (ans.trim().toLowerCase() !== 'y') die('已取消')
  }
  const symOf = (t: Address) => (same(t, USDG) ? 'USDG' : groups.find((g) => same(g.token, t))?.symbol ?? t)
  const kit = txKit(o.clients, usd, symOf)
  await kit.sendEstimated(`领手续费 ${pools.map((ps) => ps.map((p) => p.id).join(',')).join(' + ')}`, collectTx)
  const balances = await Promise.all(groups.map((g) => balanceOf(g.token)))
  const got = groups.map((g, i) => balances[i] - g.start)
  log(`领取完成: 领到 ≈${fmtU(totalUsdg)} USDG${groups.map((g, i) => (got[i] > 0n ? ` + ${g.fmtT(got[i])} ${g.symbol}` : '')).join('')}`)
  // 卖币：每种币按实际到账数量重新报价（并行），授权按需串行补，然后所有卖币交易同时广播、落在同一个区块
  const selling = groups.map((g, i) => ({ g, amount: got[i] })).filter((x) => x.g.sell && x.amount > 0n)
  if (selling.length) {
    const prepared = []
    for (const { g, amount } of selling) { const p = await g.sell!.prepare(amount, kit); if (p) prepared.push(p) }
    const results = await kit.sendBatch(prepared)
    const failed = results.filter((r) => !r.ok)
    if (failed.length) log(`${failed.length} 笔卖币失败，对应代币留在钱包: ${failed.map((r) => r.label).join('、')}`)
  }
  log(`完成: 共收回 ${fmtU((await balanceOf(USDG)) - usdgStart)} USDG${groups.some((g) => g.tokens > 0n && !g.sell) ? '，未卖的代币留在钱包' : ''}`)
  log(`gas 合计: ${kit.stats.txCount} 笔，${trim(kit.stats.gasTotal, 18)} ETH ($${usd(kit.stats.gasTotal)})`)
}

// positions 给了就只撤这些仓位、只卖撤出来的币（同一代币可能还有别的进程在管的仓位；sellAll 则连钱包里原有的一起卖光）；否则撤该代币全部仓位、卖光钱包里的币
export type WithdrawOptions = {
  token?: Address; positions?: bigint[]; via: string; slippage: number; lpSlippage: number; keepTokens: boolean; sellAll?: boolean; yes: boolean; dryRun: boolean; clients: Clients
  json?: boolean // 计划确定后额外打印一行 "@@plan {json}" 给网页界面用
}
export async function withdraw(o: WithdrawOptions) {
  const { wallet, pub } = o.clients
  const balanceOf = (t: Address) => pub.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })
  const token: Address = o.token ?? await (async () => {
    const [k] = await pub.readContract({ address: POSM, abi: posmAbi, functionName: 'getPoolAndPositionInfo', args: [o.positions![0]] })
    if (BigInt(k.currency1) === 0n) die(`仓位 ${o.positions![0]} 不存在或已被撤销`)
    return same(k.currency0, USDG) ? k.currency1 : k.currency0
  })()
  const [{ symbol, decimals }, ethPrice, usdgStart, tokenStart, positions] = await Promise.all([tokenMeta(pub, token), ethPriceUsd(pub), balanceOf(USDG), balanceOf(token), findPositions(o.clients, token, o.positions)])
  const usd = (wei: bigint) => (Number(formatEther(wei)) * ethPrice).toFixed(2)
  const fmtU = (x: bigint) => trim(x, 6), fmtT = (x: bigint) => trim(x, decimals)
  const symOf = (t: Address) => (same(t, USDG) ? 'USDG' : symbol)
  log(`钱包 ${wallet} | ${fmtU(usdgStart)} USDG, ${fmtT(tokenStart)} ${symbol} | ETH $${ethPrice.toFixed(2)}`)
  if (positions.length === 0) die(o.positions ? `仓位 ${o.positions.join(',')} 不在钱包名下或已没有流动性` : `钱包名下没有 ${symbol}/USDG 的有效仓位`)
  const sellHeld = o.positions && !o.sellAll ? 0n : tokenStart // 钱包里原有的币要不要一起卖

  // ---- 计划 ----
  let expectUsdg = 0n, expectToken = 0n
  const groups = new Map<Hex, Position[]>() // 同一个池的仓位合并成一笔交易
  for (const p of positions) {
    const [u, t] = same(p.key.currency1, token) ? [p.amount0, p.amount1] : [p.amount1, p.amount0]
    expectUsdg += u; expectToken += t
    groups.set(v4.poolId(p.key), [...(groups.get(v4.poolId(p.key)) ?? []), p])
    log(`仓位 ${p.id}: ${symbol}/USDG ${p.key.fee / 10000}% ticks [${p.tickLower}, ${p.tickUpper}]，≈${fmtU(u)} USDG + ${fmtT(t)} ${symbol}`)
  }
  const sellAmount = sellHeld + expectToken
  log(`计划: 撤 ${positions.length} 个仓位（${groups.size} 笔交易），拿回 ≈${fmtU(expectUsdg)} USDG + ${fmtT(expectToken)} ${symbol}`)

  // 卖币报价：Uniswap 和 OKX 同时报价，能换回更多 USDG 的排前面
  const s = seller(o.clients, token, symbol, fmtT, o.via, o.slippage)
  const sellOffers: SwapOffer[] = !o.keepTokens && sellAmount > 0n ? await s.plan(sellAmount) : []
  if (o.json) console.log('@@plan ' + JSON.stringify({
    kind: 'exit', wallet, token: { address: token, symbol, decimals }, usdg: fmtU(usdgStart), held: fmtT(tokenStart), ethPrice: ethPrice.toFixed(2),
    positions: positions.map((p) => { const [u, t] = same(p.key.currency1, token) ? [p.amount0, p.amount1] : [p.amount1, p.amount0]; return { id: p.id.toString(), fee: p.key.fee / 10000, tickLower: p.tickLower, tickUpper: p.tickUpper, usdg: fmtU(u), token: fmtT(t), kind: p.kind } }),
    txCount: groups.size, expectUsdg: fmtU(expectUsdg), expectToken: fmtT(expectToken), sellAmount: fmtT(sellAmount), keepTokens: o.keepTokens,
    offers: sellOffers.map((x) => ({ via: x.via, out: fmtU(x.out), text: x.text })), lpSlippage: o.lpSlippage,
  }))
  // 撤仓交易：BURN_POSITION ×n + TAKE_PAIR，最少拿回量 = 预估 × (1 - LP_SLIPPAGE)
  const floor = (x: bigint) => (x * BigInt(Math.round((100 - o.lpSlippage) * 100))) / 10_000n
  const burnTx = (ps: Position[]) => ({
    to: POSM,
    data: encodeFunctionData({ abi: posmAbi, functionName: 'modifyLiquidities', args: [v4.encodeBurnUnlockData(ps[0].key, ps.map((p) => ({ id: p.id, amount0Min: floor(p.amount0), amount1Min: floor(p.amount1) })), wallet), BigInt(now() + 600)] }),
  })
  if (o.dryRun) {
    for (const [, ps] of groups) log(`模拟撤仓 ${ps.map((p) => p.id).join(',')}: OK，gas ${await pub.estimateGas({ account: wallet, ...burnTx(ps) })}`)
    log('演练模式，到此为止')
    return { usdgGained: 0n, tokenLeft: tokenStart }
  }
  if (!o.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const ans = await rl.question('确认撤退? (y/N) ')
    rl.close()
    if (ans.trim().toLowerCase() !== 'y') die('已取消')
  }

  // ---- 1) 撤仓位 ----
  // 最少拿回量按池价算，等确认的这段时间价格可能已经变了：发送前按最新池价重算；上链时仍回滚（MinimumAmountInsufficient）就再重读重试
  const refresh = async (ps: Position[]) => {
    const [sqrtP, tick] = await pub.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [v4.poolId(ps[0].key)] })
    return ps.map((p) => { const [amount0, amount1] = v4.amountsForLiquidity(sqrtP, v4.getSqrtRatioAtTick(p.tickLower), v4.getSqrtRatioAtTick(p.tickUpper), p.liquidity); return { ...p, tick, amount0, amount1 } })
  }
  const kit = txKit(o.clients, usd, symOf)
  for (const [, ps0] of groups) {
    let ps = await refresh(ps0)
    const label = `撤仓位 ${ps.map((p) => p.id).join(',')}`
    for (let attempt = 1; ; attempt++) {
      try { await kit.sendEstimated(label, burnTx(ps)); break } catch (e) {
        const r = slippageRevert(e)
        if (r?.kind !== 'min' || attempt >= 5) throw e
        const hit = ps.find((p) => floor(p.amount0) === r.limit || floor(p.amount1) === r.limit)
        const cur = hit && floor(hit.amount1) === r.limit ? hit.key.currency1 : ps[0].key.currency0
        const f = (x: bigint) => trim(x, same(cur, USDG) ? 6 : decimals)
        log(`${label} 回滚: 池价变动，能拿回 ${f(r.actual)} ${symOf(cur)} 低于最少 ${f(r.limit)}，等 3 秒按新池价重算（第 ${attempt} 次）`)
        await sleep(3000)
        ps = await refresh(ps)
      }
    }
  }
  const [usdgAfterBurn, tokenBal] = await Promise.all([balanceOf(USDG), balanceOf(token)])
  log(`撤仓完成: 拿回 ${fmtU(usdgAfterBurn - usdgStart)} USDG + ${fmtT(tokenBal - tokenStart)} ${symbol}（含手续费）`)

  // ---- 2) 卖币：按实际余额重新报价，走更好的一家 ----
  const toSell = sellHeld + (tokenBal - tokenStart)
  if (!o.keepTokens && toSell > 0n) await s.sell(toSell, kit)
  const [usdgEnd, tokenEnd] = await Promise.all([balanceOf(USDG), balanceOf(token)])
  log(`完成: 共收回 ${fmtU(usdgEnd - usdgStart)} USDG${tokenEnd > 0n ? `，钱包还剩 ${fmtT(tokenEnd)} ${symbol}` : ''}`)
  log(`gas 合计: ${kit.stats.txCount} 笔，${trim(kit.stats.gasTotal, 18)} ETH ($${usd(kit.stats.gasTotal)})`)
  return { usdgGained: usdgEnd - usdgStart, tokenLeft: tokenEnd }
}

// ---- 命令行入口 ----
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values: opt } = parseArgs({
    options: {
      token: { type: 'string' },                                            // 代币地址：撤掉它的全部仓位
      position: { type: 'string' },                                         // 只撤这些仓位 id（逗号分隔，可代替 --token），只卖撤出来的币
      via: { type: 'string', default: env('EXIT_SWAP_VIA', 'best') },       // 卖币走哪家: okx | uniswap | best（两边报价取高者）
      slippage: { type: 'string', default: env('SWAP_SLIPPAGE', '5') },     // 卖币滑点 %
      'lp-slippage': { type: 'string', default: env('LP_SLIPPAGE', '5') },  // 撤仓最少拿回量的余量 %
      'keep-tokens': { type: 'boolean', default: false },                   // 只撤仓位，不卖币
      'sell-all': { type: 'boolean', default: false },                      // --position 模式下也把钱包里原有的币一起卖光
      collect: { type: 'boolean', default: false },                         // 只领手续费，本金不动（需要 --position）
      sell: { type: 'boolean', default: false },                            // --collect 时把领到的代币卖成 USDG
      yes: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      from: { type: 'string' },
      json: { type: 'boolean', default: false },                            // 给网页界面用：计划确定后打印一行 "@@plan {json}"
    },
  })
  if (!opt.token && !opt.position) die('用法: npm run exit -- --token <代币地址> [--position <仓位id,仓位id>] [--via okx|uniswap|best] [--keep-tokens] [--sell-all] [--collect [--sell]] [--yes] [--dry-run]')
  if (!['okx', 'uniswap', 'best'].includes(opt.via)) die('--via 只能是 okx / uniswap / best')
  const positions = opt.position ? opt.position.split(',').map((x) => BigInt(x.trim())) : undefined
  if (opt.collect) {
    if (!positions) die('--collect 需要 --position 指定仓位')
    await collectFees({ positions, sell: opt.sell, via: opt.via, slippage: Number(opt.slippage), yes: opt.yes, dryRun: opt['dry-run'], json: opt.json, clients: makeClients(opt.from, !opt['dry-run']) })
    await sleep(100); process.exit(0)
  }
  await withdraw({
    token: opt.token ? getAddress(opt.token) : undefined, positions, via: opt.via,
    slippage: Number(opt.slippage), lpSlippage: Number(opt['lp-slippage']), keepTokens: opt['keep-tokens'], sellAll: opt['sell-all'], yes: opt.yes, dryRun: opt['dry-run'], json: opt.json,
    clients: makeClients(opt.from, !opt['dry-run']),
  })
  await sleep(100); process.exit(0)
}
