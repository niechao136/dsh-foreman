# 2026-11-07 设备绑定配置页 — 设计

## 意图

今天绑定一台设备要动四样东西，全是命令行：服务器跑 `scripts/add-device.mjs` 拿 token、改服务器的
`cordis.patch.yml`、改笔记本的 `cordis.patch.yml`、再手动开一条 `ssh -L 8790:127.0.0.1:8790` 隧道。
最后一步最致命——插件连不上时表现为「离线」，而真正的原因是一条没人开的隧道。

目标是：**两台机器各自在自己的配置页里填完，点一下就连上**，全程不碰命令行。

## 目标 / 非目标

**目标**

- hub 的「设置 › 设备」能新增设备，并把 token 一次性展示成可直接粘贴的一块。
- 设备的 `dsh-foreman-node` 配置页能：填枢纽地址、**从 `~/.ssh` 列出的密钥里挑一把**、填 SSH 主机/用户/端口、
  列出本机项目路径、点「测试连接」、点「保存并连接」。
- 设备端自己拉起 `ssh -N -L` 隧道并自动重连；隧道断了重启，不表现为「离线」。
- 配置不全时页面仍然可用（这是 0.1.1 修的那个 bug 的延伸）。

**非目标**

- 不改 hub 只监听 `127.0.0.1` 这条安全约束。
- 不做密码登录（Windows 没有 `sshpass`，`BatchMode=yes` 是前提）。
- 不做「新增 loop session」——用户确认这部分现在就可以。
- 不引入 dsh-remote 依赖。

## 现状

| 位置 | 现状 |
| --- | --- |
| `dsh-foreman` 设备页 | 只能列出、吊销、换令牌。新增只能跑脚本。 |
| `scripts/add-device.mjs` | 幂等，写 `foreman-device:` 前缀的 kv 行，token 只打印一次 |
| `dsh-foreman-node` | **没有任何前端文件**：无 `dsh.client`、无 HTTP 路由、无 `lib/client.js` |
| `apply()` | 配置缺失时 `logger.info` 后 `return`——路由必须注册在这个 return 之前 |
| 隧道 | 完全在流程之外，靠人手开 |

## 方案

### 一、hub 侧：「设置 › 设备」加一个新增表单

新增路由 `POST /orchestrator/api/devices`，body `{ id, name, labels, roots }`，走 `Devices.add`，
返回**一次性 token**。页面在成功后就地展开一张卡片，把三个值排成可直接抄写的三行：

```
url: ws://127.0.0.1:8790     deviceId: laptop     token: 21c3e0…
```

不新增「配对」概念——token 本来就是设备侧配置的一个字段，卡片只是把它显示得能抄。

`roots` 的表单是 `project → path` 的重复行：服务器要知道这台设备能接哪些项目、以及**那台机器上**的路径，
因为 `prepareTicketWithForeman` 用它把工单的目录映射过去。手填路径不是命令行，可以接受。

### 二、设备侧：配置长这样

```ts
interface NodeConfig {
  url, deviceId, token, roots, heartbeatMs, reconnectMs   // 已有
  ssh: {
    enabled: boolean        // 关掉表示地址公网可达，不需要隧道
    host: string            // 例如 139.224.13.57
    port: number            // 默认 22
    user: string
    keyPath: string         // 从密钥列表里选出来的
    remotePort: number      // 枢纽在自己机器上的端口，默认 8790
    localPort: number       // 本机监听，默认 8790
  }
}
```

`ssh.enabled` 为真时，`url` **不被使用**：枢纽地址一律推导成 `ws://127.0.0.1:<localPort>`，页面把这个框
置灰并显示推导结果。为假时才用 `url` 直连。两种模式共用一个字段会让人以为隧道开着也连 `url`，
那恰好是你昨天踩的坑。存储层仍保留 `url`，切回直连时值还在。

`ssh` 这一块**必须有默认值**（`s.object({...}).default({...})` 或逐字段默认），否则已经手写过
`cordis.patch.yml` 的老配置缺这个键，schemastery 会判 invalid config——0.1.1 修的就是这个类别的 bug。

### 三、设备侧：Tunnel 监管

新文件 `src/tunnel.ts`，一个类，状态 `idle | connecting | connected | failed`：

```
ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3
    -p <port> -i <keyPath> -L <localPort>:127.0.0.1:<remotePort> <user>@<host>
```

- `ExitOnForwardFailure=yes` 让「端口被占」立刻退出而不是假装成功——这是最难诊断的一种失败。
- 就绪判定用 TCP 连 `127.0.0.1:<localPort>`，不信 stderr 的措辞。
- 退出非零 → `failed`，记录 stderr 最后几行，退避重连 1s→60s。
- `stop()` 发 SIGTERM，2 秒后 SIGKILL。

`apply()` 的顺序变成：注册路由 → 若配置齐则起 Tunnel → Tunnel 报 connected 才 `client.start()`。

### 四、设备侧：两个本机接口

**服务依赖必须是可选的。** hub 把 `webServer` 写在 `inject` 里——那是硬依赖，服务不在插件就不激活。
设备侧不能照抄：一台没跑 Web 界面的 DSH（headless、CLI）同样该能接单干活的活。所以用

```ts
ctx.inject(['webServer'], child => { child.effect(() => registerRoutes(child)) })
```

服务在就注册路由、页面可用；不在就只是没有配置页，设备照常连枢纽。这一条是定稿前自查发现的，
原来的写法会让 headless 设备整个插件不启动。


都有前缀 `/foreman-node/api/`，同源校验照抄 hub 的 `sameOrigin`（复用 `x-orchestrator-request` 头这个约定）：

- `GET keys` — 读 `~/.ssh/`，列出形如 `id_*` 且**对应 `.pub` 存在**的文件，返回 `{ name, path, comment }`。
  只给路径和公钥注释，**绝不返回私钥内容**。
- `POST test` — 用表单里的值跑一次 `ssh -o BatchMode=yes -o ConnectTimeout=8 <user>@<host> true`，
  返回 `{ ok, output }`。不建隧道，只验证认证能不能过。

两个路由都在 `missingConfiguration` 的 early return **之前**注册——否则配置不全时打不开配置页，
0.1.1 修好的死结会以另一种形式回来。

### 五、设备侧：配置页

新增 `src/client/index.tsx`，加 `dsh.client` 与第二段 tsdown 配置（照抄 hub 的 cjs 包装）。
挂 `plugins.row.config`，key `dsh-foreman-node#dsh-foreman-node`。

页面结构：

1. **密钥** — 下拉框，选项来自 `GET keys`，显示 `id_ed25519 · niech@desktop-dsh`；选中即写 `ssh.keyPath`。
   没有密钥时给一句「`~/.ssh` 里没有可用密钥」并保留手填输入框。
2. **连接** — host / port / user / 两个端口 / 一个「测试连接」按钮，结果就地显示。
3. **枢纽** — url / deviceId / token（token 用 password 输入框）。
4. **项目路径** — 重复的 `project -> path` 行。
5. **保存并连接** — `configForms.mutate` 写入后提示「需要重启生效」。

所有写入走 `configForms.mutate`，不新增保存路径。保存的落点仍是 profile 的 `cordis.patch.yml`，
和今天手写的那份完全等价。

`configForms` 在宿主里是可选服务（hub 的 `deployment.tsx` 已经按可空处理）。拿不到时页面退化成只读：
显示当前配置和两个测试按钮，但不写盘，并说明「这个宿主不提供配置写入，请手工编辑配置」。


## 已定的取舍

| 取舍 | 决定 | 理由 |
| --- | --- | --- |
| 隧道由谁拉起 | 设备端插件 | hub 零改动，安全边界不动 |
| 密钥怎么选 | 列出 `~/.ssh` 让人挑 | 用户明确要求；由设备进程读盘，浏览器做不到 |
| 密码登录 | 不支持 | Windows 无 `sshpass`；`BatchMode=yes` 是自动重连的前提 |
| 带口令的私钥 | 走 Windows OpenSSH Agent | 自动化里没法交互输入口令 |
| 页面形态 | 全自定义页 | 「列出密钥挑选」自动表单做不到 |
| 保存通道 | 复用 `configForms.mutate` | 不发明第二套配置写入 |

## 工作量

| 部分 | 文件 | 规模 |
| --- | --- | --- |
| hub 新增设备路由 + 视图 | `src/app/http.ts`、`src/app/api.ts`、`src/app/views/devices.ts` | 小 |
| hub 设备页新增表单 | `src/client/devices.tsx`、`src/client/locales.ts` | 中 |
| 设备配置结构 | `dsh-foreman-node/src/index.ts` | 小 |
| 隧道监管 | 新 `src/tunnel.ts` + 测试 | 中 |
| 两个本机路由 | 新 `src/routes.ts` + 测试 | 中 |
| 设备配置页 | 新 `src/client/index.tsx` + tsdown 第二段 | 大 |
| 发布 | 两个包各一版，hub 依赖升到新的 node 版本 | 小 |

## 留给定稿的已知风险

- **带口令的私钥**：如果用户挑了一把有 passphrase 的钥匙，`BatchMode=yes` 会直接失败。页面必须把这条错误
  明说成「这把钥匙有口令，请改用 ssh-agent 或换一把无口令的钥匙」，而不是笼统的「连接失败」。
- **端口冲突**：`-L` 绑定失败时 `ExitOnForwardFailure` 让 ssh 立刻退出，页面报「本地端口 8790 已被占用」。
- **重启语义**：`ssh.*` 改动是否要重启 DSH，取决于 schemastery 的 volatile 标记。计划把它们标成 volatile，
  由保存后重开隧道生效；`url/deviceId/token` 保持非 volatile（重连才换身份）。
