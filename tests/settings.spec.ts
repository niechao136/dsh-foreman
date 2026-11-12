/** Concurrency, retry, and validation tests for settings saves, pause toggling, and policy synchronization. */
import { afterEach, expect, it, vi } from 'vitest'
import { UserError } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { Setup } from '../src/app/setup.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { KV } from '../src/kv.ts'
import { seal, secretKey, unseal } from '../src/infra/secrets.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}
const model = { provider: 'worker-provider', model: 'worker-model' }

it('refuses a save of a block that another save changed during its model or account check, and saves nothing of it', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const llm = (h.ctx as unknown as { llm: { resolveCallConfig: ReturnType<typeof vi.fn> } }).llm
  const check = deferred<unknown>()
  llm.resolveCallConfig.mockImplementationOnce(() => check.promise)
  const executor = store.settings().executor
  const revision = store.blockRevision('executor')
  const slow = settings.save('executor', { ...executor, model, maxWorkers: 5 }, revision, 'panel')
  await settings.save('executor', { ...executor, maxWorkers: 2 }, revision, 'panel')
  check.resolve(model)
  await expect(slow).rejects.toThrow(SettingsConflict)
  expect(store.settings().executor).toMatchObject({ maxWorkers: 2, model: executor.model })
  // An account check that a save of the same Source outruns is refused the same way.
  const accounts = deferred<void>()
  vi.spyOn(Setup.prototype, 'checkAccounts').mockImplementationOnce(() => accounts.promise)
  const github = settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const moved = settings.save('source:github', { ...value, config: { ...value.config, cli: '/opt/bin/gh-other' } }, github.revision,
    'panel')
  await settings.save('source:github', { ...value, config: { ...value.config, pollSeconds: 90 } }, github.revision, 'panel')
  accounts.resolve()
  await expect(moved).rejects.toThrow(SettingsConflict)
  expect(store.settings().sources.github!.config).toMatchObject({ cli: value.config.cli, pollSeconds: 90 })
})

it('refuses a Policy sync that a Policy save outran, reports it on sync:feishu, and keeps the save', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const members = deferred<unknown>()
  vi.mocked(Commands.prototype.lark).mockImplementationOnce(() => members.promise as never)
  const syncing = settings.sync('feishu')
  const policy = store.settings().policy
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs' }]
  await settings.save('policy', { ...policy, rules }, store.blockRevision('policy'), 'panel')
  members.resolve({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_new', name: 'New' }], has_more: false })
  await expect(syncing).rejects.toThrow(SettingsConflict)
  expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error',
    detail: expect.stringContaining('Policy changed during synchronization') })
  expect(store.settings().policy).toMatchObject({ rules, sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } })
})

it('syncs a Policy part again after a failed sync, a minute later and then after a wait that doubles, until it succeeds', async () => {
  h = await startRuntime()
  const { settings } = h.runtime
  // The syncs the Runtime runs as it starts finish first.
  await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
  await h.runtime.idle()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const lark = vi.mocked(Commands.prototype.lark)
    lark.mockRejectedValueOnce(new Error('network down')).mockRejectedValueOnce(new Error('network down'))
    await expect(settings.sync('feishu')).rejects.toThrow('network down')
    expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error', detail: expect.stringContaining('network down') })
    const calls = () => lark.mock.calls.filter(([args]) => args.includes('+chat-members-list')).length
    const before = calls()
    await vi.advanceTimersByTimeAsync(60_000)
    // The first retry fails too, so the next waits two minutes.
    expect(calls()).toBe(before + 1)
    lark.mockResolvedValueOnce({ users: [{ member_id: 'ou_alice', name: 'Alice' }], has_more: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
    expect(calls()).toBe(before + 2)
    // A success ends the retries.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls()).toBe(before + 2)
  } finally { vi.useRealTimers() }
})
it('records nothing for a pause that changes nothing, refuses a sync while setup waits, and names an unknown block', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const revision = store.blockRevision('pause')
  const inject = h.agents.get(h.runtime.masterId)!.inject
  inject.mockClear()
  expect(await settings.pause(false, 'panel')).toEqual({ paused: false })
  await h.runtime.idle()
  expect([store.blockRevision('pause'), inject.mock.calls.length, h.runtime.effects.pending('notice')]).toEqual([revision, 0, false])
  vi.spyOn(Setup.prototype, 'configured').mockReturnValue(false)
  await expect(settings.sync('feishu')).rejects.toThrow(new UserError('nothingToSync', { source: 'feishu' }))
  vi.mocked(Setup.prototype.configured).mockRestore()
  expect(() => settings.block('source:x')).toThrow(new UserError('unknownBlock', { block: 'source:x' }))
})

it('saves and reads the routing block, so a mapping is panel-editable and reaches device selection', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const revision = store.blockRevision('routing')
  expect(settings.block('routing').value).toEqual({ chats: [], repositories: [] })
  await settings.save('routing', {
    chats: [{ chatId: 'oc_shop', workspace: '/srv/shop' }],
    repositories: [{ repository: 'acme/widgets', workspace: '/srv/widgets', labels: ['intranet'] }],
  }, revision, 'panel')
  expect(store.settings().routing.repositories).toEqual([{ repository: 'acme/widgets', workspace: '/srv/widgets', labels: ['intranet'] }])
  expect(settings.block('routing').revision).toBe(revision + 1)
  expect(settings.view().routing.value).toMatchObject({ repositories: [{ repository: 'acme/widgets' }] })
})

it('refuses a routing block that is not a route table, leaving the saved one in place', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const revision = store.blockRevision('routing')
  await expect(settings.save('routing', { repositories: [{ repository: 'not-a-repo', workspace: '/w/x' }] }, revision, 'panel')).rejects.toThrow()
  expect(store.settings().routing.repositories).toEqual([])
})

/**
 * Credential saving: a blank form means "unchanged", never "delete".
 *
 * The card renders empty on every load because the panel is never sent a stored secret. If a save with empty boxes
 * cleared the stored value, merely saving an unrelated field on the same card would silently drop the token and the
 * CLI would start running as nobody while the card still looked configured.
 */
it('keeps a stored CLI credential when the card is saved with its boxes left blank', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const github = settings.block('source:github').value as { enabled: boolean; config: Record<string, unknown> }
  // Start from a saved token, then save the block again with empty credential boxes.
  await settings.save('source:github', { ...github, secret: { token: 'ghp_first' } }, settings.block('source:github').revision, 'panel')
  const revision = settings.block('source:github').revision
  await settings.save('source:github', { ...github, secret: { token: '' } }, revision, 'panel')
  const sealed = store.get(KV.sources.secret('github'))
  expect(sealed).toBeDefined()
  expect(unseal(secretKey(h.runtime.machine.stateDir), sealed!)).toEqual({ 'GH_TOKEN=token': 'ghp_first' })
  // A non-empty value replaces it. The block is also changed, because an identical block is a no-op save that never
  // reaches the credential write.
  const changed = { ...github, config: { ...github.config, pollSeconds: 120 } }
  await settings.save('source:github', { ...changed, secret: { token: 'ghp_second' } },
    settings.block('source:github').revision, 'panel')
  expect(unseal(secretKey(h.runtime.machine.stateDir), store.get(KV.sources.secret('github'))!)).toEqual({ 'GH_TOKEN=token': 'ghp_second' })
})

/**
 * The typed credential must reach the CLI during the check that uses it.
 *
 * End-to-end version of the bug: setup resolved the GitHub account before writing the worker environment, so the very
 * command that verifies the token ran without it and reported "cannot read its account" for a valid token. This
 * asserts the probe's own environment, not the environment applied afterwards.
 */
it('hands the stored credential to the account check that runs during setup', async () => {
  // The credential is present before setup runs, which is the state a panel save leaves behind. It is written
  // through the store's own seeding hook so the key file lives beside the database the runtime will read.
  h = await startRuntime((store, stateDir) => {
    store.set(KV.sources.secret('github'), seal(secretKey(stateDir), { 'GH_TOKEN=token': 'ghp_probe' }))
  })
  const argv = h.probed.find(line => line.includes('api') && line.includes('user'))
  expect(argv).toBeDefined()
  expect(argv!.some(part => part === 'GH_TOKEN=ghp_probe')).toBe(true)
})


/**
 * An older secret row stores only the field key, without the variable name.
 *
 * Those rows predate the mapping, and an operator who already saved a token must not be silently signed out by the
 * upgrade. Once the source kind is registered its declaration supplies the name, so the value keeps working.
 */
it('still injects a credential stored before the variable mapping existed', async () => {
  h = await startRuntime((store, stateDir) => {
    store.set(KV.sources.secret('github'), seal(secretKey(stateDir), { token: 'ghp_legacy' }))
  })
  // The kind registers after setup runs, so the legacy row is picked up on the next setup pass, which is what
  // "re-check setup" performs.
  await h.runtime.setup.run(h.runtime.store.settings())
  const argv = h.probed.filter(line => line.includes('api') && line.includes('user')).at(-1)
  expect(argv!.some(part => part === 'GH_TOKEN=ghp_legacy')).toBe(true)
})

/**
 * Credentials must be discoverable before the source plugins register.
 *
 * Setup runs before them, so `sources.instances()` is empty at that point. Enumerating secrets from the registry
 * therefore injected nothing, and a perfectly valid token still produced agentCliSignedOut. This asserts the value
 * reaches the probe in that early window.
 */
it('injects a credential that was stored before any source kind registered', async () => {
  h = await startRuntime((store, stateDir) => {
    store.set(KV.sources.secret('github'), seal(secretKey(stateDir), { 'GH_TOKEN=token': 'ghp_early' }))
  })
  const argv = h.probed.find(line => line.includes('api') && line.includes('user'))
  expect(argv!.some(part => part === 'GH_TOKEN=ghp_early')).toBe(true)
})

/**
 * A save that introduces a token must be verified WITH that token.
 *
 * The account check runs before the credential is stored, so passing only the already-stored secret meant a first
 * save could never succeed: the operator typed a valid token, the check ran `gh` without it, and the refused save was
 * reported as "cannot read its account". That looked like the token itself was wrong.
 */
it('checks a new credential on the save that introduces it, before it is stored', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const block = settings.block('source:github')
  const value = block.value as { enabled: boolean; config: Record<string, unknown> }
  h.probed.length = 0
  await settings.save('source:github', { ...value, secret: { token: 'ghp_brandnew' } }, block.revision, 'panel')
  const probe = h.probed.find(line => line.includes('api') && line.includes('user'))
  expect(probe).toBeDefined()
  // The value under test: the check saw the token the operator had just typed, not an empty environment.
  expect(probe!.some(part => part === 'GH_TOKEN=ghp_brandnew')).toBe(true)
  // And it is stored afterwards.
  expect(unseal(secretKey(h.directory), store.get(KV.sources.secret('github'))!))
    .toEqual({ 'GH_TOKEN=token': 'ghp_brandnew' })
})

/**
 * The credential must survive into the environment of every command the host runs afterwards.
 *
 * Setup resolves the account, then applies the credential to `process.env` so workers inherit it. But `Commands` does
 * not run with `process.env` alone: it merges `setup.commandEnvironment` over it, and that view is built from
 * `agentVariables()`, which sets `GH_TOKEN: undefined` to keep an operator's own token out of the agent's way. The
 * `undefined` therefore overwrote the very credential setup had just injected, and only the host's own CLI calls — the
 * GitHub polling loop — ran unsigned while the worker shims worked. That is the source of the endless
 * "please run gh auth login" poll failures next to an otherwise healthy deployment.
 */
it('keeps the resolved credential in the environment of the CLI calls the host itself runs', async () => {
  h = await startRuntime((store, stateDir) => {
    store.set(KV.sources.secret('github'), seal(secretKey(stateDir), { 'GH_TOKEN=token': 'ghp_polling' }))
  })
  // The value under test: the environment merged into every Commands.run, not the process environment.
  expect(h.runtime.setup.commandEnvironment.GH_TOKEN).toBe('ghp_polling')
})

/**
 * The command environment must be read when a command runs, not when the Commands object is built.
 *
 * `Runtime` constructs `Commands` before setup resolves anything, so passing the environment record by value froze an
 * empty credential map into every later command. The host's own `gh` then ran unsigned while the panel showed a
 * configured token — the actual cause of the endless `gh auth login` poll failures.
 */
it('applies a credential resolved after the Commands object was built', async () => {
  h = await startRuntime((store, stateDir) => {
    store.set(KV.sources.secret('github'), seal(secretKey(stateDir), { 'GH_TOKEN=token': 'ghp_later' }))
  })
  // Undo the fixture's stub of `run`: this assertion is about what a real command receives, and `node` exists
  // everywhere the suite runs.
  vi.restoreAllMocks()
  await h.runtime.setup.run(h.runtime.store.settings())
  const output = await h.runtime.commands.run(process.execPath, ['-e', 'process.stdout.write(process.env.GH_TOKEN ?? "")'])
  expect(output).toBe('ghp_later')
})

/**
 * Replacing only the token must restart setup so the new value is actually used.
 *
 * A credential lives outside the settings document, so a card whose configuration is unchanged produces an identical
 * document. The save skipped itself as a no-op and never restarted setup, so the old token stayed in `process.env`
 * and in the polling loop while the card showed the new one — a "the token I typed is ignored" report with nothing
 * visibly wrong.
 */
it('restarts setup to apply a credential that changed with no other setting', async () => {
  h = await startRuntime((store, stateDir) => {
    store.set(KV.sources.secret('github'), seal(secretKey(stateDir), { 'GH_TOKEN=token': 'ghp_before' }))
  })
  const { settings, store } = h.runtime
  const block = settings.block('source:github')
  const value = block.value as { enabled: boolean; config: Record<string, unknown> }
  const result = await settings.save('source:github', { ...value, secret: { token: 'ghp_after' } }, block.revision, 'panel')
  // The card's configuration is untouched, so the document save is a no-op — the credential still has to be applied.
  expect(result.restarting).toBe(true)
  expect(unseal(secretKey(h.directory), store.get(KV.sources.secret('github'))!)).toEqual({ 'GH_TOKEN=token': 'ghp_after' })
})
