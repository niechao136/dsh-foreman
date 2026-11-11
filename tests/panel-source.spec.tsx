// @vitest-environment jsdom
// The Source status and settings.
import { act } from 'react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field, at } from './fixtures/panel.tsx'
import { server, problemOf, droppedReply } from './fixtures/panel-server.ts'

usePanel()
it('folds more than six chats into a line of their names', async () => {
  const chats = Array.from({ length: 7 }, (_, n) => ({ chatId: n ? `oc_c${n}` : 'oc_team', listen: 'all' as const }))
  server.settings.sources.feishu = { ...server.settings.sources.feishu!, config: { ...server.settings.sources.feishu!.config, chats } }
  await mount()
  // 来源页已删除：设置页左栏直接选「来源」分组，卡片就是同一个表单。
  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.source'], '.dt-settings-link'))
  const summary = all('.dt-card')[0]!.querySelector('.dt-rows-summary')!
  expect(summary.textContent).toBe(['团队群', 'oc_c1', 'oc_c2', 'oc_c3', 'oc_c4', 'oc_c5', 'oc_c6'].join('、'))
})

it('rereads the chats the bot has joined on request and says which are new, keeping unsaved edits', async () => {
  await mount()
  // 来源页已删除：设置页左栏直接选「来源」分组，卡片就是同一个表单。
  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.source'], '.dt-settings-link'))
  const feishu = () => all('.dt-card')[0]!
  const button = () => [...feishu().querySelectorAll('button')].find(item => item.textContent === '刷新群列表')!
  await click([...feishu().querySelectorAll('button')].find(item => item.textContent === '添加')!)
  server.joining = { oc_new: '新群' }
  await click(button())
  expect(server.requests.find(request => request.path === 'sources/feishu/labels')).toMatchObject({ method: 'POST' })
  expect(document.querySelector('.dt-toast')?.textContent).toBe('列表已更新，新增：新群')
  // The row being added stays, and now offers the new chat.
  const pick = feishu().querySelectorAll('.dt-rows-item')[1]!.querySelector<HTMLSelectElement>('select[aria-label="选择机器人已加入的群"]')!
  expect([...pick.options].map(option => option.textContent)).toEqual(['选择机器人已加入的群', '另一个群', '新群'])
  await click(button())
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe(zh.labelsCurrent)
  server.joinError = 'lark-cli: token expired'
  await click(button())
  expect([...document.querySelectorAll('.dt-toast')].at(-1)?.textContent).toBe('读取失败，列表保持不变：lark-cli: token expired')
  expect(button().disabled).toBe(false)
  // Only a field whose key column offers a refresh shows the button.
  expect([...all('.dt-card')[1]!.querySelectorAll('button')].some(item => item.textContent === '刷新群列表')).toBe(false)
})

it('renders each Source\'s settings from its kind\'s fields and saves one Source against its own revision', async () => {
  await mount()
  // 来源页已删除：设置页左栏直接选「来源」分组，卡片就是同一个表单。
  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.source'], '.dt-settings-link'))
  const cards = all('.dt-card')
  expect(cards.map(card => card.querySelector('.dt-row-title')?.firstChild?.textContent)).toEqual(['飞书', 'GitHub'])
  const feishu = cards[0]!
  expect(feishu.textContent).toContain('接收的群')
  await click([...feishu.querySelectorAll('button')].find(button => button.textContent === '添加')!)
  const rows = feishu.querySelectorAll('.dt-rows-item')
  // A saved chat shows its name; a row being added picks from the joined chats not yet configured.
  expect(rows[0]!.querySelector('.dt-row-label')?.textContent).toBe('团队群')
  expect(rows[0]!.querySelector('select[aria-label="选择机器人已加入的群"]')).toBeNull()
  const pick = rows[1]!.querySelector<HTMLSelectElement>('select[aria-label="选择机器人已加入的群"]')!
  expect([...pick.options].map(option => option.textContent)).toEqual(['选择机器人已加入的群', '另一个群'])
  await type(pick, 'oc_other')
  await type(rows[1]!.querySelector('select[aria-label="接收"]')!, 'all')
  await click('接收私聊')
  await act(async () => { feishu.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.requests.find(request => request.path === 'settings/source:feishu')).toMatchObject({ method: 'PUT', body: { revision: 0,
    value: { enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }, { chatId: 'oc_other', listen: 'all' }],
      directMessages: false } } } })
  expect(server.settings.sources.feishu!.config).toMatchObject({ directMessages: false })
  const github = all('.dt-card')[1]!
  await click('运行来源：GitHub')
  server.revisions['source:github'] = 5
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  // Another save changed nothing this draft changed, so the draft moves onto the newer revision and saves from there.
  expect(github.querySelector('.dt-savebar')?.textContent).toContain('设置已在别处修改，你的修改已合并到最新版本')
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.sources.github).toMatchObject({ enabled: false })
  expect(server.revisions['source:github']).toBe(6)
})

/**
 * Selects "type a path" in the CLI dropdown and types one.
 *
 * The CLI field became a dropdown of what the machine has; typing a path is still supported, because a wrapper script
 * (a gh signed in through GH_CONFIG_DIR) is how the documented deployment gives the agent its own account and it will
 * never show up in a scan. A test that reached for the input directly would fail on the control rather than the rule.
 */
/**
 * Types a CLI path into a source card.
 *
 * The picker is a dropdown of what the machine has, with a "type a path" option for a binary the scan missed (a gh
 * wrapper signed in through GH_CONFIG_DIR is the documented deployment and never shows up in a scan). Once that option
 * is chosen the control is a plain input, so a second call must not expect a <select> to still be there.
 */
async function chooseTypedPath(card: HTMLElement, path: string, label = '智能体的 GitHub CLI'): Promise<void> {
  const select = [...card.querySelectorAll<HTMLSelectElement>('select.dt-select')]
    .find(item => item.getAttribute('aria-label') === label)
  if (select) {
    const option = [...select.options].find(item => item.textContent === zh.cliTypePath)!
    await act(async () => {
      select.value = option.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
  }
  await type(field<HTMLInputElement>(label), path)
}


it('shows the account each CLI signs in as, and keeps a saved CLI on screen while dsh-foreman restarts', async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  // The settings payload arrives after the first render; wait for it before reading the card.
  await settle()
  const github = all('.dt-card')[1]!
  expect(github.textContent).toContain('当前账号 @agent-bot')
  const labels = () => [...github.querySelectorAll('label')].map(label => label.textContent)
  // 仓库列表用的是 rows 字段（表头不是 label），逐个仓库一个输入框。
  expect(github.textContent).toContain('监听的仓库')
  const repositories = () => [...github.querySelectorAll('.dt-rows-item .dt-row-label')].map(cell => cell.textContent)
  expect(repositories()).toEqual(['acme/widgets'])
  // The CLI picker is not a <label> (it chooses from a list rather than naming one field), so only the credential
  // fields and the advanced numbers appear here.
  expect(labels()).toEqual(['令牌'])
  // A fact describes the saved value, so an edited CLI shows none until it is saved.
  // The CLI is a dropdown now; "type a path" is the option that still lets an operator name a binary the scan missed.
  await chooseTypedPath(github, 'gh-other')
  expect(github.textContent).not.toContain('当前账号 @agent-bot')
  await click(zh.discard)
  expect(github.textContent).toContain('当前账号 @agent-bot')
  await click([...github.querySelectorAll<HTMLElement>('[data-disclosure-row]')].find(row => row.textContent?.includes('高级'))!)
  expect(labels()).toEqual(['令牌', '轮询间隔 / 秒', '连续失败几次后报告异常'])
  expect(all('.dt-card')[0]!.textContent).toContain('当前机器人 Widgets Bot')
  await chooseTypedPath(github, '/opt/bin/gh-agent')
  expect(github.textContent).toContain('保存会重启 dsh-foreman：2 个进行中的派工会中断，并带恢复说明重新开始。')
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.sources.github!.config).toMatchObject({ cli: '/opt/bin/gh-agent' })
  expect(text()).toContain(zh.savedRestarting)
  // The saved value stays, and the card's fields are disabled, until the saved revision returns with the restarted dsh-foreman.
  expect(field<HTMLInputElement>('智能体的 GitHub CLI').value).toBe('/opt/bin/gh-agent')
  expect(field('智能体的 GitHub CLI').matches(':disabled')).toBe(true)
  expect(sessionStorage.getItem('dsh-foreman/draft/master/source:github')).toBeNull()
})

it('points a setup problem at the settings that fix it', async () => {
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset'), accounts: null }
  await mount()
  expect(text()).toContain(zh.problemSetup)
  expect(text()).toContain(zh['setup.agentCliUnset'])
  // Nothing runs while setup waits, so the Executor says so instead of counting.
  expect(text()).toContain(zh.executorWaitingSetup)
  expect(all('.dt-stat').map(stat => stat.textContent)).not.toContain('执行中2 / 3')
  expect(text()).toContain('在设置 › 来源的 GitHub 卡片修正后保存，会重新检查')
  await click(find(zh.problemSetup, 'button, a, [role="button"]'))
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.source'])
  // 来源页左栏点开的就是这张卡：详情页里只有它显示，问题文案在原处。
  expect(all('.dt-card')[1]!.textContent).toContain('部署检查未通过：没有设置智能体的 GitHub CLI。')
  await click(find(zh['settingsGroup.deployment'], '.dt-settings-link'))
  expect(text()).toContain('部署检查未通过：没有设置智能体的 GitHub CLI。')
  // After a fix outside dsh-foreman, a check runs setup again.
  await click(zh.setupCheck)
  expect(server.requests.filter(request => request.path === 'setup/check')).toEqual([{ path: 'setup/check', method: 'POST' }])
  expect(text()).toContain(zh.setupChecking)
  server.setup = { ...server.setup, problem: problemOf('gitTooOld') }
  await remount()
  await click(zh['tab.overview'])
  await click(find(zh.problemSetup, 'button, a, [role="button"]'))
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.deployment'])
  expect(text()).toContain('部署检查未通过：git 没有读取 dsh-foreman 为 github.com 写的凭据配置')
})

it('shows a failed Feishu bot check as a problem of the Feishu Source only, with a check after a fix outside dsh-foreman', async () => {
  server.setup = { ...server.setup, problems: [{ ...problemOf('feishuBotNotReady', { app: 'cli_bot', status: 'missing' }),
    scope: 'source' as const, title: { zh: '飞书', en: 'Feishu' } }], accounts: { ...server.setup.accounts!, feishu: null } }
  const paused = zh.problemSetupSource.replace('{source}', '飞书')
  await mount()
  expect(text()).toContain(paused)
  expect(text()).not.toContain('飞书 来源异常')
  await click(find(paused, 'button, a, [role="button"]'))
  const feishu = all('.dt-card')[0]!
  expect(feishu.textContent).toContain('部署检查未通过：应用 cli_bot 的机器人身份状态是 missing；用 lark-cli 配置应用密钥。')
  // dsh-foreman runs meanwhile, so checking again asks first: the restart interrupts running Executor Sessions.
  await click([...feishu.querySelectorAll('button')].find(button => button.textContent === '重新检查')!)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('重新检查会重启 dsh-foreman：2 个进行中的派工会中断')
  expect(server.requests.some(request => request.path === 'setup/check')).toBe(false)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'setup/check')).toBe(true)
})

it('leaves Feishu out of a GitHub-only deployment', async () => {
  server.setup = { ...server.setup, accounts: { ...server.setup.accounts!, feishu: null } }
  server.settings = { ...server.settings, sources: { ...server.settings.sources, feishu: { enabled: false, config: {} } } }
  at({ page: 'settings', query: { group: 'prompts' } })
  await mount()
  await click(tab(zh.promptViewFull))
  expect([...field<HTMLSelectElement>(zh.promptPreviewTarget).options].map(option => option.textContent)).toEqual(['主 Session',
    '执行器 Session', 'dsh-foreman-github'])
})

it('shows a refused Source save with the output of the tool that failed on its own line', async () => {
  await mount()
  // 来源页已删除：设置页左栏直接选「来源」分组，卡片就是同一个表单。
  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.source'], '.dt-settings-link'))
  const feishu = all('.dt-card')[0]!
  // The fixture refuses a save whose CLI is "lark-broken", standing in for a CLI whose account check fails.
  // The picker is a dropdown now, so that name has to go in through the "type a path" option.
  await chooseTypedPath(feishu, 'lark-broken', '机器人的 lark-cli')

  await act(async () => { feishu.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(feishu.querySelector('.dt-savebar [role="alert"]')?.textContent).toBe('机器人的 lark-cli 不可用。\nlark-cli: app secret missing')
})

it('shows a setup problem on its Source card within one read of the settings, which the settings groups share', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  const card = () => document.getElementById('dt-source-github')!
  expect(card().textContent).not.toContain(zh['setup.agentCliUnset'])
  server.setup = { ...server.setup, problem: problemOf('agentCliUnset') }
  // The settings are read every five seconds, as the state is; the Source settings do not read the Source status.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) }); await settle()
  expect(server.requests.filter(request => request.path === 'settings')).toHaveLength(2)
  expect(server.requests.some(request => request.path === 'sources')).toBe(false)
  expect(card().textContent).toContain(zh['setup.agentCliUnset'])
})

it('reads the settings again as soon as dsh-foreman answers after a save restarted it', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  at({ page: 'settings', query: { group: 'source' } })
  await mount()
  const github = all('.dt-card')[1]!
  await chooseTypedPath(github, '/opt/bin/gh-agent')
  await act(async () => { github.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(field('智能体的 GitHub CLI').matches(':disabled')).toBe(true)
  // dsh-foreman restarts: DSH answers with empty 404s, then it answers again.
  server.down = true
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle()
  server.down = false
  const reads = server.requests.filter(request => request.path === 'settings').length
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) }); await settle()
  expect(server.requests.filter(request => request.path === 'settings').length).toBeGreaterThan(reads)
  expect(field('智能体的 GitHub CLI').matches(':disabled')).toBe(false)
  expect(field<HTMLInputElement>('智能体的 GitHub CLI').value).toBe('/opt/bin/gh-agent')
})

/**
 * Credentials typed on a Source card must stay typed.
 *
 * The regression this covers: the inputs were bound to `source.secret`, which the server reports with every value
 * blank on purpose (the panel never receives a stored secret). A controlled input whose `value` is always '' therefore
 * erased each keystroke — the boxes looked disabled because nothing could be entered into them.
 */
it('keeps a credential typed into the CLI form, and says a stored one is kept when left blank', async () => {
  // The server pretends a token is already saved, which is exactly the state that used to break typing.
  server.secret = { token: '' }
  await mount()
  await click(tab(zh['tab.settings']))
  await settle()
  const github = all('.dt-card')[1]!
  const token = field<HTMLInputElement>('令牌')
  // A stored value reports as "already saved, leave blank to keep it" rather than looking empty.
  expect(token.placeholder).toBe(zh.cliSecretKeep)
  await type(token, 'ghp_typed_value')
  await settle()
  // The regression: the keystrokes must survive a re-render instead of being reset to ''.
  expect(field<HTMLInputElement>('令牌').value).toBe('ghp_typed_value')
  // Typing a credential alone is enough to make the block dirty, so the save bar appears.
  expect(all('.dt-savebar').length).toBe(1)
})
