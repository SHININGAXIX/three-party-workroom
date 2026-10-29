(function(root){
  const names={ds:'DS',codex:'Codex'};
  function duration(start,end=Date.now()){
    const a=typeof start==='number'?start:Date.parse(start),b=typeof end==='number'?end:Date.parse(end);
    const seconds=Math.max(0,Math.floor((b-a)/1000));if(!Number.isFinite(seconds))return '00:00';
    const h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=seconds%60;return (h?h+':':'')+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
  }
  function describe(state,connection={},now=Date.now()){
    const age=connection.lastSeenAt?Math.max(0,now-connection.lastSeenAt):Infinity;
    const fresh=age<10000&&!connection.error;
    const link=fresh?'工作间已连接 · '+Math.floor(age/1000)+' 秒前更新':connection.lastSeenAt?'连接中断 · '+Math.floor(age/1000)+' 秒未更新':'正在连接工作间';
    if(!fresh)return {kind:connection.lastSeenAt||connection.error?'offline':'connecting',title:connection.lastSeenAt?'暂时无法确认 AI 状态':'正在连接工作间',detail:connection.lastSeenAt?'后台可能仍在处理；连接恢复后会自动核对。':'等待工作间返回状态。',elapsed:'',link,live:false};
    if(connection.pending){const p=connection.pending;return {kind:p.uncertain?'uncertain':'sending',title:p.uncertain?'消息是否送达，尚待确认':'正在发送到工作间',detail:p.uncertain?'输入已保留；可点“重试原消息”核对并重试，不会重复登记同一消息。':'正在等待接收确认，请勿重复发送。',elapsed:'送达等待 '+duration(p.startedAt,now),link,live:!p.uncertain};}
    const op=state?.operations?.find(o=>o.id===(state.active||state.blockedOperation))||connection.accepted||state?.operations?.at(-1);
    if(!op)return {kind:'idle',title:'可以发送消息',detail:'工作间连接正常，发送后会显示接收与 AI 处理状态。',elapsed:'',link,live:false};
    const serverNow=now+(connection.offset||0),member=op.progress?.member||state.activeMember,metrics=op.members?.[member];
    if(['stop_requested','stop_unconfirmed'].includes(op.status))return {kind:'uncertain',title:op.status==='stop_requested'?'已请求停止，等待确认':'停止尚未确认',detail:'该轮迟到回复不会发布。请在原会话核对；工作间确认会话空闲后会恢复发送。'+(op.cancelError?' 停止请求返回错误：'+op.cancelError:''),elapsed:'停止等待 '+duration(op.cancellation?.requestedAt||op.createdAt,serverNow),link,live:op.status==='stop_requested',operationId:op.id};
    if(op.status==='running'){
      const completed=Object.entries(op.members||{}).filter(([,m])=>m.status==='completed').map(([n])=>(names[n]||n)+' 已回复');
      const label=op.progress?.label||state.activeActivity||'工作间已接收，等待成员处理';
      let detail=completed.join(' · ');if(metrics?.lastObservedAt)detail+=(detail?'；':'')+'最近确认会话状态：'+duration(metrics.lastObservedAt,serverNow)+' 前';
      if(metrics?.submittedAt&&serverNow-Date.parse(metrics.submittedAt)>=60000)detail+=(detail?'。':'')+'AI 尚未返回完整回复，可继续等待或请求停止。';
      if(!detail)detail='消息已保存；收到完整回复后会自动显示。';
      const elapsed='本轮 '+duration(op.createdAt,serverNow)+(metrics?' · '+(names[member]||member)+(metrics.submittedAt?' 响应等待 ':' 准备中 ')+duration(metrics.submittedAt||metrics.startedAt,serverNow):'');
      return {kind:'working',title:label,detail,elapsed,link,live:true,operationId:op.id};
    }
    const completed=op.status==='completed',parts=Object.entries(op.members||{}).filter(([,m])=>m.finishedAt).map(([n,m])=>(names[n]||n)+' '+duration(m.startedAt,m.finishedAt));
    return {kind:completed?'complete':op.status==='cancelled'?'stopped':'failed',title:completed?'本轮回复已完成':op.status==='cancelled'?'本轮已停止':'本轮未完成',detail:completed?'回复和记录已保存，可以继续发消息。':op.error||'请查看聊天中的状态说明。',elapsed:'本轮耗时 '+duration(op.createdAt,op.finishedAt||serverNow)+(parts.length?' · '+parts.join(' · '):''),link,live:false,operationId:op.id};
  }
  const api={duration,describe};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RoomStatus=api;
})(typeof globalThis!=='undefined'?globalThis:this);
