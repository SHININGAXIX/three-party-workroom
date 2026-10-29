const {createHash}=require('node:crypto');
function fingerprint(kind,payload){return createHash('sha256').update(JSON.stringify({kind,...payload})).digest('hex');}
function validateClientId(id){if(typeof id!=='string'||!id.trim()||id.length>160)throw Error('消息编号无效');}
function markDelivery(memory,op,member,state,extra={}){
  op.deliveries||={};op.deliveries[member]={...op.deliveries[member],...extra,state,updatedAt:new Date().toISOString()};memory.save();
}
function unsettled(op){return Object.values(op.deliveries||{}).some(d=>['attempting','accepted'].includes(d.state));}
function confirmStop(memory,op){op.cancellation={...op.cancellation,state:'confirmed',confirmedAt:new Date().toISOString()};memory.save();}
async function settleWithin(promise,ms){let timer;try{await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(resolve,ms);})]);}finally{clearTimeout(timer);}}
function dsReply(snap,requestId,context){
  const request=snap.messages.find(m=>m.requestId===requestId);if(!request)return null;
  const replies=snap.messages.filter(m=>m.type==='assistant/message'&&m.turn===request.turn);
  const content=replies.map(m=>m.text).join('\n\n'),match=content.match(/\[\[ROOM_ACK seq=(\d+) memory=(\d+)\]\]/);
  if(!match)throw Error('DS 原回复缺少已读回执；未重复发送，请在原会话核对');
  const ack={seen_seq:Number(match[1]),memory_revision:Number(match[2])};
  if(ack.seen_seq!==context.through||ack.memory_revision!==context.revision)throw Error('DS 原回复的已读版本不匹配；未重复发送');
  const reply=content.replace(/\[\[ROOM_ACK seq=\d+ memory=\d+\]\]/g,'').trim();
  if(!reply)throw Error('DS 返回空回复；未重复发送');
  return {reply,ack,lastSeq:replies.at(-1).seq};
}
module.exports={fingerprint,validateClientId,markDelivery,unsettled,confirmStop,dsReply,settleWithin};
