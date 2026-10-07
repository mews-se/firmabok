import type { CustomerType, VatTreatment } from '@/types'

export interface VatRateOption {
  rate: number
  label: string
  treatment: VatTreatment
}

/**
 * Get the DEFAULT VAT rates offered for invoice line items, per customer type.
 *
 * Swedish/EU-unvalidated customers can choose between 25%, 12%, 6%, and 0% (exempt).
 * Reverse charge and export customers default to a single 0% option, because
 * huvudregeln (ML 6 kap. 34 §, Article 44 VAT Directive) taxes a B2B service
 * where the buyer is established.
 *
 * This is the DEFAULT, not the full set of lawful rates: see
 * getPermittedVatRates() for the taxed-where-performed exceptions that carry
 * Swedish VAT even to a foreign business customer. Validation must gate on
 * getPermittedVatRates(); only the picker default should come from here.
 *
 * This helper does NOT gate on the seller's VAT registration status: it only
 * knows the customer side. The seller-side gate lives one level up: the invoice
 * form hides the Moms column entirely when company_settings.vat_registered is
 * false, and both the create route and the MCP commit force every line to 0%
 * (momsfri) server-side, so a non-momsregistrerad company never books output VAT.
 */
export function getAvailableVatRates(
  customerType: CustomerType,
  vatNumberValidated: boolean = false,
): VatRateOption[] {
  // EU business with validated VAT → reverse charge, locked to 0%
  if (customerType === 'eu_business' && vatNumberValidated) {
    return [{ rate: 0, label: '0% (omvänd skattskyldighet)', treatment: 'reverse_charge' }]
  }

  // Non-EU → export, locked to 0%
  if (customerType === 'non_eu_business') {
    return [{ rate: 0, label: '0% (export)', treatment: 'export' }]
  }

  // Swedish customers (or EU without validated VAT) can choose any rate
  return [
    { rate: 25, label: '25%', treatment: 'standard_25' },
    { rate: 12, label: '12%', treatment: 'reduced_12' },
    { rate: 6, label: '6%', treatment: 'reduced_6' },
    { rate: 0, label: '0% (momsfritt)', treatment: 'exempt' },
  ]
}

/**
 * The set of VAT rates an article's stored rate may be ADOPTED from when the
 * article prefills an invoice line (web line picker parity: the picker only
 * adopts a rate the customer could have picked themselves). Empty when the
 * customer is locked to a single rate (foreign business 0% reverse charge /
 * export): an article's stored rate is its DOMESTIC rate, and adopting it
 * there would silently put Swedish VAT on a reverse-charge or export invoice
 * even though the wider permitted set would accept it. This governs PREFILL
 * only; every validation gate keeps using getPermittedVatRates().
 */
export function getArticleVatRateAdoptionSet(
  customerType: CustomerType,
  vatNumberValidated: boolean = false,
): ReadonlySet<number> {
  const offered = getAvailableVatRates(customerType, vatNumberValidated)
  return new Set(offered.length > 1 ? offered.map((r) => r.rate) : [])
}

/**
 * Get the VAT rates that may LEGALLY appear on an invoice line for this
 * customer type. This is the set validation must gate on.
 *
 * Distinct from getAvailableVatRates(), which is only the DEFAULT offered in
 * the picker. Under huvudregeln (ML 6 kap. 34 §, Article 44 VAT Directive)
 * "B2B services taxed where buyer established", so 0% (reverse charge for a
 * VAT-validated EU business, export outside the EU) is the right DEFAULT for a
 * foreign business customer. It is not the only lawful rate.
 *
 * ML 6 kap. (plats för transaktioner) carries exceptions that are taxed where
 * the supply is performed, and therefore carry Swedish VAT even when the buyer
 * is a foreign business. Per the swedish-vat reference, the exceptions "(taxed
 * where performed)" are:
 *
 *   - Fastighetstjänster (property location)                        25%
 *   - Persontransporter (where transport occurs)                     6%
 *   - Korttidsuthyrning transport vehicles (pickup location)        25%
 *   - Restaurang/catering (where performed)                         12%
 *   - Admission to cultural/sports events (event location)           6%
 *
 * A Stockholm hotel night or a conference ticket sold to a German or a US
 * company is such a supply. Refusing every non-zero rate for these customers
 * makes those invoices impossible to issue at all. Because the exceptions span
 * 25%, 12% and 6%, no single non-zero rate can be whitelisted instead.
 *
 * Nothing on an invoice line distinguishes "consulting for a German company"
 * (0%, reverse charge) from "hotel night in Stockholm sold to a German company"
 * (12% Swedish VAT), so this set only widens what is ACCEPTED. The default stays
 * 0% via getAvailableVatRates() and getVatRules().rate, which is also the
 * fallback when a line omits vat_rate. A Swedish rate therefore lands on such an
 * invoice only when it was set explicitly on that line.
 */
export function getPermittedVatRates(
  customerType: CustomerType,
  vatNumberValidated: boolean = false,
): VatRateOption[] {
  const offered = getAvailableVatRates(customerType, vatNumberValidated)

  const isForeignBusiness =
    customerType === 'non_eu_business' ||
    (customerType === 'eu_business' && vatNumberValidated)
  if (!isForeignBusiness) {
    return offered
  }

  // The 0% reverse-charge / export option stays FIRST so any consumer that
  // treats element 0 as the default keeps defaulting to 0%.
  return [
    ...offered,
    { rate: 25, label: '25%', treatment: 'standard_25' },
    { rate: 12, label: '12%', treatment: 'reduced_12' },
    { rate: 6, label: '6%', treatment: 'reduced_6' },
  ]
}

/**
 * Map a numeric VAT rate to a VatTreatment.
 */
export function getVatTreatmentForRate(rate: number): VatTreatment {
  switch (rate) {
    case 25:
      return 'standard_25'
    case 12:
      return 'reduced_12'
    case 6:
      return 'reduced_6'
    case 0:
      return 'exempt'
    default:
      return 'standard_25'
  }
}

export interface VatRule {
  treatment: VatTreatment
  rate: number
  momsRuta: string
  reverseChargeText?: string
}

/**
 * Statutory notices stamped on an invoice's reverse_charge_text at create
 * time. The stored value is a snapshot, so the PDF template matches against
 * these exact strings to render the notice in the recipient's language;
 * keep them byte-identical to what getVatRules() writes.
 */
export const EU_REVERSE_CHARGE_NOTICE =
  'Omvänd skattskyldighet / Reverse charge - VAT to be accounted for by the recipient as per Article 196, Council Directive 2006/112/EC'
export const EXPORT_NOTICE_SV = 'Omsättning utanför EU, ML 10 kap.'

/**
 * Determine VAT treatment based on customer type and VAT validation status.
 *
 * Rules:
 * - Swedish customers: 25% VAT, moms ruta 05
 * - EU business with validated VAT: 0% reverse charge, moms ruta 39
 * - EU business without validated VAT: 25% VAT, moms ruta 05
 * - Non-EU business: 0% export, moms ruta 40
 *
 * Independent of the seller's VAT registration status. A non-momsregistrerad
 * seller who charges VAT still owes it under ML 16 kap. 23 § (faktureringsmoms),
 * so the rule output must reflect the rate actually charged on the line.
 */
export function getVatRules(
  customerType: CustomerType,
  vatNumberValidated: boolean = false,
): VatRule {
  switch (customerType) {
    case 'individual':
    case 'swedish_business':
      return {
        treatment: 'standard_25',
        rate: 25,
        momsRuta: '05',
      }

    case 'eu_business':
      if (vatNumberValidated) {
        return {
          treatment: 'reverse_charge',
          rate: 0,
          momsRuta: '39',
          reverseChargeText: EU_REVERSE_CHARGE_NOTICE,
        }
      }
      // EU business without validated VAT number must be charged Swedish VAT
      return {
        treatment: 'standard_25',
        rate: 25,
        momsRuta: '05',
      }

    case 'non_eu_business':
      return {
        treatment: 'export',
        rate: 0,
        momsRuta: '40',
        reverseChargeText: EXPORT_NOTICE_SV,
      }

    default:
      return {
        treatment: 'standard_25',
        rate: 25,
        momsRuta: '05',
      }
  }
}

/**
 * Get VAT treatment label in Swedish
 */
export function getVatTreatmentLabel(treatment: VatTreatment): string {
  const labels: Record<VatTreatment, string> = {
    standard_25: '25% moms',
    reduced_12: '12% moms',
    reduced_6: '6% moms',
    reverse_charge: 'Omvänd skattskyldighet (0%)',
    export: 'Export (0%)',
    exempt: 'Momsfritt',
  }
  return labels[treatment]
}
