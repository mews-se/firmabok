/**
 * Detects Windows-1252 artifacts in imported text: a CP437/Latin-1 SIE file
 * decoded as CP1252 turns diacritic bytes into C1 specials ("F”rmedlad").
 */

/**
 * Windows-1252 code points in the 0x80–0x9F block, where CP1252 diverges from
 * Latin-1 (e.g. U+2013 "–", U+2026 "…").
 */
const CP1252_SPECIALS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
])

/**
 * True if the name contains a Windows-1252 C1 "special" character used IN PLACE
 * OF A LETTER — i.e. a CP437/Latin-1 diacritic byte mis-decoded as CP1252
 * (CP437 ö 0x94 → "”", ä 0x84 → "„", Ö 0x99 → "™"). Swedish diacritics always
 * sit mid-word, so the tell is letter-adjacency: "F”rmedlad" (corrupt) vs
 * "Periodiseringsfond 2021 – nr 2" (a legitimate space-padded en-dash, NOT
 * corrupt).
 */
export function hasCp1252Artifact(s: string): boolean {
  const chars = [...s]
  const isLetter = (c: string | undefined): boolean => !!c && /\p{L}/u.test(c)
  for (let i = 0; i < chars.length; i++) {
    if (!CP1252_SPECIALS.has(chars[i].codePointAt(0)!)) continue
    if (isLetter(chars[i - 1]) || isLetter(chars[i + 1])) return true
  }
  return false
}
