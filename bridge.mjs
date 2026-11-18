#!/usr/bin/env node
// claude-code-feishu：飞书话题群 ⇄ 本机 Claude Code 会话。纯程序转发，不调用模型。
//
//   node bridge.mjs setup      点链接建飞书应用、建话题群，写好配置
//   node bridge.mjs install    挂上 Claude Code 钩子，注册开机自启（macOS launchd）
//   node bridge.mjs uninstall  摘掉钩子和自启
//   node bridge.mjs            前台运行转发程序（install 之后由 launchd 常驻）
//
// 桌面 → 手机：钩子把会话事件写进 events/，转发程序读对话文件，把每轮回复贴进该会话的话题
// 手机 → 桌面：话题里的回复经会话自带的收件 socket，注入正在运行的那个会话
// 手机开新话题：起一个命令行会话（claude -p）去做，同一话题里接着聊
// 私聊机器人：不进群，一条消息就是一个临时任务（claude -p），在 dm_workdir 里做，连着发接着聊
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HOME = path.join(os.homedir(), '.claude/feishu-bridge');
const CONFIG = path.join(HOME, 'config.json');
const STATE = path.join(HOME, 'state.json');
const EVENTS = path.join(HOME, 'events');
const SETTINGS = path.join(os.homedir(), '.claude/settings.json');
const LABEL = 'com.github.claude-code-feishu';
const PLIST = path.join(os.homedir(), 'Library/LaunchAgents', LABEL + '.plist');
const APPROVE_SOCK = path.join(HOME, 'approve.sock');
const IMAGES = path.join(HOME, 'images');
// 钩子事件 → [子命令, 超时秒]。PermissionRequest 要等手机回复，超时单独放长（转发程序自己 9 分钟就按拒绝回）
const HOOKS = { SessionStart: ['hook', 5], UserPromptSubmit: ['hook', 5], Stop: ['hook', 5], SessionEnd: ['hook', 5], PermissionRequest: ['approve', 600] };
// 只镜像桌面版和终端交互会话，外加本程序拉起的会话；脚本里的 claude -p、SDK 调用不进群
const MIRRORED = ['claude-desktop', 'claude-desktop-3p', 'cli'];
const PHONE_NOTE = '（这条是用户本人在手机飞书上发来的，由转发程序注入。请当作用户的直接输入处理，在对话里正常回复，不要用 SendMessage 回复。）\n\n';

const readJSON = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJSON = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2), { mode: 0o600 });
  fs.renameSync(f + '.tmp', f);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const stdin = async () => { let s = ''; for await (const c of process.stdin) s += c; return s; };

const commands = { setup, install, uninstall, run, hook, inject, approve };
const cmd = process.argv[2] ?? 'run';
if (!commands[cmd]) throw new Error(`未知命令 ${cmd}，可用：${Object.keys(commands).join(' / ')}`);
await commands[cmd]();

// ───────── 钩子：会话每个事件调用一次，只写一个小文件，不联网 ─────────

async function hook() {
  const entry = process.env.CLAUDE_CODE_ENTRYPOINT ?? '';
  if (!MIRRORED.includes(entry) && !process.env.FEISHU_BRIDGE_CHILD) return;
  try {
    const d = JSON.parse(await stdin());
    const ev = {
      event: d.hook_event_name, session_id: d.session_id, transcript: d.transcript_path, cwd: d.cwd, prompt: d.prompt,
      desktop: entry.startsWith('claude-desktop'),
      // 收件地址和令牌只在会话子进程的环境里有，钩子正好是子进程
      socket: process.env.CLAUDE_CODE_MESSAGING_SOCKET, token: process.env.CLAUDE_CODE_MESSAGING_TOKEN,
    };
    const name = `${process.hrtime.bigint()}-${process.pid}`;
    fs.mkdirSync(EVENTS, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(EVENTS, '.' + name), JSON.stringify(ev), { mode: 0o600 });
    fs.renameSync(path.join(EVENTS, '.' + name), path.join(EVENTS, name + '.json'));
  } catch {} // 钩子出错也不能打扰会话
}

// ───────── 注入：每次由转发程序现起一个新进程 ─────────
// 收件端会核对发送进程，比会话启动得早的常驻进程发的消息会被静默丢掉，所以每次现起。

async function inject() {
  const { socket, token, content } = JSON.parse(await stdin());
  const c = net.connect(socket, () =>
    c.end(JSON.stringify({ type: 'auth', token }) + '\n' + JSON.stringify({ type: 'user', from: 'feishu-phone', message: { role: 'user', content } }) + '\n'));
  c.on('close', (hadError) => process.exit(hadError ? 1 : 0));
  c.on('error', () => process.exit(1));
  setTimeout(() => process.exit(1), 3000);
}

// ───────── 审批：会话要弹权限确认时调用一次（PermissionRequest 钩子）─────────
// 本机所有会话都会走到这里。转发程序判断这一轮是不是手机发起的：是就把请求发到手机等回复；
// 不是、或者转发程序没在跑，就什么都不输出，会话照常弹窗（命令行 -p 则照常拒绝）

async function approve() {
  let line;
  try { line = JSON.stringify(JSON.parse(await stdin())) + '\n'; } catch { return; }
  const answer = await new Promise((resolve) => {
    let buf = '';
    const c = net.connect(APPROVE_SOCK, () => c.write(line));
    c.on('data', (d) => (buf += d));
    c.on('close', () => resolve(buf));
    c.on('error', () => resolve(''));
  });
  try {
    const decision = JSON.parse(answer);
    if (decision?.behavior) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
  } catch {}
}

// ───────── setup：建应用、建话题群 ─────────

async function setup() {
  const cfg = readJSON(CONFIG, {});
  if (!cfg.app_id) Object.assign(cfg, await registerApp());
  if (!cfg.chat_id) {
    const res = await (await larkClient(cfg)).client.im.v1.chat.create({
      params: { user_id_type: 'open_id' },
      data: { name: 'Claude', chat_mode: 'topic', owner_id: cfg.owner_open_id, user_id_list: [cfg.owner_open_id] },
    });
    if (res.code !== 0) throw new Error(`建群失败：${res.code} ${res.msg}`);
    cfg.chat_id = res.data.chat_id;
    console.log('已建好话题群「Claude」，你是群主。');
  }
  cfg.claude ??= execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim();
  cfg.workdir ??= os.homedir();
  cfg.permission_mode ??= 'bypassPermissions';
  writeJSON(CONFIG, cfg);
  console.log(`配置已写入 ${CONFIG}\n下一步：node bridge.mjs install`);
}

// 飞书官方 CLI 同款的应用注册设备流：PersonalAgent 模板自动开好机器人、消息权限、事件订阅和长连接
async function registerApp() {
  let base = 'https://accounts.feishu.cn';
  const call = async (body) =>
    (await fetch(base + '/oauth/v1/app/registration', { method: 'POST', body: new URLSearchParams(body) })).json();
  const begin = await call({ action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id tenant_brand' });
  if (!begin.device_code) throw new Error('飞书没有返回注册链接：' + JSON.stringify(begin));
  console.log(`\n在浏览器或飞书手机端打开这个链接，点「立即创建」：\n\n  ${begin.verification_uri_complete}\n`);
  let interval = (begin.interval || 5) * 1000;
  for (const deadline = Date.now() + (begin.expires_in || 600) * 1000; Date.now() < deadline; ) {
    await sleep(interval);
    const r = await call({ action: 'poll', device_code: begin.device_code });
    if (r.error === 'authorization_pending') continue;
    if (r.error === 'slow_down') { interval += 5000; continue; }
    if (r.error) throw new Error(`创建应用失败：${r.error} ${r.error_description ?? ''}`);
    // 国际版 Lark 的租户要换到 larksuite.com 再取一次
    if (!r.client_secret && r.user_info?.tenant_brand === 'lark') { base = 'https://accounts.larksuite.com'; continue; }
    console.log('应用已创建：' + r.client_id);
    return { app_id: r.client_id, app_secret: r.client_secret, owner_open_id: r.user_info.open_id, domain: base.includes('larksuite') ? 'lark' : 'feishu' };
  }
  throw new Error('等待超时，重新运行 setup 即可');
}

// ───────── install / uninstall ─────────

async function install() {
  if (!fs.existsSync(CONFIG)) throw new Error('先运行 setup');
  const settings = stripHooks(readJSON(SETTINGS, {}));
  for (const [e, [sub, timeout]] of Object.entries(HOOKS))
    ((settings.hooks ??= {})[e] ??= []).push({ hooks: [{ type: 'command', command: `"${process.execPath}" "${SELF}" ${sub}`, timeout }] });
  writeJSON(SETTINGS, settings);
  console.log(`钩子已写入 ${SETTINGS}`);
  if (process.platform !== 'darwin') return console.log(`请用 systemd、pm2 等常驻运行：node ${SELF}`);

  const out = path.join(HOME, 'bridge.log');
  fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${SELF}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${out}</string>
  <key>StandardErrorPath</key><string>${out}</string>
</dict></plist>
`);
  const service = `gui/${process.getuid()}/${LABEL}`;
  launchctl('bootout', service);
  // bootout 是异步的：旧进程没退干净就 bootstrap 会失败，等它退完再注册
  for (let i = 0; i < 50 && launchctl('print', service); i++) await sleep(100);
  if (!launchctl('bootstrap', `gui/${process.getuid()}`, PLIST)) throw new Error(`启动失败，手动试试：launchctl bootstrap gui/${process.getuid()} ${PLIST}`);
  console.log(`已启动并设为开机自启：${LABEL}，日志 ${out}`);
}

function uninstall() {
  writeJSON(SETTINGS, stripHooks(readJSON(SETTINGS, {})));
  launchctl('bootout', `gui/${process.getuid()}/${LABEL}`);
  fs.rmSync(PLIST, { force: true });
  console.log(`已摘掉钩子和自启，配置和状态留在 ${HOME}`);
}

function stripHooks(settings) {
  for (const e of Object.keys(HOOKS)) {
    const list = settings.hooks?.[e]?.filter((g) => !g.hooks?.some((h) => h.command?.includes(SELF)));
    if (list?.length) settings.hooks[e] = list;
    else delete settings.hooks?.[e];
  }
  return settings;
}

function launchctl(...args) {
  try { execFileSync('launchctl', args, { stdio: 'ignore' }); return true; } catch { return false; }
}

// ───────── 转发程序 ─────────

async function larkClient(cfg) {
  const lark = await import('@larksuiteoapi/node-sdk');
  const opts = { appId: cfg.app_id, appSecret: cfg.app_secret, domain: cfg.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu };
  return { lark, opts, client: new lark.Client(opts) };
}

async function run() {
  const cfg = readJSON(CONFIG, null);
  if (!cfg?.chat_id) throw new Error('先运行 setup');
  const { lark, opts, client } = await larkClient(cfg);

  // sessions: { [sessionId]: { root, title, cwd, transcript, desktop, socket, token, posted[], pending[] } }
  // roots:    { [话题首条消息 id]: sessionId }
  const state = readJSON(STATE, { sessions: {}, roots: {} });
  const save = () => writeJSON(STATE, state);
  const session = (id) => (state.sessions[id] ??= { posted: [], pending: [] });

  const cardOf = (elements) => JSON.stringify({ schema: '2.0', body: { elements } });
  const card = (md) => cardOf([{ tag: 'markdown', content: md }]);
  // 有 root 就回进群里那个话题；否则发到 chat（默认话题群，私聊会话传私聊的 chat_id）
  async function postCard(elements, root, chat = cfg.chat_id) {
    const content = cardOf(elements);
    const res = root
      ? await client.im.v1.message.reply({ path: { message_id: root }, data: { msg_type: 'interactive', content, reply_in_thread: true } })
      : await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chat, msg_type: 'interactive', content } });
    if (res.code !== 0) throw new Error(`feishu ${res.code} ${res.msg}`);
    return res.data.message_id;
  }
  const post = (md, root, chat) => postCard([{ tag: 'markdown', content: md }], root, chat);
  const patch = (id, md) => client.im.v1.message.patch({ path: { message_id: id }, data: { content: card(md) } }).catch(() => {});
  const react = (id) => client.im.v1.messageReaction.create({ path: { message_id: id }, data: { reaction_type: { emoji_type: 'OnIt' } } }).catch(() => {});
  // 按钮点了走 card.action.trigger 回调，value 原样带回来
  const button = (text, value, type = 'default') => ({ tag: 'button', text: { tag: 'plain_text', content: text }, type, behaviors: [{ type: 'callback', value }] });
  const buttonRow = (buttons) => ({ tag: 'column_set', flex_mode: 'flow', horizontal_spacing: '8px', columns: buttons.map((b) => ({ tag: 'column', width: 'auto', elements: [b] })) });
  const plain = (content) => ({ tag: 'plain_text', content });

  // 读对话文件末尾（默认 4MB）
  function readTail(file, max = 4 << 20) {
    try {
      const fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, max));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      fs.closeSync(fd);
      return buf.toString('utf8').split('\n').slice(size > buf.length ? 1 : 0).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    } catch { return []; }
  }
  // 会话标题：桌面版和终端都会往对话文件里写 custom-title / ai-title
  const titleOf = (records) => records.findLast((r) => r.customTitle)?.customTitle ?? records.findLast((r) => r.aiTitle)?.aiTitle;
  // 用户输入（一轮的开头）：真人打的字或排队进来的消息，不算工具结果
  function isPrompt(r) {
    const c = r.message?.content;
    return (r.type === 'user' && !r.isMeta && (typeof c === 'string' || (Array.isArray(c) && c.some((b) => b.type === 'text') && !c.some((b) => b.type === 'tool_result')))) ||
      (r.type === 'attachment' && r.attachment?.type === 'queued_command');
  }
  // 本轮（最后一个用户输入之后）还没发过的助手文字
  function turnTexts(records, posted) {
    let out = [];
    for (const r of records) {
      if (r.isSidechain) continue;
      const c = r.message?.content;
      if (isPrompt(r)) out = [];
      else if (r.type === 'assistant' && Array.isArray(c) && !posted.includes(r.uuid)) {
        const text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (text) out.push({ uuid: r.uuid, text });
      }
    }
    return out;
  }

  const header = (s) => `${s.desktop ? '🖥' : '⌨️'} **${s.title}**\n${s.cwd ?? ''}`;
  // 每个会话一个话题。标题往往在第一轮之后才起好，起好后改写话题首条
  async function topic(id, title, hint) {
    const s = session(id);
    if (!s.root) {
      s.title = title || hint || id.slice(0, 8);
      s.root = await post(header(s));
      state.roots[s.root] = id;
    } else if (title && title !== s.title) {
      s.title = title;
      await client.im.v1.message.patch({ path: { message_id: s.root }, data: { content: card(header(s)) } }).catch(() => {});
    }
    return s.root;
  }

  async function handleEvent(ev) {
    const s = session(ev.session_id);
    if (ev.cwd) s.cwd = ev.cwd;
    if (ev.transcript) s.transcript = ev.transcript;
    if (ev.desktop) s.desktop = true;
    if (ev.socket && ev.token) Object.assign(s, { socket: ev.socket, token: ev.token });
    if (ev.event === 'SessionEnd') {
      Object.assign(s, { socket: undefined, token: undefined });
      finishStatus(ev.session_id, '⏹ 会话已结束');
    }

    if (ev.event === 'UserPromptSubmit' && ev.prompt) {
      const i = s.pending.findIndex((t) => ev.prompt.includes(t));
      // phone 记下这一轮是谁发起的：手机发起的那一轮，权限确认才转到手机
      s.phone = i >= 0;
      await finishStatus(ev.session_id, '⏹ 已结束'); // 上一轮被中断时收不到 Stop
      if (s.phone) startStatus(ev.session_id);
      if (i >= 0) s.pending.splice(i, 1); // 手机发来的，不回显
      else if (s.dm) await post(`🖥 **桌面**：${ev.prompt.slice(0, 3000)}`, null, s.dm);
      else await post(`🖥 **桌面**：${ev.prompt.slice(0, 3000)}`, await topic(ev.session_id, titleOf(readTail(s.transcript)), ev.prompt.slice(0, 40)));
    }
    if (ev.event === 'Stop' && s.transcript) {
      await sleep(800); // 等对话文件写完
      await finishStatus(ev.session_id, '✅ 完成');
      const records = readTail(s.transcript);
      const texts = turnTexts(records, s.posted);
      // 私聊里开的会话回私聊，其余回群里各自的话题
      const root = s.dm ? null : await topic(ev.session_id, titleOf(records));
      const md = texts.map((t) => t.text).join('\n\n');
      for (let i = 0; i < md.length; i += 12000) await post(md.slice(i, i + 12000), root, s.dm); // 卡片有长度上限
      if (s.dm && state.dm?.session === ev.session_id) state.dm.last = Date.now(); // 空闲从回完这一轮算起
      s.posted = [...s.posted, ...texts.map((t) => t.uuid)].slice(-300);
    }
    save();
  }

  let chain = Promise.resolve();
  const drain = () => (chain = chain.then(async () => {
    let files = [];
    try { files = fs.readdirSync(EVENTS).filter((f) => f.endsWith('.json')).sort(); } catch {}
    for (const f of files) {
      const p = path.join(EVENTS, f);
      try { await handleEvent(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch (e) {
        log('event failed', f, e.message);
        if (Date.now() - fs.statSync(p).mtimeMs < 3600e3) break; // 多半是断网，留着下一轮按顺序重试
      }
      fs.rmSync(p, { force: true });
    }
  }));

  // 现起注入进程发出去，再看对话文件里有没有出现这条，没有就重试一次
  async function deliver(s, text) {
    const needle = JSON.stringify(text).slice(1, -1);
    for (let attempt = 0; attempt < 2; attempt++) {
      const ok = await new Promise((resolve) => {
        const child = spawn(process.execPath, [SELF, 'inject'], { stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('exit', (code) => resolve(code === 0)).on('error', () => resolve(false));
        child.stdin.end(JSON.stringify({ socket: s.socket, token: s.token, content: PHONE_NOTE + text }));
      });
      if (!ok) return false;
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        if (readTail(s.transcript).some((r) => JSON.stringify(r).includes(needle))) return true;
      }
    }
    return false;
  }

  // 同一会话同一时刻只跑一个 claude -p：上一条没跑完时后来的消息先排队，跑完合成一条再续，
  // 免得两个 --resume 并行把一份对话分叉成两份
  const running = new Map(); // sessionId -> 排队中的消息
  // 在某个 Claude Code 会话里手动起转发程序时，会继承那个会话的入口、收件 socket、API 地址等环境变量；
  // 原样传给 claude -p，钩子会把它当成那个会话（桌面版）的事件。launchd 起的没有这些，不受影响
  function childEnv() {
    const env = { ...process.env, FEISHU_BRIDGE_CHILD: '1' };
    if (process.env.CLAUDECODE) for (const k of Object.keys(env)) if (/^(CLAUDE|MCP_|ANTHROPIC_BASE_URL$)/.test(k)) delete env[k];
    return env;
  }
  // 用桌面版同款的 stream-json 模式跑：权限确认和 AskUserQuestion 选择题经 stdio 问到这里（answerTool），
  // 纯文本 -p 模式下没有 AskUserQuestion。一个进程只跑一条消息，跑完关掉输入让它退出
  function runCli(id, text, resume) {
    if (running.has(id)) return running.get(id).push(text);
    running.set(id, []);
    const s = session(id);
    s.pending.push(text);
    if (!resume && cfg.desktop_import !== false) s.to_desktop = true;
    const mode = (s.dm && cfg.dm_permission_mode) || cfg.permission_mode;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-prompt-tool', 'stdio', '--permission-mode', mode, resume ? '--resume' : '--session-id', id];
    const child = spawn(cfg.claude, args, { cwd: s.cwd || cfg.workdir, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    log('cli start', id.slice(0, 8), resume ? 'resume' : 'new', s.cwd);
    const send = (o) => child.stdin.writable && child.stdin.write(JSON.stringify(o) + '\n');
    child.stdin.on('error', () => {});
    send({ type: 'user', message: { role: 'user', content: text } });
    let err = '', out = '', failed = false;
    child.stderr.on('data', (d) => (err = (err + d).slice(-1500)));
    child.on('error', (e) => (err += e.message));
    child.stdout.on('data', (d) => {
      out += d;
      for (let i; (i = out.indexOf('\n')) >= 0;) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'control_request') {
          const reply = (response) => send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
          const fail = (e) => send({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: e.message } });
          if (msg.request?.subtype === 'can_use_tool') answerTool(s, msg.request).then(reply, fail);
          else fail(new Error(`unsupported control request ${msg.request?.subtype}`));
        } else if (msg.type === 'result') {
          if (msg.is_error) {
            failed = true;
            err = String(msg.result ?? msg.subtype ?? 'error').slice(-1500) + (err ? `\n\n${err}` : '');
          }
          child.stdin.end();
        }
      }
    });
    child.on('close', (code) => { // 进程没能起来（error）时也会触发 close
      log('cli exit', id.slice(0, 8), code);
      finishStatus(id, code || failed ? '⚠️ 出错了' : '✅ 完成');
      if (code || failed) post(`⚠️ 命令行会话出错（退出码 ${code}）\n\n${err}`, s.root, s.dm).catch(() => {});
      const queued = running.get(id);
      running.delete(id);
      if (queued.length) return runCli(id, queued.join('\n\n'), true);
      if (!code && !failed && s.to_desktop) importToDesktop(id).catch((e) => log('desktop import failed', id.slice(0, 8), e.message));
    });
  }

  // 手机开的会话，命令行跑完第一轮后导入桌面版：先在对话文件末尾写上标题（和 /rename 写的是同一种记录），
  // 再用桌面版自己的 claude://resume 深链接导入。桌面版只登记会话并切到它，不起进程；
  // 之后在桌面里接着聊，就是同一个会话 id 的桌面会话
  async function importToDesktop(id) {
    const s = session(id);
    delete s.to_desktop;
    save();
    await drain(); // 拿到钩子报上来的对话文件路径
    if (!s.transcript || !fs.existsSync(s.transcript)) return log('desktop import skipped: no transcript', id.slice(0, 8));
    fs.appendFileSync(s.transcript, JSON.stringify({ type: 'custom-title', customTitle: `📱 ${s.title}`, sessionId: id }) + '\n');
    await new Promise((resolve) =>
      spawn('/usr/bin/open', ['-g', `claude://resume?session=${id}`], { stdio: 'ignore' }).on('close', resolve).on('error', resolve));
    log('desktop import', id.slice(0, 8));
  }

  // 接着一个已有会话聊：命令行还在跑就排队；有进程开着（桌面版或命令行）就注入；
  // 进程已经没了就用命令行续上。桌面版下次接着聊时按会话 id 从对话文件续，命令行续的那几轮也在里面
  const alive = (sock) => {
    const pid = Number(path.basename(sock, '.sock'));
    if (!fs.existsSync(sock)) return false;
    if (!pid) return true;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  };
  async function resumeWith(id, text, m, say) {
    const s = session(id);
    if (!running.has(id)) {
      await drain(); // 先把钩子事件读完，拿到最新的收件地址
      if (s.socket && s.token && alive(s.socket)) {
        s.pending.push(text);
        if (await deliver(s, text)) {
          save();
          return react(m.message_id);
        }
        s.pending.pop();
        return say('没送进去：这个会话的进程还开着，但没收到这条。稍后再发一次。');
      }
      Object.assign(s, { socket: undefined, token: undefined }); // 进程已经退了（没赶上报 SessionEnd 时）
    }
    runCli(id, text, true); // 上一条还在跑就排队
    react(m.message_id);
  }

  // ───── 手机审批和选择题 ─────
  // 手机发起的那一轮要确认权限、或者 Claude 用 AskUserQuestion 提问时，发一张带按钮的卡片到私聊或话题，
  // 等手机上点按钮（card.action.trigger 回调）或回文字。同一个地方一次只问一个，回复只对应眼前这一个；超时按拒绝。
  // 转发程序自己起的会话经 stdio 问到 answerTool；桌面版、终端会话经 PermissionRequest 钩子问到 decide
  const asking = new Map(); // 私聊 chat_id 或话题 root -> 队尾（排队用）
  const waiting = new Map(); // 私聊 chat_id 或话题 root -> 眼前这个请求 { text(回复) }
  const prompts = new Map(); // 请求 id -> 同一个请求 { click(按钮值, 表单值) }，按钮回调按 id 找
  const clip = (t, n = 3000) => (t.length > n ? t.slice(0, n) + `\n…（共 ${t.length} 字，只显示前 ${n} 字）` : t);
  const chunks = (md) => (md.length <= 12000 ? [md] : Array.from({ length: Math.ceil(md.length / 12000) }, (_, i) => md.slice(i * 12000, (i + 1) * 12000)));
  function enqueue(key, fn) {
    const turn = (asking.get(key) ?? Promise.resolve()).then(fn);
    asking.set(key, turn.catch(() => {}));
    return turn;
  }

  // spec: body 正文；hint(分钟) 怎么回；controls(id) 按钮或表单；fromText / fromClick 把回复变成结果，
  // 看不懂时返回一句提示（字符串）；summary(结果) 答完后卡片上显示什么；timeout(分钟) 超时的结果
  async function ask(key, root, chat, spec) {
    const id = crypto.randomUUID().slice(0, 8);
    const mins = cfg.approve_timeout_minutes ?? 9; // 钩子最多等 600 秒，超时由这里回拒绝，而不是钩子被杀
    const parts = chunks(`${spec.body}\n\n${spec.hint(mins)}`); // 卡片有长度上限，长的分几条，按钮放最后一条
    for (const p of parts.slice(0, -1)) await post(p, root, chat);
    let msg;
    try {
      msg = await postCard([{ tag: 'markdown', content: parts.at(-1) }, ...spec.controls(id)], root, chat);
    } catch (e) { // 卡片结构被拒时退回纯文字，回文字照样能答
      log('button card failed', e.message);
      msg = await post(parts.at(-1), root, chat);
    }
    const final = (result) => `${parts.length === 1 ? spec.body : '（内容见上面几条）'}\n\n${spec.summary(result)}`;
    return new Promise((resolve) => {
      const finish = (result) => {
        clearTimeout(timer);
        waiting.delete(key);
        prompts.delete(id);
        resolve(result);
        nudgeStatus(key);
        return final(result);
      };
      const timer = setTimeout(() => {
        patch(msg, finish(spec.timeout(mins)));
        post(`⏱ ${mins} 分钟没有回复，已按拒绝处理。`, root, chat).catch(() => {});
      }, mins * 60e3);
      const entry = {
        text(t) {
          const r = spec.fromText(t);
          if (typeof r === 'string') return r;
          patch(msg, finish(r));
        },
        click(value, form) {
          const r = spec.fromClick(value, form);
          if (typeof r === 'string') return { toast: { type: 'warning', content: r } };
          return { toast: { type: 'success', content: '已提交' }, card: { type: 'raw', data: JSON.parse(card(finish(r))) } };
        },
      };
      waiting.set(key, entry);
      prompts.set(id, entry);
      nudgeStatus(key);
    });
  }

  function describe({ tool_name: tool, tool_input: input = {} }) {
    let body;
    // 命令不截断：截掉尾巴可能正好藏着危险部分
    if (tool === 'Bash') body = '```\n' + input.command + '\n```' + (input.description ? `\n${input.description}` : '');
    else if (input.file_path) {
      const content = input.content ?? input.new_string;
      body = `\`${input.file_path}\`` + (content ? '\n```\n' + clip(content) + '\n```' : '');
    } else body = '```\n' + clip(JSON.stringify(input, null, 2)) + '\n```';
    return `🔐 **需要确认：${tool}**\n${body}`;
  }
  const refused = (said) => ({ behavior: 'deny', message: said ? `用户在手机上拒绝了，并说：${said}` : '用户在手机上拒绝了。' });
  const approvalSpec = (req) => ({
    body: describe(req),
    hint: (mins) => `点按钮，或回复 **y** 允许、**n** 拒绝；直接说别的也算拒绝，并把你的话转给 Claude。${mins} 分钟内不回按拒绝。`,
    controls: (id) => [buttonRow([button('允许', { a: 'allow', id }, 'primary_filled'), button('拒绝', { a: 'deny', id }, 'danger')])],
    fromText: (t) => (/^(y|yes|ok|好|是|允许|可以|同意)$/i.test(t) ? { behavior: 'allow' } : refused(/^(n|no|否|不|拒绝|不行|不要)$/i.test(t) ? '' : t)),
    fromClick: (v) => (v.a === 'allow' ? { behavior: 'allow' } : refused('')),
    summary: (r) => (r.behavior === 'allow' ? '✅ 已允许' : `❌ ${r.message.replace(/^用户在手机上/, '')}`),
    timeout: (mins) => ({ behavior: 'deny', message: `用户在手机上 ${mins} 分钟内没有确认，已拒绝。` }),
  });

  // AskUserQuestion：单题单选直接点选项；多选或多题用表单（下拉 + 自己写），点提交。
  // 也能回文字：编号（多选用逗号隔开，多题按顺序用 / 隔开）或直接打字
  function textAnswers(qs, text) {
    const parts = qs.length === 1 ? [text] : text.split(/\s*[\n/／]\s*/).filter(Boolean);
    if (parts.length !== qs.length) return null;
    return Object.fromEntries(qs.map((q, i) => {
      const nums = parts[i].split(/[\s,，、]+/).filter(Boolean);
      const ok = nums.every((n) => /^\d+$/.test(n) && +n >= 1 && +n <= q.options.length) && (q.multiSelect || nums.length === 1);
      return [q.question, ok ? nums.map((n) => q.options[n - 1].label).join(', ') : parts[i]];
    }));
  }
  function questionSpec(input) {
    const qs = input.questions ?? [];
    const simple = qs.length === 1 && !qs[0].multiSelect;
    const answered = (answers) => ({ behavior: 'allow', updatedInput: { ...input, answers } });
    const options = (q) => q.options.map((o, j) => ({ text: plain(o.label), value: String(j) }));
    return {
      body: '❓ **Claude 在问你**\n\n' + qs.map((q, i) =>
        `**${qs.length > 1 ? `${i + 1}. ` : ''}${q.question}**${q.multiSelect ? '（可多选）' : ''}\n` +
        q.options.map((o, j) => `${j + 1}. ${o.label}${o.description && o.description !== o.label ? ` — ${o.description}` : ''}`).join('\n')).join('\n\n'),
      hint: (mins) => (simple ? '点选项，或回复编号；也可以直接打字回答。'
        : qs.length === 1 ? '选好后点提交；也可以回复编号（多个用逗号隔开），或直接打字。'
          : '选好后点提交；也可以按题目顺序回复编号、用 / 隔开（如 2 / 1,3），或直接打字。') + `${mins} 分钟内不回就当没回答。`,
      controls: (id) => (simple
        ? [buttonRow(qs[0].options.map((o, j) => button(o.label, { a: 'pick', id, o: j })))]
        : [{
          tag: 'form', name: `ask_${id}`, elements: [
            ...qs.flatMap((q, i) => [
              { tag: 'markdown', content: `**${qs.length > 1 ? `${i + 1}. ` : ''}${q.question}**` },
              { tag: q.multiSelect ? 'multi_select_static' : 'select_static', name: `q${i}`, placeholder: plain(q.multiSelect ? '选一个或多个' : '选一个'), options: options(q) },
              { tag: 'input', name: `o${i}`, placeholder: plain('不在选项里？写在这') },
            ]),
            { tag: 'button', name: 'submit', text: plain('提交'), type: 'primary_filled', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { a: 'form', id } }] },
          ],
        }]),
      fromText: (t) => {
        const a = textAnswers(qs, t);
        return a ? answered(a) : `有 ${qs.length} 道题，按顺序用 / 隔开回复，比如 2 / 1,3`;
      },
      fromClick: (v, form) => {
        if (v.a === 'pick') return answered({ [qs[0].question]: qs[0].options[v.o]?.label ?? '' });
        const answers = {};
        for (const [i, q] of qs.entries()) {
          const picked = [].concat(form[`q${i}`] ?? []).map((j) => q.options[+j]?.label).filter(Boolean);
          const own = String(form[`o${i}`] ?? '').trim();
          if (!picked.length && !own) return `第 ${i + 1} 题还没选`;
          answers[q.question] = [...picked, ...(own ? [own] : [])].join(', ');
        }
        return answered(answers);
      },
      summary: (r) => (r.behavior === 'allow'
        ? '✅ 已回答\n' + Object.entries(r.updatedInput.answers).map(([q, a]) => `- ${q} → **${a}**`).join('\n')
        : `⏱ ${r.message.replace(/^用户在手机上/, '')}`),
      timeout: (mins) => ({ behavior: 'deny', message: `用户在手机上 ${mins} 分钟内没有回答。` }),
    };
  }

  // 手机发来的图片存在 images/ 里，读它不用再问
  const isImageRead = (tool, input) => tool === 'Read' && String(input?.file_path ?? '').startsWith(IMAGES + path.sep);

  // 转发程序自己起的会话（stdio）：返回 { behavior: 'allow', updatedInput } 或 { behavior: 'deny', message }
  async function answerTool(s, req) {
    const key = s.dm ?? s.root;
    const root = s.dm ? null : s.root;
    const input = req.input ?? {};
    if (!key) return { behavior: 'deny', message: '转发程序找不到这个会话对应的飞书会话，没法确认。' };
    if (req.tool_name === 'AskUserQuestion') return enqueue(key, () => ask(key, root, s.dm, questionSpec(input)));
    if (isImageRead(req.tool_name, input)) return { behavior: 'allow', updatedInput: input };
    const d = await enqueue(key, () => ask(key, root, s.dm, approvalSpec({ tool_name: req.tool_name, tool_input: input })));
    return d.behavior === 'allow' ? { behavior: 'allow', updatedInput: input } : d;
  }

  // 桌面版、终端会话（PermissionRequest 钩子）：返回 { behavior, message? }；返回 null 表示不表态，会话照常弹窗
  async function decide(req) {
    await drain(); // 先把钩子事件读完，才知道这一轮是不是手机发起的
    const s = state.sessions[req.session_id];
    if (!s?.phone) return null;
    if (running.has(req.session_id)) return null; // 转发程序自己起的：不在这里答，CLI 会接着经 stdio 问到 answerTool
    const key = s.dm ?? s.root;
    if (!key) return null;
    if (req.tool_name === 'AskUserQuestion') { // 钩子答不了选择题，只能在桌面上点
      post(`${questionSpec(req.tool_input ?? {}).body}\n\n这道题要在桌面版里选，手机上答不了。`, s.dm ? null : s.root, s.dm).catch(() => {});
      return null;
    }
    if (isImageRead(req.tool_name, req.tool_input)) return { behavior: 'allow' };
    return enqueue(key, () => ask(key, s.dm ? null : s.root, s.dm, approvalSpec(req)));
  }

  fs.rmSync(APPROVE_SOCK, { force: true });
  net.createServer((c) => {
    let buf = '', done = false;
    c.on('data', async (d) => {
      buf += d;
      if (done || !buf.includes('\n')) return;
      done = true;
      let decision = null;
      try { decision = await decide(JSON.parse(buf)); } catch (e) { log('approve failed', e.message); }
      if (decision) log('approve', decision.behavior);
      c.end(JSON.stringify(decision));
    });
    c.on('error', () => {}); // 钩子超时被杀时连接会断，不用管
  }).listen(APPROVE_SOCK, () => fs.chmodSync(APPROVE_SOCK, 0o600));

  // 手机回文字答眼前这个请求；看不懂就回一句提示，请求继续等
  function answerPending(key, text, m) {
    const p = waiting.get(key);
    if (!p || !text) return false;
    const hint = p.text(text);
    if (hint) post(hint, m.chat_type === 'p2p' ? null : key, m.chat_type === 'p2p' ? m.chat_id : undefined).catch(() => {});
    else react(m.message_id);
    return true;
  }

  // ───── 工作中 ─────
  // 手机发起的一轮开始时（UserPromptSubmit）发一张状态卡片，每 15 秒按对话文件刷新：用时、调用了几次工具、
  // 最近在做什么、是不是在等你确认；这一轮结束（Stop、进程退出、会话结束）时改成完成
  const status = new Map(); // sessionId -> { key, start, msg, timer, shown }
  const duration = (ms) => (ms < 60e3 ? `${Math.round(ms / 1e3)} 秒` : `${Math.floor(ms / 60e3)} 分 ${Math.round((ms % 60e3) / 1e3)} 秒`);
  function toolLine(b) {
    const i = b.input ?? {};
    const arg = i.description ?? i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.query ?? i.prompt ?? i.sql ?? '';
    return `${b.name}${arg ? ` · ${String(arg).replace(/\s+/g, ' ').slice(0, 80)}` : ''}`;
  }
  function statusMd(id, st, done) {
    const records = readTail(session(id).transcript, 1 << 20).filter((r) => !r.isSidechain);
    const start = records.findLastIndex(isPrompt);
    const tools = records.slice(start + 1).flatMap((r) => (r.type === 'assistant' && Array.isArray(r.message?.content) ? r.message.content.filter((b) => b?.type === 'tool_use') : []));
    const count = tools.length ? ` · 调用工具 ${tools.length} 次` : '';
    if (done) return `${done} · 用时 ${duration(Date.now() - st.start)}${count}`;
    const lines = [`⏳ **工作中** · ${duration(Date.now() - st.start)}${count}`];
    if (waiting.has(st.key)) lines.push('⏸ 在等你回复（看下面那条）');
    else if (tools.length) lines.push(`最近：${toolLine(tools.at(-1))}`);
    else lines.push('正在想…');
    return lines.join('\n');
  }
  function startStatus(id) {
    const s = session(id);
    const key = s.dm ?? s.root;
    if (!key || status.has(id)) return;
    const st = { key, start: Date.now() };
    status.set(id, st);
    st.msg = post(statusMd(id, st), s.dm ? null : s.root, s.dm).catch(() => null);
    st.timer = setInterval(() => refreshStatus(id), 15e3);
  }
  async function refreshStatus(id) {
    const st = status.get(id);
    if (!st) return;
    const s = session(id);
    // 进程已经没了却没收到结束信号（被打断、崩溃）
    if (!running.has(id) && !(s.socket && alive(s.socket))) return finishStatus(id, '⏹ 已停止');
    if (Date.now() - st.start > 6 * 3600e3) return finishStatus(id, '⏹ 超过 6 小时，不再刷新');
    const md = statusMd(id, st);
    if (md === st.shown) return;
    st.shown = md;
    const msg = await st.msg;
    if (msg && status.get(id) === st) await patch(msg, md);
  }
  async function finishStatus(id, done) {
    const st = status.get(id);
    if (!st) return;
    status.delete(id);
    clearInterval(st.timer);
    const msg = await st.msg;
    if (msg) await patch(msg, statusMd(id, st, done));
  }
  const nudgeStatus = (key) => { for (const [id, st] of status) if (st.key === key) refreshStatus(id); };

  // ───── 图片 ─────
  // 手机发来的图片下载到 images/（留 7 天），在消息里附上路径让 Claude 用 Read 看
  async function fetchImages(m, keys) {
    fs.mkdirSync(IMAGES, { recursive: true, mode: 0o700 });
    for (const f of fs.readdirSync(IMAGES)) {
      const p = path.join(IMAGES, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 7 * 86400e3) fs.rmSync(p, { force: true });
    }
    const files = [];
    for (const [i, key] of keys.entries()) {
      const res = await client.im.v1.messageResource.get({ path: { message_id: m.message_id, file_key: key }, params: { type: 'image' } });
      const base = path.join(IMAGES, `${m.message_id}-${i}`);
      await res.writeFile(base);
      // Read 按扩展名认图片，按文件头补上
      const head = fs.readFileSync(base).subarray(0, 12);
      const ext = head[0] === 0xff ? 'jpg' : head.toString('latin1', 1, 4) === 'PNG' ? 'png' : head.toString('latin1', 0, 3) === 'GIF' ? 'gif' : head.toString('latin1', 8, 12) === 'WEBP' ? 'webp' : 'png';
      fs.renameSync(base, `${base}.${ext}`);
      files.push(`${base}.${ext}`);
    }
    return files;
  }

  async function onPhoneMessage({ message: m, sender }) {
    // 只认本人：别人私聊机器人也能在这台电脑上跑 Claude，所以私聊和群里一样先核对发送人
    if (sender?.sender_id?.open_id !== cfg.owner_open_id) return log('ignored: not owner', m.message_id);
    const dm = m.chat_type === 'p2p';
    if (!dm && m.chat_id !== cfg.chat_id) return log('ignored: other chat', m.chat_id);
    let text = '', images = [];
    try {
      const c = JSON.parse(m.content);
      if (m.message_type === 'text') text = c.text;
      else if (m.message_type === 'image') images = [c.image_key];
      else { // post：富文本，段落里混着文字和图片
        const els = (c.content ?? []).flat();
        text = els.map((x) => x.text ?? '').join('');
        images = els.filter((x) => x.tag === 'img' && x.image_key).map((x) => x.image_key);
      }
    } catch {}
    text = text.replace(/@_user_\d+/g, '').trim();
    const key = dm ? m.chat_id : m.root_id || m.message_id;
    if (answerPending(key, text, m)) return;
    if (images.length) {
      try {
        const files = await fetchImages(m, images);
        text = [text, ...files.map((f) => `[图片] ${f}`), '（手机发来的图片，已存到上面的路径，请用 Read 工具查看）'].filter(Boolean).join('\n');
      } catch (e) {
        return post(`图片下载失败：${e.message}`, dm ? null : key, dm ? m.chat_id : undefined);
      }
    }
    if (dm) return onDirectMessage(m, text);
    if (!text) return post('暂时只支持文字和图片。', key);

    const id = state.roots[key];
    if (!id) {
      // 新话题：起一个命令行会话
      const nid = crypto.randomUUID();
      Object.assign(session(nid), { root: key, title: titleFrom(text), cwd: cfg.workdir });
      state.roots[key] = nid;
      save();
      runCli(nid, text, false);
      return react(m.message_id);
    }
    return resumeWith(id, text, m, (md) => post(md, key));
  }

  // 会话标题取第一行文字；只发了图片时叫「图片」
  const titleFrom = (text) =>
    text.split('\n').find((l) => l.trim() && !l.startsWith('[图片]') && !l.startsWith('（手机发来的图片'))?.trim().slice(0, 40) || '图片';

  // ───── 私聊：直接和机器人聊，一条消息就是一个临时任务 ─────
  // 连着发接着同一个会话聊；/new 或空闲超过 dm_idle_minutes 后开新任务。
  // 私聊任务默认在 dm_workdir 里做（不配就是 workdir），/cd 换目录
  const DM_HELP = [
    '直接发消息就是一个任务，连着发会接着聊；空闲一段时间后再发自动开新任务。',
    '`/new [内容]` 结束当前任务，开新任务',
    '`/cd <别名或绝对路径> [内容]` 在指定目录开新任务',
    '`/help` 显示这段说明',
  ].join('\n');
  const idleMs = () => (cfg.dm_idle_minutes ?? 30) * 60e3;
  const tilde = (p) => p.replace(os.homedir(), '~');

  async function startTask(m, text) {
    const id = crypto.randomUUID();
    const cwd = state.dm.next_cwd ?? cfg.dm_workdir ?? cfg.workdir;
    delete state.dm.next_cwd;
    Object.assign(session(id), { dm: m.chat_id, title: titleFrom(text), cwd });
    Object.assign(state.dm, { session: id, last: Date.now() });
    save();
    runCli(id, text, false);
    react(m.message_id);
    await post(`🆕 新任务 · \`${tilde(cwd)}\`${cfg.desktop_import === false ? '' : '\n第一轮做完会出现在桌面版，可以在那边接着聊'}`, null, m.chat_id);
  }

  async function onDirectMessage(m, text) {
    const dm = (state.dm ??= {});
    dm.chat_id = m.chat_id;
    const say = (md) => post(md, null, m.chat_id);
    if (!text) return say('暂时只支持文字和图片。');
    const [, cmd, arg = ''] = text.match(/^\/(new|cd|help)(?:\s+([\s\S]*))?$/i) ?? [];
    switch (cmd?.toLowerCase()) {
      case 'help': // 「/help 你是谁」：先回说明，后面的内容照常当一条消息处理
        await say(DM_HELP);
        if (!arg.trim()) return;
        text = arg.trim();
        break;
      case 'new':
        dm.session = null;
        save();
        return arg.trim() ? startTask(m, arg.trim()) : say('好，下一条消息开新任务。');
      case 'cd': {
        const [, where = '', rest = ''] = arg.match(/^(\S*)\s*([\s\S]*)$/) ?? [];
        const dir = cfg.projects?.[where] ?? (path.isAbsolute(where) ? where : '');
        if (!dir || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
          return say(`没有这个目录或别名：${where || '（空）'}\n可用别名：${Object.keys(cfg.projects ?? {}).join(' / ') || '无（在 config.json 的 projects 里配）'}`);
        dm.session = null;
        dm.next_cwd = dir;
        save();
        return rest.trim() ? startTask(m, rest.trim()) : say(`好，下一条消息在 \`${tilde(dir)}\` 开新任务。`);
      }
    }
    const cur = dm.session && state.sessions[dm.session];
    if (cur && Date.now() - (dm.last ?? 0) < idleMs()) {
      dm.last = Date.now();
      save();
      return resumeWith(dm.session, text, m, say);
    }
    return startTask(m, text);
  }

  const seen = new Set();
  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': (data) => {
      const m = data.message;
      // 收到什么先记一笔（不记内容），丢消息时才查得出是飞书没推还是这里过滤掉了
      log('recv', m.chat_type, m.message_type, m.message_id, m.root_id ? 'in ' + m.root_id : '');
      if (seen.has(m.message_id)) return; // 飞书偶尔重复推送
      seen.add(m.message_id);
      onPhoneMessage(data).catch((e) => log('phone message failed', e.message));
    },
    // 卡片按钮（审批、选择题）。要在飞书开发者后台「事件与回调 → 回调配置」用长连接订阅 card.action.trigger。
    // 返回值就是给飞书的回调响应：弹个提示，答完的卡片换成去掉按钮的样子
    'card.action.trigger': (data) => {
      const v = data.action?.value ?? {};
      log('card action', v.a ?? '', v.id ?? '');
      if (data.operator?.open_id !== cfg.owner_open_id) return { toast: { type: 'error', content: '只有本人能操作' } };
      const p = prompts.get(v.id);
      if (!p) return { toast: { type: 'info', content: '这个请求已经结束了' } };
      return p.click(v, data.action?.form_value ?? {});
    },
    // 一键建的应用还订阅了表情事件，登记空处理，免得日志刷警告
    'im.message.reaction.created_v1': () => {},
    'im.message.reaction.deleted_v1': () => {},
  });
  // info 级别只多出连上/重连两类日志，带上时间才能和丢消息的时间对上
  const stamped = (fn) => (msg) => fn(new Date().toISOString(), ...msg);
  const logger = { error: stamped(console.error), warn: stamped(console.warn), info: stamped(console.log), debug: stamped(console.log), trace: stamped(console.log) };
  new lark.WSClient({ ...opts, loggerLevel: lark.LoggerLevel.info, logger }).start({ eventDispatcher: dispatcher });

  fs.mkdirSync(EVENTS, { recursive: true, mode: 0o700 });
  fs.watch(EVENTS, drain);
  setInterval(drain, 5000);
  drain();
  log('feishu bridge started');
}
