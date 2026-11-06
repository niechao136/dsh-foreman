# Superagent 面板 UI v2 重构规范

> 目标：把当前「左竖 rail + 页内多套头部 + 12~14px 密集排版」重构为**顶部应用栏 + 一级标签栏 + 页面模板 + 组件卡**的结构；视觉上抬高字号与留白、明确层级、统一状态语义。
> 本文件是重构期唯一的接口契约：新组件类名、页面模板、不可破坏的测试钩子都写在这里。
> 2026-11-02 起：来源页签与概览里的办公室可视化已删除，相关类名（`.dt-office-*`）不再存在。

## 1. 信息架构

- **AppBar**（吸顶，64px）：左 = 面板图标 + 产品名 + 面包屑（页面名 / 记录名），右 = 全局搜索 / 术语表 / 打开主会话。
- **TabBar**（吸顶于 AppBar 下，48px）：概览 · 触发 · 评估 · 执行 · 设置；选中项下划线 + 计数徽标（待处理/运行中/未读决策）。来源不单列页签：状态与计数在概览，配置在「设置 › 来源」。
- **Content**（唯一滚动容器）：页面以 `PageHeader` 开头，正文宽度上限 1160px（阅读型页面 980px）。
- **二级导航**：设置页保留左侧分组列表（`.dt-settings-nav`），但改为 sticky 卡片；列表页的筛选改用 `Toolbar` 横排（`.dt-filters`）。
- **详情页**：`DetailLayout` = 主列（摘要/输入/事件/决定）+ 右栏 300px（状态、负责人、来源、目录、时间、危险操作），<900px 折成单列。
- **面包屑**：AppBar 内 `Superagent / 工单 / <记录标题>`，详情页主列头保留返回按钮（`PageHeader back`）。

## 2. 设计令牌（client.css :root）

| 类别 | 值 |
|---|---|
| 字号 | metric 28 / page 22 / block 17 / sub 15 / body 14 / meta 13 / tag 12 |
| 行高 | 正文 1.6，标题 1.4，数字 1.1 |
| 间距 | 4 / 8 / 12 / 16 / 24 / 32 / 40（`--dt-space-1..7`） |
| 圆角 | sm 10 / 默认 14 / lg 20 |
| 阴影 | `--dt-shadow-1`（卡片）/ `--dt-shadow-2`（浮层） |
| 动效 | `--dt-dur 140ms`，`--dt-ease cubic-bezier(.2,.7,.3,1)`；`prefers-reduced-motion` 下关闭 |
| 状态 | `success / warn / error / info / idle` → `data-tone` 三件套（dot / soft-bg / text） |

所有颜色仍取 DSH 的 `--dsw-alias-*`；派生色只用 `color-mix()`，不要写死 hex。

## 3. 组件契约（widgets.tsx / controls.tsx）

- `PageHeader({ title, hint, eyebrow, actions, back })` → `.dt-page-head` > `.dt-page-title`(h2) + `.dt-hint` + `.dt-page-actions`；`back` 时最前面是返回按钮。
- `Card({ title, hint, actions, tone, children, className })` → `section.dt-card[data-tone]`；标题走 `h3.dt-card-head`（内含 `.dt-card-title`）。
- `StatCard({ label, value, hint, tone, icon })` → `.dt-stat-card` > `.dt-stat-card-label` / `.dt-stat-card-value` / `.dt-stat-card-hint`（`[data-tone]` 只染数字）。注意 `.dt-stat/.dt-stats` 是分节里的**内联统计条**（测试按它断言），两者不是同一个组件。
- `Toolbar({ children, actions })` → `.dt-toolbar-row`（左侧筛选 pills，右侧操作）。
- `MetaList({ items })` → `dl.dt-meta-list`（详情页右栏键值，长值可折行）。
- `Section / ListSection / Empty / ErrorLine / LoadState / LoadMore / Truncated / StatusHead / StatusLine` 保持现有 API，仅升级外观。
- 标签页：`SegmentedTabs variant='bar'` → `.dt-navbar/.dt-tabbar-item`（一级导航，下划线 + 徽标），`'tabs'` → 药丸，`'subtabs'` → 页内下划线。`.dt-nav-item` 专指纵向导航里的条目（设置页左栏、提示词左栏），语义不要互相借。

## 4. 页面模板

1. **仪表盘（overview）**：PageHeader → 4 张 StatCard 一行 → 两列：运行中（Office 卡）+ 待处理工单 / 系统问题 → 来源健康（卡片网格）→ 最近触发。
2. **列表页（工单/执行/Eval/触发）**：PageHeader(标题+计数+刷新) → Toolbar(筛选) → ListSection（骨架/错误/空态/加载更多）。
3. **详情页（工单/线程）**：PageHeader(back + 标题 + 状态) → DetailLayout：主列用 Card 分组（摘要、输入、事件时间线、决定），右栏用 Card + MetaList。
4. **设置页**：PageHeader → 左分组导航（sticky）+ 右表单卡；字段用两列栅格 `.dt-field-grid`，窄屏单列。

## 5. 不可破坏的契约（测试钩子，改名会红）

`.dt-status-head / .dt-status-title / .dt-status-subtitle / .dt-status-line`、
`.dt-empty-title / .dt-empty-hint / .dt-empty`、`.dt-list / .dt-row / .dt-row-title / .dt-row-meta / .dt-row-name / .dt-row-label`、
`.dt-card / .dt-card-title / .dt-cards`、`.dt-savebar / .dt-form / .dt-field / .dt-field-head`、
`.dt-settings-link`、`.dt-toast`、`.dt-search-results`、`.dt-page-head / .dt-page-title`、`.dt-section-title / .dt-section-head / .dt-more-link`、
`.dt-subtab`、`.dt-pill`、`.dt-tag`、`.dt-stage`、`.dt-event / .dt-event-text / .dt-highlight`、`.dt-rows-item`、`.dt-stat / .dt-stat-label`、
`.dt-part / .dt-preview-part / .dt-att / .dt-att-what`、`.dt-tabbar-item`、`.dt-nav-item`、`.dt-prompt-nav`、`.dt-lv / .dt-lv-value`、`.dt-rule`、`.dt-table`、
`.dt-ticket / .dt-ticket-stage / .dt-ticket-actions / .dt-ticket-note / .dt-ticket-meta`、`.dt-chip / .dt-chip-problem / .dt-chip-link`、
`.dt-admission / .dt-admission-slot / .dt-admission-scope`、`.dt-model`、`.dt-mono`、`.dt-banner / .dt-danger`、`.dt-hint`、`.dt-kv`、
`.dt-disclosure / .dt-disclosure-body`、`.dt-switch-row`、`.dt-default-updated / .dt-updated-tag / .dt-changed-tag`、`.dt-trigger-link`、`.dt-textlink`、`.dt-subhead`。

id 契约：`dt-tab-{page}`（导航 tab）、`dt-page`（内容 panel）、`dt-worker-model-efforts`。

## 6. 分批与写范围

- **批次 1（Lead）**：令牌 + `.dt-app/.dt-appbar/.dt-navbar/.dt-tabbar-item/.dt-content/.dt-detail/.dt-stat-card/.dt-meta-list` + `Card/StatCard/MetaList/Toolbar/PageHeader` + `app.tsx` 壳。
- **批次 2A（设置家族）**：`settings.tsx / settings-kit.tsx / source.tsx / deployment.tsx / draft.tsx`。
- **批次 2B（列表与详情）**：`ticket.tsx / thread.tsx / execution.tsx / eval.tsx / trigger.tsx / prompts.tsx / rows.tsx`。
- **批次 2C（Lead）**：`overview.tsx` 仪表盘 + `source.tsx` 之外的概览相关。
- **批次 3（Lead）**：测试同步、`typecheck`、`build`、部署预览、交接文档。

并行铁律：只改自己范围内的文件；`client.css` 与 `controls.tsx/widgets.tsx/locales.ts` 由 Lead 独占；不改 `tests/`；类名契约（第 5 节）可加不可改。


## 7. 闭环可见性（LoopTrack，2026-11-02 追加）

目标：让「决策 → 工单流转 → 执行 → 评估 → 回流策略」这一整条闭环在每个相关页面都看得见、点得进。

原语（`src/client/widgets.tsx`）：

```ts
interface LoopStep { label: string; value?: ReactNode; hint?: string; state?: 'done' | 'current' | 'pending'; icon?: IconName; onSelect?: () => void }
LoopTrack({ steps, label })
```

- DOM：`div.dt-loop` > `span.dt-loop-caption`? + `ol.dt-loop-track` > `li.dt-loop-step[data-state][aria-current="step"]` > `button.dt-loop-body.dt-loop-link`（有 `onSelect`）或 `div.dt-loop-body`。
- 每步内部：`.dt-loop-mark`（序号或图标）+ `.dt-loop-text` > `.dt-loop-label` / `.dt-loop-value` / `.dt-loop-hint`。
- `state` 只由真实数据推导：有计数即 `done`、计数为 0 即 `pending`、正在发生的那一环 `current`；**禁止**为了好看写死。
- 可点步骤的 `onSelect` 只做两件事：跳到对应页面（`navigate`）或滚动到本页对应区块；接不到真实目标就不给 `onSelect`。

落地位置：

| 页面 | 内容 | 当前步判定 |
| --- | --- | --- |
| 概览 `overview.tsx` | 到达 → 被过滤 → 触发 → 已评估 → 接单或续做 → 执行中 → 评估 → 回流策略，数字取 `GET overview` 的 flow / executor / policyVersion | 有执行中工单则「执行中」，否则评估中则「评估」 |
| 执行 `execution.tsx` | 决策 → 工单 → 执行中 → 评估 → 回流策略，数字取 `state.load` | 固定「执行中」——本页就是这一环 |
| 工单详情 `ticket.tsx` | 触发 → 决策 → 工单 → 执行 → 回报，取工单详情自身字段 | 由 `ticketStage` 映射（working→执行、person→工单、idle→回报） |
| 线程详情 `thread.tsx` | 触发 → 决策 → 回报 → 评估 → 回流 | 评估中→评估、queued→决策、subscribed→回报 |
| 评估 `eval.tsx` | 用列表里最新一条决策做样例：触发 → 规则命中 matched/total → 结论 → 工单 → 回流 | 固定「结论」 |

新增文案键（`src/client/locales.ts`）：`loopTitle`、`loopHint`、`loopCurrent`、`loopPending`、`loopDone`、`flowTriggeredLabel`、`flowDecidedLabel`、`flowTickedLabel`、`flowRunningLabel`、`flowEvaluatingLabel`、`flowReportedLabel`、`flowReturnedLabel`、`ticketLoop`、`decisionLoop`。既有 `flowReceivedLabel / flowFilteredLabel / flowDroppedLabel / flowJudgedLabel / flowAcceptedLabel` 继续复用。
