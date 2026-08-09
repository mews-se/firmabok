# Service Integration Patterns

Two patterns for extensions to provide services to core. Both ensure core compiles without the extension.

## Pattern A: Interface Registration

Best for single-implementation services (e.g., email). Core defines interface + noop default; extension registers at load time.

```typescript
// Core: lib/email/service.ts
let emailService: EmailService = new NoopEmailService()
export function getEmailService(): EmailService { return emailService }
export function registerEmailService(svc: EmailService): void { emailService = svc }

// Extension: extensions/general/email/index.ts
import { registerEmailService } from '@/lib/email/service'
registerEmailService(new ResendEmailService())  // Registers at module load
export const emailExtension: Extension = { id: 'email', name: 'Email', version: '1.0.0' }

// Core consumption:
const svc = getEmailService()
if (svc.isConfigured()) await svc.sendEmail({ to, subject, html })
```

## Pattern B: Services Record

Best for multiple named functions (e.g., AI categorization). Extension exposes via `services`; core discovers via registry.

```typescript
// Extension:
services: {
  findSimilarTemplates: async (...args: unknown[]) => {
    const { findSimilarTemplates } = await import('./lib/template-embeddings')
    return findSimilarTemplates(args[0] as Transaction, args[1] as EntityType)
  },
},

// Core facade (lib/bookkeeping/template-embeddings.ts):
const aiExt = extensionRegistry.get('ai-categorization')
if (aiExt?.services?.findSimilarTemplates) {
  return aiExt.services.findSimilarTemplates(transaction, entityType)
}
return findMatchingTemplates(transaction, entityType)  // Fallback
```

## Pattern C: Core Services for Extensions

Extensions consume core services via `ctx.services`:

```typescript
await ctx?.services.ingestTransactions(ctx.supabase, ctx.userId, rawTransactions)
```

## Comparison

| Aspect | Interface Registration | Services Record |
|--------|----------------------|-----------------|
| Defined in | Core (`lib/`) | Extension (`index.ts`) |
| Discovery | `get*()` getter | `extensionRegistry.get().services` |
| Functions | Single interface | Multiple named |
| Lazy imports | No | Yes (inside service fns) |
| Fallback | Noop default | Core provides fallback |
| Example | Email | AI categorization |
