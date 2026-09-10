import { createRequire } from 'node:module'

// DLMM 的 ESM 入口从 CommonJS Anchor 导入 BN，在 Node.js 下会加载失败。
// 使用 SDK 官方的 require 入口；该入口直接导出 DLMM 类及其辅助函数。
export const dlmmSdk = createRequire(import.meta.url)('@meteora-ag/dlmm') as typeof import('@meteora-ag/dlmm')
