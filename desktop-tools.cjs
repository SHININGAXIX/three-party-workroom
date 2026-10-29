// Uses the installed codex-app-tools plugin's length-prefixed local MCP host protocol.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),os=require('node:os'),{randomUUID}=require('node:crypto');
const MAX=8*1024*1024;
class DesktopTools{
  constructor(socket,caller){this.socket=socket;this.caller=caller;this.nextId=0;this.pending=new Map();this.buffer=Buffer.alloc(0);socket.on('data',b=>this.data(b));socket.on('error',e=>this.fail(e));socket.on('close',()=>this.fail(Error('Codex 桌面连接已关闭')));}
  fail(e){for(const p of this.pending.values())p.reject(e);this.pending.clear();}
  data(chunk){this.buffer=Buffer.concat([this.buffer,chunk]);while(this.buffer.length>=4){const n=this.buffer.readUInt32LE(0);if(n>MAX){this.fail(Error('桌面返回数据过大'));this.close();return;}if(this.buffer.length<n+4)return;let e;try{e=JSON.parse(this.buffer.subarray(4,n+4));}catch{this.fail(Error('桌面返回无效数据'));this.close();return;}this.buffer=this.buffer.subarray(n+4);const p=this.pending.get(e.id);if(p){this.pending.delete(e.id);e.error?p.reject(Error(e.error.message)):p.resolve(e.result);}}}
  request(method,params,timeout=45000){return new Promise((resolve,reject)=>{const id=++this.nextId,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Codex 桌面工具连接超时；未自动重发消息'));},timeout);this.pending.set(id,{resolve:x=>{clearTimeout(timer);resolve(x);},reject:e=>{clearTimeout(timer);reject(e);}});const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id,method,params}));if(body.length>MAX){this.pending.get(id).reject(Error('发送数据过大'));this.pending.delete(id);return;}const header=Buffer.alloc(4);header.writeUInt32LE(body.length);this.socket.write(Buffer.concat([header,body]));});}
  async call(name,args,timeout){const tool=this.tools.find(t=>t.name===name);if(!tool)throw Error('桌面工具不可用：'+name);const r=await this.request('tools/call',{arguments:args,callerSource:'codex',callId:'workroom-'+randomUUID(),threadId:this.caller,turnId:'workroom-'+randomUUID(),namespace:tool.namespace,tool:name},timeout);const text=(r.contentItems||[]).filter(x=>x.type==='inputText').map(x=>x.text).join('\n');if(!r.success)throw Error(text||'Codex 桌面工具失败');try{return JSON.parse(text);}catch{return {text};}}
  close(){this.socket.destroy();}
}
async function connectDesktop(root,callerHint){
  const file=path.join(root,'.runtime','desktop-bridge.json');let saved={};try{saved=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  const caller=process.env.CODEX_THREAD_ID||callerHint||saved.callerThreadId;if(!caller)return null;
  const candidates=[process.env.CODEX_APP_TOOLS_PIPE_PATH,saved.pipePath];
  if(process.platform==='win32')try{for(const name of fs.readdirSync('\\\\.\\pipe\\').filter(n=>/^codex-app-tools-[a-f\d-]{36}$/i.test(n)))candidates.push('\\\\.\\pipe\\'+name);}catch{}
  for(const pipe of [...new Set(candidates.filter(Boolean))]){
    let client;try{
      const socket=await new Promise((resolve,reject)=>{const s=net.createConnection(pipe),timer=setTimeout(()=>{s.destroy();reject(Error('连接超时'));},1500);s.once('error',e=>{clearTimeout(timer);reject(e);});s.once('connect',()=>{clearTimeout(timer);resolve(s);});});
      client=new DesktopTools(socket,caller);const catalog=await client.request('tools/list',{threadStartKind:'all'},8000);client.tools=catalog.tools||[];
      if(!['read_thread','send_message_to_thread','wait_threads'].every(n=>client.tools.some(t=>t.name===n)))throw Error('桌面缺少工作间工具');
      fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({pipePath:pipe,callerThreadId:caller},null,2));return client;
    }catch{client?.close();}
  }
  return null;
}
function finalReply(snapshot,through,revision,previousId){
  for(const turn of snapshot.turns||[]){if(turn.id===previousId)continue;for(const item of turn.items||[]){if(item.type!=='agentMessage'||!item.text)continue;let r;try{r=JSON.parse(item.text.replace(/^```(?:json)?\s*|\s*```$/g,''));}catch{continue;}if(r.ack?.seen_seq===through&&r.ack?.memory_revision===revision&&typeof r.reply==='string'&&r.reply.trim()&&Array.isArray(r.files)&&turn.status==='completed')return {result:r,turn};}}
  return null;
}
const rolloutCache=new Map();
function completeLongReply(snapshot,threadId,sessionRoot=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'sessions')){
  const turn=snapshot.turns?.[0];if(turn?.status!=='completed'||!turn.items?.some(i=>i.type==='agentMessage'&&i.text?.length>=19000))return snapshot;
  let file=rolloutCache.get(threadId);
  function locate(dir,depth){if(depth>3)return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const full=path.join(dir,entry.name);if(entry.isFile()&&entry.name.endsWith('-'+threadId+'.jsonl'))return full;if(entry.isDirectory()){const found=locate(full,depth+1);if(found)return found;}}}
  let fd;try{
    if(!file||!fs.existsSync(file)){file=locate(sessionRoot,0);if(!file)return snapshot;rolloutCache.set(threadId,file);}
    fd=fs.openSync(file,'r');const size=fs.fstatSync(fd).size,header=Buffer.alloc(Math.min(size,65536));fs.readSync(fd,header,0,header.length,0);
    const first=JSON.parse(header.toString('utf8').split('\n')[0]);if(first.type!=='session_meta'||first.payload?.id!==threadId)return snapshot;
    const tail=Buffer.alloc(Math.min(size,8*1024*1024));fs.readSync(fd,tail,0,tail.length,size-tail.length);
    const lines=tail.toString('utf8').split('\n');for(let n=lines.length-1;n>=0;n--){let e;try{e=JSON.parse(lines[n]);}catch{continue;}if(e.type==='event_msg'&&e.payload?.type==='task_complete'&&e.payload.turn_id===turn.id&&typeof e.payload.last_agent_message==='string'){
      // Read only the visible final message for this exact completed turn. Never
      // import reasoning, credentials, unrelated turns, or write the live rollout.
      return {...snapshot,turns:[{...turn,items:[...turn.items.filter(i=>i.type!=='agentMessage'),{type:'agentMessage',text:e.payload.last_agent_message,phase:'final_answer'}]},...snapshot.turns.slice(1)]};
    }}
  }catch{}finally{if(fd!==undefined)fs.closeSync(fd);}
  return snapshot;
}
module.exports={DesktopTools,connectDesktop,finalReply,completeLongReply};
