// squeeze 形状的数据面公式（纯函数，不碰链、不碰网络；selfcheck 用固定样本测）。
// 思路：窄幅震荡 + 高换手时，把大头压在现价附近吃手续费（Curve 核心），两侧再挂越远越厚的 Bid-Ask 翼接挤压（squeeze）的单；
// 翼的长度和厚度按 5 分钟买卖失衡偏斜：买盘强 -> 上翼拉长加厚（涨上去卖），卖盘强 -> 下翼。
// 一切尺度都从这个币自己最近 1 小时的走势和目标池的费率 / 间距里取，没有写死的百分比：
//   核心半宽 = 观察窗口（默认 10 分钟）的实际振幅的一半，下限 = 池费率的几倍（区间比手续费还窄就没意义）
//   翼外沿   = 最近 1 小时的最高 / 最低价（至少是核心的几倍），再按买卖偏斜拉伸
//   核心份额 = 最近 1 小时里价格落在核心带内的时间占比（横盘越久核心越厚），两翼按偏斜分剩下的
//   闸门     = 和自己比：当前 5 分钟成交 vs 1 小时均值、窗口振幅 vs 1 小时振幅、5 分钟漂移 vs 自身 σ、预算 vs 池内 USDG
// 参数只剩倍数 / 比例（params.env 的 SQ_*，网页设置页可覆盖）。闸门默认只提示不拦（SQ_GATE_BLOCK=0）。
import type { Snapshot } from './gmgn.ts'
import { squeezeOverrides } from './settings.ts'

export type SqueezeParams = {
  windowMin: number       // 观察窗口（分钟）：核心宽度 / 收敛度 / σ 用最近这么多根 1m K 线
  gateBlock: number       // 1 = 闸门不过禁止真实进场；0 = 只提示
  hotMin: number          // 活跃闸门：当前 5 分钟成交 ≥ 过去 1 小时平均每 5 分钟成交 × 这个倍数
  compressMax: number     // 收敛闸门：窗口振幅 ≤ 1 小时振幅 × 这个比例
  driftSigmas: number     // 漂移闸门：|5 分钟漂移| ≤ 这么多个 σ√5
  budgetShareMax: number  // 深度闸门：预算 ≤ 目标池内 USDG 的这个百分比
  top10Max: number        // 安全闸门：前 10 持仓占比 ≤ 这个百分比
  coreFloorFees: number   // 核心半宽下限 = 池费率 × 这个倍数（还至少 2 个 tick 间距）
  wingMinMult: number     // 翼外沿至少 = 核心半宽 × 这个倍数（1 小时高低点更远就用高低点）
  coreShareMin: number    // 核心份额下限 %（价格再怎么乱跑，核心也至少留这么多）
  exitHeat: number        // 监控：当前 5 分钟成交低于 1 小时均值 × 这个比例…
  exitConfirm: number     // …连续这么多分钟就整组撤退
}
export const DEFAULT_SQUEEZE: SqueezeParams = { windowMin: 10, gateBlock: 0, hotMin: 1, compressMax: 0.5, driftSigmas: 2, budgetShareMax: 5, top10Max: 40, coreFloorFees: 2, wingMinMult: 2, coreShareMin: 30, exitHeat: 0.25, exitConfirm: 3 }
// 可调参数表：params.env 的名字 -> SqueezeParams 字段；网页设置页按这张表出输入框，settings.json 里的值优先于 params.env
export const SQUEEZE_FIELDS: { key: string; field: keyof SqueezeParams; label: string; hint: string; min: number; max: number }[] = [
  { key: 'SQ_WINDOW_MIN', field: 'windowMin', label: '观察窗口 分钟', hint: '核心宽度 = 这段时间的实际振幅；收敛度 / σ 也按它算（3~60）', min: 3, max: 60 },
  { key: 'SQ_GATE_BLOCK', field: 'gateBlock', label: '闸门不过就禁止进场', hint: '0 = 只提示，形状照样算出来可以开仓（默认）；1 = 真实进场被拒绝', min: 0, max: 1 },
  { key: 'SQ_HOT_MIN', field: 'hotMin', label: '活跃 ≥ 1 小时均值 ×', hint: '当前 5 分钟成交 ÷ 过去 1 小时平均每 5 分钟成交', min: 0, max: 100 },
  { key: 'SQ_COMPRESS_MAX', field: 'compressMax', label: '收敛 ≤ 1 小时振幅 ×', hint: '窗口振幅 ÷ 1 小时振幅，越小越像横盘', min: 0.01, max: 1 },
  { key: 'SQ_DRIFT_SIGMAS', field: 'driftSigmas', label: '漂移 ≤ σ 倍数', hint: '|5 分钟漂移| ÷ (1 分钟 σ × √5)', min: 0, max: 20 },
  { key: 'SQ_BUDGET_SHARE_MAX', field: 'budgetShareMax', label: '预算 ≤ 池内 USDG %', hint: '别让自己成为池子的大头', min: 0.1, max: 100 },
  { key: 'SQ_TOP10_MAX', field: 'top10Max', label: '前 10 持仓 ≤ %', hint: '另外固定要求非蜜罐、24h 有卖出、卖税 < 10%', min: 0, max: 100 },
  { key: 'SQ_CORE_FLOOR_FEES', field: 'coreFloorFees', label: '核心半宽 ≥ 费率 ×', hint: '2.5% 池 × 2 = 核心至少 ±5%；另至少 2 个 tick 间距', min: 0, max: 50 },
  { key: 'SQ_WING_MIN_MULT', field: 'wingMinMult', label: '翼外沿 ≥ 核心 ×', hint: '1 小时最高 / 最低价更远就取高低点', min: 1, max: 20 },
  { key: 'SQ_CORE_SHARE_MIN', field: 'coreShareMin', label: '核心份额下限 %', hint: '核心份额 = 1 小时里价格落在核心带内的时间占比，不低于这个数', min: 5, max: 95 },
  { key: 'SQ_EXIT_HEAT', field: 'exitHeat', label: '撤退：活跃 < 1 小时均值 ×', hint: '监控每分钟查一次 GMGN', min: 0, max: 1 },
  { key: 'SQ_EXIT_CONFIRM', field: 'exitConfirm', label: '撤退：连续分钟', hint: '连续这么多分钟低于上面的比例就整组撤退', min: 1, max: 1440 },
]
// 生效参数：设置页（settings.json）优先，其次 params.env（环境变量），都没填用默认
export function squeezeParamsFromEnv(env: Record<string, string | undefined> = { ...process.env, ...Object.fromEntries(Object.entries(squeezeOverrides()).filter(([, v]) => v !== '')) }): SqueezeParams {
  const out = { ...DEFAULT_SQUEEZE }
  for (const f of SQUEEZE_FIELDS) { const v = Number(env[f.key]); if (env[f.key] && Number.isFinite(v)) (out as any)[f.field] = v }
  return out
}
// 设置页显示用：每个参数的生效值和来源
export const squeezeParamSources = () => SQUEEZE_FIELDS.map((f) => { const o = squeezeOverrides()[f.key], e = process.env[f.key]; return { ...f, value: o || e || String(DEFAULT_SQUEEZE[f.field]), source: o ? 'settings' : e ? 'env' : 'default' } })
export const HOUR_BARS = 60 // 快照总是拉最近 1 小时的 1m K 线，窗口从里面截

export type Metrics = {
  price: number; depthUsd: number; liquidityUsd: number; depthSource: 'pool' | 'gmgn-quote' | 'half-liquidity'; depthLabel: string // depthUsd = 计价币侧：目标池链上 USDG（pool）> GMGN 主池 quote 侧 > liquidity/2
  feePct: number; spacingPct: number                                          // 目标池费率 % / 一个 tick 间距 ≈ 多少 %（没有目标池按 1% / 0.1%）
  vol5: number; buy5: number; sell5: number; vol1h: number; turnover: number; heat: number; skew: number // turnover = vol5 / depthUsd；heat = vol5 / (vol1h/12)；skew ∈ [-1, 1]
  sigma1m: number | null; rangeWin: number | null; rangeHour: number | null; compression: number | null; bars: number; hourBars: number // 小数；bars = 窗口根数
  hourHi: number | null; hourLo: number | null                                  // 1 小时最高 / 最低 相对现价的倍数
  drift5: number; drift1h: number; driftZ: number | null                        // driftZ = |drift5| / (σ√5)
  holders: number; top10: number | null; honeypot: boolean | null; canNotSell: boolean; sellTax: number; sells24h: number
}
export type Gate = { key: string; name: string; ok: boolean; text: string }
// 形状参数全是相对现价的倍数：核心 [1−w, 1+w]，下翼 [downLo, 1−w)，上翼 (1+w, upHi]；份额按预算价值算，翼份额为 0 = 不建那一侧
export type SqueezePlan = { w: number; upHi: number; downLo: number; shares: { core: number; up: number; down: number }; insideShare: number | null; label: string }
export type Evaluation = { metrics: Metrics; gates: Gate[]; pass: boolean; block: boolean; windowMin: number; plan: SqueezePlan; warnings: string[] } // block = 闸门没过且开了 SQ_GATE_BLOCK

const std = (xs: number[]) => { if (xs.length < 3) return null; const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, r) => a + (r - m) ** 2, 0) / (xs.length - 1)) }
const rangeOf = (bars: { high: number; low: number }[], price: number) => (bars.length >= 3 && price > 0 ? (Math.max(...bars.map((b) => b.high)) - Math.min(...bars.map((b) => b.low))) / price : null)

export function metricsOf(s: Snapshot, windowMin = DEFAULT_SQUEEZE.windowMin): Metrics {
  const { info, security } = s
  const pool = info.pool, pd = s.poolDepth
  const liquidityUsd = pd ? pd.quoteUsd + pd.tokenUsd : pool?.liquidityUsd || info.liquidityUsd // 两侧合计
  const depthUsd = pd ? pd.quoteUsd : pool && pool.quoteReserveUsd > 0 ? pool.quoteReserveUsd : liquidityUsd / 2 // 计价币侧
  const depthSource = pd ? 'pool' as const : pool && pool.quoteReserveUsd > 0 ? 'gmgn-quote' as const : 'half-liquidity' as const
  const depthLabel = pd ? `池内 ${pd.quoteSymbol}（${pd.label}${pd.truncated ? '，读取范围受限' : ''}）` : pool && pool.quoteReserveUsd > 0 ? `GMGN 主池 ${pool.quoteSymbol} 侧（${pool.exchange}，非目标池）` : 'GMGN liquidity/2 估'
  const feePct = pd?.feePips ? pd.feePips / 10_000 : 1, spacingPct = pd?.spacing ? pd.spacing * 0.01 : 0.1
  const vol5 = info.buyVolume5m + info.sellVolume5m || info.volume5m, vol1h = Math.max(info.volume1h, vol5)
  const hour = s.bars, win = hour.slice(-Math.max(3, Math.round(windowMin)))
  const closes = win.map((b) => b.close)
  const sigma1m = std(closes.slice(1).map((c, i) => Math.log(c / closes[i])).filter(Number.isFinite))
  const rangeWin = rangeOf(win, info.price), rangeHour = hour.length > win.length ? rangeOf(hour, info.price) : null
  const drift5 = info.price5m > 0 ? info.price / info.price5m - 1 : 0
  return {
    price: info.price, depthUsd, liquidityUsd, depthSource, depthLabel, feePct, spacingPct,
    vol5, buy5: info.buyVolume5m, sell5: info.sellVolume5m, vol1h, turnover: depthUsd > 0 ? vol5 / depthUsd : 0, heat: vol1h > 0 ? vol5 / (vol1h / 12) : 0, skew: vol5 > 0 ? (info.buyVolume5m - info.sellVolume5m) / vol5 : 0,
    sigma1m, rangeWin, rangeHour, compression: rangeWin !== null && rangeHour ? rangeWin / rangeHour : null, bars: win.length, hourBars: hour.length,
    hourHi: hour.length >= 3 && info.price > 0 ? Math.max(...hour.map((b) => b.high)) / info.price : null, hourLo: hour.length >= 3 && info.price > 0 ? Math.min(...hour.map((b) => b.low)) / info.price : null,
    drift5, drift1h: info.price1h > 0 ? info.price / info.price1h - 1 : 0, driftZ: sigma1m ? Math.abs(drift5) / (sigma1m * Math.sqrt(5)) : null,
    holders: info.holderCount, top10: security?.top10Rate ?? info.top10Rate, honeypot: security?.honeypot ?? null, canNotSell: security?.canNotSell ?? false, sellTax: security?.sellTax ?? 0, sells24h: info.sells24h,
  }
}
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
const pc = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`
const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`
const sgn = (x: number) => (x >= 0 ? '+' : '')

export function evaluateSqueeze(s: Snapshot, budgetUsd: number, p: SqueezeParams = DEFAULT_SQUEEZE): Evaluation {
  const m = metricsOf(s, p.windowMin)
  // 核心半宽下限 = 费率 × 倍数，且至少 2 个 tick 间距（闸门和形状都要用）
  const floor = Math.max((p.coreFloorFees * m.feePct) / 100, (2 * m.spacingPct) / 100, 0.001)
  const flatHour = m.rangeHour !== null && m.rangeHour <= 4 * floor // 整个小时都在 ±2 个下限内：本身就是横盘，不必再要求窗口比小时更窄
  const gates: Gate[] = [
    { key: 'heat', name: '活跃', ok: m.heat >= p.hotMin, text: `当前 5 分钟成交 ${usd(m.vol5)} 是过去 1 小时均值 ${usd(m.vol1h / 12)} 的 ${m.heat.toFixed(2)} 倍（要求 ≥ ${p.hotMin}）；相当于池内 ${m.depthLabel.startsWith('池内') ? '' : '（估）'}USDG 的 ${m.turnover.toFixed(2)} 倍` },
    { key: 'compress', name: '收敛', ok: m.compression !== null && (m.compression <= p.compressMax || flatHour), text: m.compression === null ? `K 线不足（1 小时 ${m.hourBars} 根 / 窗口 ${m.bars} 根），算不出收敛度` : `${p.windowMin} 分钟振幅 ${pc(m.rangeWin!)} 是 1 小时振幅 ${pc(m.rangeHour!)} 的 ${pc(m.compression, 0)}（要求 ≤ ${pc(p.compressMax, 0)}${flatHour ? `；整个小时振幅不到 ${pc(4 * floor)}，本身就是横盘，算通过` : ''}）` },
    { key: 'drift', name: '漂移', ok: m.driftZ !== null && m.driftZ <= p.driftSigmas, text: m.driftZ === null ? `算不出 σ，无法判断漂移（5 分钟 ${sgn(m.drift5)}${pc(m.drift5)}）` : `5 分钟漂移 ${sgn(m.drift5)}${pc(m.drift5)} = ${m.driftZ.toFixed(1)} σ（1m σ ${pc(m.sigma1m!, 2)}，要求 ≤ ${p.driftSigmas} σ）` },
    { key: 'depth', name: '深度', ok: m.depthUsd > 0 && budgetUsd / m.depthUsd <= p.budgetShareMax / 100, text: `预算 ${usd(budgetUsd)} 占 ${m.depthLabel} ${usd(m.depthUsd)} 的 ${m.depthUsd > 0 ? pc(budgetUsd / m.depthUsd) : '∞'}（要求 ≤ ${p.budgetShareMax}%）` },
    { key: 'safety', name: '安全', ok: m.honeypot !== true && !m.canNotSell && m.sells24h > 0 && m.sellTax < 10 && (m.top10 === null || m.top10 <= p.top10Max / 100), text: `蜜罐 ${m.honeypot === null ? '未测' : m.honeypot ? '是' : '否'}，24h 卖出 ${m.sells24h} 笔，卖税 ${m.sellTax}%，前 10 持仓 ${m.top10 === null ? '未知' : pc(m.top10)}（要求 ≤ ${p.top10Max}%）` },
  ]
  // 核心半宽：窗口实际振幅的一半；窗口没 K 线就用 σ 推（2σ√窗口），再没有就用下限
  const fromRange = m.rangeWin !== null ? m.rangeWin / 2 : m.sigma1m ? 2 * m.sigma1m * Math.sqrt(m.bars || p.windowMin) : 0
  const w = clamp(Math.max(fromRange, floor), floor, 0.6)
  // 翼外沿：1 小时的最高 / 最低（至少核心的 wingMinMult 倍），再按买卖偏斜拉伸：买盘强上翼更长、下翼更短
  const sk = clamp(m.skew, -1, 1)
  const upBase = Math.max(m.hourHi !== null ? m.hourHi - 1 : 0, p.wingMinMult * w), downBase = Math.max(m.hourLo !== null ? 1 - m.hourLo : 0, p.wingMinMult * w)
  const upHi = 1 + clamp(upBase * (1 + 0.5 * sk), w + m.spacingPct / 100, 5), downLo = 1 - clamp(downBase * (1 - 0.5 * sk), w + m.spacingPct / 100, 0.9)
  // 份额：核心 = 1 小时里收盘价落在核心带内的时间占比（下限 coreShareMin）；两翼按偏斜分剩下的，不到 5% 的翼并到另一侧
  const inside = s.bars.length >= 3 ? s.bars.filter((b) => b.close >= m.price * (1 - w) && b.close <= m.price * (1 + w)).length / s.bars.length : null
  const core = clamp(inside ?? 0.5, p.coreShareMin / 100, 0.9)
  let up = ((1 - core) * (1 + sk)) / 2, down = ((1 - core) * (1 - sk)) / 2
  if (up < 0.05) { down += up; up = 0 }
  if (down < 0.05) { up += down; down = 0 }
  const plan: SqueezePlan = { w, upHi, downLo, shares: { core, up, down }, insideShare: inside, label: `squeeze（核心 Curve ±${pc(w)} 占 ${pc(core, 0)}${down > 0 ? `，下翼到 ${pc(downLo - 1)} 占 ${pc(down, 0)}` : ''}${up > 0 ? `，上翼到 +${pc(upHi - 1)} 占 ${pc(up, 0)}` : ''}，偏斜 ${sgn(sk)}${sk.toFixed(2)}）` }
  const pass = gates.every((g) => g.ok)
  return { metrics: m, gates, pass, block: !pass && p.gateBlock >= 1, windowMin: p.windowMin, plan, warnings: s.warnings }
}
export const metricsText = (m: Metrics) => [
  `现价 $${m.price}，${m.depthLabel} ${usd(m.depthUsd)}（两侧合计 ${usd(m.liquidityUsd)}，费率 ${m.feePct}%），持有人 ${m.holders}`,
  `5 分钟成交 ${usd(m.vol5)}（买 ${usd(m.buy5)} / 卖 ${usd(m.sell5)}），1 小时 ${usd(m.vol1h)}，活跃 ${m.heat.toFixed(2)}×，换手 ${m.turnover.toFixed(2)} 倍，偏斜 ${sgn(m.skew)}${m.skew.toFixed(2)}`,
  `1m σ ${m.sigma1m === null ? '—' : pc(m.sigma1m, 2)}（窗口 ${m.bars} 根 / 1 小时 ${m.hourBars} 根），窗口振幅 ${m.rangeWin === null ? '—' : pc(m.rangeWin)}，1 小时振幅 ${m.rangeHour === null ? '—' : pc(m.rangeHour)}（高 ${m.hourHi === null ? '—' : sgn(m.hourHi - 1) + pc(m.hourHi - 1)} / 低 ${m.hourLo === null ? '—' : pc(m.hourLo - 1)}），漂移 5m ${sgn(m.drift5)}${pc(m.drift5)} / 1h ${sgn(m.drift1h)}${pc(m.drift1h)}`,
]
