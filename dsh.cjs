const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const log = process.env.DSH_LOG_PATH || path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'dsh-desktop', 'logs', 'harness.log'
);
async function connect() {
  if (!fs.existsSync(log)) throw Error('找不到 DSH 日志；请确认 DeepSeek Harness 正在运行，或设置 DSH_LOG_PATH');
  const matches = [...fs.readFileSync(log, 'utf8').matchAll(/\bdsh web:\s*(\S+)/gu)];
  const url = new URL(matches.at(-1)?.[1]);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw Error('Expected local DSH');
  const login = await fetch(url, {redirect:'manual',signal:AbortSignal.timeout(10000)});
  const cookie = login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  if (!cookie) throw Error('DSH launch authentication unavailable');
  return {
    origin:url.origin, cookie,
    async rpc(method, args) {
      const res = await fetch(url.origin + '/api/' + method, {method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Cookie:cookie,Origin:url.origin},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args}})});
      const data = await res.json();
      if (!data.result?.ok) throw Error(data.result?.error?.message||'DSH RPC failed');
      return data.result.value;
    }
  };
}
module.exports = {connect};
