// 流动性形状：把一个 tick 区间拆成几个仓位（纯数学，进场命令和 Solana 的 Raydium CLMM 共用）。
//   spot   一个仓位
//   curve  layers 个同心嵌套仓位，每层宽度减半、权重相同 -> 现价附近被所有层覆盖，最厚；越往外越薄
//   bidask 现价两侧各 layers 段互不重叠，第 k 段权重 k -> 离现价越远越厚；含现价的那一格空着（跌买涨卖，不做市）
// 单边区间（整体在现价一侧）以靠近现价的那条边为锚点。区间太窄时相邻层会取整到同一组 tick，合并；拆不出来返回 []
import * as v4 from './v4.ts'

export type Shape = 'spot' | 'curve' | 'bidask'
export type Leg = { lo: number; hi: number; g: number } // g 是各仓位的流动性权重（同一份流动性 L 按 g 倍分配）

export function shapeLegs(o: { lo: number; hi: number; t: number; spacing: number; shape: Shape; layers: number; tokenIs1: boolean }): Leg[] {
  const { lo, hi, t, spacing, shape, layers } = o
  if (shape === 'spot') return [{ lo, hi, g: 1 }]
  const below = hi <= t, above = lo > t
  const [c0, c1] = [v4.floorToSpacing(t, spacing), v4.floorToSpacing(t, spacing) + spacing] // 含现价的那一格
  const raw: Leg[] = []
  const add = (l: number, h: number, g: number) => { l = Math.max(lo, l); h = Math.min(hi, h); if (h > l) raw.push({ lo: l, hi: h, g }) }
  const round = (x: number) => Math.round(x / spacing) * spacing
  if (shape === 'curve') {
    const a = below ? hi : above ? lo : t
    for (let i = 0; i < layers; i++) {
      const f = 0.5 ** i
      let l = v4.floorToSpacing(a - (a - lo) * f, spacing), h = v4.ceilToSpacing(a + (hi - a) * f, spacing)
      if (below) l = Math.min(l, hi - spacing); else if (above) h = Math.max(h, lo + spacing); else { l = Math.min(l, c0); h = Math.max(h, c1) } // 每层至少一格，双边时都要跨过现价
      add(l, h, 1)
    }
  } else {
    const inLo = below ? hi : c0, inHi = above ? lo : c1 // 靠近现价的内侧边界：下侧 ≤ 现价，上侧 > 现价
    if (!above) for (let k = 1; k <= layers; k++) add(k === layers ? lo : round(inLo - ((inLo - lo) * k) / layers), k === 1 ? inLo : round(inLo - ((inLo - lo) * (k - 1)) / layers), k)
    if (!below) for (let k = 1; k <= layers; k++) add(k === 1 ? inHi : round(inHi + ((hi - inHi) * (k - 1)) / layers), k === layers ? hi : round(inHi + ((hi - inHi) * k) / layers), k)
  }
  raw.sort((x, y) => x.lo - y.lo || x.hi - y.hi)
  const legs: Leg[] = []
  for (const l of raw) { const p = legs[legs.length - 1]; if (p && p.lo === l.lo && p.hi === l.hi) p.g += l.g; else legs.push({ ...l }) }
  if (o.tokenIs1) legs.reverse() // 按代币价格从低到高排（代币是 currency1 时 tick 越大价格越低）
  return legs
}

// 仓位相对现价的位置：tick 比现价低的一侧全是 currency1，高的一侧全是 currency0
export const legSide = (l: Leg, t: number, tokenIs1: boolean) => (l.hi <= t ? (tokenIs1 ? 'token' : 'usdg') : l.lo > t ? (tokenIs1 ? 'usdg' : 'token') : 'both')

// 价格 sqrt(sp) 处、区间 [lo, hi] 每单位流动性需要多少 currency0 / currency1（基础单位，浮点，只用于配比；真实数量用 v4.amountsForLiquidity）
export function unitAmounts(sp: number, lo: number, hi: number) {
  const sa = Math.sqrt(v4.priceAtTick(lo)), sb = Math.sqrt(v4.priceAtTick(hi))
  const a0 = sp >= sb ? 0 : (sb - Math.max(sp, sa)) / (Math.max(sp, sa) * sb)
  const a1 = sp <= sa ? 0 : Math.min(sp, sb) - sa
  return [a0, a1] as const
}
// 整套仓位在 tick t 处每单位流动性需要多少代币 / 计价币（基础单位）
export function mixAt(t: number, legs: Leg[], tokenIs1: boolean) {
  const sp = Math.sqrt(v4.priceAtTick(t))
  let tok = 0, usdg = 0
  for (const l of legs) { const [a0, a1] = unitAmounts(sp, l.lo, l.hi); tok += l.g * (tokenIs1 ? a1 : a0); usdg += l.g * (tokenIs1 ? a0 : a1) }
  return { tok, usdg }
}
// 每 1 计价币基础单位的预算要配多少代币基础单位（p = 每个代币基础单位值多少计价币基础单位）：0 = 只要计价币，1/p = 只要代币
export const tokenPerUsdg = (legs: Leg[], t: number, p: number, tokenIs1: boolean) => { const { tok, usdg } = mixAt(t, legs, tokenIs1); return tok === 0 ? 0 : tok / (tok * p + usdg) }

// 各仓位按当前配比占预算的份额（按市场价折成计价币）；p = 每个代币基础单位值多少计价币基础单位
export function legShares(legs: Leg[], t: number, p: number, tokenIs1: boolean) {
  const sp = Math.sqrt(v4.priceAtTick(t))
  const v = legs.map((l) => { const [a0, a1] = unitAmounts(sp, l.lo, l.hi); return l.g * ((tokenIs1 ? a1 : a0) * p + (tokenIs1 ? a0 : a1)) })
  const sum = v.reduce((a, b) => a + b, 0)
  return v.map((x) => (sum > 0 ? x / sum : 0))
}

// 由持有量算各仓位的流动性：单仓按余额精确算；多仓共用一份流动性 L（先按配比算出整套最多能组多大，第 i 个仓位 L×g_i）。
// 每个仓位的 amountMax = 实际扣款 + 余量，合计不超过持有量（超了就把剩余空间按扣款比例分）。返回 null = 算不出（价格在仓位另一侧、手里没有它需要的币）
export type MintAmounts = { tickLower: number; tickUpper: number; liquidity: bigint; amount0: bigint; amount1: bigint; amount0Max: bigint; amount1Max: bigint; amount0Min: bigint; amount1Min: bigint }
export function planMints(legs: Leg[], sqrtP: bigint, avail0: bigint, avail1: bigint, lpSlippage: number) {
  const sqrts = legs.map((l) => [v4.getSqrtRatioAtTick(l.lo), v4.getSqrtRatioAtTick(l.hi)] as const)
  const amountsOf = (liq: bigint[]) => liq.map((x, j) => v4.amountsForLiquidity(sqrtP, sqrts[j][0], sqrts[j][1], x))
  const sumOf = (xs: [bigint, bigint][]) => xs.reduce(([a, b], [x0, x1]) => [a + x0, b + x1] as [bigint, bigint], [0n, 0n])
  let liq: bigint[] = []
  if (legs.length === 1) liq = [v4.liquidityForAmounts(sqrtP, sqrts[0][0], sqrts[0][1], avail0, avail1)]
  else {
    const sp = Math.sqrt(v4.priceFromSqrtX96(sqrtP))
    let tot0 = 0, tot1 = 0
    for (const l of legs) { const [a0, a1] = unitAmounts(sp, l.lo, l.hi); tot0 += l.g * a0; tot1 += l.g * a1 }
    let L = Math.min(tot0 > 0 ? Number(avail0) / tot0 : Infinity, tot1 > 0 ? Number(avail1) / tot1 : Infinity)
    if (!Number.isFinite(L)) return null
    for (let i = 0; ; i++) { // 浮点配比与链上向上取整有微小误差：合计超出持有量就整体缩 0.01% 再算
      liq = legs.map((l) => BigInt(Math.floor(L * l.g)))
      const [s0, s1] = sumOf(amountsOf(liq))
      if (s0 <= avail0 && s1 <= avail1) break
      if (i >= 20) return null
      L *= 0.9999
    }
  }
  if (liq.some((x) => x === 0n)) return null
  const amounts = amountsOf(liq), [sum0, sum1] = sumOf(amounts)
  const maxes = (xs: bigint[], sum: bigint, avail: bigint) => {
    const want = xs.map((x) => (x * BigInt(Math.round((100 + lpSlippage) * 100))) / 10_000n)
    return want.reduce((a, b) => a + b, 0n) <= avail || sum === 0n ? want : xs.map((x) => x + ((avail - sum) * x) / sum)
  }
  const floorSlip = (x: bigint) => (x * BigInt(Math.round((100 - lpSlippage) * 100))) / 10_000n
  const m0 = maxes(amounts.map((a) => a[0]), sum0, avail0), m1 = maxes(amounts.map((a) => a[1]), sum1, avail1)
  const specs: MintAmounts[] = legs.map((l, j) => ({ tickLower: l.lo, tickUpper: l.hi, liquidity: liq[j], amount0: amounts[j][0], amount1: amounts[j][1], amount0Max: m0[j], amount1Max: m1[j], amount0Min: floorSlip(amounts[j][0]), amount1Min: floorSlip(amounts[j][1]) }))
  return { specs, amounts, sum0, sum1 }
}
