const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
function publish(workspace,d){
  for(const key of ['summary','limitations','next_step'])if(typeof d[key]!=='string')throw Error('Invalid delivery: '+key);
  if(!Array.isArray(d.evidence)||d.evidence.some(x=>typeof x!=='string')||!Array.isArray(d.files)||d.files.length>30)throw Error('Invalid delivery arrays');
  const root=fs.realpathSync(workspace),seen=new Set();let total=0;
  const files=d.files.map(f=>{
    if(typeof f.path!=='string'||typeof f.content!=='string')throw Error('Invalid file');
    const segments=f.path.replace(/\\/g,'/').split('/');
    if(!segments.length||segments.some(s=>!s||s.startsWith('.')||/[<>:"|?*\x00-\x1f]/.test(s)||/[. ]$/.test(s)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(s)))throw Error('Unsafe output path');
    const name=segments.join('/');
    if(['agents.md','brief.json','context.md'].includes(name.toLowerCase())||seen.has(name.toLowerCase()))throw Error('Reserved or duplicate output path');
    seen.add(name.toLowerCase());const target=path.resolve(root,...segments);
    if(!target.toLowerCase().startsWith(root.toLowerCase()+path.sep)||fs.existsSync(target))throw Error('Output escapes workspace or already exists');
    total+=Buffer.byteLength(f.content);if(total>2*1024*1024)throw Error('Delivery exceeds 2 MB');
    return {...f,path:name,target};
  });
  return files.map(f=>{
    fs.mkdirSync(path.dirname(f.target),{recursive:true});
    const parent=fs.realpathSync(path.dirname(f.target));
    if(parent.toLowerCase()!==root.toLowerCase()&&!parent.toLowerCase().startsWith(root.toLowerCase()+path.sep))throw Error('Output parent is outside workspace');
    fs.writeFileSync(f.target,f.content,{flag:'wx'});
    const bytes=fs.readFileSync(f.target);
    return {path:f.path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  });
}
module.exports={publish};
