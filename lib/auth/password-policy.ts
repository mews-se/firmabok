/**
 * Password rules, in one place.
 *
 * Length is the only rule: mixed case, a digit and a special character are not
 * demanded. Firmabok serves a single operator over HTTP on the local network,
 * where a long list of composition rules buys little and mostly pushes people
 * towards a written-down password. Six is deliberate: it matches GoTrue's floor
 * (`GOTRUE_PASSWORD_MIN_LENGTH` defaults to 6), so the form and the auth
 * service never disagree. Anything this accepts, GoTrue accepts too, and the
 * "weak password" round trip cannot happen.
 *
 * Every check lives here so the five call sites (register, reset-password,
 * set-password, the security settings panel and the account password route)
 * cannot drift apart again. The translated strings in messages/*.json spell
 * the number out in prose, so they have to be updated alongside it.
 */
export const PASSWORD_MIN_LENGTH = 6

export function isValidPassword(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH
}

/**
 * The live checklist under the password field. One entry per rule, keyed by
 * its translation id, so the list and `isValidPassword` stay in step.
 */
export function passwordChecks(password: string) {
  return [
    { key: 'password_req_length', met: password.length >= PASSWORD_MIN_LENGTH },
  ] as const
}
