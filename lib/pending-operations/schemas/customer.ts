import { z } from 'zod'
import { UpdateCustomerSchema } from '@/lib/api/schemas'

const CustomerChangesSchema = z
  .object({
    name: UpdateCustomerSchema.shape.name,
    customer_type: UpdateCustomerSchema.shape.customer_type,
    customer_number: UpdateCustomerSchema.shape.customer_number,
    email: UpdateCustomerSchema.shape.email,
    phone: UpdateCustomerSchema.shape.phone,
    address_line1: UpdateCustomerSchema.shape.address_line1,
    address_line2: UpdateCustomerSchema.shape.address_line2,
    postal_code: UpdateCustomerSchema.shape.postal_code,
    city: UpdateCustomerSchema.shape.city,
    country: UpdateCustomerSchema.shape.country,
    org_number: UpdateCustomerSchema.shape.org_number,
    vat_number: UpdateCustomerSchema.shape.vat_number,
    language: UpdateCustomerSchema.shape.language,
    default_payment_terms: UpdateCustomerSchema.shape.default_payment_terms,
    notes: UpdateCustomerSchema.shape.notes,
  })
  .strict()
  .superRefine((changes, ctx) => {
    if (Object.keys(changes).length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'At least one customer field must be supplied',
      })
    }
  })

export const UpdateCustomerParamsSchema = z
  .object({
    customer_id: z.string().uuid(),
    changes: CustomerChangesSchema,
  })
  .strict()

export type UpdateCustomerParams = z.infer<typeof UpdateCustomerParamsSchema>
