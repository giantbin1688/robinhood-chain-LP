// 命令入口：按 --chain（或 CHAIN 环境变量）把 launch / exit / watch 分派到 EVM（cli.ts / exit.ts / monitor.ts）或 Solana（sol/ 下同名实现），其余参数原样透传。
// npm run launch -- --chain solana --token <mint> …   等价于   node … src/sol/cli.ts --chain solana --token <mint> …
const cmd = process.argv[2]
const files: Record<string, [string, string]> = { launch: ['./cli.ts', './sol/cli.ts'], exit: ['./exit.ts', './sol/exit.ts'], watch: ['./monitor.ts', './sol/monitor.ts'] }
if (!files[cmd]) { console.error('用法: run.ts launch|exit|watch [参数…]'); process.exit(1) }
process.argv.splice(2, 1)
const i = process.argv.findIndex((a) => a === '--chain' || a.startsWith('--chain='))
const chain = (i < 0 ? process.env.CHAIN ?? '' : process.argv[i].includes('=') ? process.argv[i].split('=')[1] : process.argv[i + 1] ?? '').trim().toLowerCase()
process.env.RH_MAIN = cmd // exit.ts / monitor.ts 用它判断自己是不是命令行入口（argv[1] 是这个文件，原来的判断认不出；进场会把它们当模块引入，所以要带命令名）
await import(files[cmd][chain === 'solana' ? 1 : 0])
