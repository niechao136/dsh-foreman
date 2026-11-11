/** Settings view combining versioned configuration blocks, per-source forms and policy metadata, and execution environment details. */
import { KV } from '../../kv.ts'
import { secretKey, unseal } from '../../infra/secrets.ts'
import { policyVersion } from '../../policy.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import { declaredVariables, executionRoot } from '../execution-environment.ts'
import type { Store } from '../store.ts'
import { problemOf, sourceHealth, type HealthMap, type SetupState } from './sources.ts'

/**
 * The Source's stored credential, decrypted for the panel.
 *
 * It is returned so the card can show which fields are filled without ever sending a value back: the view marks each
 * key as configured and leaves the text empty. Returning the plaintext to a browser would spread a token into a page,
 * its devtools, and any screenshot of it, for no gain — the operator only needs to know it is there.
 */
function secretOf(store: Store, id: string, stateDir: string): { secret: Record<string, string>; secretSet: string[] } {
  const sealed = store.get(KV.sources.secret(id))
  if (sealed === undefined) return { secret: {}, secretSet: [] }
  try {
    const values = unseal(secretKey(stateDir), sealed)
    // Every key reports as "set", with an empty value: the form then renders a placeholder rather than the token.
    return { secret: Object.fromEntries(Object.keys(values).map(key => [key, ''])),
      secretSet: Object.keys(values).sort() }
  } catch {
    // A row that cannot be decrypted is reported as absent rather than crashing the settings page; saving again
    // replaces it.
    return { secret: {}, secretSet: [] }
  }
}

function policyOf(sources: SourceRegistry, id: string, health: HealthMap) {
  const policy = sources.kind(id)?.policy
  if (!policy) return {}
  const part = sources.policyPart(id)!
  const config = sources.instance(id)?.config ?? {}
  const sync = policy.sync && { label: policy.sync.label, ready: policy.sync.ready(part), health: health[`sync:${id}`] }
  return { policy: { fields: policy.fields, explicit: policy.explicit, ...policy.rows ? { rows: policy.rows(config) } : {}, ...sync
    ? { sync } : {} } }
}
/**
 * Builds the settings view by block (`{ value, revision }`), per-Source configuration and restart-sensitive fields,
 * and execution environment details (`stateDir` provides the default ticket working directory root).
 */
export function settingsView(store: Store, sources: SourceRegistry, health: HealthMap, setup: SetupState, stateDir: string) {
  const settings = store.settings()
  const block = <V>(name: 'policy' | 'eval' | 'executor' | 'routing', value: V) => ({ value, revision: store.blockRevision(name) })
  return {
    policyVersion: policyVersion(settings),
    blocks: { policy: block('policy', settings.policy), eval: block('eval', settings.eval), executor: block('executor',
      settings.executor), routing: block('routing', settings.routing) },
    sources: sources.instances(settings).map(instance => {
      const kind = sources.kind(instance.kind)
      const problem = problemOf(instance.id, setup)
      const { id, title } = sourceHealth(sources, instance, health)
      return { id, kind: instance.kind, title, description: kind?.description ?? { zh: '', en: '' }, installed: instance.installed,
        value: { enabled: instance.enabled, config: instance.config }, revision: store.blockRevision(`source:${instance.id}`),
        restarts: kind?.setupFields ?? [], fields: kind?.fields ?? [], facts: kind?.facts?.(setup.deployment) ?? {},
        labels: store.get(KV.sources.labels(instance.id)) ?? {}, ...secretOf(store, instance.id, stateDir),
        clis: store.get(KV.sources.clis(instance.id)) ?? [],
        ...problem ? { problem } : {}, ...policyOf(sources, instance.id, health) }
    }),
    environment: { root: executionRoot(settings, stateDir), variables: declaredVariables(sources, settings) },
  }
}
export type SettingsView = ReturnType<typeof settingsView>
export type SourceSettingsView = SettingsView['sources'][number]
