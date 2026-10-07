/**
 * Structured logger for server-side code.
 *
 * Emits JSON in production (Vercel logs ingest these), pretty text in dev.
 * Suppresses info/warn in test (preserves existing test-noise contract).
 *
 * Backward-compatible with the legacy `log.error(msg, ...args)` callers: any
 * extra args after the message are merged into the structured payload:
 *   - Error instances become `err: { name, message, stack, code }`
 *   - plain objects merge into the context fields (after PII redaction)
 *   - everything else goes into `details: [...]`
 *
 * New code should prefer the explicit ctx form: `log.error('msg', err, ctx)`.
 *
 * Use `log.child({ requestId, companyId, ... })` to bind a context that is
 * merged into every subsequent call. The `with-route-context` wrapper relies
 * on this to thread requestId through a request lifecycle.
 *
 * PII: the redaction primitives live in `./redact`; the personnummer regex
 * and the key denylist run over every record before it reaches stdout.
 */

// Relative, not `@/lib/...`: the logger sits at the bottom of the import graph
// and is pulled in by everything, so it should not depend on path-alias
// resolution being configured in whatever context it is loaded from.
import { redact, redactString } from './redact'

type LogLevel = 'info' | 'warn' | 'error'

export interface LogContext {
  requestId?: string
  userId?: string
  companyId?: string
  operation?: string
  entityType?: string
  entityId?: string
  durationMs?: number
  [k: string]: unknown
}

export interface Logger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  child(extra: LogContext): Logger
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !(v instanceof Error) &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    Object.getPrototypeOf(v) === Object.prototype
  )
}

function shouldLog(level: LogLevel): boolean {
  if (process.env.NODE_ENV === 'test') return level === 'error'
  return true
}

interface LogRecord {
  level: LogLevel
  module: string
  msg: string
  ts: string
  err?: unknown
  details?: unknown[]
  [k: string]: unknown
}

function buildRecord(
  level: LogLevel,
  module: string,
  base: LogContext,
  message: string,
  args: unknown[],
): LogRecord {
  const ctx: Record<string, unknown> = { ...base }
  let err: unknown
  const details: unknown[] = []

  for (const arg of args) {
    if (arg instanceof Error) {
      // First Error wins; subsequent ones land in details
      if (err === undefined) err = redact(arg)
      else details.push(redact(arg))
    } else if (isPlainObject(arg)) {
      Object.assign(ctx, redact(arg) as Record<string, unknown>)
    } else if (arg !== undefined) {
      details.push(redact(arg))
    }
  }

  const record: LogRecord = {
    level,
    module,
    msg: redactString(message),
    ts: new Date().toISOString(),
    ...(redact(ctx) as Record<string, unknown>),
  }
  if (err !== undefined) record.err = err
  if (details.length > 0) record.details = details
  return record
}

/** A `redact()`-serialized Error: `{ name, message, stack?, code? }`. */
function isSerializedError(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).name === 'string' &&
    typeof (v as Record<string, unknown>).message === 'string' &&
    'stack' in (v as Record<string, unknown>)
  )
}

/**
 * Drop `stack` from every serialized error in the record, however nested, so
 * production log lines stay small and grep-friendly. `redact()` keeps the
 * (redacted) stack, which the dev output below still prints.
 */
function stripErrorStacks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripErrorStacks)
  if (typeof value === 'object' && value !== null) {
    const dropStack = isSerializedError(value)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (dropStack && k === 'stack') continue
      out[k] = stripErrorStacks(v)
    }
    return out
  }
  return value
}

function emit(record: LogRecord) {
  const fn =
    record.level === 'error' ? console.error : record.level === 'warn' ? console.warn : console.log

  if (process.env.NODE_ENV === 'production') {
    fn(JSON.stringify(stripErrorStacks(record)))
    return
  }

  // Pretty dev output
  const { level, module, msg, ts: _ts, err, details, ...ctx } = record
  const ctxKeys = Object.keys(ctx)
  const ctxStr = ctxKeys.length > 0 ? ' ' + ctxKeys.map((k) => `${k}=${JSON.stringify(ctx[k])}`).join(' ') : ''
  const prefix = `[${module}]`
  const tag = level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : 'INFO'
  fn(`${prefix} ${tag} ${msg}${ctxStr}`)
  if (err) fn('  err:', err)
  if (details && details.length > 0) fn('  details:', ...details)
}

function write(
  module: string,
  base: LogContext,
  level: LogLevel,
  message: string,
  args: unknown[],
): void {
  if (!shouldLog(level)) return
  emit(buildRecord(level, module, base, message, args))
}

function makeLogger(module: string, base: LogContext): Logger {
  return {
    info(message: string, ...args: unknown[]) {
      write(module, base, 'info', message, args)
    },
    warn(message: string, ...args: unknown[]) {
      write(module, base, 'warn', message, args)
    },
    error(message: string, ...args: unknown[]) {
      write(module, base, 'error', message, args)
    },
    child(extra: LogContext): Logger {
      return makeLogger(module, { ...base, ...extra })
    },
  }
}

export function createLogger(module: string, base: LogContext = {}): Logger {
  return makeLogger(module, base)
}

/**
 * Test-only escape hatch. Returns a logger that writes records to the supplied
 * array instead of stdout. Useful for asserting on emitted log lines.
 */
export function createTestLogger(module: string, sink: LogRecord[], base: LogContext = {}): Logger {
  const push = (level: LogLevel, message: string, args: unknown[]) => {
    sink.push(buildRecord(level, module, base, message, args))
  }
  return {
    info(message: string, ...args: unknown[]) {
      push('info', message, args)
    },
    warn(message: string, ...args: unknown[]) {
      push('warn', message, args)
    },
    error(message: string, ...args: unknown[]) {
      push('error', message, args)
    },
    child(extra: LogContext): Logger {
      return createTestLogger(module, sink, { ...base, ...extra })
    },
  }
}
