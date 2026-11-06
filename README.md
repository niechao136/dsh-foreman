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

## 状态

**早期开发中。** 设计与实现计划见：
- [设计](docs/superpowers/specs/2026-11-06-dsh-foreman-design.md)
- [实现计划](docs/superpowers/plans/2026-11-06-dsh-foreman.md)

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
