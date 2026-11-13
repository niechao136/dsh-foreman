## 0.7.1 — 2026-11-13

### 修复：群/仓库映射到项目后，消息仍落到机器级默认主子

面板「项目对应」写的是 `/dsh-context-fold`，hub 上的工作区是 `/root/dsh-context-fold`。`masterIdForPath`
用**字符串全等**比较两者，于是每一行都查不到，`masterOf` 一路 fallback 到默认主子——群里的消息由机器级
router 处理，而且**没有任何地方留下痕迹**：操作者在面板上看不出是路由表打错了。

- 路径比较改走 `samePath()`（`src/foreman/path.ts`）：折叠多余的 `/` 与 `.`/`..`、去掉末尾分隔符，
  并且在**大小写不敏感的文件系统上才**折叠大小写（Linux 上 `Foo` 与 `foo` 是两个项目，合并会把活派进
  错的 checkout）；
- 新路由健康项 `routing`：映射指向打不开的目录，或目录里没有工作区时，在概览上报出具体路径，
  而不是静默退回默认主子；
- `ensureChatWorkspaces` 现在也遍历**仓库**路由（以前只看群）。

### 修复：主会话选不出设备，因为评估根本没有设备清单

线上三次 ignore 的理由是「no registered device named "dorm computer" exists」，而设备注册表里 `pc` /
显示名「宿舍电脑」当时就在册。真正的原因是**设备清单从来没进过任何 prompt**：`admission.md` 让模型
「按设备 id 或名字填写 device」，但注册表内容一处都没有喂给它。

- 候选卡片与 `orchestrator_eval` 的 payload 都带上 `devices`：id、显示名、标签、能接的项目名、在线状态、
  当前负载。**不含设备路径**（面板要过隧道，路径是那台机器的磁盘地图）；
- `selectDevice` 的设备名匹配改为 `namesDevice()`：整串先比，再按 token 比，NFKC 归一、大小写不敏感、
  去掉 `()（）/·,，、|`。线上那张票写的是 `"宿舍电脑 pc"`（名字和 id 拼在一起），严格相等两个都不命中，
  于是票被当成「设备离线」blocked。仍然只匹配 id 与显示名，不做前缀匹配。

### 修复：改 GitHub 令牌后插件卡在「卸载中」

只换令牌的保存会触发一次进程内 restart。`serve().close()` 只是 `await server.close()`，而 node 的
`server.close()` 语义是「停止 accept，然后**等所有现有连接结束**」；一条握手没完成的设备连接就能让它永不
返回。disposer 不返回，fiber 永远停在 unloading，依赖它的 github-watch/feishu-watch/local-watch 全部
「等待依赖」。

- `serve().close()` 先 `terminate()` 掉 `server.clients` 里剩下的连接，再给 `server.close()` 一个 5 秒上限；
- `Runtime.shutdown()` 整体加 30 秒上限：超时就记一条 warn 并继续关库、放锁，宁可放弃一次优雅关闭，
  也不能让插件永久停在卸载中；
- 回归测试 `closes while a device is connected`：移除修复会超时失败（已实测）。

### 优化：「项目与仓库」的仓库勾选改为紧凑选择器

原来每个项目行下面平铺整张复选框列表，仓库一多，每个项目行都和整个 GitHub 来源一样高，
操作者真正要改的那一栏「项目目录」反而最小。

- 行内只留一行：已选仓库的 chip（可单个移除）+「选择仓库（已选 N）」按钮；
- 点开才是可搜索的列表，带「全选当前结果 / 清空当前结果」；
- 已从 GitHub 来源消失的仓库仍然列出并标注，编辑时不会静默丢掉。

## 0.7.0 — 2026-11-12

### 新增：查证类需求也能接单（`answer` 规则）

线上账本里，版本查询、状态查询一律被判「no enabled rule admits it」。根因不在规则写得不够宽，
而在**结构**：`directionAllowed()` 要求 `implementation_requested === true`，所以查询类无论开哪条规则
都不可能被接受。

- `AdmissionDirection` 增加 `answer_requested`，与 `implementation_requested` 并列；
- 查证类**不需要** `target_basis`（「部署的是哪个版本」没有目标要确定），变更类仍然需要；
- 新增默认规则 **Status answers**：只读、必须给出证据、不得改动任何东西；
- 工单记下 `workKind: 'change' | 'answer'`，面板显示「查证（只读并回报）」。

默认规则从两条变三条，因此提示词里的规则行会变长——预算测试守住了这一点，`admission.md` 也相应压缩。

### 新增：完成标准写进任务（P1-3）

`ticketExecution` 现在把一份「完成标准」附在任务文本后：变更类核对改动与测试，查证类核对每个问题都
有证据且未改动任何东西。设备模型对着清单勾选，比自行判断「什么时候算完」容易得多，hub 也能按同一份
清单审阅回报。这也降低了 `watchTurnEnd` 兜底被触发的概率。

### 新增：远端工单的结构化回报（P1-1）

`ReportFrame.detail` 携带设备侧从自己历史里统计的事实：回合数、工具调用与失败数、改动的文件、最后的
错误、测试计数。**由设备侧计算而非模型叙述**，所以数字不会被回报文本美化。面板的工单页新增「这台设备
的执行摘要」。旧设备不带 `detail`，hub 照常工作。

### 新增：按需拉取远端 transcript（P1-2）

新增 `read` / `part` 帧与 `ticket/<id>/device` 资源：设备保留完整历史，hub 一次只要一页（≤4000 字符，
必然装得进 256 KiB 帧上限）。不必让设备把整份记录推上来，路由器上下文就不会被一台设备的日志撑大。

### 新增：协议能力协商（P0-2）

`hello` 增加 `capabilities`。**新增字段不再改协议版本**：一台关机一个月的笔记本回来后仍能连上，只是
少了新功能；hub 用 `supports()` 跳过设备没有的能力，而不是发一个它答不了的帧。

### 新增：话题归属（P3）

`Mandate.topic` 把「同一件事」与「这个项目里的新一句话」分开。本地操作者的线程是整个项目对话，无法
区分二者——这正是「接着那张工单做」一直做不到的原因。现在消息里写 `#topic:<名字>` 即可：

- 同一话题、工单已结束 → 接上那张工单（同一件事继续做）；
- 不同话题或没写话题 → 照旧各开一张单。

`thread` 管投递，`topic` 管归属。
## 0.6.1 — 2026-11-12

### 修复：飞书回复卡在 2200，「已重试 4 次」永不成功

线上一条回复连续失败：

```
Something went wrong. Please contact technical support … (2200)
```

在服务器上用同一份凭据逐项复现后确认：**这不是代码里的参数写错，而是飞书的一个边界条件**。

飞书对「目标消息还没有话题（`thread_id` 为 null）」时带 `--reply-in-thread` 的回复，
返回 **2200**（通用服务端错误，且标 `retryable: true`）。实测对照：

| 目标消息 | `--reply-in-thread` | 普通回复 |
| --- | --- | --- |
| 没有话题（`thread_id = null`） | **2200 失败** | 成功 |
| 已有话题（`thread_id = omt_…`） | 成功 | 成功 |

那条失败的消息是群里一条顶层消息、当时还没有任何人在话题里回它，所以 `thread_id` 为空。
飞书把 2200 标成可重试，于是重试永远不可能成功——它缺的不是时间，是一个还不存在的话题。

现在：带话题回复被 2200 拒绝时，**退化成不带话题的普通回复**（同一个幂等键，所以绝不会重复发）；
其它 2200（真正的服务端故障）仍然照常重试。
## 0.6.0 — 2026-11-12

### 修复：面板上没有「策略」，`policy.sources` 无处可填

接单规则、各来源的名单、准入表一直存在（`PolicyBlock`），但它被渲染在「设置 › 评估」里，
而侧栏的 `SETTINGS_GROUPS` **没有任何一项指向它**。结果：

- 面板上找不到「策略」，`policy.sources` 无法编辑；
- 名单为空时，准入默认值等于「谁都不接」，于是每条消息都被判 **发送者不在名单里**。

现在「策略」是独立的设置分组：接单规则 + 各来源名单 + 准入表。「评估」只留接单模式、超时、模型，
两组各自独立保存。

### 新增：一个项目可以挂多个仓库

「项目对应」原本一行一个仓库对一个目录。但实际情况是一个工作目录服务多个仓库
（`dsh-foreman` 与 `dsh-foreman-node` 就是同一个目录）。

页面改为**按项目编辑**：填一个目录 + 勾选多个仓库 + 一组设备标签。存储仍是每仓库一行
（查找是按仓库进行的），保存时再摊开——**已有配置不需要迁移**，运行逻辑不变。

同一目录不同标签会被当成两个项目，因为标签决定哪台设备能接活，合并会悄悄放宽其中一边。
## 0.5.9 — 2026-11-12

### 修复：0.5.8 没修好轮询失败（真正的根因）

0.5.8 让 `commandEnvironment` 带上了凭据，但漏了更关键的一层：**那份环境是在 `Commands` 构造时按值取的**。

`Runtime` 构造函数里写着 `new Commands(..., setup.commandEnvironment, ...)`——getter 在那一刻被求值，
而 setup 还没跑，于是凭据映射是空的，被冻结进了之后每一条命令。`agentVariables()` 里的
`GH_TOKEN: undefined` 又恰好把 `process.env` 里的值也清掉，结果宿主自己的 `gh` 拿到的是空字符串。

现在 `Commands` 接受一个**函数**形式的覆盖值（`Environment`），每次 `run()` 时才求值；
`Runtime` 传 `() => setup.commandEnvironment`。

服务器上实测：修复前 `gh` 报未登录，修复后同一进程内 `process.env.GH_TOKEN` 为真值。
## 0.5.8 — 2026-11-12

### 修复：GitHub 轮询连续失败（`gh` 报未登录）

令牌本身是好的，`gh auth status` 也能读到。真正的问题是**宿主自己的 `gh` 调用**跑在一个不含凭据的环境里。

`Commands.run()` 把 `setup.commandEnvironment` 铺在 `process.env` 之上，而那份环境由 `agentVariables()`
构成——它把 `GH_TOKEN` 主动设成 `undefined`（防止操作者 shell 里的令牌漏给智能体）。于是 `undefined`
覆盖掉了 setup 刚刚注入的凭据：worker 走 shim 一切正常，**只有宿主自己的轮询在裸跑**。
这就是「部署看起来是好的、却一直提示 `gh auth login`」的来源。

现在 setup 把解析出的凭据单独记住，并在 `agentVariables()` **之后**合并进 `commandEnvironment`；
`restore()` 同时清掉这份副本。

### 修复：只改令牌不会生效

凭据不落在 settings 文档里，所以「只换了令牌、没动任何配置」保存出来的文档与旧文档完全相同。
保存逻辑把它当成空操作提前返回，setup 从未重跑，`process.env` 里仍是旧令牌，
而面板上显示的是新令牌。

现在 `credentialChanged` 既触发账号校验，也强制重启 setup。

### 文档

`dsh-foreman` 与 `dsh-foreman-node` 的 README 补上「怎么用」：安装、来源与凭据配置、
策略与准入、设备登记与 tunnel，以及「不接单时的理由是什么、去哪里改」。
删掉了 `dsh-foreman-node` README 里重复的 `cordis.patch.yml` 示例。
## 0.5.7 — 2026-11-11

### 修复：改令牌 / 加仓库时保存被拒

保存来源卡片时，账号校验在**凭据写入之前**执行，而且只拿到已存的旧凭据。于是一个从没成功保存过令牌的人，
无论填什么新令牌，那一刻校验用的 `gh` 都是未登录的，结果必然是 `agentCliSignedOut`——看起来像令牌错了。

两处一起改：

- `checkAccounts` 现在把**本次提交的**凭据一起传给探测（并用它覆盖已存值）；
- 只改令牌、不改任何 config 字段时也会跑校验。原先的触发条件是 `setupChanged`（只比较 config），
  单填一个令牌根本不会进入校验，与注释里写的“保存时检查”不符。

## 0.5.6 — 2026-11-11

### 修复：令牌已经存进去，`gh` 却仍然报未登录

`Setup` 在 source 插件注册之前运行，此时 `sources.instances()` 是空数组。`credentials()` 遍历它来收集凭据，
于是一个循环都没执行，注入的环境变量为空——这是「填了有效令牌却报 agentCliSignedOut」的最后一层原因。

现在改为直接枚举数据库里的 `source-secret:` 键，完全不依赖注册表。

## 0.5.6 — 2026-11-11

### 修复：令牌已经存进去，`gh` 却仍然报未登录

`Setup` 在 source 插件注册之前运行，此时 `sources.instances()` 是空数组。`credentials()` 遍历它来收集凭据，
于是一个循环都没执行，注入的环境变量为空——**这是「填了有效令牌却报 agentCliSignedOut」的最后一层原因**。

现在改为直接枚举数据库里的 `source-secret:` 键，完全不依赖注册表；连 `variableOf` 的回退也因此能在
插件注册后继续生效。

## 0.5.5 — 2026-11-11

### 修复：服务器上已存的令牌无法解密

早期构建把加密串又 JSON 编码了一次，数据库里存的是带引号的 `"v1:…"`。`unseal` 收到的 version 因此变成
`"v1`，GCM 认证失败，已保存的令牌等同于没有——`gh` 自然报「读不到账号」。

现在 `unseal` 会先解开这层引号，旧记录继续可用；新写入仍然是裸的 `v1:…`。


### 修复：服务器上已存的令牌无法解密

早期构建把加密串又 JSON 编码了一次，数据库里存的是带引号的 `"v1:…"`。`unseal` 收到的 version 因此变成
`"v1`，GCM 认证失败，已保存的令牌等同于没有——`gh` 自然报「读不到账号」。

现在 `unseal` 会先解开这层引号，旧记录继续可用；新写入仍然是裸的 `v1:…`。

## 0.5.4 — 2026-11-11

### 修复：升级后已存的令牌被静默忽略

0.5.3 起凭据记录里额外存了变量名（`GH_TOKEN=token`），但升级前存的记录只有裸字段名 `token`，
注入时会因为找不到变量名而被跳过——已经填好令牌的人升级后会莫名报「读不到账号」。
现在 source 插件注册之后，裸字段名会回退到它声明的变量名，旧记录继续可用。


### 修复：升级后已存的令牌被静默忽略

0.5.3 起凭据记录里额外存了变量名（GH_TOKEN=token），但升级前存的记录只有裸字段名 	oken，
注入时会因为找不到变量名而被跳过——已经填好令牌的人升级后会莫名报「读不到账号」。
现在 source 插件注册之后，裸字段名会回退到它声明的变量名，旧记录继续可用。

## 0.5.3 — 2026-11-11

### 修复：填了令牌却报「读不到账号」

两个原因叠在一起，都出在「凭据要等部署检查做完才注入」这条顺序上：

1. esolveDeployment / esolveFeishuBot 在 pplyEnvironment **之前**执行，探测用的 gh / lark-cli 拿不到
   GH_TOKEN / LARKSUITE_CLI_APP_SECRET，于是对一个完全可用的令牌报 gentCliSignedOut。
   现在凭据作为参数随每次探测一起传下去。
2. Setup 在 source 插件注册之前运行，credentials() 因此查不到 kind，也就拿不到环境变量名。
   现在凭据记录里紧跟每个值存下 变量名=字段（如 GH_TOKEN=token），注入不再依赖注册顺序。

### 修复：凭据输入框无法输入（0.5.1 已修，此处一并说明）

输入框绑在服务端的占位值上，而服务端总把每个值报成空字符串，受控输入框因此把每次击键清掉。

## 0.5.1 — 2026-11-11

### 修复：凭据输入框无法输入

文本框绑在 source.secret 上，而服务端出于「不回传明文」的考虑，总是把每个值报成空字符串。受控输入框的 alue`r
因此恒为 ''，每次击键都被立刻清掉——看起来就像输入框是禁用的。现在绑定到草稿里的值。

已保存的凭据会在空白框里显示「已保存，留空表示不修改」的提示。

### 修复：留空保存会把已存凭据删掉

「清空输入框就是删除」与「空框表示不修改」两处语义互相矛盾，而后者才是唯一能成立的：面板从不回传密钥，
所以无法区分「没动过的框」和「清空的框」。原先的代码在提交空对象时直接删掉记录，导致在同一张卡上
保存任何一个无关字段都会静默丢掉令牌。现在只要没有填写任何值就一律保留已存凭据；要去掉凭据，把 CLI 设为不选即可。

## 0.5.0 — 2026-11-11

### 修复：项目对应页没有保存按钮

`routing.tsx` 把自己的编辑结果当成 `useBlockDraft` 的 `saved` 基线，于是每份草稿都和「自己」比较、永远相等，`dirty`
恒为 false，保存条——唯一能落盘的地方——从不渲染。看起来就像这页没有保存按钮。现在 `saved` 取真正存下的值。

### 新增：CLI 改为「先发现、再选择」

飞书的 `lark-cli` 与 GitHub 的 `gh` 不再是手填路径，而是一个下拉框，选项来自**当场扫描**本机（服务进程的 PATH
加 `/usr/local/bin` 等标准前缀，按 `gh`/`gh-cli`、`lark-cli`/`larksuite-cli` 两种拼写）。旁边的刷新按钮重新扫一遍：

- 装完 CLI 不需要重启 dsh-foreman 就能看到；
- 扫到几个就列几个（同一台机器上装了两份 `gh` 时能选）；
- 已保存但这次没扫到的值仍然显示，不会被悄悄换成别的程序；
- 「手动输入路径…」保留输入能力——用 `GH_CONFIG_DIR` 登录的 gh 包装脚本不会出现在标准目录的扫描里。

### 新增：选中 CLI 后就地填写凭据

选中一个 CLI 之后，卡片展开凭据表单：飞书要 App ID + App Secret（`cli_` 开头的应用凭据），GitHub 要一个令牌。

凭据**加密后存进 foreman 的数据库**，不写进两个 CLI 自己的配置：

- AES-256-GCM，每次写入随机 nonce，密文带格式版本与 GCM 认证标签；
- 密钥放在 `<stateDir>/secret.key`（`0600`），**不在数据库里**——只拿到 `.sqlite` 或其备份的人读不出令牌；
- 密钥文件损坏时报错而不是悄悄重建（重建会让已存凭据全部变成读不出的样子）；
- 面板不回传明文：设置页只说「这些字段已填」，输入框留空表示「不修改」；
- 注入时用各自 CLI 的官方环境变量（`LARKSUITE_CLI_APP_ID` / `LARKSUITE_CLI_APP_SECRET` / `GH_TOKEN`），
  与 worker 其余环境一起写入，宿主自己的 CLI 调用和 worker 用同一个账号。

### 新增：允许在仓库、群、项目目录上做下拉选择

项目对应页的「群」从飞书来源已知的群名里选，「仓库」从 GitHub 来源已配置的仓库里选，仍然可以直接输入未知值。
**项目目录保持文本输入**：面板拿不到设备路径（只拿到项目名），而这个值必须是真正跑那台机器上的绝对路径，猜一个比问
更糟。

## 0.4.2 — 2026-11-10

### 修复：面板现在会告诉你「装了工具，但来源没用它」

服务器上装了 `gh` 和 `lark-cli`，面板却完全看不出任何变化。原因不在发现逻辑，而在**它根本没被调用**：

- `resolveDeployment` 在没有订阅仓库时直接返回（`deployment.ts:164`），不检查 `gh`；
- `resolveFeishuBot` 在没有填 `cli` 名时直接返回（`deployment.ts:196`），不检查 `lark-cli`。

于是「机器上没有这个工具」和「来源没有设置所以不需要这个工具」在面板上长得一模一样，操作者只能靠猜。

新增 `diagnoseClis()` 与设置 › 部署里的「命令行工具」卡片，只回答「这台机器上有没有、装在哪」，
**不改变任何 Source 的行为，也不因此拒绝启动**：

- 找到 → 显示实际路径；
- 找到但 GitHub 来源没订阅仓库 → 显示「已找到，但…不会使用它」，把这个状态明说出来；
- 飞书留空 → 显示「未设置……不启动机器人」（这是正常状态，不是错误）；
- 找不到 → 显示搜索失败的原因原文。

探测每次读取 `/orchestrator/api/state` 时重算，所以装完工具刷新页面就能看到，不用重启插件。

## 0.4.1 — 2026-11-10

### 新增：项目对应（GitHub 仓库 → 项目）

路由表原来只能回答「哪个飞书群属于哪个项目」，GitHub 来的请求**完全没有项目**——`prepareTicket` 拿不到 workspace，
就选不了设备，工单只能在本机执行。现在 `routing` 同时收仓库：

```yaml
routing:
  repositories:
    - { repository: acme/widgets, workspace: /srv/widgets, labels: [intranet] }
```

仓库名按大小写不敏感比较（GitHub 的 owner/repo 就是如此），`labels` 与群路由同义。**这是修 bug，不是加功能**：
没登记的仓库仍在本机跑，GitHub 工单从此才能真正派到设备上。

### 新增：设置 › 项目对应一页

`routing` 从只能经数据库或 agent 工具修改，变成面板上的一等设置块（独立 revision，并发保存互不影响）。
两半都以表格编辑，不填 JSON：群 id 和仓库名是又长又难记的字符串，一列一事的表格才看得清。

### 新增：一台机器被选上之后还能换

`AssignmentTarget.pinned`：请求点名机器、或群路由限定了标签时置位，重试仍去那台；否则重试可以重新选，
排除刚失败的那台。设备离线不再意味着一整天的人工介入，**前提是没人点名要那台机器**。

### 改进：CLI 路径不再必填

GitHub CLI 与飞书 CLI 留空时，在 PATH 与常见安装位置里查找（`gh`/`gh-cli`、`lark-cli`/`larksuite-cli`）。
**填了就严格按填的来**：静默回退到另一个二进制会把 agent 登录成那个它的账号，这正是这个字段存在的理由。

### 内部：`frame` 队列与 reselect 的接缝

`EngineOptions.reselectTarget` 是可选的：没有它，重试一律保留原机器，与之前一致。

## 0.3.9 — 2026-11-09

### 设备端跟到 0.4.0：设备可以把本机页面发布到枢纽

枢纽锁定的 `dsh-foreman-node` 从 0.3.0 跳到 0.4.0。新增的反向隧道让**枢纽上的浏览器能打开设备的配置页**：
设备用 `ssh -R` 请枢纽在自己 loopback 上开一个端口，转发回设备的 `ctx.webServer.port`。

本机端口不写进配置——它是操作系统启动时分配的（实测 65277 与 65371 之间变化），写死会在设备重启后
转发到一个没人监听的端口。发布失败与设备接单完全隔离：只是没有页面，任务照收。

配置页现在同时显示两条地址，因为它们是两个不同的端口：本机那条是 DSH 实际拿到的端口，只在设备上打得开；
枢纽那条是 `expose.remotePort`，只在枢纽上打得开。令牌来自 `connection.authenticatedUrl()`。

设备保存配置后**不再需要重启 DSH**：监听 `loader/volatile-update` 重建隧道与连接。以前页面那句「重启后
生效」是真的，因为 `apply()` 构造完就没人再读配置了。`jobPreset` 也补了配置页栏位，此前只能手改 patch。

### 修复：点名了设备，工单却发给了另一台

真机现场（上海服务器，两台设备 `laptop`＝公司笔记本、`pc`＝宿舍电脑）：

| 工单 | 用户点名 | 实际派给 | 路由备注 |
| --- | --- | --- | --- |
| `3481d0ac` | 公司笔记本 | **pc** | 目标机器是「公司笔记本」，不是宿舍电脑 |
| `8bce26dc` | 公司笔记本 | **pc** | 用户指定在公司笔记本执行 |

根因不在设备、连接或端口，而在**显式路由这条路上根本没有选择机器的字段**：

- 选机只发生在 `prepareTicket`，它读 `outcome.device`（`src/foreman/prepare.ts:63`）；
- `outcome.device` 只由 `orchestrator_eval_decide` 的 `AssessmentSchema` 提供（主动评估那条路）；
- 而操作者直接下的指令走 `orchestrator_route`（kind=accept），它的 `RouteItemSchema` 里**没有 `device`**
  → `request.device` 恒为 `undefined` → `mustBeRemote` 恒为假 → 退化成纯自动选机：
  **最闲 → lastSeenAt 最新 → id 字典序**。两台设备都声明了同名项目根，于是谁闲谁中。

账本可以直读：出问题的工单 decision 的 `reason` 都是 `[{"code":"explicitRouted"}]`，且全库所有 accept
decision 的 `audit` 里 `device` 出现 **0 次**。主会话其实一直知道目标机器，只能写进 `note`——而 `note`
是给 worker 看的文本，对枢纽选机毫无作用。

更糟的是派单文本会以 `You are the device **宿舍电脑** (id pc)… When the request names this machine —` 开头，
**反过来告诉错误的设备「你就是被点名的那台」**。

修法：

- `orchestrator_route` 的 item 增加可选 `device` 字段（按 id 或 name），透传进 `engine.decide`，与
  `orchestrator_eval_decide` 对齐；`FIELDS` 里登记为 accept 读取、非必填。
- `prompts/dispatch.md` 明确：请求本身点名机器时填 `device`；`note` 从不决定机器；被点名的设备离线时工单
  `blocked`，绝不改派别处。
- 模型可见文本预算从 59,000 提到 60,000（基线只剩 10 字符余量，本次净增 ~550）。

`selector` / `prepare` 未改：`selectDevice` 本就支持按 id 或 name 精确匹配，`prepare.ts` 在点名设备不可用时
本来就落 `blocked` 而不是悄悄换机器。

回归测试（`tests/tools.spec.ts`）：

- 点名机器（且该机器更忙）→ 派给被点名的机器；
- 未点名 → 仍由 selector 选最闲的；
- 点名机器不在线 → `blocked`，**不**在枢纽本机运行。

## 0.3.8 — 2026-11-09

### 设备端跟到 0.3.0：配置页搬进「设置 › 设备连接」

`dsh-foreman-node` 0.3.0 把设备的配置页从「插件详情」搬成了设置面板里的一整页。枢纽里对这个包的版本锁定
跳了一版本（0.2.2 → 0.3.0），`pnpm-lock.yaml` 里则一直停在 0.1.0，落后三个版本，这次一并补上。

装完之后设备配置在 **设置 › 设备连接**，插件详情里不再有独立的配置页。

### 说明

新增 `pnpm-workspace.yaml`：pnpm 11 默认拒绝安装 24 小时内发布的依赖（供应链保护），但枢纽锁定的设备包
总是刚发布就装。只对 `dsh-foreman-node@0.3.0` 这一个名字豁免，其余依赖照旧受限。

# Changelog

本仓库的历史从本项目自己的初始提交开始，**不携带上游 git 历史**（见 README 的「由来与致谢」）。
下面 `0.2.0` 一节是从代码基线 `dsh-superagent-local` 沿袭下来的、那一份代码相对上游
`dsh-superagent-prototype` 的改动记录，保留它是为了说明基线里已经有什么；**它不是本项目的发布版本**。

本项目自己的版本从 `0.1.0` 开始。

## 0.3.7 — 2026-11-08

### 修复：0.3.6 漏发了提示词改动

`0.3.6` 改了 `prompts/replies.md`，但那个文件是运行时从 `prompts/` 读取的，而构建用的同步脚本不复制这个
目录——于是发出去的包版本号是 0.3.6，内容却还是旧的。同步脚本已补上 `prompts/` 和 `locale/`。

`0.3.6` 的功能（`dsh` 来源直接写回复正文）现在才真正生效。

## 0.3.6 — 2026-11-08

### 改进：`dsh` 来源的结果直接写进对话

主 loop 收到设备回报后，已经把结论整理好了，却通过 `orchestrator_reply` 发出去——而在 `dsh` 来源里，
那个"收件人"就是当前这段对话。结果是：真正的内容藏在工具调用的展开项里，对话里只剩一句
"已发到对话里"，同一句话还说两遍。

现在提示词明确：**来源是 `dsh` 时，结果直接写进回复正文**，不调那个工具。它留给飞书、GitHub 这类
真的经由外部渠道的会话——那些地方回复正文到不了人。

### 依赖

`dsh-foreman-node` 升到 `0.2.2`：设备上的权限预设可以配置了。

## 0.3.5 — 2026-11-08

### 修复：编辑设备会清空它的项目，并让它再也连不上

三个缺陷叠在一起，一次「编辑」就能毁掉一台设备：

1. **页面提交的 roots 是空的。** `DeviceRow` 故意不发布设备路径（面板经隧道分享，路径等于那台机器的
   磁盘地图），所以编辑表单拿到的只有项目名，路径全是空串；保存时 `filter(root => root.path)` 把
   它们全部丢掉。每次保存都把原有项目清空一次。
2. **服务端把「没给路径」当成「清掉路径」。** 现在：**只给项目名时保留库里已存的路径**；只有真正新增的
   项目才要求填路径（那时本来也没有旧值可保留）。
3. **清空之后设备被永久拒绝。** roots 变成空数组后，设备重连时 hello 里的真实 roots 与注册表对不上，
   `rootsMismatch` 于是拒绝连接——设备再也回不来，面板上一直是离线。

修法：空的注册表记录不再当作「矛盾」拒绝，而是**采纳设备自己声明的 roots 并写回注册表**，
这样下一次握手就有据可依。注册表已有 roots 时，仍按原规则校验，声明不一致照样拒绝。

### 修复：改个名字也会把设备踢下线

`updateDevice` 无条件调用 `hub.detach`，改显示名或标签也断连，看起来就是莫名离线。
现在只有**roots 真的变了**才断开让它重连重新声明。

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
