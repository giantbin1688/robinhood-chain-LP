# rh-uni — Robinhood Chain 一键 swap + 建池 + 组 LP

输入一个代币地址，一条命令完成：

1. 把预算中合适的份额 `USDG -> 代币` 交换（Uniswap Trading API 路由，走 UniversalRouter，Permit2 签名授权）
2. 创建 `代币/USDG` 的 Uniswap v4 池（手续费由 `.env` 的 `POOL_FEE` 决定，默认 5%，tickSpacing 默认 fee/50 → 1000）；已存在则复用
3. 在现价 **-50% ~ +100%**（`RANGE` 可改）区间 mint 流动性（PositionManager `multicall([initializePool?, modifyLiquidities])`）

## 准备

```bash
npm install
cp .env.example .env   # Windows: copy .env.example .env
```

两个配置文件，密钥和策略参数分开：

**`.env`（密钥，已 git-ignore）**

| 变量 | 说明 |
|---|---|
| `PRIVATE_KEY` | 付款钱包私钥（0x 开头）。需要 `USDG_AMOUNT` 的 USDG + 少量 ETH 付 gas |
| `UNISWAP_API_KEY` | Uniswap Trading API key（换币路由服务的密钥，和钱包无关）：https://developers.uniswap.org/dashboard |
| `HTTPS_PROXY` | 可选。若本机直连不了 `trade-api.gateway.uniswap.org`，填本地代理（如 `http://127.0.0.1:7897`） |

**`params.env`（策略参数，不含密钥）**

| 变量 | 说明 |
|---|---|
| `POOL_FEE` | 池子手续费，百分比：`5` = 5%，`3` = 3%，`0.3` = 0.3% |
| `TICK_SPACING` | 留空 = `fee/50`（5%→1000、3%→600、1%→200）；只在建新池时生效，复用已有池时以链上为准 |
| `USDG_AMOUNT` | LP 总预算（USDG）。工具按区间配比和实时报价算出该换多少代币，剩余 USDG 直接进 LP，目标是 mint 后两边都几乎用尽 |
| `RANGE` | 相对现价的区间：`-50%,+100%` 双边；只填 `-50%` = 只做现价下方（全部 USDG，相当于挂买单）；只填 `+100%` = 只做现价上方（全部代币，相当于挂卖单）。边界要落在 tick 间距的格点上：远端向外取整，0% 那端向内取整（单边仓位不含现价）。5% 池间距 1000 ≈ 每格 10.5%，想更精确建新池时把 `TICK_SPACING` 调小 |
| `SWAP_SLIPPAGE` | 换币滑点 %（默认 5） |
| `LP_SLIPPAGE` | 组 LP 时 amountMax 余量 %（默认 5） |
| `MAX_DEVIATION` | 池价与市场价最大偏离 %（默认 10），见下文"池价校正" |

## 运行

```bash
# 先看计划，不发交易（没有私钥也行，用 --from 指定钱包地址）
npm run launch -- --token 0xce221b17b872a5782be1b29305494a53e4985c9c --dry-run --from 0x你的地址

# 正式执行（会先打印计划，输入 y 确认）
npm run launch -- --token 0xce221b17b872a5782be1b29305494a53e4985c9c

# 命令行参数可临时覆盖 params.env 里的默认值
npm run launch -- --token <addr> [--usdg 25] [--fee 3] [--spacing 600] [--range="-50%,+100%"] [--slippage 5] [--lp-slippage 5] [--max-deviation 10] [--yes] [--dry-run] [--from <addr>]
```

- `--yes`：跳过确认；`--dry-run`：只打印计划
- 命令行里的区间要写成 `--range="-50%,+100%"`（带 `=` 和引号），否则 `-50%` 会被当成选项

## 池价校正（已有池的价格偏离市场价时）

别人建的池价格常常是过时的；直接在偏离的价格上组 LP，套利者会立刻把价格推回市场价，等于你以低于/高于市价的价格被动成交。工具在组 LP 前检查池价与市场价（Uniswap API 报价）的偏离：

- 偏离 ≤ `MAX_DEVIATION`：直接组 LP。
- 偏离超过阈值、池内流动性够用：直接在这个池里做一笔 swap 把价格推回市场价（数量按恒定流动性模型算，用 Quoter 真实模拟核对）。买入方向等于低价拿币。
- 偏离超过阈值、池价到市场价之间没有流动性（典型：唯一的 LP 仓位边缘就在那里）：先建一个约 1% 预算（最少 0.2 USDG）的单边"过渡仓位"覆盖这段空隙，再通过它做一笔精确输出的 swap 把价格推到市场价。过渡仓位用完即弃，剩几美分粉尘。
- 校正花费超过预算、或 3 轮后仍不达标：放弃，不组 LP。

## 自检

```bash
npm run selfcheck   # 用链上真实 mint 交易复算 tick/liquidity/编码，逐字节比对
npm run typecheck
```

## 链上地址（Robinhood Chain, chainId 4663）

| 合约 | 地址 |
|---|---|
| USDG (6 decimals) | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| v4 PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| v4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| UniversalRouter 2.1.1 | `0x8876789976decbfcbbbe364623c63652db8c0904`（由 API 返回，代码里不写死） |

## 注意

- RHC 上 UniversalRouter 是 2.1.1，请求 Trading API 时**不要**带 `x-universal-router-version: 2.0`（会报错），本工具不发该 header。
- 新币价格可被单笔交易操纵；池子已存在时以池内价格组仓，若与市场探测价偏离 >10% 会打印 WARNING。
- 交易失败会直接退出并打印 explorer 链接：https://robinhoodchain.blockscout.com
