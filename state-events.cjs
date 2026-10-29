const {randomUUID}=require('node:crypto');
// These events invalidate a snapshot; they never carry model text or credentials.
// A reconnect always requests a fresh /state, including after process restart.
class StateEvents{
  constructor(){this.epoch=randomUUID();this.seq=0;this.clients=new Set();}
  get cursor(){return this.epoch+':'+this.seq;}
  frame(type){return `id: ${this.cursor}\nevent: ${type}\ndata: {}\n\n`;}
  publish(){this.seq++;for(const res of this.clients){try{if(!res.write(this.frame('state')))res.destroy();}catch{res.destroy();this.clients.delete(res);}}}
  attach(req,res){
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
    res.write('retry: 1500\n\n'+this.frame(req.headers['last-event-id']===this.cursor?'state':'reset'));this.clients.add(res);
    const heartbeat=setInterval(()=>{if(!res.write(': heartbeat\n\n'))res.destroy();},15000);heartbeat.unref?.();
    res.on('close',()=>{clearInterval(heartbeat);this.clients.delete(res);});
  }
  close(){for(const res of this.clients)res.end();this.clients.clear();}
}
module.exports={StateEvents};
