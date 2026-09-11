import type { Address, PublicClient } from 'viem'
import { makeClients, tokenMeta } from './common.ts'
import { makeLp } from './lp.ts'
import * as v4 from './v4.ts'

export function exactTickRange(value: string, spacing: number): [number, number] {
  if (!/^-?\d+\s*,\s*-?\d+$/.test(value.trim())) throw new Error('tick 区间格式：下界,上界（整数）')
  const [lo, hi] = value.split(',').map(Number)
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo >= hi || lo < v4.MIN_TICK || hi > v4.MAX_TICK) throw new Error('tick 区间超出范围或下界不小于上界')
  if (spacing < 1 || lo % spacing || hi % spacing) throw new Error(`tick 上下界必须是池间距 ${spacing} 的整数倍`)
  return [lo, hi]
}

// 同一区块的当前流动性为锚；跨越初始化 tick 时加减 liquidityNet。
export function tickRows(o: { tick: number; sqrtP: bigint; liquidity: bigint; lo: number; hi: number; step: number; net: Map<number, bigint>; tokenIs1: boolean; tokenDecimals: number; quoteDecimals: number }) {
  const readLo = Math.min(o.lo, o.tick), readHi = Math.max(o.hi, o.tick + 1)
  const B = [readLo, ...[...o.net.keys()].filter(t => t > readLo && t < readHi).sort((a,b) => a-b), readHi]
  const L = v4.segmentLiquidity(B, o.tick, o.liquidity, o.net)
  if (L.some(x => x < 0n)) throw new Error('tick 流动性数据不一致，请刷新')
  const [d0,d1] = o.tokenIs1 ? [o.quoteDecimals,o.tokenDecimals] : [o.tokenDecimals,o.quoteDecimals]
  const priceAt = (tick: number) => { const p = v4.priceAtTick(tick)*10**(d0-d1); return o.tokenIs1 ? 1/p : p }
  const rows = []
  for (let a=o.lo;a<o.hi;a+=o.step) {
    const b=Math.min(a+o.step,o.hi); let amount0=0n,amount1=0n,min:bigint|null=null,max=0n
    for(let j=0;j<L.length;j++) {
      const x=Math.max(a,B[j]), y=Math.min(b,B[j+1]); if(x>=y) continue
      min=min===null || L[j]<min ? L[j] : min; if(L[j]>max) max=L[j]
      const [u,v]=v4.amountsForLiquidity(o.sqrtP,v4.getSqrtRatioAtTick(x),v4.getSqrtRatioAtTick(y),L[j]); amount0+=u;amount1+=v
    }
    const [q,t]=o.tokenIs1?[amount0,amount1]:[amount1,amount0]
    const quote=Number(q)/10**o.quoteDecimals,token=Number(t)/10**o.tokenDecimals
    const [priceLo,priceHi]=[priceAt(a),priceAt(b)].sort((a,b)=>a-b)
    rows.push({lo:a,hi:b,priceLo,priceHi,quote,token,value:quote+token*priceAt(o.tick),liquidityMin:String(min??0n),liquidityMax:String(max),current:a<=o.tick&&o.tick<b})
  }
  return {price:priceAt(o.tick),rows:rows.sort((a,b)=>b.priceLo-a.priceLo)}
}

export async function readTickDetail(query: { token: Address; pool?: string; fee: number; spacing: number; zoom: number; center?: number }) {
  if (![1,4,16,64].includes(query.zoom)) throw new Error('显示倍率只支持 1 / 4 / 16 / 64')
  const c=await makeClients({chain:'robinhood',protocol:'v4',needKey:false,from:'0x0000000000000000000000000000000000000001'})
  if (!query.pool && (!Number.isInteger(query.fee)||query.fee<=0||query.fee>1_000_000||!Number.isInteger(query.spacing)||query.spacing<1||query.spacing>32767)) throw new Error('费率或 tick 间距无效')
  if (query.pool && !/^0x[0-9a-fA-F]{64}$/.test(query.pool)) throw new Error('Pool ID 必须是 32 字节 hex')
  const pool=query.pool ? await c.lp.poolById(query.pool as `0x${string}`) : await c.lp.pool(query.token,query.fee,query.spacing)
  if(!pool || ![pool.currency0,pool.currency1].some(t=>t.toLowerCase()===query.token.toLowerCase()) || ![pool.currency0,pool.currency1].some(t=>t.toLowerCase()===c.Q.address.toLowerCase()) || query.token.toLowerCase()===c.Q.address.toLowerCase()) throw new Error('不是该代币的 USDG 池，或无法读取 PoolKey')
  const blockNumber=await c.pub.getBlockNumber({cacheTime:0})
  // 所有状态和两轮 tick multicall 固定到同一区块，避免价格跨 tick 时拼出错误深度。
  const pub = new Proxy(c.pub,{get(target,key) { if(key==='readContract'||key==='multicall') return (args: any)=>(target[key] as any)({...args,blockNumber}); return Reflect.get(target,key) }}) as PublicClient
  const lp=await makeLp('v4',{pub,archive:pub,wallet:c.wallet,cfg:c.cfg,rpcIsAlchemy:c.rpcIsAlchemy,log:()=>{}}) // 固定的是最新区块，公共节点也有，不用归档节点
  const [slot,liquidity,meta]=await Promise.all([lp.slot0(pool),lp.liquidity(pool),tokenMeta(pub,query.token)])
  if(!slot.sqrtP) throw new Error('池子尚未初始化，没有链上 tick 明细')
  const step=pool.spacing*query.zoom,center=query.center??slot.tick
  if(!Number.isSafeInteger(center)||center<v4.MIN_TICK||center>=v4.MAX_TICK||Math.abs(center-slot.tick)>pool.spacing*8192) throw new Error('查看范围离现价太远，请回到现价')
  const lo=Math.max(v4.ceilToSpacing(v4.MIN_TICK,pool.spacing),v4.floorToSpacing(center,step)-32*step)
  const hi=Math.min(v4.floorToSpacing(v4.MAX_TICK,pool.spacing),v4.floorToSpacing(center,step)+32*step)
  const {net}=await lp.ticks(pool,Math.min(lo,slot.tick),Math.max(hi,slot.tick+1))
  return {pool:pool.id,token:query.token,symbol:meta.symbol,quoteSymbol:c.Q.symbol,spacing:pool.spacing,fee:pool.fee,block:blockNumber.toString(),tick:slot.tick,zoom:query.zoom,center,lo,hi, ...tickRows({tick:slot.tick,sqrtP:slot.sqrtP,liquidity,lo,hi,step,net,tokenIs1:pool.currency0.toLowerCase()===c.Q.address.toLowerCase(),tokenDecimals:meta.decimals,quoteDecimals:c.Q.decimals})}
}
