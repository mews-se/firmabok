import { describe, it, expect } from 'vitest'
import { attachStagedOperations, toolNameFor } from '../AgentChat'
import type { StoredStagedOperation } from '@/types'

/**
 * Approval cards ride on streamed `staged_operation` events, which are never
 * persisted. Without re-attaching them, reopening a conversation showed the
 * tool trace and the answer but no card, so an unapproved proposal waited out
 * its full 30-day expiry in Granskning with nothing in the thread pointing at
 * it. This is the reattachment.
 */

const op = (overrides: Partial<StoredStagedOperation> = {}): StoredStagedOperation => ({
  id: 'op-1',
  // As actually stored: pending_operations.operation_type is the bare action
  // name, verified against prod (categorize_transaction / create_voucher /
  // approve_supplier_invoice are the values in the wild).
  operation_type: 'categorize_transaction',
  title: 'Kontering: Circle K, 689 kr',
  risk_level: 'low',
  preview_data: { lines: [] },
  ...overrides,
})

describe('attachStagedOperations', () => {
  it('returns the thread untouched when nothing is pending', () => {
    const messages = [
      { role: 'user' as const, text: 'boka om' },
      { role: 'assistant' as const, text: 'klart' },
    ]
    expect(attachStagedOperations(messages, [])).toBe(messages)
  })

  it('attaches a pending proposal to the last assistant turn', () => {
    const messages = [
      { role: 'user' as const, text: 'boka om Circle K' },
      { role: 'assistant' as const, text: 'Klart att godkänna.' },
    ]

    const [, assistant] = attachStagedOperations(messages, [op()])

    expect(assistant!.staged).toHaveLength(1)
    expect(assistant!.staged![0]).toMatchObject({
      operation_id: 'op-1',
      risk_level: 'low',
      tool_name: 'gnubok_categorize_transaction',
      message: 'Kontering: Circle K, 689 kr',
    })
  })

  it('maps the stored operation_type onto the tool name the preview dispatches on', () => {
    // pending_operations stores the bare action name; the live card carries the
    // MCP tool name, and ApprovalCard's PreviewBlock keys off that. Getting this
    // wrong is invisible in a mock but drops every hydrated card to the flat
    // generic preview instead of the journal-line one. These four are the
    // operation types that have a specialized renderer.
    for (const t of [
      'categorize_transaction',
      'create_invoice',
      'create_voucher',
      'correct_entry',
    ]) {
      expect(toolNameFor(t)).toBe(`gnubok_${t}`)
    }
  })

  it('leaves an already-prefixed operation type alone', () => {
    expect(toolNameFor('gnubok_create_voucher')).toBe('gnubok_create_voucher')
  })

  it('keeps risk level for medium and high, and floors anything unknown to low', () => {
    const messages = [{ role: 'assistant' as const, text: 'svar' }]

    const risks = (level: string | null) =>
      attachStagedOperations(messages, [op({ risk_level: level })])[0]!.staged![0]!.risk_level

    expect(risks('high')).toBe('high')
    expect(risks('medium')).toBe('medium')
    // An unrecognized value must not silently render as a one-click low-risk
    // approval... but it also must not crash: low is the safe render, and the
    // server re-checks risk on commit regardless.
    expect(risks('nonsense')).toBe('low')
    expect(risks(null)).toBe('low')
  })

  it('preserves staged cards already on the message', () => {
    const messages = [
      {
        role: 'assistant' as const,
        text: 'svar',
        staged: [
          {
            tool_use_id: 'tu_live',
            operation_id: 'op-live',
            risk_level: 'low' as const,
            message: 'redan här',
          },
        ],
      },
    ]

    const out = attachStagedOperations(messages, [op({ id: 'op-2' })])

    expect(out[0]!.staged!.map((s) => s.operation_id)).toEqual(['op-live', 'op-2'])
  })

  it('appends a carrier turn when the thread has no assistant message', () => {
    // Defensive: a conversation whose assistant turn was never persisted still
    // has to show its proposal rather than swallow it.
    const out = attachStagedOperations([{ role: 'user', text: 'boka' }], [op()])

    expect(out).toHaveLength(2)
    expect(out[1]!.role).toBe('assistant')
    expect(out[1]!.staged).toHaveLength(1)
  })

  it('attaches to the LAST assistant turn, not the first', () => {
    const messages = [
      { role: 'assistant' as const, text: 'första' },
      { role: 'user' as const, text: 'och sen?' },
      { role: 'assistant' as const, text: 'andra' },
    ]

    const out = attachStagedOperations(messages, [op()])

    expect(out[0]!.staged).toBeUndefined()
    expect(out[2]!.staged).toHaveLength(1)
  })

  it('gives every hydrated card a distinct tool_use_id key', () => {
    const out = attachStagedOperations(
      [{ role: 'assistant', text: 'svar' }],
      [op({ id: 'op-a' }), op({ id: 'op-b' })],
    )

    const keys = out[0]!.staged!.map((s) => s.tool_use_id)
    expect(new Set(keys).size).toBe(2)
  })
})
