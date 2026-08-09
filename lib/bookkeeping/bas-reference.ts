/**
 * BAS Reference Data for Swedish Accounting
 *
 * Full BAS Kontoplan 2026 (~1,276 accounts) organized by account class.
 * Data files live in ./bas-data/ and are aggregated here.
 *
 * Reference: BAS Kontoplan 2026 v1.0
 * SRU codes follow Skatteverket's SRU specification for NE and INK2 forms.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BASReferenceAccount {
  account_number: string
  account_name: string
  account_class: number
  account_group: string
  account_type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense' | 'untaxed_reserves'
  normal_balance: 'debit' | 'credit'
  description: string
  sru_code: string | null
  k2_excluded: boolean
}

// ---------------------------------------------------------------------------
// Data (imported from per-class data files)
// ---------------------------------------------------------------------------

export { BAS_REFERENCE } from './bas-data'

// ---------------------------------------------------------------------------
// Class & Group Labels
// ---------------------------------------------------------------------------

/** Swedish labels for each BAS account class (1-8) */
export const ACCOUNT_CLASS_LABELS: Record<number, string> = {
  1: 'Tillgångar',
  2: 'Eget kapital och skulder',
  3: 'Rörelseintäkter',
  4: 'Varuinköp och material',
  5: 'Övriga externa kostnader',
  6: 'Övriga externa kostnader',
  7: 'Personalkostnader och avskrivningar',
  8: 'Finansiella poster och resultat',
}

/** Swedish labels for BAS account groups (first two digits) */
export const ACCOUNT_GROUP_LABELS: Record<string, string> = {
  // Class 1 - Assets
  '10': 'Immateriella anläggningstillgångar',
  '11': 'Byggnader och mark',
  '12': 'Maskiner respektive inventarier',
  '13': 'Finansiella anläggningstillgångar',
  '14': 'Lager, produkter i arbete och pågående arbeten',
  '15': 'Kundfordringar',
  '16': 'Övriga kortfristiga fordringar',
  '17': 'Förutbetalda kostnader och upplupna intäkter',
  '18': 'Kortfristiga placeringar',
  '19': 'Kassa och bank',

  // Class 2 - Equity & Liabilities
  '20': 'Eget kapital',
  '21': 'Obeskattade reserver',
  '22': 'Avsättningar',
  '23': 'Långfristiga skulder',
  '24': 'Kortfristiga skulder till kreditinstitut, kunder och leverantörer',
  '25': 'Skatteskulder',
  '26': 'Moms och punktskatter',
  '27': 'Personalens skatter, avgifter och löneavdrag',
  '28': 'Övriga kortfristiga skulder',
  '29': 'Upplupna kostnader och förutbetalda intäkter',

  // Class 3 - Revenue
  '30': 'Huvudintäkter',
  '31': 'Försäljning av varor utanför Sverige',
  '32': 'Försäljning VMB och omvänd moms',
  '33': 'Försäljning av tjänster utanför Sverige',
  '34': 'Försäljning, egna uttag',
  '35': 'Fakturerade kostnader',
  '36': 'Rörelsens sidointäkter',
  '37': 'Intäktskorrigeringar',
  '38': 'Aktiverat arbete för egen räkning',
  '39': 'Övriga rörelseintäkter',

  // Class 4 - Cost of goods
  '40': 'Inköp av handelsvaror',
  '41': 'Inköp av varor och material',
  '42': 'Sålda handelsvaror VMB',
  '43': 'Inköp av råvaror och material i Sverige',
  '44': 'Inköp av råvaror m.m., omvänd betalningsskyldighet',
  '45': 'Inköp av råvaror m.m. från utlandet',
  '46': 'Inköp av tjänster, underentreprenader och legoarbeten',
  '47': 'Reduktion av inköpspriser',
  '48': 'Andra produktionskostnader',
  '49': 'Förändring av lager, produkter i arbete och pågående arbeten',

  // Class 5 - External expenses
  '50': 'Lokalkostnader',
  '51': 'Fastighetskostnader',
  '52': 'Hyra av anläggningstillgångar',
  '53': 'Energikostnader för drift',
  '54': 'Förbrukningsinventarier och förbrukningsmaterial',
  '55': 'Reparation och underhåll',
  '56': 'Kostnader för transportmedel',
  '57': 'Frakter och transporter',
  '58': 'Resekostnader',
  '59': 'Reklam och PR',

  // Class 6 - Other external expenses
  '60': 'Övriga försäljningskostnader',
  '61': 'Kontorsmateriel och trycksaker',
  '62': 'Tele, data och post',
  '63': 'Företagsförsäkringar och övriga riskkostnader',
  '64': 'Förvaltningskostnader',
  '65': 'Övriga externa tjänster',
  '66': 'Franchisingavgifter',
  '67': 'Särskilt för ideella föreningar och stiftelser',
  '68': 'Inhyrd personal',
  '69': 'Övriga externa kostnader',

  // Class 7 - Personnel
  '70': 'Löner till kollektivanställda',
  '71': 'Löner till anställda',
  '72': 'Löner till tjänstemän och företagsledare',
  '73': 'Kostnadsersättningar och förmåner',
  '74': 'Pensionskostnader',
  '75': 'Sociala och andra avgifter enligt lag och avtal',
  '76': 'Övriga personalkostnader',
  '77': 'Nedskrivningar och återföring av nedskrivningar',
  '78': 'Avskrivningar enligt plan',
  '79': 'Övriga rörelsekostnader',

  // Class 8 - Financial
  '80': 'Resultat från andelar i koncernföretag',
  '81': 'Resultat från andelar i intresseföretag',
  '82': 'Resultat från övriga värdepapper och långfristiga fordringar',
  '83': 'Övriga ränteintäkter och liknande resultatposter',
  '84': 'Räntekostnader och liknande resultatposter',
  '85': 'Extraordinära intäkter',
  '86': 'Extraordinära kostnader',
  '87': 'Bokslutsdispositioner (intäkter)',
  '88': 'Bokslutsdispositioner',
  '89': 'Skatter och årets resultat',
}

// ---------------------------------------------------------------------------
// Lookup indexes (lazy-initialized for performance)
// ---------------------------------------------------------------------------

// Import BAS_REFERENCE for use in indexes (re-exported above for consumers)
import { BAS_REFERENCE } from './bas-data'

let _byAccountNumber: Map<string, BASReferenceAccount> | null = null
let _byClass: Map<number, BASReferenceAccount[]> | null = null

function getByAccountNumberIndex(): Map<string, BASReferenceAccount> {
  if (!_byAccountNumber) {
    _byAccountNumber = new Map()
    for (const account of BAS_REFERENCE) {
      _byAccountNumber.set(account.account_number, account)
    }
  }
  return _byAccountNumber
}

function getByClassIndex(): Map<number, BASReferenceAccount[]> {
  if (!_byClass) {
    _byClass = new Map()
    for (const account of BAS_REFERENCE) {
      const existing = _byClass.get(account.account_class) ?? []
      existing.push(account)
      _byClass.set(account.account_class, existing)
    }
  }
  return _byClass
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Look up a single BAS reference account by its account number.
 * Returns undefined if the account number is not in the reference data.
 */
export function getBASReference(accountNumber: string): BASReferenceAccount | undefined {
  return getByAccountNumberIndex().get(accountNumber)
}

/**
 * Get all BAS reference accounts for a given account class (1-8).
 * Returns an empty array if the class has no accounts in the reference data.
 */
export function getBASReferenceByClass(accountClass: number): BASReferenceAccount[] {
  return getByClassIndex().get(accountClass) ?? []
}

/**
 * Check whether an account number exists in the BAS reference data.
 * Useful for validating that a user-entered account number is a standard BAS account.
 */
export function isStandardBASAccount(accountNumber: string): boolean {
  return getByAccountNumberIndex().has(accountNumber)
}
