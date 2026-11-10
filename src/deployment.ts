/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { homedir } from 'node:os'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^(?:[\\/]|[A-Za-z]:[\\/])/).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-foreman entry. Volatile fields apply without a restart because dsh-foreman reads them on each use; changing `stateDir` remounts the plugin. */
/** stateDir 有默认值：profile 的 patch 里漏写 config 时插件仍能启动，不会整块报 invalid config 让面板显示「没有响应」。 */
const defaultStateDir = (): string => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'state', 'superagent')
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.')
    .default(defaultStateDir()),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
  workspace: s.string().pattern(/^(?:\/.*)?$/).default('')
    .description('The directory the main Session and its Executor Sessions work in. Empty means stateDir. Absolute path.'),
  sessionTitle: s.string().default('dsh-foreman orchestrator')
    .description('Title of the main Session, in the language the operator reads.'),
  // Not volatile: the listener is bound once at startup, so a new port needs a restart, which the loader performs.
  hubPort: s.natural().max(65535).default(0).description('Loopback port for device connections; 0 disables the hub, so every ticket runs here.'),
  hubIdleMs: s.natural().min(30_000).max(86_400_000).default(600_000)
    .description('How long a device may go unheard before its work is reported blocked, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  /** 主会话与执行器会话共用的工作目录；空字符串表示沿用 stateDir。 */
  workspace: string
  /** 主会话的标题，按操作者阅读的语言配置。 */
  sessionTitle: string
  /** 设备连进来的环回端口；0 表示不开 Hub，所有工单都在本机跑。 */
  hubPort: number
  /** 设备多久没心跳就报 blocked（毫秒）。 */
  hubIdleMs: Volatile<number>
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-foreman configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, workspace, sessionTitle, hubPort, hubIdleMs } = config
  return { stateDir, workspace, sessionTitle, hubPort, hubIdleMs, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

/** 一个要监听的仓库，写作 owner/name；面板里就是列表中的一行。 */
export const GithubRepositorySchema = z.object({
  repository: z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/name'),
}).strict()
/** 智能体的 GitHub 账号与要监听的仓库列表；列表为空表示本地工作区模式，不访问 GitHub。 */
export const GithubAccountsSchema = z.object({
  repositories: z.array(GithubRepositorySchema).default([]),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export interface Deployment extends Machine {
  /** 监听并推送的仓库，canonical 名字（owner/name）；空数组表示本地工作区模式。 */
  repositories: string[]
  github: { cli: string; login: string; noreply: string }
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

/**
 * The spellings the GitHub CLI is installed under, tried after the configured name.
 *
 * `gh` is the released name; `gh-cli` is what some package managers install. A deployment that needs another name
 * still types it, so this list only saves the common case.
 */
const GITHUB_CLI_FALLBACKS = ['gh', 'gh-cli'] as const
/** The spellings the Feishu bot CLI is installed under, tried after the configured name. */
const FEISHU_CLI_FALLBACKS = ['lark-cli', 'larksuite-cli'] as const

/**
 * Well-known places a CLI is installed when it is not on the PATH the hub runs with.
 *
 * The hub is often started by systemd or a container, whose PATH differs from the operator's shell — the reason a
 * working `gh` "could not be found". Only standard prefixes and the user's own bin directories are named.
 */
const knownDirectories = (name: string): string[] => {
  const home = homedir(), suffix = process.platform === 'win32' ? `${name}.exe` : name
  return [
    join(home, '.local', 'bin'), join(home, 'bin'), join(home, '.npm-global', 'bin'),
    join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links'),
    '/usr/local/bin', '/usr/bin', '/bin', '/opt/homebrew/bin', '/snap/bin',
  ].map(directory => join(directory, suffix))
}

/**
 * The executable a configured CLI name resolves to.
 *
 * An empty `name` used to be a setup error the operator fixed by typing an absolute path. It now means "find the
 * usual tool": `fallbacks` first, then the well-known install directories. A name that IS given is honoured strictly —
 * silently falling back to a different binary would sign the agent in as whichever account that one holds, which is
 * exactly the mistake this setting exists to prevent.
 *
 * @throws Error naming every spelling tried when nothing executable was found.
 */
export function discoverExecutable(name: string, path: string, exclude: string, fallbacks: readonly string[] = []): string {
  if (name !== '') return executable(name, path, exclude)
  const tried: string[] = []
  for (const candidate of [...fallbacks, ...fallbacks.flatMap(knownDirectories)]) {
    if (tried.includes(candidate)) continue
    tried.push(candidate)
    try { return executable(candidate, path, exclude) } catch { /* Keep looking. */ }
  }
  throw new Error(`no ${fallbacks[0] ?? 'command'} is an executable file: tried ${tried.join(', ')}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to every configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  // 同一个仓库可能被写进两行；按 owner/name 去重后再逐个检查。
  const wanted = [...new Set(accounts.repositories.map(row => row.repository))]
  // 本地工作区模式：没有配置 GitHub 仓库时，不访问 GitHub，工单直接在工作区目录里执行。
  // 这类部署照样要有 stateDir 与 worker 环境，所以仍返回一个 Deployment，只是仓库与账户为空。
  if (!wanted.length) return { ...machine, repositories: [], github: { cli: '', login: '', noreply: '' } }
  let cli: string
  // An empty `cli` was a setup error; it now means "find the agent's gh", so a default installation needs no path typed.
  try { cli = discoverExecutable(accounts.cli, path, workerBin(stateDir), GITHUB_CLI_FALLBACKS) }
  catch (error) { throw new SetupError(accounts.cli === '' ? 'agentCliUnset' : 'agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // 每个仓库单独检查：canonical 名字（仓库改名后仍能匹配通知）与推送权限，第一个失败的仓库就报告出来。
  const repositories: string[] = []
  for (const remote of wanted) {
    const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
      throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
    }))
    if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
    if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository: remote })
    repositories.push(access.name)
  }
  // 两个不同写法可能解析成同一个仓库；换回 canonical 名字后再去重一次。
  return { ...machine, repositories: [...new Set(repositories)], github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

/**
 * Why a Source does not use its CLI, as the settings page reports it.
 *
 * `found` is the binary this deployment would run. `error` means discovery ran and found nothing, so the operator
 * learns the search failed rather than seeing a blank setting. `unset` means there was nothing to look for, which is
 * the normal state of a Source that names no CLI at all.
 */
export type CliProbe = { state: 'unset' } | { state: 'found'; path: string } | { state: 'error'; detail: string }
/**
 * What discovery would do for a Source, without refusing setup when it finds nothing.
 *
 * @param name Configured CLI name; `''` means "find the usual one".
 * @param optional When true, an empty `name` is reported as `unset` instead of being searched for: the Feishu Source
 *   treats a blank CLI as "no bot", whereas the GitHub Source treats it as "find `gh`".
 */
const probeCli = (name: string, optional: boolean, path: string, exclude: string, fallbacks: readonly string[]): CliProbe => {
  if (optional && name === '') return { state: 'unset' }
  try { return { state: 'found', path: discoverExecutable(name, path, exclude, fallbacks) } }
  catch (error) { return { state: 'error', detail: reason(error) } }
}
/**
 * Report where each account CLI would be found, so the settings page can say "installed but not configured" instead
 * of showing nothing at all.
 *
 * 为什么单独一条：`resolveDeployment` 在没有仓库时提前返回、`resolveFeishuBot` 在没有 cli 名时提前返回，两条路径都
 * 不会调用发现逻辑——于是“机器上装了 gh 却仍不可用”和“根本没配”在面板上长得一模一样。这里只回答“能不能找到”，
 * 不改变任何 Source 的行为，也不因为没有仓库或没有 cli 名就拒绝启动。
 *
 * @param github GitHub Source config, as stored (may be undefined when the Source is absent).
 * @param feishu Feishu Source config, as stored (may be undefined when the Source is absent).
 */
export function diagnoseClis(machine: Machine, github: unknown, feishu: unknown, path = process.env.PATH ?? ''): { github: CliProbe; feishu: CliProbe } {
  const exclude = workerBin(machine.stateDir)
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const bot = FeishuBotSchema.parse(feishu ?? {})
  // 没有仓库时仍探测 gh：这样能区分“装了 gh 但没订阅仓库”和“这台机器没有 gh”。
  return { github: probeCli(accounts.cli, false, path, exclude, GITHUB_CLI_FALLBACKS),
    feishu: probeCli(bot.cli, true, path, exclude, FEISHU_CLI_FALLBACKS) }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  // No CLI named is no Feishu bot: a deployment without Feishu must not start one. A named CLI is discovered, so the
  // operator can type `lark-cli` alone and let the hub find where it lives.
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = discoverExecutable(name, path, workerBin(machine.stateDir), FEISHU_CLI_FALLBACKS) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}

/**
 * Account probes for Source settings cards, keyed by Source kind id: saving a `source:<id>` block runs the probe
 * registered here before the settings are stored.
 *
 * 扩展点：一个来源需要在保存卡片前验证 CLI 账号，就在这里登记一行；不登记等于保存时不做账号检查。
 */
export const ACCOUNT_PROBES: Record<string, (machine: Machine, config: unknown, probe: Probe) => Promise<unknown>> = {
  github: (machine, config, probe) => resolveDeployment(machine, config, probe),
  feishu: (machine, config, probe) => resolveFeishuBot(machine, config, probe),
}
