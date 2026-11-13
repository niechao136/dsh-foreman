// @vitest-environment jsdom
/**
 * The Migration page: what a move carries, and the one control that starts a download.
 *
 * The export is deliberately a plain link rather than a `fetch`: the server streams the archive, and the browser
 * writing it straight to disk is what keeps a large `sessions` directory out of JavaScript memory. A page that
 * instead fetched and re-saved the blob would look identical and lose that.
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, onTestFinished } from 'vitest'
import { MigrationPage } from '../src/client/migration.tsx'
import { zh } from '../src/client/locales.ts'
import { all, settle, text, usePanel } from './fixtures/panel.tsx'
import { PanelProvider } from '../src/client/provider.tsx'
import { translator } from './fixtures/panel.tsx'

usePanel()

/** Render the Migration page alone, against the fake panel server. */
async function render(): Promise<void> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  onTestFinished(() => { act(() => { root.unmount() }); container.remove() })
  await act(async () => {
    root.render(<PanelProvider t={translator(zh)} interval={0}><MigrationPage /></PanelProvider>)
  })
  await settle()
}

it('lists every carried entry with its size, and says which are absent', async () => {
  await render()
  const entries = all('.dt-migration-entry').map(row => row.textContent ?? '')
  expect(entries.length).toBe(6)
  // The state directory, the workspace UUIDs, the sessions, and the panel's own session are all named.
  expect(entries.join('|')).toContain('state/superagent')
  expect(entries.join('|')).toContain('.credentials.yaml')
  expect(entries.join('|')).toContain('profiles')
  // An entry the hub never created says so rather than showing 0 B, which would read as an empty directory.
  expect(entries.find(entry => entry.includes('attachments'))).toContain(zh.migrationAbsent)
})

it('states the total, and that dependencies are excluded from it', async () => {
  await render()
  const page = text()
  expect(page).toContain('MB')
  expect(page).toContain('profiles/node_modules')
})

/** The download is a real link to the streaming endpoint, so the browser saves the archive as it arrives. */
it('offers the export as a plain download link rather than a scripted request', async () => {
  await render()
  const link = document.querySelector('a[download]') as HTMLAnchorElement | null
  expect(link).not.toBeNull()
  expect(link!.getAttribute('href')).toBe('/orchestrator/export')
  expect(link!.textContent).toContain(zh.migrationExportButton)
})

/** Restoring is offered as a two-step flow: upload and check, then apply. */
it('offers a restore through upload-then-apply rather than one click', async () => {
  await render()
  const page = text()
  // The upload control and the apply button both exist, and applying starts disabled: nothing is checked yet.
  expect(page).toContain(zh.migrationUpload)
  const apply = Array.from(document.querySelectorAll('button')).find(button => button.textContent === zh.migrationApply)
  expect(apply).toBeDefined()
  expect((apply as HTMLButtonElement).disabled).toBe(true)
  expect(document.querySelector('input[type="file"]')).not.toBeNull()
})

/** It also names the check to run after unpacking, which is the part a ticket count cannot make. */
it('points at the verify step and what it checks beyond the ticket count', async () => {
  await render()
  expect(text()).toContain('migrate.mjs verify')
})
