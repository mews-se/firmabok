// NE-bilaga rutor (NE appendix boxes)
export interface NEDeclarationRutor {
  R1: number   // Momspliktiga intäkter (3000-3799 excl 3100)
  R2: number   // Momsfria intäkter (3100, 3900-3999)
  R3: number   // Bil- och bostadsförmån (no BAS account)
  R4: number   // Ränteintäkter m.m. (38xx, financial income in 80xx-88xx)
  R5: number   // Varor, material och tjänster (4000-4999)
  R6: number   // Övriga externa kostnader (5000-6999)
  R7: number   // Anställd personal (7000-7699)
  R8: number   // Räntekostnader m.m. (774x, 779x, 79xx, financial costs in 80xx-89xx)
  R9: number   // Avskrivningar byggnader och mark (772x, 777x, 782x, 784x)
  R10: number  // Avskrivningar övrigt (771x, 773x, 776x, 778x, 781x, 783x, 885x)
  R11: number  // Bokfört resultat (beräknat)
  R12: number  // Bokfört resultat, förs över från R11
  R13: number  // Bokförda kostnader som inte ska dras av (NE_NON_DEDUCTIBLE_ACCOUNTS)
  R14: number  // Bokförda intäkter som inte ska tas upp (NE_TAX_FREE_INCOME_ACCOUNTS)
}

// NE account mapping configuration
export interface NEAccountMapping {
  ruta: keyof NEDeclarationRutor
  description: string
  accountRanges: Array<{
    start: string
    end: string
    exclude?: string[]
    // BAS (+)/(-): the range only takes a credit (intäkt) or a debit (kostnad) balance
    side?: 'credit' | 'debit'
  }>
  isExpense: boolean  // true = debit normal, false = credit normal
}

// NE declaration response
export interface NEDeclaration {
  fiscalYear: {
    id: string
    name: string
    start: string
    end: string
    isClosed: boolean
  }
  rutor: NEDeclarationRutor
  // Detailed breakdown per ruta
  breakdown: Record<keyof NEDeclarationRutor, {
    accounts: Array<{
      accountNumber: string
      accountName: string
      amount: number
    }>
    total: number
  }>
  // Company info for SRU (orgNumber for enskild firma is the owner's personnummer)
  companyInfo: {
    companyName: string
    orgNumber: string | null
    addressLine1: string | null
    postalCode: string | null
    city: string | null
    email: string | null
  }
  // Warnings
  warnings: string[]
}

// A complete SRU submission: two files (INFO.SRU + BLANKETTER.SRU), ISO 8859-1 encoded by the route.
export interface SRUSubmission {
  infoSru: string
  blanketterSru: string
  generatedAt: string
}

// Labels for NE rutor
export const NE_RUTA_LABELS: Record<keyof NEDeclarationRutor, string> = {
  R1: 'Försäljning med moms (25%)',
  R2: 'Momsfria intäkter',
  R3: 'Bil/bostadsförmån',
  R4: 'Ränteintäkter',
  R5: 'Varuinköp',
  R6: 'Övriga kostnader',
  R7: 'Lönekostnader',
  R8: 'Räntekostnader',
  R9: 'Avskrivningar fastighet',
  R10: 'Avskrivningar övriga tillgångar',
  R11: 'Bokfört resultat',
  R12: 'Bokfört resultat (från R11)',
  R13: 'Bokförda kostnader som inte ska dras av',
  R14: 'Bokförda intäkter som inte ska tas upp',
}
