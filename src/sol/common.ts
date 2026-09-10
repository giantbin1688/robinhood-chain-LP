// Solana 公共部分：链配置、节点连接（Alchemy 优先，getProgramAccounts 走公共节点）、钱包、发交易 / 模拟、代币元数据与余额、SOL 美元价。
// EVM 那套（common.ts）是 viem 的地址 / 合约调用，这里全是 @solana/web3.js 的 PublicKey / 账户，没法共用；命令行入口和网页服务按 --chain solana 分派到 sol/ 下的实现
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, VersionedTransaction, type Signer } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getTokenMetadata, unpackMint } from '@solana/spl-token'
import bs58 from 'bs58'
import type { BorshCoder } from '@coral-xyz/anchor'
import { rpcUrl as settingsRpcUrl, solanaCfg } from '../settings.ts'
import { die, env, failFast, log, sleep, trim } from '../common.ts'
import { makeSolLp, type SolLp, type SolPool } from './lp.ts'

if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) setGlobalDispatcher(new EnvHttpProxyAgent())

export type SolProtocol = 'dlmm' | 'clmm'
export type QuoteName = 'SOL' | 'USDC'
export type SolToken = { mint: string; symbol: string; decimals: number }
export const WSOL = 'So11111111111111111111111111111111111111112'
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const QUOTES: Record<QuoteName, SolToken> = { SOL: { mint: WSOL, symbol: 'SOL', decimals: 9 }, USDC: { mint: USDC, symbol: 'USDC', decimals: 6 } }
export const SOL_CHAIN = {
  name: 'solana' as const, label: 'Solana', native: { symbol: 'SOL', decimals: 9 },
  publicRpc: 'https://api.mainnet-beta.solana.com', rpcEnv: 'SOL_RPC_URL',
  explorer: 'https://solscan.io', gecko: 'solana', okxChainIndex: 501,
  protocols: ['dlmm', 'clmm'] as SolProtocol[],
  solUsdPool: '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6', // Meteora DLMM SOL/USDC（binStep 4）：SOL 的美元价从它的活跃 bin 读
}
export const PROTOCOL_LABEL: Record<SolProtocol, string> = { dlmm: 'Meteora DLMM', clmm: 'Raydium CLMM' }
export const isSolAddress = (s: string) => { try { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && !!new PublicKey(s) } catch { return false } }
export const same = (a: string, b: string) => a === b
export const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`
export const quoteOf = (mint: string): SolToken | null => (mint === WSOL ? QUOTES.SOL : mint === USDC ? QUOTES.USDC : null)
// 池子里哪一边是计价币（SOL / USDC）：两边都是就按 USDC 计价（SOL/USDC 池 SOL 是"代币"）
export const quoteSide = (p: SolPool): { quote: SolToken; tokenIsX: boolean } | null => {
  const qx = quoteOf(p.mintX), qy = quoteOf(p.mintY)
  if (qy && !(qx && qx.symbol === 'USDC' && qy.symbol === 'SOL')) return { quote: qy, tokenIsX: true }
  if (qx) return { quote: qx, tokenIsX: false }
  return null
}

// ---- 节点：自己的（Alchemy）优先；getProgramAccounts 免费档直接 429（每次都超它的每秒算力额度），固定走公共节点；其它方法 429 / 5xx 也退到公共节点重试一次 ----
function routedFetch(primary: string, fallback: string, quiet: boolean) {
  let warned = false
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? init.body : ''
    const heavy = /"method":"getProgramAccounts"/.test(body)
    const target = String(url) === primary && heavy ? fallback : String(url)
    let r = await fetch(target, init)
    for (let i = 0; target === primary && (r.status === 429 || r.status >= 500) && i < 3; i++) { // 自己的节点限流：等一下再试，越等越久
      await sleep(400 * (i + 1))
      r = await fetch(primary, init)
    }
    if (target === primary && (r.status === 429 || r.status >= 500)) {
      if (!warned && !quiet) { warned = true; log(`节点 ${r.status}，这次请求改走公共节点`) }
      r = await fetch(fallback, init)
    }
    return r
  }
}
export function makeConnection(rpc: string, quiet = false) {
  const own = rpc !== SOL_CHAIN.publicRpc
  return new Connection(rpc, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: own ? (routedFetch(rpc, SOL_CHAIN.publicRpc, quiet) as any) : undefined })
}

// ---- 钱包：SOL_PRIVATE_KEY 支持 base58（Phantom 导出）或 JSON 字节数组（solana-keygen）----
function loadKeypair(): Keypair | undefined {
  const k = process.env.SOL_PRIVATE_KEY?.trim()
  if (!k) return undefined
  try {
    const bytes = k.startsWith('[') ? Uint8Array.from(JSON.parse(k)) : bs58.decode(k)
    return Keypair.fromSecretKey(bytes)
  } catch { die('SOL_PRIVATE_KEY 格式不对：要 base58 私钥（Phantom 导出）或 JSON 字节数组') }
}

export type SolClientsOptions = { from?: string; needKey?: boolean; protocol?: SolProtocol; quiet?: boolean }
export async function makeSolClients(o: SolClientsOptions = {}) {
  const needKey = o.needKey ?? true
  const keypair = loadKeypair()
  const wallet = keypair?.publicKey ?? (o.from && isSolAddress(o.from) ? new PublicKey(o.from) : die('请在 .env 里设置 SOL_PRIVATE_KEY（或 --dry-run 配合 --from <钱包地址>）'))
  if (!keypair && needKey) die('非 --dry-run 模式必须提供 SOL_PRIVATE_KEY')
  const rpc = settingsRpcUrl('solana', SOL_CHAIN.rpcEnv) || SOL_CHAIN.publicRpc // 设置页优先，其次 .env
  const own = rpc !== SOL_CHAIN.publicRpc
  const conn = makeConnection(rpc, o.quiet)
  const protocol = (o.protocol ?? ((process.env.PROTOCOL ?? '').toLowerCase() as SolProtocol)) || SOL_CHAIN.protocols[0]
  if (!SOL_CHAIN.protocols.includes(protocol)) die(`Solana 上 --protocol / PROTOCOL 只能是 ${SOL_CHAIN.protocols.join(' / ')}，当前 "${protocol}"`)
  const cfg = SOL_CHAIN
  const base = { conn, wallet, keypair, cfg, protocol, rpcIsOwn: own, log }
  const lp = await makeSolLp(protocol, base)
  return { ...base, lp }
}
export type SolClients = Awaited<ReturnType<typeof makeSolClients>>

// ---- 代币元数据：精度从 mint 账户读；符号先看 Metaplex 元数据账户，再看 Token-2022 的元数据扩展，再问 Jupiter，都没有就用地址缩写 ----
const METADATA_PROGRAM = new PublicKey('metaqbxxUo1ZfKhBDrE2r6hKvVUSGtYBqPZaXsX1GcT')
const metaCache = new Map<string, Promise<{ symbol: string; name: string; decimals: number; program: PublicKey }>>()
export function tokenMeta(conn: Connection, mint: string) {
  if (mint === WSOL) return Promise.resolve({ symbol: 'SOL', name: 'Solana', decimals: 9, program: TOKEN_PROGRAM_ID })
  if (!metaCache.has(mint)) {
    const p = (async () => {
      const pk = new PublicKey(mint)
      const [pda] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), pk.toBuffer()], METADATA_PROGRAM)
      const [mintAcc, metaAcc] = await conn.getMultipleAccountsInfo([pk, pda])
      if (!mintAcc) throw new Error(`代币 ${mint} 不存在（mint 账户读不到）`)
      const program = mintAcc.owner
      if (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID)) throw new Error(`${mint} 不是 SPL 代币`)
      const decimals = unpackMint(pk, mintAcc, program).decimals
      let symbol = '', name = ''
      if (metaAcc) { // Metaplex Metadata：key(1) updateAuthority(32) mint(32) name(u32+bytes) symbol(u32+bytes)，字符串用 \0 补齐
        const d = metaAcc.data
        let o = 65
        const str = () => { const n = d.readUInt32LE(o); const s = d.subarray(o + 4, o + 4 + n).toString('utf8').replace(/\0+$/, '').trim(); o += 4 + n; return s }
        try { name = str(); symbol = str() } catch { /* 元数据账户损坏就当没有 */ }
      }
      if (!symbol && program.equals(TOKEN_2022_PROGRAM_ID)) { const m = await getTokenMetadata(conn, pk, 'confirmed', program).catch(() => null); if (m) { symbol = m.symbol; name = m.name } }
      if (!symbol) {
        const j: any = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => null)
        const hit = Array.isArray(j) ? j.find((t: any) => t.id === mint) : null
        if (hit) { symbol = hit.symbol ?? ''; name = hit.name ?? '' }
      }
      return { symbol: symbol || short(mint), name: name || symbol || short(mint), decimals, program }
    })()
    p.catch(() => metaCache.delete(mint))
    metaCache.set(mint, p)
  }
  return metaCache.get(mint)!
}
// 余额（基础单位）：SOL 用原生余额（SDK / Jupiter 都自动包装）；其它代币把该 mint 的所有代币账户加起来
export async function balanceOf(conn: Connection, owner: PublicKey, mint: string): Promise<bigint> {
  if (mint === WSOL) return BigInt(await conn.getBalance(owner))
  const r = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) })
  return r.value.reduce((s, a) => s + BigInt(a.account.data.parsed?.info?.tokenAmount?.amount ?? 0), 0n)
}
export const lamportsToSol = (x: bigint) => trim(x, 9)

// ---- SOL 美元价：读 DLMM SOL/USDC 池的活跃 bin；读不到退到 Jupiter 价格接口 ----
let solUsdCache: { at: number; v: number } | null = null
export async function solUsd(conn: Connection): Promise<number> {
  if (solUsdCache && Date.now() - solUsdCache.at < 30_000) return solUsdCache.v
  let v = 0
  try {
    const sdk: any = await import('@meteora-ag/dlmm')
    const d = await sdk.default.create(conn, new PublicKey(SOL_CHAIN.solUsdPool))
    v = Number((await d.getActiveBin()).pricePerToken)
  } catch { /* 下面用 Jupiter */ }
  if (!(v > 0)) {
    const j: any = await fetch(`https://lite-api.jup.ag/price/v3?ids=${WSOL}`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).catch(() => null)
    v = Number(j?.[WSOL]?.usdPrice ?? 0)
  }
  if (!(v > 0)) throw new Error('读不到 SOL 价格')
  solUsdCache = { at: Date.now(), v }
  return v
}
// 计价币 -> 美元：USDC 是 1，SOL 按现价
export const quoteUsd = async (conn: Connection, q: SolToken) => (q.symbol === 'USDC' ? 1 : solUsd(conn))

// ---- 发交易：优先费、模拟、确认。每笔一行日志（和 EVM 的 send 同样的格式，网页按这行解析交易表）----
export type TxBundle = { label: string; tx: Transaction | VersionedTransaction; signers: Signer[] }
export function solTxKit(c: SolClients, usd: (lamports: bigint) => string) {
  const { conn, keypair, wallet, cfg } = c
  const priority = Number(solanaCfg().priorityFee || '100000') // 每计算单元的微 lamport（设置页 / SOL_PRIORITY_FEE）；30 万 CU ≈ 0.00003 SOL
  const stats = { txCount: 0, feeTotal: 0n }
  async function prepare(b: TxBundle) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
    if (b.tx instanceof Transaction) {
      b.tx.feePayer = wallet; b.tx.recentBlockhash = blockhash
      const budget = b.tx.instructions.filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId)).map((ix) => ix.data[0])
      if (priority > 0 && !budget.includes(3)) b.tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }))
      if (!budget.includes(2)) b.tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })) // Raydium 的 SDK 不带；默认 200k 不够开仓 / 撤仓
    }
    return { blockhash, lastValidBlockHeight }
  }
  // 只模拟（演练用）：不签名也能模拟
  async function simulate(b: TxBundle) {
    await prepare(b)
    const r = b.tx instanceof Transaction
      ? await conn.simulateTransaction(b.tx)
      : await conn.simulateTransaction(b.tx, { sigVerify: false, replaceRecentBlockhash: true })
    if (r.value.err) throw Object.assign(new Error(`${b.label} 模拟失败: ${JSON.stringify(r.value.err)} ${(r.value.logs ?? []).filter((l) => /Error|failed|Program log:/.test(l)).slice(-4).join(' | ').slice(0, 300)}`), { logs: r.value.logs })
    return r.value.unitsConsumed ?? 0
  }
  async function send(b: TxBundle) {
    const { blockhash, lastValidBlockHeight } = await prepare(b)
    if (b.tx instanceof Transaction) b.tx.sign(keypair!, ...b.signers)
    else b.tx.sign([keypair!, ...b.signers])
    const raw = b.tx.serialize()
    const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 })
    process.stdout.write(`${new Date().toTimeString().slice(0, 8)} ${b.label} ${sig} ...`)
    const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
    let fee = 0n, cu = 0
    const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null)
    if (t?.meta) { fee = BigInt(t.meta.fee); cu = t.meta.computeUnitsConsumed ?? 0 }
    stats.txCount++; stats.feeTotal += fee
    const failed = !!conf.value.err || !!t?.meta?.err
    process.stdout.write(failed ? ' 失败(revert)\n' : ` 成功，${cu} CU $${usd(fee)}\n`)
    if (failed) throw Object.assign(new Error(`${b.label} 交易失败`), { shortMessage: `${b.label} 交易失败: ${cfg.explorer}/tx/${sig}`, onchain: true })
    return { sig, tx: t }
  }
  // 顺序发送一串交易（Solana 一笔装不下的操作拆成几笔，前一笔确认了再发下一笔）
  async function sendAll(bs: TxBundle[]) { const out = []; for (const b of bs) out.push(await send(b)); return out }
  return { simulate, send, sendAll, stats }
}

// ---- 本地仓位记录：和 EVM 共用 positions.json，chain='solana'、protocol=dlmm/clmm，id 是仓位账户 / NFT mint 地址 ----
export type SolPositionRecord = { id: string; token: string; symbol: string; poolId: string; kind: 'lp' | 'bridge'; at: string; shape?: string; group?: string; chain: 'solana'; protocol: SolProtocol; quote?: QuoteName }
const POSITIONS_FILE = 'positions.json'
const loadAll = (): any[] => (existsSync(POSITIONS_FILE) ? JSON.parse(readFileSync(POSITIONS_FILE, 'utf8')) : [])
export const solPositionsOf = (protocol: SolProtocol): SolPositionRecord[] => loadAll().filter((p) => p.chain === 'solana' && p.protocol === protocol)
export function saveSolPosition(p: SolPositionRecord) { writeFileSync(POSITIONS_FILE, JSON.stringify([...loadAll(), p], null, 2) + '\n') }

// ---- Anchor 事件：两种发法都认。emit!（Raydium）写在日志 "Program data: <base64>"；emit_cpi!（Meteora DLMM）是程序对自己发一笔内层 CPI，
// 事件在那条内层指令的 data 里（前 8 字节固定 e445a52e51cb9a1d，之后是事件判别符 + borsh 数据），日志里没有 ----
const CPI_EVENT_TAG = Buffer.from('e445a52e51cb9a1d', 'hex')
export function anchorEvents(coder: BorshCoder, programId: PublicKey, tx: import('@solana/web3.js').ParsedTransactionWithMeta): { name: string; data: any }[] {
  const out: { name: string; data: any }[] = []
  const stack: string[] = []
  for (const l of tx.meta?.logMessages ?? []) { // 只认这个程序自己打的 Program data
    const inv = l.match(/^Program (\S+) invoke/); if (inv) { stack.push(inv[1]); continue }
    if (/^Program \S+ (success|failed)/.test(l)) { stack.pop(); continue }
    if (l.startsWith('Program data: ') && stack[stack.length - 1] === programId.toBase58()) { const ev = coder.events.decode(l.slice(14)); if (ev) out.push(ev) }
  }
  for (const grp of tx.meta?.innerInstructions ?? []) for (const ix of grp.instructions) {
    if (!('data' in ix) || !ix.programId.equals(programId)) continue
    let bytes: Buffer
    try { bytes = Buffer.from(bs58.decode(ix.data)) } catch { continue }
    if (bytes.length < 16 || !bytes.subarray(0, 8).equals(CPI_EVENT_TAG)) continue
    const ev = coder.events.decode(bytes.subarray(8).toString('base64'))
    if (ev) out.push(ev)
  }
  return out
}

export const feeText = (p: SolPool) => (p.dynamic ? `动态(基础 ${p.fee / 10000}%)` : `${p.fee / 10000}%`)
export { die, env, failFast, log, sleep, trim }
export const p6 = (n: number) => String(Number(n.toPrecision(6)))
export const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`
export const lamports = LAMPORTS_PER_SOL
