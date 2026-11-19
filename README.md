# 飞书遥控 Claude Code｜Claude Code Remote Control via Feishu/Lark

Continue the same desktop Claude Code session from your phone through Feishu / Lark.

出门前电脑上开的活，到手机上就接不上了？这个项目用飞书把**正在运行的那个 Claude Code 会话**接到手机上：桌面版和终端里每个会话自动在飞书话题群里开一个话题，每轮回复贴进来；你在话题里回一句，就注入那个会话接着干。回到电脑前，对话就在原处，不用再讲一遍前情。

## 离开电脑以后怎么用

- **出门前没干完**：“接着刚才的方案做，先把第一部分完成。”在那个会话的话题里回一句，桌面上的原会话接着干。
- **路上想到新要求**：“刚才那个页面再加一个筛选项。”发进对应话题，Claude 带着已有上下文处理。
- **等长任务出结果**：每轮回复自动贴到飞书，你在电脑上敲的轮次也会回传，不用一直盯着屏幕。
- **几个会话同时在跑**：一个会话一个话题，在哪个话题里说话就指挥哪个会话，结果各回各处。
- **手机上临时开个新活**：在群里发一个新话题，后台起一个命令行会话去做，在同一话题里接着聊。

项目为中国大陆环境而写：官方的 Remote Control、Channels 都要求 claude.ai 账号或 Console API key，用中转或第三方模型服务时用不了；飞书在国内稳定，长连接也不需要公网 IP。

## 三步装好

需要 macOS、Node ≥ 20、[Claude Code](https://claude.com/claude-code)（桌面版或终端版都行），以及一个飞书账号（个人版即可）。

```bash
git clone https://github.com/ruodou233/claude-code-feishu ~/claude-code-feishu
cd ~/claude-code-feishu && npm install
node bridge.mjs setup
```

`setup` 会打印一个链接。在浏览器或飞书手机端打开，点「立即创建」——这用的是飞书官方 CLI 同款的应用注册流程，机器人、消息权限、事件订阅、长连接一次配好，不用进开放平台后台。之后脚本自动建一个话题群「Claude」，你是群主。

**再开一项权限**：一键建的应用只能收到群里 @ 它的消息。想在话题里直接说话、不用每句 @，到 [开放平台](https://open.feishu.cn/app) → 你的应用 → 权限管理，开通「获取群组中所有消息」（`im:message.group_msg`）。个人版免审，开通即生效。不开也能用，每句 @ 一下机器人就行。

```bash
node bridge.mjs install
```

`install` 往 `~/.claude/settings.json` 挂四个钩子（SessionStart / UserPromptSubmit / Stop / SessionEnd），并注册 launchd 开机自启。之后新开的会话会自动进群；已经开着的会话，下一轮也会自己登记上。

卸载：`node bridge.mjs uninstall`，摘掉钩子和自启，配置留在 `~/.claude/feishu-bridge/`。

整个项目就一个文件 [`bridge.mjs`](bridge.mjs)（约 370 行），唯一依赖是飞书官方 Node SDK。

> 用 CC Switch 之类会改写 `settings.json` 的工具切换供应商时，记得把这四个钩子也加进它的通用配置，否则切换后钩子会丢。

## 原理

```
 桌面版 / 终端的 Claude Code 会话
   │ 钩子：每个事件写一个小文件（会话 id、对话文件路径、收件地址）
   ▼
 bridge.mjs（launchd 常驻，不调用模型）
   ├─ Stop 事件 → 读对话文件，取本轮回复 → 贴进该会话的话题
   └─ 话题里有人回复 → 经会话的收件 socket 注入正在运行的那个会话
   ▲
   │ 飞书长连接（WebSocket，不需要公网 IP）
 手机飞书：话题群「Claude」，一个会话一个话题
```

### 为什么不用 Channels

上一版（v1）基于官方 [Channels](https://code.claude.com/docs/en/channels)：声明 `claude/channel` 的 MCP server 可以把消息推进运行中的会话。实际用下来有三个硬伤：

1. **要官方账号**。Channels 要求 claude.ai 登录或 Console API key，走中转、用第三方模型服务的人用不了。
2. **会话得专门起**。只有带 `--dangerously-load-development-channels` 启动的终端会话才能接，桌面版的会话一个都接不上，每次启动还要过一次警告框。
3. **回信要额外造轮子**。模型只在觉得该回话时才调回复工具，最后还是得靠 Stop 钩子兜底。

这一版换了思路：**Claude Code 每个会话本来就开着一个本地收件 socket**，跨会话消息就是从这里进来的。钩子是会话的子进程，环境里有这个 socket 的地址和令牌，顺手交给转发程序，手机上的消息就能送进任何一个正在运行的会话——桌面版、终端都行，不用改启动方式，也不挑登录方式。

### 实测踩到的坑

- **常驻进程发的消息会被静默丢掉**。收件端会核对发送进程，比会话启动得早的进程发过去，连错误都没有，消息就没了。所以每次注入都现起一个新进程去发（`bridge.mjs inject`），发完再看对话文件里有没有这条，没有就重试一次。
- **注入的消息在 Claude 看来是「另一个会话发来的」**，没法伪装成用户输入。转发程序在消息前加一句说明，请 Claude 当作用户本人的输入正常回复。它不会把这类消息当成批准待确认操作的同意——这是 Claude Code 自己的安全设计，也是对的。
- **`~/.claude/sessions/*.key` 里的令牌发的消息会被丢掉**，只有会话子进程环境里的 `CLAUDE_CODE_MESSAGING_TOKEN` 有效。这也是为什么必须靠钩子来登记。
- **一键建的应用收不到群里的普通消息**，只收 @ 机器人的。要么开 `im:message.group_msg`，要么每句 @。
- **只镜像交互会话**。钩子按 `CLAUDE_CODE_ENTRYPOINT` 只认桌面版（`claude-desktop`、`claude-desktop-3p`）和终端交互（`cli`），外加本程序自己拉起的会话；脚本里的 `claude -p`、Agent SDK 调用不会刷进群。

## 用起来要知道的

- **手机开的会话自动进桌面版**：命令行跑完第一轮后，转发程序在对话末尾写上标题（`📱 第一句话`），再用桌面版的 `claude://resume?session=<id>` 深链接导入。桌面版会把窗口切到这个会话，但不起进程；在桌面里接着聊就是同一个会话 id 的桌面会话。桌面版没开着时会被拉起来。不想要就在配置里设 `"desktop_import": false`。秘书派出去的任务也一样（标题前是 📋）；私聊的秘书本身不导入（见「私聊：你的秘书」）。
- **往已有会话发消息**：会话进程开着（桌面版或终端）就注入进去；进程已经退了，就用 `claude -p --resume` 在原对话文件上接着跑，桌面会话也一样。桌面版下次接着聊时按会话 id 从对话文件续，命令行续的那几轮也在里面。进程开着却没送进去时只提示重发，不另起进程，免得两个进程同时写一份对话。
- **手机上看到的是每轮的最终文字**，工具调用和中间过程不转发；超过 12000 字分几条发。
- **能发图片**（单张图或图文混排）。图片下载到 `~/.claude/feishu-bridge/images/`（留 7 天），路径附在消息里让 Claude 用 Read 看，读这个目录不用确认。
- **Mac 睡眠时离线**。转发程序没在跑或断网时，钩子事件攒在 `events/` 里，恢复后按顺序补发（超过一小时的丢弃）。想一直在线，可以 `sudo pmset -c sleep 0`（接电源时不睡）。
- **Claude Code 升级后收件协议如果变了**（现在是 `type:auth` 和 `type:user` 两行 JSON），注入会失败，机器人会回「没在运行」，所以失效时看得出来。这是未公开的内部机制，2.1.3xx 实测可用。
- **手机开的会话用的是命令行 `claude` 的登录**，和桌面版分开。命令行登录过期时，新会话第一句就报 `Failed to authenticate`，在终端里 `claude auth login` 重新登录即可。

## 手机审批和选择题

Claude 要执行需要确认的操作时（没放行的命令、写文件等），如果这一轮是手机发起的，确认请求会发到手机：

- 私聊任务发到私聊，话题里的发到那个话题。写明工具和完整命令，并带上 Claude 执行前说的那句话（💬）当理由；文件内容只显示前 3000 字。
- 点 **允许 / 拒绝** 按钮，或回复 `y` / `n`；直接说别的也算拒绝，并把这句话转给 Claude（比如「别删，先备份」）。
- **默认一直等到你回复**。想要到点自动处理就配 `approve_timeout_minutes`：手机开的会话到点按拒绝，桌面版、终端会话到点交给电脑上的弹窗。同一个地方一次只问一个，排队往下问。
- 等着的时候在私聊发 `/new`、`/cd`，不会被当成回复：眼前这一步按没执行处理，接着开新任务。
- 桌面上自己发起的那一轮不受影响，照常在桌面弹窗。

Claude 用 AskUserQuestion 提问时（单选、多选、一次几道题），手机上收到一张选择题卡片：单题单选直接点选项；多选或多道题在下拉框里选好（不在选项里的可以自己写）再点提交。也能回文字：编号（多选用逗号隔开，多道题按顺序用 `/` 隔开，如 `2 / 1,3`），或者直接打字。

- 手机开的会话用桌面版同款的 stream-json 模式跑，权限确认和选择题经 stdio 问到转发程序。纯文本的 `claude -p` 没有 AskUserQuestion，Claude 只能用文字列选项。
- 桌面版、终端会话里手机发起的那一轮，权限确认靠 `PermissionRequest` 钩子转到手机（`install` 时挂上，最多等一天，对本机所有会话生效，只转手机发起的那一轮；转发程序没在跑时钩子直接放过）。电脑上同时也会弹确认，**哪边先答算哪边**；电脑上先答了，手机上的卡片会改成「已在电脑上处理」。钩子答不了选择题，这时手机上只收到题目，要回桌面版里选。

**按钮要在飞书后台开回调**：开发者后台 → 你的应用 → 事件与回调 → 回调配置 → 订阅方式选「使用长连接接收回调」→ 添加回调「卡片回传交互」（`card.action.trigger`），保存后如果提示要发布版本就发布一下。没开时按钮点了没反应，回文字照样能用。

## 工作中

手机发起的每一轮开始时会发一张状态卡片，每 15 秒刷新：用了多久、调用了几次工具、最近在做什么（比如 `Bash · 查日志`），在等你确认时会标出来；这一轮做完改成「✅ 完成 · 用时 3 分 12 秒 · 调用工具 14 次」，后面跟着回复。被打断或进程没了会改成「⏹ 已停止」。

**执行过程**：Claude 列了计划时，卡片上显示勾选清单（「计划 2/5」，✅ 做完、▶️ 正在做、⬜ 没开始）；没列计划时，逐条列出这一轮做过的步骤（每次工具调用一行，用它自带的说明；✅ 做完、▶️ 正在做、❌ 出错或被拒），太长只留最后几步。做完后清单留在卡片上。手机开的会话会提示 Claude 把工具说明写成简短中文。

- 手机开的会话：命令行在 `-p` 下默认不给较新的模型任务清单工具，转发程序起会话时设 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 打开，并提示 Claude 多步骤的活先列计划；清单从 `~/.claude/tasks/<会话 id>/` 读。
- 桌面会话：从对话记录里重放桌面版自己的计划（`update_plan`）。
- 列计划、查工具这类调用不算进「调用工具 N 次」，也不列进步骤。

手机开的会话，卡片上有 **停止** 按钮，也可以发 `/stop`（私聊停当前任务，话题里停那个话题的会话）：正在等的审批、选择题按没执行放掉，已经排着的消息清掉，再中断进程；停下之后再发的消息照常接着跑。桌面版、终端会话从外面停不了，卡片上不放按钮，要在电脑上停。

## 文件回传

Claude 在回复里单独写一行 `[发送文件] /绝对路径`（转发程序会在提示里告诉它这个写法），这一行不显示，文件直接发到私聊或话题：图片（10MB 内）直接显示，其他文件（30MB 内）按附件发。手机上也可以直接发 `/file 路径`，相对路径按当前任务的目录算。

- 密钥和凭据一律不发：`~/.ssh`、`~/.aws`、`~/.gnupg`、钥匙串、转发程序自己的配置目录等，以及 `.env`、`*.pem`、`*.key`、`id_rsa`、`appsettings*.json`、`web.config`、名字里带 credential / secret / password / token 的文件。软链接按真实路径检查。
- 文件会上传到飞书，只发到你自己的私聊或话题群里。用的是应用已有的「获取与上传图片或文件资源」权限，不用另开。

## 私聊：你的秘书

在飞书里点开机器人发私信。私聊里是一个**一直开着的秘书会话**：你只说要什么，它来拆活、派活、盯进度，你只看结果；过程细节都在群里各自的话题里。

- **小事它自己做**（查个数、看个文件、回答问题）；**大活派出去**：秘书调用派活工具，转发程序先在私聊发一张派活卡片（标题、目录、会不会改代码、完整说明），你点 **派** 才开始，在群里开一个新话题，起一个新的命令行会话去做，过程、审批、选择题都在那个话题里。想看细节或插话，进话题直接说。
- **做完通知你**：派出去的任务每做完一轮，私聊收到一条短通知（标题、用时，和它在回复最后写的「汇报：」那一行），带「在桌面打开」按钮。出错也会通知。
- **等你确认时两边都能点**：任务要确认权限或问选择题时，话题里和私聊里各有一张同样带按钮的卡片，在哪边点都行。私聊里打的字是发给秘书的，不算回这张卡片。
- **追加指示、查进度、停止**：跟秘书说就行，它用 `send_to_task`（同样要你点 **发送**）、`list_tasks` / `task_detail`、`stop_task`。`send_to_task` 也能递给电脑上开着的桌面、终端会话。你自己在话题里或电脑上接着聊之后，那个会话就不再往私聊报。
- **同时跑几个不限**（想限就配 `max_tasks`），改代码的也可以同时跑好几个；两个任务改到同一处打架时，再让它们各自建 git worktree（跟秘书说就行）。
- **派出去的任务第一轮做完自动导入桌面版**（标题前是 📋），之后点通知上的「在桌面打开」能再跳过去；同时派了好几个时，每做完一个桌面窗口会切过去一次。跑着的时候在话题里看过程。**秘书本身不导入**：桌面版接着聊时没有派活工具，私聊消息还会被送到桌面那边去。
- **秘书会自动换新**：同一个会话每条消息都要把整段历史重读一遍，越聊越贵。所以隔了一天（早上 4 点算新一天），或上下文超过 `secretary_max_context`（默认 8 万 token）后再发消息，转发程序会开一个新秘书，私聊里提示一句。交接不靠模型总结：转发程序把任务清单和最近 3 轮对话放进新秘书的第一条消息，更早的细节它不记得。秘书正在跑的那一轮不换。任务都登记在转发程序里，换新或 `/new` 都不会丢。
- 指令：`/tasks` 看任务（不经过模型），`/new [内容]` 换新的秘书会话，`/cd <别名或绝对路径> [内容]` 在指定目录开新的秘书会话（别名配在 `projects`），`/stop` 停止秘书正在跑的那一轮，`/file <路径>` 发文件，`/help`。
- **秘书在 `dm_workdir` 里**，派出去的任务默认在 `workdir` 里做。建议都配成项目根目录：项目 `.claude/` 里的放行规则只在工作目录那一层生效。
- 和群里一样只认 `owner_open_id`，别人私聊机器人一律忽略。
- **桌面版定时任务出问题时私聊提醒**：转发程序每 30 秒扫一遍 `~/.claude/projects`，第一条消息以 `<scheduled-task name="…">` 开头的就是定时任务的一次运行（不靠钩子）。跑完一分钟后看最终回复第一行：是「正常」不打扰；其余（有结论、没跑成、没文字、API 报错）私聊发「⚠️ 显示名：第一行」加几行要点，带「在桌面打开」。一小时没动静也没跑完的当卡住提醒。每次运行只发一次，重启不重发；这个功能上线之前的运行不补发。根本没跑起来（电脑睡着、桌面版没开）不会有对话记录，提醒不了。
- 不想要秘书就设 `"secretary": false`，回到老样子：一条消息一个临时任务，连着发接着聊，空闲超过 `dm_idle_minutes`（默认 30 分钟）再发开新任务。

## 安全边界

这东西让一条飞书消息能在你电脑上执行命令，务必想清楚：

- **只认群主本人**。转发程序只处理配置里那个话题群、只认 `owner_open_id`（setup 时由飞书返回，就是扫码的人）。群里拉了别人，他们的消息会被忽略。
- **手机开的新会话默认 `bypassPermissions`**：命令行会话没有人在旁边点确认，不放行就会卡住。想收紧就改 `config.json` 的 `permission_mode`（比如 `acceptEdits`，或配好 `permissions.allow` 后用 `default`）。注入到已有会话的消息，沿用那个会话自己的权限模式。
- **秘书写的派活说明不是你逐字说的**：它可能是读了外部内容（邮件、网页、报错）之后写的，而派出去的会话照样按 `permission_mode` 跑。所以派活和追加指示默认都要你在私聊点按钮，卡片上是完整说明；派出去的会话也被告知说明来自秘书，删数据、改生产、对外发消息前要先问你。`dispatch_confirm: false` 能去掉这一步（只发通知），等于放宽权限，想清楚再关。
- **配置里有 App Secret**，`~/.claude/feishu-bridge/` 下的文件都是 600 权限。

## 配置

`~/.claude/feishu-bridge/config.json`，setup 自动生成：

| 字段 | 含义 |
|---|---|
| `app_id` / `app_secret` | 飞书应用凭证 |
| `owner_open_id` | 唯一允许指挥的人 |
| `chat_id` | 话题群 |
| `domain` | `feishu` 或 `lark`（国际版） |
| `claude` | `claude` 命令的路径，手机开新会话时用 |
| `workdir` | 手机开新会话的工作目录，默认家目录 |
| `permission_mode` | 手机开新会话的权限模式，默认 `bypassPermissions` |
| `dm_workdir` | 私聊（秘书）的工作目录，默认同 `workdir`（可选） |
| `secretary` | 私聊用秘书模式，默认 `true`；`false` 回到一条消息一个临时任务（可选） |
| `max_tasks` | 秘书派出去的任务同时最多跑几个，默认不限（可选） |
| `secretary_max_context` | 秘书上下文超过多少 token 后自动换新，默认 80000；`0` 只按天换（可选） |
| `dispatch_confirm` | 派活、追加指示要不要你在私聊点按钮确认，默认 `true`（可选） |
| `dm_idle_minutes` | 关了秘书时，私聊空闲多久后开新任务，默认 30（可选） |
| `dm_permission_mode` | 私聊任务单独的权限模式，不填沿用 `permission_mode`（可选） |
| `approve_timeout_minutes` | 手机审批、选择题等多久没回复就收尾（手机开的会话按拒绝，桌面会话交给电脑），不配就一直等（可选） |
| `projects` | `/cd` 用的目录别名，如 `{"web": "/path/to/repo"}`（可选） |
| `desktop_import` | 手机开的会话跑完第一轮后是否导入桌面版，默认 `true`（可选） |

同目录下还有 `state.json`（会话 ↔ 话题映射）、`events/`（钩子投递的事件）、`bridge.log`（含每条收到的消息 ID 和长连接重连记录，丢消息时先看这里）。

```bash
launchctl kickstart -k gui/$(id -u)/com.github.claude-code-feishu   # 重启
tail -f ~/.claude/feishu-bridge/bridge.log                           # 看日志
```

非 macOS：`install` 只挂钩子，转发程序用 systemd、pm2 之类常驻运行 `node bridge.mjs` 即可。

---

# claude-code-feishu (English)

Steer the **same** Claude Code session from your phone through Feishu / Lark: every desktop or terminal session gets its own topic in a Feishu topic group, each turn's reply is posted there, and anything you reply in the topic is injected into that running session.

> Written for users in mainland China. Anthropic's Remote Control and Channels require claude.ai or Console API-key auth and don't work behind third-party gateways; Feishu works reliably there and its long connection needs no public IP.

## Install

```bash
git clone https://github.com/ruodou233/claude-code-feishu ~/claude-code-feishu
cd ~/claude-code-feishu && npm install
node bridge.mjs setup     # open the printed link, click Create — app, bot, scopes, events all preconfigured; a topic group is created
node bridge.mjs install   # adds 4 hooks to ~/.claude/settings.json and a launchd agent
```

Optional: enable `im:message.group_msg` in the developer console so you can talk in topics without @-mentioning the bot.

## How it works

Every Claude Code session already listens on a local inbox socket (that's how cross-session messages arrive). Hooks run as children of the session, so they can see the socket path and the per-session `CLAUDE_CODE_MESSAGING_TOKEN`; they hand both to `bridge.mjs`, a small launchd daemon that holds the Feishu WebSocket. Replies are read from the transcript on `Stop`; phone messages are injected through the socket. No model calls, no Channels, works with the desktop app and with any auth method.

Field notes:

- The inbox silently drops messages from a sender process older than the session, so each injection spawns a fresh `bridge.mjs inject` process and then confirms delivery by checking the transcript.
- Injected messages are presented to Claude as coming from another session, so the bridge prefixes a note asking Claude to treat it as the user's own input. Claude still won't treat it as approval for a pending permission prompt — by design.
- If a desktop session's process has exited there is no socket; the bot asks you to reopen it rather than forking the conversation. Terminal and phone-started sessions resume with `claude -p --resume`.
- This relies on an undocumented internal protocol (tested on Claude Code 2.1.3xx). If it changes, the bot reports the session as not running.

Direct messages to the bot go to a long-lived "secretary" session in `dm_workdir`: it handles small things itself and hands bigger jobs to new sessions through a small MCP server the bridge gives it (`start_task`, `list_tasks`, `task_detail`, `send_to_task`, `stop_task`, served by `bridge.mjs mcp` and relayed over `tasks.sock`). Each dispatched job gets its own topic in the group; dispatching and follow-up instructions wait for an owner tap in the DM (`dispatch_confirm`), with no limit on how many run at once unless `max_tasks` is set. When a job finishes a turn, fails, or waits for an approval, the DM gets a short notice (approval cards are mirrored to the DM, buttons only); `/tasks` lists jobs without calling the model. Because every message re-reads the whole session, the secretary is replaced by a fresh one on the first message of a new day (4 a.m. boundary) or once its context passes `secretary_max_context` (default 80,000 tokens); the bridge hands over the job list and the last three exchanges in the new session's first prompt, without a model-written summary. Set `"secretary": false` for the old behaviour, where each DM starts a throwaway `claude -p` task and `/new`, `/cd`, `/help` manage it. Only the owner's messages are accepted, in the group or in DMs. After its first turn, every phone-started session (dispatched jobs included, the secretary excepted) is imported into Claude Desktop (a `custom-title` line is appended to the transcript, then `claude://resume?session=<id>` is opened), so it shows up in the sidebar and can be continued there; set `"desktop_import": false` to turn this off. Messages to a session whose process has exited resume it with `claude -p --resume`, desktop sessions included. Images (single or inside rich text) are downloaded and passed to Claude as file paths. Phone-started sessions run in stream-json mode with `--permission-prompt-tool stdio`, so permission prompts and AskUserQuestion questions come back to the bridge and are sent as cards with buttons (single choice) or a form (multi-select / several questions); text replies work too; approval cards also show the last thing Claude said before the call. Messages sent while a phone-started task is running are written straight into it (stream-json with `--replay-user-messages`, so the bridge knows when every message has been taken in) and Claude sees them at its next step. Buttons need the `card.action.trigger` callback subscribed over the long connection in the Feishu developer console. Each phone-started turn also gets a status card that refreshes every 15 seconds (elapsed time, tool calls, latest tool, and Claude's plan as a checklist: phone-started sessions run with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` and the list is read from `~/.claude/tasks/<session id>/`, desktop sessions replay the desktop app's `update_plan` calls) and turns into a done line when the turn ends; for phone-started sessions it carries a Stop button (also `/stop`), which cancels pending prompts, drops queued messages and interrupts the process. Claude can send files to the chat by writing a line `[发送文件] /absolute/path` in its reply, and `/file <path>` does the same from the phone; images are shown inline, other files are attached, and key or credential files (`~/.ssh`, `.env`, `*.pem`, the bridge's own config, and so on) are never sent. In desktop and terminal sessions, permission prompts of phone-started turns are forwarded by a `PermissionRequest` hook (the hook cannot answer AskUserQuestion, so those questions are only shown). Tap Allow / Deny or reply `y` / `n` (anything else denies and is passed to Claude); the bridge waits for your answer indefinitely unless `approve_timeout_minutes` is set. In desktop sessions the desktop prompt is shown at the same time and whichever side answers first wins; the phone card is closed when the desktop answers. Phone-started sessions default to `bypassPermissions`; change `permission_mode` in `~/.claude/feishu-bridge/config.json` to tighten it.

## License

MIT
