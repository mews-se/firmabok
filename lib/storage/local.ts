import { createHmac, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Filesystem-backed object storage.
 *
 * Replaces the supabase storage-api service: buckets are directories under
 * STORAGE_DIR (a named volume in the self-hosted stack) and every operation
 * mirrors the {data, error} result shape of supabase-js storage, so call
 * sites read the same either way. Authorization happens in the API routes
 * and services that call this module - there is no RLS layer here, which
 * matches how the routes already worked: they validated membership against
 * the database before touching storage.
 *
 * Signed URLs point at /api/files (app/api/files/[...path]/route.ts): an
 * HMAC over bucket, key and expiry, keyed with the service-role secret that
 * never leaves the server. Public URLs are only honoured for PUBLIC_BUCKETS.
 */

/** Buckets whose objects may be read without a signature (logo images). */
export const PUBLIC_BUCKETS = new Set(['logos'])

// Production default matches the volume mount in docker-compose.yml; dev and
// tests fall back to a checkout-local directory (gitignored).
export function storageRootDir(): string {
  if (process.env.STORAGE_DIR) return process.env.STORAGE_DIR
  return process.env.NODE_ENV === 'production' ? '/var/lib/firmabok-storage' : '.storage'
}

function signingSecret(): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for signed file URLs')
  return secret
}

function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')
}

type StorageError = { message: string } | null

/**
 * Resolve bucket/key to an absolute path under the storage root, rejecting
 * traversal. The key is used verbatim as a relative path, matching how the
 * storage-api laid keys out, so existing key-building helpers keep working.
 */
function resolveObjectPath(bucket: string, key: string): string {
  const root = path.resolve(storageRootDir())
  const abs = path.resolve(root, bucket, key)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('Invalid storage path')
  }
  return abs
}

function toError(err: unknown): { message: string } {
  return { message: err instanceof Error ? err.message : String(err) }
}

/** Absolute on-disk path for an object: for the /api/files route. */
export function objectDiskPath(bucket: string, key: string): string {
  return resolveObjectPath(bucket, key)
}

export function signFilePayload(bucket: string, key: string, expiresAtMs: number, method: 'GET' | 'PUT'): string {
  return createHmac('sha256', signingSecret())
    .update(`${method}\n${bucket}\n${key}\n${expiresAtMs}`)
    .digest('base64url')
}

export function verifyFileSignature(
  bucket: string,
  key: string,
  expiresAtMs: number,
  method: 'GET' | 'PUT',
  signature: string
): boolean {
  if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) return false
  const expected = signFilePayload(bucket, key, expiresAtMs, method)
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}

function signedFileUrl(bucket: string, key: string, expiresInSeconds: number, method: 'GET' | 'PUT'): string {
  const exp = Date.now() + expiresInSeconds * 1000
  const sig = signFilePayload(bucket, key, exp, method)
  const encodedKey = key.split('/').map(encodeURIComponent).join('/')
  return `${appBaseUrl()}/api/files/${bucket}/${encodedKey}?exp=${exp}&sig=${sig}${method === 'PUT' ? '&upload=1' : ''}`
}

export interface StoredObjectInfo {
  name: string
  id: string
  created_at: string
}

class LocalBucket {
  constructor(private bucket: string) {}

  async download(key: string): Promise<{ data: Blob | null; error: StorageError }> {
    try {
      const buf = await fs.readFile(resolveObjectPath(this.bucket, key))
      return { data: new Blob([new Uint8Array(buf)]), error: null }
    } catch (err) {
      return { data: null, error: toError(err) }
    }
  }

  async upload(
    key: string,
    body: ArrayBuffer | Uint8Array | Blob,
    options?: { contentType?: string; upsert?: boolean }
  ): Promise<{ data: { path: string } | null; error: StorageError }> {
    try {
      const abs = resolveObjectPath(this.bucket, key)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      const bytes =
        body instanceof Blob
          ? Buffer.from(await body.arrayBuffer())
          : body instanceof Uint8Array
            ? Buffer.from(body)
            : Buffer.from(new Uint8Array(body))
      await fs.writeFile(abs, bytes, { flag: options?.upsert ? 'w' : 'wx' })
      return { data: { path: key }, error: null }
    } catch (err) {
      return { data: null, error: toError(err) }
    }
  }

  async move(fromKey: string, toKey: string): Promise<{ error: StorageError }> {
    try {
      const target = resolveObjectPath(this.bucket, toKey)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.rename(resolveObjectPath(this.bucket, fromKey), target)
      return { error: null }
    } catch (err) {
      return { error: toError(err) }
    }
  }

  async remove(keys: string[]): Promise<{ error: StorageError }> {
    try {
      for (const key of keys) {
        await fs.rm(resolveObjectPath(this.bucket, key), { force: true })
      }
      return { error: null }
    } catch (err) {
      return { error: toError(err) }
    }
  }

  async list(
    prefix: string,
    options?: { limit?: number; offset?: number; sortBy?: { column: string; order: string } }
  ): Promise<{ data: StoredObjectInfo[] | null; error: StorageError }> {
    try {
      const dir = resolveObjectPath(this.bucket, prefix)
      let names: string[]
      try {
        names = await fs.readdir(dir)
      } catch {
        return { data: [], error: null }
      }
      const items: Array<StoredObjectInfo & { mtimeMs: number }> = []
      for (const name of names) {
        const st = await fs.stat(path.join(dir, name)).catch(() => null)
        if (!st?.isFile()) continue
        items.push({ name, id: name, created_at: st.mtime.toISOString(), mtimeMs: st.mtimeMs })
      }
      const ascending = options?.sortBy?.order !== 'desc'
      items.sort((a, b) => (ascending ? a.mtimeMs - b.mtimeMs : b.mtimeMs - a.mtimeMs))
      const offset = options?.offset ?? 0
      const limit = options?.limit ?? items.length
      return {
        data: items.slice(offset, offset + limit).map(({ mtimeMs: _m, ...rest }) => rest),
        error: null,
      }
    } catch (err) {
      return { data: null, error: toError(err) }
    }
  }

  async createSignedUrl(
    key: string,
    expiresInSeconds: number
  ): Promise<{ data: { signedUrl: string } | null; error: StorageError }> {
    try {
      await fs.access(resolveObjectPath(this.bucket, key))
      return { data: { signedUrl: signedFileUrl(this.bucket, key, expiresInSeconds, 'GET') }, error: null }
    } catch (err) {
      return { data: null, error: toError(err) }
    }
  }

  async createSignedUploadUrl(
    key: string,
    _options?: { upsert?: boolean }
  ): Promise<{ data: { signedUrl: string } | null; error: StorageError }> {
    try {
      return {
        data: { signedUrl: signedFileUrl(this.bucket, key, 2 * 60 * 60, 'PUT') },
        error: null,
      }
    } catch (err) {
      return { data: null, error: toError(err) }
    }
  }

  getPublicUrl(key: string): { data: { publicUrl: string } } {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/')
    return { data: { publicUrl: `${appBaseUrl()}/api/files/${this.bucket}/${encodedKey}` } }
  }
}

export interface FileStorage {
  from(bucket: string): LocalBucket
}

/** Filesystem storage accessor: the drop-in for `client.storage`. */
export function fileStorage(): FileStorage {
  return {
    from(bucket: string) {
      return new LocalBucket(bucket)
    },
  }
}
