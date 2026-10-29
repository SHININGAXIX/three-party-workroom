const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { connect } = require('./dsh.cjs');

async function main() {
  const file = path.join(__dirname, 'config.json');
  if (fs.existsSync(file)) {
    console.log('config.json 已存在；为保护现有会话，安装程序不会覆盖它。');
    return;
  }
  const dsh = await connect();
  const response = await dsh.rpc('session/list', { _request: {} });
  const sessions = response.items || [];
  if (!sessions.length) throw Error('DSH 中没有可用会话；请先在 DeepSeek Harness 中建立一条会话。');
  console.log('\n选择要沿用的 DeepSeek Harness 会话：');
  sessions.forEach((session, index) =>
    console.log((index + 1) + '. ' + (session.title || session.name || '(未命名)') + ' — ' + session.sessionId)
  );
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  try {
    const choice = (await prompt.question('输入编号：')).trim();
    const index = Number(choice) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= sessions.length) throw Error('无效的会话编号。');
    const dshSessionId = sessions[index].sessionId;
    if (!/^session-[a-f\d-]{36}$/i.test(dshSessionId)) throw Error('DSH 返回的会话 ID 格式无效。');
    const codexThreadId = (await prompt.question('已有专用 Codex 会话 UUID？没有就直接回车：')).trim();
    if (codexThreadId && !/^[a-f\d-]{36}$/i.test(codexThreadId)) throw Error('Codex 会话 UUID 格式无效。');
    const config = { codex: 'auto', dshSessionId, proxy: '', codexModel: '', codexThreadId, codexCallerThreadId: '' };
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
    console.log('\n已创建 config.json。现在可以双击“启动工作间.cmd”。');
    if (!codexThreadId) console.log('首次 Codex 回合会尝试通过本机 Codex CLI 建立固定会话。');
  } finally {
    prompt.close();
  }
}

if (require.main === module) main().catch(error => {
  console.error('设置失败：' + error.message);
  process.exitCode = 1;
});
