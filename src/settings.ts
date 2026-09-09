// 网页"设置"页存的东西（settings.json，已 git 忽略）：fomo 账号的 Privy token、Telegram、FomoScan key。
// 和 .env 的关系：同名项设置页优先，没填才退回 .env。token 一类的值只在这里落盘，接口只回"配没配 + 末 4 位"，不把原值回给页面
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export type Settings = {
  fomo: { token: string; refreshToken: string; updatedAt: number }
  telegram: { botToken: string; chatId: string }
  fomoscan: { key: string }
}
const FILE = new URL('../settings.json', import.meta.url)
const blank = (): Settings => ({ fomo: { token: '', refreshToken: '', updatedAt: 0 }, telegram: { botToken: '', chatId: '' }, fomoscan: { key: '' } })
const store: Settings = (() => { const b = blank(); if (!existsSync(FILE)) return b; try { const j = JSON.parse(readFileSync(FILE, 'utf8')); return { fomo: { ...b.fomo, ...j.fomo }, telegram: { ...b.telegram, ...j.telegram }, fomoscan: { ...b.fomoscan, ...j.fomoscan } } } catch { return b } })()
export const settings = () => store
export function saveSettings() { writeFileSync(FILE, JSON.stringify(store, null, 1) + '\n') }
export const tgConfig = () => ({ botToken: store.telegram.botToken || process.env.TG_BOT_TOKEN || '', chatId: store.telegram.chatId || process.env.TG_CHAT_ID || '' })
export const fomoscanKey = () => store.fomoscan.key || process.env.FOMOSCAN_KEY || ''
// 日志脱敏用：当前所有秘密值（会变，每次取）
export const secretValues = () => [store.fomo.token, store.fomo.refreshToken, store.telegram.botToken, store.fomoscan.key].filter((v) => v.length >= 8)
export const masked = (v: string) => (v ? `已填（…${v.slice(-4)}）` : '')
