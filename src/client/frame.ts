/**
 * 把滚动留在面板里。
 *
 * 背景：宿主（ui-web）把 `html/body` 都设成 `overflow:hidden`，文档本来不该滚动。但桌面外壳下
 * `documentElement.scrollHeight` 会比视口高出一截（窗口之外的浮层撑大了可滚动区），于是
 * `focus()` / `scrollIntoView()` 这类「把元素滚进视野」的调用会把整个界面顶上去：顶部 AppBar
 * 被切掉、底部露出一条窗口背景色 —— 也就是用户报的「黑下巴」。面板自己只滚自己的容器，
 * 同时对宿主文档做一次兜底复位，谁把它滚走都能拉回来。
 */

/** 宿主真正的滚动容器：标准模式下就是 `documentElement`。 */
const scrollingElement = (): Element => document.scrollingElement ?? document.documentElement

/** 把宿主文档的滚动量清零。 */
export function resetFrameScroll(): void {
  const node = scrollingElement()
  // 只在真的被滚走时才写，避免每帧都触发一次布局。
  if (node.scrollTop !== 0) node.scrollTop = 0
  if (node.scrollLeft !== 0) node.scrollLeft = 0
}

/**
 * 装上「文档不许滚」的兜底监听。
 * 返回卸载函数，随插件卸载一起撤掉，不给宿主留活着的监听器。
 */
export function keepFrameInPlace(): () => void {
  // 先复位一次：插件装载之前可能已经被别的插件顶走了。
  resetFrameScroll()
  // scroll 不冒泡，但文档滚动会在 window 上派发；passive 表示我们只读，不拦默认行为。
  window.addEventListener('scroll', resetFrameScroll, { passive: true })
  return () => window.removeEventListener('scroll', resetFrameScroll)
}

/**
 * 把面板内某个区块滚进视野，但只滚面板自己的滚动容器。
 *
 * `focus()` 不带 `preventScroll` 会让浏览器去滚「所有」祖先滚动容器（包括宿主文档），
 * 这里先用 `preventScroll` 只拿焦点，再用 `block: 'nearest'` 让浏览器在需要时才动
 * 最近的容器：可见就不动，不可见才动 `.dt-content`。
 */
export function revealSection(id: string): void {
  const target = document.getElementById(id)
  if (!target) return
  target.focus({ preventScroll: true })
  target.scrollIntoView?.({ block: 'nearest' })
}
