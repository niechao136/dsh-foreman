# Changelog

本仓库的历史从本项目自己的初始提交开始，**不携带上游 git 历史**（见 README 的「由来与致谢」）。
下面 `0.2.0` 一节是从代码基线 `dsh-superagent-local` 沿袭下来的、那一份代码相对上游
`dsh-superagent-prototype` 的改动记录，保留它是为了说明基线里已经有什么；**它不是本项目的发布版本**。

本项目自己的版本从 `0.1.0` 开始。

## 0.3.4 — 2026-11-08

### 修复：设备回报只进了账本，主会话从没收到

远程设备的 `report` 帧只调了 `engine.report(...)`，**没有生成 relay**。后果是那张工单在面板上显示
`ready`、`ended`，但派它的主会话完全不知道——既不把结果转达给人，也不会据此继续处理。

本地 worker 的 `orchestrator_report` 工具一直有这一步（`reportRelay` + `steer`），远程这条路径从来没接上。

现在 `applyReport` 补上同一道缝：报告入账后生成 relay 并 steer 到发起该工单的主会话。
`reportRelay` 自己决定哪些值得打扰人——`progress` 仍然留在内部，`ready` / `blocked` / `failed`
会唤醒主会话，由它决定是转达结果还是接着做下一步。

relay 失败只记日志：报告已经入账，不能因为通知不到就把它退回去。

## 0.3.3 — 2026-11-08

### 改进：派单时直接告诉设备「你就是那台机器」

人在 hub 上写「看看宿舍电脑上的项目结构」。「宿舍电脑」就是收到这条任务的那台机器，但**派单文本里
没有一句话说明这件事**——设备收到的只有标题和请求原文。

于是模型每次都要先花不少步数去比对设备名、列目录、找自己在哪儿，确认之后才真正开始干活。

现在每张派单的开头多了一段：

```
## Where this job runs

You are the device **宿舍电脑** (id `pc`) working in `F:\dsh`. When the request names this machine —
"宿舍电脑", or "this computer", "here", "the machine you are on" — it means you, and the files are
already under that directory. Do not go looking for another machine.
```

只把**登记的设备名**当作别名。目录的最后一段通常是项目名（`shop`），把它说成机器别名会让模型
搞不清那是项目还是主机。

## 0.3.2 — 2026-11-08

### 修复：派单文本没有说要回报

真机上一次派单，设备做了 30 步、写完整答案，**一次都没调用 `foreman_report`**——因为派单文本里
根本没提这件事。设备收到的只有标题、请求原文和附件说明，模型自然当成普通任务做完就停，
hub 于是永远停在 `running`。

现在每张派单的末尾都有一段：`foreman_report` 是结果到达问话人的唯一途径，答在对话里
不算完成，**没回报就不算做完**。

配套地，设备侧 `dsh-foreman-node@0.2.1` 加了一层兜底：一轮结束而还没回报时自动补一条
`ready`。两层一起，模型照做时走正路，不照做也不会让工单挂死。

## 0.3.1 — 2026-11-08

### 修复：同一 id 的两个连接互相踢，设备永远上不了线

`Hub.attach` 在新连接到达时，立刻关闭同 id 的旧连接。设备重连时旧 socket 往往还没超时，
于是**两边互相踢**：谁都完不成握手，hub 一直认为设备离线，双方不停重试。

现场证据：本机 89 个 TIME_WAIT，hub 上一个在线设备都没有；一张要查看宿舍电脑的工单，
因为选不到设备，回退到服务器本地，在空目录里跑完并报告成功。

现在新连接先排队，**令牌验证通过后才接管 id**。半成品连接打扰不到正在工作的那条，
真正的重连仍然能接管。

### 修复：点名了机器，却在服务器上跑

`prepareTicket` 在选不到设备时静默回退本地执行，并把这种行为写成了「有意为之」。
在「项目只存在于远程设备」的场景里，它给出一个看起来成功、实际毫无意义的结果。

现在：点名了设备或要求了标签的请求，选不到设备就记 `blockedReason`，由 executor
直接报 `blocked`，**不启动任何 Session**。人在面板上看到「没有设备能接」，
而不是假成功。没点名设备的仍然回退本地——本机可达的项目不该因为笔记本离线就卡住。

### 修复：worker 会话在侧栏看不到

原来把所有 `worker-*` 都藏起来。那恰好藏掉了唯一能回答「任务在哪台机器、哪个目录跑」的线索。
现在只藏主会话（用行上的 M 气泡进），worker 保留显示。

### 新增：设备可以删除，也可以改项目

- **删除**：吊销保留记录（审计用），删除连记录一起去掉（登记错了用）。删除需要二次确认。
- **编辑**：显示名、标签、它能接的项目都能改，**id 和令牌不动**，所以那台设备不用重新配置。
  这解决了「登记时漏了项目只能重登」的问题。

## 0.3.0 — 2026-11-07

### 新增：在面板里登记设备，不用再跑脚本

「设置 › 设备」多了一个登记表单：填 id、显示名、它能接的项目和**那台机器上的路径**，
点「登记」就得到一枚令牌。卡片把设备要的四样东西排在一起——`url`、`deviceId`、`token`，
以及设备页面的入口——令牌只显示这一次，因为库里只存哈希，关掉或刷新就再也拿不回来。

以前这一步只能跑 `scripts/add-device.mjs`，那个脚本还在，行为不变；面板走的是同一个
`Devices.add`，所以两条路得到的结果一样。

重复的 id 会回 400 并明确说「去换令牌」，不是 500——那是操作者的失误，不是服务端故障。

### 新增接口

`POST /orchestrator/api/devices`，body `{ id, name, labels?, roots }`，
响应 `{ id, token }`。令牌只在这里出现一次。

### 修复：bundle patch 里的中文是乱码

`cordis.patch.yml` 里几行中文在初始提交时就已经是「UTF-8 字节被当成 GBK 读」的产物，
所以面板上主会话旁边显示的是 `dsh-foreman 涓?Session`。已改回正确的
`dsh-foreman 主 Session` 与 `dsh-foreman 执行器`。

### 依赖

`dsh-foreman-node` 精确锁到 `0.2.0`（不写 `^`）：两边协议必须同版本，自动升级反而危险。

## 0.1.1 — 2026-11-07

修的是 `0.1.0` 发布时才暴露的两个问题，都是真机验证（上海服务器 srv-02）发现的。

### 修复：运维脚本没有进包

`0.1.0` 的 `files` 漏了 `scripts/`，于是装完 `dsh-foreman@0.1.0` 之后
`node scripts/add-device.mjs` **不存在** —— 而那是加设备的唯一入口，
文档里却写着让人这么跑。现在随包发三个脚本：

- `scripts/add-device.mjs`（加设备 / 换令牌 / 吊销）
- `scripts/migrate.mjs`（迁机打包与自检）
- `scripts/dsh-foreman`（服务脚本）

`scripts/sync-wsl.sh`、`scripts/deploy-preview.sh` 是开发用的，**不发布**。

### 修复：一个不带正文的帧会崩掉握手

`ws.ts` 把收到的任何消息一律 `.toString()`，于是 payload 缺失时会得到字符串 `"undefined"`，
再被当成帧去解析。现在只接受真的带文本的帧（字符串 / Buffer / Buffer[]），
其余直接忽略，并在握手阶段给出可读原因。

## 0.1.0 — 2026-11-07

首个公开发布。**一个常驻主 loop，把工单派给多台在线设备上各自完整运行的 DSH，账本只有一份。**

### 新增：设备与派单

- **设备注册表**（`src/foreman/devices.ts`）：同一份 SQLite 里的 `foreman-device:` 家族，
  令牌只存 SHA-256。加设备、换令牌、吊销都不需要重启主 loop。
  CLI：`scripts/add-device.mjs add | list | rotate | revoke`。
- **Selector**（`src/foreman/selector.ts`）：纯函数。吊销的、离线的、没有对应项目 root 的设备先出局；
  显式点名或标签要求再收窄；剩下的按在跑数量最少，平局取最近心跳。
- **选择落在 accept 上**：`Ticket.target` 在 accept 时确定，`newAssignment` 复制到
  `Assignment.target`。选设备在 `prepareTicket` 缝上，**不在** Executor 里——Executor 没有写库通道。
- **ForemanExecutor**（`src/foreman/executor.ts`）：本机目标原样交给 `DshExecutor`；
  远端目标变成一个 `assign` 帧。设备不可达时报 `blocked`，**不伪造 failed，也不悄悄改成本机执行**。
- **Foreman Hub**（`src/foreman/hub.ts` + `ws.ts`）：设备主动外连，`ws` 只出现在一个文件里，
  只监听 `127.0.0.1`（对外由隧道终结 TLS）。握手校验令牌与协议版本；吊销在下一帧就生效。
- **文本渲染**（`src/foreman/render.ts`）：任务文本在主 loop 侧定稿，**不带任何主 loop 路径**；
  附件走 base64 字节，按编码后大小卡 256 KiB 上限。

### 新增：断线与恢复

- **断线绝不自动重派**。`assignmentInterrupted` 会走 `Tickets.restart` 立刻重开一张，
  而设备可能还在跑——那是「同一件事执行两遍」。超时只转 `blocked`，交给人。
- Hub 重启时，在飞的远端 assignment 一律先转 `blocked`，等设备 `hello` 对齐；
  `DshExecutor.resume()` 按 target 跳过远端项。
- 设备重连后先 `hello` 报「我在跑哪些」，Hub 对齐而不是假设。

### 新增：设备侧插件（另一个包）

- [`dsh-foreman-node`](https://www.npmjs.com/package/dsh-foreman-node)：连出去、接单、回报三件事。
  job 会话是 `job-<assignmentId>`，权限是 **`workspace-write`**（不是主 loop 自己的 `danger-full-access`：
  笔记本前没人，弹审批等于卡死）。
- 设备上注册 `foreman_report` 工具（`progress` / `ready` / `blocked` / `failed`）。
  **`dropped` 不允许**：那是判断，设备没有判断权。

### 新增：面板

- 「设置 › 设备」：在线点、在跑数、最近活动、项目名（**不显示设备自己的路径**）、吊销与换令牌。

### 新增：飞书群即项目

- Policy 的 `routing.chats`：群 → 工作区，同时约束设备选择（内网群只选带 `intranet` 标签的设备）。
  映射按 settings 修订号缓存，改了对新到的消息生效。

### 新增：迁移

- `scripts/migrate.mjs`：`plan` / `checkpoint` / `pack` / `verify`。
  必须先 checkpoint——库跑在 WAL 模式，只拷 `.sqlite` 会**静默丢掉**最近的工单。
- [docs/migration.md](docs/migration.md) 五步 runbook。

### 依赖

- 唯一新增的运行时依赖是 `ws@8`。
- `@deepseek-ai/*` 全是 `peerDependencies`，由装了本插件的 DSH 实例提供。

---

## 0.2.0 — 2026-11-01（上游基线，非本项目发布）

> 这一节记录的是代码基线 `dsh-superagent-local` 相对上游 `dsh-superagent-prototype` 的改动。
> 本项目的 `0.1.0` 已包含其中全部内容。

### 新增：需求来自本机操作者

- `src/sources/dsh.ts`，作为 `./local-watch` 导出，注册 Source kind `dsh`
  （标题「本机操作者」）。主会话里由人手输入的消息（`message.source.kind === 'user'`）
  变成 Trigger，主会话的回复回到同一条会话。
- 消息里带的图片和文件随需求一起走：Trigger 的 `meta.attachments` 记录附件 id，
  Executor 在派给 Worker 的任务说明里附上 `~/.dsh/attachments/v1/objects/<前两位>/<id>`
  路径，Worker 用 `read_image` 打开后再动手。
- 本地部署不再要求 GitHub 仓库：`resolveDeployment` 在没有远端时返回空 repository，
  GitHub watcher 报 `paused` 而不是反复失败。

### 新增：每个工作区一条主会话

- `KV.runtime.masters` 记录 workspaceId 到 sessionId 的映射，重启后恢复。
- `GET /orchestrator/api/master?workspace=<id>` 按需创建并返回该工作区的主会话，
  会话 id 由工作区路径确定性生成，cwd 就是该工作区目录。
- `Runtime.isMaster()` 让所有主会话都套 router preset、挂路由工具；主会话只有
  路由类工具，没有 bash 和文件写入。
- 客户端在每个工作区组标题行注入 ★ 按钮（`data-main-session-entry`），点它打开
  该工作区的主会话，并把主会话行从侧栏列表里隐藏。

### 修复：一次需求一张工单

- `meta.newTicket` 让本地来源的每条消息都开新工单，不再被同 thread 的运行中工单
  吸收，也不会复活已结束的工单。修正前第二条需求会挂到第一张工单上、复用同一个
  Worker 会话。
- 本地需求的 Worker 会话与主会话同组，产物落在该工作区目录，不再为每张工单建
  `work/<工单名>` 工作区。

### 改进：结果回给发起它的主会话

- `relay` 与 `notice` 两个 effect 载荷带上 `sessionId`，工单结束通知回到创建它的
  那条主会话，而不是固定回默认主会话。
- 工单卡片带 `workspace` 字段说明产物目录，提示词要求主会话去那里读文件。
