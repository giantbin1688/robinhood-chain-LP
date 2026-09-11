# rh-uni — 一键 LP：进场 / 监控 / 撤退

围绕一个代币做集中流动性 LP：换币 → 建池或复用池（价格偏了先校正）→ 在现价附近组 LP → 盯价 → 跳出区间自动撤退卖回。命令行 + 网页界面。

| 命令 | 做什么 |
|---|---|
| `npm run launch -- --token <地址>` | **进场**：换币 → 建池 / 复用池 → 组 LP。加 `--watch` 直接转监控 |
| `npm run watch -- --token <地址>` | **监控**：跳出区间自动撤退；你手动撤了它自动停 |
| `npm run exit -- --token <地址>` | **撤退**：撤仓 + 领手续费 + 卖回。`--percent 40` 只撤一部分 |

通用开关：`--dry-run`（只打印计划 / 链上模拟，不花钱，无私钥也能跑，配 `--from <地址>`）、`--yes`（跳过确认）、`--position <id,…>`（限定到指定仓位）。

## 支持的链和协议

| `--chain` | `--protocol` | 计价币 | 备注 |
|---|---|---|---|
| `ethereum` | `v4` Uniswap v4（默认）· `v3` Uniswap v3 | USDC | v3 费率 0.01 / 0.05 / 0.3 / 1% |
| `robinhood`（默认） | `v4` Uniswap v4 | USDG | 费率间距任意，gas 极便宜 |
| `bsc` | `infinity` PancakeSwap Infinity（默认）· `v3` PancakeSwap v3 · `v4` Uniswap v4 | USDT | v3 是成交主战场（费率 0.01 / 0.05 / 0.25 / 1%）；Infinity 活跃池多带 hook：能复用不能新建 |
| `solana` | `dlmm` Meteora DLMM（默认）· `clmm` Raydium CLMM | SOL 或 USDC | DLMM 按 bin、动态费率、仓位是账户；CLMM 按 tick、固定费率、仓位是 NFT |

下文 `USDG` 按链读作 USDT / USDC / SOL。一条链一个钱包：计价币 + 少量原生币付 gas。换币路由 Robinhood / Ethereum 用 Uniswap API，**BSC 必须配 OKX 密钥**（Uniswap 路由不到 PancakeSwap 的深度），Solana 用 Jupiter（免 key）。

EVM 三种协议的差异收在 `src/lp.ts` 适配器后面；Solana 账户模型不同，`src/sol/` 是平行实现，命令、参数、网页一致。

## 快速开始

```bash
npm install
cp .env.example .env     # 填 PRIVATE_KEY 和 UNISWAP_API_KEY；策略参数在 params.env

npm run launch -- --token 0x… --dry-run    # 先演练
npm run launch -- --token 0x… --watch      # 进场并保持监控
npm run exit   -- --token 0x…              # 手动撤退

# 换链：加 --chain [--protocol]，或在 .env 里设 CHAIN / PROTOCOL 作默认
npm run launch -- --chain bsc --protocol infinity --token 0x0E09… --usdg 50 --dry-run
npm run launch -- --chain solana --token DezX… --usdg 0.5 --fee 1 --dry-run   # 填 mint，--usdg 是 SOL 数量
```

## 网页界面 `npm run ui`

打开 `http://127.0.0.1:3000`（`UI_PORT` 可改）。页面把表单拼成命令行、以子进程跑同样的命令，交易逻辑完全相同；只监听本机，私钥仍只由子进程从 `.env` 读。关浏览器不影响在跑的任务，关服务会结束它们。

顶栏切链、进场页选协议和计价币（各链各记上次选择），右上一排状态灯（节点绿=Alchemy 黄=公共、钱包、聚合器 key、事件流、信号源、任务），☾/☀ 明暗模式。

EVM 仓位的 Spot / Curve / Bid-Ask 是 `positions.json` 中的本地标签，不在链上，也不随 git 同步。另一台电脑发现没有本地记录的仓位时显示“未分类”，按同池、同一笔建仓交易分组；可以用仓位行的分类下拉框补充或修改，同组一起更新，只保存标签、不发送交易。跨电脑需要另行同步分类记录，`package-lock.json` 不存仓位信息。

日历统计的是 LP 仓位的存入、撤出本金和手续费估值，不等同于整次操作的现金收支（不含钱包闲置代币和 gas）。遇到 Uniswap 极限池价时，先按区块内事件顺序还原操作时价格；仍为极限价的撤仓，只在能核对紧随其后的同钱包卖币交易时使用实际成交价，并显示交易链接。没有可靠价格则暂不计算，不能把撤出的代币按零价记账。

Robinhood Uniswap v4 的进场页还提供 **池子 tick 明细**：选池后自动读取，或按左侧费率 / 间距点“读取 / 刷新”，不要求先持仓。显示同一区块的当前 tick、价格、每段 USDG / 代币数量和流动性 L；每行可合并 1 / 4 / 16 / 64 个 tick 间距，并可向两侧翻页。点击起止两行把精确边界填到左侧，也可手输 `下界,上界`；边界必须对齐池间距，之后仍先计划、再执行。命令行对应 `--tick-range=334000,349000`，优先于价格 / 百分比区间。显示数量是池内资产，不是本次投入；本次投入看演练计划。

- **进场**：左侧表单（默认值来自 `params.env`），右侧自动列出该代币在 GeckoTerminal 上的全部池子——费率/间距、池价、流动性、24h 成交和手续费、你的预算占池比例和预估日收；不能复用的灰掉（悬停看原因），现价处链上流动性为 0 的标"空池"。点"用这个池"按 pool id 指定（带 hook 的池只能这样用）。先"计划"出四张卡片，再"执行这个计划"。
- **仓位**：页顶五格汇总（投入 / 现金价值 / 手续费 / 总盈亏 / DPR 日收益率）。按 Spot / Curve / Bid-Ask 分区，同一次进场的几段成组、可整组撤退或监控、可折叠。每行给区间标尺、投入、价值、手续费、uPNL、DPR；点 uPNL 展开每笔资金明细（按当时池价折算），点 id 展开池子流动性分布图。每行可领手续费 / 监控 / 撤 % / 撤退，工具栏能把所有池的手续费合成 1 笔领完再卖币。资金流水从链上重建，**需要 Alchemy 节点**，否则 uPNL 显示"—"。
- **信号**：盯 [fomo.family](https://fomo.family) 头部交易者的买卖（Robinhood 用 rhtrenches.com、BSC 用 bsctrenches.com，Ethereum / Solana 暂无），来一笔记一条并提醒，能识别"别人买了塞进钱包"的假买入。买入的币自动做一遍安全检查（流动性、池龄、涨幅、买卖人数、可升级代理、owner、`mint`/`pause`/黑名单、貔貅模拟、$100 往返损耗），给出通过 / 注意 / 风险，悬停看理由。提醒走页面 toast + 桌面通知 + 可选 Telegram。只能盯数据源名单里的人。
- **盈亏日历**：已平仓仓位按平仓日排成月历，每格是当天整段盈亏和胜负平，页顶是本月盈亏 / 胜率 / 最好最差的一天，点某天看明细。第一次打开要读全部历史（EVM 约半分钟，Solana 1~3 分钟），之后秒开；同样需要 Alchemy。
- **设置**：Telegram、各链节点 RPC + Uniswap API 网关、Solana 选项（Jupiter key / 优先费 / 日历扫描笔数）。存 `settings.json`，**优先于 `.env`**，保存立即生效；密码框留空 = 不变，填 `-` = 清除。
- **任务**：全部任务的状态和日志，可随时停止。多个监控可并行，**真正发交易的进场 / 撤退同时只能有一个**（nonce 会冲突）。

## 配置

密钥在 `.env`，策略参数在 `params.env`。`.env`、`positions.json`、`signals.json`、`settings.json` 都不进 git——永远不要提交或分享 `.env`。

| `.env` | 说明 |
|---|---|
| `PRIVATE_KEY` | EVM 三链共用的钱包私钥（`0x` + 64 位） |
| `SOL_PRIVATE_KEY` | Solana 钱包私钥：base58 或 JSON 字节数组 |
| `UNISWAP_API_KEY` | 只用于问路由，和钱包无关：https://developers.uniswap.org/dashboard |
| `OKX_API_KEY` `OKX_SECRET_KEY` `OKX_API_PASSPHRASE` | 换币时和 Uniswap 比价（常多换回 1~2%），**BSC 必填**：https://web3.okx.com/onchainos |
| `RPC_URL` `BSC_RPC_URL` `ETH_RPC_URL` `SOL_RPC_URL` | 各链节点，可选，也能在设置页填。**建议用自己的 Alchemy**：快 5 倍，且资金流水 / 盈亏 / 日历依赖它的转账记录和历史状态。配了之后公共节点自动作备用 |
| `SOL_QUOTE` `JUPITER_API_KEY` `SOL_PRIORITY_FEE` `SOL_HISTORY_TXS` | Solana 选项，见下文 |
| `TG_BOT_TOKEN` `TG_CHAT_ID` | 可选，信号推 Telegram |
| `HTTPS_PROXY` | 可选，直连不了 alchemy / uniswap / okx 时填本地代理 |

| `params.env` | 默认 | 说明 |
|---|---|---|
| `USDG_AMOUNT` | `25` | LP 总预算（计价币）。钱包里已有的该代币按市价折算计入预算 |
| `POOL_FEE` | `5` | 池子费率 %，最多 4 位小数 |
| `TICK_SPACING` | 空 | tick 间距，留空 = `POOL_FEE × 200`。只在建新池时生效 |
| `POOL_SELECT` | `auto` | 配置的池不存在时：`auto` 复用该币已有的池（同费率优先，否则流动性 ≥ max($5k, 预算) 中日成交最大的）；`exact` 只用配置的费率，没有就新建 |
| `PRICE_RANGE` | 空 | 区间的绝对价格 `最低,最高`，如 `0.006,0.01`，优先于 `RANGE` |
| `RANGE` | `-50%,+100%` | 区间，相对现价的百分比 |
| `LP_SHAPE` `LP_LAYERS` | `spot` `3` | 流动性形状 / `curve` 的层数、`bidask` 每侧段数（2~8） |
| `SWAP_SLIPPAGE` `LP_SLIPPAGE` | `5` `5` | 换币滑点 % / 组 LP 和撤 LP 的数量余量 % |
| `SWAP_VIA` `EXIT_SWAP_VIA` | `best` | 换币 / 卖币走哪家：`best` 三方报价取优 / `okx` / `uniswap` / `pool`（Solana 上是 `jupiter` / `pool`） |
| `MAX_DEVIATION` | `10` | 池价与市场价的最大偏离 %，超过先校正 |
| `WATCH_INTERVAL` `WATCH_CONFIRM` | `10` `2` | 监控：几秒查一次 / 连续几次跳出才撤退（防插针） |
| `WATCH_UPPER_GRACE` | `600` | 涨破上沿后再等几秒（此时全是计价币，等着没风险）；跌破下沿不受影响 |

费率 + 间距共同决定"是哪个池"：3.9999% 和 4% 是两个池。别人建池的间距常和 Uniswap 网页默认的不一样，`POOL_SELECT=auto` 会用 pool id 反推已有池的精确间距再复用。

### 区间

区间和现价的位置关系决定仓位形态，不用自己算换多少币：

| 现价 0.0178 时填 | 结果 |
|---|---|
| `PRICE_RANGE=0.006,0.01`（全在下方） | 不换币，全部计价币挂着等跌进来（一排买单） |
| `PRICE_RANGE=0.03,0.05`（全在上方） | 预算全换成代币等涨上去（一排卖单） |
| `PRICE_RANGE=0.012,0.03`（跨现价） | 按几何拆分，一部分换币，两边都投 |
| `RANGE=-30%,+30%` / `RANGE=-50%` | 百分比写法，双边 / 单边（单边只填一个数，负往下正往上） |

一开始就在区间外的仓位监控会显示"等待进入区间"，进入后再离开才撤退。边界必须落在间距格点上（远端向外取整、0% 那端向内取整），所以实际区间会略宽、计划里会打印；想更精确就把 `TICK_SPACING` 调小。

### 形状

`curve` / `bidask` 是把**同一个区间、同一份预算**拆成 `LP_LAYERS` 个仓位叠出来的形状，换币只做一次，所有仓位同一笔交易原子创建：

- `curve`：层层嵌套、都跨现价，每层宽度减半、流动性相同 → 现价附近最厚。适合预期震荡。
- `bidask`：两侧各分几段、互不重叠，第 k 段是第 1 段的 k 倍 → 越远越厚，含现价那格空着。适合预期大波动、方向不定。

单边区间也能用。带 `--watch` 时**任何一段进入过区间又跳出就整组撤退**——想让 `bidask` 的外段留着，别勾监控，改在仓位页按仓位单独盯。

## 命令详解

```bash
# 进场：--usdg --fee --spacing --price-range --range --shape --layers --slippage --lp-slippage
#       --max-deviation --pool-select 都是临时覆盖 params.env
npm run launch -- --token <地址> [--pool <池id>] [--range="-30%,+30%"] [--shape curve] [--watch]

# 监控
npm run watch -- --token 0x… [--position 2070306] [--interval 5] [--confirm 3] [--upper-grace 0]

# 撤退
npm run exit -- --token 0x… [--dry-run]              # 该代币全部仓位，钱包里的币也全卖掉
npm run exit -- --position 2027534 [--sell-all]      # 只撤这些仓位、只卖撤出来的币（--sell-all 连钱包余额一起卖）
npm run exit -- --position 2027534 --percent 40      # 只撤 40% 流动性，手续费全领，NFT 保留继续做 LP
npm run exit -- --position 2027534 --collect [--sell]  # 只领手续费，本金不动（可跨代币，领取合成 1 笔）
npm run exit -- --token 0x… --keep-tokens --via okx   # 不卖币 / 指定卖币走哪家
```

- `--pool` 直接指定池 id，费率间距以链上为准（带 hook 的池只能这样用）；`--range` 必须写成 `--range="-30%,+30%"`，否则 `-30%` 会被当成选项。
- 计划阶段就用真实数量向各家报价，都找不到路或冲击超 20% 就在确认前停下，不花钱。
- 交易每笔一行。ERC20 → Permit2 的授权每个币每个钱包只需一次（首次 3 笔，之后 2 笔）；Permit2 → PositionManager / Router 用签名，不单独发交易。
- 组 LP 那笔若因池价变动回滚，自动重读池价重算再发，最多 5 次。中途退出重跑同一条命令即可：钱包里已有的代币折算进预算，只补差额。
- 仓位 id 记进 `positions.json`，供监控和撤退使用。
- 监控每分钟核对仓位是否还在，你手动撤了就自动停；日志只在状态变化或每 5 分钟打一行；Ctrl+C 随时停，仓位不受影响。`launch --watch` 只盯本次建的仓位，同一代币可开多个进程各撤各的。
- 撤退时同池仓位合成一笔；最少拿回量在你确认之后按最新池价重算，模拟不过或回滚都重试。**卖币卖不掉就一直重试直到卖出**（报价失败和模拟不过都不花钱，退避到 30 秒重新报价），只有真正上链回滚连续 3 次才停下、币留在钱包。
- 演练会用 `estimateGas` / `simulateTransaction` 在链上模拟撤仓，确认编码无误。

一次真实进场（8 秒，3 笔交易，gas 共 $0.62）：

```
23:36:52 池子 Investor/USDG 费率=3.9999% 间距=800: 不存在，将创建
23:36:53 市场价 0.00113326 USDG/Investor
23:36:53 计划: 换币 ≈56.517674 USDG -> ≈49874.134779 Investor，LP ≈43.482326 USDG + 全部拿到的 Investor
23:36:53 计划: 区间 ticks [334400, 351200] = 0.000560196 .. 0.00300551 (-50% .. +150%)
确认执行? (y/N) y
23:36:57 换币 0x<hash> ... 成功，194586 gas $0.18
23:36:59 授权 Investor -> Permit2 0x<hash> ... 成功，46201 gas $0.04
23:37:00 建池+组LP 0x<hash> ... 成功，439531 gas $0.40
23:37:00 完成: 仓位 2027534，池 0xb7bf…80c4（已记录到 positions.json）
```

## 池价校正（进场时自动处理）

别人建的池价格常常过时，直接在偏离的价格上组 LP 等于被套利者按市价反向成交。所以偏离超过 `MAX_DEVIATION` 时：

- 池内流动性够用 → 在这个池里做一笔 swap 把价格推回市场价（用链上 Quoter 真实模拟核对）。
- 池价到市场价之间没有流动性 → EVM 上先用约 1% 预算建一个覆盖这段空隙的单边"过渡仓位"当跳板，用完即弃、撤退时回收；Solana 上直接放弃。
- 花费超预算或 3 轮不达标 → 放弃，不组 LP，不花钱。

某个代币只有这一个池时，报价就是池价本身，偏离恒为 0，不触发校正。

## Solana（Meteora DLMM / Raydium CLMM）

三条命令、`params.env` 的全部参数、网页的全部页面都能用，差异：

- **配置**：`SOL_PRIVATE_KEY` + 可选 `SOL_RPC_URL`。换币走 Jupiter 的免 key 接口，不用申请（`JUPITER_API_KEY` 可选）；`SOL_PRIORITY_FEE` 默认 100000（每计算单元微 lamport ≈ 一笔 0.00003 SOL）。Alchemy 免费档不给 `getProgramAccounts`，这一种请求自动改走公共节点。
- **计价币**：默认 `SOL_QUOTE=SOL`（meme 币几乎都对 SOL 建池），`USDG_AMOUNT` 就是 SOL 的数量；也可选 USDC。仓位页两种都列，美元按当时 SOL 价折算。
- **费率**：都是链上固定档，不能随便填（Meteora 来自 `presetParameter2`，`TICK_SPACING` 填 binStep；Raydium 来自 AmmConfig，0.01%~4%）。网页会列出档位并把配置改到最近的一档；没有对应档时只能复用已有池。Meteora 费率是动态的：基础费 + 随波动上浮。
- **形状**：DLMM 的 `spot`/`curve`/`bidask` 直接用它原生的同名策略（不用 `LP_LAYERS`）；Raydium 用和 EVM 相同的多层拆分。
- **租金**：超 70 个 bin 的 DLMM 区间拆成几笔交易。仓位账户约 0.057 SOL / 70 bin（关闭退还），没人建过的 bin 数组每个 0.075 SOL **不退**；Raydium 仓位约 0.01 SOL 可退、未初始化的 tick 数组每个约 0.07 SOL 不退。计划里会算出要留多少 SOL，不够就不发交易。
- **盈亏 / 日历**：流水从仓位账户的交易历史重建、事件用 Anchor IDL 解码，缺价格的退到 GeckoTerminal 分钟 K 线。已平仓仓位靠扫钱包最近 `SOL_HISTORY_TXS`（默认 800）笔交易找；`getTransaction` 限流紧，第一次打开日历 1~3 分钟。
- **仓位 id**：DLMM 是仓位账户地址，Raydium 是 NFT mint（44 位 base58），`--position` 用它们。
- **程序地址**：DLMM `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`、CLMM `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`、USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`、SOL 价来自 DLMM SOL/USDC 池 `5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6`。

## 注意事项

- 新币风险自负：貔貅币能 mint 成功但卖不掉；池子薄时你的仓位就是主要流动性，退出会砸价；无常损失由 LP 承担。先用小预算试。
- 链上地址在 `src/chains.ts`（EVM，取自各家官方 SDK 并在链上互相核对过）和上面的 Solana 一节。
- **Robinhood**：UniversalRouter 是 2.1.1，请求 Trading API 不能带 `x-universal-router-version: 2.0`。发行平台直接调 PoolManager 建的带 hook 池 `poolKeys` 查不到，退到公共节点过滤 `Initialize` 事件；这类池 Gecko 常没收录，可拿 poolId 用 `--pool` 指定。整套流程 gas 通常不到 $1.5。
- **BSC**：链太长扫不动仓位——PancakeSwap v3 的 NFT 可枚举，Infinity 和 Uniswap v4 没有 Alchemy 节点时只认 `positions.json` 里本工具建的仓位；公共节点也不给历史状态，流水 / 盈亏 / 日历需要 Alchemy。Infinity 活跃池几乎都带 hook（动态费率，链上 `lpFee` 为 0），能复用不能新建，换币前用 Quoter 真实模拟。
- **Solana**：租金部分不退，宽区间 DLMM 一次要几笔交易；SOL 计价时预算和租金从同一个余额出。

## 代码结构

| 文件 | 作用 |
|---|---|
| `src/run.ts` | 入口：按 `--chain` 把 launch / exit / watch 分派到 EVM 或 Solana |
| `src/cli.ts` `monitor.ts` `exit.ts` | EVM 的进场 / 监控 / 撤退 |
| `src/lp.ts` | 协议适配器接口（池 / 池价 / 仓位 / 手续费 / mint / burn / collect / 换币 / 深度 / 流水） |
| `src/lp-singleton.ts` `lp-v3.ts` | Uniswap v4 与 PancakeSwap Infinity / Uniswap v3 与 PancakeSwap v3 |
| `src/v4.ts` `shape.ts` | 集中流动性数学与编码 / 形状的多层拆分（EVM 与 Raydium 共用） |
| `src/chains.ts` `common.ts` `pools.ts` | 链与协议配置 / 客户端与聚合器与发交易 / GeckoTerminal 池子发现 |
| `src/sol/common.ts` | Solana 节点与钱包、发交易与模拟、代币元数据、SOL 价、Anchor 事件解码 |
| `src/sol/lp.ts` `dlmm.ts` `clmm.ts` | Meteora DLMM 与 Raydium CLMM 适配层 |
| `src/sol/cli.ts` `exit.ts` `monitor.ts` `swap.ts` `pools.ts` `history.ts` `ui.ts` | Solana 的三条命令、换币比价、池子发现、流水、网页数据 |
| `src/ui/server.ts` `index.html` | 网页：本地服务 + 单页面，子进程跑上面的命令 |
| `src/signals.ts` `rht.ts` | 信号：trenches 成交流、安全检查、Telegram |
| `src/settings.ts` | 设置页的配置（`settings.json`，优先于 `.env`，子进程也读） |
| `src/selfcheck.ts` | 离线自检：用链上真实交易逐字节比对编码，交叉验证 Solana 两家 SDK 的数学 |

```bash
npm run selfcheck    # 自检
npm run typecheck    # 类型检查
```
