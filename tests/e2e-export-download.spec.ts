// @vitest-environment node
/**
 * 端到端验证：真实 HTTP 服务上的下载入口，在端口转发场景下能不能通过鉴权。
 *
 * 前面的 `http.spec.ts` 直接调 `downloadOrigin` 测判定；这里把 `registerHttp` 挂到一个真的 `http.Server`
 * 上，用真的 socket 请求它，复现操作者遇到的两种情况：
 *
 *   1. 浏览器导航（`<a download>`）：没有 `x-orchestrator-request`，只有 `sec-fetch-site`；
 *   2. 端口转发：`Host` 是浏览器看到的端口，不是 hub 自己的 `webServer.port`。
 *
 * 改动前这两条都拿到 403 + `application/json`，浏览器按 MIME 存成 `export.json`。
 *
 * 注意：`canExport()` 在没有 `tar` 的平台（Windows）上是 false，那种机器**本来**就打不了包，会回 400。
 * 所以这里把「鉴权结果」和「能不能打包」分开断言：403 表示被拦下，非 403 表示已经放行到打包那一步。
 * 只有能打包的平台才校验压缩包字节。
 */
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { registerHttp } from '../src/app/http.ts'
import { canExport } from '../src/app/export.ts'

const home = mkdtempSync(join(tmpdir(), 'e2e-export-'))
const HUB_PORT = 3100
const FORWARDED_PORT = 8080
let server: ReturnType<typeof createServer>
let port = 0

beforeAll(async () => {
  // 一个真实的 webServer 会同时挂三条 prefix 路由（export / restore / 主表）；桩要按路径分别记住，
  // 只留最后一条会让 export 落到主表上、拿到 404。
  const registered: { path: string; handler: (req: never, res: never) => Promise<void> }[] = []
  const webServer = { host: '127.0.0.1', port: HUB_PORT,
    register: (route: { path: string; handler: never }) => {
      registered.push(route as never)
      return () => {}
    } }
  const ctx = { webServer, logger: { info: () => {}, error: () => {} } }
  const runtime = { machine: { stateDir: join(home, 'state'), home }, hostAuth: async () => true,
    links: () => [], sources: { instances: () => [] } }
  registerHttp(ctx as never, runtime as never)
  server = createServer((req, res) => {
    const url = req.url ?? '/'
    // 最长匹配优先，和宿主的路由行为一致。
    const hit = [...registered].sort((a, b) => b.path.length - a.path.length)
      .find(route => url === route.path || url.startsWith(`${route.path}/`) || url.startsWith(`${route.path}?`))
    if (!hit) { res.writeHead(404); res.end('{}'); return }
    void hit.handler(req as never, res as never)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => resolve()) })
  rmSync(home, { recursive: true, force: true })
})

/**
 * 用真的 socket 发一次请求，把响应头和字节数带回来。
 *
 * 必须走 `http.request` 而不是 `fetch`：`fetch`（undici）把 `Host` 当禁止头，会用自己的 URL 主机名覆盖，
 * 那就测不到「端口转发时 Host 与 hub 端口不同」这件事。
 */
function download(headers: Record<string, string>): Promise<{ status: number; type: string
  disposition: string | undefined; bytes: number; gzip: boolean }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/orchestrator/export', method: 'GET',
      headers, setHost: false }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk as Buffer))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''),
          disposition: res.headers['content-disposition'] as string | undefined, bytes: body.length,
          // gzip 的魔数：确认拿到的真的是压缩包，而不是一段 JSON。
          gzip: body[0] === 0x1f && body[1] === 0x8b })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

/** 打包这一步是否真的跑起来了：能打包的平台是 200，不能的（Windows）是 400。 */
const packable = canExport()

/**
 * 这条是操作者报的问题：经端口转发打开面板，点下载拿到 `export.json`。
 * 浏览器导航带不了标记头，Host 里的端口也不是 hub 自己监听的端口。
 */
it('lets a browser navigation on a forwarded port through to the packer', async () => {
  const got = await download({ host: `127.0.0.1:${FORWARDED_PORT}`, 'sec-fetch-site': 'same-origin' })
  expect(got.status, JSON.stringify(got)).toBe(packable ? 200 : 400)
  if (!packable) return
  expect(got.type).toContain('application/gzip')
  expect(got.disposition).toMatch(/attachment; filename="dsh-foreman-.*\.tar\.gz"/)
  expect(got.gzip).toBe(true)
})

it('lets an address-bar open through as well', async () => {
  const got = await download({ host: `127.0.0.1:${FORWARDED_PORT}`, 'sec-fetch-site': 'none' })
  expect(got.status, JSON.stringify(got)).toBe(packable ? 200 : 400)
  if (packable) expect(got.gzip).toBe(true)
})

it('still lets a scripted request with the marker header through', async () => {
  const got = await download({ host: `127.0.0.1:${FORWARDED_PORT}`, 'x-orchestrator-request': '1' })
  expect(got.status, JSON.stringify(got)).toBe(packable ? 200 : 400)
})

/** 放宽的只是「回环的任意端口」，跨站和非回环仍然拒绝——下载里含密钥与会话。 */
it('refuses a cross-site navigation and any non-loopback host', async () => {
  const crossSite = await download({ host: `127.0.0.1:${FORWARDED_PORT}`, 'sec-fetch-site': 'cross-site' })
  expect(crossSite.status).toBe(403)
  expect(crossSite.gzip).toBe(false)
  const remote = await download({ host: `10.0.0.5:${HUB_PORT}`, 'sec-fetch-site': 'same-origin' })
  expect(remote.status).toBe(403)
  // 回环地址但没有任何放行标记：也拒绝。
  expect((await download({ host: `127.0.0.1:${FORWARDED_PORT}` })).status).toBe(403)
})
