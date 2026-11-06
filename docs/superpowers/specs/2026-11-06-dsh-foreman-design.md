# dsh-foreman 设计：主 loop 常驻服务器、多设备接单执行

日期：2026-11-06
状态：待批准
基线代码：`dsh-superagent-local`（fork，`main` 分支）
目标产物：新插件 `dsh-foreman`（新仓库），在仓库内**内置**一份 `src/core/` 的拷贝

---

## 1. 意图与由来

`dsh-superagent` 原型已经在新加坡服务器（srv-01）上跑通，但它有两条限制：**只服务单个项目**，且**安装繁琐**。

用户要的形态是：

- 公司笔记本、宿舍电脑、服务器各装一套**完整**的 DSH（各自的模型 provider、凭据、文件、审批、面板）；
- 服务器上的 DSH 里跑一个**常驻主 loop**，是唯一的调度者；
- 其余设备与飞书通过**固定会话**接入这个主 loop；
- 主 loop 自动选择合适的在线设备下发任务，多设备状态因此收敛到一处；
- 主 loop 本身要方便搬迁到新服务器。

设计依据是 DeepSeek Harness 团队的《Super-agent 设计探索》一文与 `dsh-superagent-prototype`。本文只借它已经落地的那部分（双层架构、Trigger/Thread/Subscription、计算与执行环境分离），不假装解决它第八节承认未解的问题。

### 1.1 与本仓库现有代码的关系

| 现有 | 现状 | 本设计 |
| --- | --- | --- |
| 领域内核 `src/core/` | Trigger → Eval → Ticket → Assignment，单一 Engine | 拷贝进 `dsh-foreman`，只改两处：`Assignment.target`、accept 结果多一个 `device` |
| `DshExecutor`（`src/executor/dsh.ts`） | 每张工单在本机开一个 `worker-<ticketId>` 会话 | 保留，作为 `local` 目标；远端分支并列 |
| `Executor` 端口（`src/core/ports.ts:59`） | `start` / `deliver` / `stop` | **签名不动**；选设备不在这里发生（见 5.3） |
| 主会话（`src/app/runtime.ts`：一份 Engine；`masterFor` 每工作区一条） | 一账本、多入口 | **保持**，这就是「多项目」的答案 |
| 本地 Source（`src/sources/dsh.ts`） | 主会话里一句话 → Trigger | 保留。设备侧**没有** Source |

### 1.2 与 `dsh-superagent-local` 的部署关系

`dsh-foreman` **取代** `dsh-superagent` 装在主 loop 上，不并存：`Runtime` 构造时对 `machine.stateDir` 上锁（`src/app/runtime.ts:109`），并且只建一个 `Engine`。两个插件同时装会在锁和会话命名上撞车。

迁移时搬的是**一份** stateDir，不是两份。

---

## 2. 目标、非目标、反目标

### 目标

1. 一份账本：Ticket / Eval / Mandate / Subscription / 策略只存在于主 loop 一处。
2. 设备是完整的 DSH，但**不建工单**：它接住主 loop 派的活，在本地跑，把回报交回。
3. 自动选设备：按在线状态、能力、负载选，不需要人每次指定。
4. 多项目：同一份账本上开多个入口会话，不是一个项目一套安装。
5. 迁移：换服务器是「停 → 打包 → 传 → 起」，设备侧不用重新配对。
6. 飞书一个机器人覆盖所有项目，靠「群」区分（5.2）。
7. 主 loop 跑在独立实例里，服务器上原有的 `dsh-superagent` 实例一行不动（5.14）。

### 非目标

- 设备侧不出现工单面板、不做评估、不做决策、不持有策略、不打开 SQLite。
- 不做文件/镜像同步（设备上本来就有仓库）。
- 不做多跳跳板机、不做跨组织的 A2A、不做移动端。
- 不给每个项目配一个飞书机器人（预算论证见 5.2）。
- 不把桌面端整套插件搬进新实例（多数是 Windows 专用，见 5.14）。
- 不解决「主 loop 被攻破等于所有设备被攻破」——只做缓解（见 5.15），不声称解决。

### 反目标（技术上跑通但算失败）

- 设备侧因为连不上主 loop 就什么事都不能干。
- 断线重连后同一件事被执行两遍，或工单状态与设备真实状态分叉。
- 迁移时必须手改数据库里的路径。
- 每加一台设备就要在主 loop 上改配置并重启。

---

## 3. 约束（来自代码与运维，不是偏好）

1. **方向**：服务器打不到公司笔记本（NAT/公司网络）。设备必须**主动外连**。这与 `dsh-server-connector` 的 SSH 出站方向相反。
2. **Assignment 没有设备维度**：`Assignment`（`src/core/model.ts:218`）只绑 Ticket；`Machine` = `stateDir` / `workspace` / `sessionTitle` / `promptMaxChars` / `admissionContext*`（`src/deployment.ts:33-42`）。
3. **worker 拿不到 `srv_*`**：worker 工具白名单（`src/app/sessions.ts` 的 `WORK_TOOLS`）不含远程执行工具。跨设备必须发生在 Executor 层。
4. **状态是单文件 SQLite**（`src/app/store.ts:2`，`node:sqlite`）。
5. **库里存绝对路径**：工单执行目录（`src/core/model.ts:315` 的 `Execution.directory`）、`worker-bin` shim（`src/infra/environment.ts:19`）。
6. **附件根目录写死家目录**：`join(homedir(), '.dsh', 'attachments', 'v1', 'objects')`（`src/sources/dsh.ts:69`）。
7. **进程环境是全局的**：`process.env` 被整体改写（`src/infra/environment.ts:145`），同一进程内不能有两套账号设置。
8. **srv-01 现状**：跑的是上游 prototype（`dsh-superagent 0.1.0`，commit `8c32a9d`），**不是**本文基线那个 fork；`/home/ubuntu/src/dsh-superagent` 下没有 `src/sources/dsh.ts`。
9. **srv-01 资源**：2 vCPU / 3.7 GB 内存，swap 已用 1.8 GB。当常驻 router 合格，当执行农场不合格。
10. **WAL 未合并**：`~/.dsh/state/superagent/orchestrator.sqlite-wal` 约 4,136,512 字节，冷拷前必须 checkpoint。
11. **管理路由只允许环回**：`registerHttp` 在非环回 host 上直接抛错（`src/app/http.ts:364-366`）。主 loop 的对外端点不能长在面板上。
12. **srv-01 没有 `sqlite3` 命令**；checkpoint 只能走 `node:sqlite`，或用服务自身退出时的关闭路径。
13. **工作区身份是 UUID**：`KV.runtime.masters` 存的是 DSH 工作区 UUID → 主会话 id（`src/app/runtime.ts:120-122`），UUID 落在 `$DSH_HOME/storages/workspace.json`。

---

## 4. 方案比较

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| **A. 设备侧接单插件** | 主 loop 把 `Assignment` 发给设备上的一个薄插件；插件在本地开一个会话跑，按帧回报 | **选定** |
| B. 远程调 `dsh headless` | `dsh --session-id … --json --approval-policy never`，设备侧几乎零代码 | 弃：一问一答即退出，长任务插不进新指令、问不了人、附件走不通 |
| C. 共用飞书群谁抢到谁做 | 不写传输 | 弃：无法「自动选合适设备」，而那是需求核心 |

---

## 5. 设计

### 5.1 角色与账本归属

```
┌──────────────── 主 loop（服务器，唯一账本） ────────────────┐
│  Engine / SQLite / Policy / Tickets / Evals / Devices      │
│  Router 会话（每项目一个入口）  ← 人在这里说话               │
│  Selector（accept 时选设备）                                │
│  ForemanExecutor  ── 下发、收回报、管断线                     │
│  Foreman Hub（127.0.0.1 监听 + 隧道，设备来连）               │
└───────────────────────────┬─────────────────────────────────┘
                            │ 设备主动外连（wss，稳定域名）
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   公司笔记本            宿舍电脑            服务器本机
   完整 DSH             完整 DSH            本地直跑（不走网络）
   自有模型/凭据/审批      …                   …
   dsh-foreman-node 插件   dsh-foreman-node       —
   （无工单、无账本）     （无工单、无账本）
```

设备上的人随时可以用自己的 DSH 做别的事；主 loop 派来的活是**另一个会话**（`job-<assignmentId>`），两者互不干扰。

### 5.2 飞书入口：一个机器人，群即项目

**已定方案 A：整台服务器只配一个飞书机器人，用「群」区分项目。**

理由：飞书的「群」本来就承担项目边界；一个机器人 = 一次建应用、一次批权限，加项目只是拉群；拆成每 loop 一个机器人则 N 个项目 = N 套飞书应用、N 份 `lark-cli` 配置，成本随项目数线性增长。

现状：飞书 Triggers 只带 `chatId` 等 meta（`src/sources/feishu-trigger.ts:42`），**不带 workspace**；能带 workspace 的只有本地 Source（`src/sources/dsh.ts:163`）。`masterOf` 只按 `trigger.source === 'dsh'` 分流（`src/app/runtime.ts:232`），所以今天飞书消息**一律进默认主会话**，不会按群路由。

需要新增的一层：

- Policy 里加一张 **群 → 工作区** 的映射（`chatId` → 工作区路径），与 Source 的「接收哪个群」是两回事：前者决定归谁管，后者决定收不收。
- `masterOf` 增加一路：飞书 Trigger 先查这张表，查到就路由到那个工作区的 router 会话，查不到落默认。
- 这条映射**同时决定设备选择**：群归内网项目，则 Selector 只会选带 `intranet` 标签的设备；选不到就 `blocked`，不会退化成「随便找一台跑」。

所以这张表必须和 5.12 的 Selector 一起设计，不能事后补。

### 5.3 领域改动：设备在 accept 时就定了

两处，都在 `dsh-foreman` 自己那份 `src/core/` 里：

**其一**，`Assignment` 增加不可变字段：

```ts
/** 这件活交给谁做；缺省是本机，旧库读出时按本机解释。 */
target?: { deviceId: string; kind: 'local' | 'remote'; directory: string }
```

`directory` 是**设备侧**的绝对路径（不是主 loop 的路径），见 5.5。

**其二**，`AssessmentOutcome.accept` 增加可选 `device?: string`（设备名或标签）。assessor 可以说「这活要去能访问内网的那台」，也可以不说。

**在哪写**：`Tickets.create`（`src/core/tickets.ts:38-54`）的顺序是
`prepareTicket?.(ticket, outcome)` → `newAssignment(ticket)` → `repo.save` → `executor.start`。

选设备发生在 `prepareTicket` 这一步：Selector 拿到 ticket + outcome + 设备注册表，定下 `target`，写到 ticket 上；`newAssignment` 读它填进 Assignment；`save` 落库；`Executor.start` 只负责**照做**。

这样 `Executor.start(ticket, assignment)` 的签名不用改，Executor 也不再需要写库的通道——它本来就只该排队，不该改状态（`src/core/ports.ts` 的注释正是这么说的）。

`outcome.device` 要真的能被模型产出，主 loop 的 assessor prompt 与工具 schema 就得跟着改（现在 accept 的字段是 `title/scope/reason/rules/name/note`，`note` 已被 worker 路由占用，不能挪用）。具体做法：accept 的 JSON schema 加一个可选的 `device`，prompt 里告诉它「只有在需求本身指明地点时才填，否则留空让 Selector 自动挑」。

### 5.4 ForemanExecutor

实现现有 `Executor` 端口，内部持有一个本机 `DshExecutor` 和一个远端分支。**它不选设备**。

- `start(ticket, assignment)`：
  - `target.kind === 'local'` → 原样转给 `DshExecutor`。
  - 远端 → 入队一次下发：设备在线则发 `assign` 帧，`accepted` 后 `Engine.assignmentStarted`。
  - 设备不在线 → `report({ state: 'blocked' })`。**不**伪造 `failed`，**不**悄悄改成本机执行。
- `deliver(ticket, assignment)`：Inputs 作为 `input` 帧发出，设备 `ack` 后 `inputsDelivered`。
- `stop(...)`：发 `stop` 帧，然后**不再等**——`DshExecutor.stop` 就是 fire-and-forget（`src/executor/dsh.ts:406-419`），远端保持一致；迟到的回报由 `Engine` 按「assignment 已结束」拒绝。
- 设备连接变化**不直接**调用 `assignmentInterrupted`（理由见 5.8）。

远端 `report` 帧的 `state` 只能是 `progress` / `ready` / `blocked` / `failed`，**不允许 `dropped`**：`dropped` 在领域里表示「这件事不该做」，是判断而不是执行结果，设备没有判断权。设备想表达同样意思只能 `blocked`，由主 loop 的 router 会话定夺。

### 5.5 设备侧运行时（`dsh-foreman-node`）

薄插件，三件事，**不 import** `src/core/`、不开 SQLite、不读 Policy。

1. **常驻连接**：出站 wss 到主 loop 的稳定域名，带设备令牌；指数退避重连；断线时本地缓冲待发帧。
2. **接单**：收到 `assign` → 用与 `Sessions.ensure`（`src/app/sessions.ts:142`）同源的方式，在帧里给的**设备侧目录**建/复用会话 `job-<assignmentId>`，把任务文本作为一条用户消息投进去。会话出现在设备自己的侧栏，人能看、能插话。

   设备上人插的话**不跨网**：它进设备本地的 job 会话，改变的是设备上这一轮怎么走，但不会变成主 loop 的 `TicketInput`，也不会触发 `followups`。主 loop 眼中的状态仍只由 `foreman_report` 决定。这是刻意的取舍——要让人从设备侧把话送回主 loop，就得在设备上装一个 Source，与「设备侧无 Source」冲突（见 1.1）。若以后需要，正确做法是人直接在 Hub 的 router 会话里说，而不是在设备上说。
3. **回报**：在 job 会话上注册一个 `foreman_report` 工具，schema 与 `orchestrator_report`（`src/app/tools/executor.ts:101-140`）同构：`progress` / `ready` / `blocked` / `failed` + 可选 `question`。工具调用直接转成 `report` 帧。

第 3 点是硬要求，不是便利：领域里「等人」是结构化事实，`report` 的 `question`/`askedBy` 会与真实 Trigger 校验（`src/core/assignments.ts:104-109`），靠「回合结束了」这种启发式猜 `waiting` 属于被明确拒绝的做法（`docs/001-domain.md` 的「Rejected concepts」）。**只信 `foreman_report` 的文本，不信会话事件推断状态。**

### 5.6 路径映射

主 loop 的 `Execution.directory` 是主 loop 自己的路径，设备上不存在。所以：

- 设备在 `hello` 里声明 `roots`：一组 `{ project: 'foo', path: '/Users/me/work/foo' }`（逻辑名 → 设备本地绝对路径）。
- 工单 accept 时，Selector 按项目名在目标设备上解析出 `target.directory`；解析不到 → 这台设备不可选。
- 设备的 `prepare` 由它自己跑（`prepareDirectory`，`src/executor/dsh.ts:294-309` 是本机逻辑，远端不复用）；设备侧跑自己的 prepare 命令，失败即 `report({state:'failed'})`。

主 loop 上「同构路径」的要求（5.13）只约束主 loop 自己，跟设备无关。

### 5.7 附件与长文本

远端 worker 拿不到主 loop 的资源指针（`read: ticket/<id>/input/<x>` 由主 loop 的 `Resources` 提供，`src/app/tools/executor.ts:53-54`）。所以：

- **任务文本一律在主 loop 侧渲染成终稿**，不把资源指针发给设备。`triggerCard` 需要的 `sourceLink` / `repliedTo` 也在这里补齐。
- **附件走字节**：`assign` / `input` 帧带 `attachments: { id, mediaType, name, bytes(base64) }`，设备落进自己的附件库或 job 目录。附件通常很小，不做流式。

### 5.8 断线与恢复

原则：**没有设备的确证，绝不重派。**

- 连接断开：Hub 记 `disconnectedAt`，assignment 保持 `running`，**不**调 `assignmentInterrupted`。理由：该函数对未结算的 assignment 会走 `Tickets.restart`（`src/core/assignments.ts:83-92` → `src/core/tickets.ts:320-329`），立刻结束旧 assignment 并 `executor.start` 一张新的——设备可能还在跑，正是反目标里的「同一件事被执行两遍」。
- 超时（默认 10 分钟无心跳）：`report({ state: 'blocked', summary: 'device offline' })`，等人决定「换设备重试」。**不自动重派**。
- 设备重连：先 `hello` 报「我在跑哪些 assignment」。Hub 对齐：
  - Hub 也认为在跑 → 重新挂上，继续。
  - Hub 已判 blocked/已结束 → 发 `stop`，设备收尾。
  - 设备报「没在跑」而 Hub 认为在跑 → 此时才允许转 `blocked` 或按人工选择重派（有确证，不会重复执行）。
- Hub 重启：远端 assignment 一律**先转 `blocked`**，等设备 `hello`。`DshExecutor.resume()` 在启动时跑（`src/app/runtime.ts:414`），但远端项不得走它——这是 5.3 里「远端分支不转给 `DshExecutor`」的直接原因。

### 5.9 多项目 = 多入口会话

保持现有形态：一份 Engine、一份 SQLite，每个工作区一条 router 会话（`masterFor`，`src/app/runtime.ts:257`，id 由工作区路径推出）。

- `Mandate` / `Subscription` / 跨工单去重都是全局概念（`src/core/model.ts:126`）；拆成多账本，同一个 PR 上的两件事互相看不见。
- 拆会话便宜且可逆；拆账本贵且不可逆。
- 隔离的是上下文，不是状态。

**排除**：每项目一套独立 `stateDir`。那会把「安装麻烦」翻成 N 倍，迁移要搬 N 份库。

### 5.10 设备注册表

设备不是领域概念，但也不是插件配置——accept 时要读它，加设备不能重启（反目标 4）。所以：

- 一张 `devices` 表（同一份 SQLite，走现有 `Store` 的 KV/表机制）：`id`、`name`、`labels`、`tokenHash`、`roots`、`lastSeenAt`、`revokedAt`。
- 令牌只存哈希；吊销 = 写 `revokedAt`，Hub 断开该连接。
- 设备清单、在线状态、最近活动在面板里可看可改（沿用现有 client 半）。

### 5.11 协议

单条 WebSocket，JSON 帧，带 `v` 做版本协商。Hub 监听 `127.0.0.1`，对外由隧道（cloudflared / frp）终结 TLS——因为 DSH 自己的 web server 只允许环回（约束 11），而管理路由不能长在其上。

| 方向 | 帧 | 语义 |
| --- | --- | --- |
| 设备→Hub | `hello` | 设备 id、版本、`roots`、`running: assignmentId[]` |
| 设备→Hub | `heartbeat` | 存活 + 负载 |
| Hub→设备 | `assign` | assignmentId、ticketId、设备侧目录、渲染好的任务文本、附件字节、权限档 |
| Hub→设备 | `input` | 追加 Inputs（对应现有 `TicketInput`），同样渲染成终稿 |
| Hub→设备 | `stop` | 中止理由 |
| 设备→Hub | `accepted` | 已投递进会话 |
| 设备→Hub | `report` | `progress` / `ready` / `blocked` / `failed` + 摘要 + 可选提问（不含 `dropped`） |
| 双向 | `ack` | 按 `frameId` 幂等确认 |

规则：

- 每条带副作用的帧有 `frameId`，接收方去重；设备侧投递复用现有 requestId 幂等语义（`Sessions.holds`，`src/app/sessions.ts:165`）。
- 重连后**设备先报在跑什么**，Hub 对齐，而不是 Hub 假设设备状态。
- 协议不传凭据。
- **协议不运文件**：`roots` 声明的是设备已有目录，任务在设备本地的仓库里做；真要跨机器搬产物，走 git push / 已有的传输工具，不走这条连接。附件例外（5.7），因为它是任务输入而不是产物。

### 5.12 选设备

按顺序：

1. accept 结果里显式点名（`outcome.device`）→ 该设备在线且有对应 `roots` 则用，否则 `blocked`。
2. 能力匹配：按 `labels` 与 `roots` 过滤（要内网、要有某仓库）。
3. 多台可用 → 在跑 assignment 最少的那台；平局取最近心跳。
4. 全不可用 → `blocked` 交给人，不排队空等。

选择逻辑是纯函数：`(ticket, outcome, devices) => target | undefined`，可单测，不碰网络。

### 5.13 迁移

前提（已确认）：**接受迁移期间所有设备断开、在飞的活暂停后在新机器续跑。**

1. 停进程（或让它正常退出，走关闭路径释放锁）。
2. checkpoint WAL：**用 `node:sqlite` 打开后 `PRAGMA wal_checkpoint(TRUNCATE)`**，因为 srv-01 上没有 `sqlite3`（约束 12）。
3. 打包：`$DSH_HOME/state/superagent`、`$DSH_HOME/sessions`、`$DSH_HOME/attachments`、`$DSH_HOME/storages`、`$DSH_HOME/profiles/<name>`。
   `storages/` 必须在内：`workspace.json` 保存工作区 UUID，而 `KV.runtime.masters` 按 UUID 索引（约束 13）；不搬它，主会话与工作区的归属会在新机器上静默重置。
4. 新机器用**完全相同的用户与绝对路径**展开（`/home/ubuntu/.dsh`、`/home/ubuntu/src/...`）。
5. 起进程；设备连的是**稳定域名**，只是重连，不用重新配对。

两条硬约束：**路径同构**（否则 `Execution.directory`、`worker-bin` 要改数据）；**设备连稳定名字**（换服务器 = 改一条 DNS 记录）。

交付物：一份脚本 + 一段 runbook + 迁移后自检（库能开、工单数一致、附件根在、设备全部重连、工作区归属正确）。

### 5.14 主 loop 自身的部署形态（新实例，不动旧的）

主 loop 跑在**独立实例**里，与服务器上原有的 `dsh-superagent` 实例互不干扰：

- **独立 `DSH_HOME`**（如 `/home/ubuntu/.dsh-loop`），不是共用 `~/.dsh`。`dsh` 的 home 由 `$DSH_HOME` 决定（`resolveDshHome(configured, env)`，`dsh-home-paths`），所以两套实例的 `sessions/`、`storages/`、`attachments/` 在文件系统层面就分开了。
- **独立 profile**（如 `loop`），独立端口。
- 旧实例（srv-01 上 tmux 里的 `--profile superagent`，pid 893595，端口 3082）**原样保留**。
- 由 systemd 托管，而不是 tmux 里手动起——否则重启机器就没了，而且 token 每次变，才逼出「从日志 grep token」这种脚本（`panel.py`）。

资源提醒：srv-01 只有 2 vCPU / 3.7 GB 内存，swap 已用 1.8 GB。能跑两个实例，但不宽裕；新实例初期不要开定时任务和大量并发 worker。

**配置同步**：模型与偏好从桌面端带过来，用 `dsh-config-manager`。注意它的 CLI **导不出** `providers` / `settings` / `plugins` / `mcp` 这些分区（`backup-plan.js:77-80`：需要 DSH Service 门面读值，CLI 是离线收集），**只能用 GUI 导出**。凭据默认永不进包（`SENSITIVE_FILE_BASENAMES`），要带必须勾「导出密钥」并设加密密码。

因此同步范围是：**模型与偏好走 GUI 导出/导入；插件按需单独装**——桌面端 26 个插件里有一半是 Windows 专用的（`dsh-remote`、`dsh-wsl-tool`、`dshmarket` 等），全量搬过去在 Linux 上装不上。

### 5.15 安全（只做缓解，不声称解决）

主 loop 被拿下 = 所有设备被拿下，与文章 8.4 结论一致。缓解：

- 设备侧 `job-*` 会话用 `workspace-write` 并限定在声明的 root 内（**不是** `danger-full-access`；现有 `Sessions.ensure` 在 `src/app/sessions.ts:160` 设的就是全权限，远端分支必须换掉这一行）。
- **不做审批转发**：`workspace-write` 内的操作不需要审批，所以「笔记本前没人，任务卡在审批上」不会发生。需要越界时设备不弹窗，而是 `report({state:'blocked', summary:'needs permissions beyond the declared root'})`，由人决定是放宽 root 还是换设备。
- 凭据不进该会话上下文：设备自己的模型 provider 凭据由 DSH 持有，任务文本里不放任何 secret。
- 单设备令牌可吊销；Hub 不持有设备凭据。
- 设备侧本地审计：每个 assign 记一行（谁派的、什么内容、结果）。
- 默认只在声明的 `roots` 里工作。

---

## 6. 我做的判断（实现者可以推翻，但要知道为什么）

1. **内核拷贝而非共享包**：`dsh-foreman` 里放一份 `src/core/` 拷贝。上游 `dsh-superagent` 是 `"private": true`，抽公共包要改两边发布流程；拷贝的代价是将来合上游要手动 diff。
2. **选设备在 `prepareTicket` 缝上，不在 Executor 里**：Executor 没有写库通道，在它里面改 assignment 不会被保存。
3. **设备侧注册 `durable_report` 工具**，而不是从会话事件推断状态。
4. **断线不重派**，只在有确证（设备说没在跑）时才允许换设备。
5. **Hub 监听环回 + 隧道**：绕开 `registerHttp` 的环回限制，也和现有部署方式一致。
6. **设备注册表进同库**，不进插件配置，避免「加设备要重启」。
7. **协议用 WebSocket + JSON**：够简单、可读、双向推；帧语义不变时载体可换。
8. **设备侧会话 id 用 `job-<assignmentId>`**：与 `worker-<ticketId>` 同构，便于排查。
9. **设备侧不落账本**：宁可重连时重新对齐，也不引入第二份真相。
10. **Hub 与 ForemanExecutor 同进程**：先不拆服务。

---

## 7. 留给实现者

- 帧的精确字段与版本协商细节。
- 迁移脚本的语言与打包格式（tar + 校验和即可）。
- Hub 侧连接表不持久化，纯内存 + 设备重连对齐（注册表持久化，见 5.10）。
- 设备侧 `foreman_report` 工具与主 loop `orchestrator_report` 的字段级兼容。
- 两份协议帧定义之间的防漂移测试怎么写（Hub 侧同时 import 两边互解是既定方向，具体形态未定）。

---

## 8. 验收

1. 笔记本上的 DSH 正常可用；主 loop 派一张工单过去，笔记本上出现 `job-*` 会话并跑完，主 loop 收到 `ready`，工单结束。
2. 拔掉笔记本网线：工单在合理时间内转 `blocked`；插回后状态一致，**同一件活没有被执行两遍**。
3. 两台设备同时在线，两张工单落到不同设备。
4. 停服务器、按 runbook 迁到新机器、起服务：工单数一致、工作区归属正确、设备全部重连。
5. 新增一台设备不需要改主 loop 配置、不需要重启主 loop。
6. 一个飞书机器人在两个群里被 @，两个请求分别在各自群对应的项目里开工，回复回到各自群。
7. 新实例起来后，服务器上原有的 `dsh-superagent` 实例仍在跑，端口、会话、数据都不受影响。
8. 模型配置从桌面端经 GUI 导出/导入后，新实例能正常选到同一个 provider 和模型。

### 已排除的其他路线

- 复用 npm 上的 `dsh-fleet`（SnowDu）：那是「算力池」，靠 master 反连 worker 的 `47900`，你的公司笔记本在 NAT 后面连不进去；且它自己没有账本。
- 复用你本地那份 `dsh-fleet`（Punica Studio）：那是「多机管理台」，控制端同样要主动连远程 `IP:端口`，且只做「看」，不做「派」。
- 每个项目一个飞书机器人：成本随项目数线性增长，且同一群里多机器人仍要靠 `meta` 分流，问题没消失。
- 用 `dsh-config-manager` 的「档案」另起独立实例：档案共用同一个 `~/.dsh`，做不到文件系统级隔离。
