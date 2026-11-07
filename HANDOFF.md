# 交接文档（HANDOFF）

> 更新时间：2026-11-07 08:55
> 下次接手时，**先读这一页**，再读 `docs/superpowers/specs/` 和 `docs/superpowers/plans/`。

---

## 一、这是什么

**dsh-foreman**：一个常驻的主 loop，把工单派给多台在线设备上各自完整运行的 DSH。
账本只有一份，在服务器上。设备只执行、只回报，不建工单、不做评估。

三个名字的关系：

| 项目 | 位置 | 说明 |
| --- | --- | --- |
| `dsh-foreman` | https://github.com/niechao136/dsh-foreman | **主 loop**，装在服务器。拥有全部账本 |
| `dsh-foreman-node` | https://github.com/niechao136/dsh-foreman-node | **设备侧**，每台设备一个。薄，只连接/接单/回报 |
| 设计 + 计划 | `docs/superpowers/specs/`、`docs/superpowers/plans/` | 两份都要读 |

代码基线是 `dsh-superagent-local`（第三方，它是 `dsh-superagent-prototype` 的改编版），
**是搬过来的，不是 git fork**，README 里写清了来源与 MIT 署名。

---

## 二、当前进度

计划共 **14 个任务**，**全部完成**（1332 项测试通过）：

| 任务 | 状态 | 落点 |
| --- | --- | --- |
| Task 1 建仓库 | ✅ | 两个仓库已建、已推 |
| Task 2 协议帧 | ✅ | 定义在 **node 仓**，hub 通过依赖导入 |
| Task 3 Assignment 加 target | ✅ | `264b4ee` |
| Task 4 设备注册表 | ✅ | `9220ca8` `src/foreman/devices.ts` + `KV.foreman.device` |
| Task 5 Selector | ✅ | `94380bf` `selector.ts` + `prepare.ts` |
| Task 6 ForemanExecutor | ✅ | `4ab7c6f` `executor.ts` + `render.ts` |
| Task 7 Hub 连接 | ✅ | `3a093b7` `hub.ts` + `ws.ts`（唯一 import `ws` 的文件） |
| Task 8 回报/断线 | ✅ | `61694ad` `reports.ts` |
| Task 9 设备侧插件 | ✅ | node 仓 `04cd4a8`（**不在 hub 仓**，见决策 2） |
| Task 10 文本渲染 | ✅ | `b779d04` |
| Task 11 迁移脚本 | ✅ | `7eb981b` `scripts/migrate.mjs` + `docs/migration.md` |
| Task 12 面板设备页 | ✅ | `9b2b5d9`「设置 › 设备」 |
| Task 13 飞书群路由 | ✅ | `7962aa1` `routing.chats` |
| Task 14 部署 runbook | ✅ | `462d5ab` `docs/deploy-loop-instance.md` |

**Git 状态**：两个仓库都已推送，与 origin 同步。
hub 仓 `master` = `0d0661a`，node 仓 `master` = `b79e44d`。

**已过一轮独立代码审查**（审查范围 `264b4ee..462d5ab`），报出 2 个 Critical + 5 个 Important + 若干 Minor，
已全部处理并各自补了测试。最要紧的是两条：

1. **设备侧从没注册过 `foreman_report`** —— `JobSessions.reportTools` 没有任何调用方，
   于是设备永远无法回报，主 loop 只能等。现在由 `ensure()` 自己挂工具，并保证重复 assign 只挂一次。
2. **Hub 重启会把在飞的远端 assignment 再派一遍** —— `DshExecutor.resume()` 没有按 target 过滤，
   走到 `Tickets.restart` 就新开一张。现在 `resume()` 跳过远端，运行时对它们只报一次 `blocked`（设计 5.8）。

---

## 二点五、发布了没有

**发布了 `0.1.0` 和 `0.1.1`。`0.1.1` 是真机验证后修掉两个打包/健壮性问题的版本，用它。**

| 版本 | 为什么要它 |
| --- | --- |
| `0.1.1` | **用这个。** 补上 `scripts/`（`0.1.0` 漏了，导致加设备的命令不存在）+ 帧无正文时的握手加固 |
| `0.1.0` | 首个发布，有上面两个问题 |

| 位置 | 地址 |
| --- | --- |
| npm（hub） | https://www.npmjs.com/package/dsh-foreman |
| npm（设备侧） | https://www.npmjs.com/package/dsh-foreman-node |
| Release（hub） | https://github.com/niechao136/dsh-foreman/releases/tag/v0.1.0 |
| Release（node） | https://github.com/niechao136/dsh-foreman-node/releases/tag/v0.1.0 |

两个 tag 都叫 `v0.1.0`。hub 的依赖 `dsh-foreman-node` 是**精确版本号 `0.1.0`**（不是 `^`）：
两个包同步发版，协议不一致时握手就拒绝。

两处 release 都**附了 `.tgz` 资产**，与 npm 上那份**逐字节相同**：
`dsh-foreman-0.1.0.tgz`（sha1 `2a0d87e7…`，386361 B）、
`dsh-foreman-node-0.1.0.tgz`（sha1 `8d73ddff…`，23987 B）。
两个都实测从 GitHub 下载后 sha1 一致、能装上、能 import。

### `0.0.0-stage` 删不掉（不是没做，是做不到）

npm 现在用 **staged publishing**：每次 `npm publish` 都会在 registry 里先落一个
`0.0.0-stage` 的真实版本。它**不是** `npm stage` 的暂存对象（`npm stage list` 是空的），
所以 `npm stage reject` 用不上；要删只能 `npm unpublish`。

而 `npm unpublish` 被 npm 的政策挡住了：

```
E403 Granular access tokens that bypass two-factor authentication may not perform this action
```

本机只有一枚 automation token（`bypass_2fa: true`）。**绕不过，`--force` 也不行**，
这是服务端按 token 类型拒绝的。要真删，得用**不绕过 2FA 的 token 或网页登录**在
https://www.npmjs.com/ 上手动操作（`npm unpublish <pkg>@0.0.0-stage`），npm 只允许发布后
72 小时内删。

**已做的替代处理**：两个占位版本都标了 deprecation，`npm install <pkg>` 会打出警告并指向 `0.1.0`；
`latest` 本来就是 `0.1.0`，所以正常安装拿不到占位版本。

### 真机验证：上海服务器 srv-02 --- 已跑通

不是纸面验收，是在 Ubuntu 24.04 上真装的：

| 项 | 结果 |
| --- | --- |
| Node 24.9 + `@deepseek-ai/dsh@0.2.2-rc.1` | 装好，`dsh --version` 正常 |
| `dsh plugin --profile loop add dsh-foreman@0.1.1` | 从 npm 装成功，**只引入 8 个包** |
| `--dump-config` 里 `dsh-foreman-node` 出现次数 | **0 次** —— 设备包的 patch 行没有被连带激活，这是设计里一直未实测的那条验收标准，**现在通过了** |
| 面板 3100 + hub 8790 | 都起来 |
| hub 握手 | 错误令牌 -> `error` 帧拒绝；正确令牌 -> 保持连接 |
| 设备登记 | `lastSeenAt` 被写入库 |
| `scripts/add-device.mjs add/rotate` | 都可用（`0.1.1` 才有） |

`dev-ops-mcp` 三个容器**只停未删**（`docker compose stop`，可逆），释放约 190 MB，
现在可用内存约 890 MB。仓库 `/github/dev-ops-mcp` 与 `data/` 都还在。

**还没跑的**：需要真实模型的端到端闭环（人说话 -> 评估接单 -> 派给设备 -> 设备调
`foreman_report` 回 `ready`）。本地那个 `router` provider 只暴露 `GET /router/api/*`
管理接口（`/v1/chat/completions` 返回 405），不是可直接外部调用的 OpenAI 兼容端点，
所以没能在服务器上复用本地模型配置。

### 发版时踩到的坑（下次照做）

1. **`private: true` 必须删掉**，否则 `npm publish` 直接拒绝。两个包都已经删了。
2. **npm 的 staged publishing 会先出现一个 `0.0.0-stage` 占位版本**。
   `npm publish` 打印成功之后，registry 里还要一两分钟才出现真正的版本；
   用 `curl https://registry.npmjs.org/<pkg>` 轮询 `versions` 字段确认，别以为发失败了。
   这个 `0.0.0-stage` **留着删不掉**（见上一节），所以发版前就要接受它会永久留在版本列表里。
3. **pnpm 的 `minimumReleaseAge` 策略会拦住刚发布的版本**。
   本机 WSL 里踩到过：`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`。
   `pnpm install` 时加 `--config.minimumReleaseAge=0` 即可，**不要**为了它往仓库里提交
   `pnpm-workspace.yaml`（那只在本机成立）。
4. **这台机器没有 npm 登录态**（`~/.npmrc` 只有镜像 registry）。
   发布用的是 `npm publish --//registry.npmjs.org/:_authToken=...`，token 不落盘。
   下次发版前先确认 token 还有效：`curl -H "Authorization: Bearer $TOKEN" https://registry.npmjs.org/-/whoami`。

## 三、环境怎么跑（重要，踩过坑）

### 测试只在 WSL 里可信

Windows 上跑会有一堆**环境性失败**（`sleep` 不存在、chmod、tmux、路径反斜杠），
原仓库也一样，**不是代码问题**。

现在有脚本了，**不要**再手抄 rsync：

```bash
~/bin/sync-wsl                           # hub 仓：全量跑
~/bin/sync-wsl tests/foreman-hub.spec.ts  # hub 仓：只跑指定文件
~/bin/sync-node                           # 设备仓
```

两个脚本的源在仓库里（hub 仓的 `scripts/sync-wsl.sh`），改完要
`cp scripts/sync-wsl.sh ~/bin/sync-wsl` 一次。它们会把 `src/`、`tests/`、`docs/`、`scripts/`
同步过去、统一成 LF、再跑 vitest（超时放大到 60s）。

WSL 里的 Node 在 `~/.local/opt/node-v22.22.0-linux-x64/bin`；装包用 Windows 那份 pnpm 的绝对路径：
`node /mnt/f/Deepseek/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs install`。

**基线**：`1332 passed`。`tests/sources.spec.ts > reports an event line too large to buffer`
是已知的**负载敏感 flaky**：单独跑基本都过，和别的重活并行时偶发（它等的是一个 45 秒窗口）。
判断方法：单独跑这个文件，若全绿就不是回归。

### 编码：PowerShell 会毁掉中文

**不要用 `Get-Content -Raw` 改文件**——PowerShell 5.1 按 GBK 读 UTF-8，会把中文写成乱码
（`package.json` 就这么坏过一次）。用 .NET：
`[System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)`。
或者干脆在 WSL 里用 Python 改。

### 两个仓库的行尾

hub 仓有 `.gitattributes`（`* text=auto eol=lf`）；**node 仓没有**，工作区里是 CRLF、库里是 LF。
归一之后再 `git add`，否则 diff 会显示整个文件被改写：

```bash
for f in $(git ls-files) src/*.ts; do sed -i 's/\r$//' "$f"; done
```

### 已经修过的坑（别退回去）

- **git 依赖只能走 HTTPS**：本机没有 GitHub SSH key，pnpm 拉 `github:…` 依赖会失败。已设
  `git config --global url."https://github.com/".insteadOf git@github.com:`。
- **`checkHeartbeats` 必须查账本，不能查 Hub**：设备**彻底断线**后就不在 `hub.snapshot()` 里了，
  而那正是唯一需要超时转 `blocked` 的时刻。现在从 `tickets.open()` 取 running assignment，
  Hub 只提供负载与 lastSeen。
- **`memoryChannel` 不能用 class 实例**：计划里的 `{ ...a, close }` 展开会把 class 的方法丢掉。
  现在是普通对象。
- **`hubPort` 默认 0（Hub 关）**：端口被占不能拖垮整个插件激活，面板要照常可用。

---

## 四、已经定下来的关键决策

这些是讨论过的结论，**不要重新发明**：

1. **两个独立仓库**，不是一个包两个入口。一个包只有一份 patch，设备装上会连带插入 hub 行，
   而 hub 要 `stateDir`、锁库、开监听，笔记本上起不来。
2. **协议只有一份，在 node 仓**（`src/protocol.ts`）。hub 依赖它、
   从 `dsh-foreman-node/protocol` 导入。反过来会把整个领域内核装进每台笔记本。
3. **设备必须在 accept 时就定**：`Ticket.target` → `newAssignment` 复制到 `Assignment.target`。
   因为 `newAssignment` 看不到 `outcome`，所以选择要落在 Ticket 上。
4. **选设备在 `prepareTicket` 缝上，不在 Executor 里**。Executor 没有写库通道。
5. **断线绝不自动重派**。`assignmentInterrupted` 会走 `Tickets.restart` 立刻重开一张，
   而设备可能还在跑 —— 那是「同一件事执行两遍」。超时只转 `blocked`。
6. **设备侧必须注册 `foreman_report` 工具**，不信会话事件推断状态。
   设备不允许报 `dropped`（那是判断，设备没有判断权）。
7. **飞书：一个机器人 + 群即项目**（方案 A）。群 → 工作区映射进 Policy，
   且同时约束设备选择（内网群只选带 `intranet` 标签的设备）。
8. **主 loop 用独立 `DSH_HOME`**（`~/.dsh-loop`）+ 独立 profile + systemd，
   不碰服务器上原来的 `dsh-superagent` 实例（pid 893595 / 端口 3082，tmux 里那个）。
9. **node 仓提交 `lib/` 产物、不带 `prepare`**。git 依赖会跑 `prepare`，
   pnpm 拒绝白名单外的包（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），
   而且 pnpm 11 已不读 package.json 的 `pnpm` 字段。
10. **Hub 与传输解耦**：`Hub` 只认 `Channel`（`send`/`close`/两个事件注册），
    `ws` 只出现在 `src/foreman/ws.ts` 一个文件里。测试用 `memoryChannel()` 内存管道。
11. **设备会话的权限是 `workspace-write`，不是 `danger-full-access`**。
    主 loop 自己的会话用全权限（人就在前面），设备上没人，弹审批等于卡死；
    要越界就报 `blocked` 让人决定。
12. **设备侧插件在 node 仓，不在 hub 仓**。计划文档 Task 9 写的是 `dsh-foreman/src/node/`，
    那与决策 1、2 冲突，已按决策做在 node 仓。

---

## 五、下一个任务怎么开始

**14 个任务全部完成。** 接下来不是写新代码，是**真机验收**——计划末尾那份验收清单一条都还没在
真实设备上跑过：

**真机验收前，先确认三件只有上机才能验证的事**（自动化测试覆盖不到）：
设备真的能收到任务并在 `job-*` 会话里跑起来；`foreman_report` 在真模型身上被调用；
拔网线后 `blocked` 在 `hubIdleMs` 内出现。这三条通过之后，再走下面的清单。

1. 服务器起独立实例（`docs/deploy-loop-instance.md`），笔记本装 `dsh-foreman-node`。
2. 主 loop 派一单过去：笔记本上出现 `job-*` 会话并跑完，主 loop 收到 `ready`。
3. **拔网线**：10 分钟内工单不变；超过 `hubIdleMs` 转 `blocked`；插回后 `hello` 对齐，
   **同一件活没有第二张 assignment**（这是整套设计最核心的一条）。
4. 两台设备同时在线，两张工单落到不同设备。
5. 按 `docs/migration.md` 迁一次机。
6. 飞书两个群 @ 同一个机器人，各自落到对应项目。

第 3 条是唯一值得专门盯着跑的：它跨了 Hub、reports、Selector 三个模块。

改代码时仍然：**每个任务独立 commit**，`pnpm typecheck` + 全量测试（WSL）绿了才提交。

---

## 六、待解决的悬而未决

1. ~~`masterOf` 同步/异步~~ **已解决**（Task 13）：`src/foreman/routing.ts` 按
   `KV.settings.revision` 缓存 chat → workspace 索引，映射改了对**新到的消息**生效；
   已在飞的消息保持它当时被路由到的项目。
   副作用：映射到的工作区若还没有主会话，第一批消息会先落默认主会话（后台正在建那条）。
2. **`dsh-foreman-node` 作为传递依赖时是否会激活它自己的 patch 行** —— **仍未验证**。
   验收标准：装完 hub 后 `dsh --profile loop --dump-config | grep foreman`
   **只能出现 `dsh-foreman` 一行**。这是设计里明确的风险点，装完必须看一眼。
3. ~~迁移脚本还没写~~ **已写**（Task 11），但**没有在真机上跑过**。第一次真迁机前
   先用 `--home` 指向一个复制出来的 home 空跑一次 `plan` / `verify`。
4. **两个仓库都没 push**。hub 仓 10 个 commit、node 仓 1 个都还在本地。
   node 仓的 `lib/` 已重新构建并提交，但 hub 的 `pnpm-lock.yaml` 还指向 node 仓的**旧 commit**
   ——协议没变所以不影响，下次 `pnpm update dsh-foreman-node` 会跟上。
5. **面板的设备页没有真实数据验证过**：`GET /devices` 与吊销/换令牌两个 POST 只有单测。
6. **`ws` 是唯一的新增依赖**，仍是 `8.22.0`（钉死版本，不是 `^`）。

---

## 七、相关但不属于本项目的

- 服务器上原有实例 `dsh-superagent`（上游 prototype 0.1.0，不是本项目的 fork 基线）
  仍跑在 tmux 的 `dsh-superagent` session 里，端口 3082。**保持不动。**
- 查看服务器面板：用 `dsh-remote` 插件的「远程 DSH 界面」，不要再用 `panel.py`。
  注意 `dsh` 不在非交互 SSH 的 PATH 上，需要在 dsh-remote 里配绝对路径
  `/home/ubuntu/.local/bin/dsh`，profile 填 `superagent`。
- 工作区里 `dsh-fleet/` 是从 GitHub 下载的**别人的**插件（Punica Studio 的多机管理台），
  与我们要做的东西**不重叠**（它只「看」，我们「派」），留着参考即可。
