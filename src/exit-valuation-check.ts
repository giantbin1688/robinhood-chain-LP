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
  const tx=('0x'+'1'.repeat(64)) as Hex,saleHash=('0x'+'2'.repeat(64)) as Hex
  let nonce=12,from=wallet,received=true,transfers:{hash:Hex;metadata:{blockTimestamp:string}}[]|null=null,head=102n
  const c={wallet,Q:{address:quote},lp:{ledger:{parseMods:()=>[]}},pub:{
    getBlockNumber:async()=>head,
    getTransaction:async({hash}:{hash:Hex})=>hash===tx?{from:wallet,blockNumber:100n,transactionIndex:1,nonce:10}:{from,nonce},
    request:async()=>({transfers:transfers??[{hash:saleHash,metadata:{blockTimestamp:new Date(101_000).toISOString()}}]}),
    getTransactionReceipt:async()=>({...receipt,logs:received?receipt.logs:[],status:'success',blockNumber:101n,transactionIndex:0}),
  }} as unknown as Clients
  const request={tx,block:100n,time:100_000,token,tokenIs0:true,withdrawnToken:1900n}
  assert.equal((await exitValuation(c,request)).tx,saleHash)
  nonce=22;assert.equal((await exitValuation(c,request)).tx,saleHash,'a dozen nonces after the exit still counts as the follow-up sale')
  nonce=23;await assert.rejects(exitValuation(c,request),(e:any)=>/暂不计算/.test(e.message)&&e.permanent===true)
  nonce=12;transfers=[{hash:saleHash,metadata:{blockTimestamp:new Date(100_000+25*60_000).toISOString()}}]
  assert.equal((await exitValuation(c,request)).tx,saleHash,'a sale 25 minutes later (quote retries during a crash) is accepted')
  transfers=[{hash:saleHash,metadata:{blockTimestamp:new Date(100_000+31*60_000).toISOString()}}];await assert.rejects(exitValuation(c,request),(e:any)=>e.permanent===true)
  transfers=[];await assert.rejects(exitValuation(c,request),(e:any)=>e.permanent===false,'no sale yet within 512 blocks is a transient failure')
  head=700n;await assert.rejects(exitValuation(c,request),(e:any)=>e.permanent===true,'no sale after 512 blocks is final')
  head=102n;transfers=null
  nonce=12;from=router;await assert.rejects(exitValuation(c,request),/暂不计算/)
  from=wallet;received=false;await assert.rejects(exitValuation(c,request),/暂不计算/)
  received=true;await assert.rejects(exitValuation(c,{...request,withdrawnToken:2100n}),/暂不计算/)
}
