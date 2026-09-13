// 扫描：拉 GMGN 数据 + 读目标计价币池的链上储备，打印 squeeze 形状的指标、闸门判定和推导出的形状参数，只读链、不建仓。
// npm run scan -- --chain robinhood --token <地址> [--usdg 500] [--pool <池id>] [--fee 4] [--json]
import { parseArgs } from 'node:util'
import { getAddress } from 'viem'
import { die, env, failFast, log, makeClients } from './common.ts'
import type { ChainName } from './chains.ts'
import { scanSqueeze } from './squeeze-scan.ts'
import { metricsText } from './strategy.ts'

failFast()
const { values: opt } = parseArgs({ options: { chain: { type: 'string', default: env('CHAIN', 'robinhood') }, protocol: { type: 'string' }, token: { type: 'string' }, usdg: { type: 'string', default: env('USDG_AMOUNT', '25') }, pool: { type: 'string', default: '' }, fee: { type: 'string', default: env('POOL_FEE', '') }, from: { type: 'string' }, json: { type: 'boolean', default: false } } })
const chain = (opt.chain ?? 'robinhood').toLowerCase()
if (!['robinhood', 'bsc', 'ethereum'].includes(chain)) die('--chain 只能是 robinhood / bsc / ethereum（GMGN 数据源不含 Solana）')
if (!opt.token || !/^0x[0-9a-fA-F]{40}$/.test(opt.token)) die('用法: npm run scan -- --chain robinhood --token <代币地址> [--usdg 500] [--pool <池id>] [--fee 4]')
const budget = Number(opt.usdg)
if (!(budget > 0)) die('--usdg 必须大于 0')
if (opt.pool && !/^0x[0-9a-fA-F]{64}$|^0x[0-9a-fA-F]{40}$/.test(opt.pool)) die('--pool 必须是池 id')
const c = await makeClients({ needKey: false, from: opt.from ?? '0x0000000000000000000000000000000000000001', chain: chain as ChainName, protocol: opt.protocol as any })
const r = await scanSqueeze(c, getAddress(opt.token), budget, { poolId: opt.pool || undefined, fee: opt.fee ? Math.round(Number(opt.fee) * 10_000) : undefined })
log(`GMGN ${chain} ${r.symbol} ${opt.token}（GMGN 主池 ${r.gmgnPool?.exchange ?? '?'} / ${r.gmgnPool?.quote ?? '?'}；目标池 ${r.pool ? `${r.pool.label} ${r.pool.id.slice(0, 10)}…${r.pool.truncated ? '（读取范围受限，储备偏低）' : ''}` : '无'}）`)
for (const l of metricsText(r.metrics)) log(l)
for (const w of r.warnings) log(`警告: ${w}`)
for (const g of r.gates) log(`${g.ok ? '✓' : '✗'} ${g.name}: ${g.text}`)
log(`${r.pass ? '闸门全部通过' : r.block ? '闸门未通过，真实进场会被拒绝（SQ_GATE_BLOCK=1）' : '闸门未通过，只提示不拦（SQ_GATE_BLOCK=0）'}，形状 ${r.plan.label}`)
if (opt.json) console.log('@@scan ' + JSON.stringify(r))
process.exit(0)
