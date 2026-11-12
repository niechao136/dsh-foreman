/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { ACCOUNT_PROBES, FEISHU_CLI_FALLBACKS, GITHUB_CLI_FALLBACKS, findExecutables, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Key } from '../kv.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import { secretKey, unseal } from '../infra/secrets.ts'
import { SetupError, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  /** Saved settings, read for each Source's stored CLI credential. */
  readonly store: Pick<Store, 'get' | 'keys'>
  readonly sources: SourceRegistry
  restart(): void
}

/**
 * Serializes the setup-sensitive configuration of every installed Source (`SourceKind.setupFields`), so a change to
 * any of them re-runs setup.
 *
 * 扩展点：哪些字段算“要重跑 setup”由来源自己声明，这里不认识任何具体来源。
 */
const setupFields = (settings: Settings, sources: SourceRegistry) => JSON.stringify(sources.instances().filter(instance => instance.installed)
  .map(instance => [instance.id, (sources.kind(instance.kind)?.setupFields ?? []).map(key => settings.sources[instance.id]?.config[key] ?? '')]))
export const setupChanged = (before: Settings, after: Settings, sources: SourceRegistry): boolean =>
  setupFields(before, sources) !== setupFields(after, sources)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  /** Setup failure that stops all Sources. */
  problem?: SetupProblem
  /** Setup failures that pause one Source only, keyed by its setup place (the Source kind id). */
  problems: Record<string, SetupProblem> = {}
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  /**
   * The credentials resolved from storage, for the host's own CLI calls.
   *
   * `agentVariables()` deliberately blanks credential-shaped names so the operator's shell token never reaches the
   * agent; the resolved credentials are the one sanctioned source and must therefore be merged AFTER it. Keeping them
   * here rather than reading `process.env` matters because `applyEnvironment` writes to the whole process, and a
   * later `agentVariables()` spread would silently undo it — which is exactly how the host's GitHub polling ran
   * unsigned while the worker shims worked.
   */
  private credentialVariables: Record<string, string | undefined> = {}
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables, the resolved credentials, and the worker shim directory removed from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, ...this.credentialVariables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-foreman is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`problems` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing when setup and every Source are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && Object.keys(this.problems).length === 0) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /**
   * Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks.
   * 扩展点：探测函数按 Source kind id 在 `ACCOUNT_PROBES` 里登记，没有登记的来源保存卡片时不做额外检查。
   */
  async checkAccounts(block: SettingsBlock, settings: Settings, secret?: Record<string, string>): Promise<void> {
    const { machine } = this.host
    const id = block.slice('source:'.length)
    const probe = ACCOUNT_PROBES[id]
    if (!probe) return
    // The credential typed on this very card, merged over what is stored: a save that introduces a token must be
    // verified WITH that token, otherwise every first save is refused as "cannot read its account" and the operator
    // can never get a token in.
    const env = { ...this.credentials(), ...this.named(id, secret ?? {}) }
    await probe(machine, settings.sources[id]?.config, this.probe(), this.path, env).catch((error: unknown) => {
      if (!(error instanceof SetupError) || error.place === id) throw error
    })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined; this.credentialVariables = {} }
  /**
   * The environment variables carrying each Source's stored credential.
   *
   * The variable names come from the Source kind's `secret` declaration, so a new Source adds credentials without
   * touching this method. A credential that cannot be decrypted is skipped, not fatal: the CLI then simply fails its
   * own sign-in check and setup reports that, which names the real problem better than a crash here.
   */
  private credentials(): Record<string, string> {
    const { store } = this.host
    const values: Record<string, string> = {}
    // Enumerated from storage, not from the source registry: setup runs before the source plugins register their
    // kinds, so `sources.instances()` is empty here and a loop over it silently injected nothing — the exact reason
    // a valid token still produced agentCliSignedOut. Each record stores `VARIABLE=key` beside its value, so the
    // variable name needs no kind either.
    for (const name of store.keys(KV.sources.secret.prefix)) {
      const sealed = store.get(name as Key<string>)
      if (sealed === undefined) continue
      let record: Record<string, string>
      try { record = unseal(secretKey(this.host.machine.stateDir), sealed) }
      catch { continue /* A damaged row is reported by the CLI's own sign-in check. */ }
      const id = name.slice(KV.sources.secret.prefix.length)
      for (const [field, value] of Object.entries(record)) {
        const [variable, key] = field.includes('=') ? field.split('=', 2) : [undefined, field]
        // A bare key is a record written before the mapping existed. Once the source plugin has registered, its
        // declaration supplies the variable name, so an older stored token keeps working instead of silently
        // signing the CLI out; before registration there is nothing to ask and the value is skipped.
        const fallback = variable === undefined && key !== undefined ? this.variableOf(id, key) : undefined
        const target = variable ?? fallback
        if (target && value !== '') values[target] = value
      }
    }
    return values
  }


  /**
   * Named environment variables for a credential record that has not been stored yet.
   *
   * The card sends field keys; the variable name comes from the Source kind, which is registered by the time the panel
   * saves. An empty value means "unchanged", so it is skipped rather than blanking a stored secret.
   */
  private named(id: string, secret: Record<string, string>): Record<string, string> {
    const values: Record<string, string> = {}
    for (const [key, value] of Object.entries(secret)) {
      const variable = this.variableOf(id, key)
      if (variable && value !== '') values[variable] = value
    }
    return values
  }
  /** The environment variable a Source kind exposes one credential field under, when that kind is registered. */
  private variableOf(kind: string, key: string): string | undefined {
    const field = this.host.sources.kind(kind)?.fields.find(item => item.type === 'cli')
    return field && field.type === 'cli' ? field.secret?.fields.find(item => item.key === key)?.variable : undefined
  }
  /**
   * Every executable a Source's CLI setting could name, for the settings card's dropdown and its refresh button.
   *
   * Scanned on demand rather than remembered: after an operator installs the CLI, the previous single answer is
   * exactly what misleads, and a restart should not be the price of learning the truth.
   *
   * @param id Source kind id (`github` or `feishu`); an unknown id yields an empty list rather than an error.
   */
  cliCandidates(id: string): string[] {
    const fallbacks = id === 'github' ? GITHUB_CLI_FALLBACKS : id === 'feishu' ? FEISHU_CLI_FALLBACKS : undefined
    if (!fallbacks) return []
    try { return findExecutables('', this.path, workerBin(this.host.machine.stateDir), fallbacks) }
    catch { return [] /* Discovery is a listing; a scan failure must not break the settings page. */ }
  }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    // Resolved BEFORE the probes: the credential the operator just typed has to be presented by the very command that
    // verifies it, and the worker environment that would otherwise carry it is only written further down.
    const credentials = this.credentials()
    const deployment = await resolveDeployment(machine, settings.sources.github?.config, probe, this.path, credentials)
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe, this.path, credentials).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.problems[error.place] = error.problem
      context.logger.warn('dsh-foreman leaves the %s Source out: %s', error.place, error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    // Credentials are injected at the same point as the rest of the agent environment, so a worker and the host's own
    // CLI calls sign in as the same account, and neither one reads a token from the operator's shell.
    this.credentialVariables = credentials
    this.restoreEnvironment = applyEnvironment({ ...this.variables, ...credentials }, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
