// 发现某个代币在 Solana 上已有的池：GeckoTerminal 列出（dex id：meteora = DLMM，raydium-clmm），再读链上池账户拿 binStep / tickSpacing / 费率和现价
import { feeText, log, quoteSide, tokenMeta, type SolClients } from './common.ts'
import type { SolPool } from './lp.ts'

export type SolFoundPool = { pool: SolPool; liquidityUsd: number; volume24h: number; name: string; empty: boolean | null; quote: string }
const GECKO_DEX: Record<string, string> = { dlmm: 'meteora', clmm: 'raydium-clmm' }

export async function fetchGeckoPools(token: string, strict = false): Promise<any[]> {
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${token}/pools?page=1`, { signal: AbortSignal.timeout(15_000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return (await r.json()).data ?? []
  } catch (e: any) { if (strict) throw new Error(`GeckoTerminal ${String(e?.message).slice(0, 80)}`); log(`查询已有池失败（GeckoTerminal ${String(e?.message).slice(0, 80)}），按配置的费率处理`); return [] }
}
const feeFromName = (name: string) => { const m = name.match(/([\d.]+)%/); return m ? Math.round(Number(m[1]) * 10_000) : null }

// 本协议、以 SOL / USDC 计价的池（quote 给了就只要那种计价）
export async function discoverQuotePools(c: SolClients, token: string, quote?: string): Promise<SolFoundPool[]> {
  const { lp } = c
  const out: SolFoundPool[] = []
  for (const p of await fetchGeckoPools(token)) {
    const a = p.attributes ?? {}
    if (String(p.relationships?.dex?.data?.id ?? '') !== GECKO_DEX[c.protocol]) continue
    const pool = await lp.poolById(String(a.address)).catch(() => null)
    const q = pool && quoteSide(pool)
    if (!pool || !q || (quote && q.quote.mint !== quote) || (q.tokenIsX ? pool.mintX : pool.mintY) !== token) continue
    const empty = await lp.state(pool).then((s) => !s.hasLiquidity).catch(() => null)
    const hint = feeFromName(String(a.name ?? ''))
    out.push({ pool: hint ? { ...pool, feeHint: hint } : pool, liquidityUsd: empty ? 0 : Number(a.reserve_in_usd ?? 0), volume24h: empty ? 0 : Number(a.volume_usd?.h24 ?? 0), name: a.name, empty, quote: q.quote.symbol })
  }
  return out
}

// 网页界面用：该代币的全部池子，每个标出能不能被本工具复用及原因
export type SolTokenPool = { id: string; name: string; dex: string; liquidityUsd: number; volume24h: number; fee24h: number | null; fee: number; feeText: string; spacing: number; hooks: null; usable: boolean; empty: boolean; status: string; quote: string | null
  createdAt: number | null; fdvUsd: number | null; change24h: number | null; buyers24h: number; sellers24h: number }
export async function listTokenPools(c: SolClients, token: string): Promise<SolTokenPool[]> {
  const { lp } = c
  const out: SolTokenPool[] = []
  const usd$ = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`
  for (const p of await fetchGeckoPools(token)) {
    const a = p.attributes ?? {}
    const dex = String(p.relationships?.dex?.data?.id ?? '')
    const name = String(a.name ?? ''), id = String(a.address)
    const feeN = feeFromName(name) ?? 0
    const volume24h = Number(a.volume_usd?.h24 ?? 0)
    const numOr = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
    const base: SolTokenPool = { id, name, dex, liquidityUsd: Number(a.reserve_in_usd ?? 0), volume24h, fee24h: feeN ? (volume24h * feeN) / 1_000_000 : null, fee: feeN, feeText: feeN ? `${feeN / 10000}%` : '—', spacing: 0, hooks: null, usable: false, empty: false, status: '', quote: null,
      createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) || null : null, fdvUsd: numOr(a.fdv_usd), change24h: numOr(a.price_change_percentage?.h24), buyers24h: Number(a.transactions?.h24?.buyers ?? 0), sellers24h: Number(a.transactions?.h24?.sellers ?? 0) }
    if (dex !== GECKO_DEX[c.protocol]) { out.push({ ...base, status: `不是 ${lp.label}（${dex}）` }); continue }
    let err = ''
    const pool = await lp.poolById(id).catch((e) => { err = String(e?.message).slice(0, 80); return null })
    if (err) { out.push({ ...base, status: `读链失败（${err}），刷新再试` }); continue }
    if (!pool) { out.push({ ...base, status: '读不到池账户，不复用' }); continue }
    const q = quoteSide(pool)
    if (!q || (q.tokenIsX ? pool.mintX : pool.mintY) !== token) { out.push({ ...base, status: `计价不是 SOL / USDC（${name.split('/')[1]?.trim().split(' ')[0] ?? '?'}）` }); continue }
    const row: SolTokenPool = { ...base, fee: pool.fee, fee24h: pool.fee ? (volume24h * pool.fee) / 1_000_000 : base.fee24h, feeText: feeText(pool), spacing: pool.step, usable: true, quote: q.quote.symbol }
    const empty = await lp.state(pool).then((s) => !s.hasLiquidity).catch(() => null)
    if (empty === null) out.push({ ...row, usable: false, status: '链上状态读取失败，刷新再试' })
    else if (empty) out.push({ ...row, liquidityUsd: 0, volume24h: 0, fee24h: 0, empty: true, status: `空池：现价 bin / tick 没有流动性，Gecko 的 ${usd$(base.liquidityUsd)} / 日成交 ${usd$(base.volume24h)} 是旧数据` })
    else out.push({ ...row, status: `可用（${q.quote.symbol} 计价）${base.liquidityUsd < 5000 ? '，流动性 < $5k（auto 不会自动选）' : ''}` })
  }
  return out.sort((a, b) => b.liquidityUsd - a.liquidityUsd)
}
export const symbolOf = async (c: SolClients, mint: string) => (await tokenMeta(c.conn, mint)).symbol
