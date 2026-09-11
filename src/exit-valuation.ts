// 极限池价不能用来给撤出的代币估值；只接受紧随撤仓、同钱包签发且有真实 USDG/USDT/USDC 到账的卖币交易（可以是连续几笔，累加到覆盖撤出数量）。
import { parseAbiItem, parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem'
import type { Clients } from './common.ts'
import { same } from './exit.ts'
export const transferEvent = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)')
// 撤仓后多久内、多少个 nonce 内的卖出算"紧随撤仓"：卖币循环报价失败时每次最多等 30 秒重试，暴跌时 OKX 报价恰好最容易失败，
// 一笔撤退（可能多个币、各自授权 + 换币）也会用掉好几个 nonce；窄了会把正常的撤退永久记成"暂不计算"。
// 搜索的区块范围要盖住整个时间窗口：Robinhood 约 10 块/秒，30 分钟 ≈ 18000 块（以前只搜 512 块 ≈ 50 秒，2 分钟后才卖出的就被判成永久无法估值）
const SALE_WINDOW_MS = 30 * 60_000, SALE_NONCE_SPAN = 12, SALE_WINDOW_BLOCKS = 20_000n
export function walletSale(receipt: Pick<TransactionReceipt,'logs'>, wallet: Address, token: Address, quote: Address) {
  let tokenNet=0n,quoteNet=0n
  for(const l of parseEventLogs({abi:[transferEvent],logs:receipt.logs})) {
    const net=(same(l.args.to,wallet)?l.args.value:0n)-(same(l.args.from,wallet)?l.args.value:0n)
    if(same(l.address,token)) tokenNet+=net
    if(same(l.address,quote)) quoteNet+=net
  }
  return tokenNet<0n&&quoteNet>0n?{sold:-tokenNet,received:quoteNet}:null
}
export function saleTick(sold: bigint, received: bigint, tokenIs0: boolean) {
  if(sold<=0n||received<=0n) throw new Error('卖币数量或到账金额无效')
  const ratio=Number(received)/Number(sold)
  const tick=Math.log(tokenIs0?ratio:1/ratio)/Math.log(1.0001)
  if(!Number.isFinite(tick)) throw new Error('实际成交价格无效')
  return tick // 保留小数，估值不按交易 tick 取整
}
export async function exitValuation(c:Clients,o:{tx:Hex;block:bigint;time:number;token:Address;tokenIs0:boolean;withdrawnToken:bigint}) {
  if(o.withdrawnToken<=0n) throw new Error('没有可核对的撤出代币数量')
  const [exit,head]=await Promise.all([c.pub.getTransaction({hash:o.tx}),c.pub.getBlockNumber({cacheTime:0})])
  if(!same(exit.from,c.wallet)||exit.blockNumber!==o.block||exit.transactionIndex===null) throw new Error('无法确认撤仓交易的钱包或区块，暂不估值')
  const end=head<o.block+SALE_WINDOW_BLOCKS?head:o.block+SALE_WINDOW_BLOCKS
  const response:any=await c.pub.request({method:'alchemy_getAssetTransfers',params:[{fromBlock:`0x${o.block.toString(16)}`,toBlock:`0x${end.toString(16)}`,fromAddress:c.wallet,contractAddresses:[o.token],category:['erc20'],withMetadata:true,order:'asc',maxCount:'0x64'}]} as any)
  const seen=new Set<string>()
  let permanent=false,sold=0n,received=0n
  // 撤出后连续的几笔卖出累加，加到覆盖撤出数量为止，按总成交额算价：撤退程序可能先卖掉钱包里原有的一点、再卖撤出来的（或分几次卖完），
  // 只看第一笔会把 14 个币的小单当成全部、判成"永久无法估值"。中间只要出现一笔不是卖币的转出（转走、加仓）就不猜，永久放弃
  for(const item of response.transfers??[]) {
    const hash=item.hash as Hex
    if(hash===o.tx||seen.has(hash)) continue
    seen.add(hash)
    const rc=await c.pub.getTransactionReceipt({hash})
    if(rc.blockNumber<o.block||(rc.blockNumber===o.block&&rc.transactionIndex<=exit.transactionIndex!)) continue
    const time=Date.parse(item.metadata?.blockTimestamp??'')||Number((await c.pub.getBlock({blockNumber:rc.blockNumber})).timestamp)*1000
    const tx=await c.pub.getTransaction({hash})
    const sale=walletSale(rc,c.wallet,o.token,c.Q.address)
    if(rc.status!=='success'||!same(tx.from,c.wallet)||tx.nonce<=exit.nonce||tx.nonce>exit.nonce+SALE_NONCE_SPAN||time<o.time||time-o.time>SALE_WINDOW_MS||!sale||c.lp.ledger.parseMods(rc.logs).length) { permanent=true; break }
    sold+=sale.sold; received+=sale.received
    if(sold>=o.withdrawnToken) return {tick:saleTick(sold,received,o.tokenIs0),tx:hash,sold,received}
  }
  // 卖出还没覆盖撤出数量：时间窗口对应的区块都过完了 = 不会再有了；还没过完的是暂时没找到（可能还在分批卖），下次刷新再试（调用方按 permanent 决定失败是否缓存）
  throw Object.assign(new Error(sold>0n?`池价处于极限，撤出后只核对到卖出 ${sold} / ${o.withdrawnToken}，暂不计算盈亏`:'池价处于极限，未找到可核对的后续卖币成交；暂不计算盈亏，避免把本金记成 0'),{permanent:permanent||head>=o.block+SALE_WINDOW_BLOCKS})
}
