// 撤退：撤掉某个代币的全部 LP 仓位（本金 + 手续费），再把代币全部换回 USDG（OKX DEX / Uniswap 取报价更好的一个）
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { createPublicClient, encodeFunctionData, formatEther, getAddress, http, parseAbiItem, type Address, type Hex } from 'viem'
import * as v4 from './v4.ts'
import {
  POSM, PUBLIC_RPC, STATE_VIEW, USDG, chain, die, env, erc20Abi, ethPriceUsd, loadPositions, log, makeClients, now, okxDex, posmAbi,
  sleep, stateViewAbi, tokenMeta, trim, txKit, uniswapApi,
} from './common.ts'

const { values: opt } = parseArgs({
  options: {
    token: { type: 'string' },                                            // 代币地址：撤掉它的全部仓位
    position: { type: 'string' },                                         // 只撤这一个仓位 id（可代替 --token）
    via: { type: 'string', default: env('EXIT_SWAP_VIA', 'best') },       // 卖币走哪家: okx | uniswap | best（两边报价取高者）
    slippage: { type: 'string', default: env('SWAP_SLIPPAGE', '5') },     // 卖币滑点 %
    'lp-slippage': { type: 'string', default: env('LP_SLIPPAGE', '5') },  // 撤仓最少拿回量的余量 %
    'keep-tokens': { type: 'boolean', default: false },                   // 只撤仓位，不卖币
    yes: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    from: { type: 'string' },
  },
})
if (!opt.token && !opt.position) die('用法: npm run exit -- --token <代币地址> [--position <仓位id>] [--via okx|uniswap|best] [--keep-tokens] [--yes] [--dry-run]')
if (!['okx', 'uniswap', 'best'].includes(opt.via)) die('--via 只能是 okx / uniswap / best')
const swapSlippage = Number(opt.slippage), lpSlippage = Number(opt['lp-slippage'])
const dryRun = opt['dry-run']

const clients = makeClients(opt.from, !dryRun)
const { wallet, pub, wc } = clients
const balanceOf = (t: Address) => pub.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })
const posInfo = (id: bigint) => pub.readContract({ address: POSM, abi: posmAbi, functionName: 'getPoolAndPositionInfo', args: [id] })
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase() // 合约返回的是校验和大小写地址，比较时忽略大小写

// ---- 找仓位：--position 指定的 + positions.json 记录的 + 链上扫描（PositionManager 转给钱包的 NFT，走公共节点，Alchemy 免费版限制 getLogs 区间）----
const candidates = new Set<bigint>()
if (opt.position) candidates.add(BigInt(opt.position))
const token: Address = opt.token ? getAddress(opt.token) : await (async () => {
  const [k] = await posInfo(BigInt(opt.position!))
  return same(k.currency0, USDG) ? k.currency1 : k.currency0
})()
for (const p of loadPositions()) if (same(p.token, token)) candidates.add(BigInt(p.id))
if (!opt.position) {
  const scan = createPublicClient({ chain, transport: http(PUBLIC_RPC) })
  const logs = await scan.getLogs({ address: POSM, event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed id)'), args: { to: wallet }, fromBlock: 0n })
  for (const l of logs) candidates.add(l.args.id!)
}
const [{ symbol, decimals }, ethPrice, usdgStart, tokenStart] = await Promise.all([tokenMeta(pub, token), ethPriceUsd(pub), balanceOf(USDG), balanceOf(token)])
const usd = (wei: bigint) => (Number(formatEther(wei)) * ethPrice).toFixed(2)
const fmtU = (x: bigint) => trim(x, 6), fmtT = (x: bigint) => trim(x, decimals)
const symOf = (t: Address) => (same(t, USDG) ? 'USDG' : symbol)
log(`钱包 ${wallet} | ${fmtU(usdgStart)} USDG, ${fmtT(tokenStart)} ${symbol} | ETH $${ethPrice.toFixed(2)}`)

// 仍归钱包所有、属于 代币/USDG 池、且还有流动性的仓位
const owned = (await Promise.allSettled([...candidates].map(async (id) => ({ id, owner: await pub.readContract({ address: POSM, abi: posmAbi, functionName: 'ownerOf', args: [id] }) }))))
  .flatMap((r) => (r.status === 'fulfilled' && same(r.value.owner, wallet) ? [r.value.id] : []))
const found = (await Promise.all(owned.map(async (id) => {
  const [[key, info], liquidity] = await Promise.all([posInfo(id), pub.readContract({ address: POSM, abi: posmAbi, functionName: 'getPositionLiquidity', args: [id] })])
  return { id, key, liquidity, ...v4.decodePositionInfo(info) }
}))).filter((p) => p.liquidity > 0n && [p.key.currency0, p.key.currency1].some((c) => same(c, USDG)) && [p.key.currency0, p.key.currency1].some((c) => same(c, token)))
if (found.length === 0) die(`钱包名下没有 ${symbol}/USDG 的有效仓位（扫描了 ${candidates.size} 个候选）`)

// ---- 计划：每个仓位按当前池价折算能拿回多少（手续费另计）----
let expectUsdg = 0n, expectToken = 0n
const positions = await Promise.all(found.map(async (p) => {
  const [sqrtP] = await pub.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [v4.poolId(p.key)] })
  const [amount0, amount1] = v4.amountsForLiquidity(sqrtP, v4.getSqrtRatioAtTick(p.tickLower), v4.getSqrtRatioAtTick(p.tickUpper), p.liquidity)
  return { ...p, amount0, amount1 }
}))
const groups = new Map<Hex, typeof positions>() // 同一个池的仓位合并成一笔交易
for (const p of positions) {
  const [u, t] = same(p.key.currency1, token) ? [p.amount0, p.amount1] : [p.amount1, p.amount0]
  expectUsdg += u; expectToken += t
  groups.set(v4.poolId(p.key), [...(groups.get(v4.poolId(p.key)) ?? []), p])
  log(`仓位 ${p.id}: ${symbol}/USDG ${p.key.fee / 10000}% ticks [${p.tickLower}, ${p.tickUpper}]，≈${fmtU(u)} USDG + ${fmtT(t)} ${symbol}`)
}
const sellAmount = tokenStart + expectToken
log(`计划: 撤 ${positions.length} 个仓位（${groups.size} 笔交易），拿回 ≈${fmtU(expectUsdg)} USDG + ${fmtT(expectToken)} ${symbol}`)

// ---- 卖币报价：Uniswap 和 OKX 各报一次，取高者 ----
const uni = uniswapApi(wallet, swapSlippage)
const okx = okxDex(wallet, swapSlippage)
if (opt.via === 'okx' && !okx) die('--via okx 需要在 .env 里配置 OKX_API_KEY / OKX_SECRET_KEY / OKX_API_PASSPHRASE')
type Offer = { via: 'okx' | 'uniswap'; out: bigint; text: string; okx?: NonNullable<Awaited<ReturnType<NonNullable<typeof okx>['swap']>>>; uni?: Awaited<ReturnType<typeof uni.quote>> }
// 两边同时报价，按能换回的 USDG 排序，最好的排前面
async function offers(amount: bigint): Promise<Offer[]> {
  const all = await Promise.all([
    opt.via !== 'okx' ? uni.quote(token, USDG, 'EXACT_INPUT', amount).then((q): Offer => ({ via: 'uniswap', out: q.out, text: `Uniswap ≈${fmtU(q.out)} USDG`, uni: q })).catch((e) => (log(`Uniswap 报价失败: ${String(e.message).slice(0, 120)}`), null)) : null,
    opt.via !== 'uniswap' && okx ? okx.swap(token, USDG, amount).then((s): Offer => ({ via: 'okx', out: s.out, text: `OKX ≈${fmtU(s.out)} USDG (${s.route})${s.honeypot ? ' 警告: OKX 标记为貔貅币' : ''}`, okx: s })).catch((e) => (log(`OKX 报价失败: ${String(e.message).slice(0, 120)}`), null)) : null,
  ])
  return all.filter((o): o is Offer => !!o).sort((a, b) => (a.out > b.out ? -1 : 1))
}
if (!opt['keep-tokens'] && sellAmount > 0n) {
  const os = await offers(sellAmount)
  if (os.length === 0) die('拿不到卖币报价，放弃')
  log(`计划: 卖出 ≈${fmtT(sellAmount)} ${symbol}：${os.map((o) => o.text).join('；')}${os.length > 1 ? `，走 ${os[0].via}` : ''}${!okx && opt.via !== 'uniswap' ? '（未配置 OKX_API_KEY，只有 Uniswap）' : ''}`)
}
// 撤仓交易：BURN_POSITION ×n + TAKE_PAIR，最少拿回量 = 预估 × (1 - LP_SLIPPAGE)
const floor = (x: bigint) => (x * BigInt(Math.round((100 - lpSlippage) * 100))) / 10_000n
const burnTx = (ps: typeof positions) => ({
  to: POSM,
  data: encodeFunctionData({ abi: posmAbi, functionName: 'modifyLiquidities', args: [v4.encodeBurnUnlockData(ps[0].key, ps.map((p) => ({ id: p.id, amount0Min: floor(p.amount0), amount1Min: floor(p.amount1) })), wallet), BigInt(now() + 600)] }),
})
if (dryRun) {
  for (const [, ps] of groups) log(`模拟撤仓 ${ps.map((p) => p.id).join(',')}: OK，gas ${await pub.estimateGas({ account: wallet, ...burnTx(ps) })}`)
  log('演练模式，到此为止'); await sleep(100); process.exit(0)
}
if (!opt.yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ans = await rl.question('确认撤退? (y/N) ')
  rl.close()
  if (ans.trim().toLowerCase() !== 'y') die('已取消')
}

// ---- 1) 撤仓位 ----
const { sendEstimated, ensureErc20Approval, stats } = txKit(clients, usd, symOf)
for (const [, ps] of groups) await sendEstimated(`撤仓位 ${ps.map((p) => p.id).join(',')}`, burnTx(ps))
const [usdgAfterBurn, tokenBal] = await Promise.all([balanceOf(USDG), balanceOf(token)])
log(`撤仓完成: 拿回 ${fmtU(usdgAfterBurn - usdgStart)} USDG + ${fmtT(tokenBal - tokenStart)} ${symbol}（含手续费）`)

// ---- 2) 卖币：按实际余额重新报价，走更好的一家 ----
if (!opt['keep-tokens'] && tokenBal > 0n) {
  const [o] = await offers(tokenBal)
  if (!o) die('卖币报价失败，代币留在钱包里')
  log(`卖出 ${fmtT(tokenBal)} ${symbol} -> ${o.text}`)
  if (o.via === 'okx') {
    await ensureErc20Approval(token, tokenBal, await okx!.approver(), 'OKX DEX')
    await sendEstimated('卖币 (OKX)', o.okx!.tx, o.okx!.tx.gasLimit)
  } else {
    await ensureErc20Approval(token, tokenBal)
    const tx = await uni.swapTx(o.uni!, wc!)
    await sendEstimated('卖币 (Uniswap)', tx, tx.gasLimit)
  }
}
const [usdgEnd, tokenEnd] = await Promise.all([balanceOf(USDG), balanceOf(token)])
log(`完成: 共收回 ${fmtU(usdgEnd - usdgStart)} USDG${tokenEnd > 0n ? `，钱包还剩 ${fmtT(tokenEnd)} ${symbol}` : ''}`)
log(`gas 合计: ${stats.txCount} 笔，${trim(stats.gasTotal, 18)} ETH ($${usd(stats.gasTotal)})`)
