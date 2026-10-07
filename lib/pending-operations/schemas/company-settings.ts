import { z } from 'zod'
import { UpdateSettingsSchema } from '@/lib/api/schemas'
import {
  validateBankgiroNumber,
  validatePlusgiroNumber,
} from '@/lib/bankgiro/luhn'

const CompanySettingsChangesSchema = z
  .object({
    bank_name: UpdateSettingsSchema.shape.bank_name,
    clearing_number: UpdateSettingsSchema.shape.clearing_number,
    account_number: UpdateSettingsSchema.shape.account_number,
    bankgiro: UpdateSettingsSchema.shape.bankgiro,
    plusgiro: UpdateSettingsSchema.shape.plusgiro,
    swish: UpdateSettingsSchema.shape.swish,
    iban: UpdateSettingsSchema.shape.iban,
    bic: UpdateSettingsSchema.shape.bic,
    default_our_reference: UpdateSettingsSchema.shape.default_our_reference,
    email: UpdateSettingsSchema.shape.email,
    phone: UpdateSettingsSchema.shape.phone,
    website: UpdateSettingsSchema.shape.website,
  })
  .strict()
  .superRefine((changes, ctx) => {
    if (Object.keys(changes).length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'At least one company setting must be supplied',
      })
    }

    if (changes.bankgiro && !validateBankgiroNumber(changes.bankgiro)) {
      ctx.addIssue({
        code: 'custom',
        path: ['bankgiro'],
        message: 'Invalid Bankgiro number',
      })
    }

    if (changes.plusgiro && !validatePlusgiroNumber(changes.plusgiro)) {
      ctx.addIssue({
        code: 'custom',
        path: ['plusgiro'],
        message: 'Invalid Plusgiro number',
      })
    }
  })

export const UpdateCompanySettingsParamsSchema = z
  .object({
    changes: CompanySettingsChangesSchema,
  })
  .strict()
