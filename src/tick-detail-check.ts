// tick 深度的守恒、负 tick 边界与精确区间回归；不连接网络、不发送交易。
import assert from 'node:assert/strict'
import { tickRows, exactTickRange } from './tick-detail.ts'
import { getSqrtRatioAtTick, amountsForLiquidity } from './v4.ts'

export function checkTickDetail() {
  assert.deepEqual(exactTickRange('-20,10',10),[-20,10])
  for(const s of ['-19,10','10,-20','0,0','1.5,20','-887280,10','1e2,200']) assert.throws(()=>exactTickRange(s,10))
  const liquidity=1_000_000_000_000n, sqrtP=getSqrtRatioAtTick(0)
  const base={tick:0,sqrtP,liquidity,lo:-20,hi:20,step:10,net:new Map<number,bigint>(),tokenIs1:false,tokenDecimals:0,quoteDecimals:0}
  const rows=tickRows(base).rows
  assert.equal(rows.filter(r=>r.current).length,1)
  assert.equal(rows.find(r=>r.current)!.lo,0,'tick exactly on boundary belongs to the upper interval')
  const total=amountsForLiquidity(sqrtP,getSqrtRatioAtTick(-20),getSqrtRatioAtTick(20),liquidity)
  assert(Math.abs(rows.reduce((n,r)=>n+r.token,0)-Number(total[0]))<=4,'per-interval rounding conserves token0')
  assert(Math.abs(rows.reduce((n,r)=>n+r.quote,0)-Number(total[1]))<=4,'per-interval rounding conserves token1')
  const reversed=tickRows({...base,tokenIs1:true}).rows
  for(const r of rows) { const rev=reversed.find(x=>x.lo===r.lo)!;assert.equal(r.quote,rev.token);assert.equal(r.token,rev.quote);assert(Math.abs(r.priceLo*rev.priceHi-1)<1e-12) }
  const changing=tickRows({...base,net:new Map([[-10,liquidity],[10,-liquidity]])}).rows
  assert.equal(changing.find(r=>r.lo===-20)!.liquidityMax,'0')
  assert.equal(changing.find(r=>r.lo===10)!.liquidityMax,'0')
  const paged=tickRows({...base,lo:10,hi:30,net:new Map([[10,-liquidity]])}).rows
  assert(paged.every(r=>r.liquidityMax==='0'),'offscreen current tick still anchors liquidity correctly')
  assert.throws(()=>tickRows({...base,net:new Map([[10,-liquidity*2n]])}),/不一致/)
}
