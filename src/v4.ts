// Uniswap v4 math + encoding needed to mint one position and to swap in one pool. Pure functions, no I/O.
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from 'viem'

export const Q96 = 1n << 96n
export const MIN_TICK = -887272
export const MAX_TICK = 887272
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }

export const POOL_KEY_ABI = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
} as const

export function makePoolKey(a: Address, b: Address, fee: number, tickSpacing: number): PoolKey {
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a]
  return { currency0, currency1, fee, tickSpacing, hooks: ZERO_ADDRESS }
}

export const poolId = (key: PoolKey): Hex => keccak256(encodeAbiParameters([POOL_KEY_ABI], [key]))

// Bit-exact port of v4-core TickMath.getSqrtPriceAtTick (same constants as v3-core).
const TICK_MAGIC = [
  0xfff97272373d413259a46990580e213an, 0xfff2e50f5f656932ef12357cf3c7fdccn, 0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n, 0xff973b41fa98c081472e6896dfb254c0n, 0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n, 0xfcbe86c7900a88aedcffc83b479aa3a4n, 0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n, 0xe7159475a2c29b7443b29c7fa6e889d9n, 0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n, 0x70d869a156d2a1b890bb3df62baf32f7n, 0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n, 0x5d6af8dedb81196699c329225ee604n, 0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
]
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick out of range: ${tick}`)
  const abs = Math.abs(tick)
  let ratio = abs & 1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n
  TICK_MAGIC.forEach((m, i) => { if (abs & (2 << i)) ratio = (ratio * m) >> 128n })
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n)
}

// price here is always the raw pool price: currency1 base units per currency0 base unit = 1.0001^tick
export const tickFromPrice = (price: number) => Math.floor(Math.log(price) / Math.log(1.0001))
export const priceAtTick = (tick: number) => 1.0001 ** tick
export const priceFromSqrtX96 = (sqrtPriceX96: bigint) => (Number(sqrtPriceX96) / 2 ** 96) ** 2
export const floorToSpacing = (tick: number, spacing: number) => Math.floor(tick / spacing) * spacing
export const ceilToSpacing = (tick: number, spacing: number) => Math.ceil(tick / spacing) * spacing

const mulDivUp = (a: bigint, b: bigint, d: bigint) => (a * b + d - 1n) / d

// SqrtPriceMath.getAmount0Delta / getAmount1Delta for the price interval [a, b]
export function amount0Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (a > b) [a, b] = [b, a]
  const n = liquidity << 96n
  return roundUp ? (mulDivUp(n, b - a, b) + a - 1n) / a : (n * (b - a)) / b / a
}
export function amount1Delta(a: bigint, b: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (a > b) [a, b] = [b, a]
  return roundUp ? mulDivUp(liquidity, b - a, Q96) : (liquidity * (b - a)) / Q96
}

// LiquidityAmounts.getLiquidityForAmounts (full precision, rounds down like the SDK)
export function liquidityForAmounts(sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, amount0: bigint, amount1: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA]
  const l0 = (a: bigint, b: bigint) => (amount0 * a * b) / Q96 / (b - a)
  const l1 = (a: bigint, b: bigint) => (amount1 * Q96) / (b - a)
  if (sqrtP <= sqrtA) return l0(sqrtA, sqrtB)
  if (sqrtP >= sqrtB) return l1(sqrtA, sqrtB)
  const x = l0(sqrtP, sqrtB), y = l1(sqrtA, sqrtP)
  return x < y ? x : y
}

// Amounts PoolManager charges when adding `liquidity` (rounded up)
export function amountsForLiquidity(sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, liquidity: bigint): [bigint, bigint] {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA]
  if (sqrtP <= sqrtA) return [amount0Delta(sqrtA, sqrtB, liquidity, true), 0n]
  if (sqrtP >= sqrtB) return [0n, amount1Delta(sqrtA, sqrtB, liquidity, true)]
  return [amount0Delta(sqrtP, sqrtB, liquidity, true), amount1Delta(sqrtA, sqrtP, liquidity, true)]
}

// Exact-input swap against constant liquidity: input net of fees -> resulting sqrt price and output amount.
// Pass sqrtTarget instead of amountInNet to get the input that moves the price exactly to sqrtTarget.
export function swapConstantL(liquidity: bigint, sqrtP: bigint, zeroForOne: boolean, x: { amountInNet: bigint } | { sqrtTarget: bigint }) {
  let sqrtNext: bigint, amountInNet: bigint
  if ('sqrtTarget' in x) {
    sqrtNext = x.sqrtTarget
    amountInNet = zeroForOne ? amount0Delta(sqrtNext, sqrtP, liquidity, true) : amount1Delta(sqrtP, sqrtNext, liquidity, true)
  } else {
    amountInNet = x.amountInNet
    sqrtNext = zeroForOne
      ? mulDivUp(liquidity * Q96, sqrtP, liquidity * Q96 + amountInNet * sqrtP) // getNextSqrtPriceFromAmount0RoundingUp
      : sqrtP + (amountInNet * Q96) / liquidity                                   // getNextSqrtPriceFromAmount1RoundingDown
  }
  const out = zeroForOne ? amount1Delta(sqrtNext, sqrtP, liquidity, false) : amount0Delta(sqrtP, sqrtNext, liquidity, false)
  return { sqrtNext, amountInNet, out }
}

// Permit2 AllowanceTransfer PermitSingle (EIP-712 message and calldata struct)
export const PERMIT_TYPES = {
  PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
  PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
} as const
export type PermitSingle = { details: { token: Address; amount: bigint; expiration: number; nonce: number }; spender: Address; sigDeadline: bigint }
export type SignedPermit = { permitSingle: PermitSingle; signature: Hex }
const PERMIT_SINGLE_ABI = {
  type: 'tuple', components: [
    { name: 'details', type: 'tuple', components: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] },
    { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' },
  ],
} as const

// UniversalRouter calldata for one swap in one singleton pool, exact input or exact output:
// [PERMIT2_PERMIT] V4_SWAP/INFI_SWAP(0x10) { SWAP_EXACT_IN_SINGLE | SWAP_EXACT_OUT_SINGLE, SETTLE_ALL, TAKE_ALL }. Input is pulled from the caller through Permit2;
// an optional signed permit sets the Permit2 -> router allowance in the same transaction.
// keyAbi: PoolKey tuple of the protocol; minHop: Robinhood's UniversalRouter 2.1.1 adds a minHopPriceX36 field after amountLimit (PancakeSwap Infinity does not)
export function encodeV4SwapCalldata(
  key: unknown, zeroForOne: boolean, amount: { exactIn: bigint; minOut: bigint } | { exactOut: bigint; maxIn: bigint }, deadline: bigint, permit?: SignedPermit | null,
  opts: { keyAbi?: typeof POOL_KEY_ABI | { type: 'tuple'; components: readonly { name: string; type: string }[] }; minHop?: boolean } = {},
): Hex {
  const keyAbi = opts.keyAbi ?? POOL_KEY_ABI, minHop = opts.minHop ?? true
  const k = key as PoolKey
  const exactIn = 'exactIn' in amount
  const swap = encodeAbiParameters(
    [{ type: 'tuple', components: [
      { ...keyAbi, name: 'poolKey' }, { name: 'zeroForOne', type: 'bool' }, { name: 'amount', type: 'uint128' },
      { name: 'amountLimit', type: 'uint128' }, ...(minHop ? [{ name: 'minHopPriceX36', type: 'uint256' }] : []), { name: 'hookData', type: 'bytes' },
    ] }] as any,
    [{ poolKey: key, zeroForOne, amount: exactIn ? amount.exactIn : amount.exactOut, amountLimit: exactIn ? amount.minOut : amount.maxIn, ...(minHop ? { minHopPriceX36: 0n } : {}), hookData: '0x' }],
  )
  const [cin, cout] = zeroForOne ? [k.currency0, k.currency1] : [k.currency1, k.currency0]
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cin, exactIn ? amount.exactIn : amount.maxIn])
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cout, exactIn ? amount.minOut : amount.exactOut])
  const v4Input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [exactIn ? '0x060c0f' : '0x080c0f', [swap, settle, take]])
  const commands: Hex = permit ? '0x0a10' : '0x10'
  const inputs = permit ? [encodeAbiParameters([PERMIT_SINGLE_ABI, { type: 'bytes' }], [permit.permitSingle, permit.signature]), v4Input] : [v4Input]
  return encodeFunctionData({ abi: UR_ABI, functionName: 'execute', args: [commands, inputs, deadline] })
}
const UR_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable'])

// PositionManager.modifyLiquidities unlockData for MINT_POSITION (0x02) ×n + SETTLE_PAIR (0x0d): several positions of one pool in one transaction,
// each with its own amountMax, one settlement of the summed deltas. ERC20 pairs only (no SWEEP). Same action bytes on Uniswap v4 and PancakeSwap Infinity CL.
export type MintSpec = { tickLower: number; tickUpper: number; liquidity: bigint; amount0Max: bigint; amount1Max: bigint }
export function encodeMintUnlockData(key: unknown, mints: MintSpec[], owner: Address, keyAbi: { type: 'tuple'; components: readonly { name: string; type: string }[] } = POOL_KEY_ABI): Hex {
  const k = key as PoolKey
  const encoded = mints.map((m) => encodeAbiParameters(
    [keyAbi, { type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' }] as any,
    [key, m.tickLower, m.tickUpper, m.liquidity, m.amount0Max, m.amount1Max, owner, '0x'],
  ))
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [k.currency0, k.currency1])
  const actions = ('0x' + '02'.repeat(mints.length) + '0d') as Hex
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [...encoded, settle]])
}

// unlockData for burning whole positions of one pool: BURN_POSITION (0x03) per position + TAKE_PAIR (0x11) to the recipient
export function encodeBurnUnlockData(key: { currency0: Address; currency1: Address }, positions: { id: bigint; amount0Min: bigint; amount1Min: bigint }[], recipient: Address): Hex {
  const burns = positions.map((p) => encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }], [p.id, p.amount0Min, p.amount1Min, '0x'],
  ))
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [key.currency0, key.currency1, recipient])
  const actions = ('0x' + '03'.repeat(positions.length) + '11') as Hex
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [...burns, take]])
}

// unlockData for collecting fees only: DECREASE_LIQUIDITY (0x01) with liquidity 0 per position (fees accrue as the delta) + TAKE_PAIR (0x11)
export function encodeCollectUnlockData(key: { currency0: Address; currency1: Address }, ids: bigint[], recipient: Address): Hex {
  const decreases = ids.map((id) => encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }], [id, 0n, 0n, 0n, '0x'],
  ))
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [key.currency0, key.currency1, recipient])
  const actions = ('0x' + '01'.repeat(ids.length) + '11') as Hex
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [...decreases, take]])
}

// PositionInfo packing (v4-periphery PositionInfoLibrary, same on PancakeSwap Infinity): poolId (200 bits) | tickUpper (24) | tickLower (24) | hasSubscriber (8)
export function decodePositionInfo(info: bigint) {
  const int24 = (x: bigint) => { const n = Number(x & 0xffffffn); return n >= 0x800000 ? n - 0x1000000 : n }
  return { tickLower: int24(info >> 8n), tickUpper: int24(info >> 32n) }
}

// Fee growth inside [lower, upper] from the global counters and the two ticks' feeGrowthOutside (v3-core Tick.getFeeGrowthInside; uint256 wraparound)
const U256 = (1n << 256n) - 1n
export function feeGrowthInside(tick: number, lower: number, upper: number, global: [bigint, bigint], outLower: [bigint, bigint], outUpper: [bigint, bigint]): [bigint, bigint] {
  const one = (i: 0 | 1) => {
    const below = tick >= lower ? outLower[i] : (global[i] - outLower[i]) & U256
    const above = tick < upper ? outUpper[i] : (global[i] - outUpper[i]) & U256
    return (global[i] - below - above) & U256
  }
  return [one(0), one(1)]
}
// Uncollected fees of a position: liquidity × (feeGrowthInside − feeGrowthInsideLast) / 2^128, difference taken modulo 2^256
export const feesOwed = (liquidity: bigint, inside: [bigint, bigint], last: [bigint, bigint]): [bigint, bigint] =>
  [(((inside[0] - last[0]) & U256) * liquidity) >> 128n, (((inside[1] - last[1]) & U256) * liquidity) >> 128n]
