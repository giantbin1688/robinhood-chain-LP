// Offline self-check of src/v4.ts against a real Robinhood Chain mint:
// tx 0x233ae8d87ebcba63d9671dc909b428eb035b306a8f7d579e8bda658d35e31841 (GRACE/USDG 5% pool, tokenId 1981258).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { keccak256 } from 'viem'
import { amountsForLiquidity, encodeMintUnlockData, getSqrtRatioAtTick, liquidityForAmounts, makePoolKey, poolId } from './v4.ts'

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const GRACE = '0xce221b17b872a5782be1b29305494a53e4985c9c'
const WALLET = '0xabd21db472062c373425308bb83fc80f7fffffff'

const key = makePoolKey(USDG, GRACE, 50000, 1000)
assert.equal(key.currency0, USDG, 'USDG sorts first')
assert.equal(poolId(key), '0x759630ddd2995746a1f4c3dcdf7c9841339b34a9449c2cf3593deaee272b3668')

// initializePool was called with the exact probe price (tick 341266.9); tick math must bracket it,
// same for slot0 snapshots of the v4 GRACE pool (tick 369224) and a v3 WETH/USDG pool (tick -198082)
const sqrtP = 2037161786837643599474709395128553579n
const brackets = (tick: number, sqrt: bigint) => getSqrtRatioAtTick(tick) <= sqrt && sqrt < getSqrtRatioAtTick(tick + 1)
assert.ok(brackets(341266, sqrtP))
assert.ok(brackets(369224, 8243103664141908263094636096949699068n))
assert.ok(brackets(-198082, 3961138388793536199535693n))

// 25 USDG + 17418.332908461372096057 GRACE received from the swap -> the liquidity the tool minted
const sqrtA = getSqrtRatioAtTick(334000), sqrtB = getSqrtRatioAtTick(349000)
const liquidity = liquidityForAmounts(sqrtP, sqrtA, sqrtB, 25_000_000n, 17418332908461372096057n)
assert.equal(liquidity, 2004651612282831n)
const [amount0, amount1] = amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity)
assert.equal(amount0, 25_000_000n)
assert.equal(amount1, 15702640868205473793213n, 'matches the GRACE Transfer in the receipt')

const unlockData = encodeMintUnlockData(key, [{ tickLower: 334000, tickUpper: 349000, liquidity, amount0Max: 25_000_000n, amount1Max: 16487772911615747482873n }], WALLET)
assert.equal(keccak256(unlockData), '0x19e3852cd4d12f82843f099bf8d7c00dcce5caf72bad1bf06bb6b896b8154c78', 'byte-identical to on-chain unlockData')
// 多仓位一笔交易：动作串是 02×n + 0d，参数数组是 n 个 mint + 1 个 settle
const two = encodeMintUnlockData(key, [{ tickLower: 334000, tickUpper: 349000, liquidity, amount0Max: 1n, amount1Max: 1n }, { tickLower: 330000, tickUpper: 352000, liquidity, amount0Max: 1n, amount1Max: 1n }], WALLET)
assert.ok(two.includes('02020d'.padEnd(64, '0')), 'actions 0x02020d')

// PancakeSwap（BSC）：v3 池地址的 create2 推导、Infinity PoolKey 的 poolId（含带 hook 的动态费率池），都对照链上已知的池
const { checkTickDetail } = await import('./tick-detail-check.ts')
checkTickDetail()
const { checkExitValuation } = await import('./exit-valuation-check.ts')
await checkExitValuation()
const { mergePositionRecords } = await import('./common.ts')
const labelRecord = { id:'1', token:USDG as `0x${string}`, symbol:'TEST', poolId:poolId(key), kind:'lp' as const, at:'2026-01-01', shape:'spot' as const }
const labelRecords = mergePositionRecords([labelRecord, {...labelRecord, chain:'bsc'}, {...labelRecord,id:'2'}], [{...labelRecord,shape:'bidask',at:'2026-09-11',chain:'robinhood',protocol:'v4'}])
assert.equal(labelRecords.length,3)
assert.equal(labelRecords[0].shape,'bidask')
assert.equal(labelRecords[0].at,'2026-01-01','classification preserves original creation time')
assert.equal(labelRecords[1].shape,'spot','same NFT id on a different chain is independent')
assert.equal(labelRecords[2].shape,'spot','unselected positions remain unchanged')
assert.equal(mergePositionRecords([labelRecord,labelRecord],[{...labelRecord,shape:'bidask'}]).length,1,'duplicate local records cannot override a corrected classification')
// positions.json 的目录锁：写完必须真的把锁删掉，过期的锁要能清掉再写。放在名字带非 ASCII 字符的临时目录里做——
// Node 24.12 的 rmSync 在 Windows 上对这种路径静默无效（nodejs/node#61067），曾把锁永远留在磁盘上，之后每次进场都在写记录这一步死循环
const { savePosition, loadPositions } = await import('./common.ts')
const { existsSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync, utimesSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const projectDir = process.cwd(), lockDir = mkdtempSync(join(tmpdir(), 'rh-锁-'))
process.chdir(lockDir)
try {
  savePosition(labelRecord)
  assert.ok(!existsSync('positions.json.lock'), 'the lock directory is removed after writing')
  savePosition({ ...labelRecord, id: '2' })
  assert.equal(loadPositions().length, 2, 'consecutive writes from one process both land')
  mkdirSync('positions.json.lock'); const minuteAgo = Date.now() / 1000 - 60; utimesSync('positions.json.lock', minuteAgo, minuteAgo)
  const lockWait = Date.now(); savePosition({ ...labelRecord, id: '3' })
  assert.ok(Date.now() - lockWait < 1000 && !existsSync('positions.json.lock') && loadPositions().length === 3, 'a stale lock left by a dead process is removed and the write goes through')
} finally {
  process.chdir(projectDir)
  if (existsSync(join(lockDir, 'positions.json'))) unlinkSync(join(lockDir, 'positions.json'))
  if (existsSync(join(lockDir, 'positions.json.lock'))) rmdirSync(join(lockDir, 'positions.json.lock'))
  rmdirSync(lockDir)
}
const { computePoolAddress, UNI_POOL_INIT_CODE_HASH, v3Tiers } = await import('./lp-v3.ts')
const { CHAINS: chainConfigs, selectChain: chooseChain, protocolLabel: labelOf } = await import('./chains.ts')
const ethConfig = chainConfigs.ethereum
assert.equal(chooseChain(['--chain=ethereum'], {}).cfg.id, 1)
assert.equal(labelOf('ethereum', 'v3'), 'Uniswap v3')
assert.equal(computePoolAddress(ethConfig.contracts.v3!.factory as `0x${string}`, ethConfig.quote.address, ethConfig.wnative!, 500, UNI_POOL_INIT_CODE_HASH), '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', 'Uniswap v3 USDC/WETH 0.05% CREATE2')
assert.deepEqual(v3Tiers('ethereum').map((t) => [t.fee, t.spacing]), [[100, 1], [500, 10], [3000, 60], [10000, 200]])
assert.equal(v3Tiers('bsc')[2].fee, 2500, 'Pancake v3 fee tier remains independent')
// Arc：USDC 既是 gas 又是计价币（ERC-20 接口 0x3600…），v3 是 Uniswap 原版 + SwapRouter02。02 的 exactInputSingle 参数里没有 deadline（选择器 0x04e45aaf，
// 原版 SwapRouter 带 deadline 的是 0x414bf389），限时靠 multicall(uint256 deadline, bytes[])（0x5ae401dc）包一层
const { router02Calldata } = await import('./lp-v3.ts')
const arcConfig = chainConfigs.arc
assert.equal(arcConfig.quote.address, '0x3600000000000000000000000000000000000000')
assert.equal(arcConfig.nativePrice, undefined, 'Arc: native USDC is the quote, gas priced at $1')
assert.equal(labelOf('arc', 'v3'), 'Uniswap v3')
assert.equal(v3Tiers('arc')[2].fee, 3000)
const r02 = router02Calldata('0x0000000000000000000000000000000000000001', arcConfig.quote.address, '0x0000000000000000000000000000000000000002', 3000, { exactIn: 1n, minOut: 1n }, 123n)
assert.equal(r02.slice(0, 10), '0x5ae401dc', 'SwapRouter02 multicall(deadline, data)')
assert.ok(r02.includes('04e45aaf'), 'SwapRouter02 exactInputSingle (no deadline field)')
assert.equal(router02Calldata('0x0000000000000000000000000000000000000001', arcConfig.quote.address, '0x0000000000000000000000000000000000000002', 3000, { exactOut: 1n, maxIn: 1n }, 123n).includes('5023b4df'), true, 'SwapRouter02 exactOutputSingle')
const USDT = '0x55d398326f99059fF775485246999027B3197955', CAKE = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'
assert.equal(computePoolAddress('0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9', CAKE, USDT, 2500), '0x7f51c8AaA6B0599aBd16674e2b17FEc7a9f674A1', 'Pancake v3 CAKE/USDT 0.25% pool address')
const { encodeAbiParameters } = await import('viem')
const INFI_KEY = { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'hooks', type: 'address' }, { name: 'poolManager', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'parameters', type: 'bytes32' }] } as const
const infiId = keccak256(encodeAbiParameters([INFI_KEY], [{ currency0: CAKE, currency1: USDT, hooks: '0x1A3DFBCAc585e22F993Cc8e09BcC0dB388Cc1Ca3', poolManager: '0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b', fee: 0x800000, parameters: '0x0000000000000000000000000000000000000000000000000000000000320040' }]))
assert.equal(infiId, '0x47516855520496b84a169f7bb92ace7ffb6e8c535bccb52a308ccff113aeccfb', 'Infinity CAKE/USDT dynamic-fee pool id')

// Solana：Raydium CLMM 的 sqrtPriceX64 左移 32 位当 X96 直接用 v4.ts 的 tick 数学（Raydium 的常数表按 64 位精度算，相对差在 1e-11 以内，远小于滑点余量），
// Meteora DLMM 的 bin 价格公式 (1 + binStep/1e4)^binId 与 SDK 一致（SOL/USDC 池 binStep 4、活跃 bin -5721 时 SDK 报 0.101475 USDC 每 lamport 组… 即每 SOL 101.475）
const { TickUtil } = await import('@raydium-io/raydium-sdk-v2')
for (const tick of [-443636, -22885, -1, 0, 1, 81831, 443636]) {
  const sdk = BigInt(TickUtil.getSqrtPriceAtTick(tick).toString()), mine = getSqrtRatioAtTick(tick) >> 32n
  const diff = mine > sdk ? mine - sdk : sdk - mine
  assert.ok(diff * 10n ** 10n <= sdk, `Raydium sqrtPriceX64 at tick ${tick}: sdk ${sdk} vs v4>>32 ${mine}`)
}
const { dlmmSdk } = await import('./sol/dlmm-sdk.ts')
assert.equal(typeof (dlmmSdk as any).create, 'function', 'DLMM CommonJS entry exports the class directly')
assert.equal(typeof (await import('./sol/dlmm.ts')).dlmmLp, 'function', 'DLMM adapter loads in Node.js')
const binPrice = (binId: number, binStep: number) => (1 + binStep / 10_000) ** binId
for (const [binId, binStep] of [[-5721, 4], [-823, 100], [0, 1], [1200, 25]] as const) {
  const sdk = Number(dlmmSdk.getPriceOfBinByBinId(binId, binStep).toString())
  assert.ok(Math.abs(binPrice(binId, binStep) / sdk - 1) < 1e-9, `DLMM bin ${binId} step ${binStep}: sdk ${sdk} vs ${binPrice(binId, binStep)}`)
}
assert.ok(Math.abs(binPrice(-5721, 4) * 1e3 - 101.475) < 0.01, 'SOL/USDC active bin -5721 ≈ 101.475 USDC/SOL')

// squeeze 形状：strategy.ts 的闸门 / 形状公式用固定样本测；shape.ts 的 squeezeLegs 三块的资金份额要和公式给的一致
{
  const { evaluateSqueeze, DEFAULT_SQUEEZE, squeezeParamsFromEnv } = await import('./strategy.ts')
  const { squeezeLegs, legShares } = await import('./shape.ts')
  // 1 小时 K 线：前 50 分钟在 0.024~0.036 之间大幅摆动，最近 10 分钟在 0.03 附近 ±0.6% 横盘
  const bars = Array.from({ length: 60 }, (_, i) => { const c = i < 50 ? 0.03 * (1 + 0.2 * Math.sin(i / 3)) : 0.03 * (1 + 0.006 * Math.sin(i)); return { time: i * 60_000, open: c, high: c * 1.002, low: c * 0.998, close: c, volume: 1000 } })
  const info = { symbol: 'T', holderCount: 5000, liquidityUsd: 200_000, price: 0.03, price1m: 0.03, price5m: 0.0299, price1h: 0.03, price24h: 0.03, volume1m: 0, volume5m: 700_000, volume1h: 4_200_000, volume24h: 0, buyVolume5m: 500_000, sellVolume5m: 200_000, buyVolume1h: 0, sellVolume1h: 0, buys5m: 0, sells5m: 0, sells24h: 500, swaps5m: 0, swaps1h: 0, pool: { address: '0x', exchange: 'uniswap_v4', quoteSymbol: 'USDG', baseReserveUsd: 100_000, quoteReserveUsd: 120_000, liquidityUsd: 220_000, createdAt: 0 }, top10Rate: 0.2 }
  const security = { honeypot: false, canNotSell: false, buyTax: 0, sellTax: 0, renounced: true, top10Rate: 0.2 }
  const depth = { id: '0x1', label: 'v4 2.5% USDG 池', quoteSymbol: 'USDG', quoteUsd: 160_000, tokenUsd: 40_000, source: 'chain' as const, feePips: 25_000, spacing: 250 }
  const cold5 = { ...info, buyVolume5m: 100_000, sellVolume5m: 50_000 }
  const ok = evaluateSqueeze({ info, security, bars, at: 0, warnings: [], poolDepth: depth }, 500)
  assert.ok(ok.pass, 'sample passes all gates: ' + ok.gates.filter((g) => !g.ok).map((g) => g.text).join('; '))
  assert.ok(Math.abs(ok.metrics.heat - 700_000 / (4_200_000 / 12)) < 1e-9, 'heat = vol5 / (vol1h / 12)')
  assert.ok(Math.abs(ok.metrics.turnover - 700_000 / 160_000) < 1e-9, 'turnover = vol5 / USDG inside the target pool')
  assert.ok(ok.metrics.compression !== null && ok.metrics.compression < 0.1, 'a 10-minute flat window inside a wide hour compresses')
  assert.ok(Math.abs(ok.plan.w - 0.05) < 1e-9, 'flat window narrower than 2 × 2.5% fee -> core floor = ±5%')
  assert.ok(ok.plan.upHi - 1 > 0.15 && 1 - ok.plan.downLo > 0.15, 'wings reach the hour high / low, not a fixed multiple')
  assert.ok(ok.plan.upHi - 1 > 1 - ok.plan.downLo, 'buy-heavy tape stretches the upper wing')
  assert.ok(ok.plan.insideShare !== null && Math.abs(ok.plan.shares.core - Math.max(ok.plan.insideShare, 0.3)) < 1e-9, 'core share = time spent inside the core band')
  assert.ok(Math.abs(ok.plan.shares.core + ok.plan.shares.up + ok.plan.shares.down - 1) < 1e-9)
  assert.ok(Math.abs(evaluateSqueeze({ info, security, bars, at: 0, warnings: [], poolDepth: { ...depth, feePips: 100_000 } }, 500).plan.w - 0.2) < 1e-9, 'a 10% fee pool gets a ±20% core floor')
  const trending = evaluateSqueeze({ info, security, bars: bars.slice(0, 50), at: 0, warnings: [], poolDepth: depth }, 500)
  assert.ok(!trending.gates.find((g) => g.key === 'compress')!.ok && trending.plan.w > 0.05, 'a swinging window fails compression and widens the core to its real range')
  const cold = evaluateSqueeze({ info: cold5, security, bars, at: 0, warnings: [], poolDepth: depth }, 500)
  assert.ok(!cold.gates.find((g) => g.key === 'heat')!.ok && cold.gates.filter((g) => !g.ok).length === 1, 'only the heat gate fails when the tape cools below the hour average')
  assert.equal(cold.block, false, 'gates only warn by default')
  assert.equal(evaluateSqueeze({ info: cold5, security, bars, at: 0, warnings: [], poolDepth: depth }, 500, { ...DEFAULT_SQUEEZE, gateBlock: 1 }).block, true, 'SQ_GATE_BLOCK=1 blocks a failed gate')
  assert.ok(!evaluateSqueeze({ info, security, bars: [], at: 0, warnings: [], poolDepth: depth }, 500).gates.find((g) => g.key === 'compress')!.ok, 'no kline -> compression gate fails instead of passing silently')
  assert.equal(evaluateSqueeze({ info: { ...info, sellVolume5m: 0, buyVolume5m: 700_000 }, security, bars, at: 0, warnings: [], poolDepth: depth }, 500).plan.shares.down, 0, 'skew +1 drops the lower wing')
  assert.ok(!evaluateSqueeze({ info, security, bars, at: 0, warnings: [], poolDepth: depth }, 20_000).gates.find((g) => g.key === 'depth')!.ok, 'a budget above 5% of pool USDG fails the depth gate')
  assert.equal(squeezeParamsFromEnv({ SQ_HOT_MIN: '2', SQ_WINDOW_MIN: 'abc' }).hotMin, 2, 'env override')
  assert.equal(squeezeParamsFromEnv({ SQ_WINDOW_MIN: 'abc' }).windowMin, DEFAULT_SQUEEZE.windowMin, 'garbage falls back to default')
  // 腿：USDG 是 currency0（tokenIs1），tick 311511、间距 100；核心 ±1.5%、下翼到 −13%（上翼份额 0）。p = 每个代币基础单位值多少 USDG 基础单位
  const t = 311511, spacing = 100, tokenIs1 = true, p = 0.03 * 10 ** (6 - 18)
  const mul = (m: number) => t - Math.log(m) / Math.log(1.0001)
  const core: [number, number] = [Math.floor(mul(1.015) / spacing) * spacing, Math.ceil(mul(0.985) / spacing) * spacing]
  const legs = squeezeLegs({ t, spacing, tokenIs1, p, core, down: [core[1], Math.ceil(mul(0.87) / spacing) * spacing], up: null, shares: { core: 0.4, down: 0.6, up: 0 } })
  assert.equal(legs.length, 4, '2 core layers + 2 lower-wing segments')
  assert.ok(legs.every((l) => l.g >= 1), 'weights normalised so the thinnest leg is 1')
  const shares = legShares(legs, t, p, tokenIs1)
  const coreShare = legs.reduce((s, l, i) => s + (l.lo <= t && t < l.hi ? shares[i] : 0), 0)
  assert.ok(Math.abs(coreShare - 0.4) < 1e-6, `core legs hold 40% of the budget, got ${coreShare}`)
  const far = legs.findIndex((l) => l.hi === Math.max(...legs.map((x) => x.hi))), near = legs.findIndex((l) => !(l.lo <= t && t < l.hi) && l.hi !== Math.max(...legs.map((x) => x.hi)))
  assert.ok(shares[far] > shares[near], 'outer wing segment is heavier than the inner one')
  assert.equal(squeezeLegs({ t, spacing, tokenIs1, p, core, down: [core[1], core[1] + 50], up: null, shares: { core: 0.4, down: 0.6, up: 0 } }).length, 2, 'a wing thinner than one spacing is dropped')
}

// 网页内联脚本只做语法解析（不执行）：一个重复声明就会让整个页面不动，右上角停在"连接中…"
for (const [, src] of readFileSync(new URL('./ui/index.html', import.meta.url), 'utf8').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(src)

console.log('selfcheck ok')
