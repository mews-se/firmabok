import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { createLogger } from '@/lib/logger'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

const logger = createLogger('salary/personnummer')

/**
 * Get the encryption key from environment.
 * Falls back to a dev-only key for local development.
 */
function getEncryptionKey(): Buffer {
  const envKey = process.env.PERSONNUMMER_ENCRYPTION_KEY
  if (!envKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('PERSONNUMMER_ENCRYPTION_KEY is required in production')
    }
    // Dev-only deterministic key (NOT safe for production)
    return scryptSync('dev-only-key', 'gnubok-dev-salt', 32)
  }
  // Use scrypt to derive a 32-byte key from the env var
  return scryptSync(envKey, 'gnubok-pnr-salt', 32)
}

/**
 * Encrypt a personnummer for storage.
 * Returns a hex string: iv + ciphertext + authTag
 */
export function encryptPersonnummer(personnummer: string): string {
  const key = getEncryptionKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  let encrypted = cipher.update(personnummer, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag()

  return iv.toString('hex') + encrypted + authTag.toString('hex')
}

/**
 * Decrypt a personnummer from storage.
 */
export function decryptPersonnummer(encrypted: string): string {
  // Tolerate legacy/unencrypted rows. A raw 12-digit personnummer (written by
  // a path that skipped encryptPersonnummer, e.g. the v1 REST create route
  // before this fix, or a seed) would otherwise be sliced as iv/ciphertext/tag
  // and throw ERR_CRYPTO_INVALID_AUTH_TAG ("Invalid authentication tag length:
  // 6"), 500-ing every decrypt-on-read path (roster, salary runs, payslips,
  // KU, AGI, MCP). Real ciphertext is 80 hex chars, so a 12-digit match is
  // unambiguously plaintext. Return it as-is and warn so the backfill can find
  // and re-encrypt it. Value is never logged. See DECISIONS.md.
  if (/^\d{12}$/.test(encrypted)) {
    logger.warn('decryptPersonnummer received an unencrypted personnummer; returning as-is (row needs backfill)')
    return encrypted
  }

  const key = getEncryptionKey()
  const ivHex = encrypted.slice(0, IV_LENGTH * 2)
  const authTagHex = encrypted.slice(-TAG_LENGTH * 2)
  const ciphertext = encrypted.slice(IV_LENGTH * 2, -TAG_LENGTH * 2)

  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

/**
 * Extract the last 4 digits of a personnummer for display.
 */
export function extractLast4(personnummer: string): string {
  const digits = personnummer.replace(/\D/g, '')
  return digits.slice(-4)
}

/**
 * Validate a Swedish personnummer or samordningsnummer (12-digit format:
 * YYYYMMDDNNNN). Checks format + Luhn checksum on last 10 digits.
 *
 * A samordningsnummer is the identity number Skatteverket assigns to a person
 * who has no personnummer. It has the same shape, except the day field carries
 * an added 60, so the printed day is 61-91 instead of 1-31. Skatteverket files
 * these under FK215 in the arbetsgivardeklaration exactly like a personnummer,
 * and our own AGI generator accepts them (see IDENTITET_PATTERN in
 * lib/salary/agi/xml-generator.ts, which spells out "samordningsnummer where
 * day = actual_day + 60"). Rejecting them here meant the system could file an
 * AGI for someone it refused to register as an employee.
 *
 * The Luhn check digit is computed over the printed digits, the +60 day
 * included: a samordningsnummer has no underlying non-offset form to compute it
 * from. So the checksum below is deliberately untouched by the offset.
 */
export function validatePersonnummer(personnummer: string): { valid: boolean; error?: string } {
  const digits = personnummer.replace(/\D/g, '')

  if (digits.length !== 12) {
    return { valid: false, error: 'Personnummer måste vara 12 siffror (ÅÅÅÅMMDDNNNN)' }
  }

  const year = parseInt(digits.slice(0, 4))
  const month = parseInt(digits.slice(4, 6))
  const day = parseInt(digits.slice(6, 8))

  if (year < 1900 || year > 2100) {
    return { valid: false, error: 'Ogiltigt år' }
  }
  if (month < 1 || month > 12) {
    return { valid: false, error: 'Ogiltig månad' }
  }
  // Strip the samordningsnummer offset before range-checking the day, so both
  // forms collapse to a real 1-31 calendar day. This accepts 1-31 (personnummer)
  // and 61-91 (samordningsnummer) while still rejecting 32-60 and 92-99, which
  // are neither: 32-60 is an out-of-range day that has not been offset, and
  // 92-99 offsets back to day 32-39.
  const birthDay = day > 60 ? day - 60 : day
  if (birthDay < 1 || birthDay > 31) {
    return { valid: false, error: 'Ogiltig dag' }
  }

  // Luhn check on digits 3-12 (YYMMDDNNNN, 10 digits)
  const luhnDigits = digits.slice(2)
  if (!luhnCheck(luhnDigits)) {
    return { valid: false, error: 'Ogiltigt kontrollnummer (Luhn)' }
  }

  return { valid: true }
}

/**
 * Luhn checksum validation for 10-digit string.
 */
function luhnCheck(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = parseInt(digits[i])
    // Multiply every other digit by 2, starting from the first
    if (i % 2 === 0) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}
