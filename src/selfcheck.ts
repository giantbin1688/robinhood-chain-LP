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
const { computePoolAddress, UNI_POOL_INIT_CODE_HASH, v3Tiers } = await import('./lp-v3.ts')
const { CHAINS: chainConfigs, selectChain: chooseChain, protocolLabel: labelOf } = await import('./chains.ts')
const ethConfig = chainConfigs.ethereum
assert.equal(chooseChain(['--chain=ethereum'], {}).cfg.id, 1)
assert.equal(labelOf('ethereum', 'v3'), 'Uniswap v3')
assert.equal(computePoolAddress(ethConfig.contracts.v3!.factory as `0x${string}`, ethConfig.quote.address, ethConfig.wnative, 500, UNI_POOL_INIT_CODE_HASH), '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', 'Uniswap v3 USDC/WETH 0.05% CREATE2')
assert.deepEqual(v3Tiers('ethereum').map((t) => [t.fee, t.spacing]), [[100, 1], [500, 10], [3000, 60], [10000, 200]])
assert.equal(v3Tiers('bsc')[2].fee, 2500, 'Pancake v3 fee tier remains independent')
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

// 网页内联脚本只做语法解析（不执行）：一个重复声明就会让整个页面不动，右上角停在"连接中…"
for (const [, src] of readFileSync(new URL('./ui/index.html', import.meta.url), 'utf8').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(src)

console.log('selfcheck ok')
