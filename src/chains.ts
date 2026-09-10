// 链与协议的静态配置：地址、计价币、公共节点、区块浏览器。选哪条链 / 哪个协议由命令行 --chain / --protocol 或环境变量 CHAIN / PROTOCOL 决定
// 地址来源：Robinhood 的是本工具一直在用的；BSC 的取自 @pancakeswap/infinity-sdk、v3-sdk、universal-router-sdk、permit2-sdk，
// 并在链上核对过（CLPositionManager.clPoolManager()/vault()/permit2()、NPM/SwapRouter/QuoterV2 的 factory() 都互相指向）
import { getAddress, type Address } from 'viem'

export type ChainName = 'robinhood' | 'bsc' | 'ethereum'
export type ProtocolName = 'v4' | 'infinity' | 'v3'

export type Token = { address: Address; symbol: string; decimals: number }
export type ChainConfig = {
  name: ChainName; id: number; label: string
  native: { symbol: string; decimals: number }; wnative: Address
  quote: Token                       // LP 的计价币（Ethereum: USDC；Robinhood: USDG；BSC: USDT）
  publicRpc: string; rpcEnv: string  // 自己的节点从这个环境变量读
  explorer: string; gecko: string    // GeckoTerminal 的 network id
  okxChainIndex: number
  protocols: ProtocolName[]          // 这条链上支持的协议，第一个是默认
  multicall3: Address
  // 原生币的美元价：从一个稳定的 计价币/包装原生币 池读 tick（v4 用 poolId，v3 用池地址）
  nativePrice: { protocol: ProtocolName; fee: number; spacing: number }
  // 每个协议自己的合约；permit2 按协议而不是按链（BSC 上 Uniswap 用 0x22D4…，PancakeSwap 用自己部署的 0x31c2…）
  // urMinHop：UniversalRouter 2.1.1 的 v4 swap 参数多一个 minHopPriceX36 字段（Robinhood 只有 2.1.1）；2.0 及 PancakeSwap 的没有
  contracts: Partial<Record<ProtocolName, { permit2: Address; urMinHop?: boolean } & Record<string, Address | boolean | undefined>>>
}

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address
const UNI_PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address // Uniswap 的 Permit2（各链同地址）
const PCS_PERMIT2 = '0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768' as Address // PancakeSwap 自己部署的 Permit2

export const CHAINS: Record<ChainName, ChainConfig> = {
  ethereum: {
    name: 'ethereum', id: 1, label: 'Ethereum Mainnet',
    native: { symbol: 'ETH', decimals: 18 }, wnative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    quote: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
    publicRpc: 'https://ethereum-rpc.publicnode.com', rpcEnv: 'ETH_RPC_URL',
    explorer: 'https://etherscan.io', gecko: 'eth', okxChainIndex: 1,
    protocols: ['v4', 'v3'], multicall3: MULTICALL3,
    nativePrice: { protocol: 'v3', fee: 500, spacing: 10 },
    // Uniswap sdk-core 主网部署；UniversalRouter 2.1.1（对应 minHopPriceX36 编码）。
    contracts: {
      v4: {
        permit2: UNI_PERMIT2, urMinHop: true,
        poolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
        positionManager: getAddress('0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e'),
        stateView: getAddress('0x7ffe42c4a5deea5b0fec41c94c136cf115597227'),
        quoter: getAddress('0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203'),
        universalRouter: '0x4C82D1fBFe28C977cBB58D8C7FF8FCF9F70a2cCA',
      },
      v3: {
        permit2: UNI_PERMIT2,
        factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', deployer: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
        positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
        // 原版 SwapRouter 带 deadline；不使用参数结构不同的 SwapRouter02。
        swapRouter: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
        quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
      },
    },
  },
  robinhood: {
    name: 'robinhood', id: 4663, label: 'Robinhood Chain',
    native: { symbol: 'ETH', decimals: 18 }, wnative: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    quote: { address: getAddress('0x5fc5360d0400a0fd4f2af552add042d716f1d168'), symbol: 'USDG', decimals: 6 },
    publicRpc: 'https://rpc.mainnet.chain.robinhood.com', rpcEnv: 'RPC_URL',
    explorer: 'https://robinhoodchain.blockscout.com', gecko: 'robinhood', okxChainIndex: 4663,
    protocols: ['v4'], multicall3: MULTICALL3,
    nativePrice: { protocol: 'v4', fee: 500, spacing: 10 },
    // 从 @unipcs 钱包（0x0a6e…119e）的历史交易里核对：每笔买入代币都由 0xb92f… 转入，卖出的 USDG 都进 0x4cd0…；tx.to 都是 EntryPoint v0.8
    contracts: {
      v4: {
        permit2: UNI_PERMIT2, urMinHop: true,
        poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951', positionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
        stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b', quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
        universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904', // UniversalRouter 2.1.1
      },
    },
  },
  bsc: {
    name: 'bsc', id: 56, label: 'BNB Smart Chain',
    native: { symbol: 'BNB', decimals: 18 }, wnative: getAddress('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'),
    quote: { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 },
    publicRpc: 'https://bsc-rpc.publicnode.com', rpcEnv: 'BSC_RPC_URL', // bsc-dataseed.binance.org 在国内直连不通
    explorer: 'https://bscscan.com', gecko: 'bsc', okxChainIndex: 56,
    protocols: ['infinity', 'v3', 'v4'], multicall3: MULTICALL3,
    nativePrice: { protocol: 'v3', fee: 500, spacing: 10 },
    contracts: {
      infinity: {
        permit2: PCS_PERMIT2,
        vault: '0x238a358808379702088667322f80aC48bAd5e6c4', poolManager: '0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b',
        positionManager: '0x55f4c8abA71A1e923edC303eb4fEfF14608cC226', quoter: '0xd0737C9762912dD34c3271197E362Aa736Df0926',
        universalRouter: '0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB',
      },
      // Uniswap v4 在 BSC 的部署（@uniswap/sdk-core CHAIN_TO_ADDRESSES_MAP[56]；UR 2.1.1 取自 @uniswap/universal-router-sdk）。
      // 链上核对：PositionManager / StateView / Quoter 的 poolManager() 一致，PositionManager.permit2() = Uniswap 的 Permit2
      v4: {
        permit2: UNI_PERMIT2, urMinHop: true,
        poolManager: getAddress('0x28e2ea090877bf75740558f6bfb36a5ffee9e9df'), positionManager: getAddress('0x7a4a5c919ae2541aed11041a1aeee68f1287f95b'),
        stateView: getAddress('0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4'), quoter: getAddress('0x9f75dd27d6664c475b90e105573e550ff69437b0'),
        universalRouter: '0x8B844f885672f333Bc0042cB669255f93a4C1E6b', // UniversalRouter 2.1.1（BSC 也有 2.0 的 0x1906…，2.1.1 才带 minHopPriceX36）
      },
      v3: {
        permit2: PCS_PERMIT2,
        factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', deployer: '0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9',
        positionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364', swapRouter: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
        quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
      },
    },
  },
}

export const PROTOCOL_LABEL: Record<ProtocolName, string> = { v4: 'Uniswap v4', infinity: 'PancakeSwap Infinity', v3: 'PancakeSwap v3' }
export const protocolLabel = (chain: ChainName, protocol: ProtocolName) => chain === 'ethereum' && protocol === 'v3' ? 'Uniswap v3' : PROTOCOL_LABEL[protocol]

// 命令行 --chain=x / --chain x（或环境变量 CHAIN），协议同理；不合法就报错退出
export function selectChain(argv = process.argv, env = process.env): { cfg: ChainConfig; protocol: ProtocolName } {
  const pick = (flag: string, fallback: string) => {
    const i = argv.findIndex((a) => a === `--${flag}` || a.startsWith(`--${flag}=`))
    if (i < 0) return fallback
    return (argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1] ?? '').trim().toLowerCase() || fallback
  }
  const chain = pick('chain', (env.CHAIN ?? 'robinhood').toLowerCase()) as ChainName
  const cfg = CHAINS[chain]
  if (!cfg) { console.error(`错误: --chain / CHAIN 只能是 ${Object.keys(CHAINS).join(' / ')}，当前 "${chain}"`); process.exit(1) }
  const protocol = pick('protocol', (env.PROTOCOL ?? '').toLowerCase() || cfg.protocols[0]) as ProtocolName
  if (!cfg.protocols.includes(protocol)) { console.error(`错误: ${cfg.label} 上 --protocol / PROTOCOL 只能是 ${cfg.protocols.join(' / ')}，当前 "${protocol}"`); process.exit(1) }
  return { cfg, protocol }
}
