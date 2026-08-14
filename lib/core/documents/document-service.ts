import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { fileStorage } from '@/lib/storage/local'
import type { DocumentAttachment, DocumentUploadSource } from '@/types'

/**
 * Document Service - WORM-style document archive
 *
 * Handles document upload with SHA-256 integrity, version chains,
 * and linking to journal entries. Deletion is blocked by DB triggers
 * for documents linked to committed entries.
 */

/**
 * Sanitize a filename for use in Supabase Storage keys.
 * Replaces spaces and non-ASCII characters with underscores,
 * collapses consecutive underscores, and truncates to avoid
 * exceeding Supabase Storage path length limits.
 */
function sanitizeFileName(name: string): string {
  const dotIndex = name.lastIndexOf('.')
  const ext = dotIndex > 0 ? name.slice(dotIndex) : ''
  const base = dotIndex > 0 ? name.slice(0, dotIndex) : name

  const sanitizedBase = base
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 100) || 'file'
  const sanitizedExt = ext.replace(/[^a-zA-Z0-9.]/g, '_')

  return sanitizedBase + sanitizedExt
}

/**
 * Storage key layout for the `documents` bucket:
 *
 *   documents/{companyId}/{userId}/{timestamp}_{filename}
 *
 * The company prefix keeps the on-disk layout stable and makes the key alone
 * reveal which tenant owns the object. Authorization happens in the routes
 * and services against the database before storage is touched.
 */
export const DOCUMENTS_BUCKET = 'documents'
export const SIGNED_DOCUMENT_UPLOAD_TTL_MS = 2 * 60 * 60 * 1000
export const PENDING_DOCUMENT_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000
const PENDING_DOCUMENT_UPLOAD_CLEANUP_LIMIT = 100

/** Build a company-scoped storage key for a new upload. */
export function buildDocumentStoragePath(
  companyId: string,
  userId: string,
  fileName: string,
  timestamp: number = Date.now()
): string {
  return `${companyId}/${userId}/${timestamp}_${sanitizeFileName(fileName)}`
}

/** Build the temporary key targeted by a signed, model-free upload. */
export function buildPendingDocumentStoragePath(
  companyId: string,
  userId: string,
  uploadId: string,
  fileName: string
): string {
  return `${companyId}/${userId}/pending/${uploadId}_${sanitizeFileName(fileName)}`
}

/** Build the permanent WORM key for a completed signed upload. */
export function buildReservedDocumentStoragePath(
  companyId: string,
  userId: string,
  uploadId: string,
  fileName: string
): string {
  return `${companyId}/${userId}/${uploadId}_${sanitizeFileName(fileName)}`
}

type StorageErrorLike = { message?: string } | null

/**
 * Download a document object by its stored key. Returns the resolved key
 * alongside the blob so callers can log which key served the bytes.
 */
export async function downloadDocumentObject(
  storagePath: string
): Promise<{ blob: Blob | null; error: StorageErrorLike; resolvedPath: string | null }> {
  const { data, error } = await fileStorage().from(DOCUMENTS_BUCKET).download(storagePath)
  if (!error && data) {
    return { blob: data as Blob, error: null, resolvedPath: storagePath }
  }
  return {
    blob: null,
    error: (error as StorageErrorLike) ?? { message: 'download returned no data' },
    resolvedPath: null,
  }
}

/**
 * Create a signed URL for a document object by its stored key.
 * Same contract as downloadDocumentObject().
 */
export async function createDocumentSignedUrl(
  storagePath: string,
  expiresInSeconds: number
): Promise<{ signedUrl: string | null; error: StorageErrorLike; resolvedPath: string | null }> {
  const { data, error } = await fileStorage()
    .from(DOCUMENTS_BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds)
  if (!error && data?.signedUrl) {
    return { signedUrl: data.signedUrl, error: null, resolvedPath: storagePath }
  }
  return {
    signedUrl: null,
    error: (error as StorageErrorLike) ?? { message: 'createSignedUrl returned no data' },
    resolvedPath: null,
  }
}

export const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024 // 10 MB
export const ALLOWED_DOCUMENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]

/**
 * Validate file size and MIME type before upload.
 * Returns an error string or null if valid.
 */
export function validateDocumentFile(file: { size: number; type?: string }): string | null {
  if (file.size === 0) {
    return 'Filen är tom'
  }
  if (file.size > MAX_DOCUMENT_SIZE) {
    return `Filen är för stor (max ${MAX_DOCUMENT_SIZE / 1024 / 1024} MB)`
  }
  if (!file.type || !ALLOWED_DOCUMENT_TYPES.includes(file.type)) {
    return 'Otillåten filtyp. Tillåtna: PDF, JPG, PNG, WebP.'
  }
  return null
}

/**
 * Inspect the first bytes of a buffer to identify the actual file format.
 * Defends against callers (typically MCP agents) that base64-encode a text
 * placeholder or summary instead of the real binary file: those uploads
 * succeed at the storage layer but the bytes are unreadable as a PDF/image.
 */
export function detectFileMagic(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null
  // PDF: %PDF- anywhere in the first 1024 bytes. ISO 32000 readers accept a
  // preamble before the header (Acrobat scans the first 1 KB), and real-world
  // invoice PDFs arrive with leading newlines/junk: requiring offset 0
  // rejected files every normal reader opens. Image types stay strict at
  // offset 0: genuine image files always start with their signature, and the
  // looseness is not needed there to keep the anti-placeholder defense tight.
  const pdfScanEnd = Math.min(bytes.length - 5, 1024)
  for (let i = 0; i <= pdfScanEnd; i++) {
    if (
      bytes[i] === 0x25 &&
      bytes[i + 1] === 0x50 &&
      bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46 &&
      bytes[i + 4] === 0x2D
    ) return 'application/pdf'
  }
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png'
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg'
  // WebP: RIFF<4-byte size>WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp'
  return null
}

/**
 * XHTML/XML has no binary magic number. For the declared type
 * application/xhtml+xml (system-generated iXBRL årsredovisningar) we instead
 * require the content to start with an XML declaration, an HTML doctype, or
 * an <html> root element (after an optional UTF-8 BOM and leading
 * whitespace). This branch is consulted ONLY for that declared type: it
 * never loosens detection for PDF/PNG/JPEG/WEBP uploads.
 */
function looksLikeXhtml(bytes: Uint8Array): boolean {
  const offset = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? 3 : 0
  const head = Buffer.from(bytes.slice(offset, offset + 256))
    .toString('utf8')
    .replace(/^[\s﻿]+/, '')
    .toLowerCase()
  return head.startsWith('<?xml') || head.startsWith('<!doctype html') || head.startsWith('<html')
}

/**
 * JSON has no binary magic number either. For the declared type
 * application/json (raw PSD2 responses archived as räkenskapsinformation per
 * BFL 7 kap) the content must parse as JSON with an object or array root — a
 * prose placeholder is not valid JSON, and a bare quoted string still fails
 * the root check, so the anti-placeholder defense stays intact. Consulted
 * ONLY for that declared type.
 */
function looksLikeJson(bytes: Uint8Array): boolean {
  const offset = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? 3 : 0
  try {
    const parsed = JSON.parse(Buffer.from(bytes.slice(offset)).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null
  } catch {
    return false
  }
}

/**
 * Verify the buffer actually contains a file of the declared type.
 * Returns an error string or null if valid. HEIC has many ftyp brands so
 * we skip the check for now: the UI path doesn't allow HEIC anyway, only
 * the MCP upload tool does, and corrupted HEIC has not been observed.
 */
export function validateDocumentMagicBytes(buffer: ArrayBuffer, declaredMimeType: string): string | null {
  if (declaredMimeType === 'image/heic') return null
  if (declaredMimeType === 'application/xhtml+xml') {
    if (looksLikeXhtml(new Uint8Array(buffer))) return null
    return `Filinnehållet kunde inte verifieras som ${declaredMimeType}. Filen verkar inte vara ett XHTML/XML-dokument.`
  }
  if (declaredMimeType === 'application/json') {
    if (looksLikeJson(new Uint8Array(buffer))) return null
    return `Filinnehållet kunde inte verifieras som ${declaredMimeType}. Filen verkar inte vara ett giltigt JSON-dokument.`
  }
  const detected = detectFileMagic(new Uint8Array(buffer))
  if (!detected) {
    return `Filinnehållet kunde inte verifieras som ${declaredMimeType}. Filen verkar vara skadad eller inte en riktig binärfil: vid uppladdning via API, kontrollera att file_content_base64 är base64-kodade råbytes, inte en textrepresentation.`
  }
  if (detected !== declaredMimeType) {
    return `Filinnehållet matchar inte den angivna filtypen (förväntade ${declaredMimeType}, hittade ${detected}).`
  }
  return null
}

/**
 * Remove a bounded batch of abandoned signed-upload objects. Pending objects
 * are not accounting records and have no document_attachments row. Completed
 * documents are moved out of this prefix before the immutable row is created.
 */
export async function cleanupExpiredPendingDocumentUploads(
  companyId: string,
  userId: string,
  now: number = Date.now()
): Promise<number> {
  const prefix = `${companyId}/${userId}/pending`
  const storage = fileStorage().from(DOCUMENTS_BUCKET)
  const { data, error } = await storage.list(prefix, {
    limit: PENDING_DOCUMENT_UPLOAD_CLEANUP_LIMIT,
    offset: 0,
    sortBy: { column: 'created_at', order: 'asc' },
  })
  if (error || !data) return 0

  const cutoff = now - PENDING_DOCUMENT_UPLOAD_RETENTION_MS
  const expiredPaths = data
    .filter((item) => {
      if (!item.id || !item.created_at) return false
      const createdAt = Date.parse(item.created_at)
      return Number.isFinite(createdAt) && createdAt < cutoff
    })
    .map((item) => `${prefix}/${item.name}`)

  if (expiredPaths.length === 0) return 0
  const { error: removeError } = await storage.remove(expiredPaths)
  return removeError ? 0 : expiredPaths.length
}

export interface PendingDocumentUploadReservation {
  uploadId: string
  signedUrl: string
  expiresAt: string
}

/**
 * Reserve a company-scoped object key and create a short-lived upload URL.
 * The returned URL accepts the raw file bytes via PUT without authentication.
 */
export async function createPendingDocumentUpload(
  companyId: string,
  userId: string,
  uploadId: string,
  fileName: string,
  now: number = Date.now()
): Promise<PendingDocumentUploadReservation> {
  await cleanupExpiredPendingDocumentUploads(companyId, userId, now)

  const storagePath = buildPendingDocumentStoragePath(companyId, userId, uploadId, fileName)
  const { data, error } = await fileStorage()
    .from(DOCUMENTS_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: false })

  if (error || !data?.signedUrl) {
    throw new Error(`Failed to create document upload URL: ${error?.message ?? 'no URL returned'}`)
  }

  return {
    uploadId,
    signedUrl: data.signedUrl,
    expiresAt: new Date(now + SIGNED_DOCUMENT_UPLOAD_TTL_MS).toISOString(),
  }
}

export interface CompletedPendingDocumentUpload {
  document: DocumentAttachment
  buffer: ArrayBuffer
}

async function findReservedDocument(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  uploadId: string
): Promise<DocumentAttachment | null> {
  const { data, error } = await supabase
    .from('document_attachments')
    .select('*')
    .eq('id', uploadId)
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(`Failed to check document upload: ${error.message}`)
  return data as DocumentAttachment | null
}

function validateReservedDocumentMetadata(
  document: DocumentAttachment,
  fileName: string,
  mimeType: string
): void {
  if (document.file_name !== fileName || document.mime_type !== mimeType) {
    throw new Error('Upload ID was already completed with different file metadata')
  }
}

async function validatePendingDocumentBytes(
  buffer: ArrayBuffer,
  mimeType: string
): Promise<string> {
  if (buffer.byteLength === 0) throw new Error('Uploaded file is empty')
  if (buffer.byteLength > MAX_DOCUMENT_SIZE) {
    throw new Error(`File too large (max ${MAX_DOCUMENT_SIZE / 1024 / 1024} MB)`)
  }
  const magicError = validateDocumentMagicBytes(buffer, mimeType)
  if (magicError) throw new Error(magicError)
  return computeSHA256(buffer)
}

/**
 * Adopt bytes uploaded through a signed URL into the WORM document archive.
 * The reserved UUID becomes the document id, making retries and concurrent
 * completion calls converge on the same immutable row.
 */
export async function completePendingDocumentUpload(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  uploadId: string,
  fileName: string,
  mimeType: string,
  now: number = Date.now()
): Promise<CompletedPendingDocumentUpload> {
  const storage = fileStorage().from(DOCUMENTS_BUCKET)
  const pendingPath = buildPendingDocumentStoragePath(companyId, userId, uploadId, fileName)
  const permanentPath = buildReservedDocumentStoragePath(companyId, userId, uploadId, fileName)

  const existing = await findReservedDocument(supabase, companyId, userId, uploadId)
  if (existing) {
    validateReservedDocumentMetadata(existing, fileName, mimeType)
    const { data, error } = await storage.download(existing.storage_path)
    if (error || !data) {
      throw new Error(`Failed to read completed document upload: ${error?.message ?? 'no data returned'}`)
    }
    const buffer = await data.arrayBuffer()
    const hash = await validatePendingDocumentBytes(buffer, mimeType)
    if (hash !== existing.sha256_hash) throw new Error('Completed document failed its integrity check')
    return { document: existing, buffer }
  }

  await cleanupExpiredPendingDocumentUploads(companyId, userId, now)

  let sourcePath = pendingPath
  let { data: blob, error: downloadError } = await storage.download(pendingPath)
  if (downloadError || !blob) {
    const permanentDownload = await storage.download(permanentPath)
    blob = permanentDownload.data
    downloadError = permanentDownload.error
    sourcePath = permanentPath
  }
  if (downloadError || !blob) {
    throw new Error('Document upload was not found or has expired. Create a new upload URL and try again.')
  }

  const buffer = await blob.arrayBuffer()
  let sha256Hash: string
  try {
    sha256Hash = await validatePendingDocumentBytes(buffer, mimeType)
  } catch (error) {
    await storage.remove([sourcePath])
    throw error
  }

  if (sourcePath === pendingPath) {
    const { error: moveError } = await storage.move(pendingPath, permanentPath)
    if (moveError) {
      const permanentDownload = await storage.download(permanentPath)
      if (permanentDownload.error || !permanentDownload.data) {
        throw new Error(`Failed to finalize document upload: ${moveError.message}`)
      }
    }
  }

  const { data, error } = await supabase
    .from('document_attachments')
    .insert({
      id: uploadId,
      user_id: userId,
      company_id: companyId,
      storage_path: permanentPath,
      file_name: fileName,
      file_size_bytes: buffer.byteLength,
      mime_type: mimeType,
      sha256_hash: sha256Hash,
      version: 1,
      is_current_version: true,
      uploaded_by: userId,
      upload_source: 'api',
      digitization_date: new Date(now).toISOString(),
      journal_entry_id: null,
      journal_entry_line_id: null,
    })
    .select()
    .single()

  if (error) {
    const concurrent = await findReservedDocument(supabase, companyId, userId, uploadId)
    if (concurrent) {
      validateReservedDocumentMetadata(concurrent, fileName, mimeType)
      if (concurrent.sha256_hash !== sha256Hash) {
        throw new Error('Upload ID was completed with different file content')
      }
      return { document: concurrent, buffer }
    }
    await storage.remove([permanentPath])
    throw new Error(`Failed to create document record: ${error.message}`)
  }

  const document = data as DocumentAttachment
  await eventBus.emit({
    type: 'document.uploaded',
    payload: { document, userId, companyId },
  })

  return { document, buffer }
}

/**
 * Compute SHA-256 hash of a file buffer
 */
export async function computeSHA256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Upload a document and create a record with SHA-256 integrity hash
 */
export async function uploadDocument(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  file: { name: string; buffer: ArrayBuffer; type?: string },
  metadata: {
    upload_source?: DocumentUploadSource
    journal_entry_id?: string
    journal_entry_line_id?: string
  } = {}
): Promise<DocumentAttachment> {
  // Reject corrupt uploads at the boundary: see validateDocumentMagicBytes.
  if (file.type) {
    const magicError = validateDocumentMagicBytes(file.buffer, file.type)
    if (magicError) throw new Error(magicError)
  }

  // Compute SHA-256 hash
  const sha256Hash = await computeSHA256(file.buffer)

  // Company-scoped storage key: kept for a stable on-disk layout and so the
  // key alone reveals which tenant owns the object.
  const storagePath = buildDocumentStoragePath(companyId, userId, file.name)

  const { error: uploadError } = await fileStorage()
    .from('documents')
    .upload(storagePath, file.buffer, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    })

  if (uploadError) {
    throw new Error(`Failed to upload document: ${uploadError.message}`)
  }

  // Create document record
  const { data, error } = await supabase
    .from('document_attachments')
    .insert({
      user_id: userId,
      company_id: companyId,
      storage_path: storagePath,
      file_name: file.name,
      file_size_bytes: file.buffer.byteLength,
      mime_type: file.type || null,
      sha256_hash: sha256Hash,
      version: 1,
      is_current_version: true,
      uploaded_by: userId,
      upload_source: metadata.upload_source || 'file_upload',
      digitization_date: new Date().toISOString(),
      journal_entry_id: metadata.journal_entry_id || null,
      journal_entry_line_id: metadata.journal_entry_line_id || null,
    })
    .select()
    .single()

  if (error) {
    // Clean up the just-uploaded object on record creation failure so it
    // doesn't linger as an orphan. Authorization: the key was built by this
    // very call for the caller's own failed upload, and no DB row references
    // it. The WORM guarantee for linked documents lives in the DB trigger
    // (block_document_deletion), not in the storage layer.
    await fileStorage().from(DOCUMENTS_BUCKET).remove([storagePath])
    throw new Error(`Failed to create document record: ${error.message}`)
  }

  const result = data as DocumentAttachment

  await eventBus.emit({
    type: 'document.uploaded',
    payload: { document: result, userId, companyId },
  })

  return result
}

/**
 * Create a new version of an existing document (WORM: old version is superseded)
 *
 * Uses the create_document_version RPC for atomic versioning with:
 * - Row-level locking (prevents concurrent versioning race condition)
 * - Cryptographic hash chain (prev_version_hash links to previous version)
 * - Single transaction (insert new + mark old superseded)
 */
export async function createNewVersion(
  supabase: SupabaseClient,
  userId: string,
  originalId: string,
  file: { name: string; buffer: ArrayBuffer; type?: string }
): Promise<DocumentAttachment> {
  if (file.type) {
    const magicError = validateDocumentMagicBytes(file.buffer, file.type)
    if (magicError) throw new Error(magicError)
  }

  // Compute SHA-256 hash
  const sha256Hash = await computeSHA256(file.buffer)

  // The new version must land under the SAME company prefix as the document
  // it supersedes. The caller (POST /api/documents/:id/versions) does not
  // pass a companyId, so resolve it from the original row: the read goes
  // through the user-scoped client, so RLS already blocks a cross-tenant id,
  // and create_document_version re-checks membership server-side.
  const { data: original, error: originalError } = await supabase
    .from('document_attachments')
    .select('company_id')
    .eq('id', originalId)
    .maybeSingle()

  if (originalError || !original?.company_id) {
    throw new Error('Failed to create new version: original document not found')
  }

  // Upload new file to storage
  const storagePath = buildDocumentStoragePath(
    original.company_id as string,
    userId,
    file.name
  )

  const { error: uploadError } = await fileStorage()
    .from('documents')
    .upload(storagePath, file.buffer, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    })

  if (uploadError) {
    throw new Error(`Failed to upload new version: ${uploadError.message}`)
  }

  // Atomic version creation via RPC (row lock + hash chain + supersede in one tx)
  const { data: newDocId, error: rpcError } = await supabase.rpc('create_document_version', {
    p_user_id: userId,
    p_original_doc_id: originalId,
    p_storage_path: storagePath,
    p_file_name: file.name,
    p_file_size_bytes: file.buffer.byteLength,
    p_mime_type: file.type || null,
    p_sha256_hash: sha256Hash,
  })

  if (rpcError) {
    // Clean up the uploaded file on RPC failure. The original-document fetch
    // above (user-scoped, RLS) plus the failed RPC are the authorization
    // context; the key was created by this call and nothing references it.
    await fileStorage().from(DOCUMENTS_BUCKET).remove([storagePath])
    throw new Error(`Failed to create new version: ${rpcError.message}`)
  }

  // Fetch the complete new version record
  const { data: newDoc, error: fetchError } = await supabase
    .from('document_attachments')
    .select('*')
    .eq('id', newDocId)
    .single()

  if (fetchError || !newDoc) {
    throw new Error('Failed to fetch new version record')
  }

  return newDoc as DocumentAttachment
}

/**
 * Link an existing document to a journal entry
 */
export async function linkToJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string,
  journalEntryId: string,
  journalEntryLineId?: string
): Promise<DocumentAttachment> {
  // The document is company-filtered below, but the journal entry id arrives
  // from the client and the FK only requires existence: verify it belongs to
  // the same company so a crafted id can't anchor a document to another
  // tenant's verifikation. (RLS hides foreign rows either way; this makes the
  // rejection explicit instead of a confusing downstream state.)
  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('id', journalEntryId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (entryError || !entry) {
    throw new Error('Failed to link document: journal entry not found')
  }

  const { data, error } = await supabase
    .from('document_attachments')
    .update({
      journal_entry_id: journalEntryId,
      journal_entry_line_id: journalEntryLineId || null,
    })
    .eq('id', documentId)
    .eq('company_id', companyId)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to link document: ${error.message}`)
  }

  return data as DocumentAttachment
}

export type DeleteDocumentResult =
  | { ok: true; document: Pick<DocumentAttachment, 'id' | 'file_name'> }
  | { ok: false; reason: 'not_found' | 'linked_to_entry'; status: number; message: string }

/**
 * Delete a document if and only if it is not yet linked to a journal entry.
 *
 * BFL 7 kap 2§: once a document is attached to a verifikation it becomes
 * räkenskapsinformation and may not be deleted within the 7-year retention
 * window. Linked docs must be superseded via createNewVersion() instead.
 * The block_document_deletion() trigger is the DB-level backstop.
 */
export async function deleteDocument(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string
): Promise<DeleteDocumentResult> {
  const { data: doc, error: fetchError } = await supabase
    .from('document_attachments')
    .select('id, file_name, storage_path, journal_entry_id, user_id')
    .eq('id', documentId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (fetchError || !doc) {
    return {
      ok: false,
      reason: 'not_found',
      status: 404,
      message: 'Underlaget hittades inte.',
    }
  }

  if (doc.journal_entry_id) {
    return {
      ok: false,
      reason: 'linked_to_entry',
      status: 409,
      message:
        'Underlaget är knutet till en verifikation och utgör räkenskapsinformation enligt Bokföringslagen 7 kap 2§. Räkenskapsinformation ska bevaras i minst 7 år och får inte raderas. Använd "Ersätt med ny version" om underlaget behöver korrigeras.',
    }
  }

  const { error: deleteError } = await supabase
    .from('document_attachments')
    .delete()
    .eq('id', documentId)
    .eq('company_id', companyId)

  if (deleteError) {
    const msg = (deleteError as { message?: string }).message ?? ''
    if (msg.includes('Bokföringslagen') || msg.includes('retention')) {
      return {
        ok: false,
        reason: 'linked_to_entry',
        status: 409,
        message:
          'Underlaget kan inte tas bort på grund av Bokföringslagens bevarandekrav (7 kap 2§).',
      }
    }
    throw new Error(`Failed to delete document: ${msg}`)
  }

  if (doc.storage_path) {
    // Authorization already happened above: the company-filtered row fetch
    // plus the row delete that just succeeded (with block_document_deletion()
    // as the DB-level backstop).
    await fileStorage().from(DOCUMENTS_BUCKET).remove([doc.storage_path])
  }

  await eventBus.emit({
    type: 'document.deleted',
    payload: {
      document: { id: doc.id, file_name: doc.file_name },
      userId: doc.user_id,
      companyId,
    },
  })

  return { ok: true, document: { id: doc.id, file_name: doc.file_name } }
}

/**
 * Verify document integrity by re-hashing and comparing
 */
export async function verifyIntegrity(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string
): Promise<{ valid: boolean; storedHash: string; computedHash: string }> {

  // Fetch document record
  const { data: doc, error: docError } = await supabase
    .from('document_attachments')
    .select('storage_path, sha256_hash')
    .eq('id', documentId)
    .eq('company_id', companyId)
    .single()

  if (docError || !doc) {
    throw new Error('Document not found')
  }

  // The company-filtered row fetch above is the authorization for the
  // storage read below.
  const { blob: fileData, error: downloadError } = await downloadDocumentObject(doc.storage_path)

  if (downloadError || !fileData) {
    throw new Error(`Failed to download document: ${downloadError?.message}`)
  }

  // Re-compute hash
  const buffer = await fileData.arrayBuffer()
  const computedHash = await computeSHA256(buffer)

  return {
    valid: computedHash === doc.sha256_hash,
    storedHash: doc.sha256_hash,
    computedHash,
  }
}
