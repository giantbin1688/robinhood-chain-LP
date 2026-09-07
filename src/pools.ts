// 发现某个代币已有的 USDG v4 池：GeckoTerminal 列出池子（名字里带费率），再用 pool id 反推出精确的 (fee, tickSpacing)
import type { Address } from 'viem'
import * as v4 from './v4.ts'
import { USDG, log } from './common.ts'

export type FoundPool = { id: `0x${string}`; fee: number; spacing: number; liquidityUsd: number; volume24h: number; name: string }

// GeckoTerminal 上这个代币的全部池子（任何 DEX、任何计价币），失败返回 []
async function fetchGeckoPools(token: Address): Promise<any[]> {
  try {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${token}/pools?page=1`, { signal: AbortSignal.timeout(15_000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return (await r.json()).data ?? []
  } catch (e: any) { log(`查询已有池失败（GeckoTerminal ${String(e?.message).slice(0, 80)}），按配置的费率处理`); return [] }
}

export async function discoverUsdgPools(token: Address): Promise<FoundPool[]> {
  const out: FoundPool[] = []
  for (const p of await fetchGeckoPools(token)) {
    const a = p.attributes ?? {}
    if (!String(p.relationships?.dex?.data?.id ?? '').includes('uniswap-v4') || !/USDG/.test(a.name ?? '')) continue
    const m = String(a.name).match(/([\d.]+)%/)
    if (!m) continue
    const found = decodeKey(token, String(a.address).toLowerCase() as `0x${string}`, m[1])
    if (!found) continue // 反推不出来：多半带 hook，不碰
    out.push({ id: found.id, fee: found.fee, spacing: found.spacing, liquidityUsd: Number(a.reserve_in_usd ?? 0), volume24h: Number(a.volume_usd?.h24 ?? 0), name: a.name })
  }
  return out
}

// 网页界面用：该代币的全部池子，每个标出能不能被本工具复用及原因
export type TokenPool = FoundPool & { dex: string; usable: boolean; status: string; fee: number; spacing: number }
export async function listTokenPools(token: Address): Promise<TokenPool[]> {
  const out: TokenPool[] = []
  for (const p of await fetchGeckoPools(token)) {
    const a = p.attributes ?? {}
    const dex = String(p.relationships?.dex?.data?.id ?? '').replace(/-robinhood$/, '')
    const name = String(a.name ?? ''), id = String(a.address).toLowerCase() as `0x${string}`
    const base = { id, name, dex, liquidityUsd: Number(a.reserve_in_usd ?? 0), volume24h: Number(a.volume_usd?.h24 ?? 0), fee: 0, spacing: 0, usable: false }
    const m = name.match(/([\d.]+)%/)
    if (!dex.includes('uniswap-v4')) out.push({ ...base, fee: m ? Number(m[1]) * 10_000 : 0, status: `不是 v4（${dex}）` })
    else if (!/USDG/.test(name)) out.push({ ...base, fee: m ? Number(m[1]) * 10_000 : 0, status: `计价不是 USDG（${name.split('/')[1]?.trim().split(' ')[0] ?? '?'}）` })
    else if (!m) out.push({ ...base, status: '动态费率 / 带 hook，不复用' })
    else {
      const found = decodeKey(token, id, m[1])
      if (!found) out.push({ ...base, fee: Number(m[1]) * 10_000, status: '带 hook 或非标准参数，不复用' })
      else out.push({ ...base, fee: found.fee, spacing: found.spacing, usable: true, status: base.liquidityUsd < 5000 ? '可用，流动性 < $5k（auto 不会自动选）' : '可用' })
    }
  }
  return out.sort((a, b) => b.liquidityUsd - a.liquidityUsd)
}

// 名字里的百分比是四舍五入过的：在误差范围内枚举费率，配合常见间距（fee/100、fee/50 …）算 pool id 比对；不行再全范围扫间距
function decodeKey(token: Address, id: `0x${string}`, pctStr: string) {
  const decimals = (pctStr.split('.')[1] ?? '').length
  const center = Math.round(Number(pctStr) * 10_000), half = Math.round(5 * 10 ** (3 - decimals))
  const match = (fee: number, spacing: number) => v4.poolId(v4.makePoolKey(USDG, token, fee, spacing)) === id
  const spacings = [...new Set([...[100, 50, 10, 20, 25, 200, 500].map((d) => Math.round(center / d)), 1, 10, 60, 100, 200, 500, 1000, 2000])].filter((s) => s >= 1 && s <= 32767)
  const fees = [center, center - 1, ...Array.from({ length: 2 * half + 1 }, (_, i) => center - half + i)].filter((f) => f >= 1 && f <= 1_000_000)
  for (const fee of fees) for (const spacing of spacings) if (match(fee, spacing)) return { id, fee, spacing }
  for (const fee of [center, center - 1]) for (let spacing = 1; spacing <= 32767; spacing++) if (match(fee, spacing)) return { id, fee, spacing }
  return null
}
