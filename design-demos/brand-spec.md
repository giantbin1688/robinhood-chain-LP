# brand-spec.md · rh-uni（Robinhood LP 工具）

> §1.a 核心资产协议产物。2026-09-08。
> 触发的是**第二类**：设计里要呈现多个真实可识别的协议 / 链 / 交易所品牌。

## 一、产品是什么

`rh-uni` —— 一个**自用**的集中流动性做市工具。不是面向公众的产品，没有自己的
品牌 VI，没有 logo。这一点很重要：**它不需要被"品牌化"，它需要被"仪表化"**。

- 跑在两条链上：Robinhood Chain（chainId 4663）、BNB Smart Chain（56）
- 支持三个协议：Uniswap v4、PancakeSwap Infinity、Uniswap v3
- 三个动作：进场（换币 + 建池 + 组 LP，一笔交易）/ 监控（跳出区间自动撤）/ 撤退
- 界面四页：进场、仓位、盈亏日历、任务

## 二、资产清单（全部已取到官方原件，无占位）

| 资产 | 文件 | 来源 | 校验 |
|---|---|---|---|
| Uniswap 独角兽 | `assets/uniswap.png` 240² | trustwallet/assets · UNI 合约 `0x1f98…F984` | 肉眼核对：粉色独角兽头像 ✓ |
| PancakeSwap 兔子松饼 | `assets/pancakeswap.png` 256² | trustwallet/assets · CAKE 合约 `0x0E09…cE82` | 肉眼核对：青底棕兔松饼 ✓ |
| BNB Chain 金立方 | `assets/bnbchain.png` 256² | trustwallet/assets · smartchain info | 肉眼核对：黑底金色立方 ✓ |
| USDG（Global Dollar） | `assets/usdg.png` 256² | trustwallet/assets · USDG 合约 | 肉眼核对：黑底白 G ✓ |
| USDT | `assets/usdt.png` 300² | trustwallet/assets · BSC USDT | ✓ |
| Robinhood 羽毛 | `assets/robinhood.svg` | simple-icons | ✓ |
| OKX | simple-icons `okx` | simple-icons | 备用，界面里只在「卖币走」下拉出现 |

**为什么必须有这些**：现在的界面里，「Uniswap v4 / PancakeSwap Infinity / v3」
只是下拉框里的三行纯文字。用户每天要在两条链、三个协议之间切，**切错协议 = 钱进错池子**。
把协议做成可辨认的图形标记，是功能需求，不是装饰。这条通过了"真图诚实性测试"：
去掉 logo，信息有损。

## 三、色板（全部从真实资产抽取，一个都不是临场发明）

抽取方法：PNG 调色板 `PLTE` chunk 直读 + simple-icons 官方 hex。

| 品牌 | 主色 | 抽取方式 |
|---|---|---|
| Uniswap | `#FE007A` | uniswap.png 调色板最饱和色（= 官方 Uniswap Pink #FF007A） |
| PancakeSwap | `#1CD1DF` | pancakeswap.png 调色板最饱和色（= 官方 #1FC7D4） |
| BNB Chain | `#F0B90B` / 底 `#0B0E11` | simple-icons 官方 hex |
| Robinhood | `#CCFF00` | simple-icons 官方 hex |
| OKX | `#000000` | simple-icons 官方 hex |

### 产品自身的既有色板（从 `src/ui/index.html` 现有 CSS 抽取，不是新发明）

现有界面已经有一套成熟的暖灰色系，三版初稿**全部继承**它作为底色，
只在结构、密度、层级上做差异——这样选中的那版才能迁回生产代码：

```
--bg        #f7f6f2   暖灰底
--text      #191918   近黑
--muted     #77756f   次要文字
--line      #deddd7   分隔线
--accent    #d97757   赤陶橙（主 accent）
--blue      #3565a8   链接 / 运行中
--red       #c6534f   亏损 / 危险
--green     #417a5b   盈利 / 正常
--amber     #9a6a2c   警告
```

## 四、禁区

- ❌ 不给这个工具编一个 logo —— 它没有品牌，编一个就是假的
- ❌ 协议 / 链的 logo 不许自己用 SVG 画（画出来的独角兽和兔子必然走形）
- ❌ 不引入紫渐变、emoji 图标 —— 现有界面本来就干净，别倒退
- ❌ 盈亏的红绿不许换成其他色 —— 用户看惯了，换了要出事故
- ⚠️ logo 必须 **base64 内嵌**（三版是可双击打开的单文件 HTML，相对路径会全员裂图）

## 五、气质定位

**不是 SaaS 落地页，是驾驶舱。** 参照物应该是彭博终端、券商交易端、飞机 PFD，
不是 Stripe 官网。用户打开它的时刻通常是：钱已经在池子里了，想知道亏没亏、
要不要撤。所以气质关键词：**冷静、可信、一眼看到关键数字、危险操作有重量感**。
