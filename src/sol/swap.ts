// Solana 换币：Jupiter 聚合器（lite-api.jup.ag 免费、免 key；配了 JUPITER_API_KEY 走 api.jup.ag）和「要做 LP 的那个池」同时报价，产出多的排前面。
// 和 EVM 的 swapOffers 一个思路：聚合器报价虚高时池内直换兜底；探测市场价（external）只问聚合器，别拿池子自己当市场
import { VersionedTransaction } from '@solana/web3.js'
import { solanaCfg } from '../settings.ts'
import { die, log, sleep, type SolClients, type TxBundle, balanceOf } from './common.ts'
import type { SolPool } from './lp.ts'

export type SolSwapOffer = { via: 'jupiter' | 'pool'; amountIn: bigint; out: bigint; text: string; at: number; jup?: any; pool?: { pool: SolPool; xToY: boolean; minOut: bigint } }
export type SolSwapDeps = { c: SolClients; via: string; slippage: number; fmtOut: (x: bigint) => string; outSym: string; pools: SolPool[] }

const JUP = () => { const key = solanaCfg().jupiterApiKey; return { base: key ? 'https://api.jup.ag' : (process.env.JUPITER_API_URL ?? 'https://lite-api.jup.ag'), key } }
async function jupFetch(path: string, init: RequestInit = {}): Promise<any> {
  const { base, key } = JUP()
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(base + path, { ...init, headers: { accept: 'application/json', 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) })
    const j: any = await r.json().catch(() => ({}))
    if (r.ok) return j
    const transient = r.status === 429 || r.status >= 500
    if (!transient || attempt >= 4) throw new Error(`Jupiter ${path.split('?')[0]} -> HTTP ${r.status}: ${String(j.error ?? j.message ?? JSON.stringify(j)).slice(0, 200)}`)
    await sleep(1000 * attempt)
  }
}
export async function jupQuote(tokenIn: string, tokenOut: string, amount: bigint, slippage: number) {
  const q = await jupFetch(`/swap/v1/quote?inputMint=${tokenIn}&outputMint=${tokenOut}&amount=${amount}&slippageBps=${Math.round(slippage * 100)}&restrictIntermediateTokens=true`)
  if (!q.outAmount) throw new Error(`Jupiter 报不出价: ${String(q.error ?? JSON.stringify(q)).slice(0, 120)}`)
  const route = (q.routePlan ?? []).map((r: any) => `${r.swapInfo?.label ?? '?'} ${r.percent ?? ''}%`).join(' + ')
  return { quote: q, out: BigInt(q.outAmount), minOut: BigInt(q.otherAmountThreshold ?? q.outAmount), route, impact: Number(q.priceImpactPct ?? 0) }
}
export async function jupSwapTx(quote: any, user: string): Promise<TxBundle> {
  const r = await jupFetch('/swap/v1/swap', { method: 'POST', body: JSON.stringify({ quoteResponse: quote, userPublicKey: user, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, dynamicSlippage: false, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: 'high' } } }) })
  if (!r.swapTransaction) throw new Error(`Jupiter swap 没返回交易: ${JSON.stringify(r).slice(0, 160)}`)
  return { label: '换币 (Jupiter)', tx: VersionedTransaction.deserialize(Buffer.from(r.swapTransaction, 'base64')), signers: [] }
}

export function solSwapDepsFor(c: SolClients, slippage: number, via: string, fmtOut: (x: bigint) => string, outSym: string, pools: SolPool[] = []): SolSwapDeps {
  if (!['best', 'jupiter', 'pool'].includes(via)) die('SWAP_VIA / EXIT_SWAP_VIA 在 Solana 上只能是 best / jupiter / pool')
  return { c, via, slippage, fmtOut, outSym, pools }
}
export async function solSwapOffers(d: SolSwapDeps, tokenIn: string, tokenOut: string, amount: bigint, o: { external?: boolean } = {}): Promise<SolSwapOffer[]> {
  const quiet = (e: any) => (log(`报价失败: ${String(e?.message).slice(0, 120)}`), null)
  const inPool = (p: SolPool) => [p.mintX, p.mintY].includes(tokenIn) && [p.mintX, p.mintY].includes(tokenOut)
  const poolOffer = (p: SolPool) => d.c.lp.quoteSwap(p, p.mintX === tokenIn, amount).then((q): SolSwapOffer => ({ via: 'pool', amountIn: amount, out: q.out, text: `池内 ≈${d.fmtOut(q.out)} ${d.outSym} (${d.c.lp.label} 池直换)`, pool: { pool: p, xToY: p.mintX === tokenIn, minOut: (q.out * BigInt(Math.round((100 - d.slippage) * 100))) / 10_000n }, at: Date.now() })).catch(() => null)
  const poolOffers = () => Promise.all(d.pools.filter(inPool).map(poolOffer))
  const all = await Promise.all([
    (o.external || d.via !== 'pool') ? jupQuote(tokenIn, tokenOut, amount, d.slippage).then((q): SolSwapOffer => ({ via: 'jupiter', amountIn: amount, out: q.out, text: `Jupiter ≈${d.fmtOut(q.out)} ${d.outSym} (${q.route})${q.impact > 0.2 ? ` 冲击 ${(q.impact * 100).toFixed(1)}%` : ''}`, jup: q.quote, at: Date.now() })).catch(quiet) : null,
    !o.external && (d.via === 'best' || d.via === 'pool') ? poolOffers() : [],
  ])
  let ok = all.flat().filter((x): x is SolSwapOffer => !!x)
  if (!ok.length && o.external) ok = (await poolOffers()).filter((x): x is SolSwapOffer => !!x)
  return ok.sort((a, b) => (a.out > b.out ? -1 : 1))
}
// 报价 -> 可发送的交易（Jupiter 报价超过 20 秒就重新报一次）
export async function solPrepareSwap(o: SolSwapOffer, d: SolSwapDeps, tokenIn: string, tokenOut: string): Promise<TxBundle> {
  if (o.via === 'pool') return d.c.lp.swapTx(o.pool!.pool, o.pool!.xToY, o.amountIn, o.pool!.minOut)
  let q = o.jup
  if (Date.now() - o.at > 20_000) q = (await jupQuote(tokenIn, tokenOut, o.amountIn, d.slippage)).quote
  return jupSwapTx(q, d.c.wallet.toBase58())
}
// 执行一个报价，返回收到的 tokenOut 数量
export async function solExecuteSwap(o: SolSwapOffer, d: SolSwapDeps, kit: { send(b: TxBundle): Promise<unknown> }, tokenIn: string, tokenOut: string, label: string) {
  const before = await balanceOf(d.c.conn, d.c.wallet, tokenOut)
  const b = await solPrepareSwap(o, d, tokenIn, tokenOut)
  await kit.send({ ...b, label: `${label} (${o.via === 'jupiter' ? 'Jupiter' : '池内'})` })
  const got = (await balanceOf(d.c.conn, d.c.wallet, tokenOut)) - before
  if (got <= 0n) die(`${label}交易成功但没有收到代币?`)
  return got
}
