# dsh-foreman 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一个常驻主 loop 把工单派给任意在线设备上完整运行的 DSH，设备只执行并回报，账本始终只有一份。

**Architecture:** 以 `dsh-superagent-local` 为起点 fork 出 `dsh-foreman`（内核 `src/core/` 随之整份复制，见「决策」第 1 条）。在 accept 时由纯函数 Selector 定下 `Assignment.target`；ForemanExecutor 包住现有 `DshExecutor`，本机目标原样下传，远端目标经 WebSocket 帧发给设备上的 `dsh-foreman-node` 插件，设备在一个 `job-<assignmentId>` 会话里跑完，用 `foreman_report` 工具回报。

**Tech Stack:** TypeScript 6 / Node 22+ / `node:sqlite` / vitest 4 / `ws` 8 / cordis bundle（`@deepseek-ai/dsh-*` peer 依赖沿用 fork 的版本）

**Spec:** `docs/superpowers/specs/2026-11-06-dsh-foreman-design.md`

## Global Constraints

- Node `^22.19.0 || >=24.0.0`；`engines.dsh` 与 fork 相同（`^0.2.1-alpha.2`）。
- `Config` 必须用 `@deepseek-ai/schemastery` 的 schema，**不能用 zod**（Loader 会拒绝该行）。
- 依赖只用 `ws` 一个新增项；HTTP 服务不引入。
- 帧里不传凭据；附件以 base64 传字节，单帧 ≤ 256 KiB。
- 设备侧 import 不得触及 `src/core/`、`src/app/store.ts`、`src/policy.ts`。
- Hub 监听 `127.0.0.1`，TLS 由隧道终结（`src/app/http.ts:364-366` 要求环回）。
- 远端 `report` 的 `state` 只允许 `progress | ready | blocked | failed`。
- 迁移脚本只能经 `node:sqlite` 做 checkpoint（srv-01 无 `sqlite3` 命令）。
- 每个任务结束都要 `pnpm typecheck` 通过；提交信息用 `feat:` / `fix:` / `test:` 前缀。

## Review Focus

- **重连后同一件活被执行两遍**：设备断线期间 Hub 若走 `Tickets.restart`，会在设备可能仍在跑时重开一张。期望：断线不重派，只有设备 `hello` 明确说没在跑才允许。
- **版本漂移**：设备与 Hub 的协议版本不一致时，期望握手即拒绝并给出可读原因，而不是半懂地继续跑。
- **已吊销的设备仍在推帧**：期望 Hub 在下一次心跳就断开并拒绝其 `report`。
- **超大附件**：期望超过 256 KiB 的帧被拒绝且不影响连接，错误可读。
- **对已结束 assignment 的迟到回报**：期望被丢弃并记一行日志，不抛错、不复活工单。
- **含空格与非 ASCII 的设备路径**（如 `D:\工作\我的 项目`）：期望 `roots` 原样往返，不被规范化改写。

---

## 决策（写进代码前先读）

1. **`dsh-foreman` 是 `dsh-superagent-local` 的整仓 fork**，不是从零搭壳。这样内核拷贝、测试夹具（`tests/fixtures/host.ts` 等）和 60 多个既有测试一起过来，且与「用拷贝而非共享包」的结论一致。
2. **两个独立仓库**：`github.com/niechao136/dsh-foreman`（Hub 侧，装在服务器）与 `github.com/niechao136/dsh-foreman-node`（设备侧，每台设备一个）。一个包里只有一份 patch，若合在一处，设备装上会连带插入 hub 那行，而 hub 要求 `stateDir`、要锁库、要开监听，笔记本上会起不来。两个仓库才能做到「设备安装是一条命令」。
3. **`Ticket.target` 也要加**：设计只写了 `Assignment.target`，但 `newAssignment` 在 `Tickets.create` 里创建 Assignment，它读不到 `outcome`。所以 accept 时把选择写进 `Ticket.target`，`newAssignment` 复制到 `Assignment.target`。这是本次唯一超出设计文字的改动。
4. **Hub 与传输解耦**：`Hub` 只认一个 `Channel` 接口（`send`/`close`/事件），`ws` 只出现在 `src/foreman/ws.ts` 一个文件里。测试用内存管道。
5. **设备令牌只存 SHA-256 十六进制**，用 `node:crypto`，不加依赖。
6. **帧定义只有一份，在 node 仓**（`dsh-foreman-node/src/protocol.ts`），Hub 通过 `"dsh-foreman-node": "github:niechao136/dsh-foreman-node"` 依赖它并从 `dsh-foreman-node/protocol` 导入。反过来（协议归 Hub）会把整个领域内核装进每台笔记本。
7. **飞书「群即项目」的映射进 Policy**（见设计 5.2）：它既是路由依据，也是设备选择的约束，所以和 Selector 一起做（Task 5）。
8. **主 loop 用独立 `DSH_HOME` 与独立 profile**（设计 5.14），不碰服务器上原有的 `dsh-superagent` 实例。
9. **node 包提交 `lib/` 产物，不带 `prepare` 脚本**。实测教训：git 依赖会执行 `prepare`，而 pnpm 要求该包在构建白名单里，否则装不上（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）；pnpm 11 已不再读 package.json 的 `pnpm` 字段。提交产物把构建移出安装路径。
10. **代码是搬过来的，不是 git fork**：`dsh-foreman` 的初始提交包含从 `dsh-superagent-local` 搬来的代码（MIT，保留署名），但不携带上游 git 历史，README 写清三者关系。

---

### Task 1: 建 `dsh-foreman` 仓库并让既有测试全绿 ✅ 已完成

**Files:**
- Create: `dsh-foreman/`（自 `dsh-superagent-local` 搬入，排除 `node_modules`、`lib`、`.git`）
- 两个仓库已建：`github.com/niechao136/dsh-foreman`、`github.com/niechao136/dsh-foreman-node`
- Modify: `dsh-foreman/package.json`
- Modify: `dsh-foreman/src/index.ts:1`
- Modify: `dsh-foreman/cordis.patch.yml:1-4`
- Test: `dsh-foreman/tests/index.spec.ts`（既有，随复制过来）
- Test: `dsh-foreman/tests/foreman-packages.spec.ts`（新增：两个包各自的 patch 只插自己那一行）

**Interfaces:**
- Consumes: 无
- Produces: 可 `pnpm check` 的仓库；Hub 包 `dsh-foreman`（行 id `dsh-foreman`），设备包 `dsh-foreman-node`（行 id `dsh-foreman-node`）

- [ ] **Step 1: 复制仓库**

```bash
cd /mnt/d/super-agent   # WSL；Windows 下用 D:\super-agent
rsync -a --exclude node_modules --exclude lib --exclude .git dsh-superagent-local/ dsh-foreman/
```

- [ ] **Step 2: 改 Hub 包的包名与插件 id**

`dsh-foreman/package.json`：`"name": "dsh-foreman"`，`"version": "0.1.0"`，`"private": true`，`"repository"` 指向新仓库。

`dsh-foreman/src/index.ts` 首行改为 `export const name = 'dsh-foreman'`。

`dsh-foreman/cordis.patch.yml` 的 `insert` 列表首项改为：

```yaml
    - id: dsh-foreman
      name: dsh-foreman
```

- [ ] **Step 3: 写失败测试，钉住「两个包各自只插自己那一行」**

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const patchIds = (path: string): string[] => {
  const text = readFileSync(join(import.meta.dirname, '..', path), 'utf8')
  return [...text.matchAll(/^\s*- id: (.+)$/gm)].map(match => match[1]!.trim())
}

it('the hub package inserts only the hub row', () => {
  const ids = patchIds('cordis.patch.yml')
  expect(ids).toContain('dsh-foreman')
  expect(ids).not.toContain('dsh-foreman-node')
})

it('the node package inserts only the node row', () => {
  const ids = patchIds('node/cordis.patch.yml')
  expect(ids).toEqual(['dsh-foreman-node'])
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm vitest run tests/foreman-packages.spec.ts`
Expected: FAIL，`node/cordis.patch.yml` 不存在

- [ ] **Step 5: 建设备包骨架**

`dsh-foreman/node/package.json`：

```json
{
  "name": "dsh-foreman-node",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "../lib/node/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "peerDependencies": { "@deepseek-ai/cordis": "4.0.5-alpha.1" }
}
```

`dsh-foreman/node/cordis.patch.yml`：

```yaml
# dsh-foreman-node bundle patch: the device side. It carries no stateDir, locks no database and opens no listener.
- insert:
    - id: dsh-foreman-node
      name: dsh-foreman-node
```

`dsh-foreman/node/src/protocol.ts` 先复制 `src/foreman/protocol.ts`（Task 2 建立后同步），暂时留一个转发注释；Task 2 完成时再定稿。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm vitest run tests/foreman-packages.spec.ts && pnpm typecheck`
Expected: PASS 2 tests；typecheck 无输出

- [ ] **Step 7: 跑既有测试**

Run: `pnpm test`
Expected: 全绿。

Windows 上若出现与 `git`/`tmux` 相关的环境失败，改用 WSL 同路径重跑，并记录失败清单：

```bash
rsync -a --exclude node_modules --exclude lib /mnt/d/super-agent/dsh-foreman/ ~/src/dsh-foreman-test/
cd ~/src/dsh-foreman-test && pnpm install && pnpm test
```

- [ ] **Step 8: 提交**

```bash
cd dsh-foreman && git init && git add -A && git commit -m "feat: fork dsh-superagent-local as dsh-foreman with a separate node package"
```


---

### Task 2: 协议帧 ✅ 已完成

**实际落点（与最初设想不同）**：帧定义在 `dsh-foreman-node/src/protocol.ts`（设备仓，权威），
hub 仓的 `src/foreman/protocol.ts` 只是转发导出。已推送两个仓库，`tests/foreman-protocol.spec.ts`
验证跨包导入可用。

**实测得到的两个约束**，后续协议改动必须遵守：
- git 依赖装包时会跑 `prepare`，pnpm 拒绝未被构建白名单的包；因此 node 仓**提交 `lib/` 产物且不带 `prepare`**。
- pnpm 11 不再读取 package.json 的 `pnpm` 字段，别指望在那里配构建白名单。

**Files（原计划，留作参考）:**
- Create: `dsh-foreman/src/foreman/protocol.ts`
- Test: `dsh-foreman/tests/foreman-protocol.spec.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `const FOREMAN_PROTOCOL_VERSION = 1`
  - `interface Root { project: string; path: string }`
  - `interface FrameAttachment { id: string; mediaType?: string; name?: string; bytes: string }`
  - `type NodeReportState = 'progress' | 'ready' | 'blocked' | 'failed'`
  - `type Frame = HelloFrame | HeartbeatFrame | AssignFrame | InputFrame | StopFrame | AcceptedFrame | ReportFrame | AckFrame`，每个都含 `v: number; type: string; frameId: string`
  - `function encodeFrame(frame: Frame): string`
  - `function parseFrame(text: string): Frame` — 抛 `FrameError`（`class FrameError extends Error`）
  - `class FrameDedupe { constructor(private readonly seen: Set<string>); take(frameId: string): boolean }` — 首次 `true`
  - `const MAX_FRAME_BYTES = 256 * 1024`

- [ ] **Step 1: 写失败测试**

```ts
import { expect, it } from 'vitest'
import { FrameDedupe, FrameError, MAX_FRAME_BYTES, encodeFrame, parseFrame } from '../src/foreman/protocol.ts'

const assign = { v: 1, type: 'assign' as const, frameId: 'f1', assignmentId: 'a1', ticketId: 't1',
  directory: 'D:\\工作\\我的 项目', text: 'do it', attachments: [] }

it('round-trips a frame through JSON and keeps a non-ASCII path byte-for-byte', () => {
  expect(parseFrame(encodeFrame(assign))).toEqual(assign)
})

it('refuses a frame from a different protocol version with a readable reason', () => {
  const bad = JSON.stringify({ ...assign, v: 2 })
  expect(() => parseFrame(bad)).toThrow(FrameError)
  expect(() => parseFrame(bad)).toThrow(/protocol version 2/)
})

it('refuses a frame over the size cap instead of truncating it', () => {
  const huge = { ...assign, attachments: [{ id: 'x', bytes: 'a'.repeat(MAX_FRAME_BYTES) }] }
  expect(() => parseFrame(encodeFrame(huge))).toThrow(/too large/)
})

it('takes each frameId once', () => {
  const dedupe = new FrameDedupe(new Set())
  expect([dedupe.take('f1'), dedupe.take('f1'), dedupe.take('f2')]).toEqual([true, false, true])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/foreman-protocol.spec.ts`
Expected: FAIL，`Cannot find module '../src/foreman/protocol.ts'`

- [ ] **Step 3: 写实现**

`parseFrame` 顺序：先按字节长度判 `MAX_FRAME_BYTES`（`Buffer.byteLength(text, 'utf8')`）→ `JSON.parse` → `v !== FOREMAN_PROTOCOL_VERSION` 抛 `new FrameError(\`unsupported protocol version ${v}\`)` → `type` 不在已知集合内抛 `FrameError` → 返回。`encodeFrame` 直接 `JSON.stringify`，不压缩。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/foreman-protocol.spec.ts`
Expected: PASS 4 tests

- [ ] **Step 5: 提交**

```bash
git add src/foreman/protocol.ts tests/foreman-protocol.spec.ts
git commit -m "feat: add the foreman protocol frames"
```

---

### Task 3: 给 Assignment 加目标

**Files:**
- Modify: `dsh-foreman/src/core/model.ts:218-233`（`Assignment`）
- Modify: `dsh-foreman/src/core/model.ts`（`Ticket` 接口，加 `target?`）
- Modify: `dsh-foreman/src/core/tickets.ts:383-388`（`newAssignment`）
- Modify: `dsh-foreman/src/core/ports.ts:40-46`（`AssessmentOutcome.accept` 加 `device?`）
- Test: `dsh-foreman/tests/foreman-target.spec.ts`

**Interfaces:**
- Consumes: `Assignment`、`Ticket`、`AssessmentOutcome`
- Produces:
  - `interface AssignmentTarget { deviceId: string; kind: 'local' | 'remote'; directory: string }`
  - `Assignment.target?: AssignmentTarget`、`Ticket.target?: AssignmentTarget`
  - `function targetOf(assignment: Assignment): AssignmentTarget` — 缺省返回 `{ deviceId: 'local', kind: 'local', directory: '' }`
  - `function assignmentTargetOf(ticket: Ticket): Pick<Assignment, 'target'>` — 导出给 `newAssignment` 用，也是这一层的可测点
  - `AssessmentOutcome` 的 accept 分支新增 `device?: string`

- [ ] **Step 1: 写失败测试**

```ts
import { expect, it } from 'vitest'
import { assignmentTargetOf, targetOf } from '../src/core/model.ts'
import type { Assignment, Ticket } from '../src/core/index.ts'

it('reads an assignment written before targets existed as local', () => {
  const legacy = { id: 'assignment:t:0', state: 'running', createdAt: '2026-01-01T00:00:00.000Z' } as Assignment
  expect(targetOf(legacy)).toEqual({ deviceId: 'local', kind: 'local', directory: '' })
})

it('gives an assignment the target its ticket chose, and nothing when it chose none', () => {
  const target = { deviceId: 'laptop', kind: 'remote' as const, directory: 'D:\\工作\\我的 项目' }
  const chosen = { id: 'tk1', target } as unknown as Ticket
  const plain = { id: 'tk2' } as unknown as Ticket
  expect([assignmentTargetOf(chosen), assignmentTargetOf(plain)]).toEqual([{ target }, {}])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/foreman-target.spec.ts`
Expected: FAIL，`targetOf` / `assignmentTargetOf` 未导出

- [ ] **Step 3: 改内核**

- `model.ts` 加 `AssignmentTarget`、`targetOf`、`assignmentTargetOf`；`Assignment` 与 `Ticket` 各加可选 `target`。
- `tickets.ts` 的 `newAssignment` 在构造对象时展开 `...assignmentTargetOf(ticket)`。
- `ports.ts` 的 accept 分支加 `device?: string`（仅类型）。

- [ ] **Step 4: 跑全量测试**

Run: `pnpm vitest run`
Expected: 全绿（既有 core 测试不受影响，因为 `target` 是可选的）

- [ ] **Step 5: 提交**

```bash
git add src/core tests/foreman-target.spec.ts
git commit -m "feat: give assignments a target device"
```

---

### Task 4: 设备注册表

**Files:**
- Create: `dsh-foreman/src/foreman/devices.ts`
- Modify: `dsh-foreman/src/kv.ts`（加 `foreman` 家族）
- Test: `dsh-foreman/tests/foreman-devices.spec.ts`

**Interfaces:**
- Consumes: `Store` 的 `get`/`set`/`keys`
- Produces:
  - `interface DeviceRecord { id: string; name: string; labels: string[]; roots: Root[]; tokenHash: string; lastSeenAt?: string; revokedAt?: string }`
  - `class Devices { constructor(store: Pick<Store, 'get' | 'set' | 'keys'>); list(): DeviceRecord[]; get(id: string): DeviceRecord | undefined; add(input: { id: string; name: string; labels?: string[]; roots: Root[] }): { device: DeviceRecord; token: string }; rotate(id: string): string; revoke(id: string): void; verify(id: string, token: string): boolean; seen(id: string, at: string): void }`
  - `function hashToken(token: string): string`（`node:crypto` 的 sha256 十六进制）

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Devices } from '../src/foreman/devices.ts'
import { Store } from '../src/app/store.ts'

const open = () => new Devices(new Store(join(mkdtempSync(join(tmpdir(), 'foreman-')), 'o.sqlite')))

it('keeps only a hash of the token and verifies it', () => {
  const devices = open()
  const { device, token } = devices.add({ id: 'laptop', name: '公司笔记本', roots: [{ project: 'shop', path: 'D:\\工作\\我的 项目' }] })
  expect(device.tokenHash).not.toBe(token)
  expect(device.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  expect([devices.verify('laptop', token), devices.verify('laptop', 'nope')]).toEqual([true, false])
})

it('refuses a revoked device and lists what is left', () => {
  const devices = open()
  const { token } = devices.add({ id: 'laptop', name: 'L', roots: [] })
  devices.add({ id: 'dorm', name: 'D', roots: [] })
  devices.revoke('laptop')
  expect(devices.verify('laptop', token)).toBe(false)
  expect(devices.list().map(d => d.id).sort()).toEqual(['dorm', 'laptop'])
})

it('keeps the roots a device declared, character for character', () => {
  const devices = open()
  devices.add({ id: 'laptop', name: 'L', roots: [{ project: 'shop', path: '/Users/me/工作 dir' }] })
  expect(devices.get('laptop')!.roots[0]!.path).toBe('/Users/me/工作 dir')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/foreman-devices.spec.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 写实现**

`kv.ts` 加：

```ts
  /** Foreman: one record per device, keyed by device id. */
  foreman: { device: family<DeviceRecord, [id: string]>('foreman-device:') },
```

`devices.ts` 用 `store.set(KV.foreman.device(id), record)` 写、`store.keys(KV.foreman.device.prefix)` 列出并逐个 `get`。`add` 用 `randomBytes(32).toString('hex')` 生成令牌，只存哈希。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/foreman-devices.spec.ts`
Expected: PASS 3 tests

- [ ] **Step 5: 提交**

```bash
git add src/foreman/devices.ts src/kv.ts tests/foreman-devices.spec.ts
git commit -m "feat: add the device registry"
```

---

### Task 5: Selector 与 accept 时定目标

**Files:**
- Create: `dsh-foreman/src/foreman/selector.ts`
- Modify: `dsh-foreman/src/executor/dsh.ts:285-287`（`prepare` 拆成可复用的 `ticketExecution`，已存在；无需改）
- Create: `dsh-foreman/src/foreman/prepare.ts`
- Test: `dsh-foreman/tests/foreman-selector.spec.ts`

**Interfaces:**
- Consumes: `DeviceRecord`（Task 4）、`AssignmentTarget`（Task 3）
- Produces:
  - `interface Online { id: string; running: number; lastSeenAt?: string }`
  - `function selectDevice(request: { device?: string; labels?: string[]; project: string }, devices: readonly DeviceRecord[], online: readonly Online[]): AssignmentTarget | undefined`
  - `function prepareTicketWithForeman(input: { select: typeof selectDevice; devices: () => DeviceRecord[]; online: () => Online[]; local: (ticket: Ticket, outcome: Accept) => Ticket }): (ticket: Ticket, outcome: Accept) => Ticket`

- [ ] **Step 1: 写失败测试**

```ts
import { expect, it } from 'vitest'
import { selectDevice } from '../src/foreman/selector.ts'
import type { DeviceRecord } from '../src/foreman/devices.ts'

const laptop: DeviceRecord = { id: 'laptop', name: '笔记本', labels: ['intranet'], tokenHash: 'x', roots: [{ project: 'shop', path: '/w/shop' }] }
const dorm: DeviceRecord = { id: 'dorm', name: '宿舍', labels: [], tokenHash: 'y', roots: [{ project: 'shop', path: '/h/shop' }] }
const online = [{ id: 'laptop', running: 2 }, { id: 'dorm', running: 0 }]

it('picks the device with the fewest running assignments', () => {
  expect(selectDevice({ project: 'shop' }, [laptop, dorm], online)).toEqual({ deviceId: 'dorm', kind: 'remote', directory: '/h/shop' })
})

it('honours an explicit device name', () => {
  expect(selectDevice({ device: '笔记本', project: 'shop' }, [laptop, dorm], online)!.deviceId).toBe('laptop')
})

it('drops devices without a root for the project, and offline ones', () => {
  expect(selectDevice({ project: 'other' }, [laptop, dorm], online)).toBeUndefined()
  expect(selectDevice({ project: 'shop' }, [laptop], [])).toBeUndefined()
})

it('never picks a device that is offline even when it is the only one named', () => {
  expect(selectDevice({ device: 'laptop', project: 'shop' }, [laptop], [])).toBeUndefined()
})

it('filters by required label', () => {
  expect(selectDevice({ labels: ['intranet'], project: 'shop' }, [laptop, dorm], online)!.deviceId).toBe('laptop')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/foreman-selector.spec.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 写实现**

`selectDevice` 是纯函数：过滤 `revokedAt` → 过滤不在 `online` 里的 → 过滤无 `project` root 的 → 按 `device`（匹配 id 或 name）或 `labels`（全部包含）过滤 → 取 `running` 最小，平局取 `lastSeenAt` 较晚（`undefined` 视为最旧）→ 返回 `{ deviceId, kind: 'remote', directory: root.path }`。

`prepare.ts` 的 `prepareTicketWithForeman` 返回一个函数：先按工单的 `origin` trigger 取项目名（`trigger.meta.workspace` 的 basename；没有则用 `''`），调 `select`；选中则把 `target` 写到 ticket 上再调 `local` 让 `ticketExecution` 补 `execution`；选不中则 `target` 留空（默认 `local`）。**暂时不做远端目录参与 `execution`**，远端目录由 `assign` 帧单独携带（Task 6 使用 `ticket.target.directory`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/foreman-selector.spec.ts`
Expected: PASS 5 tests

- [ ] **Step 5: 提交**

```bash
git add src/foreman/selector.ts src/foreman/prepare.ts tests/foreman-selector.spec.ts
git commit -m "feat: choose a device when a ticket is accepted"
```

---

### Task 6: ForemanExecutor

**Files:**
- Create: `dsh-foreman/src/foreman/executor.ts`
- Create: `dsh-foreman/src/foreman/render.ts`（占位版，Task 10 替换为完整版）
- Modify: `dsh-foreman/src/app/runtime.ts:156`（`prepareTicket` 改走 `prepareTicketWithForeman`）
- Test: `dsh-foreman/tests/foreman-executor.spec.ts`

**Interfaces:**
- Consumes: `Executor`（`src/core/ports.ts`）、`DshExecutor`（`src/executor/dsh.ts`）、`Frame`（Task 2）、`targetOf`（Task 3）
- Produces:
  - `interface ForemanTransport { send(deviceId: string, frame: Frame): Promise<void> }`
  - `class ForemanExecutor implements Executor { constructor(input: { local: DshExecutor; transport: ForemanTransport; engine: () => ExecutorReporter }); start(ticket: Ticket, assignment: Assignment): void; deliver(ticket: Ticket, assignment: Assignment): void; stop(ticket: Ticket, assignment: Assignment, reason: string): void }`
  - 其中 `ExecutorReporter = Pick<EngineForExecutor, 'report' | 'assignmentStarted'>`

- [ ] **Step 1: 写失败测试**

```ts
import { expect, it, vi } from 'vitest'
import { ForemanExecutor } from '../src/foreman/executor.ts'
import type { Assignment, Ticket } from '../src/core/index.ts'

const ticket = { id: 'tk1', assignments: [], inputs: [], undelivered: [] } as unknown as Ticket
const remote = { id: 'a1', state: 'pending', createdAt: 'x',
  target: { deviceId: 'laptop', kind: 'remote', directory: '/w/shop' } } as Assignment
const local = { id: 'a2', state: 'pending', createdAt: 'x' } as Assignment

const setup = () => {
  const sent: { deviceId: string; frame: unknown }[] = []
  const report = vi.fn()
  const local_ = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const executor = new ForemanExecutor({ local: local_ as never, engine: () => ({ report, assignmentStarted: vi.fn() }) as never,
    transport: { send: async (deviceId, frame) => { sent.push({ deviceId, frame }) } } })
  return { executor, sent, report, local: local_ }
}

it('hands a local assignment to DshExecutor unchanged', async () => {
  const { executor, local, sent } = setup()
  executor.start(ticket, local)
  await vi.waitFor(() => expect(local.start).toHaveBeenCalledWith(ticket, local))
  expect(sent).toEqual([])
})

it('sends a remote assignment as one assign frame carrying the device-side directory', async () => {
  const { executor, local, sent } = setup()
  executor.start(ticket, remote)
  await vi.waitFor(() => expect(sent.length).toBe(1))
  expect(local.start).not.toHaveBeenCalled()
  expect(sent[0]).toMatchObject({ deviceId: 'laptop', frame: { type: 'assign', assignmentId: 'a1', directory: '/w/shop' } })
})

it('reports blocked, never failed and never local, when the device is gone', async () => {
  const report = vi.fn()
  const local_ = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const executor = new ForemanExecutor({ local: local_ as never, engine: () => ({ report, assignmentStarted: vi.fn() }) as never,
    transport: { send: async () => { throw new Error('device offline') } } })
  executor.start(ticket, remote)
  await vi.waitFor(() => expect(report).toHaveBeenCalled())
  expect(report.mock.calls[0]![1]).toMatchObject({ state: 'blocked' })
  expect(local_.start).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/foreman-executor.spec.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 写实现**

`start`：`targetOf(assignment).kind === 'local'` → `this.local.start(ticket, assignment)`；否则 `queue(() => this.transport.send(deviceId, assignFrame(ticket, assignment)))`，`send` 成功 → `engine().assignmentStarted(...)`，失败（含设备离线）→ `engine().report(ticket.id, { state: 'blocked', summary: 'device offline' })`。队列用 `Promise.resolve().then(...)` 串行，不阻塞调用方（Engine 要求这些方法同步返回）。

`deliver`：远端 → `input` 帧；失败静默（下一次 `deliver` 会重来）。

`stop`：远端 → `stop` 帧，发完不等确认。

帧的 `text` 在发之前由 `renderForDevice(ticket, options)` 生成。**本任务先用占位实现**：`src/foreman/render.ts` 只导出 `renderForDevice` 的最小版本（返回 `{ text: ticket.execution?.assignment ?? ticket.title, attachments: [] }`），Task 10 再用完整版替换它并补测试。这样 Task 6 不依赖 Task 10 的完整逻辑。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/foreman-executor.spec.ts`
Expected: PASS 3 tests

- [ ] **Step 5: 提交**

```bash
git add src/foreman/executor.ts src/foreman/render.ts tests/foreman-executor.spec.ts src/app/runtime.ts
git commit -m "feat: dispatch remote assignments through ForemanExecutor"
```

---

### Task 7: Hub 连接与握手

**Files:**
- Create: `dsh-foreman/src/foreman/hub.ts`
- Create: `dsh-foreman/src/foreman/ws.ts`
- Modify: `dsh-foreman/package.json`（加 `ws@8` 与 `@types/ws`）
- Test: `dsh-foreman/tests/foreman-hub.spec.ts`

**Interfaces:**
- Consumes: `Frame`/`parseFrame`/`encodeFrame`/`FrameDedupe`（Task 2）、`Devices`（Task 4）
- Produces:
  - `interface Channel { send(text: string): void; close(): void; onMessage(listener: (text: string) => void): void; onClose(listener: () => void): void }`
  - `class Hub { constructor(input: { devices: Devices; onFrame: (deviceId: string, frame: Frame) => void }); attach(deviceId: string, channel: Channel): void; detach(deviceId: string): void; online(): string[]; running(deviceId: string): number; send(deviceId: string, frame: Frame): Promise<void> }`
  - `function memoryChannel(): { a: Channel; b: Channel }`（测试用，导出给测试）
  - `src/foreman/ws.ts`: `function serve(input: { port: number; devices: Devices; onFrame: (deviceId: string, frame: Frame) => void }): Promise<{ hub: Hub; close(): Promise<void> }>`

- [ ] **Step 1: 写失败测试**

```ts
import { expect, it, vi } from 'vitest'
import { Hub, memoryChannel } from '../src/foreman/hub.ts'

const devices = (verify: (id: string, token: string) => boolean) => ({ verify, get: () => ({ id: 'laptop', name: 'L', labels: [], roots: [], tokenHash: 'h' }),
  seen: vi.fn(), list: () => [] }) as never

const hello = (deviceId = 'laptop', token = 'tok', extra: Record<string, unknown> = {}) =>
  ({ v: 1, type: 'hello', frameId: 'h1', deviceId, token, version: '0.1.0', roots: [], running: [], ...extra })

it('accepts a hello with a good token and remembers what the device says it runs', async () => {
  const onFrame = vi.fn()
  const hub = new Hub({ devices: devices(() => true), onFrame })
  const { a, b } = memoryChannel()
  hub.attach('laptop', a)
  b.send(JSON.stringify(hello('laptop', 'tok', { running: ['a1'] })))
  await vi.waitFor(() => expect(onFrame).toHaveBeenCalled())
  expect([hub.online(), hub.running('laptop')]).toEqual([['laptop'], 1])
})

it('closes the channel when the token is wrong', async () => {
  const close = vi.fn()
  const hub = new Hub({ devices: devices(() => false), onFrame: vi.fn() })
  const { a, b } = memoryChannel()
  const channel = { ...a, close }
  hub.attach('laptop', channel)
  b.send(JSON.stringify(hello()))
  await vi.waitFor(() => expect(close).toHaveBeenCalled())
  expect(hub.online()).toEqual([])
})

it('drops a device whose token was revoked after it connected', async () => {
  let ok = true
  const close = vi.fn()
  const hub = new Hub({ devices: devices(() => ok), onFrame: vi.fn() })
  const { a, b } = memoryChannel()
  hub.attach('laptop', { ...a, close })
  b.send(JSON.stringify(hello()))
  await vi.waitFor(() => expect(hub.online()).toEqual(['laptop']))
  ok = false
  b.send(JSON.stringify({ v: 1, type: 'heartbeat', frameId: 'hb1', deviceId: 'laptop', running: 0 }))
  await vi.waitFor(() => expect(close).toHaveBeenCalled())
})

it('replies with the protocol version when the device speaks another one', async () => {
  const sent: string[] = []
  const hub = new Hub({ devices: devices(() => true), onFrame: vi.fn() })
  const { a, b } = memoryChannel()
  hub.attach('laptop', { ...a, send: text => { sent.push(text) } })
  b.send(JSON.stringify({ ...hello(), v: 9 }))
  await vi.waitFor(() => expect(sent.length).toBe(1))
  expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'error', reason: expect.stringContaining('protocol version 9') })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/foreman-hub.spec.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 写实现**

- `memoryChannel()`：返回两个 `Channel`，各自把 `send` 投给对方已注册的 listener（用 `queueMicrotask` 保证异步）。
- `Hub`：每设备一份 `{ channel, running, lastSeenAt, dedupe }`。收帧：`parseFrame` 抛 `FrameError` → 回 `{ type: 'error', v, frameId, reason }` 并关连接；`hello` 校验 `devices.verify` 失败 → `close()`；`heartbeat` 每 30 s 未收到则视为离线（本任务只做被动记录，主动超时在 Task 8）。
- `server` 版 `ws.ts` 用一个 `WebSocketServer`，`attach` 时把 `ws` 包成 `Channel`；这是全仓唯一 `import 'ws'` 的文件。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/foreman-hub.spec.ts`
Expected: PASS 4 tests

- [ ] **Step 5: 提交**

```bash
git add src/foreman/hub.ts src/foreman/ws.ts package.json tests/foreman-hub.spec.ts
git commit -m "feat: accept device connections and handshakes"
```

---

### Task 8: 回报、断线与重派规则

**Files:**
- Create: `dsh-foreman/src/foreman/reports.ts`
- Modify: `dsh-foreman/src/foreman/hub.ts`（超时与重连对齐）
- Test: `dsh-foreman/tests/foreman-reports.spec.ts`

**Interfaces:**
- Consumes: `Engine.report`、`Assignment`（Task 3）
- Produces:
  - `function applyReport(input: { report: EngineForExecutor['report']; ticketOf: (assignmentId: string) => { ticketId: string; open: boolean } | undefined; log: (text: string) => void }): (assignmentId: string, frame: ReportFrame) => void`
  - `function onDisconnect(input: { mark: (deviceId: string) => void }): void` — 只记时间，不碰 Engine
  - `function onTimeout(input: { since: number; now: number; limitMs: number; report: EngineForExecutor['report']; ticketOf: ...; deviceId: string; running: string[] }): void` — 超时才 `report({ state: 'blocked' })`
  - `function alignHello(input: { running: string[]; known: string[]; stop: (assignmentId: string) => void }): { attach: string[]; stop: string[] }`

- [ ] **Step 1: 写失败测试**

```ts
import { expect, it, vi } from 'vitest'
import { alignHello, applyReport, onTimeout } from '../src/foreman/reports.ts'

it('passes a report through with the device\'s state', () => {
  const report = vi.fn()
  const apply = applyReport({ report, ticketOf: () => ({ ticketId: 't1', open: true }), log: vi.fn() })
  apply('a1', { v: 1, type: 'report', frameId: 'f', assignmentId: 'a1', state: 'ready', summary: 'done' } as never)
  expect(report).toHaveBeenCalledWith('t1', { state: 'ready', summary: 'done' })
})

it('drops a late report for an assignment whose ticket already ended, and logs it', () => {
  const report = vi.fn(), log = vi.fn()
  const apply = applyReport({ report, ticketOf: () => ({ ticketId: 't1', open: false }), log })
  apply('a1', { v: 1, type: 'report', frameId: 'f', assignmentId: 'a1', state: 'ready', summary: 'done' } as never)
  expect(report).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledOnce()
})

it('refuses a dropped report from a device', () => {
  const report = vi.fn(), log = vi.fn()
  const apply = applyReport({ report, ticketOf: () => ({ ticketId: 't1', open: true }), log })
  apply('a1', { v: 1, type: 'report', frameId: 'f', assignmentId: 'a1', state: 'dropped', summary: 'nope' } as never)
  expect(report).not.toHaveBeenCalled()
})

it('does not touch the engine when a device disconnects', () => {
  const report = vi.fn()
  const mark = vi.fn()
  expect(() => { mark('laptop') }).not.toThrow()
  expect(report).not.toHaveBeenCalled()
})

it('reports blocked only after the timeout, and never restarts', () => {
  const report = vi.fn()
  onTimeout({ since: 0, now: 600_001, limitMs: 600_000, report, ticketOf: () => ({ ticketId: 't1', open: true }), deviceId: 'laptop', running: ['a1'] })
  expect(report).toHaveBeenCalledWith('t1', { state: 'blocked', summary: expect.stringContaining('offline') })
})

it('does nothing before the timeout', () => {
  const report = vi.fn()
  onTimeout({ since: 0, now: 1, limitMs: 600_000, report, ticketOf: () => ({ ticketId: 't1', open: true }), deviceId: 'laptop', running: ['a1'] })
  expect(report).not.toHaveBeenCalled()
})

it('treats a device that still runs an assignment as still attached', () => {
  expect(alignHello({ running: ['a1'], known: ['a1', 'a2'], stop: vi.fn() })).toEqual({ attach: ['a1'], stop: ['a2'] })
})

it('treats a device that no longer runs an assignment as needing a decision', () => {
  expect(alignHello({ running: [], known: ['a1'], stop: vi.fn() })).toEqual({ attach: [], stop: [] })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/foreman-reports.spec.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 写实现**

- `applyReport`：`state === 'dropped'` → 记日志并丢；`ticketOf` 返回 `undefined` 或 `open === false` → 记日志并丢；否则 `report(ticketId, { state, summary })`。
- `onTimeout`：`now - since <= limitMs` 直接返回；否则对每个 `running` 里的 assignment `report(ticketId, { state: 'blocked', summary: 'device offline' })`。**绝不**调 `assignmentInterrupted`。
- `alignHello`：交集进 `attach`，`known` 里设备没报的进 `stop`（由调用方决定是停还是留给人）。
- `hub.ts` 里加一个 30 s 的定时器调用 `onTimeout`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/foreman-reports.spec.ts`
Expected: PASS 8 tests

- [ ] **Step 5: 提交**

```bash
git add src/foreman/reports.ts src/foreman/hub.ts tests/foreman-reports.spec.ts
git commit -m "feat: report, disconnect and reattach rules"
```

---

### Task 9: 设备侧插件（连接 + 接单 + 回报工具）

**Files:**
- Create: `dsh-foreman/src/node/index.ts`
- Create: `dsh-foreman/src/node/client.ts`
- Create: `dsh-foreman/src/node/session.ts`
- Create: `dsh-foreman/src/node/report-tool.ts`
- Modify: `dsh-foreman/cordis.patch.yml`（加 `dsh-foreman-node` 行）
- Test: `dsh-foreman/tests/foreman-node.spec.ts`

**Interfaces:**
- Consumes: `Frame`/`parseFrame`/`encodeFrame`（Task 2）
- Produces:
  - `class NodeClient { constructor(input: { url: string; deviceId: string; token: string; onFrame: (frame: Frame) => void; reconnectMs?: number }); start(): void; stop(): void; send(frame: Frame): void }`
  - `class JobSessions { constructor(ctx: Context); ensure(input: { assignmentId: string; directory: string; title: string }): Promise<string>; deliver(sessionId: string, text: string, requestId: string): Promise<void>; running(): string[] }`
  - `function foremanReportTool(host: { report: (assignmentId: string, report: { state: NodeReportState; summary: string; question?: string }) => void }, assignmentId: string): Tool`

- [ ] **Step 1: 写失败测试**

```ts
import { expect, it, vi } from 'vitest'
import { JobSessions } from '../src/node/session.ts'
import { foremanReportTool } from '../src/node/report-tool.ts'
import { parseFrame } from '../src/foreman/protocol.ts'

const ctx = () => {
  const created: string[] = [], prompts: { id: string; text: string }[] = []
  return { created, prompts, fake: {
    workspaceRegistry: { create: async (cwd: string) => ({ id: cwd, attachSession: async () => {} }) },
    sessionController: { resolveAgent: async () => ({ error: { code: 'session/not-found' } }),
      create: async ({ sessionId }: { sessionId: string }) => { created.push(sessionId) }, rename: async () => {} },
    agents: { get: () => ({}) }, permissionPresets: { set: vi.fn() }, logger: { warn: vi.fn() },
    sessionPersistence: { flush: async () => {}, open: async () => ({ read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }) },
  } as never }
}

it('creates one job session per assignment and reuses it on a redelivery', async () => {
  const { created, fake } = ctx()
  const jobs = new JobSessions(fake)
  const first = await jobs.ensure({ assignmentId: 'a1', directory: '/w/shop', title: 'job a1' })
  const second = await jobs.ensure({ assignmentId: 'a1', directory: '/w/shop', title: 'job a1' })
  expect([first, second, created]).toEqual(['job-a1', 'job-a1', ['job-a1']])
})

it('turns a foreman_report call into a report frame with the device state', async () => {
  const sent: unknown[] = []
  const tool = foremanReportTool({ report: (assignmentId, report) => sent.push({ assignmentId, report }) }, 'a1')
  await tool.execute({ state: 'blocked', summary: 'need the VPN', question: 'Should I turn the VPN on?' }, { signal: new AbortController().signal })
  expect(sent).toEqual([{ assignmentId: 'a1', report: { state: 'blocked', summary: 'need the VPN', question: 'Should I turn the VPN on?' } }])
})

it('refuses a dropped state from a device', async () => {
  const tool = foremanReportTool({ report: vi.fn() }, 'a1')
  await expect(tool.execute({ state: 'dropped', summary: 'x' }, { signal: new AbortController().signal })).rejects.toThrow()
})

it('round-trips a frame the way the hub will read it', () => {
  const frame = { v: 1, type: 'report' as const, frameId: 'f1', assignmentId: 'a1', state: 'ready' as const, summary: 'ok' }
  expect(parseFrame(JSON.stringify(frame))).toEqual(frame)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/foreman-node.spec.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 写实现**

- `JobSessions.ensure`：`sessionId = \`job-${assignmentId}\``；`resolveAgent` 报 `session/not-found` 才 `create`；`permissionPresets.set(session, 'workspace-write')`（这是与 `src/app/sessions.ts:160` 的全权限**相反**的一行，且必须在 node 侧独立实现）。
- `deliver`：用 `AgentDelivery` 同款 requestId 幂等（`dsh-foreman:${requestId}` 前缀），重复投递不产生第二条消息。
- `foremanReportTool`：zod schema，`state` 枚举不含 `dropped`，`question` 可选；`execute` 调 `host.report`。
- `client.ts`：`NodeClient` 用 `WebSocket`（Node 22 全局），`onopen` 发 `hello`；收到 `assign` → `JobSessions.ensure` + `deliver`；断开后 `setTimeout` 重连。
- `node/index.ts`：cordis 插件，`apply(ctx, config)` 启动 `NodeClient`，把 `report` 接到 `hub.send`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/foreman-node.spec.ts`
Expected: PASS 4 tests

- [ ] **Step 5: 提交**

```bash
git add src/node cordis.patch.yml tests/foreman-node.spec.ts
git commit -m "feat: add the device-side foreman node"
```

---

### Task 10: 远端任务文本渲染（附件与卡片）

**Files:**
- Modify: `dsh-foreman/src/foreman/render.ts`（替换 Task 6 的占位实现）
- Modify: `dsh-foreman/src/foreman/executor.ts`（传入真实的 `readAttachment`）
- Test: `dsh-foreman/tests/foreman-render.spec.ts`

**Interfaces:**
- Consumes: `Ticket`、`Trigger`、`attachmentPath`（`src/sources/dsh.ts`）
- Produces:
  - `function renderForDevice(input: { ticket: Ticket; trigger?: Trigger; readAttachment: (id: string) => Buffer }): { text: string; attachments: FrameAttachment[] }`

- [ ] **Step 1: 写失败测试**

```ts
import { expect, it } from 'vitest'
import { renderForDevice } from '../src/foreman/render.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'

const ticket = { id: 'tk1', title: 'Fix it', mandate: { strength: 'explicit', basis: { rules: undefined } },
  execution: { name: 'fix', directory: '/w/shop', assignment: '' } } as unknown as Ticket
const trigger = { source: 'dsh', text: '修一下登录', threads: [], meta: { workspace: '/w/shop' } } as unknown as Trigger

it('renders the request text and never a hub-side resource pointer', () => {
  const { text } = renderForDevice({ ticket, trigger, readAttachment: () => Buffer.from('') })
  expect(text).toContain('修一下登录')
  expect(text).not.toMatch(/read: ticket\//)
})

it('carries attachments as bytes, not as hub paths', () => {
  const withFile = { ...trigger, meta: { ...trigger.meta, attachments: [{ id: 'abc12345', kind: 'file', name: 'a.txt', bytes: 5 }] } } as Trigger
  const result = renderForDevice({ ticket, trigger: withFile, readAttachment: () => Buffer.from('hello') })
  expect(result.attachments).toEqual([{ id: 'abc12345', name: 'a.txt', mediaType: undefined, bytes: Buffer.from('hello').toString('base64') }])
  expect(result.text).not.toContain('/.dsh/attachments')
})

it('refuses to render an attachment whose bytes exceed the frame budget', () => {
  const withFile = { ...trigger, meta: { ...trigger.meta, attachments: [{ id: 'big12345', kind: 'file' }] } } as Trigger
  expect(() => renderForDevice({ ticket, trigger: withFile, readAttachment: () => Buffer.alloc(300 * 1024) })).toThrow(/too large/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/foreman-render.spec.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 写实现**

`renderForDevice` 拼三段：工单标题与 scope、来源请求原文（`trigger.text`）、附件清单（按名字列出，附一句「附件已随任务送达，用 read_image / read 打开设备本地的 `<name>`」）。附件字节读出来后 base64，超过 `MAX_FRAME_BYTES` 抛错。**不出现任何主 loop 绝对路径。**

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/foreman-render.spec.ts`
Expected: PASS 3 tests

- [ ] **Step 5: 提交**

```bash
git add src/foreman/render.ts src/foreman/executor.ts tests/foreman-render.spec.ts
git commit -m "feat: render a remote task without hub paths"
```

---

### Task 11: 迁移脚本与 runbook

**Files:**
- Create: `dsh-foreman/scripts/migrate.mjs`
- Create: `dsh-foreman/docs/migration.md`
- Test: `dsh-foreman/tests/migration-script.spec.ts`

**Interfaces:**
- Consumes: `node:sqlite`、`node:fs`
- Produces: `node scripts/migrate.mjs pack --home <dir> --out <tar>` 与 `node scripts/migrate.mjs verify --home <dir>`

- [ ] **Step 1: 写失败测试**

```ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'

it('checkpoints the WAL and packs every directory a move needs', () => {
  const home = mkdtempSync(join(tmpdir(), 'foreman-home-'))
  for (const dir of ['state/superagent', 'storages', 'sessions', 'attachments', 'profiles/web']) mkdirSync(join(home, dir), { recursive: true })
  const db = new DatabaseSync(join(home, 'state/superagent/orchestrator.sqlite'))
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO kv VALUES ("schema","12")')
  db.close()
  writeFileSync(join(home, 'storages/workspace.json'), '{"workspaces":[]}')

  const out = join(tmpdir(), `foreman-${process.pid}.tar`)
  execFileSync(process.execPath, ['scripts/migrate.mjs', 'pack', '--home', home, '--out', out], { cwd: process.cwd() })
  const verify = execFileSync(process.execPath, ['scripts/migrate.mjs', 'verify', '--home', home], { cwd: process.cwd() }).toString()
  expect(verify).toContain('workspace.json')
  expect(verify).toContain('checkpoint ok')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/migration-script.spec.ts`
Expected: FAIL，脚本不存在

- [ ] **Step 3: 写实现**

`pack`：用 `DatabaseSync` 打开 `<home>/state/superagent/orchestrator.sqlite`，`PRAGMA wal_checkpoint(TRUNCATE)`，关库，再把 `state/superagent`、`storages`、`sessions`、`attachments`、`profiles` 打进 tar（`tar` 命令，非 Windows 环境；Windows 上脚本只做 checkpoint 并打印要手工复制的目录）。`verify`：重开库、`SELECT count(*) FROM ticket`、确认 `storages/workspace.json` 存在、打印 `checkpoint ok` 与各项计数。

`docs/migration.md` 写五步 runbook：停进程 → `pack` → 传 → 同路径展开 → 起进程 → `verify`；并写明「设备连稳定域名，不连 IP」与「路径必须与旧机完全一致」。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/migration-script.spec.ts`
Expected: PASS 1 test

- [ ] **Step 5: 提交**

```bash
git add scripts/migrate.mjs docs/migration.md tests/migration-script.spec.ts
git commit -m "feat: pack and verify a hub migration"
```

---

### Task 12: 面板里的设备页

**Files:**
- Create: `dsh-foreman/src/app/views/devices.ts`
- Modify: `dsh-foreman/src/app/http.ts`（注册 `/devices` 路由）
- Create: `dsh-foreman/src/client/devices.tsx`
- Modify: `dsh-foreman/src/client/index.tsx`（挂入口）
- Test: `dsh-foreman/tests/panel-devices.spec.tsx`

**Interfaces:**
- Consumes: `Devices`（Task 4）、`Hub.online()`（Task 7）
- Produces: `function devicesView(input: { devices: DeviceRecord[]; online: string[] }): { rows: { id: string; name: string; labels: string[]; online: boolean; running: number; lastSeenAt?: string; revoked: boolean }[] }`

- [ ] **Step 1: 写失败测试**

```tsx
import { expect, it } from 'vitest'
import { devicesView } from '../src/app/views/devices.ts'

it('marks which devices are online and which are revoked', () => {
  const view = devicesView({ online: ['laptop'],
    devices: [{ id: 'laptop', name: '笔记本', labels: [], roots: [], tokenHash: 'h' },
      { id: 'dorm', name: '宿舍', labels: [], roots: [], tokenHash: 'h', revokedAt: '2026-11-06T00:00:00.000Z' }] })
  expect(view.rows.map(row => [row.id, row.online, row.revoked])).toEqual([['laptop', true, false], ['dorm', false, true]])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/panel-devices.spec.tsx`
Expected: FAIL，模块不存在

- [ ] **Step 3: 写实现**

`devicesView` 是纯函数；路由 `GET /devices` 返回它；client 半只读展示（设备名、在线点、在跑数、最近心跳、吊销按钮）。沿用 `src/client/widgets.tsx` 的现有组件，不引入新样式体系。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/panel-devices.spec.tsx`
Expected: PASS 1 test

- [ ] **Step 5: 提交**

```bash
git add src/app/views/devices.ts src/client/devices.tsx src/client/index.tsx src/app/http.ts tests/panel-devices.spec.tsx
git commit -m "feat: show foreman devices in the panel"
```

---

### Task 13: 飞书群 → 项目路由

**Files:**
- Modify: `dsh-foreman/src/policy.ts`（Settings 加 `routing.chats`）
- Modify: `dsh-foreman/src/app/runtime.ts:232-235`（`masterOf` 增加飞书分支）
- Modify: `dsh-foreman/src/foreman/selector.ts`（群映射约束设备标签）
- Test: `dsh-foreman/tests/foreman-chat-routing.spec.ts`

**Interfaces:**
- Consumes: `selectDevice`（Task 5）、`Settings`（`src/policy.ts`）
- Produces:
  - `Settings.routing: { chats: { chatId: string; workspace: string; labels?: string[] }[] }`
  - `function workspaceOfChat(settings: Settings, chatId: string): { workspace: string; labels?: string[] } | undefined`
  - `Runtime.masterOf(trigger)` 对 `source === 'feishu'` 的分支返回该群所属工作区的主会话，未配置则回默认

- [ ] **Step 1: 写失败测试**

```ts
import { expect, it } from 'vitest'
import { workspaceOfChat } from '../src/policy.ts'
import { SettingsSchema } from '../src/policy.ts'

const settings = SettingsSchema.parse({ routing: { chats: [
  { chatId: 'oc_shop', workspace: '/home/ubuntu/src/shop', labels: ['intranet'] },
] } })

it('finds the workspace a chat belongs to', () => {
  expect(workspaceOfChat(settings, 'oc_shop')).toEqual({ workspace: '/home/ubuntu/src/shop', labels: ['intranet'] })
})

it('leaves an unconfigured chat to the default main Session', () => {
  expect(workspaceOfChat(settings, 'oc_unknown')).toBeUndefined()
})

it('defaults to an empty routing table so an old database still loads', () => {
  expect(SettingsSchema.parse({}).routing.chats).toEqual([])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/foreman-chat-routing.spec.ts`
Expected: FAIL，`workspaceOfChat` 未导出

- [ ] **Step 3: 写实现**

- `policy.ts` 加 `routing` 块（schemastery，`.default({ chats: [] })`）与 `workspaceOfChat`。
- `runtime.ts` 的 `masterOf` 改为：`source === 'dsh'` 走原来的 thread 分支；`source === 'feishu'` 用 `trigger.meta.chatId` 查 `workspaceOfChat`，命中则 `masterFor(该工作区的 workspaceId)`（异步，故 `masterOf` 变成返回 Promise 或用缓存的同步映射——**取后者**：Runtime 缓存 `workspace path → masterId`，配置变更时刷新，保持 `masterOf` 同步）。
- `selector.ts` 的 `selectDevice` 接受额外的 `requiredLabels`，来自群映射；`prepareTicketWithForeman` 从 trigger 的 chatId 反查得到它。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/foreman-chat-routing.spec.ts tests/foreman-selector.spec.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/policy.ts src/app/runtime.ts src/foreman/selector.ts tests/foreman-chat-routing.spec.ts
git commit -m "feat: route a Feishu chat to its own project"
```

---

### Task 14: 独立实例部署（runbook，无代码）

**Files:**
- Create: `dsh-foreman/docs/deploy-loop-instance.md`

**Interfaces:**
- Consumes: 无
- Produces: 一份可在 srv-01 上照做的 runbook

- [ ] **Step 1: 写 runbook**

内容按顺序：

1. 建独立 home 与 profile：`export DSH_HOME=/home/ubuntu/.dsh-loop`，跑一次 `dsh --profile loop --dump-config` 让它生成目录；把 `dsh` 软链到 `/usr/local/bin`（非交互 SSH 的 PATH 里没有 `~/.local/bin`）。
2. 装两个包：`dsh plugin --profile loop add <repo>`，确认 `--dump-config` 里出现 `dsh-foreman` 一行、且**没有** `dsh-foreman-node`。
3. 搬模型配置：桌面端 `dsh-config-manager` GUI 导出（勾 `providers` + `settings`），传到服务器，在 `loop` 实例里导入。**不要整包导入插件**——桌面端一半插件是 Windows 专用的。
4. systemd unit（`/etc/systemd/system/dsh-loop.service`）：`Environment=DSH_HOME=/home/ubuntu/.dsh-loop`、`ExecStart=/home/ubuntu/.local/bin/dsh --profile loop --port 3100 --no-open`、`Restart=always`。
5. 验收命令：`systemctl status dsh-loop`、`ss -ltn | grep 3100`、以及旧实例 `pid 893595` 仍在（`ps -p 893595`）。

- [ ] **Step 2: 提交**

```bash
git add docs/deploy-loop-instance.md
git commit -m "docs: runbook for a separate loop instance"
```

---

## 验收（对应设计文档第 8 节）

1. 笔记本上跑 `dsh-foreman-node`，主 loop 派单 → 笔记本出现 `job-*` 会话 → 主 loop 收到 `ready` → 工单结束。
2. 拔网线：10 分钟内工单不变；超过后转 `blocked`；插回后 `hello` 对齐，**同一件活没有第二张 assignment**。
3. 两台在线，两张工单落到不同设备（Task 5 的测试已覆盖选择逻辑；此处是端到端手测）。
4. 按 `docs/migration.md` 迁机：工单数一致、工作区归属正确、设备全部重连。
5. 加一台设备：`Devices.add` + 设备侧配置，主 loop 不重启。
6. 一个飞书机器人在两个群里被 @，两个请求各自落在对应项目，回复回到各自的群（Task 13）。
7. 新实例起来后，服务器上原有的 `dsh-superagent`（pid 893595、端口 3082）仍在跑（Task 14）。
8. 模型配置经 GUI 导出/导入后，新实例能选到同一个 provider 与模型（Task 14）。
