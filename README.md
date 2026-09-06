# rh-uni — Robinhood Chain 一键换币 + 建池 + 组 LP

输入一个代币地址，一条命令在 Robinhood Chain 上自动完成：

1. **换币**：把预算中合适的份额 `USDG -> 代币`（Uniswap Trading API 找路由，UniversalRouter 成交，Permit2 签名授权，不需要单独 approve 给路由）
2. **建池 / 复用**：`代币/USDG` 的 Uniswap v4 池，手续费和 tick 间距由参数决定（默认 5% / 1000）；池子已存在则复用
3. **池价校正**：已有池的价格偏离市场价超过阈值时，先把池价推回市场价再组仓（见下文）
4. **组 LP**：在现价的指定区间（默认 -50% ~ +100%）mint 仓位，预算两边几乎用尽

只需要一个钱包（USDG + 少量 ETH 付 gas）和一个 Uniswap API key。

## 快速开始

```bash
npm install
copy .env.example .env      # Linux/macOS: cp .env.example .env
# 编辑 .env 填入 PRIVATE_KEY 和 UNISWAP_API_KEY；策略参数在 params.env

# 先演练（只打印计划，不发交易）
npm run launch -- --token 0x代币地址 --dry-run

# 正式执行（打印计划后输入 y 确认）
npm run launch -- --token 0x代币地址
```

## 配置文件

密钥和策略参数分成两个文件，`.env` 已被 `.gitignore` 排除，永远不要提交或分享它。

### `.env` — 密钥

| 变量 | 说明 |
|---|---|
| `PRIVATE_KEY` | 付款钱包私钥（`0x` 开头 64 位十六进制）。钱包里要有 `USDG_AMOUNT` 的 USDG 和少量 ETH |
| `UNISWAP_API_KEY` | Uniswap Trading API key，只用于问路由/拿交易数据，和钱包无关。免费申请：https://developers.uniswap.org/dashboard |
| `HTTPS_PROXY` | 可选。本机直连不了 `trade-api.gateway.uniswap.org` 时填本地代理，如 `http://127.0.0.1:7897` |
| `RPC_URL` | 可选，默认公共节点 `https://rpc.mainnet.chain.robinhood.com`。强烈建议换成自己的 Alchemy 等节点：实测每次请求 50ms vs 公共节点 260ms，整趟快一倍 |

### `params.env` — 策略参数

| 变量 | 默认 | 说明 |
|---|---|---|
| `USDG_AMOUNT` | `25` | LP 总预算（USDG）。工具按区间配比和实时报价算出该换多少代币，剩下的 USDG 直接进 LP |
| `POOL_FEE` | `5` | 池子手续费，百分比：`5` = 5%，`3` = 3%，`0.3` = 0.3% |
| `TICK_SPACING` | 空 | tick 间距。留空 = `POOL_FEE × 10000 / 50`（5%→1000、3%→600、1%→200）。只在建新池时生效，复用已有池时以链上为准 |
| `RANGE` | `-50%,+100%` | LP 区间，相对现价的百分比，写法见下 |
| `SWAP_SLIPPAGE` | `5` | 换币滑点 % |
| `LP_SLIPPAGE` | `5` | 组 LP 时最大投入量的余量 %，防止 mint 前价格小幅波动导致失败 |
| `MAX_DEVIATION` | `10` | 池价与市场价的最大偏离 %，超过就先校正池价 |

### `RANGE` 写法

| 想要 | 填写 | 结果 |
|---|---|---|
| 双边宽幅 -50% ~ +100% | `RANGE=-50%,+100%` | 默认值 |
| 双边 ±30% | `RANGE=-30%,+30%` | |
| 只做现价下方 | `RANGE=-50%` | 现价到 -50%，仓位全部是 USDG，相当于挂一排买单，不换币 |
| 只做现价上方 | `RANGE=+100%` | 现价到 +100%，仓位全部是代币，相当于挂一排卖单，预算全部换成代币 |

分隔符用逗号、空格或 `~` 都可以；单边只填一个数，负数往下、正数往上。

区间边界必须落在 tick 间距的格点上：远端边界向外取整（保证覆盖你要的范围），0% 那端向内取整（单边仓位不包含现价，保持纯单边）。5% 池的间距是 1000 tick ≈ 每格 10.5%，所以实际区间会比填的略宽、单边仓位离现价可能有最多一格的空档；计划里会打印实际区间。想更精确，建新池时把 `TICK_SPACING` 调小（如 `100`，每格 ≈ 1%）。区间不足一格会报错。

## 命令行参数

命令行参数只对本次运行生效，覆盖 `params.env` 的默认值：

```bash
npm run launch -- --token <地址> [--usdg 50] [--fee 3] [--spacing 600] [--range="-30%,+30%"] \
                  [--slippage 5] [--lp-slippage 5] [--max-deviation 10] [--yes] [--dry-run] [--from <地址>]
```

| 参数 | 说明 |
|---|---|
| `--token` | 代币合约地址（必填） |
| `--usdg` `--fee` `--spacing` `--range` `--slippage` `--lp-slippage` `--max-deviation` | 对应 `params.env` 里的同名参数 |
| `--dry-run` | 只打印计划，不发任何交易。没有私钥也能用，配合 `--from 0x地址` 指定钱包 |
| `--yes` | 跳过 y/N 确认 |

注意 `--range` 要写成 `--range="-30%,+30%"`（带 `=` 和引号），否则 `-30%` 会被当成另一个选项。

## 执行流程与日志

```
钱包 0x… | 53.14 USDG, 0.0287 ETH | ETH $2485
代币 WORTHLESS (Worthless Coin) 精度=18 地址 0x…
池子 WORTHLESS/USDG 费率=5% 间距=1000: 已存在，tick 346001 = 0.000942 USDG/WORTHLESS
市场价 0.00151 USDG/WORTHLESS，池价偏离 -37.5%
计划: 池价偏离 -37.5% 超过 10%，……把价格推到市场价
计划: 换币 ≈12.23 USDG -> ≈8119 WORTHLESS，LP ≈12.77 USDG + 全部拿到的 WORTHLESS
计划: 区间 ticks [334000, 349000] = 0.000698 .. 0.00313 USDG/WORTHLESS (-50% .. +100%)，滑点 换币 5% / LP 5%
确认执行? (y/N) y
换币 0x<hash> ... 成功，247422 gas $0.23
换币完成: 12.23 USDG -> 8050.12 WORTHLESS
授权 WORTHLESS -> Permit2 0x<hash> ... 成功，46296 gas $0.04
LP 价格: 池 tick 343480 = 0.00151 USDG/WORTHLESS
组LP: ticks [334000, 349000]，liquidity …，投入 12.76 USDG + 8050.12 WORTHLESS（上限 …），剩余 0.01 USDG + 0 WORTHLESS
组LP 0x<hash> ... 成功，365816 gas $0.34
完成: 仓位 2019256，池 0x…
      https://robinhoodchain.blockscout.com/tx/0x<hash>
gas 合计: 3 笔，0.000230 ETH ($0.57)
```

每笔交易一行，发送后原地追加结果；任何一笔失败会立刻退出并打印 explorer 链接。ERC20 → Permit2 的授权是链上交易，每个币种每个钱包只需一次；Permit2 → PositionManager / UniversalRouter 的额度用签名附在交易里，不单独发交易。首次跑一个代币通常 3 笔交易（授权、换币、组 LP），之后 2 笔。

## 池价校正

别人建的池价格常常是过时的。如果直接在偏离的价格上组 LP，套利者会立刻把价格推回市场价，等于你以低于/高于市价的价格被动成交。所以工具在组 LP 前把池价与市场价（Uniswap API 报价）做比较：

- 偏离 ≤ `MAX_DEVIATION`：直接组 LP。
- 偏离超过阈值、池内流动性够用：直接在这个池里做一笔 swap 把价格推回市场价。数量按恒定流动性模型计算，并用链上 Quoter 真实模拟核对；买入方向等于低价拿币。
- 偏离超过阈值、但池价到市场价之间没有流动性（典型情况：池里唯一的仓位边缘就在那里，swap 推不动）：先用约 1% 预算（最少 0.2 USDG）建一个覆盖这段空隙的单边"过渡仓位"，再通过它做一笔精确输出的 swap 把价格推到市场价。过渡仓位用完即弃，剩几美分粉尘，多花两笔 gas。
- 校正花费超过预算、或 3 轮后仍不达标：放弃，不组 LP，不花钱。

如果某个代币只有这一个池、没有别的市场，API 报价就是池价本身，偏离恒为 0，不会触发校正。

## 自检

```bash
npm run selfcheck    # 用链上一笔真实 mint 交易复算 tick / liquidity / 编码，逐字节比对
npm run typecheck
```

## 链上地址（Robinhood Chain, chainId 4663）

| 合约 | 地址 |
|---|---|
| USDG（6 位精度） | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| v4 PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| v4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| v4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| UniversalRouter 2.1.1 | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

## 注意事项

- `.env` 里是私钥，已被 `.gitignore` 排除，不要提交、不要截图分享。
- Robinhood Chain 上的 UniversalRouter 是 2.1.1，请求 Trading API 时不能带 `x-universal-router-version: 2.0`（会报错），本工具不发该 header。
- 新币风险自负：貔貅币能 mint 成功但卖不掉；池子薄时你的仓位可能就是主要流动性，退出会砸价；无常损失由 LP 承担。建议先用小预算试。
- 第一次跑某个代币会多几笔授权交易；Robinhood Chain gas 很便宜，整套流程通常不到 1 美元。
