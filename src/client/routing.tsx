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

/** The comma-separated labels a row carries, which constrain which devices may take its work. */
function labelsCell(value: readonly string[] | undefined, onChange: (next: string[]) => void, label: string) {
  return <Cell label={label} required={false} value={(value ?? []).join(', ')}
    onChange={text => onChange(text.split(',').map(item => item.trim()).filter(item => item !== ''))} />
}

function ChatRows({ rows, onChange }: { rows: Draft<ChatRow>[]; onChange: (next: Draft<ChatRow>[]) => void }) {
  const { t } = usePanel()
  const edit = (index: number, patch: Partial<ChatRow>) =>
    onChange(rows.map((row, at) => at === index ? { ...row, ...patch } : row))
  return <Section title={t('routingChats')} hint={t('routingChatsHint')}
    action={<Button variant="ghost" size="sm" icon={<Icon name="plus" />}
      onClick={() => onChange([...rows, { key: newKey(), chatId: '', workspace: '' }])}>{t('routingAddChat')}</Button>}>
    {rows.length ? <ul className="dt-list">{rows.map((row, index) => <li className="dt-row" key={row.key}>
      <FieldGrid>
        <Cell label={t('routingChatId')} value={row.chatId} placeholder="oc_xxxxxxxx" onChange={chatId => edit(index, { chatId })} />
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

function RepositoryRows({ rows, onChange }: { rows: Draft<RepoRow>[]; onChange: (next: Draft<RepoRow>[]) => void }) {
  const { t } = usePanel()
  const edit = (index: number, patch: Partial<RepoRow>) =>
    onChange(rows.map((row, at) => at === index ? { ...row, ...patch } : row))
  return <Section title={t('routingRepositories')} hint={t('routingRepositoriesHint')}
    action={<Button variant="ghost" size="sm" icon={<Icon name="plus" />}
      onClick={() => onChange([...rows, { key: newKey(), repository: '', workspace: '' }])}>{t('routingAddRepository')}</Button>}>
    {rows.length ? <ul className="dt-list">{rows.map((row, index) => <li className="dt-row" key={row.key}>
      <FieldGrid>
        <Cell label={t('routingRepository')} value={row.repository} placeholder="owner/name"
          onChange={repository => edit(index, { repository })} />
        <Cell label={t('routingWorkspace')} value={row.workspace} placeholder="/home/me/src/project"
          onChange={workspace => edit(index, { workspace })} />
        {labelsCell(row.labels, labels => edit(index, { labels: labels.length ? labels : undefined }), t('routingLabels'))}
      </FieldGrid>
      <div className="dt-actions">
        <Button variant="ghost" size="sm" icon={<Icon name="trash" />}
          onClick={() => onChange(rows.filter((_, at) => at !== index))}>{t('remove')}</Button>
      </div>
    </li>)}</ul> : <Hint>{t('routingRepositoriesEmpty')}</Hint>}
  </Section>
}

function RoutingBlock() {
  const { t } = usePanel()
  const block = useSettings().settings.blocks.routing
  // Rows keep a synthetic key while edited and lose it on save, so the stored value is exactly the schema's shape.
  const [chats, setChats] = useState<Draft<ChatRow>[]>(() => labelled(block.value.chats))
  const [repos, setRepos] = useState<Draft<RepoRow>[]>(() => labelled(block.value.repositories))
  const saved: Routing = { chats: plain(chats), repositories: plain(repos) }
  const draft = useBlockDraft('routing', saved, block.revision)
  return <form className="dt-form dt-block" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <h2 className="dt-block-title">{t('routingTitle')}</h2>
      <p className="dt-flow">{t('routingIntro')}</p>
      <RepositoryRows rows={repos} onChange={setRepos} />
      <ChatRows rows={chats} onChange={setChats} />
    </Fields>
    <SaveBar {...draft} onDiscard={() => { draft.discard(); setChats(labelled(block.value.chats)); setRepos(labelled(block.value.repositories)) }} />
  </form>
}

export function RoutingSettings({ version }: { version?: string | undefined }) {
  return <div className="dt-form">
    <RoutingBlock />
    <ConfigHistory blocks={['routing']} versions {...version ? { focus: version } : {}} />
  </div>
}
