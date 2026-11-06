/**
 * Structured startup and configuration errors, each carrying the settings place that fixes it and the panel
 * label in both interface languages.
 *
 * 扩展点：`SetupPlace` 是开放字符串（`deployment` 或某个 Source 的 kind id）。新增 Source 不必改这里的
 * 联合类型；它可以用自己的 kind id 当 place，给 `SetupError` 传自己的 `ProblemSpec`，面板就能把这条问题
 * 连到那张设置卡片上，并按 kind 自带的中英文文案显示（见 docs/005-panel.md「新增一个 Source」）。
 */
import { fill } from './infra/text.ts'

/** Settings place that fixes a problem: `deployment`, or a Source kind id. */
export type SetupPlace = string
export const DEPLOYMENT_PLACE = 'deployment'
/**
 * Panel label of a problem in both interface languages.
 * `en` defaults to the English message template, so a spec usually only adds the Chinese text.
 */
export interface ProblemLabel { zh: string; en?: string }
/** Message template (`{name}` placeholders), the settings place that fixes it, and the panel label. */
export interface ProblemSpec { place: SetupPlace; message: string; label: ProblemLabel }
/**
 * Problems raised by core code: deployment probes, the worker environment, and git.
 *
 * 为什么 github/feishu 的账号问题留在这里：它们的探测代码在 `deployment.ts`（core），而 core 不能反向依赖
 * 某个 Source 模块。不带 CLI 探测的 Source 可以只在自己的模块里声明问题，不必往这张表里加东西。
 */
export const CORE_PROBLEMS = {
  foreignFile: { place: DEPLOYMENT_PLACE, message: '{file} was not written by dsh-foreman; move it, or choose another state directory.',
    label: { zh: '{file} 不是 dsh-foreman 写入的文件；移走它，或换一个状态目录。' } },
  gitTooOld: { place: DEPLOYMENT_PLACE, message: 'git does not read the github.com credential configuration dsh-foreman writes; dsh-foreman needs git 2.32 or later.',
    label: { zh: 'git 没有读取 dsh-foreman 为 github.com 写的凭据配置；需要 git 2.32 或更新版本。' } },
  environmentFailed: { place: DEPLOYMENT_PLACE, message: 'Preparing the agent environment failed.',
    label: { zh: '准备智能体的运行环境失败。' } },
  repositoryUnset: { place: 'github', message: 'The GitHub Source names no repository.',
    label: { zh: 'GitHub 来源没有设置监听的仓库。' } },
  agentCliUnset: { place: 'github', message: 'The agent GitHub CLI is not set.',
    label: { zh: '没有设置智能体的 GitHub CLI。' } },
  agentCliMissing: { place: 'github', message: 'The agent GitHub CLI was not found.',
    label: { zh: '找不到智能体的 GitHub CLI。' } },
  agentCliSignedOut: { place: 'github', message: 'The agent GitHub CLI cannot read its account.',
    label: { zh: '智能体的 GitHub CLI 读不到它的账号。' } },
  agentCliNoAccount: { place: 'github', message: 'The agent GitHub CLI did not report a GitHub account.',
    label: { zh: '智能体的 GitHub CLI 没有报告 GitHub 账号。' } },
  repositoryUnreadable: { place: 'github', message: '@{account} cannot read {repository}.',
    label: { zh: '@{account} 读不到 {repository}。' } },
  repositoryUnreported: { place: 'github', message: 'The agent GitHub CLI did not return {repository}.',
    label: { zh: '智能体的 GitHub CLI 没有返回 {repository}。' } },
  repositoryReadOnly: { place: 'github', message: '@{account} cannot push to {repository}.',
    label: { zh: '@{account} 没有 {repository} 的推送权限。' } },
  feishuCliFailed: { place: 'feishu', message: 'The bot lark-cli does not work.',
    label: { zh: '机器人的 lark-cli 不可用。' } },
  feishuNoApp: { place: 'feishu', message: 'auth status of the bot lark-cli did not report the app.',
    label: { zh: '机器人的 lark-cli 的 auth status 没有报告应用。' } },
  feishuBotNotReady: { place: 'feishu', message: 'The bot identity of app {app} is {status}; configure the app secret with lark-cli.',
    label: { zh: '应用 {app} 的机器人身份状态是 {status}；用 lark-cli 配置应用密钥。' } },
  feishuUserIdentity: { place: 'feishu', message: 'The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot, as docs/006-deployment.md describes.',
    label: { zh: '机器人的 lark-cli 允许用户身份（strict mode 为 {mode}）；按 docs/006-deployment.md 给机器人一份 strict mode 为 bot 的单独配置。' } },
  feishuNoBot: { place: 'feishu', message: 'The Feishu bot API did not return the bot\'s open_id.',
    label: { zh: '飞书机器人接口没有返回机器人的 open_id。' } },
} as const satisfies Record<string, ProblemSpec>
export type CoreProblemCode = keyof typeof CORE_PROBLEMS
/** Any problem code: a core one, or one a Source kind raised with its own spec. */
export type SetupCode = CoreProblemCode | (string & {})
/** A raised setup problem as the panel receives it: where to fix it, its template values, and its bilingual label. */
export interface SetupProblem { place: SetupPlace; code: SetupCode; values: Record<string, string>; detail: string; label: Required<ProblemLabel> }

/** Spec used for a code raised without one; the kind id stays the place so the panel still links to its card. */
const fallback = (code: string): ProblemSpec => ({ place: code, message: code, label: { zh: code } })

/**
 * Thrown by deployment and account verification checks when a required CLI, account, or repository check fails.
 * `Setup` records it for the management overview, and the HTTP layer returns `problem` so the panel can localize it.
 *
 * @param spec Problem text and place. Omit it for a core code; a Source kind passes its own so its problems need
 *   neither a `CORE_PROBLEMS` entry nor a client locale key.
 */
export class SetupError extends Error {
  readonly place: SetupPlace
  constructor(readonly code: SetupCode, readonly values: Record<string, string> = {},
    readonly spec: ProblemSpec = CORE_PROBLEMS[code as CoreProblemCode] ?? fallback(code)) {
    const sentence = fill(spec.message, values)
    super(values.output ? `${sentence}\n${values.output}` : sentence)
    this.place = spec.place
  }
  get problem(): SetupProblem {
    return { place: this.place, code: this.code, values: this.values, detail: this.message,
      label: { zh: this.spec.label.zh, en: this.spec.label.en ?? this.spec.message } }
  }
}
