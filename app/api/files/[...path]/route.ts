import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { NextResponse, type NextRequest } from 'next/server'
import {
  PUBLIC_BUCKETS,
  fileStorage,
  objectDiskPath,
  verifyFileSignature,
} from '@/lib/storage/local'

/**
 * File serving for the filesystem storage backend (lib/storage/local.ts).
 *
 * GET  /api/files/{bucket}/{key}?exp&sig   signed download
 * GET  /api/files/logos/{key}              public read (PUBLIC_BUCKETS only)
 * PUT  /api/files/{bucket}/{key}?exp&sig   signed upload (pending documents)
 *
 * The HMAC signature carries bucket, key, method and expiry, so a leaked
 * download URL cannot be replayed as an upload or against another object,
 * and everything dies with the expiry. No cookie auth here by design: the
 * signature IS the authorization (MCP clients fetch these URLs without a
 * browser session), which mirrors how storage-api's signed URLs worked.
 */

const UPLOAD_MAX_BYTES = 52428800 // same 50 MB cap the documents bucket had

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.se': 'application/octet-stream',
  '.sie': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xhtml': 'application/xhtml+xml',
}

function parseObjectRef(segments: string[]): { bucket: string; key: string } | null {
  if (segments.length < 2) return null
  const [bucket, ...keyParts] = segments
  const key = keyParts.join('/')
  if (!bucket || !key) return null
  return { bucket, key }
}

function requestSignature(request: NextRequest): { exp: number; sig: string } {
  const exp = Number(request.nextUrl.searchParams.get('exp'))
  const sig = request.nextUrl.searchParams.get('sig') ?? ''
  return { exp, sig }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const ref = parseObjectRef((await params).path)
  if (!ref) return NextResponse.json({ error: 'Ogiltig sökväg.' }, { status: 400 })

  if (!PUBLIC_BUCKETS.has(ref.bucket)) {
    const { exp, sig } = requestSignature(request)
    if (!sig || !verifyFileSignature(ref.bucket, ref.key, exp, 'GET', sig)) {
      return NextResponse.json({ error: 'Ogiltig eller utgången länk.' }, { status: 403 })
    }
  }

  let abs: string
  try {
    abs = objectDiskPath(ref.bucket, ref.key)
  } catch {
    return NextResponse.json({ error: 'Ogiltig sökväg.' }, { status: 400 })
  }

  const stat = await fs.stat(abs).catch(() => null)
  if (!stat?.isFile()) {
    return NextResponse.json({ error: 'Filen hittades inte.' }, { status: 404 })
  }

  const ext = path.extname(ref.key).toLowerCase()
  const fileName = path.basename(ref.key)
  const disposition = PUBLIC_BUCKETS.has(ref.bucket) ? 'inline' : 'attachment'
  const body = Readable.toWeb(createReadStream(abs)) as ReadableStream

  return new Response(body, {
    headers: {
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Content-Disposition': `${disposition}; filename="${encodeURIComponent(fileName)}"`,
      'Cache-Control': PUBLIC_BUCKETS.has(ref.bucket) ? 'public, max-age=3600' : 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const ref = parseObjectRef((await params).path)
  if (!ref) return NextResponse.json({ error: 'Ogiltig sökväg.' }, { status: 400 })

  const { exp, sig } = requestSignature(request)
  if (!sig || !verifyFileSignature(ref.bucket, ref.key, exp, 'PUT', sig)) {
    return NextResponse.json({ error: 'Ogiltig eller utgången länk.' }, { status: 403 })
  }

  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > UPLOAD_MAX_BYTES) {
    return NextResponse.json({ error: 'Filen är för stor.' }, { status: 413 })
  }

  const buffer = await request.arrayBuffer()
  if (buffer.byteLength === 0) {
    return NextResponse.json({ error: 'Filen är tom.' }, { status: 400 })
  }
  if (buffer.byteLength > UPLOAD_MAX_BYTES) {
    return NextResponse.json({ error: 'Filen är för stor.' }, { status: 413 })
  }

  // upsert:false semantics, same as the signed uploads had on storage-api: a
  // retry against an already-written key must not silently overwrite bytes.
  const { error } = await fileStorage().from(ref.bucket).upload(ref.key, buffer, { upsert: false })
  if (error) {
    const exists = /EEXIST/i.test(error.message)
    return NextResponse.json(
      { error: exists ? 'Objektet finns redan.' : 'Uppladdningen misslyckades.' },
      { status: exists ? 409 : 500 }
    )
  }

  return NextResponse.json({ path: ref.key }, { status: 200 })
}
