// @vitest-environment jsdom
// 面板只管自己的滚动：宿主文档被顶走时要能拉回来，区块定位不能依赖 focus 的默认滚动行为。
import { expect, it, vi } from 'vitest'
import { keepFrameInPlace, resetFrameScroll, revealSection } from '../src/client/frame.ts'

/** 把 documentElement 的滚动量换成可写替身：jsdom 不实现真实滚动，直接断言写入更可靠。 */
function stubScroll(top: number, left = 0) {
  const writes: Array<[string, number]> = []
  Object.defineProperty(document.documentElement, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => { writes.push(['top', value]); top = value },
  })
  Object.defineProperty(document.documentElement, 'scrollLeft', {
    configurable: true,
    get: () => left,
    set: (value: number) => { writes.push(['left', value]); left = value },
  })
  return writes
}

it('pulls a scrolled host document back to zero and leaves a settled one alone', () => {
  const writes = stubScroll(96)
  resetFrameScroll()
  expect(writes).toEqual([['top', 0]])
  // 已经在 0 时不再写，避免每帧都触发一次布局。
  writes.length = 0
  resetFrameScroll()
  expect(writes).toEqual([])
})

it('restores the frame on every document scroll and stops doing so once disposed', () => {
  const writes = stubScroll(0)
  const stop = keepFrameInPlace()
  writes.length = 0
  // 模拟 focus()/scrollIntoView() 把整屏顶上去：文档 scrollTop 变成 96，随后派发 scroll。
  document.documentElement.scrollTop = 96
  window.dispatchEvent(new Event('scroll'))
  expect(document.documentElement.scrollTop).toBe(0)
  // 卸载之后不再干预宿主的滚动。
  stop()
  document.documentElement.scrollTop = 96
  window.dispatchEvent(new Event('scroll'))
  expect(document.documentElement.scrollTop).toBe(96)
})

it('reveals a panel section without letting the browser scroll every ancestor', () => {
  const section = document.createElement('div')
  section.id = 'dt-overview-problems'
  const focus = vi.fn()
  const scrollIntoView = vi.fn()
  section.focus = focus as unknown as typeof section.focus
  section.scrollIntoView = scrollIntoView
  document.body.append(section)
  revealSection('dt-overview-problems')
  // 只拿焦点，不要浏览器顺手滚祖先；滚动交给最近的容器（block: 'nearest'）。
  expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  // 目标不存在时静默跳过，不抛错。
  revealSection('dt-missing-section')
  section.remove()
})
