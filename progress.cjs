function stamp(op,member,phase,label,observed=false,now=new Date().toISOString()){
  const old=op.progress,changed=!old||old.member!==member||old.phase!==phase||old.label!==label;
  op.progress={member,phase,label,updatedAt:changed?now:old.updatedAt};op.currentActivity=label;
  if(member){
    op.members??={};const m=op.members[member]??={startedAt:now};m.phase=phase;
    if(phase==='waiting'&&!m.submittedAt)m.submittedAt=now;
    if(['processing','generating','tools'].includes(phase)&&!m.firstActivityAt)m.firstActivityAt=now;
    if(observed)m.lastObservedAt=now;
  }
  return changed;
}
function finishMember(op,member,status='completed',now=new Date().toISOString()){
  const m=op.members?.[member];if(!m)return;m.finishedAt=now;m.status=status;
}
module.exports={stamp,finishMember};
