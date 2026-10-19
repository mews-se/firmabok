/**
 * SRU Code Computation
 *
 * The SRU code on an account is the NE-bilaga field its balance sums into,
 * which the SIE export writes as #SRU. Ranges follow BAS-kontogruppen's
 * kopplingstabell NE_EJ_K1 (bas.se/kontoplaner/sru), the same table the NE
 * engine maps by; field codes are Skatteverket's (NE_SKV2161, 2026P4).
 *
 * BAS lets 30xx-37xx and 39xx go to R1 or R2 by the VAT on the account; like
 * the NE engine, 3100 and 39xx count as momsfria here. Groups that BAS marks
 * (+) or (-) go to R4 or R8 by sign. SIE allows only one of the two codes on
 * such an account (the receiving program moves the amount by sign), so the
 * account's normal balance picks it.
 */

interface SRURange {
  start: string
  end: string
  exclude?: string[]
}

const NE_SRU_RANGES: Array<{ code: string; ranges: SRURange[] }> = [
  // B1 Immateriella anläggningstillgångar
  { code: '7200', ranges: [{ start: '1000', end: '1099' }] },
  // B2 Byggnader och markanläggningar
  {
    code: '7210',
    ranges: [
      { start: '1100', end: '1129' },
      { start: '1150', end: '1179' },
      { start: '1190', end: '1199' },
    ],
  },
  // B3 Mark och andra tillgångar som inte får skrivas av
  {
    code: '7211',
    ranges: [
      { start: '1130', end: '1149' },
      { start: '1180', end: '1189' },
      { start: '1291', end: '1291' },
    ],
  },
  // B4 Maskiner och inventarier
  { code: '7212', ranges: [{ start: '1200', end: '1299', exclude: ['1291'] }] },
  // B5 Övriga anläggningstillgångar
  { code: '7213', ranges: [{ start: '1300', end: '1399' }] },
  // B6 Varulager
  { code: '7240', ranges: [{ start: '1400', end: '1499' }] },
  // B7 Kundfordringar
  { code: '7250', ranges: [{ start: '1500', end: '1599' }] },
  // B8 Övriga fordringar
  { code: '7260', ranges: [{ start: '1600', end: '1899' }] },
  // B9 Kassa och bank
  { code: '7280', ranges: [{ start: '1900', end: '1999' }] },
  // B10 Eget kapital
  {
    code: '7300',
    ranges: [
      { start: '2010', end: '2019' },
      { start: '2050', end: '2059' },
    ],
  },
  // B11 Obeskattade reserver
  { code: '7320', ranges: [{ start: '2100', end: '2199' }] },
  // B12 Avsättningar
  { code: '7330', ranges: [{ start: '2200', end: '2299' }] },
  // B13 Låneskulder
  {
    code: '7380',
    ranges: [
      { start: '2300', end: '2399' },
      { start: '2410', end: '2419' },
      { start: '2480', end: '2489' },
    ],
  },
  // B14 Skatteskulder (7381): BAS maps no account here, so 25xx gets no code.
  // B15 Leverantörsskulder
  {
    code: '7382',
    ranges: [
      { start: '2440', end: '2449' },
      { start: '2460', end: '2479' },
    ],
  },
  // B16 Övriga skulder
  {
    code: '7383',
    ranges: [
      { start: '2420', end: '2439' },
      { start: '2450', end: '2459' },
      { start: '2490', end: '2499' },
      { start: '2600', end: '2999' },
    ],
  },
  // R1 Försäljning och utfört arbete samt övriga momspliktiga intäkter
  { code: '7400', ranges: [{ start: '3000', end: '3799', exclude: ['3100'] }] },
  // R2 Momsfria intäkter
  {
    code: '7401',
    ranges: [
      { start: '3100', end: '3100' },
      { start: '3900', end: '3999' },
    ],
  },
  // R4 Ränteintäkter m.m.
  {
    code: '7403',
    ranges: [
      { start: '3800', end: '3899' },
      { start: '8010', end: '8019' },
      { start: '8110', end: '8119' },
      { start: '8200', end: '8219' },
      { start: '8250', end: '8269' },
      { start: '8300', end: '8319' },
      { start: '8340', end: '8349' },
      { start: '8360', end: '8369' },
      { start: '8390', end: '8399' },
      { start: '8440', end: '8449' },
    ],
  },
  // R5 Varor, material och tjänster
  { code: '7500', ranges: [{ start: '4000', end: '4999' }] },
  // R6 Övriga externa kostnader
  { code: '7501', ranges: [{ start: '5000', end: '6999' }] },
  // R7 Anställd personal
  { code: '7502', ranges: [{ start: '7000', end: '7699' }] },
  // R8 Räntekostnader m.m.
  {
    code: '7503',
    ranges: [
      { start: '7740', end: '7749' },
      { start: '7790', end: '7799' },
      { start: '7900', end: '7999' },
      { start: '8070', end: '8089' },
      { start: '8170', end: '8189' },
      { start: '8270', end: '8289' },
      { start: '8370', end: '8389' },
      { start: '8400', end: '8429' },
      { start: '8460', end: '8469' },
      { start: '8480', end: '8489' },
      { start: '8900', end: '8989' },
    ],
  },
  // R9 Av- och nedskrivningar byggnader och markanläggningar
  {
    code: '7504',
    ranges: [
      { start: '7720', end: '7729' },
      { start: '7770', end: '7779' },
      { start: '7820', end: '7829' },
      { start: '7840', end: '7849' },
    ],
  },
  // R10 Av- och nedskrivningar maskiner, inventarier och immateriella tillgångar
  {
    code: '7505',
    ranges: [
      { start: '7710', end: '7719' },
      { start: '7730', end: '7739' },
      { start: '7760', end: '7769' },
      { start: '7780', end: '7789' },
      { start: '7810', end: '7819' },
      { start: '7830', end: '7839' },
      { start: '8850', end: '8859' },
    ],
  },
  // R11 Bokfört resultat
  { code: '7440', ranges: [{ start: '8990', end: '8999' }] },
]

/** Groups BAS marks (+) on R4 and (-) on R8 */
const NE_SIGN_SPLIT_RANGES: SRURange[] = [
  { start: '8020', end: '8039' },
  { start: '8120', end: '8139' },
  { start: '8220', end: '8249' },
  { start: '8290', end: '8299' },
  { start: '8320', end: '8339' },
  { start: '8350', end: '8359' },
  { start: '8430', end: '8439' },
  { start: '8450', end: '8459' },
  { start: '8490', end: '8499' },
  { start: '8810', end: '8819' },
  { start: '8860', end: '8869' },
  { start: '8880', end: '8899' },
]

function inRanges(num: string, ranges: SRURange[]): boolean {
  return ranges.some((r) => num >= r.start && num <= r.end && !r.exclude?.includes(num))
}

/**
 * Compute the SRU code for a given BAS account number, or null when the
 * account belongs to no NE field (aktiebolag/handelsbolag equity, 25xx,
 * koncernbidrag, class 9).
 */
export function computeSRUCode(
  accountNumber: string,
  normalBalance: 'debit' | 'credit' = 'credit',
): string | null {
  if (inRanges(accountNumber, NE_SIGN_SPLIT_RANGES)) {
    return normalBalance === 'debit' ? '7503' : '7403'
  }
  return NE_SRU_RANGES.find((row) => inRanges(accountNumber, row.ranges))?.code ?? null
}
