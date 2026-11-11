/**
 * Encrypted credential storage for the account CLIs.
 *
 * The values live in the same SQLite database as everything else, so the protection has to come from encryption
 * rather than from file permissions: a copied database or a backup must not hand over a GitHub token. The key is kept
 * beside the database in a file the operator's account owns, and is never written into the database itself — that is
 * the one property that makes copying the database alone useless.
 *
 * 为什么不用 CLI 自己的凭据存储：那需要让 foreman 以 lark-cli config init / gh auth login 的身份去写另一个工具的
 * 私有格式，且两个 CLI 的格式各自变化。这里只把值加密保存，再按 CLI 支持的官方环境变量注入。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Format version of a stored ciphertext, so a later change can tell old rows apart. */
const VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'
/** 12 bytes is the GCM nonce size; a longer one is hashed internally and loses the guarantee. */
const NONCE_BYTES = 12
const TAG_BYTES = 16

/**
 * The key file beside the database.
 *
 * Kept out of the database on purpose: whoever obtains only the `.sqlite` file, its WAL, or a backup of the state
 * directory's database still cannot read a token. It is created `0600` and never printed.
 */
export const keyFile = (stateDir: string): string => join(stateDir, 'secret.key')

/**
 * Reads the encryption key, creating it the first time.
 *
 * @throws When the file exists but is not 32 bytes: that is a damaged key, and continuing would silently make every
 *   stored credential unreadable while looking like "no credentials configured".
 */
export function secretKey(stateDir: string): Buffer {
  const file = keyFile(stateDir)
  try {
    const key = readFileSync(file)
    if (key.length !== 32) throw new Error(`${file} is not a 32-byte key; restore it or delete it to start over (stored credentials become unreadable)`)
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const key = randomBytes(32)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, key, { mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* A filesystem without POSIX modes already restricts it by directory. */ }
  return key
}

/**
 * Encrypts one JSON value into `v1:<iv>:<tag>:<ciphertext>`, all base64url.
 *
 * @param key 32-byte key from {@link secretKey}.
 * @param value Any JSON-serializable record; it is stringified with sorted keys so equal values encrypt differently
 *   (the nonce is random) but tests can still compare structure after decryption.
 */
export function seal(key: Buffer, value: Record<string, string>): string {
  const iv = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  // AAD binds the ciphertext to this format version: a row written by a future format cannot be misread as this one.
  cipher.setAAD(Buffer.from(VERSION))
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join(':')
}

/**
 * Decrypts a value produced by {@link seal}.
 *
 * @throws When the format is unknown or authentication fails; both mean the row cannot be trusted, and returning an
 *   empty record would silently run the CLI as nobody.
 */
export function unseal(key: Buffer, sealed: string): Record<string, string> {
  const [version, iv, tag, body] = sealed.split(':')
  if (version !== VERSION || !iv || !tag || body === undefined) throw new Error(`Stored credential is not ${VERSION} format`)
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'))
  decipher.setAAD(Buffer.from(VERSION))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  const plain = Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()])
  const parsed: unknown = JSON.parse(plain.toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Stored credential is not a record')
  return Object.fromEntries(Object.entries(parsed).map(([name, value]) => [name, String(value)]))
}

/** Length of the authentication tag, exported so a test can assert the format rather than guess it. */
export const tagBytes = TAG_BYTES
