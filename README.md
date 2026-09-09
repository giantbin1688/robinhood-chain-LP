# rh-uni — 一键 LP：进场 / 监控 / 撤退（Robinhood Chain · BNB Chain）

围绕一个代币做集中流动性 LP 的全套命令行工具 + 网页界面，三条命令覆盖整个生命周期。支持的链和协议：

| 链 | 协议（`--protocol`） | 计价币 | 说明 |
|---|---|---|---|
| Robinhood Chain（`--chain robinhood`，默认） | `v4` Uniswap v4 | USDG | 原有功能 |
| BNB Smart Chain（`--chain bsc`） | `infinity` PancakeSwap Infinity CLAMM（默认） | USDT | BSC 上成交最活跃的 CL 池多是带 hook 的动态费率池，本工具能复用它们（只是不能新建带 hook 的池） |
| | `v3` PancakeSwap v3 | USDT | BSC 成交量的主战场；费率只有 0.01 / 0.05 / 0.25 / 1% 四档 |
| | `v4` Uniswap v4 | USDT | 合约在、流动性很薄，主要用于工具直接复用的场景 |

链上差异（PoolKey 结构、Permit2 地址、路由编码、仓位 NFT 合约、手续费计算）都收在 `src/lp.ts` 的适配器后面，进场 / 监控 / 撤退 / 网页对三种协议是同一套逻辑。

| 命令 | 做什么 |
|---|---|
| `npm run launch -- --token 0x…` | **进场**：USDG 换币 → 建池（已有则复用，价格偏了先校正）→ 在现价区间组 LP |
| `npm run watch -- --token 0x…` | **监控**：盯着池价，跳出区间就自动撤退 + 卖币；你手动撤了它自动停。`--position` 可只盯指定仓位 |
| `npm run exit -- --token 0x…` | **撤退**：撤掉该代币全部仓位（本金 + 手续费），代币自动换回 USDG（Uniswap / OKX DEX 比价取高者）。`--position` 可只撤指定仓位 |

进场时加 `--watch` 可以一条龙：组完 LP 直接进入监控。只需要一个钱包（Robinhood：USDG + 少量 ETH；BSC：USDT + 少量 BNB）和聚合器密钥：Robinhood 上 Uniswap API key 够用，**BSC 上要配 OKX DEX 密钥**（Uniswap 的 Trading API 只看 Uniswap 自家的池，PancakeSwap 的深度它路由不到）。下文所有 `USDG` 在 BSC 上都读作 `USDT`。

## 快速开始

```bash
npm install
copy .env.example .env      # Linux/macOS: cp .env.example .env
# 编辑 .env 填入 PRIVATE_KEY 和 UNISWAP_API_KEY；策略参数在 params.env
```

典型流程：

```bash
# 1. 先演练（只打印计划，不发交易）
npm run launch -- --token 0x代币地址 --dry-run

# 2. 进场并直接进入监控（打印计划后输入 y 确认；之后终端保持打开）
npm run launch -- --token 0x代币地址 --watch

#    或者分开：先进场，再单独开监控
npm run launch -- --token 0x代币地址
npm run watch -- --token 0x代币地址

# 3. 任何时候想手动撤退（监控会自动发现并停止）
npm run exit -- --token 0x代币地址

# BSC：在每条命令前面加 --chain bsc [--protocol infinity|v3|v4]（或在 .env 里设 CHAIN / PROTOCOL 作默认）
npm run launch -- --chain bsc --protocol infinity --token 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82 --usdg 50 --dry-run
npm run exit   -- --chain bsc --protocol v3 --token 0x…
```

每条命令都支持 `--dry-run`（只看计划 / 模拟交易，不花钱）和 `--yes`（跳过确认）。

## 网页界面 `npm run ui`

不想敲命令的话，进场和撤退都可以在浏览器里点：

```bash
npm run ui          # 打开 http://127.0.0.1:3000（端口可用 UI_PORT 改）
```

- 页头的下拉框切换 **链**（Robinhood / BSC），进场页表单第一行选 **协议**（BSC 上：PancakeSwap Infinity / PancakeSwap v3 / Uniswap v4；Robinhood 只有 Uniswap v4，这一行不显示；每条链各自记住上次选的协议），仓位、日历、进场都按所选链显示，任务列表是全部链的（任务名前缀 `[BSC]` / `[RHC]`）；钱包余额、计价币（USDG / USDT）、原生币（ETH / BNB）随之切换，选择记在浏览器里。
- **进场**页：左侧表单（默认值来自 `params.env`），输入代币地址后右侧自动列出该代币在 GeckoTerminal 上的**全部池子**（v4 / v3 / 其他 DEX、USDG 或 WETH 计价），按流动性只显示前 10 个（其余点"显示其余"展开），每个池给出费率/间距、链上池价、流动性、24h 成交和 **24h 手续费**（成交 × 费率，就是这个池一天分给全体 LP 的钱；下面的百分比是它占流动性的比例，即整池每天的费率回报，选池看这个比看成交额直观）和**你的份额**（左侧预算投进去后占池子流动性的比例 = 预算 ÷ (流动性 + 预算)，以及按这个比例分到的预估日收；这是把预算摊到整池算的，做窄区间时实际更高；改预算实时重算），状态只标"可用 / 空池"，不能复用的（不是当前协议、计价不是 USDG、查不到 PoolKey）整行灰掉、鼠标悬停看原因；可复用的点"用这个池"就按池 id 指定这个池（带 hook 的池也行；之后手动改代币/费率/间距/池选择会取消指定）。GeckoTerminal 的流动性 / 成交量会滞后，所以可复用的池还会读一次链上流动性：现价处流动性为 0 的标成**空池**（Gecko 的旧数字归零、排到末尾，按钮变成"仍要用"），`POOL_SELECT=auto` 也不会复用空池——复用要先花预算 1% 纠价、之后也没成交量，不如按市场价新建一个不同间距的池。点"计划"先演练，右侧出现换币 / 池子 / 仓位 / 钱包四张卡片；确认无误再点"执行这个计划"（会弹一次确认）。勾上"继续监控"等于 `--watch`。改过参数必须重新计划才能执行。
- 进场页和仓位页底部的"运行"只显示一行状态（任务名、状态、最后一行日志），"在任务中查看"跳到任务页看完整日志，"展开日志"就地展开交易步骤表和日志。
- **仓位**页：页顶五格汇总——**投入价值**（各仓位存入 − 已撤本金）、**现金价值**（本金现值 + 未领手续费）、**手续费收益**（已领 + 未领）、**总盈亏**（= 现金价值 + 已领手续费 − 投入价值，也就是各仓位 uPNL 之和）、**DPR 日收益率**（总盈亏 ÷ Σ 各仓位投入×持仓天数，即按资金量和时间加权的每天收益率；小字给出加权持仓时长和只算手续费的日收益率）。下面是钱包名下所有 USDG 池的仓位，按形状分成 **Spot / Curve / Bid-Ask** 三个区（`positions.json` 里没记录形状的、包括不是本工具建的，都算 Spot）；Curve、Bid-Ask 区里同一次进场建的几段连在一起，组头一行给出整组的价值 / 手续费 / uPNL 和建仓交易，带**整组撤退**（同一个池合成 1 笔交易）和**整组监控**按钮。分区标题行和组头行都可以点击折叠 / 展开（默认全部平铺；折叠的组头会补一句几段在区间内），折叠状态记在浏览器里，刷新不丢。每个仓位一行：仓位（交易对、费率、id、持仓时间）、区间（USDG/代币，带现价标尺和在不在区间内）、**投入**、**价值**、**手续费**（已领 + 未领）、**uPNL**、**DPR**，以及操作按钮；美元一律 2 位小数，两种币的数量和手续费的已领/未领拆分鼠标悬停可见。uPNL = 现值 + 未领手续费 + 已领手续费 + 已撤本金 − 存入，每一笔都按发生当时的池价折算（不含进场换币的手续费/滑点）；**点 uPNL 数字展开资金明细**：这个仓位的每笔交易（加流动性 / 领手续费 / 撤流动性）的两种币数量、当时价值、当时池价和交易链接，最新在前。流水从链上重建（钱包和 PoolManager 之间的转账 + PoolManager 的 ModifyLiquidity 事件按仓位 id 归类），对任何仓位（包括不是本工具建的）都能算，但需要 `RPC_URL` 是 Alchemy 节点（用它的转账记录接口和历史状态）；不是的话 uPNL 显示"—"，持仓时间仍然有。点 id 展开**该仓位所在池子的流动性分布图**（蓝 = 现价下方的 USDG 侧，绿 = 现价上方的代币侧，淡色 = 你的区间外，悬停看每段数量）。每个仓位可"领取"手续费（只领手续费，本金不动，等于 `npm run exit -- --position <id> --collect`；确认框里可以勾选"顺便把领到的币卖成 USDG"，等于加 `--sell`）、"监控"（各仓位独立监控，跳出区间自动撤退）、"撤退"（只撤这一个、只卖撤出来的币；确认框里可以勾选"顺便把钱包里全部该币卖光"，等于加 `--sell-all`）。正在监控的仓位会标出是哪个任务在盯。工具栏的**"领取全部手续费"**一次领所有仓位（未领 ≥ $0.01 的）的手续费：所有池的领取合成 **1 笔交易**（`PositionManager.multicall`），然后（勾选了卖币的话）每种币按实际到账数量重新报价，所有卖币交易**同时广播、落在同一个区块**——广播前逐笔模拟，模拟不过的直接剔除不占 nonce；没卖出去的币（报不出价、模拟不过、上链回滚）随后逐个进入"卖出为止"的重试（见撤退一节），不影响别的币；等于 `npm run exit -- --position <id,id,…> --collect --sell` 跨代币一起给。
- **盈亏日历**页：已平仓仓位按平仓日排成月历（周一起，本地时间），每格是当天平掉的仓位各自整段盈亏（拿回本金 + 手续费 − 存入，每笔按当时池价折算）之和和胜负平数，页顶是本月盈亏 / 平仓数 / 胜率（盈亏在 ±1 分内算平，不计入胜率）/ 最好一天 / 最差一天，‹ › 切换月份，点某一天列出当天平掉的每个仓位（存入、拿回本金、手续费、盈亏、持仓时间、平仓交易）。"已平仓" = 流动性全部撤出的仓位，NFT 销没销毁都算（Uniswap 网页撤流动性不销毁 NFT）；只算 USDG 池的。撤出后拿到的代币再卖掉的盈亏不在这里（那是换币，不是 LP）。第一次打开要从创世块起读钱包全部 LP 交易并逐笔取当时池价，约半分钟，之后秒开；同样需要 Alchemy 的 `RPC_URL`。
- **任务**页：所有任务（进场 / 撤退 / 监控）的状态和日志，可随时停止。多个监控可以同时跑；进场和撤退的演练也可以随时跑。唯一限制是**真正发交易的进场/撤退同一时刻只能有一个**（两个进程各自缓存 nonce 会互相冲突），带监控的进场组完 LP 后就不再占这个名额；同一仓位也不允许开两个监控。
- 页面只是把表单拼成命令行、以子进程跑 `cli.ts` / `exit.ts` / `monitor.ts`（多一个 `--json` 开关用来喂卡片），交易逻辑和命令行完全相同。服务只监听本机 `127.0.0.1`，私钥仍只在 `.env` 里由子进程读取，浏览器看不到。关掉浏览器不影响正在跑的任务，重新打开能看到全部日志；关掉服务（Ctrl+C）会结束它启动的所有任务。

## 配置文件

密钥和策略参数分成两个文件。`.env` 和 `positions.json` 已被 `.gitignore` 排除，永远不要提交或分享 `.env`。

### `.env` — 密钥

| 变量 | 说明 |
|---|---|
| `PRIVATE_KEY` | 付款钱包私钥（`0x` 开头 64 位十六进制）。钱包里要有 `USDG_AMOUNT` 的 USDG 和少量 ETH |
| `UNISWAP_API_KEY` | Uniswap Trading API key，只用于问路由/拿交易数据，和钱包无关。免费申请：https://developers.uniswap.org/dashboard |
| `OKX_API_KEY` `OKX_SECRET_KEY` `OKX_API_PASSPHRASE` | 可选。撤退卖币时用 OKX DEX 聚合器和 Uniswap 比价（实测常比 Uniswap 多换回 1~2%）。在 https://web3.okx.com/onchainos 申请 |
| `RPC_URL` | 可选，默认公共节点 `https://rpc.mainnet.chain.robinhood.com`。强烈建议换成自己的 Alchemy 等节点：实测每次请求 50ms vs 公共节点 260ms，整趟快一倍。配了自己的节点后公共节点自动作为备用（节点限流/超时的请求改走公共节点） |
| `HTTPS_PROXY` | 可选。本机直连不了 `trade-api.gateway.uniswap.org` / `web3.okx.com` 时填本地代理，如 `http://127.0.0.1:7897` |

### `params.env` — 策略参数

| 变量 | 默认 | 说明 |
|---|---|---|
| `USDG_AMOUNT` | `25` | LP 总预算（USDG）。工具按区间配比和实时报价算出该换多少代币，剩下的 USDG 直接进 LP。钱包里已有的该代币按市场价折算计入预算（见"进场"末尾） |
| `POOL_FEE` | `5` | 池子手续费，百分比，最多 4 位小数：`5` = 5%，`3.9999` = 3.9999%，`0.3` = 0.3% |
| `POOL_SELECT` | `auto` | 配置的池不存在时：`auto` = 复用该币已有的 USDG 池（同费率优先，否则流动性 ≥ max($5k, 预算) 中日成交最大的）；`exact` = 只用配置的费率/间距，没有就新建 |
| `TICK_SPACING` | 空 | tick 间距。留空 = `POOL_FEE × 10000 / 50`（5%→1000、3%→600、1%→200）。只在建新池时生效，复用已有池时以链上为准 |
| `PRICE_RANGE` | 空 | LP 区间的**绝对价格**（USDG/代币）：`最低价,最高价`，如 `0.006,0.01`，和 Uniswap 网页的 Min/Max price 一样。填了就优先于 `RANGE`，写法见下 |
| `RANGE` | `-50%,+100%` | LP 区间，相对现价的百分比，写法见下 |
| `LP_SHAPE` | `spot` | 流动性形状：`spot` 一个仓位、区间内均匀；`curve` 同心嵌套、越靠现价越厚；`bidask` 两侧分段、越远越厚。见"形状" |
| `LP_LAYERS` | `3` | `curve` 的层数 / `bidask` 每侧的段数（2~8），每层一个仓位，全部在同一笔交易里创建 |
| `SWAP_SLIPPAGE` | `5` | 换币滑点 % |
| `SWAP_VIA` | `best` | 进场换币走哪家：`best`（Uniswap、OKX 都报价取多者）/ `okx` / `uniswap`。Uniswap 路由常常只认一个薄池报不出大单，OKX 通常能找到更深的路 |
| `LP_SLIPPAGE` | `5` | 组 LP / 撤 LP 时数量的余量 %，防止交易前价格小幅波动导致失败 |
| `MAX_DEVIATION` | `10` | 池价与市场价的最大偏离 %，超过就先校正池价（见"池价校正"） |
| `EXIT_SWAP_VIA` | `best` | 撤退时卖币走哪家：`best`（Uniswap、OKX 都报价取高者）/ `okx` / `uniswap` |
| `WATCH_INTERVAL` | `10` | 监控：每隔几秒检查一次池价 |
| `WATCH_CONFIRM` | `2` | 监控：连续几次检查都跳出区间才触发撤退（防单次插针） |
| `WATCH_UPPER_GRACE` | `600` | 监控：价格**涨破上沿**后再等几秒没回来才撤退。此时仓位已全是 USDG，等着没有价格风险，跌回来还能继续收手续费；`0` = 不等。跌破下沿不受此影响 |

手续费 + 间距共同决定"是哪个池"：3.9999% 和 4% 是两个不同的池。这条链上别人建池多用"间距 = 费率 ÷ 100"（1.9999% → 200），Uniswap 网页默认是 ÷ 50，所以同一个费率也可能对不上——`POOL_SELECT=auto` 就是为此：会用 pool id 反推出已有池的精确间距再复用。

### 区间写法：`PRICE_RANGE`（绝对价格）优先于 `RANGE`（百分比）

`PRICE_RANGE=最低价,最高价`（USDG 计价），和 Uniswap 网页填 Min price / Max price 一样。区间和现价的位置关系决定仓位形态，不用自己算换多少币：

| 现价 0.0178 时填 | 结果 |
|---|---|
| `PRICE_RANGE=0.006,0.01`（整体在现价下方） | 不换币，全部 USDG 挂在下方等价格跌进来（相当于一排买单） |
| `PRICE_RANGE=0.03,0.05`（整体在现价上方） | 预算全部换成代币挂在上方等价格涨上去（相当于一排卖单） |
| `PRICE_RANGE=0.012,0.03`（跨过现价） | 按区间几何拆分，一部分换币，两边都投入 |

等待型仓位（一开始就在区间外）监控会显示"等待进入区间"，价格进入区间后再离开才会触发撤退。

`RANGE` 是相对现价的百分比写法：

| 想要 | 填写 | 结果 |
|---|---|---|
| 双边宽幅 -50% ~ +100% | `RANGE=-50%,+100%` | 默认值 |
| 双边 ±30% | `RANGE=-30%,+30%` | |
| 只做现价下方 | `RANGE=-50%` | 现价到 -50%，仓位全部是 USDG，相当于挂一排买单，不换币 |
| 只做现价上方 | `RANGE=+100%` | 现价到 +100%，仓位全部是代币，相当于挂一排卖单，预算全部换成代币 |

分隔符用逗号、空格或 `~` 都可以；单边只填一个数，负数往下、正数往上。

区间边界必须落在 tick 间距的格点上：远端边界向外取整（保证覆盖你要的范围），0% 那端向内取整（单边仓位不包含现价，保持纯单边）。5% 池的间距是 1000 tick ≈ 每格 10.5%，所以实际区间会比填的略宽、单边仓位离现价可能有最多一格的空档；计划里会打印实际区间。想更精确，建新池时把 `TICK_SPACING` 调小（如 `100`，每格 ≈ 1%）。区间不足一格会报错。

### 形状：`LP_SHAPE` = `spot` / `curve` / `bidask`

v4 单个仓位在区间内每个 tick 流动性一样厚（`spot`）。`curve` 和 `bidask` 是把**同一个区间、同一份预算**拆成 `LP_LAYERS` 个仓位叠出来的形状，换币只做一次，然后所有仓位在**同一笔交易**里原子创建（PositionManager 一次 `modifyLiquidities` 带多个 MINT_POSITION，不需要额外合约），都记进 positions.json；撤退本来就是同一个池的仓位合成一笔交易：

| 形状 | 拆法 | 适合 |
|---|---|---|
| `curve` | 层层嵌套、都跨着现价，每层宽度减半、流动性相同：现价附近被所有层覆盖最厚，越往外越薄 | 预期在这个位置震荡：手续费大部分被内层吃到，冲出去了外层还在场；内层跳出后只剩外层在吃 |
| `bidask` | 现价两侧各分几段、互不重叠，第 k 段流动性是第 1 段的 k 倍：离现价越远越厚；含现价的那一格空着 | 预期要有大波动、方向不定：跌得越深买得越多、涨得越高卖得越多；横盘时没有手续费 |

单边区间（整体在现价一侧）也能用：`curve` 以靠近现价的那条边为中心往外嵌套，`bidask` 只铺那一侧。计划里会列出每个仓位的实际区间和资金占比；区间太窄时相邻层会取整到同一组 tick，自动合并。带 `--watch` 时监控盯的是这次建的全部仓位：任何一个"进入过区间后又跳出"都会整组撤退——`bidask` 的外段本来就是等价格来的，想让它们留着请不要勾监控、改用仓位页按仓位单独盯。

## 进场 `npm run launch`

```bash
npm run launch -- --token <地址> [--usdg 50] [--fee 3] [--spacing 600] [--pool <池id>] [--range="-30%,+30%"] [--shape curve] [--layers 3] \
                  [--slippage 5] [--lp-slippage 5] [--max-deviation 10] [--watch] [--yes] [--dry-run] [--from <地址>]
```

| 参数 | 说明 |
|---|---|
| `--token` | 代币合约地址（必填） |
| `--usdg` `--fee` `--spacing` `--price-range` `--range` `--slippage` `--lp-slippage` `--max-deviation` `--pool-select` | 临时覆盖 `params.env` 里的同名参数，只对本次生效 |
| `--pool` | 直接指定要用的池（v4 的 pool id），费率/间距以链上为准，不看 `--fee` / `--spacing` / `--pool-select`；网页里点"用这个池"就是传的这个。带 hook 的池只能这样指定（按费率/间距找的是不带 hook 的池） |
| `--watch` | 组完 LP 后不退出，继续监控本次建的仓位，跳出区间自动撤退（同一代币的其他仓位不管） |
| `--dry-run` | 只打印计划，不发任何交易。没有私钥也能用，配合 `--from 0x地址` 指定钱包 |
| `--yes` | 跳过 y/N 确认 |

注意 `--range` 要写成 `--range="-30%,+30%"`（带 `=` 和引号），否则 `-30%` 会被当成另一个选项；`--price-range="0.006,0.01"` 同理。

一次真实运行（8 秒，3 笔交易，gas 共 $0.62）：

```
23:36:52 钱包 0xbD81…A828 | 1626.298771 USDG, 0.026797 ETH | ETH $2477.30
23:36:52 代币 Investor (Investor) 精度=18 地址 0xa129…2Ed8
23:36:52 池子 Investor/USDG 费率=3.9999% 间距=800: 不存在，将创建
23:36:53 市场价 0.00113326 USDG/Investor
23:36:53 计划: 换币 ≈56.517674 USDG -> ≈49874.134779 Investor，LP ≈43.482326 USDG + 全部拿到的 Investor
23:36:53 计划: 区间 ticks [334400, 351200] = 0.000560196 .. 0.00300551 USDG/Investor (-50% .. +150%)，滑点 换币 5% / LP 5%
确认执行? (y/N) y
23:36:57 换币 0x<hash> ... 成功，194586 gas $0.18
23:36:57 换币完成: 56.517674 USDG -> 48682.022211 Investor
23:36:58 LP 价格: 新池初始价 tick 344170 = 0.00113145 USDG/Investor（市场探测价）
23:36:58 组LP: ticks [334400, 351200]，liquidity 4237451407992395，投入 42.241099 USDG + 48682.022211 Investor（上限 43.482326 / 48682.022211），剩余 1.241227 USDG + 0 Investor
23:36:59 授权 Investor -> Permit2 0x<hash> ... 成功，46201 gas $0.04
23:37:00 建池+组LP 0x<hash> ... 成功，439531 gas $0.40
23:37:00 完成: 仓位 2027534，池 0xb7bf…80c4（已记录到 positions.json，撤退: npm run exit -- --token 0xa129…2Ed8）
23:37:00       https://robinhoodchain.blockscout.com/tx/0x<hash>
23:37:00 gas 合计: 3 笔，0.000251 ETH ($0.62)
```

配置的池不存在而这个币已经有 USDG 池时，会先打印候选并说明复用了哪个：

```
00:22:52 已有 PROLOGUE/USDG 池: 1.9999%/200 流动性$151,255 日成交$255,348；5%/500 流动性$321,192 日成交$98,594；…
00:22:52 复用 PROLOGUE / USDG 2%（1.9999%/200，同费率）；只想用自己配置的费率请设 POOL_SELECT=exact
00:22:55 市场价 0.00720377 USDG/PROLOGUE（okx），池价偏离 +6.6%
00:22:58 计划: 换币 ≈148.379044 USDG -> OKX ≈19720.313383 PROLOGUE (Unknown Uniswap V3 Fork 100% + Uniswap V4 100%)，LP ≈851.620956 USDG + 全部拿到的 PROLOGUE
```

计划阶段就用真实数量向 Uniswap 和 OKX 两家报价：都找不到路、或价格冲击超过 20%，会在确认前直接停下，不花钱。

每笔交易一行，发送后原地追加结果；任何一笔失败会立刻退出并打印 explorer 链接。ERC20 → Permit2 的授权是链上交易，每个币种每个钱包只需一次；Permit2 → PositionManager / UniversalRouter 的额度用签名附在交易里，不单独发交易。首次跑一个代币通常 3 笔交易，之后 2 笔。每次 mint 的仓位 id 都会记到 `positions.json`，供监控和撤退使用。

组 LP 那笔如果因为池价变动回滚（换币本身会推动池价，套利者随即拉回），会自动等几秒重读池价、按手里的币重算流动性再发，最多 5 次。中途退出后直接重跑同一条命令即可：钱包里已有的代币会按市场价折算、从 `USDG_AMOUNT` 里扣掉，只补差额或不再换币，直接组 LP；已有代币价值超过预算时，只投入预算能装下的那部分代币（USDG 一侧按区间配比从钱包出），其余留在钱包。

## 监控 `npm run watch`

```bash
npm run watch -- --token 0x代币地址                  # 对该代币的全部仓位开监控（终端保持打开）
npm run watch -- --token 0x… --position 2070306      # 只盯这一个（或逗号分隔多个）仓位，触发时也只撤它
npm run watch -- --token 0x… --interval 5 --confirm 3  # 临时覆盖检查间隔 / 确认次数
npm run watch -- --token 0x… --upper-grace 0         # 涨破上沿也立刻撤，不等
npm run watch -- --token 0x… --dry-run               # 触发时只演练撤退，不发交易（用来验证）
```

每 `WATCH_INTERVAL` 秒读一次池子的 tick，判断主要仓位是否在区间内（忽略过渡仓位和粉尘）。连续 `WATCH_CONFIRM` 次跳出区间就自动执行撤退：撤仓 + 领手续费 + 代币卖成 USDG，然后进程结束。涨破上沿时仓位已全是 USDG，会再等 `WATCH_UPPER_GRACE` 秒（默认 10 分钟）看价格回不回来，期间回到区间就重新计时；跌破下沿是满仓代币，按 `WATCH_CONFIRM` 立刻止损。每分钟核对一次仓位是否还在：**你手动撤掉了，监控自动停止**。日志只在状态变化或每 5 分钟打一行，不刷屏；RPC 偶发出错会继续重试，连续 30 次失败才退出。Ctrl+C 随时停止，仓位不受影响。

`launch --watch` 只盯本次建的仓位，同一个代币可以开多个进程各做各的区间、各撤各的；按仓位监控时撤退只卖撤出来的币，钱包里原有的币不动。不带 `--position` 的 `watch` / `exit` 则是该代币全部仓位一起，并把钱包里的币全卖掉。

```
23:38:02 监控 Investor/USDG: 仓位 2027534 区间 0.000560196 .. 0.00300551，每 10s 检查，连续 2 次跳出区间即撤退（Ctrl+C 停止）
23:38:02 价格 0.00107401 USDG/Investor；仓位 2027534 区间 0.000560196 .. 0.00300551（距下沿 -47.8%，距上沿 +179.8%）区间内
```

跳出区间的两种情况：价格**跌破下沿**时仓位已全部变成代币，撤退等于止损卖出，所以不等；价格**涨破上沿**时仓位已全部变成 USDG，撤退等于止盈落袋（几乎没有代币可卖），多等一会儿没有损失，所以有宽限期。

## 撤退 `npm run exit`

```bash
npm run exit -- --token 0x代币地址 --dry-run    # 先看：找到哪些仓位、能拿回多少、两家卖币报价、模拟撤仓交易
npm run exit -- --token 0x代币地址              # 确认后执行
npm run exit -- --position 2027534              # 只撤某个仓位（逗号分隔可多个，自动识别代币），只卖撤出来的币
npm run exit -- --position 2027534 --sell-all   # 只撤这个仓位，但把钱包里全部该币（含仓位外的余额）一起卖光
npm run exit -- --token 0x… --keep-tokens       # 只撤仓位，不卖币
npm run exit -- --position 2027534 --collect    # 只领这个仓位的手续费，本金不动（可逗号分隔多个，可以是不同代币的仓位）
npm run exit -- --position 2027534 --collect --sell   # 领手续费，并把领到的代币卖成 USDG（USDG 那部分本来就是 USDG）；多个池/代币时领取合成 1 笔，卖币同时广播
npm run exit -- --token 0x… --via okx           # 指定卖币走 OKX（或 uniswap）
npm run exit -- --token 0x… --yes               # 跳过确认
```

流程：

1. **找仓位**：`--token` 模式下用 `positions.json` 记录 + 链上扫描 PositionManager 转给钱包的所有 NFT，只保留"仍归你所有、属于该代币/USDG 池、还有流动性"的（没记录的老仓位也能找到）；`--position` 模式只看指定的那些 id。
2. **撤仓**：同一个池的仓位合并成一笔交易，`BURN_POSITION` + `TAKE_PAIR`，本金和未领手续费一起到账；最少拿回量按 `LP_SLIPPAGE` 留余量，且在你确认之后按最新池价重算（等确认期间价格可能已经变了），发送前模拟不过或上链后仍回滚都等几秒重读池价重试，最多 5 次。过渡仓位的粉尘顺带回收。
3. **卖币**：`--token` 模式把钱包里该代币全部卖成 USDG；`--position` 模式只卖这次撤出来的。Uniswap 和 OKX DEX 同时报价，走能换回更多 USDG 的一家（OKX 还会顺带标记貔貅币）。**卖不掉就一直重试直到卖出**：报价失败、发送前模拟不过（典型是行情急跌时 "Min return not reached"——聚合器的报价已经过期）都不花钱，等 3、6、9…秒（最长 30 秒）按钱包实际余额重新报价再发；OKX 的报价因最低回报没达到失败过之后，它再比 Uniswap 高出超过滑点一半就当它是过期行情、改走 Uniswap。只有真正上链后回滚（花了 gas）连续 3 次才停下，币留在钱包里。想放弃就 Ctrl+C / 在任务页停止。
4. 打印共收回多少 USDG 和 gas。

演练模式会用 `estimateGas` 在链上模拟撤仓交易，确认编码无误：

```
23:34:51 钱包 0xbD81…A828 | 1626.298771 USDG, 0 ROBIN | ETH $2479.11
23:34:51 仓位 2024265: ROBIN/USDG 5% ticks [-320000, -311000]，≈227.174249 USDG + 13001.855366 ROBIN
23:34:51 计划: 撤 1 个仓位（1 笔交易），拿回 ≈227.174249 USDG + 13001.855366 ROBIN
23:34:51 计划: 卖出 ≈13001.855366 ROBIN：OKX ≈257.796604 USDG (Uniswap V4 - Community Hook 100%)；Uniswap ≈255.58358 USDG，走 okx
23:34:51 模拟撤仓 2024265: OK，gas 221121
23:34:51 演练模式，到此为止
```

## 池价校正（进场时自动处理）

别人建的池价格常常是过时的。如果直接在偏离的价格上组 LP，套利者会立刻把价格推回市场价，等于你以低于/高于市价的价格被动成交。所以进场前把池价与市场价（Uniswap API 报价）做比较：

- 偏离 ≤ `MAX_DEVIATION`：直接组 LP。
- 偏离超过阈值、池内流动性够用：直接在这个池里做一笔 swap 把价格推回市场价。数量按恒定流动性模型计算，并用链上 Quoter 真实模拟核对；买入方向等于低价拿币。
- 偏离超过阈值、但池价到市场价之间没有流动性（典型情况：池里唯一的仓位边缘就在那里，swap 推不动）：先用约 1% 预算（最少 0.2 USDG）建一个覆盖这段空隙的单边"过渡仓位"，再通过它做一笔精确输出的 swap 把价格推到市场价。过渡仓位用完即弃，撤退时一并回收，多花两笔 gas。
- 校正花费超过预算、或 3 轮后仍不达标：放弃，不组 LP，不花钱。

如果某个代币只有这一个池、没有别的市场，API 报价就是池价本身，偏离恒为 0，不会触发校正。

## 文件说明

| 文件 | 作用 |
|---|---|
| `src/cli.ts` | 进场命令 |
| `src/monitor.ts` | 监控命令（也被 `launch --watch` 调用） |
| `src/exit.ts` | 撤退命令（也被监控触发时调用） |
| `src/ui/server.ts` `src/ui/index.html` | 网页界面：本地服务 + 单页面，子进程跑上面的命令 |
| `src/chains.ts` | 链与协议配置：合约地址、计价币、公共节点、区块浏览器；`--chain` / `--protocol` 的解析 |
| `src/lp.ts` | 协议适配器接口（池子 / 池价 / 仓位 / 手续费 / mint / burn / collect / 池内换币 / 深度 / 流水），命令和网页只跟它打交道 |
| `src/lp-singleton.ts` | Uniswap v4 与 PancakeSwap Infinity CLAMM 的实现（同一套 singleton 架构，差别在 PoolKey 结构和状态读取合约） |
| `src/lp-v3.ts` | PancakeSwap v3 的实现（每个池一个合约、NonfungiblePositionManager、直接 ERC20 授权） |
| `src/common.ts` | 公共部分：客户端、Uniswap / OKX API、发交易与授权、仓位记录 |
| `src/v4.ts` | 集中流动性数学与 singleton 编码：tick / 流动性 / 手续费增长 / mint / burn / swap（三种协议共用） |
| `src/selfcheck.ts` | 离线自检：用链上一笔真实 mint 交易复算并逐字节比对 |
| `params.env` | 策略参数 |
| `.env` | 密钥（不进 git） |
| `positions.json` | 本地仓位记录（不进 git）；每条带 `chain` / `protocol`，没有的是早期的 Robinhood v4 记录 |

```bash
npm run selfcheck    # 自检
npm run typecheck    # 类型检查
```

## 链上地址

### Robinhood Chain（chainId 4663）

| 合约 | 地址 |
|---|---|
| USDG（6 位精度） | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| v4 PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| v4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| v4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| UniversalRouter 2.1.1 | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

### BNB Smart Chain（chainId 56）

地址来自 `@pancakeswap/infinity-sdk` / `v3-sdk` / `universal-router-sdk` / `permit2-sdk` 和 `@uniswap/sdk-core` / `universal-router-sdk`，并在链上核对过（PositionManager / StateView / Quoter 的 poolManager() 互相指向，PositionManager.permit2() 与下表一致）。

| 合约 | 地址 |
|---|---|
| USDT（18 位精度） | `0x55d398326f99059fF775485246999027B3197955` |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` |
| Infinity Vault / CLPoolManager | `0x238a358808379702088667322f80aC48bAd5e6c4` / `0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b` |
| Infinity CLPositionManager / CLQuoter | `0x55f4c8abA71A1e923edC303eb4fEfF14608cC226` / `0xd0737C9762912dD34c3271197E362Aa736Df0926` |
| PancakeSwap UniversalRouter / Permit2 | `0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB` / `0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768` |
| PancakeSwap v3 Factory / NonfungiblePositionManager | `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` / `0x46A15B0b27311cedF172AB29E4f4766fbE7F4364` |
| PancakeSwap v3 SwapRouter / QuoterV2 | `0x1b81D678ffb9C0263b24A97847620C99d213eB14` / `0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997` |
| Uniswap v4 PoolManager / PositionManager | `0x28e2ea090877bf75740558f6bfb36a5ffee9e9df` / `0x7a4a5c919ae2541aed11041a1aeee68f1287f95b` |
| Uniswap v4 StateView / Quoter | `0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4` / `0x9f75dd27d6664c475b90e105573e550ff69437b0` |
| Uniswap UniversalRouter 2.1.1 / Permit2 | `0x8B844f885672f333Bc0042cB669255f93a4C1E6b` / `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

## 注意事项

- `.env` 里是私钥和 API 密钥，已被 `.gitignore` 排除，不要提交、不要截图分享。
- Robinhood Chain 上的 UniversalRouter 是 2.1.1，请求 Trading API 时不能带 `x-universal-router-version: 2.0`（会报错），本工具不发该 header。
- 扫描钱包名下的仓位（撤退、监控、网页列表都要用）走 Alchemy 节点的 `alchemy_getAssetTransfers`（免费档也有，一次约 0.5 秒）；Robinhood 上节点不支持时退回公共节点全链 `eth_getLogs`。**BSC 链太长扫不动**：PancakeSwap v3 的仓位 NFT 可枚举（`tokenOfOwnerByIndex`），不依赖节点；Infinity 和 Uniswap v4 没有 `BSC_RPC_URL`（Alchemy）时只认 `positions.json` 里本工具建的仓位。BSC 的公共节点不提供历史状态和旧交易回执，资金流水 / 盈亏 / 日历同样需要 Alchemy。
- BSC 上 PancakeSwap Infinity 成交最活跃的池几乎都带 hook（动态费率，池名里的 0.205% 之类只是估计值，链上 `lpFee` 为 0，界面标"动态"）。本工具复用这类池时 PoolKey 从 PositionManager 的 `poolKeys` 反查，mint / burn / collect 走同一套动作；换币前用 Quoter 真实模拟，费率估计不准也不会多花钱。新建池只能是无 hook 的标准档。
- `poolKeys` 只记录有人通过 PositionManager 建过仓的池。Robinhood 上发行平台直接调 PoolManager 建的池（带 hook 的动态费池，近期新池约四分之一是这种）查不到时，退到公共节点按 poolId 过滤 PoolManager 的 `Initialize` 事件拿 PoolKey（过滤够窄，全链范围也只要零点几秒；Alchemy 免费档 `eth_getLogs` 限 10 个区块，走不了）。这类池 GeckoTerminal 常常没收录，网页列表里不会出现，可以拿 poolId 用 `--pool` 直接指定。
- BSC 上换币走 OKX DEX 聚合器（`OKX_API_KEY` 等三项）；Uniswap Trading API 在 BSC 只路由 Uniswap 自家的池。
- 本机直连不了 `alchemy.com` 的话在 `.env` 里填 `HTTPS_PROXY`，否则 Alchemy 节点会一直超时、退回公共节点。
- 新币风险自负：貔貅币能 mint 成功但卖不掉；池子薄时你的仓位可能就是主要流动性，退出会砸价；无常损失由 LP 承担。建议先用小预算试。
- Robinhood Chain gas 很便宜，进场 + 撤退整套流程通常不到 1.5 美元。
