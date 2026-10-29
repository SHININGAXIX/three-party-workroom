const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {Hub}=require('../hub.cjs'),{runDesktop}=require('../codex-session.cjs');
const {StateEvents}=require('../state-events.cjs'),{describe}=require('../status-view.js');
const {markDelivery}=require('../delivery.cjs');
function fixture(t,adapters={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workroom-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const h=new Hub(root,{config:()=>({dshSessionId:'ds-fixed'}),...adapters});h.sync=async()=>{};
  h.memory.s.codex.threadId='codex-fixed';h.memory.add('human','测试问题');h.memory.save();
  return h;
}
const operation=(id='op1')=>({id,humanSeq:1,target:'ds',status:'running',createdAt:new Date().toISOString(),dshRequestIds:[]});
function snapshot(requestId,context){return {messages:[{type:'user/message',requestId,turn:'turn-original',seq:10},{type:'assistant/message',turn:'turn-original',seq:11,text:`[[ROOM_ACK seq=${context.through} memory=${context.revision}]]\n原回复`} ]};}

test('reconnected DSH clears stale errors even when it has no new messages',async t=>{
  const h=fixture(t,{connectDS:async()=>({rpc:async()=>({asOfSeq:10})})});
  h.memory.s.ds.sourceSeq=10;h.lastSyncError='fetch failed';await h.syncNow();assert.equal(h.lastSyncError,null);assert.equal(h.memory.s.messages.length,1);
});

test('same client id and payload survives restart; changed payload or cross-route reuse fails',async t=>{
  const h=fixture(t);h.execute=async op=>{op.status='completed';};
  const a=await h.send({text:'你好',clientId:'one',target:'ds'});await h.active?.done;
  const again=await h.send({text:'你好',clientId:'one',target:'ds'});assert.equal(a.id,again.id);
  await assert.rejects(h.send({text:'已换内容',clientId:'one',target:'ds'}),/内容不同/);
  await assert.rejects(h.send({text:'你好',clientId:'one',target:'codex'}),/内容不同/);
  await assert.rejects(h.retry({operationId:a.id,clientId:'one'}),/重试目标不同/);
  const reopened=new Hub(h.root,{config:()=>({})});reopened.sync=async()=>{throw Error('must not dispatch');};
  assert.equal((await reopened.send({text:'你好',clientId:'one',target:'ds'})).id,a.id);
  assert.equal(reopened.memory.s.messages.filter(m=>m.clientId==='one').length,1);
  assert.equal(reopened.memory.s.codex.threadId,'codex-fixed');assert.equal(reopened.memory.s.revision,1);
});

test('concurrent admission cannot register two copies',async t=>{
  const h=fixture(t);let release;h.sync=()=>new Promise(r=>{release=r;});h.execute=async op=>{op.status='completed';};
  const body={text:'并发',clientId:'concurrent',target:'ds'},first=h.send(body);
  await assert.rejects(h.send(body),/正在交接/);release();const accepted=await first;await h.active?.done;
  assert.equal((await h.send(body)).id,accepted.id);assert.equal(h.memory.s.operations.length,1);
});

test('DS lost prompt response is recovered with original files and ACK, without a second prompt',async t=>{
  let prompts=0,requestId;const c={rpc:async(method,args)=>{if(method==='session/list')return {items:[{sessionId:'ds-fixed',running:false}]};if(method==='session/prompt'){prompts++;requestId=args.request.requestId;throw Error('response lost');}throw Error(method);}};
  const h=fixture(t,{connectDS:async()=>c});const ctx=h.memory.context('ds'),first=operation();h.memory.s.operations.push(first);
  await assert.rejects(h.ds(first,ctx,new AbortController().signal),/response lost/);
  assert.equal(first.deliveries.ds.state,'attempting');
  fs.writeFileSync(path.join(h.root,'artifacts',first.id,'ds-files','answer.md'),'same artifact');
  h.snapshotDS=async()=>snapshot(requestId,ctx);const retry=operation('retry');h.memory.s.operations.push(retry);
  await h.ds(retry,ctx,new AbortController().signal);
  assert.equal(prompts,1);assert.equal(retry.recoveredFrom.ds,first.id);
  assert.equal(h.memory.s.messages.at(-1).text,'原回复');
  assert.equal(fs.readFileSync(path.join(h.root,'artifacts','retry','files','ds','answer.md'),'utf8'),'same artifact');
});

test('DS missing or mismatched receipt never silently re-executes',async t=>{
  let prompts=0;const c={rpc:async method=>{if(method==='session/list')return {items:[{sessionId:'ds-fixed',running:false}]};prompts++;throw Error('lost');}};
  const h=fixture(t,{connectDS:async()=>c,snapshotDS:async()=>({messages:[]})}),ctx=h.memory.context('ds'),first=operation();h.memory.s.operations.push(first);
  await assert.rejects(h.ds(first,ctx,new AbortController().signal));const retry=operation('retry');h.memory.s.operations.push(retry);
  await assert.rejects(h.ds(retry,ctx,new AbortController().signal),/尚未确认/);
  h.snapshotDS=async()=>snapshot(first.dshRequestIds[0],{through:999,revision:1});
  await assert.rejects(h.ds(retry,ctx,new AbortController().signal),/不匹配/);assert.equal(prompts,1);
  assert.equal(h.memory.s.messages.filter(m=>m.speaker==='ds').length,0);
});

test('Codex persists uncertain dispatch before RPC; retry recovers without another send',async t=>{
  const h=fixture(t),ctx=h.memory.context('codex'),op=operation();h.memory.s.operations.push(op);let sends=0;
  const before={thread:{id:'codex-fixed',status:{type:'idle'}},turns:[{id:'old',status:'completed',items:[]}]};
  const desktop={close(){},call:async method=>{if(method==='read_thread')return before;sends++;throw Error('response lost');}};
  const options={root:h.root,config:{codex:process.execPath},memory:h.memory,operation:op,context:ctx,signal:new AbortController().signal,desktop};
  await assert.rejects(runDesktop(options),/response lost/);assert.equal(op.deliveries.codex.state,'attempting');assert.equal(op.desktopThreadId,'codex-fixed');
  const retry=operation('retry');h.memory.s.operations.push(retry);
  const result={reply:'原桌面回复',ack:{seen_seq:ctx.through,memory_revision:ctx.revision},files:[]};
  desktop.call=async method=>{assert.equal(method,'read_thread');return {thread:before.thread,turns:[{id:'new',status:'completed',items:[{type:'agentMessage',text:JSON.stringify(result)}]}]};};
  const recovered=await runDesktop({...options,operation:retry});assert.equal(recovered.reply,result.reply);assert.equal(sends,1);assert.equal(recovered.recoveredContext.through,ctx.through);
});

test('Codex retry with an unresolved old dispatch refuses to resend',async t=>{
  const h=fixture(t),ctx=h.memory.context('codex'),op=operation();op.desktopThreadId='codex-fixed';h.memory.s.operations.push(op);
  const retry=operation('retry');h.memory.s.operations.push(retry);let sends=0;
  const desktop={close(){},call:async method=>{if(method!=='read_thread'){sends++;throw Error('unexpected send');}return {thread:{id:'codex-fixed',status:{type:'idle'}},turns:[]};}};
  await assert.rejects(runDesktop({root:h.root,config:{codex:process.execPath},memory:h.memory,operation:retry,context:ctx,signal:new AbortController().signal,desktop}),/未重复发送/);assert.equal(sends,0);
});

test('DS stop remains unconfirmed while backend runs; blocks new work and later reconciles idle',async t=>{
  let running=false,requestId,cancelled=0,reachPoll,releasePoll;
  const reached=new Promise(r=>reachPoll=r),gate=new Promise(r=>releasePoll=r);
  const c={rpc:async(method,args)=>{if(method==='session/list')return {items:[{sessionId:'ds-fixed',running}]};if(method==='session/prompt'){requestId=args.request.requestId;running=true;return {};}if(method==='session/cancel'){cancelled++;return {};}throw Error(method);}};
  const h=fixture(t,{connectDS:async()=>c,pause:async()=>{reachPoll();await gate;}}),ctx=h.memory.context('ds');
  h.snapshotDS=async()=>snapshot(requestId,ctx);h.execute=async(op,signal)=>{h.active.member='ds';await h.ds(op,ctx,signal);};
  const op=operation();h.startOperation(op);const done=h.active.done;await reached;
  const receipt=await h.stop();assert.equal(receipt.confirmed,false);releasePoll();await done;
  assert.equal(op.status,'stop_unconfirmed');assert.equal(cancelled,1);assert.equal(h.state().blockedOperation,op.id);
  await assert.rejects(h.send({text:'新问题',clientId:'blocked',target:'ds'}),/尚未确认/);
  assert.equal(h.memory.s.messages.filter(m=>m.speaker==='ds').length,0);
  running=false;await h.reconcileStops();assert.equal(op.status,'cancelled');assert.equal(h.state().blockedOperation,null);
  assert.equal(h.memory.s.messages.filter(m=>m.speaker==='ds').length,0);
});

test('stop before dispatch is confirmed without cancelling unrelated backend work',async t=>{
  const h=fixture(t,{connectDS:async()=>{throw Error('must not connect');}});let release,ready;const reached=new Promise(r=>ready=r);
  h.execute=async(op,signal)=>{h.active.member='ds';ready();await new Promise(r=>release=r);if(signal.aborted)throw Error('before dispatch');};
  const op=operation();h.startOperation(op);const done=h.active.done;await reached;await h.stop();release();await done;
  assert.equal(op.status,'cancelled');assert.equal(op.cancellation.state,'confirmed');
});

test('Codex stop never returns a late model reply; waits past queued stop acknowledgement',async t=>{
  const h=fixture(t),ctx=h.memory.context('codex'),op=operation(),controller=new AbortController();h.memory.s.operations.push(op);let reads=0,sends=0;
  const result={reply:'late',ack:{seen_seq:ctx.through,memory_revision:ctx.revision},files:[]};
  const desktop={close(){},call:async method=>{if(method==='send_message_to_thread'){sends++;if(sends===1)controller.abort();return {};}
    reads++;return {thread:{id:'codex-fixed',status:{type:'idle'}},turns:[reads===1?{id:'old',status:'completed',items:[]}:{id:'new',status:'completed',items:[{type:'agentMessage',text:JSON.stringify(result)}]}]};}};
  await assert.rejects(runDesktop({root:h.root,config:{codex:process.execPath},memory:h.memory,operation:op,context:ctx,signal:controller.signal,desktop}),/迟到回复不会发布/);
  assert.equal(sends,2);assert.equal(reads,3);assert.equal(op.cancellation.state,'confirmed');
  assert.equal(h.memory.s.messages.filter(m=>m.speaker==='codex').length,0);
});

test('restart keeps identity and constraints, marks unknown stop instead of cancelled',t=>{
  const h=fixture(t),op=operation();op.status='stop_requested';op.cancellation={state:'requested',member:'ds'};h.memory.s.operations.push(op);markDelivery(h.memory,op,'ds','attempting',{sessionId:'ds-fixed',requestId:'id'});
  const room=h.memory.s.roomId,next=h.memory.s.nextSeq,revision=h.memory.s.revision;const reopened=new Hub(h.root);reopened.recover();
  assert.equal(reopened.memory.s.operations[0].status,'stop_unconfirmed');assert.equal(reopened.memory.s.roomId,room);assert.equal(reopened.memory.s.codex.threadId,'codex-fixed');assert.equal(reopened.memory.s.nextSeq,next);assert.equal(reopened.memory.s.revision,revision);
});

test('SSE reconnect resets stale cursors, handles same cursor and closes clients',()=>{
  class Response extends EventEmitter{constructor(){super();this.frames=[];}writeHead(code,headers){this.code=code;this.headers=headers;}write(data){this.frames.push(data);return true;}end(){this.emit('close');}destroy(){this.emit('close');}}
  const events=new StateEvents(),first=new Response();events.attach({headers:{}},first);assert.match(first.frames.join(''),/event: reset/);
  const initial=events.cursor;events.publish();assert.notEqual(events.cursor,initial);assert.match(first.frames.at(-1),/event: state/);
  const same=new Response();events.attach({headers:{'last-event-id':events.cursor}},same);assert.match(same.frames.join(''),/event: state/);
  const stale=new Response();events.attach({headers:{'last-event-id':initial}},stale);assert.match(stale.frames.join(''),/event: reset/);
  assert.equal(events.clients.size,3);events.close();assert.equal(events.clients.size,0);assert.notEqual(new StateEvents().cursor,events.cursor);
});

test('UI labels do not present requested/unknown stop as confirmed; inline script parses',()=>{
  const now=Date.now(),connection={lastSeenAt:now};
  for(const status of ['stop_requested','stop_unconfirmed']){const op={id:'id',status,createdAt:new Date(now).toISOString()};const view=describe({operations:[op],blockedOperation:'id'},connection,now);assert.equal(view.kind,'uncertain');assert.doesNotMatch(view.title,/已停止/);}
  const html=fs.readFileSync(path.join(__dirname,'..','chat.html'),'utf8');const source=html.match(/<script>([\s\S]*)<\/script>/)[1];assert.doesNotThrow(()=>new vm.Script(source));
});
