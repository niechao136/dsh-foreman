import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { pageCredential, registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  let handler: Handler = async () => {}
  /** 500 打进服务日志的原文，用例用它确认细节没有回流到响应里。 */
  const logged: string[] = []
  // 500 的细节只写日志（响应里只留 id），所以假的 ctx 也要有一个能吞掉这些日志的 logger。
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } },
    logger: { error: (...args: unknown[]) => { logged.push(args.map(String).join(' ')) } } }
  // 默认让写操作过凭据这一关：单个用例要测拦人的时候再传自己的 hostAuth 覆盖它。
  registerHttp(ctx as never, { ready: Promise.resolve(), hostAuth: async () => true, ...runtime } as unknown as HttpHost)
  // 返回值既是请求函数，也带着这次运行写进服务日志的内容（用例用它检查细节没有回流到响应里）。
  const request = async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  return Object.assign(request, { logged })
}

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  // 500 只回一个可反查的 id：内部错误文本只进服务日志，不回到调用方。
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 }))
    .toEqual({ status: 500, body: { code: 'internal-error', id: expect.any(String) } })
  // 细节仍然留在服务日志里，只是不再回到调用方。
  expect(call.logged.join('\n')).toContain('disk full')
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } },
        // 指标条另走一次按 kind 的计数，桩返回空分布即可，路由只要求它存在。
        decisionCounts: () => ({}) } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  // summary 是这段时间按 kind 的分布（指标条用），桩返回空分布。
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200,
    body: { items: [], next_offset: null, summary: { total: 0, byKind: {} } } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('asks the host page whether a write carries a signed-in person', async () => {
  const routes = { sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } }
  const asked: string[] = []
  const denied = serve({ ...routes, hostAuth: async (req: { method?: string }) => { asked.push(req.method ?? ''); return false } })
  const post = () => denied('POST', 'threads/github%3A1/unsubscribe')
  expect(await post()).toEqual({ status: 403, body: { code: 'credential-required' } })
  // 读操作不看凭据：探针一旦失真，面板至少还能把状态显示出来。
  expect(await denied('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(asked).toEqual(['POST'])
  expect(await serve({ ...routes, hostAuth: async () => true })('POST', 'threads/github%3A1/unsubscribe')).toMatchObject({ status: 200 })
  // 宿主抛错按放行处理：拦人的开关坏了，不该顺手把管理 API 一起关掉。
  expect(await serve({ ...routes, hostAuth: async () => { throw new Error('probe down') } })('POST', 'threads/github%3A1/unsubscribe'))
    .toMatchObject({ status: 200 })
})

it('lets a write through when the host page cannot be asked at all', async () => {
  // 端口 1 上没有宿主：探针必然失败，这时要保持加固前的行为，而不是把面板锁在门外。
  expect(await pageCredential(1)({ headers: {} })).toBe(true)
  expect(await pageCredential(1)({ headers: { cookie: 'dsh=x' } })).toBe(true)
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

it('moves a foreign worker file aside and checks setup again', async () => {
  const calls: string[] = []
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-adopt-'))
  try {
    writeFileSync(join(stateDir, 'worker-gitconfig'), '[safe]\n\tdirectory = *\n')
    const request = serve({ machine: { stateDir }, checkSetup: () => { calls.push('check') } })
    const adopted = await request('POST', 'setup/adopt', { file: join(stateDir, 'worker-gitconfig') })
    expect(adopted.status).toBe(200)
    expect(adopted.body).toEqual({ restarting: true })
    expect(calls).toEqual(['check'])
    expect(readdirSync(stateDir).some(name => name.startsWith('worker-gitconfig.foreign-'))).toBe(true)
    const refused = await request('POST', 'setup/adopt', { file: '/etc/passwd' })
    expect(refused.status).toBe(400)
  } finally { rmSync(stateDir, { recursive: true, force: true }) }
})

it('registers a device and returns its token exactly once', async () => {
  const added: unknown[] = []
  const call = serve({ addDevice: (input: unknown) => { added.push(input); return { id: 'laptop', token: 'deadbeef' } } })
  const response = await call('POST', 'devices', { id: 'laptop', name: '笔记本',
    labels: ['intranet'], roots: [{ project: 'shop', path: 'F:\\\\dsh\\\\shop' }] })
  expect(response.status).toBe(200)
  expect(response.body).toEqual({ id: 'laptop', token: 'deadbeef' })
  expect(added).toEqual([{ id: 'laptop', name: '笔记本', labels: ['intranet'], roots: [{ project: 'shop', path: 'F:\\\\dsh\\\\shop' }] }])
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
