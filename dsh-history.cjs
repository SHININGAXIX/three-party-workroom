function visible(events){
  let turn=null;const messages=[];
  for(const e of events){
    if(e.type==='turn/start')turn=e.data?.turn??turn;
    const d=e.type==='user/message'?e.data:e.type==='assistant/message'?e.data?.message:null;
    if(!d)continue;const text=(d.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n').trim();
    if(text)messages.push({seq:e.seq,type:e.type,text,requestId:d.source?.rpcId,turn:e.data?.turn??turn,id:d.id});
  }
  return messages;
}
async function page(c,id,through,maxMessages=200,beforeSeq){
  return c.rpc('session/page',{request:{address:{kind:'session',sessionId:id},throughSeq:through,maxMessages,...beforeSeq===undefined?{}:{beforeSeq}}});
}
async function snapshot(c,id){
  const p=await c.rpc('session/projections',{request:{sessionId:id}});if(!p)throw Error('原 DSH 会话不存在');
  let events=[],before,more=true;
  for(let n=0;more&&n<30;n++){
    const r=await page(c,id,p.asOfSeq,200,before);const rows=r.records.map(r=>r.event).filter(Boolean);
    events=rows.concat(events);more=r.hasMore;if(!rows.length&&more)throw Error('DSH 历史分页没有前进');before=rows[0]?.seq;
  }
  if(more)throw Error('DSH 历史过长，导入未完成；没有静默丢弃');
  const unique=[...new Map(events.map(e=>[e.seq,e])).values()].sort((a,b)=>a.seq-b.seq);
  return {through:p.asOfSeq,messages:visible(unique)};
}
module.exports={visible,snapshot,page};
