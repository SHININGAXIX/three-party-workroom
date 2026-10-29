const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
function isFile(file){try{return fs.statSync(file).isFile();}catch{return false;}}
function resolveCodex(configured,options={}){
  if(configured&&configured!=='auto'&&isFile(configured))return path.resolve(configured);
  const binRoot=options.binRoot||path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'OpenAI','Codex','bin');
  let directories;try{directories=fs.readdirSync(binRoot,{withFileTypes:true});}catch{directories=[];}
  const candidates=directories.filter(d=>d.isDirectory()&&!d.isSymbolicLink()).map(d=>path.join(binRoot,d.name,'codex.exe')).filter(isFile).map(file=>({file,modified:fs.statSync(file).mtimeMs})).sort((a,b)=>b.modified-a.modified||a.file.localeCompare(b.file));
  if(!candidates.length)throw Error('找不到本机 Codex 程序，请打开 Codex 桌面端后重试；会话和聊天记录已保留。');
  return candidates[0].file;
}
module.exports={resolveCodex};
