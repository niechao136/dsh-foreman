# 交接文档（HANDOFF）

> 更新时间：2026-11-06 18:20
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

计划共 **14 个任务**，已完成 **3 个**：

| 任务 | 状态 | 说明 |
| --- | --- | --- |
| Task 1 建仓库 | ✅ | 两个仓库已建、已推、测试全绿（Linux 基线 1238 项） |
| Task 2 协议帧 | ✅ | 定义在 **node 仓**，hub 通过依赖导入 |
| Task 3 Assignment 加 target | ✅ | `264b4ee`，126 项相关测试通过 |
| Task 4 设备注册表 | ⬜ **下一个** | 见计划文档 |
| Task 5 Selector | ⬜ | |
| Task 6 ForemanExecutor | ⬜ | |
| Task 7 Hub 连接 | ⬜ | |
| Task 8 回报/断线 | ⬜ | |
| Task 9 设备侧插件 | ⬜ | |
| Task 10 文本渲染 | ⬜ | |
| Task 11 迁移脚本 | ⬜ | |
| Task 12 面板设备页 | ⬜ | |
| Task 13 飞书群路由 | ⬜ | |
| Task 14 部署 runbook | ⬜ | |

**Git 状态**：两个仓库都已推送，工作区干净（截至 `264b4ee`，需确认已 push）。

---

## 三、环境怎么跑（重要，踩过坑）

### 测试只在 WSL 里可信

Windows 上跑会有一堆**环境性失败**（`sleep` 不存在、chmod、tmux、路径反斜杠），
原仓库也一样，**不是代码问题**。

```bash
# 1. 同步到 WSL（不要在 /mnt/d 上跑，太慢）
rsync -a --exclude node_modules --exclude lib --exclude .git \
  /mnt/d/super-agent/dsh-foreman/ ~/src/dsh-foreman/

# 2. 统一成 LF！否则 docs.spec 会因为 CRLF 全线失败
cd ~/src/dsh-foreman
find . -path ./node_modules -prune -o -type f \( -name "*.ts" -o -name "*.md" \) -print \
  | grep -v node_modules | xargs sed -i 's/\r$//'

# 3. 跑（超时必须放大，默认 10s 在 WSL 里会大量误报超时）
node node_modules/vitest/vitest.mjs run --testTimeout=60000 --hookTimeout=60000
```

**基线**：`1238 passed | 1 flaky`。那个 flaky 是
`tests/sources.spec.ts > reports an event line too large to buffer`，
单独跑稳定通过，全量并发时偶发。

`node_modules` 是从 Windows 拷进 WSL 的（WSL 里 pnpm 直接段错误，别在那里装）。
需要更新依赖时，在 Windows 用：
`node D:/Deepseek/resources/runtime/primary-runtime/dependencies/node/bin/node.exe <pnpm.mjs> install`

### 编码：PowerShell 会毁掉中文

**不要用 `Get-Content -Raw` 改文件**——PowerShell 5.1 按 GBK 读 UTF-8，会把中文写成乱码
（`package.json` 就这么坏过一次）。用 .NET：
`[System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)`。
或者干脆在 WSL 里用 Python 改。

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

---

## 五、下一个任务怎么开始

**Task 4：设备注册表**。读计划文档对应小节，按里面的测试先写、再实现。

要点（计划里已写好）：
- `src/foreman/devices.ts`，`kv.ts` 加 `foreman` 家族
- 令牌只存 SHA-256，`node:crypto`，不加依赖
- 不允许出现第三方依赖

完成一个任务就 `git commit`，然后继续下一个。建议每个任务独立 commit，方便回退。

---

## 六、待解决的悬而未决

1. **`masterOf` 是同步的，`masterFor` 是异步的** —— Task 13 飞书路由会遇到。
   计划里选了「Runtime 缓存 `workspace path → masterId`，配置变更时刷新」，
   但**缓存刷新时机没定死**（群映射改了之后，已经在飞的消息怎么办）。
   做到 Task 13 时可能需要再确认一次。
2. **`dsh-foreman-node` 作为传递依赖时是否会激活它自己的 patch 行** —— 未验证。
   验收标准是：装完 hub 后 `dsh --profile loop --dump-config | grep foreman`
   **只能出现 `dsh-foreman` 一行**。
3. **迁移脚本还没写**（Task 11），实际迁移前必须做完。

---

## 七、相关但不属于本项目的

- 服务器上原有实例 `dsh-superagent`（上游 prototype 0.1.0，不是本项目的 fork 基线）
  仍跑在 tmux 的 `dsh-superagent` session 里，端口 3082。**保持不动。**
- 查看服务器面板：用 `dsh-remote` 插件的「远程 DSH 界面」，不要再用 `panel.py`。
  注意 `dsh` 不在非交互 SSH 的 PATH 上，需要在 dsh-remote 里配绝对路径
  `/home/ubuntu/.local/bin/dsh`，profile 填 `superagent`。
- 工作区里 `dsh-fleet/` 是从 GitHub 下载的**别人的**插件（Punica Studio 的多机管理台），
  与我们要做的东西**不重叠**（它只「看」，我们「派」），留着参考即可。
