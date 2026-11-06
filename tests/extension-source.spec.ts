/**
 * 扩展性证明：新增一个 Source 时，只写它自己的 kind 模块、在注册表里 register 一次，
 * 面板的四个面（来源状态、设置卡片、概览问题、setup 脏键判定）就都认它——core、视图、前端一行都不用改。
 *
 * 这个测试故意不 import 任何真实来源，只用下面这个只存在于测试里的 `fakeKind`。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import { Store } from '../src/app/store.ts'
import { setupChanged } from '../src/app/setup.ts'
import { overview } from '../src/app/views/overview.ts'
import { settingsView } from '../src/app/views/settings.ts'
import { sourcesStatus } from '../src/app/views/sources.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError, type ProblemSpec } from '../src/setup.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

/** 假来源自己的 setup 问题：place 就是它的 kind id，文案由它自己给，core 里没有这张表。 */
const FAKE_PROBLEM: ProblemSpec = {
  place: 'fake',
  message: 'The fake source has no token.',
  label: { zh: '假来源没有配置令牌' },
}

/** 只声明自己的配置、健康码、问题与脏键的 Source kind。 */
const fakeKind: SourceKind<{ token: string }> = {
  kind: 'fake',
  title: { zh: '假来源', en: 'Fake' },
  description: { zh: '测试用的来源', en: 'Test source' },
  schema: z.object({ token: z.string().trim().default('') }).strict(),
  fields: [{ key: 'token', label: { zh: '令牌', en: 'Token' }, type: 'text' }],
  health: ['fakeHealth'],
  healthCodes: {
    // 稳态：有意停在这里（本地模式这类），面板照实显示。
    localMode: { label: { zh: '本地模式', en: 'Local mode' }, mode: 'steady' },
    // 不写 mode：启用期间显示「启动中」，等这个码清掉。
    booting: { label: { zh: '正在等待', en: 'Waiting' } },
  },
  setupFields: ['token'],
}

let directory: string
let store: Store
let sources: SourceRegistry
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-foreman-extension-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
  store.saveSettings(SettingsSchema.parse({}))
  store.saveSettings(SettingsSchema.parse({}))
  sources = new SourceRegistry(() => store.settings())
  sources.register(fakeKind)
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
/** 视图层需要的宿主；测试里没有外链，链接一律给空。 */
const host = () => ({ store, sources, links: () => ({ url: '', label: { zh: '', en: '' } }) })

it('登记一次就出现在来源状态页，稳态与启动中的语义都取它自己的声明', () => {
  // 稳态码：状态和标签都照实显示。
  const steady = sourcesStatus(host(), { fakeHealth: { state: 'paused', detail: '', code: 'localMode' } }, {})
  expect(steady.map(row => [row.id, row.state, row.title])).toEqual([['fake', 'paused', { zh: '假来源', en: 'Fake' }]])
  expect(steady[0]!.health).toEqual([{
    name: 'fakeHealth', state: 'paused', detail: '', code: 'localMode', label: { zh: '本地模式', en: 'Local mode' },
  }])
  // 未声明为稳态的码：启用期间显示「启动中」，也不沿用原状态上的标签。
  const pending = sourcesStatus(host(), { fakeHealth: { state: 'paused', detail: '', code: 'booting' } }, {})
  expect(pending[0]!.health).toEqual([{ name: 'fakeHealth', state: 'starting', detail: '' }])
  expect(pending[0]!.state).toBe('starting')
})

it('它自己声明的问题挂在它自己的设置卡片上，概览标成「只停这一个来源」', () => {
  const problem = new SetupError('fakeTokenMissing', {}, FAKE_PROBLEM).problem
  // http 层给来源问题补 scope 与标题；前端只按 scope 选文案，不认识 'fake'。
  const view = overview(host(), {}, 'v', { running: 0, queued: 0 }, [{ ...problem, scope: 'source', title: fakeKind.title }])
  expect(view.problems).toContainEqual(expect.objectContaining({ kind: 'setup', place: 'fake', scope: 'source', title: fakeKind.title }))
  // 设置视图：卡片标题、restarts（脏键）与问题都来自 kind 自己的声明。
  const settings = settingsView(store, sources, {}, { sourceProblems: { fake: problem } }, directory)
  expect(settings.sources.find(row => row.id === 'fake')).toMatchObject({
    installed: true, restarts: ['token'], title: fakeKind.title, problem: { place: 'fake' },
  })
})

it('setup 脏键判定认它声明的 setupFields：改令牌要重跑 setup，改别的不用', () => {
  const before = store.settings()
  const config = (token: string) => ({ ...before.sources, fake: { enabled: true, config: { token } } })
  expect(setupChanged(before, { ...before, sources: config('') }, sources)).toBe(false)
  expect(setupChanged(before, { ...before, sources: config('new-token') }, sources)).toBe(true)
})
