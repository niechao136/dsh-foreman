# dsh-foreman

> **Not an official DeepSeek product.** 这是第三方项目，与 DeepSeek 官方无关。

**一句话：一个常驻的主 loop，把工单派给多台在线设备上各自完整运行的 DSH，账本只有一份。**

你在服务器上装 `dsh-foreman`，它拥有全部工单、策略和评估；你在每台个人机器上装
[`dsh-foreman-node`](https://github.com/niechao136/dsh-foreman-node)，它只负责接单、在本地跑、
把结构化回报交回来。设备上不建工单、不评估、不持有策略、不打开数据库。

```
┌──────────── 服务器：dsh-foreman（唯一账本）────────────┐
│  Engine / SQLite / Policy / Tickets / Evals / 设备表    │
│  每个项目一个主会话入口   ← 你在这里说话                  │
│  Selector：accept 时决定这活交给哪台机器                  │
│  Foreman Hub：设备主动连上来                              │
└──────────────────────┬─────────────────────────────────┘
                       │  设备外连（wss，稳定域名）
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   公司笔记本        宿舍电脑        服务器本机
   dsh-foreman-node  dsh-foreman-node  本地直跑，不走网络
```

## 怎么用

装好之后，日常只有四件事。全部在 Web 面板里做，不需要碰命令行。

### 1. 装上去

```bash
dsh plugin --profile loop add dsh-foreman
```

`dsh-foreman` 是 **bundle**：安装后自动向 profile 的 `cordis.patch.yml` 追加插件行，
不需要你手写配置。完整步骤（独立 `DSH_HOME`、独立端口、systemd 托管）见
[独立实例 runbook](docs/deploy-loop-instance.md)；已经有一个实例要搬家见[迁机](docs/migration.md)。

**主 loop 上只装 `dsh-foreman`。** `dsh-foreman-node` 只装在被派活的机器上——它进主 loop
就等于把设备侧插件也装到服务器，两侧职责会打架。

### 2. 配来源（谁能让智能体干活）

设置 › 来源。每张卡片三件事：

| 项 | 说明 |
| --- | --- |
| 程序 | 下拉选本机的 `gh` / `lark-cli`；旁边 ⟳ 重新扫描 PATH。留空 = 自动查找 |
| 凭据 | 选中程序后出现输入框，加密存进 foreman 自己的数据库，**不写 CLI 的配置** |
| 仓库 / 群 | 一行一个 `owner/name` 或群；仓库可以直接下拉选已加入的群聊 |

保存时会**当场校验**：用你刚填的凭据跑一次 `gh api user`，并逐个检查仓库的推送权限。
校验不过就不保存，报错直接指向这张卡片。

> 凭据输入框留空 = **保持不变**，不是清空。要移除凭据，取消选择程序即可。

### 2.5 配项目对应（活在哪里做）

设置 › **项目对应**。一个**项目** = 一个目录 + 一组仓库：

- 一个目录可以服务**多个仓库**（比如 `dsh-foreman` 和 `dsh-foreman-node` 共用一个工作目录），
  勾选即可，不用重复填路径。
- 仓库里的请求落到它所在项目的目录；**没登记的仓库只能在本机执行**，因为工单不知道自己的项目就选不了设备。
- 飞书群也在这页映射：哪个群属于哪个项目。
### 3. 配策略（什么请求会被接）

设置 › **策略**，三部分：

- **接单规则**——智能体按规则判断一条请求该不该接。默认两条：Copy fixes（错别字/措辞）、
  Visual fixes（局部间距/对齐/溢出）。规则是自然语言，写清楚"什么算"和"什么不算"。
- **各来源的名单**——谁能通过这个来源发起工作。飞书填 open_id（或用「同步来源群」跟群成员走），
  GitHub 填账号名。**名单为空 = 谁都不能发起**，这正是"发送者不在名单里"的来源。
- **准入表**——每个接收范围里，算**明确请求**、**推断的候选**、还是**忽略**。

**接单模式**在「设置 › 评估」里，决定推断的候选怎么处理：

| 模式 | 行为 |
| --- | --- |
| `observe` | 只记录"本会接单"，什么都不做。先用它观察判断准不准 |
| `auto` | 按规则真的接单、开工 |
| `off` | 只接明确请求，不推断 |

### 4. 看工单

面板的工单页列出每张工单的状态、决策理由、和它派给了哪台设备。

- **判定** 页是流水：每条触发进来后，准入的结果和理由（"发送者不在这个来源的名单里"
  就是这样出来的）。
- 一条请求**不接**时，理由一定是这两类之一：**发送者不在名单**（设置 › 策略 里加人），
  或**准入表设为忽略**（改准入表）。两者都指向设置里的具体一格，不是玄学。

## 状态

**早期开发中。** 设备注册表、Selector、ForemanExecutor、Hub、回报规则、设备侧插件、文本渲染、
迁移脚本、面板设备页、飞书群路由都已落地，测试 1332 项。设计与实现计划见：
- [设计](docs/superpowers/specs/2026-11-06-dsh-foreman-design.md)
- [实现计划](docs/superpowers/plans/2026-11-06-dsh-foreman.md)
- [交接文档](HANDOFF.md)

部署两件事各有一份 runbook：[独立实例](docs/deploy-loop-instance.md) 与 [迁机](docs/migration.md)。

## 一眼看懂它怎么派人

accept 一张工单时，`prepareTicket` 这一步就选定了设备，写进 `Ticket.target`，再由 `newAssignment`
复制到 `Assignment.target`——**不是** Executor 选的（Executor 没有写库通道）。之后：

- `target.kind === 'local'`：原样交给本机的 `DshExecutor`，行为与没有设备时完全一样。
- 远端：变成一帧 `assign` 发给那台设备。设备不在线就报 `blocked`，**不伪造 failed，也不悄悄改成本机跑**。

断线**绝不自动重派**：设备可能还在跑，重派就是同一件事执行两遍。超时只转 `blocked`，交给人。

## 由来与致谢

本项目**不是**一个 git fork，但代码以
[dsh-superagent-local](https://github.com/mengzhongjie/dsh-superagent-local) 为起点，
而后者是 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
（DeepSeek Harness 团队）的改编版。三者的关系：

| 项目 | 作者 | 与本项目的关系 |
| --- | --- | --- |
| [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | DeepSeek Harness Team | 原始研究原型；本项目的架构思想来源 |
| [dsh-superagent-local](https://github.com/mengzhongjie/dsh-superagent-local) | mengzhongjie | 上述原型的本地化改编；本项目代码基线 |
| **dsh-foreman** | niechao136 | 在多设备与迁移方向上的重写与扩展 |

原始代码以 MIT 许可发布，Copyright (c) 2026 DeepSeek Harness Team，[LICENSE](LICENSE) 予以保留。
本仓库的 git 历史从本项目自己的初始提交开始，不携带上游历史；**这不是假装原创，而是为了
避免把一份无法与上游对齐的三方历史混进来**。要核对上游改动，请直接比对上面两个仓库。

架构思想来自 DeepSeek Harness 团队的《Super-agent 设计探索：迈向更自主的 Agent 系统》。
本项目借用了其中已经落地的部分（双层架构、Trigger/Thread/Subscription、计算与执行环境分离），
并对该文第八节自己承认为未解的问题（尤其是 A2A 与安全）给出了自己的取舍，而不是声称解决。

## 许可

MIT，见 [LICENSE](LICENSE)。
