// 网页"设置"页存的东西（settings.json，已 git 忽略）：Telegram、RPC 节点、Solana 选项、Uniswap API 地址、GMGN API key。
// 和 .env 的关系：同名项设置页优先，没填才退回 .env。key 一类的值只在这里落盘，接口只回"配没配 + 末 4 位"，不把原值回给页面。
// 命令行子进程也读这份文件（common.ts / sol/common.ts 经这里取生效值），所以网页里保存后，之后启动的任务立刻用新配置
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export type Settings = {
  telegram: { botToken: string; chatId: string }
  rpc: { ethereum: string; robinhood: string; bsc: string; arc: string; solana: string }  // 各链节点 URL（含 key）；EVM 链可以逗号分隔填多个，第一个为主、其余备用
  solana: { jupiterApiKey: string; priorityFee: string; historyTxs: string }
  api: { uniswapUrl: string }                                           // Uniswap Trading API 地址（默认官方网关）
  gmgn: { apiKey: string }                                              // GMGN OpenAPI key（只读数据：成交量 / 深度 / K 线，squeeze 形状用）
  squeeze: Record<string, string>                                       // squeeze 形状的 SQ_* 参数（键 = params.env 里的名字，值是字串；空 = 用 params.env / 默认）
}
const FILE = new URL('../settings.json', import.meta.url)
const blank = (): Settings => ({ telegram: { botToken: '', chatId: '' }, rpc: { ethereum: '', robinhood: '', bsc: '', arc: '', solana: '' }, solana: { jupiterApiKey: '', priorityFee: '', historyTxs: '' }, api: { uniswapUrl: '' }, gmgn: { apiKey: '' }, squeeze: {} })
const store: Settings = (() => {
  const b = blank()
  if (!existsSync(FILE)) return b
  try { const j = JSON.parse(readFileSync(FILE, 'utf8')); return { telegram: { ...b.telegram, ...j.telegram }, rpc: { ...b.rpc, ...j.rpc }, solana: { ...b.solana, ...j.solana }, api: { ...b.api, ...j.api }, gmgn: { ...b.gmgn, ...j.gmgn }, squeeze: { ...(j.squeeze ?? {}) } } } catch { return b }
})()
export const settings = () => store
export function saveSettings() { writeFileSync(FILE, JSON.stringify(store, null, 1) + '\n') }
export const tgConfig = () => ({ botToken: store.telegram.botToken || process.env.TG_BOT_TOKEN || '', chatId: store.telegram.chatId || process.env.TG_CHAT_ID || '' })
// 生效值：设置页优先，其次 .env；都空返回 ''（调用方退回公共节点 / 默认值）。
// 一个框里可以填多个地址（逗号 / 空白分隔）：rpcUrls 按顺序全给（EVM 链主节点 + 备用），rpcUrl 只取第一个（Solana 的连接只认一个）
export const splitUrls = (v: string) => v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
export const rpcUrls = (chain: keyof Settings['rpc'], envName: string) => splitUrls(store.rpc[chain] || process.env[envName] || '')
export const rpcUrl = (chain: keyof Settings['rpc'], envName: string) => rpcUrls(chain, envName)[0] ?? ''
export const solanaCfg = () => ({
  jupiterApiKey: store.solana.jupiterApiKey || process.env.JUPITER_API_KEY || '',
  priorityFee: store.solana.priorityFee || process.env.SOL_PRIORITY_FEE || '',
  historyTxs: store.solana.historyTxs || process.env.SOL_HISTORY_TXS || '',
})
export const squeezeOverrides = () => store.squeeze
export const gmgnApiKey = () => store.gmgn.apiKey || process.env.GMGN_API_KEY || ''
export const uniswapApiUrl = () => store.api.uniswapUrl || process.env.UNISWAP_API_URL || ''
// 日志脱敏用：当前所有秘密值（会变，每次取）。RPC URL 里含 Alchemy key，整条算秘密；多个地址各自算一条（错误信息里只会出现其中一个）
export const secretValues = () => [store.telegram.botToken, ...Object.values(store.rpc).flatMap(splitUrls), store.solana.jupiterApiKey, store.gmgn.apiKey].filter((v) => v.length >= 8)
export const masked = (v: string) => (v ? `已填（${splitUrls(v).map((u) => `…${u.slice(-4)}`).join('、') || `…${v.slice(-4)}`}）` : '')
