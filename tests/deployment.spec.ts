import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, FEISHU_CLI_FALLBACKS, GITHUB_CLI_FALLBACKS, diagnoseClis, executable, findExecutables, machineOf, resolveDeployment, resolveFeishuBot, type Machine, type Probe } from '../src/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let path: string
const program = (file: string, body = ''): string => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push = true): string => program(file, `case "$*" in\n  "api user") echo '{"login":"${login}","id":7}' ;;\n  "api repos/acme/"*" --jq {name: .full_name, push: .permissions.push}") echo '{"name":"acme/widgets","push":${push}}' ;;\n  *) exit 1 ;;\nesac`)
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  `case "$*" in\n  "auth status") echo '${JSON.stringify(status)}' ;;\n  "config strict-mode") echo 'strict-mode: ${mode} (source: profile)' ;;\n  "api GET /open-apis/bot/v3/info --as bot --format ndjson") echo '${JSON.stringify(bot)}' ;;\nesac`
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async (argv, env) => (await exec(argv[0]!, argv.slice(1), { env: { PATH: path, HOME: dir, ...env } })).stdout
/** Runs a node script the way a worker would: used where a shebang file cannot be spawned (Windows). */
const nodeProbe: Probe = async (argv, env) => (await exec(process.execPath, [argv[0]!, ...argv.slice(1)],
  { env: { PATH: path, HOME: dir, ...env } })).stdout
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}/`, join(dir, 'bin'), '/usr/bin', '/bin'].join(':')
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('defaults the state directory, then reads the editable fields through references', () => {
    // 默认值兜住「profile 的 patch 漏写 config」这种事故：插件仍能起，路径仍是 <dsh home>/state/superagent。
    expect(machineOf(Config({})).stateDir).toMatch(/[\\/]state[\\/]superagent$/)
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get(), hubIdleMs: read.hubIdleMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), workspace: '', sessionTitle: 'dsh-foreman orchestrator', hubPort: 0, hubIdleMs: 600000,
        promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('setup', () => {
  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { repositories: [{ repository: 'acme/widgets' }], cli: 'gh' }, probe, path)
    expect(deployment).toMatchObject({ repositories: ['acme/widgets'], github: { cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.github).toEqual({ cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect((await resolveDeployment(machine(), { repositories: [{ repository: 'acme/gadgets' }], cli: 'gh' }, probe, path)).repositories[0]).toBe('acme/widgets')
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), github, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    // 本地工作区模式：没配仓库时不去访问 GitHub，返回一个仓库与账号都为空的本地部署。
    expect(await resolveDeployment(machine(), { cli: 'gh' }, probe, path)).toMatchObject({ repositories: [], github: { cli: '', login: '', noreply: '' } })
    await needs('github', 'agentCliUnset', {}, { repositories: [{ repository }] })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repositories: [{ repository }], cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repositories: [{ repository }], cli: 'bin/gh' })
    await needs('github', 'agentCliSignedOut', {}, { repositories: [{ repository }], cli: program(join(dir, 'bin', 'gh-broken'), 'exit 1') })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repositories: [{ repository }], cli: gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false) })
    // Signed in, but the account cannot read the repository, or the CLI names no account.
    const unreadable = program(join(dir, 'bin', 'gh-outsider'),
      `case "$*" in\n  "api user") echo '{"login":"Agent-Bot","id":7}' ;;\n  *) echo 'HTTP 404' >&2; exit 1 ;;\nesac`)
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repositories: [{ repository }], cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repositories: [{ repository }], cli: program(join(dir, 'bin', 'gh-anonymous'), `echo '{}'`) })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: join(dir, 'bin', 'lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), 'echo "not configured" >&2; exit 1')
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
})

/**
 * 这一组直接覆盖上海服务器上那次误判：机器上装了 gh 与 lark-cli，面板却什么都看不出来。
 *
 * 两个来源都在没有仓库 / 没有 cli 名时提前返回，发现逻辑压根没跑；`diagnoseClis` 让“装了工具，但来源没设置”与
 * “这台机器没有工具”在面板上终于长得不一样。
 */
describe('CLI diagnosis', () => {
  // 用平台分隔符拼 PATH：仓库里既有的 `path` 夹具写死了 ':'，在 Windows 上整组用不了，新用例不该继承这个毛病。
  // 必须在 `it` 内部求值：`describe` 的函数体先于 `beforeEach` 运行，那时 `dir` 还没建。
  const cliPath = (): string => [join(dir, 'bin'), join(dir, 'state', 'worker-bin')].join(delimiter)
  it('reports where each CLI is, even when the Source would skip the check', () => {
    // 没有订阅仓库、也没有 cli 名：这正是服务器上的配置，此时 resolveDeployment 提前返回、根本不看 gh。
    expect(diagnoseClis(machine(), {}, {}, cliPath())).toEqual({
      github: { state: 'found', path: join(dir, 'bin', 'gh') },
      feishu: { state: 'unset' },
    })
    expect(diagnoseClis(machine(), undefined, undefined, cliPath()).github).toEqual({ state: 'found', path: join(dir, 'bin', 'gh') })
  })
  it('names the search failure instead of silently reporting nothing', () => {
    // PATH 里没有 gh 时如实说是“没找到”，而不是让面板显示空白，操作者以为设置被忽略。
    const empty = diagnoseClis(machine(), {}, {}, join(dir, 'widgets'))
    expect(empty.github.state).toBe('error')
    expect(empty.github.state === 'error' && empty.github.detail).toContain('no gh is an executable file')
    // 飞书留空是“没有机器人”这一正常状态，不能被报成一个错误。
    expect(empty.feishu).toEqual({ state: 'unset' })
  })
  it('honours a typed name strictly, so a wrong spelling is an error rather than a fallback', () => {
    expect(diagnoseClis(machine(), { repositories: [{ repository: 'acme/widgets' }], cli: 'gh' }, {}, cliPath()).github)
      .toEqual({ state: 'found', path: join(dir, 'bin', 'gh') })
    const wrong = diagnoseClis(machine(), { repositories: [{ repository: 'acme/widgets' }], cli: 'gh-typo' }, {}, cliPath())
    expect(wrong.github.state).toBe('error')
    expect(wrong.github.state === 'error' && wrong.github.detail).toContain('gh-typo is not an executable file')
    // cli 名留空时在 PATH 与常见目录里找：这正是“默认安装不用填路径”那个承诺。
    expect(diagnoseClis(machine(), { repositories: [{ repository: 'acme/widgets' }] }, {}, cliPath()).github)
      .toEqual({ state: 'found', path: join(dir, 'bin', 'gh') })
  })
  it('finds the Feishu CLI once the Source names one', () => {
    expect(diagnoseClis(machine(), {}, { cli: 'lark-cli' }, cliPath()).feishu).toEqual({ state: 'found', path: join(dir, 'bin', 'lark-cli') })
  })
  /**
   * The dropdown's data. A single answer was the bug: with `gh` installed in two places, or under both spellings, the
   * operator needs to see and choose, and a scan that reports one path hides the other.
   */
  it('lists every candidate of a CLI, in the order discovery would try them', () => {
    // A second directory with a `gh-cli` spelling: both are real candidates under the fallback list.
    mkdirSync(join(dir, 'extra'), { recursive: true })
    program(join(dir, 'extra', 'gh-cli'), 'exit 0')
    const path = [join(dir, 'bin'), join(dir, 'extra')].join(delimiter)
    const found = findExecutables('', path, join(dir, 'state', 'worker-bin'), GITHUB_CLI_FALLBACKS)
    expect(found).toEqual([join(dir, 'bin', 'gh'), join(dir, 'extra', 'gh-cli')])
    // A typed name searches only that spelling: a wrong name must not quietly list a different binary.
    expect(findExecutables('gh-cli', path, join(dir, 'state', 'worker-bin'), GITHUB_CLI_FALLBACKS))
      .toEqual([join(dir, 'extra', 'gh-cli')])
    expect(findExecutables('lark-cli', path, join(dir, 'state', 'worker-bin'), FEISHU_CLI_FALLBACKS))
      .toEqual([join(dir, 'bin', 'lark-cli')])
    // A name nothing provides lists nothing, rather than falling back to a different binary.
    expect(findExecutables('larksuite-cli', path, join(dir, 'state', 'worker-bin'), FEISHU_CLI_FALLBACKS)).toEqual([])
    // The worker shims are never candidates: they are the fail-closed stand-ins, not a CLI.
    expect(findExecutables('gh', join(dir, 'state', 'worker-bin'), join(dir, 'state', 'worker-bin'), GITHUB_CLI_FALLBACKS)).toEqual([])
  })
})

/**
 * The credential must reach the command that verifies it.
 *
 * Setup resolves the agent's account before the worker environment is written, so a `gh` invoked without the token
 * runs unsigned and reports "cannot read its account" for a token that is perfectly valid. A test that only checked
 * "the environment is applied afterwards" would pass while the check above it failed, so this asserts the probe itself
 * receives the value.
 */
it('presents the stored token to the very command that checks the account', async () => {
  // A gh that is signed in only when GH_TOKEN is present, which is how a token-only deployment behaves.
  // Written as node rather than a shebang script: on Windows a shebang file cannot be spawned, and the subject of this
  // test is the token's reach, not the launcher.
  const tokenGh = join(dir, 'bin', 'gh-token')
  writeFileSync(tokenGh, [
    '#!/usr/bin/env node',
    "const args = process.argv.slice(2).join(' ')",
    'if (!process.env.GH_TOKEN) { console.error("To get started with GitHub CLI, please run:  gh auth login"); process.exit(1) }',
    "if (args === 'api user') console.log(JSON.stringify({ login: 'Agent-Bot', id: 7 }))",
    "else if (args.startsWith('api repos/acme/')) console.log(JSON.stringify({ name: 'acme/widgets', push: true }))",
    'else process.exit(1)',
    '',
  ].join('\n'))
  chmodSync(tokenGh, 0o755)
  const config = { repositories: [{ repository: 'acme/widgets' }], cli: tokenGh }
  // Without the credential the very same CLI reports being signed out: this is the failure the operator saw.
  await expect(resolveDeployment(machine(), config, nodeProbe, path)).rejects.toEqual(setupError('github', 'agentCliSignedOut'))
  // With it, the account and its push access resolve.
  await expect(resolveDeployment(machine(), config, nodeProbe, path, { GH_TOKEN: 'ghp_test' })).resolves
    .toMatchObject({ repositories: ['acme/widgets'], github: { login: 'Agent-Bot' } })
})
