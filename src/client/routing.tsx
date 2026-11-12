/**
 * Routing settings group: which chat, and which repository, belongs to which project.
 *
 * This is the one page that answers "where does this work run". A Feishu message names a chat and a GitHub Trigger
 * names a repository, but neither names a directory; without this table a GitHub ticket is prepared with no project,
 * so `prepareTicket` cannot name a device and the work always runs on the host. The repository half exists for that
 * reason rather than as an optional extra.
 *
 * Both halves are edited as rows, not as JSON: a chat id and a repository name are long opaque strings, and a table
 * with one column per fact is what makes them checkable at a glance.
 */
import { useState } from 'react'
import type { SettingsView } from './api.ts'
import { Button, Icon, Input } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { usePanel } from './provider.tsx'
import { ConfigHistory, Field, FieldGrid, Fields, useBlockDraft, useSettings } from './settings-kit.tsx'
import { Hint, Section } from './widgets.tsx'

type Routing = SettingsView['blocks']['routing']['value']
type ChatRow = Routing['chats'][number]
type RepoRow = Routing['repositories'][number]
/** A project as the page edits it: one directory, one set of device labels, and every repository that runs there. */
type Project = { workspace: string; labels?: string[]; repositories: string[] }
/** A draft row keeps its list position stable while it is edited, so a key never moves under the cursor. */
type Draft<Row> = Row & { key: string }

const newKey = (): string => `row-${Math.random().toString(36).slice(2)}`
const labelled = <Row extends object>(rows: readonly Row[]): Draft<Row>[] => rows.map(row => ({ ...row, key: newKey() }))
const plain = <Row extends object>(rows: readonly Draft<Row>[]): Row[] =>
  rows.map(({ key: _key, ...rest }) => rest as Row)

/** One editable cell: an input whose change replaces a single field of one row. */
function Cell({ label, value, placeholder, onChange, required = true }: {
  label: string; value: string; placeholder?: string; onChange: (next: string) => void; required?: boolean
}) {
  return <Field label={label} required={required}>
    <Input value={value} placeholder={placeholder} required={required} onChange={event => onChange(event.target.value)} />
  </Field>
}

/**
 * One cell that offers the known values as a dropdown, falling back to free text.
 *
 * A chat id and a repository name are long opaque strings; picking them from what the Sources already know avoids the
 * typo that would silently route nothing. Free text stays available for a value the Sources have not seen yet.
 */
function SelectCell({ label, value, options, onChange, required = true }: {
  label: string; value: string; options: { value: string; label: string }[]; onChange: (next: string) => void; required?: boolean
}) {
  const { t } = usePanel()
  const known = options.some(option => option.value === value)
  // 已知值走下拉；未知值（还没刷新过、或手填的）退化成文本框，否则旧配置会被硬塞成第一个选项。
  if (!options.length) return <Cell label={label} value={value} required={required} onChange={onChange} />
  return <Field label={label} required={required}>
    <select className="dt-select" value={known ? value : ''} required={required} onChange={event => onChange(event.target.value)}>
      <option value="">{t('routingChoose')}</option>
      {value && !known ? <option value={value}>{value}</option> : null}
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </Field>
}

/** The comma-separated labels a row carries, which constrain which devices may take its work. */
function labelsCell(value: readonly string[] | undefined, onChange: (next: string[]) => void, label: string) {
  return <Cell label={label} required={false} value={(value ?? []).join(', ')}
    onChange={text => onChange(text.split(',').map(item => item.trim()).filter(item => item !== ''))} />
}

function ChatRows({ rows, onChange, chats }: {
  rows: Draft<ChatRow>[]; onChange: (next: Draft<ChatRow>[]) => void
  chats: { value: string; label: string }[]
}) {
  const { t } = usePanel()
  const edit = (index: number, patch: Partial<ChatRow>) =>
    onChange(rows.map((row, at) => at === index ? { ...row, ...patch } : row))
  return <Section title={t('routingChats')} hint={t('routingChatsHint')}
    action={<Button variant="ghost" size="sm" icon={<Icon name="plus" />}
      onClick={() => onChange([...rows, { key: newKey(), chatId: '', workspace: '' }])}>{t('routingAddChat')}</Button>}>
    {rows.length ? <ul className="dt-list">{rows.map((row, index) => <li className="dt-row" key={row.key}>
      <FieldGrid>
        <SelectCell label={t('routingChatId')} value={row.chatId} options={chats}
          onChange={chatId => edit(index, { chatId })} />
        <Cell label={t('routingWorkspace')} value={row.workspace} placeholder="/home/me/src/project"
          onChange={workspace => edit(index, { workspace })} />
        {labelsCell(row.labels, labels => edit(index, { labels: labels.length ? labels : undefined }), t('routingLabels'))}
      </FieldGrid>
      <div className="dt-actions">
        <Button variant="ghost" size="sm" icon={<Icon name="trash" />}
          onClick={() => onChange(rows.filter((_, at) => at !== index))}>{t('remove')}</Button>
      </div>
    </li>)}</ul> : <Hint>{t('routingChatsEmpty')}</Hint>}
  </Section>
}

/**
 * Group stored repository rows into projects.
 *
 * The stored shape is one row per repository, because the lookup is per repository and a repository belongs to one
 * project. What an operator thinks in is the opposite: one checkout that serves several repositories — a package and
 * its companion, say — with one directory and one set of device labels. Rows are therefore grouped back into projects
 * for editing, by the pair that defines a project, and written out again as one row per repository.
 *
 * Grouping by `workspace` + `labels` rather than by directory alone matters: two rows naming the same directory but
 * different device labels are genuinely two projects (the labels constrain who may take the work), and merging them
 * would silently widen one of them.
 */
function projectsOf(rows: readonly RepoRow[]): Draft<Project>[] {
  const groups = new Map<string, Draft<Project>>()
  for (const row of rows) {
    // Sorted labels: `['a','b']` and `['b','a']` name the same set, and must not split into two projects.
    const labels = [...(row.labels ?? [])].sort()
    const id = JSON.stringify([row.workspace, labels])
    const existing = groups.get(id)
    if (existing) existing.repositories.push(row.repository)
    else groups.set(id, { key: newKey(), workspace: row.workspace, labels: labels.length ? labels : undefined,
      repositories: [row.repository] })
  }
  return [...groups.values()]
}
/** One row per repository, in project order, which is the shape the settings schema and the lookup both expect. */
const repoSettings = (projects: readonly Draft<Project>[]): RepoRow[] =>  projects.flatMap(project => project.repositories
    .filter(repository => repository !== '')
    .map(repository => ({ repository, workspace: project.workspace, ...project.labels?.length ? { labels: [...project.labels] } : {} })))

/** The projects the operator may choose from, and the repositories they may put in one. */
function ProjectRow({ project, repositories, onChange }: {
  project: Draft<Project>; repositories: { value: string; label: string }[]
  onChange: (next: Draft<Project>) => void
}) {
  const { t } = usePanel()
  const toggle = (name: string) => {
    const has = project.repositories.includes(name)
    onChange({ ...project, repositories: has ? project.repositories.filter(item => item !== name) : [...project.repositories, name] })
  }
  // A stored repository the GitHub Source no longer lists still shows, so an edit never drops it without a word.
  const known = new Set(repositories.map(option => option.value))
  const extra = project.repositories.filter(name => !known.has(name))
  return <li className="dt-row">
    <FieldGrid>
      <Cell label={t('routingWorkspace')} value={project.workspace} placeholder="/home/me/src/project"
        onChange={workspace => onChange({ ...project, workspace })} />
      {labelsCell(project.labels, labels => onChange({ ...project, labels: labels.length ? labels : undefined }), t('routingLabels'))}
    </FieldGrid>
    <Field label={t('routingProjectRepositories')}>
      {repositories.length || extra.length ? <div className="dt-checklist">
        {repositories.map(option => <label key={option.value} className="dt-check">
          <input type="checkbox" checked={project.repositories.includes(option.value)} onChange={() => toggle(option.value)} />
          <span>{option.label}</span>
        </label>)}
        {extra.map(name => <label key={name} className="dt-check">
          <input type="checkbox" checked onChange={() => toggle(name)} />
          <span>{t('routingRepositoryUnknown', { name })}</span>
        </label>)}
      </div> : <Hint>{t('routingNoRepositories')}</Hint>}
    </Field>
    {project.repositories.length > 1 && <p className="dt-hint">{t('routingSharedWorkspace', { count: String(project.repositories.length) })}</p>}
  </li>
}

function ProjectRows({ projects, onChange, repositories }: {
  projects: Draft<Project>[]; onChange: (next: Draft<Project>[]) => void
  repositories: { value: string; label: string }[]
}) {
  const { t } = usePanel()
  const edit = (index: number, next: Draft<Project>) => onChange(projects.map((item, at) => at === index ? next : item))
  // 一个仓库只能属于一个项目：被别的项目占用的仓库在这里标出来，避免同一个仓库落进两个目录。
  const taken = new Set(projects.flatMap(project => project.repositories))
  return <Section title={t('routingRepositories')} hint={t('routingRepositoriesHint')}
    action={<Button variant="ghost" size="sm" icon={<Icon name="plus" />}
      onClick={() => onChange([...projects, { key: newKey(), workspace: '', repositories: [] }])}>{t('routingAddProject')}</Button>}>
    {projects.length ? <ul className="dt-list">{projects.map((project, index) => <li className="dt-row" key={project.key}>
      <ProjectRow project={project} repositories={repositories} onChange={next => edit(index, next)} />
      <div className="dt-actions">
        <Button variant="ghost" size="sm" icon={<Icon name="trash" />}
          onClick={() => onChange(projects.filter((_, at) => at !== index))}>{t('remove')}</Button>
      </div>
    </li>)}</ul> : <Hint>{t('routingRepositoriesEmpty')}</Hint>}
    {taken.size > 0 && <Hint>{t('routingRepositoryTaken')}</Hint>}
  </Section>
}

/**
 * The values the Sources already know, as dropdown options.
 *
 * Chats come from the Feishu Source's stored chat names; repositories from the GitHub Source's configured list. Both
 * are read from settings the panel already has, so the page needs no extra request.
 *
 * The workspace column stays free text: the panel never receives a device's paths (only its project names), and a
 * project directory has to be the absolute path on the machine that runs the work, so guessing one would be worse
 * than asking for it.
 */
function useChoices() {
  const { sources } = useSettings().settings
  const labels = (id: string) => (sources.find(source => source.id === id)?.labels ?? {})
  const chats = Object.entries(labels('feishu'))
    .sort(([, left], [, right]) => left.localeCompare(right))
    .map(([value, label]) => ({ value, label: `${label} (${value})` }))
  const configured = sources.find(source => source.id === 'github')?.value.config.repositories
  const repositories = (Array.isArray(configured) ? configured : [])
    .map(row => String((row as { repository?: unknown }).repository ?? '')).filter(name => name !== '')
    .map(value => ({ value, label: value }))
  return { chats, repositories }
}

function RoutingBlock() {
  const { t } = usePanel()
  const block = useSettings().settings.blocks.routing
  // Rows keep a synthetic key while edited and lose it on save, so the stored value is exactly the schema's shape.
  const [chats, setChats] = useState<Draft<ChatRow>[]>(() => labelled(block.value.chats))
  // Repositories are edited as projects, then written back as one row per repository.
  const [projects, setProjects] = useState<Draft<Project>[]>(() => projectsOf(block.value.repositories))
  // `saved` is the STORED value. The earlier code passed the edited rows as `saved`, so every draft compared equal to
  // itself, `dirty` stayed false, and the SaveBar — the only way to apply a change — never rendered.
  const draft = useBlockDraft<Routing>('routing', block.value, block.revision)
  const { chats: chatChoices, repositories } = useChoices()
  const write = (nextChats: Draft<ChatRow>[], nextProjects: Draft<Project>[]) => draft.edit({ chats: plain(nextChats),
    repositories: repoSettings(nextProjects) })
  const editChats = (next: Draft<ChatRow>[]) => { setChats(next); write(next, projects) }
  const editProjects = (next: Draft<Project>[]) => { setProjects(next); write(chats, next) }
  const reset = () => {
    draft.discard()
    setChats(labelled(block.value.chats))
    setProjects(projectsOf(block.value.repositories))
  }
  return <form className="dt-form dt-block" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <h2 className="dt-block-title">{t('routingTitle')}</h2>
      <p className="dt-flow">{t('routingIntro')}</p>
      <ProjectRows projects={projects} onChange={editProjects} repositories={repositories} />
      <ChatRows rows={chats} onChange={editChats} chats={chatChoices} />
    </Fields>
    <SaveBar {...draft} onDiscard={reset} />
  </form>
}

export function RoutingSettings({ version }: { version?: string | undefined }) {
  return <div className="dt-form">
    <RoutingBlock />
    <ConfigHistory blocks={['routing']} versions {...version ? { focus: version } : {}} />
  </div>
}
