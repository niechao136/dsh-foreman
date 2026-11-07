# Device Binding Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both sides of a foreman deployment get a configuration page: the hub can register a device and show its one-time token, and the device can pick an SSH key from `~/.ssh`, test the connection, and drive its own tunnel — so binding a machine needs no command line.

**Architecture:** The hub gains one management route that wraps the existing `Devices.add`. The device gains an `ssh` config block, a `Tunnel` class that owns one `ssh -N -L` child process with backoff, two loopback routes (list keys, test connection), and a client page that writes through DSH's existing `configForms`. The hub keeps listening on loopback only; the device dials out through a tunnel it starts itself.

**Tech Stack:** TypeScript, Cordis plugin API, schemastery config, zod, React 18 (client page), vitest, tsdown (two-build: node + cjs client bundle), `node:child_process` for ssh.

**Spec:** `docs/superpowers/specs/2026-11-07-device-binding-page-design.md`

## Global Constraints

- The hub listens on loopback only. No task may add a non-loopback listener or a config key that permits one.
- Password authentication is not supported. Every ssh invocation carries `-o BatchMode=yes`.
- Both routes on the device must be registered **before** `missingConfiguration`'s early return in `apply`.
- The device's `webServer` dependency must be optional (`ctx.inject(['webServer'], …)`), never in `inject`.
- Every new field on `NodeConfig` needs a default, so a hand-written `cordis.patch.yml` that lacks it stays valid.
- A private key's contents are never read, logged, or returned. Only its path, filename, and public-key comment leave the host.
- Tests run in WSL: `~/bin/sync-wsl [paths…]` for the hub, `~/bin/sync-node` for the device. Windows failures are environmental.
- Every new hub `src/` or `tests/` file must be added to `docs/007-architecture.md`, or the hub's
  `tests/docs.spec.ts` fails. The device repo has no such test, so its new files need no table row.
- Hub and device release together; the hub depends on `dsh-foreman-node` at an exact version.

## Review Focus

- **A key with a passphrase.** `BatchMode=yes` fails with `Permission denied (publickey)` — indistinguishable from a wrong key. The page must say the key needs a passphrase or an agent, not "connection failed".
- **`localPort` already bound.** `ExitOnForwardFailure=yes` makes ssh exit immediately; the user needs to read "port 8790 is in use", not "tunnel stopped".
- **A device with nothing configured yet.** The page must load and the two routes must answer, or a fresh install is unconfigurable — the exact failure 0.1.1 fixed.
- **`ssh.enabled: false` with a blank `url`.** `missingConfiguration` must still report the missing address, or the device dials nowhere and merely looks offline.
- **A duplicate device id.** The hub must refuse with a message naming the rotate action, not a 500.

---

### Task 1: Hub route to register a device

**Files:**
- Modify: `src/app/api.ts:60-62`
- Modify: `src/app/http.ts:71-76` (HttpHost), `src/app/http.ts:339-346` (routes)
- Modify: `src/app/runtime.ts` (add `addDevice`)
- Test: `tests/http.spec.ts`

**Interfaces:**
- Consumes: `Devices.add(input: DeviceInput): { device: DeviceRecord; token: string }`, whose `DeviceInput` is `{ id: string; name: string; labels?: string[]; roots: Root[] }`.
- Produces: `HttpHost.addDevice(input: DeviceInput): { id: string; token: string }`; API `'POST devices'` with body `{ id, name, labels?, roots }` and response `{ id: string; token: string }`.

- [ ] **Step 1: Write the failing test**

In `tests/http.spec.ts`, using the existing `serve(...)` helper:

```ts
it('registers a device and returns its token exactly once', async () => {
  const added: unknown[] = []
  const call = serve({ addDevice: (input: unknown) => { added.push(input); return { id: 'laptop', token: 'deadbeef' } } })
  const response = await call('POST', 'devices', { id: 'laptop', name: '笔记本',
    labels: ['intranet'], roots: [{ project: 'shop', path: 'F:\\dsh\\shop' }] })
  expect(response.status).toBe(200)
  expect(response.body).toEqual({ id: 'laptop', token: 'deadbeef' })
  expect(added).toEqual([{ id: 'laptop', name: '笔记本', labels: ['intranet'], roots: [{ project: 'shop', path: 'F:\\dsh\\shop' }] }])
})

it('refuses a device whose id is already registered, naming the rotate action', async () => {
  const call = serve({ addDevice: () => { throw new Error('a device with id laptop is already registered; rotate its token instead') } })
  const response = await call('POST', 'devices', { id: 'laptop', name: 'L', roots: [] })
  expect(response.status).toBe(400)
  expect(String(response.body.error)).toContain('rotate its token instead')
})

it('refuses a device registration with no id or no name', async () => {
  const call = serve({ addDevice: () => { throw new Error('unreachable: the body is rejected first') } })
  expect((await call('POST', 'devices', { name: 'L', roots: [] })).status).toBe(400)
  expect((await call('POST', 'devices', { id: 'laptop', roots: [] })).status).toBe(400)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/bin/sync-wsl tests/http.spec.ts`
Expected: FAIL — `Unknown operation` (404), because `'POST devices'` is not in the Api table.

- [ ] **Step 3: Add the API entry, the host method, the runtime method, and the route**

In `src/app/api.ts`, after `'GET devices'`:

```ts
  /** 登记一台新设备；令牌只在这里返回一次，库里只存哈希。 */
  'POST devices': { body: { id: string; name: string; labels?: string[]; roots: { project: string; path: string }[] };
    response: { id: string; token: string } }
```

In `src/app/http.ts`, on `HttpHost` beside `devices()`:

```ts
  /** Register a device and mint its token; the token is not stored in readable form anywhere. */
  addDevice(input: DeviceInput): { id: string; token: string }
```

Add `import type { DeviceInput, DeviceRecord } from '../foreman/devices.ts'` (extend the existing type import). In the routes table, before `'POST devices/:id/revoke'`:

```ts
    /** 登记一台新设备。令牌只在这一次响应里出现，刷新就没了。 */
    'POST devices': async input => {
      const body = z.object({ id: z.string().trim().min(1), name: z.string().trim().min(1),
        labels: z.array(z.string().trim().min(1)).optional(),
        roots: z.array(z.object({ project: z.string().trim().min(1), path: z.string().trim().min(1) })) }).parse(await input.body())
      // `Devices.add` throws a plain Error for a duplicate id, which `failure()` would turn into a 500;
      // a duplicate is the operator's mistake, so it is reported as a 400 with the message naming rotate.
      try { return runtime.addDevice(body) }
      catch (error) { throw new RouteError(400, error instanceof Error ? error.message : String(error)) }
    },
```

In `src/app/runtime.ts`, beside `revokeDevice`/`rotateDeviceToken`:

```ts
  /** 登记一台设备并铸一枚令牌；和 `scripts/add-device.mjs` 走同一个 `Devices.add`。 */
  addDevice(input: DeviceInput): { id: string; token: string } {
    const { device, token } = this.devices.add(input)
    return { id: device.id, token }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `~/bin/sync-wsl tests/http.spec.ts`
Expected: PASS — all three new cases plus the existing ones.

- [ ] **Step 5: Commit**

```bash
git add src/app/api.ts src/app/http.ts src/app/runtime.ts tests/http.spec.ts docs/007-architecture.md
git commit -m "feat: register a device from the management API"
```

---

### Task 2: Hub panel form for adding a device

**Files:**
- Modify: `src/client/devices.tsx`
- Modify: `src/client/locales.ts:508-527`
- Test: `tests/panel-devices.spec.tsx`

**Interfaces:**
- Consumes: `call('POST devices', { id, name, labels, roots })` returning `{ id, token }`.
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the failing test**

```tsx
it('adds a device and shows the token it can only be seen once', async () => {
  const page = renderDevices({ 'GET devices': () => ({ rows: [], totals: { devices: 0, online: 0, revoked: 0, running: 0 } }),
    'POST devices': () => ({ id: 'laptop', token: 'a'.repeat(64) }) })
  await page.fill('device-add-id', 'laptop')
  await page.fill('device-add-name', '公司笔记本')
  await page.click('device-add-submit')
  expect(await page.text()).toContain('a'.repeat(64))
  expect(page.calls()).toContainEqual(['POST devices', { id: 'laptop', name: '公司笔记本', labels: [], roots: [] }])
})

it('shows the hub refusal in place instead of a blank form', async () => {
  const page = renderDevices({ 'POST devices': () => { throw new Error('a device with id laptop is already registered; rotate its token instead') } })
  await page.fill('device-add-id', 'laptop')
  await page.fill('device-add-name', 'L')
  await page.click('device-add-submit')
  expect(await page.text()).toContain('rotate its token instead')
})

it('keeps one project row per declared root', async () => {
  const page = renderDevices({})
  await page.click('device-add-root')
  await page.fill('device-add-project-0', 'shop')
  await page.fill('device-add-path-0', 'F:\\dsh\\shop')
  await page.fill('device-add-id', 'laptop')
  await page.fill('device-add-name', 'L')
  await page.click('device-add-submit')
  expect(page.calls()).toContainEqual(['POST devices', { id: 'laptop', name: 'L', labels: [],
    roots: [{ project: 'shop', path: 'F:\\dsh\\shop' }] }])
```

Adapt `renderDevices` to the harness the file already uses; each `data-device-add-*` attribute is what the test selects by.

- [ ] **Step 2: Run test to verify it fails**

Run: `~/bin/sync-wsl tests/panel-devices.spec.tsx`
Expected: FAIL — no add form exists.

- [ ] **Step 3: Add the form and the token card**

In `src/client/devices.tsx`, above `Section`:

```tsx
const [draft, setDraft] = useState({ id: '', name: '', roots: [] as { project: string; path: string }[] })
const [minted, setMinted] = useState<{ id: string; token: string }>()
const [refusal, setRefusal] = useState<string>()
```

Render a `<Card title={t('devicesAdd')}>` holding: a text input per `id`/`name` (attributes `data-device-add-id`, `data-device-add-name`), one row per declared root with `data-device-add-project-{i}` / `data-device-add-path-{i}`, a `data-device-add-root` button appending an empty row, and a `data-device-add-submit` button. On submit:

```tsx
const add = async () => {
  setRefusal(undefined)
  try { setMinted(await call('POST devices', { ...draft, labels: [] })); await reload() }
  catch (error) { setRefusal(errorText(error)) }
}
```

The minted card reuses the existing `devicesRotated` / `devicesRotatedHint` wording plus a `data-device-token` element, and adds three labelled lines: the hub address (`ws://127.0.0.1:<hubPort>`, read from `GET state` if that view already carries it — otherwise the literal text `ws://127.0.0.1:8790` with the hint that the hub port is the `hubPort` setting), the device id, and the token.

Add locale keys `devicesAdd`, `devicesAddHint`, `devicesAddId`, `devicesAddName`, `devicesAddRoots`, `devicesAddRoot`, `devicesAddSubmit`, `devicesAddRefreshWarning` to both dictionaries in `src/client/locales.ts`. `devicesEmptyHint` changes from "run the registration command" to "add a device above; the token it shows is the only copy".

- [ ] **Step 4: Run test to verify it passes**

Run: `~/bin/sync-wsl tests/panel-devices.spec.tsx tests/panel-settings.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/client/devices.tsx src/client/locales.ts tests/panel-devices.spec.tsx
git commit -m "feat: add a device from the settings page"
```

---

### Task 3: Device config block for the tunnel

**Files:**
- Modify: `dsh-foreman-node/src/index.ts:26-76`
- Test: `dsh-foreman-node/tests/node.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `NodeConfig.ssh: SshConfig`, where `SshConfig` is `{ enabled: boolean; host: string; port: number; user: string; keyPath: string; remotePort: number; localPort: number }`; and `hubUrlOf(config: NodeConfig): string`, which returns `ws://127.0.0.1:<localPort>` when `ssh.enabled` and `config.url` otherwise.

- [ ] **Step 1: Write the failing test**

```ts
describe('the address the device dials', () => {
  it('derives the tunnel address from the local port when the tunnel is on', () => {
    expect(hubUrlOf(config({ url: 'wss://ignored.example', ssh: { enabled: true, localPort: 8790 } }))).toBe('ws://127.0.0.1:8790')
  })
  it('uses the configured address when the tunnel is off', () => {
    expect(hubUrlOf(config({ url: 'wss://foreman.example', ssh: { enabled: false } }))).toBe('wss://foreman.example')
  })
  it('reports a missing address only when the tunnel is off', () => {
    expect(missingConfiguration(config({ url: '', ssh: { enabled: false } }))).toContain('url')
    expect(missingConfiguration(config({ url: '', ssh: { enabled: true } }))).not.toContain('url')
  })
  it('still requires a host, a user and a key when the tunnel is on', () => {
    const missing = missingConfiguration(config({ url: '', ssh: { enabled: true, host: '', user: '', keyPath: '' } }))
    expect(missing).toContain('ssh.host'); expect(missing).toContain('ssh.user'); expect(missing).toContain('ssh.keyPath')
  })
})
```

`config(overrides)` is a local helper at the top of the describe returning a full `NodeConfig` built from the schema
defaults, with `overrides` deep-merged so a partial `ssh: { enabled: true, localPort: 8790 }` keeps the other ssh defaults.
Build it from `Config({})` rather than hand-writing the object, so a field added later cannot make the helper stale.

- [ ] **Step 2: Run test to verify it fails**

Run: `~/bin/sync-node tests/node.spec.ts`
Expected: FAIL — `hubUrlOf` is not exported; `ssh` is not an accepted key.

- [ ] **Step 3: Add `SshConfig`, the schema block, `hubUrlOf`, and the widened `missingConfiguration`**

```ts
export interface SshConfig {
  enabled: boolean
  host: string
  port: number
  user: string
  keyPath: string
  remotePort: number
  localPort: number
}
```

In `Config`, after `token`:

```ts
  ssh: s.object({
    enabled: s.boolean().default(false).description('Reach the hub through an SSH tunnel this device starts itself.'),
    host: s.string().default('').description('The hub machine, such as 203.0.113.10 or its ~/.ssh/config alias.'),
    port: s.natural().max(65535).default(22).description('The hub machine\\'s SSH port.'),
    user: s.string().default('').description('The SSH user on the hub machine.'),
    keyPath: s.string().default('').description('The private key this device authenticates with. The page lists these from ~/.ssh.'),
    remotePort: s.natural().max(65535).default(8790).description('The port the hub listens on, on the hub machine.'),
    localPort: s.natural().max(65535).default(8790).description('The local port the tunnel listens on; the device dials this.'),
  }).default({ enabled: false, host: '', port: 22, user: '', keyPath: '', remotePort: 8790, localPort: 8790 })
    .description('How to reach the hub when it is not directly reachable: a tunnel this device opens and keeps open.'),
```

`hubUrlOf`:

```ts
export function hubUrlOf(config: NodeConfig): string {
  return config.ssh.enabled ? `ws://127.0.0.1:${config.ssh.localPort}` : config.url
}
```

`missingConfiguration` gains, before the `missing.length === 0` check:

```ts
  if (config.ssh.enabled) {
    if (config.ssh.host.trim() === '') missing.push('ssh.host')
    if (config.ssh.user.trim() === '') missing.push('ssh.user')
    if (config.ssh.keyPath.trim() === '') missing.push('ssh.keyPath')
  } else if (config.url.trim() === '') missing.push('url')
```

Remove the unconditional `url` check and keep `deviceId`/`token` unconditional.

- [ ] **Step 4: Run test to verify it passes**

Run: `~/bin/sync-node tests/node.spec.ts`
Expected: PASS — 20 existing tests plus the four new ones.

- [ ] **Step 5: Commit**

```bash
cd /f/dsh/dsh-foreman-node
git add src/index.ts tests/node.spec.ts
git commit -m "feat: configure the hub tunnel on the device"
```

---

### Task 4: The tunnel process

**Files:**
- Create: `dsh-foreman-node/src/tunnel.ts`
- Create: `dsh-foreman-node/tests/tunnel.spec.ts`

**Interfaces:**
- Consumes: `SshConfig` from Task 3.
- Produces: `tunnelArgs(ssh: SshConfig): string[]`; `type TunnelState = 'idle' | 'connecting' | 'connected' | 'failed'`; `class Tunnel` with `constructor(input: TunnelInput)`, `state(): TunnelState`, `failure(): string | undefined`, `start(): void`, `stop(): void`.

- [ ] **Step 1: Write the failing test**

```ts
it('builds an ssh command that fails fast instead of pretending the forward worked', () => {
  expect(tunnelArgs({ enabled: true, host: 'h', port: 2222, user: 'u', keyPath: '/k', remotePort: 8790, localPort: 8791 }))
    .toEqual(['ssh', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
      '-p', '2222', '-i', '/k', '-L', '8791:127.0.0.1:8790', 'u@h'])
})

it('reaches connected only after the local port answers', async () => {
  const states: string[] = []
  const tunnel = new Tunnel({ ssh: sshOf(), spawn: fakeSpawn(), probe: async () => true, onState: state => states.push(state) })
  tunnel.start()
  await vi.waitFor(() => expect(tunnel.state()).toBe('connected'))
  expect(states).toEqual(['connecting', 'connected'])
})

it('reports the exit status and retries after a failure', async () => {
  const child = fakeSpawn({ exit: 255, stderr: 'Permission denied (publickey).' })
  const tunnel = new Tunnel({ ssh: sshOf(), spawn: () => child, probe: async () => false, log: () => {} })
  tunnel.start()
  await vi.waitFor(() => expect(tunnel.state()).toBe('failed'))
  expect(tunnel.failure()).toContain('Permission denied (publickey).')
})

it('says the key needs a passphrase rather than reprinting the ssh error', async () => {
  const child = fakeSpawn({ exit: 255, stderr: 'Permission denied (publickey).' })
  const tunnel = new Tunnel({ ssh: sshOf(), spawn: () => child, probe: async () => false })
  tunnel.start()
  await vi.waitFor(() => expect(tunnel.failure()).toContain('passphrase'))
})

it('names the occupied local port instead of reporting a bare failure', async () => {
  const child = fakeSpawn({ exit: 255, stderr: 'bind [127.0.0.1]:8790: Address already in use' })
  const tunnel = new Tunnel({ ssh: sshOf({ localPort: 8790 }), spawn: () => child, probe: async () => false })
  tunnel.start()
  await vi.waitFor(() => expect(tunnel.state()).toBe('failed'))
  expect(tunnel.failure()).toContain('8790')
  expect(tunnel.failure()).toContain('already in use')
})

it('stops the child instead of leaving it running', () => {
  const child = fakeSpawn()
  const tunnel = new Tunnel({ ssh: sshOf(), spawn: () => child, probe: async () => true })
  tunnel.start(); tunnel.stop()
  expect(child.killed).toBe(true)
})
```

`fakeSpawn({ exit, stderr })` returns `{ killed: false, kill: () => { killed = true }, on: (event, handler) => …, stderr: { on: … } }` and emits its exit on the next tick.

- [ ] **Step 2: Run test to verify it fails**

Run: `~/bin/sync-node tests/tunnel.spec.ts`
Expected: FAIL — `Cannot find module '../src/tunnel.ts'`.

- [ ] **Step 3: Implement `tunnelArgs` and `Tunnel`**

`src/tunnel.ts` holds exactly: the argument builder above; a `TunnelInput` of `{ ssh: SshConfig; spawn?: Spawn; probe?: (port: number) => Promise<boolean>; onState?: (state: TunnelState) => void; log?: (text: string) => void; reconnectMs?: number; maxReconnectMs?: number }`; a `Spawn` type returning `{ kill(): void; killed: boolean; on(event: 'exit', handler: (code: number | null) => void): void; stderr?: { on(event: 'data', handler: (chunk: Buffer) => void): void } }`.

The class keeps a state field, a last-failure string, a reconnect timer, and one child. `start()` sets `connecting`, spawns, then polls `probe(localPort)` every 200 ms up to 10 s; first success sets `connected` and calls `onState`. An `exit` with a non-null code sets `failed`, records the last 2 KB of stderr, schedules a retry with `reconnectMs` doubling to `maxReconnectMs` (1000 → 60000). `stop()` clears the timer, sends `SIGTERM` via `child.kill()`, sets `idle`.

Two messages are rewritten rather than reprinted, because the ssh text alone does not tell a person what to do:

- `failure()` containing `/Permission denied \(publickey/` becomes `the hub refused this key; if it has a passphrase, add it to ssh-agent or pick a key without one (ssh said: …)`.
- `failure()` containing `/Address already in use/` becomes `local port <localPort> is already in use; close whatever holds it, or set a different localPort (ssh said: …)`. The port comes from the config, not from parsing the ssh line.

Default `probe` opens a TCP socket to `127.0.0.1:<port>` with `node:net` and resolves whether it connected within 2 s; default `spawn` uses `node:child_process.spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })`.

- [ ] **Step 4: Run test to verify it passes**

Run: `~/bin/sync-node tests/tunnel.spec.ts`
Expected: PASS, five tests.

- [ ] **Step 5: Commit**

```bash
cd /f/dsh/dsh-foreman-node
git add src/tunnel.ts tests/tunnel.spec.ts
git commit -m "feat: keep an ssh tunnel open to the hub"
```

---

### Task 5: List SSH keys and test a connection

**Files:**
- Create: `dsh-foreman-node/src/keys.ts`
- Create: `dsh-foreman-node/src/routes.ts`
- Create: `dsh-foreman-node/tests/keys.spec.ts`
- Create: `dsh-foreman-node/tests/routes.spec.ts`

**Interfaces:**
- Consumes: `SshConfig` from Task 3.
- Produces: `interface SshKey { name: string; path: string; comment: string }`; `listKeys(directory: string): SshKey[]`; `registerNodeRoutes(ctx: Context, directory: string): () => void` serving `GET /foreman-node/api/keys` → `{ keys: SshKey[]; directory: string }` and `POST /foreman-node/api/test` (body `{ host, port, user, keyPath }`) → `{ ok: boolean; output: string }`.

- [ ] **Step 1: Write the failing tests**

`tests/keys.spec.ts`:

```ts
it('lists a key only when its public half sits beside it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keys-'))
  writeFileSync(join(dir, 'id_ed25519'), 'PRIVATE'); writeFileSync(join(dir, 'id_ed25519.pub'), 'ssh-ed25519 AAAA niech@desktop')
  writeFileSync(join(dir, 'id_orphan'), 'PRIVATE')
  writeFileSync(join(dir, 'known_hosts'), 'x')
  expect(listKeys(dir)).toEqual([{ name: 'id_ed25519', path: join(dir, 'id_ed25519'), comment: 'niech@desktop' }])
})

it('never returns the private half', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keys-'))
  writeFileSync(join(dir, 'id_ed25519'), 'SECRET-MATERIAL'); writeFileSync(join(dir, 'id_ed25519.pub'), 'ssh-ed25519 AAAA c')
  expect(JSON.stringify(listKeys(dir))).not.toContain('SECRET-MATERIAL')
})

it('returns an empty list for a directory that does not exist', () => {
  expect(listKeys('/definitely/not/here')).toEqual([])
})
```

`tests/routes.spec.ts` asserts the two endpoints: `GET keys` answers with the listed keys and the directory it read; `POST test` shells out once and maps a non-zero exit to `{ ok: false }` carrying the ssh output; and both answer 403 without the `x-orchestrator-request` header. Inject the runner (`(argv: string[]) => Promise<{ code: number; output: string }>`) so no test spawns ssh.

- [ ] **Step 2: Run tests to verify they fail**

Run: `~/bin/sync-node tests/keys.spec.ts tests/routes.spec.ts`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Implement both modules**

`keys.ts`: read `readdirSync(directory)`, keep names matching `/^id_/` that do not end `.pub` and whose `${name}.pub` exists, and take the comment as the third whitespace-separated field of that `.pub` (empty string when absent). A missing/unreadable directory returns `[]`. Never open the private file.

`routes.ts`: mirror the hub's guard — require `x-orchestrator-request: '1'` and a same-origin `origin` when present, else 403. Bind via `ctx.webServer.register({ kind: 'prefix', path: '/foreman-node', … })`. `POST test` runs `['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-p', String(port), '-i', keyPath, `${user}@${host}`, 'true']` with a 15 s timeout, and returns the combined output truncated to 2 KB. A nonzero exit is `{ ok: false, output }`, not a 500 — the page shows it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `~/bin/sync-node tests/keys.spec.ts tests/routes.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /f/dsh/dsh-foreman-node
git add src/keys.ts src/routes.ts tests/keys.spec.ts tests/routes.spec.ts
git commit -m "feat: list ssh keys and test a connection from the device"
```

---

### Task 6: Wire the tunnel and the routes into the device plugin

**Files:**
- Modify: `dsh-foreman-node/src/index.ts:92-114`
- Test: `dsh-foreman-node/tests/node.spec.ts`

**Interfaces:**
- Consumes: `Tunnel`/`tunnelArgs` (Task 4), `registerNodeRoutes`/`listKeys` (Task 5), `hubUrlOf` (Task 3).
- Produces: `apply` registers routes before the early return; the client dials `hubUrlOf(config)` only once the tunnel reports `connected`.

- [ ] **Step 1: Write the failing test**

```ts
it('registers its routes even when the device has nothing configured yet', async () => {
  const registered: string[] = []
  const ctx = hostFor({ webServer: { register: (route: { path: string }) => { registered.push(route.path); return () => {} } } })
  await apply(ctx, config({ url: '', deviceId: '', token: '' }))
  expect(registered).toContain('/foreman-node')
})

it('activates without a web server, because a headless device still takes work', async () => {
  const ctx = hostFor({}) // no webServer service at all
  await expect(apply(ctx, config({ url: 'ws://h', deviceId: 'd', token: 't' }))).resolves.toBeUndefined()
})

it('dials the tunnel address, not the configured one, when the tunnel is on', async () => {
  const dialled: string[] = []
  await apply(hostFor({ connect: url => { dialled.push(url); return fakeSocket() } }),
    config({ url: 'wss://ignored', deviceId: 'd', token: 't', ssh: { enabled: true, host: 'h', user: 'u', keyPath: '/k', localPort: 8790 } }))
  expect(dialled).toEqual(['ws://127.0.0.1:8790'])
})
```

The third test needs the tunnel to report `connected` before the client starts; inject the tunnel factory (`spawn`, `probe`) through `apply`'s surrounding seam or let the test drive the `Tunnel`'s `onState` directly.

- [ ] **Step 2: Run test to verify it fails**

Run: `~/bin/sync-node tests/node.spec.ts`
Expected: FAIL — routes are not registered, and the client dials `config.url` regardless.

- [ ] **Step 3: Restructure `apply`**

Order inside `apply`:

1. `ctx.inject(['webServer'], child => { child.effect(() => registerNodeRoutes(child, sshDirectory())) })` — before anything else, so the page works on an unconfigured device.
2. `const missing = missingConfiguration(config); if (missing !== undefined) { ctx.logger.info('%s', missing); return }`.
3. Build `jobs`. If `config.ssh.enabled`, construct a `Tunnel` and start it; `client.start()` from the tunnel's `connected` callback. Otherwise `client.start()` immediately.
4. `ctx.effect(() => () => { tunnel?.stop(); client.stop() })`.

`sshDirectory()` returns `join(homedir(), '.ssh')`. Pass `hubUrlOf(config)` as the client's `url`.

- [ ] **Step 4: Run test to verify it passes**

Run: `~/bin/sync-node tests/node.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /f/dsh/dsh-foreman-node
git add src/index.ts tests/node.spec.ts
git commit -m "feat: dial the hub through the device's own tunnel"
```

---

### Task 7: Device configuration page

**Files:**
- Create: `dsh-foreman-node/src/client/index.tsx`
- Modify: `dsh-foreman-node/tsdown.config.ts` (second build)
- Modify: `dsh-foreman-node/package.json` (`dsh.client`, `files`, exports)
- Create: `dsh-foreman-node/tests/panel.spec.tsx`

**Interfaces:**
- Consumes: `GET keys`, `POST test` (Task 5); `configForms` from the host.
- Produces: the `plugins.row.config` slot for `dsh-foreman-node#dsh-foreman-node`.

- [ ] **Step 1: Write the failing test**

```tsx
it('offers the keys it found and writes the chosen path into the draft', async () => {
  const page = renderNode({ keys: [{ name: 'id_ed25519', path: '/home/me/.ssh/id_ed25519', comment: 'me@laptop' }] })
  expect(page.options('ssh-key')).toEqual(['id_ed25519 · me@laptop'])
  await page.select('ssh-key', '/home/me/.ssh/id_ed25519')
  expect(page.value('ssh-keyPath')).toBe('/home/me/.ssh/id_ed25519')
})

it('says so when there is no usable key instead of showing an empty box', async () => {
  expect(await renderNode({ keys: [] }).text()).toContain('no usable key')
})

it('shows the test result in place, ok or not', async () => {
  const page = renderNode({ test: { ok: false, output: 'Permission denied (publickey).' } })
  await page.click('ssh-test')
  expect(await page.text()).toContain('Permission denied (publickey).')
})

it('greys out the hub address while the tunnel is on and shows the derived one', async () => {
  const page = renderNode({})
  page.check('ssh-enabled')
  expect(page.disabled('url')).toBe(true)
  expect(await page.text()).toContain('ws://127.0.0.1:8790')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `~/bin/sync-node tests/panel.spec.tsx`
Expected: FAIL — no client entry exists.

- [ ] **Step 3: Build the page and its two bundles**

Add to `tsdown.config.ts` a second config entry modelled on the hub's:

```ts
{ entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', dts: false, clean: false,
  deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
  outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({ id: "dsh-foreman-node", factory: (require) => {',
    footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' } }
```

In `package.json`, add `exports["./client"] = "./lib/client.js"`, add `"lib"` to `files` (already there), and add:

```json
"client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings"] }
```

under `dsh`. Add `react`/`react-dom`/`@types/react`/`@deepseek-ai/dsh-client-ui-settings` as devDependencies/peerDependencies at the versions the hub uses.

The page renders five labelled sections in the order the spec gives, writes through `form.mutate([{ op: 'set', path: ['ssh', 'keyPath'], value }], revision)` and falls back to read-only when `form` is absent, showing `t('nodeReadOnly')`.

- [ ] **Step 4: Run test to verify it passes**

Run: `~/bin/sync-node tests/panel.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /f/dsh/dsh-foreman-node
git add src/client/index.tsx tsdown.config.ts package.json tests/panel.spec.tsx
git commit -m "feat: a configuration page for the device"
```

---

### Task 8: Release and document

**Files:**
- Modify: `dsh-foreman-node/CHANGELOG.md`, `dsh-foreman-node/package.json` (0.2.0)
- Modify: `dsh-foreman/CHANGELOG.md`, `dsh-foreman/package.json` (0.2.0, dependency bump)
- Modify: `HANDOFF.md`, `docs/deploy-loop-instance.md`

**Interfaces:** none.

- [ ] **Step 1: Bump and describe**

Both packages go to `0.2.0`: the device gains a feature (a new config block and a page), the hub gains a route. The hub's dependency on `dsh-foreman-node` becomes `0.2.0` exactly.

- [ ] **Step 2: Update the runbooks**

`docs/deploy-loop-instance.md` loses the `ssh -L` step and gains: register the device on the hub page, copy the three values to the device page, pick the key, press test, press save. `HANDOFF.md` records the tunnel decision and the passphrase limitation.

- [ ] **Step 3: Verify the whole thing**

Run: `~/bin/sync-wsl` (hub, all tests) and `~/bin/sync-node` (device, all tests).
Expected: the hub's suite passes except the known load-sensitive `sources.spec.ts` flake, which passes alone; the device's suite passes entirely.

- [ ] **Step 4: Publish**

```bash
cd /f/dsh/dsh-foreman-node && npm publish --config.minimumReleaseAge=0
cd /f/dsh/dsh-foreman && npm publish --config.minimumReleaseAge=0
```

Then create both GitHub releases with their `.tgz` assets, as `v0.1.1` was.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md package.json HANDOFF.md docs/deploy-loop-instance.md
git commit -m "release: 0.2.0"
```
