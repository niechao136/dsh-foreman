# 005 Panel

Open **Superagent** in the DeepSeek Harness Web sidebar to supervise the agent. The panel prioritizes work that needs a person, then system health and history. This document builds on [000 Philosophy](000-philosophy.md) through [004 Prompts](004-prompts.md).

## Three questions

Opening the panel answers three questions, in this order:

1. Does anything need me now?
2. Is the system healthy and doing the right things?
3. What is the history of one piece of work, from Trigger through Eval to Ticket?

## Tabs

The tabs follow the work people watch: **Overview**, **Eval**, **Execution**, and **Settings**. Eval is the Decision log, because what was decided and why is the question this panel exists to answer; its log opens on **All** Decisions so the period is visible at once, and the pills narrow it rather than serving as the entrance. The Trigger history has no tab of its own: every Trigger, Decision, Ticket and dropped reply is in **Settings › Logs**, one filterable list that also answers `GET logs`, so a person can read the raw stream there and an agent can read the same thing without the panel. Sources no longer have a tab of their own: Overview shows each Source's state and its last day's counts, and Settings › Source holds their configuration. Until the repositories and the accounts are set up, Overview shows what is missing and links to the relevant setting.

| Tab | Shows |
| --- | --- |
| Overview | Tickets needing action, system problems, one line per Source with its state, activity counts for the last 24 hours, and Executor load. Each block links to its detailed page |
| Execution | The Ticket list filtered by Open, Pending, Working, Waiting for a Trigger or Ended, with Pause processing as the page action. Each Ticket shows its stage, and a running Ticket opens its Session from the row |
| Eval | Metrics for the period (all Decisions, accept/reopen, stop, ignore, unavailable) above the Decision log, filtered by All, accept/reopen, stop, ignore, unavailable and by the last 24 hours. The selected Decision's reasons, matched rules and the context Eval saw are in the right-hand column; the row list is the history |
| Settings | Sources, Policy, Eval, Execution, Projects, Devices, Prompts, Deployment and Logs. Each group includes its save history |
| Settings › Logs | Every Trigger, Decision, Ticket event and dropped reply merged by time, filtered by kind, level (info, warn, error) and free text, with links back to the Thread, Decision or Ticket. The page says it is `GET /orchestrator/api/logs` |

### Reading individual records

A dropped message links to its Ticket, or to its Thread when it has no Ticket. Its reason says whether the conversation disappeared or the Source stopped listening to it, and Settings › Source shows what that Source listens to.

A human follow-up still owned by an Executor is marked **Delivered to Ticket**, without an Eval. The Thread also shows hand-back reasons and context-only Subscriptions. **Evaluate again** can send that follow-up to Eval, or retry a Trigger with no effective judgement: one filtered by its Source, an unavailable Eval, or a delivered message with neither a non-stop Decision nor an Executor acknowledgement.

Ticket details show the originating Trigger, Decision and reason, scope and Policy version. Assignments and secondary details are folded below the immediate actions. **Retry** is available for failed Input delivery or a Ticket waiting for a person after a blocked or failed Report. Ended Tickets show outcomes such as **Pull request merged** or **Stopped by a person**.

## Settings groups

- **Sources:** one card per Source with its switch, fields and verified account facts. GitHub also offers receive-all switches for new Issues, pull requests, comments and default-branch CI. Polling and read limits are under Advanced.
- **Policy:** the accept rules, the Policy version, and **On each Source**. Each Source tab contains its allowed list, membership sync, admission table and bot list. Sync runs at startup and on **Sync now**. The admission table distinguishes receiving scope, sender membership and whether the message addresses the agent.

  Why a group of its own: these fields used to sit inside Eval with no navigation entry, so "who may originate work" could not be edited from the panel at all. With `policy.sources` empty, the admission defaults admit nobody, and every message was rejected as **sender not on the Source's list**.
- **Eval:** the accept mode (**off**, **observe**, **auto**), the timeout and the assessment model.
- **Projects** (项目对应): which chat, and which repositories, belong to which project directory, and which device labels that work needs. Repositories are edited as projects: a project is one directory plus a group of repositories, so a package and its companion share one directory and one set of labels. The stored shape stays one row per repository, because the lookup is per repository; grouping happens for editing only. **An unlisted repository runs on the host**, since without a project the ticket cannot name a device.
- **Execution:** worker model, concurrency, directory root, prepare command and blocked commands. Clicking an available variable inserts it into the prepare command.
- **Prompts:** **Edit** changes team sections, built-in parts and skills. **Full prompt** shows the assembled text and compares it with saved text or defaults. **History** lists versions. Edited built-in parts are marked changed and can be reset; templates list their required placeholders.

  An upgrade that changes an overridden default marks it **Default updated** (默认内容已更新). The panel compares the old and new defaults above the team's text. If the old default was not recorded, it compares the team's text with the new default instead. Choose **Keep my text** or **Use the new default**. Overrides for removed parts are listed below the tab bar and dropped on the next save.
- **Deployment:** startup problems with **Check again**, the state directory and machine limits. Saved limits apply without restart. The DeepSeek Harness Plugin Manager exposes the same page.

## Search

The header search finds Triggers by text, id, Feishu message id or a stored link, such as a GitHub comment URL. A Feishu link missing from the original message becomes searchable only after the host reads it during the current process lifetime.

Search also finds Threads by references such as `#12` or a GitHub URL, and Tickets by title or a matching Thread.

## Adding a Source

A new Source appears throughout the panel without changes here. Register its `SourceKind` in the Source's own plugin and declare, in that module, the configuration `fields`, the `health` entries with their `healthCodes` labels and `mode`, the `setupFields` whose change re-runs setup, and any setup problem it raises through its own `ProblemSpec`. The Source tab, its settings card, the Overview problem row and the restart notice then follow that declaration. The architecture guide (007) has the contract, and `tests/extension-source.spec.ts` is the proof.

## Principles

1. **Focus on what matters.** Every element answers one of the three questions, or it is removed. A number appears only when it changes what the supervisor does.
2. **Precise definitions.** Categories have checkable definitions, are mutually exclusive and cover every case, as the Ticket stages do. A label says whom a row waits for and what it needs, not an internal status code.
3. **One place per concept.** Source state belongs in Source; Decisions in Eval, raw Triggers and replies in Settings › Logs, Tickets in Execution. Settings are grouped by the concept they configure. Overview summarizes these pages and links to them instead of becoming another detailed view.
4. **Domain structure.** The panel uses the domain terms. Internal identifiers appear only in folded details, and names replace identifiers where they can be resolved.
5. **Honest state.** A count equals the length of the list it links to, and no state contradicts another fact.
6. **Quiet by default.** Healthy states take no extra space. Problems must be actionable; a one-off network error is not enough. Rows needing a person offer their action directly. Keep page explanations to one sentence and put further detail in the (?) tooltip. Destructive actions require confirmation.
7. **Consistent controls.** Use DeepSeek Harness design tokens and control behavior. The same information should look the same throughout the panel. Each settings block has one save bar, visible only while changes exist, a save runs or a save fails.
