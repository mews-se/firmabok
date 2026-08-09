---
name: bookkeep
description: Book business events as manual vouchers and clear the document inbox. Use when the user says "bokfor", "bokfora", "book this", "osorterade underlag", "kvitton", or wants daily bookkeeping done.
argument-hint: [period or counterparty]
---

# Bookkeep

Work through unbooked business events and documents and stage correct vouchers. This is the highest-frequency flow; accuracy comes from the company's own history, not from guessing.

## Flow

1. If not already done this session, call `accounted_get_agent_briefing` (accounting method changes how income is booked: faktureringsmetoden credits 1510 via invoices, kontantmetoden books on payment).
2. Find what is unbooked: start from `Accounted://attention`, then discover the voucher and document tools with `accounted_search_tools` (for example "create voucher", "inbox items", "upload receipt").
3. For each item, decide the posting in this order of authority:
   1. Explicit mapping rules the company has configured.
   2. Observed history in `Accounted://ledger/context`: how THIS company booked this counterparty before (dominant account, VAT treatment, frequency as evidence). Prefer these over textbook answers, but frequency is not permission to auto-post.
   3. Only then general knowledge, and for VAT treatment always load it: `accounted_load_skill("horizontal/swedish-vat")` for deductibility edge cases (representation caps, EU trade, reverse charge). Never answer Swedish VAT from memory.
4. Stage the vouchers, grouped by counterparty so the user can approve in coherent batches. Present each preview with account, VAT treatment, and why. Approve only what the user confirms, via `accounted_approve_pending_operation`.
5. If a tool response carries `period_status` locked or closed, stop that item and explain; never work around a period lock.
6. Finish with a short summary in the user's language: booked, skipped and why, what remains, and the next relevant deadline.

## Rules

- Evidence over guesses: ledger context and mapping rules outrank general knowledge.
- Every write stages a pending operation; the user approves before anything is booked.
- Amounts are SEK with ore precision; never round away balance.
