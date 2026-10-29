const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {attachmentContext}=require('./file-store.cjs');
const scrub=x=>String(x).replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g,'[REDACTED]').replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]');
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,value);fs.renameSync(tmp,file);}
class Memory {
  constructor(root){
    this.root=root;this.file=path.join(root,'.runtime','hub.json');
    this.s=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{version:1,roomId:randomUUID(),revision:1,nextSeq:1,messages:[],decisions:[],operations:[],codex:{threadId:null,seenSeq:0},ds:{seenSeq:0,sourceSeq:-1},imports:[]};
  }
  save(){
    atomic(this.file,JSON.stringify(this.s,null,2));
    atomic(path.join(this.root,'memory','conversation.jsonl'),this.s.messages.map(m=>JSON.stringify(m)).join('\n')+'\n');
    atomic(path.join(this.root,'memory','conversation.md'),'# 工作间共同记录\n\n'+this.s.messages.map(m=>`## #${m.seq} · ${m.speaker} · ${m.at}\n\n${m.text}\n${(m.attachments||[]).map(f=>`\n附件：${f.name}（${f.id}；${f.extraction.status}）`).join('')}\n`).join('\n'));
    atomic(path.join(this.root,'memory','STATE.md'),this.kernel());
    this.onSave?.();
  }
  add(speaker,text,meta={}){
    if(meta.sourceKey&&this.s.messages.some(m=>m.sourceKey===meta.sourceKey))return null;
    const m={id:randomUUID(),seq:this.s.nextSeq++,speaker,text:scrub(text),at:new Date().toISOString(),...meta};
    this.s.messages.push(m);return m;
  }
  decide(text,sourceMessageId,expectedRevision,replaceId=null){
    if(expectedRevision!==this.s.revision)throw Error('共同记忆版本已变化，请刷新后再保存');
    const m=this.s.messages.find(m=>m.id===sourceMessageId&&m.speaker==='human');
    if(!m)throw Error('只能从真实人类消息确认共同约束');
    const old=replaceId?this.s.decisions.find(d=>d.id===replaceId&&!d.supersededBy):null;
    if(replaceId&&!old)throw Error('被替换的共同约束已变化，请刷新');
    const confirmation=this.add('human','[确认共同约束] '+text,{source:'统一页面的人类确认',basedOnMessageId:sourceMessageId});
    const d={id:randomUUID(),text:scrub(text),sourceMessageId:confirmation.id,basedOnMessageId:sourceMessageId,at:new Date().toISOString(),authority:'human'};
    if(old)old.supersededBy=d.id;
    this.s.decisions.push(d);this.s.revision++;this.save();
  }
  kernel(){return '# 共同记忆\n\n房间 '+this.s.roomId+'\n版本 '+this.s.revision+'\n\n## 人类确认的目标与约束（当前有效）\n\n'+this.s.decisions.filter(d=>!d.supersededBy).map((d,i)=>`${i+1}. ${d.text}（来源 ${d.sourceMessageId}）`).join('\n')+'\n\n## 材料索引（路径不等于已读）\n\n'+(this.s.materials||[]).map(m=>`- ${m.name}：${m.path}；${m.status}；本机存在=${m.exists}`).join('\n')+'\n\n模型建议仅保存在聊天记录，未经人类确认不会自动成为约束。发言记录：memory/conversation.md。\n';}
  context(agent){
    const seen=agent==='codex'?this.s.codex.seenSeq:this.s.ds.seenSeq;
    const msgs=this.s.messages.filter(m=>m.seq>seen&&m.speaker!=='system'&&m.speaker!==agent);
    const through=this.s.nextSeq-1;
    const text=this.kernel()+'\n## 自上次已读后新增的发言\n\n'+msgs.map(m=>`[seq=${m.seq}; speaker=${m.speaker}; source=${m.source||'hub'}]\n${m.text}${scrub(attachmentContext(this.root,m.attachments))}`).join('\n\n');
    if(Buffer.byteLength(text)>400000)throw Error('新增上下文超过400KB；暂停发送，需先整理共同记忆，未截断历史');
    return {text,through,revision:this.s.revision,fromSeq:seen+1};
  }
  accept(agent,reply,ack,context,meta={}){
    if(this.s.revision!==context.revision)throw Error('回答生成期间人类约束已改变，旧回答没有发布');
    if(!ack||ack.seen_seq!==context.through||ack.memory_revision!==context.revision)throw Error(agent+' 的上下文回执不匹配，未发布回答');
    const m=this.add(agent,reply,{...meta,ack});
    const unreadGap=this.s.messages.some(x=>x.seq>context.through&&x.seq<m.seq&&x.speaker!=='system'&&x.speaker!==agent);
    // A manual DSH sync may add speech while a model is answering. It has not read
    // those messages yet; do not move its cursor past them with its own reply.
    if(agent==='codex')this.s.codex.seenSeq=unreadGap?context.through:m.seq;else this.s.ds.seenSeq=unreadGap?context.through:m.seq;
    this.save();return m;
  }
}
module.exports={Memory,scrub,atomic};
