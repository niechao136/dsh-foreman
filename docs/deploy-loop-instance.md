# 部署：把主 loop 跑成一个独立实例

> 目标：在 srv-01 上再起一个 **独立** 的 DSH 实例（独立 `DSH_HOME`、独立 profile、独立端口），
> 由 systemd 托管；服务器上原有的 `dsh-superagent`（pid 893595 / 端口 3082 / tmux）**一行都不动**。

---

## 为什么是独立实例

`Runtime` 构造时对 `machine.stateDir` 上锁，而且只建一个 `Engine`。两个插件装进同一个实例会在锁和会话命名上撞车。
所以新实例从文件系统层面就分开：

| 项 | 旧实例（不动） | 新实例（本文） |
| --- | --- | --- |
| `DSH_HOME` | `~/.dsh` | `/home/ubuntu/.dsh-loop` |
| profile | `superagent` | `loop` |
| 端口 | 3082 | 3100 |
| 托管 | tmux 手动起 | systemd |

资源：srv-01 是 2 vCPU / 3.7 GB，swap 已用 1.8 GB。两个实例跑得动但不宽裕；
新实例初期**不要**开定时任务和大量并发 worker（Execution 设置里的 `maxWorkers` 保持默认）。

---

## 1. 建独立 home 与 profile

```bash
export DSH_HOME=/home/ubuntu/.dsh-loop
# 跑一次就让它把目录结构建出来
dsh --profile loop --dump-config > /dev/null
```

`dsh` 不在非交互 SSH 的 PATH 上（它在 `~/.local/bin`）。systemd unit 里必须写绝对路径，
或者先软链一次：

```bash
sudo ln -sf /home/ubuntu/.local/bin/dsh /usr/local/bin/dsh
```

## 2. 装两个包中的**一个**

```bash
dsh plugin --profile loop add "github:niechao136/dsh-foreman"
```

**验收**：`--dump-config` 里只能出现 `dsh-foreman` 一行，**不能**出现 `dsh-foreman-node`。
设备侧那个包只装在被派活的笔记本和宿舍电脑上；它进了主 loop 就等于把设备侧插件也装到了服务器
（handoff 里这条验收标准至今未实测，装完顺手确认一下）：

```bash
dsh --profile loop --dump-config | grep foreman
# 期望：只有一行，且是 dsh-foreman
```

## 3. 配置 profile 的 patch

复制 `examples/profile.cordis.patch.yml` 到 `~/.dsh-loop/profiles/loop/cordis.patch.yml`，替换占位符。
与本项目相关的两个键：

```yaml
- id: dsh-foreman
  config:
    stateDir: /home/ubuntu/.dsh-loop/state/superagent
    hubPort: 8790          # 设备连进来的环回端口；0 = 不开 Hub，所有工单在本机跑
    hubIdleMs: 600000      # 设备多久没心跳就报 blocked
```

**`hubPort` 只监听 `127.0.0.1`**。对外由隧道（cloudflared / frp）终结 TLS——DSH 自己的 web server
只允许环回，管理路由不能长在它上面。设备连的是**稳定域名**，不是 IP。

## 4. 搬模型配置（GUI 导出，不是 CLI）

桌面端 `dsh-config-manager` **GUI** 导出，勾 `providers` + `settings`，加密包传到服务器，
在 `loop` 实例里导入。

- CLI **导不出** `providers` / `settings` / `plugins` / `mcp` 这些分区（需要 DSH Service 门面读值，CLI 是离线收集）。
- **不要整包导入插件**：桌面端一半插件是 Windows 专用的（`dsh-remote`、`dsh-wsl-tool`、`dshmarket` 等），
  Linux 上装不上。插件在服务器上按需单独装。
- 凭据默认永不进包；要带必须勾「导出密钥」并设密码。

## 5. systemd unit

`/etc/systemd/system/dsh-loop.service`：

```ini
[Unit]
Description=DSH foreman main loop
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Environment=DSH_HOME=/home/ubuntu/.dsh-loop
ExecStart=/home/ubuntu/.local/bin/dsh --profile loop --port 3100 --no-open
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-loop
```

用 systemd 而不是 tmux：否则重启机器就没了，而且每次启动 token 都变，才会逼出「从日志 grep token」
这种脚本。

## 6. 验收

```bash
systemctl status dsh-loop          # active (running)
ss -ltn | grep 3100                # 面板在听
ss -ltn | grep 8790                # Hub 在听（配了 hubPort 时）
ps -p 893595                       # 旧实例还活着 —— 这一条最重要
curl -s localhost:3100/orchestrator/api/state | head -c 200
```

面板里应能看到「设置 › 设备」这一组。

## 7. 加第一台设备

**全程在界面里完成，不碰命令行。**

1. 主 loop 的「设置 › 设备」里填 id、显示名、它能接的项目和**那台机器上的路径**，点「登记」。
   卡片会给出四样东西：`url`、`deviceId`、`token`，以及设备配置页的位置。
   **令牌只显示这一次**——库里只存哈希，关掉或刷新就再也拿不回来，丢了只能换一个。
2. 到那台设备的 DSH，「设置 › 插件 › dsh-foreman-node」打开配置页：
   - **密钥**：下拉里是从这台机器 `~/.ssh` 列出的密钥，挑一把。没有可用的就先 `ssh-keygen`。
   - **SSH**：勾上「走 SSH 隧道」，填枢纽机器、端口、用户。
   - **测试连接**：点一下，认证通不通当场就知道。有口令的钥匙会明说。
   - **枢纽**：把第 1 步的 `deviceId` 和 `token` 填进去。地址框在隧道开着时是只读的，
     显示的是设备真正会拨的本地端口。
   - **项目路径**：项目名 → 本机路径。
3. 保存，**重启那台设备的 DSH**。主 loop 不用重启——设备表在数据库里，不在插件配置里。

设备的隧道由插件自己拉起，断了会自动重连，所以**不需要再手开 `ssh -L`**。

界面不在时（比如 headless 服务器），同样的操作可以用脚本完成：

```bash
cd /home/ubuntu/src/dsh-foreman
export DSH_HOME=/home/ubuntu/.dsh-loop
node scripts/add-device.mjs add --home "$DSH_HOME" --id laptop --name 公司笔记本 --label intranet --root shop='D:\工作\shop'
```

其他命令：`list`（谁登记了）、`rotate`（换令牌，旧的立刻失效）、`revoke`（吊销，下一次心跳就断）。

### 为什么设备要走隧道

`hubPort` 只监听 `127.0.0.1`，这是故意的：账本是唯一值得保护的东西，把端口开到公网等于
只靠一枚令牌挡着它。所以别的机器要连它，就得在中间架一条 SSH 隧道——现在这条隧道由设备
自己开，配置页里填完就有。

如果枢纽本来就在公网可达（前面有 cloudflared 之类），把隧道关掉、地址填 `wss://` 域名即可，
那时候 `url` 才参与连接。

## 8. 飞书：一个机器人，群即项目

整台服务器只配**一个**飞书机器人，用「群」区分项目（设计 5.2）。在 Policy 设置里维护映射：

```json
{ "routing": { "chats": [
  { "chatId": "oc_shop", "workspace": "/home/ubuntu/src/shop", "labels": ["intranet"] }
] } }
```

这张表同时决定两件事：群里的话进哪个项目的主会话，以及**哪些设备可以接这个项目的活**。
`labels` 写了 `intranet`，Selector 就只会选带该标签的设备；**选不到就 `blocked`，不会退化成随便找一台**。

映射改了之后对**新到的消息**生效；已经在飞的消息保持它当时被路由到的项目。
配了映射但那个工作区还没有主会话时，第一条消息会先落默认主会话——后台正在建那条会话，
第二条就对了。

---

## 出问题

| 现象 | 先查 |
| --- | --- |
| 面板打不开 | `journalctl -u dsh-loop -n 100`；`$DSH_HOME/state/superagent/diagnostics/activation.log` |
| Hub 起不来 | 端口被占（日志里有一行 `could not start its device hub on port …`）。换端口或关掉 `hubPort`，面板仍可用 |
| 设备连上又立刻断 | token 不对，或协议版本不同。Hub 会先发一帧 `error` 说明原因，设备侧日志里有那一行 |
| 工单一直 `blocked` | 设备离线超过 `hubIdleMs`。**不会自动重派**：确认设备确实没在跑，再人工重试 |
| 旧实例受影响 | 不该发生。两个实例的 `DSH_HOME` 不同；如果旧实例挂了，先确认新实例的 `DSH_HOME` 没写错 |
