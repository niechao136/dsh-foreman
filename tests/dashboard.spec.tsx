// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { all, click, mount, tab, usePanel } from './fixtures/panel.tsx'

usePanel()
it('实时指标与历史统计分开，待办与问题指标可以聚焦对应区域', async () => {
  await mount()
  expect(all('.dt-metric-label').map(node => node.textContent)).toEqual([
    zh.executingLabel, zh.queuedLabel, zh.pendingTickets, zh.problems,
  ])
  await click(all('.dt-metric-link')[2]!)
  expect(document.activeElement?.id).toBe('dt-overview-pending')
  await click(all('.dt-metric-link')[3]!)
  expect(document.activeElement?.id).toBe('dt-overview-problems')
  expect(all('.dt-dashboard > *').at(-1)?.querySelector('.dt-loop-track')).not.toBeNull()
})
it('运行指标仍打开真实执行页面', async () => {
  await mount()
  await click(all('.dt-metric-link')[0]!)
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
})
it('英文实时状态不遗漏翻译', async () => {
  await mount(en)
  expect(all('.dt-metrics')[0]?.getAttribute('aria-label')).toBe(en.overviewLive)
  expect(all('.dt-metric-label').map(node => node.textContent)).toEqual([
    en.executingLabel, en.queuedLabel, en.pendingTickets, en.problems,
  ])
})
