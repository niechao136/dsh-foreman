/**
 * Credential storage: the property under test is that the database alone is not enough to read a token.
 *
 * The panel, the settings snapshot and the CLI's own configuration all stay free of a plaintext secret; only the key
 * file beside the database can open one. A test that only checked "round-trips" would pass even if the value were
 * stored as JSON, so each case below asserts the failure mode too.
 */
import { readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { keyFile, seal, secretKey, unseal } from '../src/infra/secrets.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'secrets-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('credential storage', () => {
  it('creates a 32-byte key once, and reads the same key back', () => {
    const first = secretKey(dir)
    expect(first.length).toBe(32)
    expect(secretKey(dir)).toEqual(first)
    // Owner-only: the key is the one thing that makes the database's ciphertext readable. Windows has no POSIX mode
    // bits to assert, so the check is limited to the platforms where 0600 means something.
    if (process.platform !== 'win32') expect(statSync(keyFile(dir)).mode & 0o777).toBe(0o600)
  })
  it('round-trips a record, and the stored text does not contain the value', () => {
    const key = secretKey(dir)
    const sealed = seal(key, { appId: 'cli_abc', appSecret: 'super-secret-value' })
    expect(sealed).not.toContain('super-secret-value')
    expect(sealed.startsWith('v1:')).toBe(true)
    expect(unseal(key, sealed)).toEqual({ appId: 'cli_abc', appSecret: 'super-secret-value' })
    // Two seals of the same record differ: the nonce is random, so equal tokens are not identifiable by comparing rows.
    expect(seal(key, { appId: 'cli_abc' })).not.toBe(seal(key, { appId: 'cli_abc' }))
  })
  it('refuses a ciphertext written with another key, rather than returning empty values', () => {
    const sealed = seal(secretKey(dir), { token: 'ghp_value' })
    // A different state directory is a different installation: its key must not open this row.
    const other = mkdtempSync(join(tmpdir(), 'secrets-other-'))
    try { expect(() => unseal(secretKey(other), sealed)).toThrow() }
    finally { rmSync(other, { recursive: true, force: true }) }
  })
  it('refuses a tampered ciphertext and an unknown format', () => {
    const key = secretKey(dir)
    const sealed = seal(key, { token: 'ghp_value' })
    const parts = sealed.split(':')
    // Flip one byte of the body: GCM authentication must reject it instead of returning a truncated token.
    const body = Buffer.from(parts[3]!, 'base64url')
    body[0] = body[0]! ^ 0xff
    expect(() => unseal(key, [parts[0], parts[1], parts[2], body.toString('base64url')].join(':'))).toThrow()
    expect(() => unseal(key, 'v9:a:b:c')).toThrow('not v1 format')
  })
  it('rejects a damaged key file instead of silently generating another', () => {
    // Writing a new key would make every stored credential unreadable while looking like "nothing is configured".
    writeFileSync(keyFile(dir), Buffer.alloc(16))
    expect(() => secretKey(dir)).toThrow('32-byte key')
    expect(readFileSync(keyFile(dir)).length).toBe(16)
  })
})

/**
 * A credential stored by an earlier build was double-encoded, so the sealed text arrived wrapped in quotes.
 *
 * Unwrapping it keeps an existing token readable across the upgrade; a test that only covered fresh writes would let
 * every operator who had already saved a token be signed out by the fix meant to help them.
 */

it('reads a credential stored by an earlier build, which double-encoded the sealed text', () => {
  const key = secretKey(dir)
  const sealed = seal(key, { 'GH_TOKEN=token': 'ghp_legacy' })
  // The old write path left a JSON string literal in the record, quotes included.
  expect(unseal(key, JSON.stringify(sealed))).toEqual({ 'GH_TOKEN=token': 'ghp_legacy' })
  // New writes are unquoted and still readable, so the two shapes coexist.
  expect(unseal(key, sealed)).toEqual({ 'GH_TOKEN=token': 'ghp_legacy' })
})
