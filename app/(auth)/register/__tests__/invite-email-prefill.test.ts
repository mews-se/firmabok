import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Findings on the signup page, all about an address travelling (or not)
 * with the user.
 *
 * 1. The email field must be pre-filled and locked from the invitation:
 *    an invitee who typed a different address made POST /api/team/accept
 *    answer 403 on its email equality check and landed on /select-company
 *    with no membership. The token survives that 403
 *    (lib/auth/consume-invite-cookie.ts retains it on `wrong_email`, and
 *    /select-company re-runs acceptance server-side), so the dead end is
 *    recoverable; the signup still should not walk into it.
 * 2. The duplicate-email screen linked to `/login?email=...`, which
 *    app/(auth)/login/page.tsx never reads. The address rode along in the URL,
 *    the browser history, the Referer header and every proxy access log, and
 *    arrived nowhere.
 *
 * The page is a client component and this repo deliberately has no component
 * test harness (CLAUDE.md: scope is lib/ + app/api/), so these assert on the
 * page source, the same pattern used by
 * app/(auth)/reset-password/__tests__/invite-handoff.test.ts and
 * app/invite/[token]/__tests__/invite-cookie.test.ts.
 */
const SRC = fs.readFileSync(path.resolve(__dirname, '../page.tsx'), 'utf8')

/** The page source with comment lines dropped, so prose about a pattern is never mistaken for the pattern. */
const CODE = SRC.split('\n')
  .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
  .join('\n')

/** The props of one `<Input>`, located by its id. */
function inputProps(id: string): string {
  const anchor = SRC.indexOf(`id="${id}"`)
  expect(anchor, `no <Input id="${id}"> on the page`).toBeGreaterThan(-1)
  return SRC.slice(SRC.lastIndexOf('<Input', anchor), SRC.indexOf('/>', anchor) + 2)
}

/** A whole labelled field group (Label + Input + hint), located by the input's id. */
function fieldGroup(id: string): string {
  const anchor = SRC.indexOf(`id="${id}"`)
  expect(anchor, `no <Input id="${id}"> on the page`).toBeGreaterThan(-1)
  return SRC.slice(
    SRC.lastIndexOf('<div className="space-y-2">', anchor),
    SRC.indexOf('</div>', anchor) + '</div>'.length,
  )
}

/** The body of the effect that resolves `?invite=` into the invited address. */
function inviteEffect(): string {
  const start = SRC.indexOf("searchParams.get('invite')")
  expect(start).toBeGreaterThan(-1)
  return SRC.slice(start, SRC.indexOf('}, [searchParams])', start))
}

/**
 * Just the duplicate-email screen. Scoped, because the page footer carries its
 * own bare `/login` link and would satisfy an unscoped assertion.
 */
function duplicateScreen(): string {
  const start = CODE.indexOf('if (duplicateEmail) {')
  expect(start).toBeGreaterThan(-1)
  const end = CODE.indexOf('if (isRegistered) {', start)
  expect(end).toBeGreaterThan(start)
  return CODE.slice(start, end)
}

describe('an invited signup', () => {
  it('pre-fills the email field from the invitation', () => {
    expect(inviteEffect()).toContain('setEmail(data.data.email)')
  })

  it('locks the email field to the invited address', () => {
    const props = inputProps('email')
    expect(props).toContain('disabled={isLoading || !!inviteEmail}')
    expect(props).toContain('readOnly={!!inviteEmail}')
  })

  it('tells the invitee where the locked address came from', () => {
    expect(fieldGroup('email')).toContain("t('invite_email_hint')")
  })

  it('still submits the invited address although a disabled input is not in the FormData', () => {
    // `disabled` (unlike `readOnly`) excludes a field from FormData, so the
    // locked value only reaches the request through the state fallback;
    // dropping the fallback would POST an empty email.
    expect(CODE).toContain("(formData.get('email') as string) || email")
  })
})

describe('a signup that did not come from an invitation', () => {
  // The overwhelming majority. Nothing may lock or pre-fill for these users.
  it('starts with no invited address', () => {
    expect(CODE).toContain('const [inviteEmail, setInviteEmail] = useState<string | null>(null)')
  })

  it('never resolves an invitation when the link carries no token', () => {
    expect(inviteEffect()).toContain('if (!inviteToken) return')
  })

  it('leaves the email field editable, gating every lock on the invitation', () => {
    const props = inputProps('email')
    // No unconditional lock: every disabled/readOnly here names inviteEmail.
    const locks = props.match(/(disabled|readOnly)=\{[^}]*\}/g) ?? []
    expect(locks.length).toBeGreaterThan(0)
    for (const lock of locks) {
      expect(lock, `${lock} is not conditional on the invitation`).toContain('inviteEmail')
    }
  })
})

describe('the duplicate-email screen', () => {
  it('sends the user to plain /login', () => {
    expect(duplicateScreen()).toContain('<Link href="/login">')
  })

  it('does not put the address in the URL of a page that never reads it', () => {
    expect(duplicateScreen()).not.toMatch(/\/login\?/)
    expect(CODE).not.toContain('encodeURIComponent(duplicateEmail)')
  })

  it('still shows the address, so nothing is lost by dropping the parameter', () => {
    expect(duplicateScreen()).toContain('{duplicateEmail}')
  })
})

describe('the post-auth destination parameter', () => {
  it('does not read `next`', () => {
    // Nothing links to /register with one: bounceToAuth (lib/supabase/
    // middleware.ts) targets /login and the two MFA pages, and
    // app/invite/[token]/page.tsx sends `?invite=`. An unread parameter cannot
    // redirect anyone.
    expect(CODE).not.toContain("searchParams.get('next')")
  })

  it('would have to sanitize a destination through safeReturnTo if one is ever added', () => {
    // The ratchet, not a restatement of today's behaviour: the moment someone
    // reads a destination off this URL, the shared validator has to be the
    // thing that vets it. Hand-rolled checks here emitted
    // `Location: http://evil.com/`. Rejection of absolute and
    // protocol-relative values is covered by
    // lib/auth/__tests__/safe-return-to.test.ts.
    const readsDestination = /searchParams\.get\('(next|returnTo|redirect|redirectTo)'\)/.test(CODE)
    if (readsDestination) {
      expect(CODE).toContain("from '@/lib/auth/safe-return-to'")
      expect(CODE).toMatch(/safeReturnTo\(\s*searchParams\.get\('(next|returnTo|redirect|redirectTo)'\)/)
    }
  })
})

describe('the wording the locked field renders', () => {
  const messages = (locale: 'sv' | 'en') =>
    JSON.parse(
      fs.readFileSync(path.resolve(__dirname, `../../../../messages/${locale}.json`), 'utf8'),
    ) as { register: Record<string, string> }

  for (const locale of ['sv', 'en'] as const) {
    it(`has the invite email hint in ${locale}.json`, () => {
      expect(messages(locale).register.invite_email_hint).toBeTruthy()
    })
  }
})
