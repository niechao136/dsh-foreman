// @vitest-environment jsdom
/**
 * The Routing settings page: its save bar, and the dropdowns that replaced free-text ids.
 *
 * The first case is a regression. `routing.tsx` used to pass its own edited rows as the draft's `saved` value, so
 * every draft compared equal to itself: `dirty` stayed false and the save bar — the only way to apply a change — never
 * rendered. On the live panel that looked like "the page has no save button".
 *
 * The page is rendered directly rather than through the whole app: the navigation to reach it is covered elsewhere,
 * and going through it here would make a save-bar bug fail with "no button named …" instead of naming the real fault.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, onTestFinished } from 'vitest'
import { RoutingSettings } from '../src/client/routing.tsx'
import { zh } from '../src/client/locales.ts'
import { all, find, settle, text, type, usePanel } from './fixtures/panel.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { SettingsProvider, useSettingsQuery } from '../src/client/settings-kit.tsx'
import { translator } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

/** Render the Routing page alone, against the fake panel server. */
async function render(): Promise<void> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  await act(async () => {
    root.render(<PanelProvider t={translator(zh)} interval={0}>
      <SettingsProvider><Ready /></SettingsProvider>
    </PanelProvider>)
  })
  await settle()
}

/** Waits for the settings payload, so the page renders against real data rather than an empty context. */
function Ready() {
  return useSettingsQuery().settings ? <RoutingSettings /> : null
}

/** Add a routing row through its button, returning the row it appended. */
async function addRow(label: string): Promise<HTMLElement> {
  const button = find(label, 'button')
  await act(async () => { button.click() })
  await settle()
  const rows = all('.dt-row')
  return rows[rows.length - 1]!
}

it('shows the Routing save bar as soon as a row is edited, and saves the rows it shows', async () => {
  await render()
  // Nothing to save yet: the bar is absent, not merely disabled.
  expect(all('.dt-savebar').length).toBe(0)
  const row = await addRow(zh.routingAddChat)
  const inputs = Array.from(row.querySelectorAll('input'))
  expect(inputs.length).toBeGreaterThan(0)
  await type(inputs[0]!, 'oc_new')
  await settle()
  // The regression: a bar must appear once the draft differs from what is stored.
  expect(all('.dt-savebar').length).toBe(1)
  expect(text()).toContain(zh.save)
})

it('offers the chats the Feishu Source knows as options instead of making the operator type ids', async () => {
  await render()
  const row = await addRow(zh.routingAddChat)
  const select = row.querySelector('select')
  expect(select).not.toBeNull()
  const options = Array.from(select!.querySelectorAll('option')).map(option => option.textContent ?? '')
  // The fixture's Feishu Source knows two chats; the dropdown names them and still shows the id.
  expect(options.join('|')).toContain('团队群')
  expect(options.join('|')).toContain('oc_team')
  expect(options).toContain(zh.routingChoose)
  // A stored value that is not among the options is still shown, so it is not silently swapped for another chat.
  expect(options.length).toBeGreaterThan(2)
  void server
})
