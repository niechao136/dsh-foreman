// @vitest-environment jsdom
/**
 * The Policy settings group, reached through the settings navigation.
 *
 * The regression this covers: the accept rules, the per-Source sender lists and the admission table all existed as
 * `PolicyBlock`, but they were rendered inside the Eval group and no navigation entry pointed at them. On the live
 * panel "策略" therefore did not exist, `policy.sources` could not be edited at all, and every sender was judged
 * "not on this Source's list" — the reason reported for messages nobody could admit.
 */
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { all, click, find, mount, tab, text, usePanel } from './fixtures/panel.tsx'

usePanel()

it('offers Policy as its own settings group in the navigation', async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  // The navigation is the only way in, so the group has to be listed there.
  const links = all('.dt-settings-link').map(link => link.textContent ?? '')
  expect(links).toContain(zh['settingsGroup.policy'])
})

it('shows the accept rules and the per-Source sender list under Policy', async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.policy'], '.dt-settings-link'))
  // The rules half of the page.
  expect(text()).toContain(zh.rules)
  expect(text()).toContain(zh.addRule)
  // The per-Source half: without it the sender lists cannot be edited anywhere in the panel. The sender list comes
  // from each Source kind's own field label, and the admission table from the Policy's, so both are asserted by the
  // labels the operator actually reads.
  expect(text()).toContain(zh.policyPerSource)
  expect(text()).toContain('能发起工作的')
  expect(text()).toContain(zh.admission)
})

/** The Eval group keeps its own half, so splitting Policy out did not take the accept mode with it. */
it('leaves the accept mode and the assessor model on the Eval group', async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['settingsGroup.eval'], '.dt-settings-link'))
  expect(text()).toContain(zh.acceptMode)
  expect(text()).toContain(zh.evalTimeout)
  // And the rules stay on Policy, so the two groups are independently editable.
  expect(text()).not.toContain(zh.addRule)
})
