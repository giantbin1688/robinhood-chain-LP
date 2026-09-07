# CLAUDE.md — 给 Claude 的项目约定

Robinhood Chain 上的 Uniswap v4 一键 LP 工具（进场 / 监控 / 撤退 + 网页界面）。功能和用法看 README.md，链上地址和设计取舍看代码注释；这里只写做事的规矩。

## 临时文件：用完必须删

- 调试脚本、接口返回、日志、截图、临时安装的包，一律放在项目下的 `.scratch/`（已 git 忽略），不要散落在项目根目录、`/tmp` 或 `%TEMP%`。
- 每次任务结束前删掉 `.scratch/`，以及自己在别处建的任何东西。曾经在 `%TEMP%` 里遗留过 826 MB 的无头 Edge 配置目录和一个 Playwright 目录，用户为此专门提过意见。
- 需要真实浏览器验证网页时：Playwright 装到 `.scratch/pw/`，用 `chromium.launch({ channel: 'msedge', headless: true })` 调系统 Edge（不下载浏览器），`user-data-dir` 也放 `.scratch/`，测完整个目录删掉。别用 Edge 的 `--dump-dom`：页面有 SSE 长连接，会挂住不退出。
- 结束自己起的进程只按 PID（`taskkill //F //PID <pid>`），绝不 `taskkill /IM node.exe`——用户的网页服务常年跑在 3000 端口；测试统一用 `UI_PORT=3101`。用 PowerShell 按命令行匹配杀进程时必须同时限定 `$_.Name -eq 'msedge.exe'`，否则会把自己所在的 shell 一起杀掉。

## 保密

- `.env` 里是私钥和 API 密钥，`RPC_URL` 里含 Alchemy key：不读出来、不打印、不提交。测试输出先过 `sed -E 's#alchemy\.com/v2/[A-Za-z0-9_-]+#alchemy.com/v2/<key>#g'`。
- `.gitignore` 里的 `.env`、`positions.json`、`.scratch/` 保持不变，只提交 `.env.example`。

## 改完代码

- 跑 `npx tsc --noEmit` 和 `npm run selfcheck`（后者还会解析网页内联脚本的语法——曾因一个重复声明让整个页面停在"连接中…"）。
- 改了网页必须在真实浏览器里打开看一遍才算做完，只 curl 接口不算。
- 链上逻辑用 `--dry-run` 验证（有真 `.env` 也安全）；不要擅自发真实交易。
- 用户要求时才 commit / push（origin main）；提交信息用英文，正文说清为什么。

## 风格

- 和用户用中文交流；程序日志精简、中文、每笔交易一行（用户明确要求）。
- 用户要求全程自己做，不派子代理。
- 读链优先走用户的 Alchemy 节点（`RPC_URL`），公共节点只是备用；逐个 NFT / 逐个 tick 的只读调用用 `pub.multicall`，不要一个个发（Alchemy 免费档每秒 500 计算单元，公共节点连续全链扫描会 429）。
