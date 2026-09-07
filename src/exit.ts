// 撤退：撤掉某个代币的全部 LP 仓位（本金 + 手续费），再把代币全部换回 USDG（OKX DEX / Uniswap 取报价更好的一个）
// 既是命令行入口（npm run exit），也导出 withdraw() 给监控（monitor.ts）调用
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createPublicClient, encodeFunctionData, formatEther, getAddress, http, numberToHex, parseAbi, parseAbiItem, type Address, type Hex } from 'viem'
import * as v4 from './v4.ts'
import {
  POSM, PUBLIC_RPC, STATE_VIEW, USDG, chain, die, env, erc20Abi, ethPriceUsd, loadPositions, log, makeClients, now, okxDex, posmAbi,
  sleep, slippageRevert, stateViewAbi, tokenMeta, trim, txKit, uniswapApi, swapOffers, executeSwap, type Clients, type SwapOffer,
} from './common.ts'

export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase() // 合约返回的是校验和大小写地址，比较时忽略大小写

// 钱包名下、属于 代币/USDG 池、还有流动性的仓位：只给了 explicit 就只看这些 id；否则 positions.json 记录的 + 链上扫描
// （PositionManager 转给钱包的 NFT，扫描走公共节点，Alchemy 免费版限制 getLogs 区间）。token 不给 = 所有 USDG 池的仓位（网页界面列表用）
export async function findPositions(c: Clients, token?: Address, explicit?: bigint[]) {
  const { wallet, pub } = c
  const posInfo = (id: bigint) => pub.readContract({ address: POSM, abi: posmAbi, functionName: 'getPoolAndPositionInfo', args: [id] })
  const candidates = new Set<bigint>(explicit ?? [])
  const kinds = new Map<string, string>()
  for (const p of loadPositions()) if (!token || same(p.token, token)) { if (!explicit) candidates.add(BigInt(p.id)); kinds.set(p.id, p.kind) }
  if (!explicit) {
    const scan = createPublicClient({ chain, transport: http(PUBLIC_RPC) })
    const logs = await scan.getLogs({ address: POSM, event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed id)'), args: { to: wallet }, fromBlock: 0n })
    for (const l of logs) candidates.add(l.args.id!)
  }
  const owned = (await Promise.allSettled([...candidates].map(async (id) => ({ id, owner: await pub.readContract({ address: POSM, abi: posmAbi, functionName: 'ownerOf', args: [id] }) }))))
    .flatMap((r) => (r.status === 'fulfilled' && same(r.value.owner, wallet) ? [r.value.id] : []))
  const found = (await Promise.all(owned.map(async (id) => {
    const [[key, info], liquidity] = await Promise.all([posInfo(id), pub.readContract({ address: POSM, abi: posmAbi, functionName: 'getPositionLiquidity', args: [id] })])
    return { id, key, liquidity, kind: kinds.get(id.toString()) ?? 'lp', ...v4.decodePositionInfo(info) }
  }))).filter((p) => p.liquidity > 0n && [p.key.currency0, p.key.currency1].some((x) => same(x, USDG)) && (!token || [p.key.currency0, p.key.currency1].some((x) => same(x, token))))
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

// 只领手续费，不动本金：同一个池的仓位合并成一笔 DECREASE_LIQUIDITY(0) ×n + TAKE_PAIR
export type CollectOptions = { positions: bigint[]; yes: boolean; dryRun: boolean; clients: Clients; json?: boolean }
export async function collectFees(o: CollectOptions) {
  const { wallet, pub } = o.clients
  const balanceOf = (t: Address) => pub.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })
  const [k] = await pub.readContract({ address: POSM, abi: posmAbi, functionName: 'getPoolAndPositionInfo', args: [o.positions[0]] })
  if (BigInt(k.currency1) === 0n) die(`仓位 ${o.positions[0]} 不存在或已被撤销`)
  const token: Address = same(k.currency0, USDG) ? k.currency1 : k.currency0
  const [{ symbol, decimals }, ethPrice, usdgStart, tokenStart, positions] = await Promise.all([tokenMeta(pub, token), ethPriceUsd(pub), balanceOf(USDG), balanceOf(token), findPositions(o.clients, token, o.positions)])
  if (positions.length === 0) die(`仓位 ${o.positions.join(',')} 不在钱包名下或已没有流动性`)
  const usd = (wei: bigint) => (Number(formatEther(wei)) * ethPrice).toFixed(2)
  const fmtU = (x: bigint) => trim(x, 6), fmtT = (x: bigint) => trim(x, decimals)
  const symOf = (t: Address) => (same(t, USDG) ? 'USDG' : symbol)
  let expectUsdg = 0n, expectToken = 0n
  const groups = new Map<Hex, Position[]>()
  for (const p of positions) {
    const [f0, f1] = await positionFees(pub, p)
    const [u, t] = same(p.key.currency1, token) ? [f0, f1] : [f1, f0]
    expectUsdg += u; expectToken += t
    groups.set(v4.poolId(p.key), [...(groups.get(v4.poolId(p.key)) ?? []), p])
    log(`仓位 ${p.id}: ${symbol}/USDG ${p.key.fee / 10000}% 未领手续费 ≈${fmtU(u)} USDG + ${fmtT(t)} ${symbol}`)
  }
  log(`计划: 领取 ${positions.length} 个仓位的手续费（${groups.size} 笔交易），≈${fmtU(expectUsdg)} USDG + ${fmtT(expectToken)} ${symbol}，本金不动`)
  if (o.json) console.log('@@plan ' + JSON.stringify({ kind: 'collect', wallet, token: { address: token, symbol, decimals }, positions: positions.map((p) => p.id.toString()), txCount: groups.size, expectUsdg: fmtU(expectUsdg), expectToken: fmtT(expectToken) }))
  const tx = (ps: Position[]) => ({ to: POSM, data: encodeFunctionData({ abi: posmAbi, functionName: 'modifyLiquidities', args: [v4.encodeCollectUnlockData(ps[0].key, ps.map((p) => p.id), wallet), BigInt(now() + 600)] }) })
  if (o.dryRun) {
    for (const [, ps] of groups) log(`模拟领取 ${ps.map((p) => p.id).join(',')}: OK，gas ${await pub.estimateGas({ account: wallet, ...tx(ps) })}`)
    log('演练模式，到此为止')
    return
  }
  if (!o.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const ans = await rl.question('确认领取? (y/N) ')
    rl.close()
    if (ans.trim().toLowerCase() !== 'y') die('已取消')
  }
  const kit = txKit(o.clients, usd, symOf)
  for (const [, ps] of groups) await kit.sendEstimated(`领手续费 ${ps.map((p) => p.id).join(',')}`, tx(ps))
  const [usdgEnd, tokenEnd] = await Promise.all([balanceOf(USDG), balanceOf(token)])
  log(`完成: 领到 ${fmtU(usdgEnd - usdgStart)} USDG + ${fmtT(tokenEnd - tokenStart)} ${symbol}`)
  log(`gas 合计: ${kit.stats.txCount} 笔，${trim(kit.stats.gasTotal, 18)} ETH ($${usd(kit.stats.gasTotal)})`)
}

// positions 给了就只撤这些仓位、只卖撤出来的币（同一代币可能还有别的进程在管的仓位）；否则撤该代币全部仓位、卖光钱包里的币
export type WithdrawOptions = {
  token?: Address; positions?: bigint[]; via: string; slippage: number; lpSlippage: number; keepTokens: boolean; yes: boolean; dryRun: boolean; clients: Clients
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
  const sellHeld = o.positions ? 0n : tokenStart // 钱包里原有的币要不要一起卖

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
  const deps = { uni: uniswapApi(wallet, o.slippage), okx: okxDex(wallet, o.slippage), via: o.via, fmtOut: fmtU, outSym: 'USDG' }
  if (o.via === 'okx' && !deps.okx) die('--via okx 需要在 .env 里配置 OKX_API_KEY / OKX_SECRET_KEY / OKX_API_PASSPHRASE')
  const offers = (amount: bigint) => swapOffers(deps, token, USDG, 'EXACT_INPUT', amount)
  let sellOffers: SwapOffer[] = []
  if (!o.keepTokens && sellAmount > 0n) {
    sellOffers = await offers(sellAmount)
    if (sellOffers.length === 0) die('拿不到卖币报价，放弃')
    log(`计划: 卖出 ≈${fmtT(sellAmount)} ${symbol}：${sellOffers.map((x) => x.text).join('；')}${sellOffers.length > 1 ? `，走 ${sellOffers[0].via}` : ''}${!deps.okx && o.via !== 'uniswap' ? '（未配置 OKX_API_KEY，只有 Uniswap）' : ''}`)
  }
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
  if (!o.keepTokens && toSell > 0n) {
    const [best] = await offers(toSell)
    if (!best) die('卖币报价失败，代币留在钱包里')
    log(`卖出 ${fmtT(toSell)} ${symbol} -> ${best.text}`)
    await executeSwap(best, deps, kit, o.clients, token, USDG, '卖币')
  }
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
      collect: { type: 'boolean', default: false },                         // 只领手续费，本金不动（需要 --position）
      yes: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      from: { type: 'string' },
      json: { type: 'boolean', default: false },                            // 给网页界面用：计划确定后打印一行 "@@plan {json}"
    },
  })
  if (!opt.token && !opt.position) die('用法: npm run exit -- --token <代币地址> [--position <仓位id,仓位id>] [--via okx|uniswap|best] [--keep-tokens] [--collect] [--yes] [--dry-run]')
  if (!['okx', 'uniswap', 'best'].includes(opt.via)) die('--via 只能是 okx / uniswap / best')
  const positions = opt.position ? opt.position.split(',').map((x) => BigInt(x.trim())) : undefined
  if (opt.collect) {
    if (!positions) die('--collect 需要 --position 指定仓位')
    await collectFees({ positions, yes: opt.yes, dryRun: opt['dry-run'], json: opt.json, clients: makeClients(opt.from, !opt['dry-run']) })
    await sleep(100); process.exit(0)
  }
  await withdraw({
    token: opt.token ? getAddress(opt.token) : undefined, positions, via: opt.via,
    slippage: Number(opt.slippage), lpSlippage: Number(opt['lp-slippage']), keepTokens: opt['keep-tokens'], yes: opt.yes, dryRun: opt['dry-run'], json: opt.json,
    clients: makeClients(opt.from, !opt['dry-run']),
  })
  await sleep(100); process.exit(0)
}
