'use strict';
// 建站长账号。交互式;也支持环境变量(docker 首启用)。
const readline = require('node:readline');
const { query, pool } = require('../db/pool');
const { hash } = require('../auth/password');
const { ADMIN_VERBS } = require('../auth/guard');

// 普通问答(用户名/显示名/邮箱):就是标准 rl.question,没什么好设计的。
function ask(rl, q) {
  return new Promise((res) => rl.question(q, res));
}

// 控制字符常量,用 fromCharCode 拼,不在源码里直接放不可见字节。
const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(8);
const DEL = String.fromCharCode(127);

// 密码输入,尽量不回显明文。
//
// 设计说明(为什么没有照抄任务书草稿里 ask(..., {silent:true}) 的实现):
// 草稿那版靠操纵 rl.line(readline.Interface 内部未文档化的行缓冲属性)+ 手写转义序列
// 抹行重绘,并且在 readline 自己已经监听 stdin 'keypress' 的同时,再叠一个独立的
// 'data' 监听器去做屏蔽 —— 这两层监听器谁先处理、rl.line 有没有跟上,全靠“同一个
// event loop tick 内 emit 顺序凑巧对上”这种未保证的时序。本次任务是在非交互沙箱里
// 完成的,没有真实 TTY 可以坐下来敲键盘验证,没法确认那版草稿在真实终端里到底好不好使。
// 与其交付一个“可能好使也可能在 Windows 终端上出怪状态”的东西,这里改用更朴素、
// 只依赖 Node 官方文档化 API(process.stdin.isTTY / setRawMode / 'data' 事件)的实现:
// 自己维护一个输入缓冲区,逐字节读,回显 '*',支持退格和 Ctrl-C。逻辑更容易读懂和推理,
// 出问题也容易定位。
//
// 即便如此:这条路径本身仍然只在“无 TTY / 管道输入”分支下被实际跑过(见任务报告),
// setRawMode(true) 那条真正逐键屏蔽的分支没有真实终端可验,按任务要求在此明确标注为未验证。
function askPassword(promptText) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(promptText);

    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      // 没有 TTY(比如管道输入、CI):没法逐键拦截屏蔽,退化为明文回显,但要明确警告。
      console.error('\n[警告] 当前输入不是终端,密码将明文回显');
      const rl2 = readline.createInterface({ input: stdin, output: process.stdout, terminal: false });
      rl2.question('', (v) => { rl2.close(); resolve(v); });
      return;
    }

    let input = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    function cleanup() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    }

    // 逐字符处理这个 chunk,而不是把整块数据当一个字符比对。
    // 粘贴时终端常常把整段文本(包括结尾的换行)作为单个 'data' 事件一次性送达 ——
    // 如果只比较"整块 === '\n'",粘贴内容会整段落进 else 分支被当明文字符追加,
    // 换行永远等不到自己独立的一次 'data' 事件,提交要么卡住要么把换行也存进密码里。
    // 这里出问题只有一种后果:站长密码存的不是用户以为粘贴的那段——因为这是唯一
    // 一个站长账号,后果是没人知道真实密码,直接锁死后台。所以逐字符扫描,一旦遇到
    // 换行就当场提交并丢弃这个 chunk 里剩下的字符,不再整块比较。
    function onData(chunk) {
      const str = chunk.toString();
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '\n' || ch === '\r') {
          cleanup();
          process.stdout.write('\n');
          resolve(input);
          return; // 提交后不再处理这个 chunk 里剩下的字符
        } else if (ch === CTRL_C) {
          // Ctrl-C:老老实实退出,别留一个挂起的 raw-mode 终端
          cleanup();
          process.stdout.write('\n');
          process.exit(1);
          return;
        } else if (ch === DEL || ch === BACKSPACE) {
          // 退格(不同终端发 DEL 或 BS)
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          input += ch;
          process.stdout.write('*');
        }
      }
    }

    stdin.on('data', onData);
  });
}

async function main() {
  const envUser = process.env.ADMIN_USER;
  const envPass = process.env.ADMIN_PASSWORD;

  let username, password, email, displayName;

  if (envUser && envPass) {
    // 与交互式路径对齐:trim,否则纯空白的 ADMIN_PASSWORD 能混过后面的非空/长度校验。
    // 这条正是 Docker 首启(Task 21)会走的路径,不能比交互式路径更松。
    username = envUser.trim();
    password = envPass.trim();
    email = (process.env.ADMIN_EMAIL || `${username}@localhost`).trim();
    displayName = (process.env.ADMIN_DISPLAY_NAME || username).trim();
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    username    = (await ask(rl, '用户名: ')).trim();
    displayName = (await ask(rl, '显示名: ')).trim() || username;
    email       = (await ask(rl, '邮箱: ')).trim();
    rl.close();
    password    = await askPassword('密码: ');
  }

  if (!username || !password || !email) {
    console.error('用户名、密码、邮箱都不能为空'); process.exit(1);
  }
  // 与 app/routes/auth.js 的 /api/auth/register 同一套校验,而且是从
  // app/auth/guard.js 引入 ADMIN_VERBS(单一事实源),不是在这里手抄一份
  // ['review','decide',...] ——手抄的第二份清单正是这个项目此前真实
  // 漂移过的地方(见 password.js 的 scrypt 代价参数曾经就有两份)。
  // 不这样做的后果:站长自己起名叫 pending,GET /api/members/pending
  // 会被路由守卫当成后台路径永久打不开自己的主页。
  if (!/^[a-z0-9_-]{3,32}$/.test(username)) {
    console.error('用户名只能是 3–32 位的字母、数字、下划线或连字符'); process.exit(1);
  }
  if (ADMIN_VERBS.has(username)) {
    console.error('该用户名是系统保留词(review/decide/grant/clear/pending/suspend),换一个吧'); process.exit(1);
  }
  if (password.length < 8) {
    console.error('密码至少 8 位'); process.exit(1);
  }

  const dup = await query('SELECT 1 FROM users WHERE username=$1 OR email=$2', [username, email]);
  if (dup.rowCount) {
    console.error('该用户名或邮箱已存在'); process.exit(1);
  }

  const password_hash = await hash(password);
  const r = await query(
    `INSERT INTO users (username, password_hash, display_name, email, role, status)
     VALUES ($1,$2,$3,$4,'admin','approved') RETURNING id`,
    [username, password_hash, displayName, email]
  );
  console.log(`站长账号已创建:${username}(id=${r.rows[0].id})`);
  await pool.end();
}

// require.main 守卫:被 require(比如外部测试脚本探针 askPassword)时不会自动跑 main();
// 作为 CLI 直接执行(node app/bin/create-admin.js / npm run create-admin)时行为不变。
if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { askPassword, ask };
