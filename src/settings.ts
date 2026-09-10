// 网页"设置"页存的东西（settings.json，已 git 忽略）：Telegram、RPC 节点、Solana 选项、Uniswap API 地址。
// 和 .env 的关系：同名项设置页优先，没填才退回 .env。key 一类的值只在这里落盘，接口只回"配没配 + 末 4 位"，不把原值回给页面。
// 命令行子进程也读这份文件（common.ts / sol/common.ts 经这里取生效值），所以网页里保存后，之后启动的任务立刻用新配置
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export type Settings = {
  telegram: { botToken: string; chatId: string }
  rpc: { ethereum: string; robinhood: string; bsc: string; solana: string }               // 各链节点 URL（含 key）
  solana: { jupiterApiKey: string; priorityFee: string; historyTxs: string }
  api: { uniswapUrl: string }                                           // Uniswap Trading API 地址（默认官方网关）
}
const FILE = new URL('../settings.json', import.meta.url)
const blank = (): Settings => ({ telegram: { botToken: '', chatId: '' }, rpc: { ethereum: '', robinhood: '', bsc: '', solana: '' }, solana: { jupiterApiKey: '', priorityFee: '', historyTxs: '' }, api: { uniswapUrl: '' } })
const store: Settings = (() => {
  const b = blank()
  if (!existsSync(FILE)) return b
  try { const j = JSON.parse(readFileSync(FILE, 'utf8')); return { telegram: { ...b.telegram, ...j.telegram }, rpc: { ...b.rpc, ...j.rpc }, solana: { ...b.solana, ...j.solana }, api: { ...b.api, ...j.api } } } catch { return b }
})()
export const settings = () => store
export function saveSettings() { writeFileSync(FILE, JSON.stringify(store, null, 1) + '\n') }
export const tgConfig = () => ({ botToken: store.telegram.botToken || process.env.TG_BOT_TOKEN || '', chatId: store.telegram.chatId || process.env.TG_CHAT_ID || '' })
// 生效值：设置页优先，其次 .env；都空返回 ''（调用方退回公共节点 / 默认值）
export const rpcUrl = (chain: 'robinhood' | 'bsc' | 'ethereum' | 'solana', envName: string) => store.rpc[chain] || process.env[envName] || ''
export const solanaCfg = () => ({
  jupiterApiKey: store.solana.jupiterApiKey || process.env.JUPITER_API_KEY || '',
  priorityFee: store.solana.priorityFee || process.env.SOL_PRIORITY_FEE || '',
  historyTxs: store.solana.historyTxs || process.env.SOL_HISTORY_TXS || '',
})
export const uniswapApiUrl = () => store.api.uniswapUrl || process.env.UNISWAP_API_URL || ''
// 日志脱敏用：当前所有秘密值（会变，每次取）。RPC URL 里含 Alchemy key，整条算秘密
export const secretValues = () => [store.telegram.botToken, store.rpc.ethereum, store.rpc.robinhood, store.rpc.bsc, store.rpc.solana, store.solana.jupiterApiKey].filter((v) => v.length >= 8)
export const masked = (v: string) => (v ? `已填（…${v.slice(-4)}）` : '')
