import assert from 'node:assert/strict'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Address, type Hex, type TransactionReceipt } from 'viem'
import { walletSale, saleTick, exitValuation } from './exit-valuation.ts'
import type { Clients } from './common.ts'

export async function checkExitValuation() {
  const wallet='0x0000000000000000000000000000000000000011' as Address,router='0x0000000000000000000000000000000000000022' as Address
  const token='0x0000000000000000000000000000000000000033' as Address,quote='0x0000000000000000000000000000000000000044' as Address
  const event=parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)')
  const log=(address:Address,from:Address,to:Address,value:bigint)=>({address,topics:encodeEventTopics({abi:[event],eventName:'Transfer',args:{from,to}}),data:encodeAbiParameters([{type:'uint256'}],[value])})
  const receipt={logs:[log(token,wallet,router,2100n),log(token,router,wallet,100n),log(quote,router,wallet,320n),log(quote,wallet,router,2n)]} as unknown as TransactionReceipt
  assert.deepEqual(walletSale(receipt,wallet,token,quote),{sold:2000n,received:318n},'use net wallet transfers including refunds and quote payments')
  assert.equal(walletSale(receipt,router,token,quote),null)
  assert(Math.abs(1.0001**saleTick(2000n,318n,true)-0.159)<1e-12)
  assert(Math.abs(1.0001**saleTick(2000n,318n,false)-1/0.159)<1e-12)
  assert.throws(()=>saleTick(0n,318n,true))
  const tx=('0x'+'1'.repeat(64)) as Hex,saleHash=('0x'+'2'.repeat(64)) as Hex,smallHash=('0x'+'3'.repeat(64)) as Hex,moveHash=('0x'+'4'.repeat(64)) as Hex
  // smallHash：先卖了钱包里原有的 100 个（换回 10）；moveHash：把币转走了，不是卖出
  const smallReceipt={logs:[log(token,wallet,router,100n),log(quote,router,wallet,10n)]},moveReceipt={logs:[log(token,wallet,router,100n)]}
  let nonce=12,from=wallet,received=true,transfers:{hash:Hex;metadata:{blockTimestamp:string}}[]|null=null,head=102n
  const at=(ms:number)=>({blockTimestamp:new Date(ms).toISOString()})
  const c={wallet,Q:{address:quote},lp:{ledger:{parseMods:()=>[]}},pub:{
    getBlockNumber:async()=>head,
    getTransaction:async({hash}:{hash:Hex})=>hash===tx?{from:wallet,blockNumber:100n,transactionIndex:1,nonce:10}:{from,nonce},
    request:async()=>({transfers:transfers??[{hash:saleHash,metadata:at(101_000)}]}),
    getTransactionReceipt:async({hash}:{hash:Hex})=>({...(hash===smallHash?smallReceipt:hash===moveHash?moveReceipt:receipt),...(hash===saleHash&&!received?{logs:[]}:{}),status:'success',blockNumber:101n,transactionIndex:0}),
  }} as unknown as Clients
  const request={tx,block:100n,time:100_000,token,tokenIs0:true,withdrawnToken:1900n}
  assert.equal((await exitValuation(c,request)).tx,saleHash)
  nonce=22;assert.equal((await exitValuation(c,request)).tx,saleHash,'a dozen nonces after the exit still counts as the follow-up sale')
  nonce=23;await assert.rejects(exitValuation(c,request),(e:any)=>/暂不计算/.test(e.message)&&e.permanent===true)
  nonce=12;transfers=[{hash:saleHash,metadata:{blockTimestamp:new Date(100_000+25*60_000).toISOString()}}]
  assert.equal((await exitValuation(c,request)).tx,saleHash,'a sale 25 minutes later (quote retries during a crash) is accepted')
  transfers=[{hash:saleHash,metadata:{blockTimestamp:new Date(100_000+31*60_000).toISOString()}}];await assert.rejects(exitValuation(c,request),(e:any)=>e.permanent===true)
  transfers=[];await assert.rejects(exitValuation(c,request),(e:any)=>e.permanent===false,'no sale yet inside the search window is a transient failure')
  head=2000n;await assert.rejects(exitValuation(c,request),(e:any)=>e.permanent===false,'1900 blocks (~3 min) later is still inside the 30-minute window')
  head=30_000n;await assert.rejects(exitValuation(c,request),(e:any)=>e.permanent===true,'no sale after the window has passed is final')
  head=102n;transfers=null
  nonce=12;from=router;await assert.rejects(exitValuation(c,request),/暂不计算/)
  from=wallet;received=false;await assert.rejects(exitValuation(c,request),/暂不计算/)
  received=true;await assert.rejects(exitValuation(c,{...request,withdrawnToken:2100n}),(e:any)=>/只核对到卖出 2000 \/ 2100/.test(e.message)&&e.permanent===false,'one sale short of the withdrawn amount waits for more sales')
  // 先卖掉钱包里原有的 100 个、再卖撤出来的 2000 个：两笔累加覆盖撤出数量，按总成交额（2100 -> 328）算价，链接指向补齐数量的那笔
  transfers=[{hash:smallHash,metadata:at(101_000)},{hash:saleHash,metadata:at(102_000)}]
  const two=await exitValuation(c,request)
  assert.deepEqual([two.tx,two.sold,two.received],[saleHash,2100n,328n],'consecutive sales are summed until they cover the withdrawn amount')
  assert(Math.abs(1.0001**two.tick-328/2100)<1e-12)
  transfers=[{hash:smallHash,metadata:at(101_000)}];await assert.rejects(exitValuation(c,request),(e:any)=>e.permanent===false,'a small first sale alone is not final yet')
  transfers=[{hash:moveHash,metadata:at(101_000)},{hash:saleHash,metadata:at(102_000)}];await assert.rejects(exitValuation(c,request),(e:any)=>e.permanent===true,'a plain transfer-out between the exit and the sale gives up for good')
  transfers=null
}
