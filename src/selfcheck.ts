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

const unlockData = encodeMintUnlockData(key, 334000, 349000, liquidity, 25_000_000n, 16487772911615747482873n, WALLET)
assert.equal(keccak256(unlockData), '0x19e3852cd4d12f82843f099bf8d7c00dcce5caf72bad1bf06bb6b896b8154c78', 'byte-identical to on-chain unlockData')

// 网页内联脚本只做语法解析（不执行）：一个重复声明就会让整个页面不动，右上角停在"连接中…"
for (const [, src] of readFileSync(new URL('./ui/index.html', import.meta.url), 'utf8').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Function(src)

console.log('selfcheck ok')
