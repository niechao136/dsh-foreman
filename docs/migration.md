# 迁移：把主 loop 搬到新机器

> 目标：停 → 打包 → 传 → 同路径展开 → 起 → 自检。设备不用重新配对。

前提（设计 5.13 已确认）：迁移期间所有设备断开，在飞的活暂停；到新机器后由设备重连对齐，
**不自动重派**。

---

## 为什么不能只拷 `.sqlite`

库跑在 WAL 模式，最新写入还在 `orchestrator.sqlite-wal` 里。只拷 `.sqlite` 会**静默丢掉最近的工单**。
`srv-01` 上没有 `sqlite3` 命令，所以 checkpoint 只能走 `node:sqlite`——`scripts/migrate.mjs` 就是这一层。

`storages/` 也必须搬：`workspace.json` 存的是工作区 UUID，而 `KV.runtime.masters` 按 UUID 索引。
不搬它，主会话与工作区的归属会在新机器上**静默重置**成「无工作区」。

---

## 五步

### 1. 停进程

```bash
systemctl stop dsh-loop          # 不用 systemd 时：在 tmux 里发 Ctrl-C，等它自己退出
ps -p <pid>                      # 确认真的没了；锁在 stateDir 上，进程还在就 checkpoint 不了
```

### 2. 打包（在旧机器上）

```bash
export DSH_HOME=/home/ubuntu/.dsh-loop
node scripts/migrate.mjs plan --home "$DSH_HOME"     # 先看要搬什么、多大
node scripts/migrate.mjs pack --home "$DSH_HOME" --out /tmp/loop.tar.gz
```

`plan` 打印五个目录（`state/superagent`、`storages`、`sessions`、`attachments`、`profiles`）的大小；
某个目录 `absent` 不是错误，但**要确认它本来就没有**。

### 3. 传

```bash
scp /tmp/loop.tar.gz new-host:/tmp/
```

### 4. 同路径展开

```bash
# 新机器上：用户与绝对路径必须与旧机器完全一致（/home/ubuntu/.dsh-loop 与 /home/ubuntu/src/...）
mkdir -p /home/ubuntu/.dsh-loop
tar -xzf /tmp/loop.tar.gz -C /home/ubuntu/.dsh-loop
```

**两条硬约束**：

- **路径同构**。库里的 `Execution.directory`、worker shim 的绝对路径都是写死的；路径不同不是改配置能修的，
  得改数据。
- **设备连稳定域名**。换服务器 = 改一条 DNS 记录，设备侧配置一行不动。

### 5. 起进程并自检

```bash
systemctl start dsh-loop
export DSH_HOME=/home/ubuntu/.dsh-loop
node scripts/migrate.mjs verify --home "$DSH_HOME"
```

`verify` 打印：

```
home: /home/ubuntu/.dsh-loop
checkpoint ok
workspace.json: present
tickets: 137
rows: kv=… trigger=… ticket=137
```

在**旧机器**上跑同样的 `verify`，两边的 `tickets` 数必须一致。`workspace.json: MISSING` 或
`missing directory:` 任何一行都要停下来查，不要继续。

设备侧：主 loop 一起来，设备会在退避窗口内重连；面板的设备页应显示它们重新上线。**不会自动重派**
在飞的活——那些工单会停在 `blocked`，由人决定继续还是换设备。

---

## Windows 上

`migrate.mjs` 在 Windows 只做 checkpoint 并打印要手工复制的目录：`tar` 不保证存在，
而一次半截的打包比一条打印出来的清单危险得多。主 loop 本来就装在 Linux 服务器上，
Windows 这条路径是给「本地试跑」用的。

---

## 出问题了怎么退

旧机器上的 `$DSH_HOME` **在确认新机器可用之前不要删**。回退就是：停新机器 → 在旧机器上
`systemctl start dsh-loop` → 设备重连。旧库没有被新机器写过（迁移期间不写），所以回退是安全的。
