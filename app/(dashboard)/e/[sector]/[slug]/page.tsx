import { redirect, notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getExtensionDefinition } from '@/lib/extensions/sectors'
import ExtensionWorkspaceLoader from '@/components/extensions/ExtensionWorkspaceLoader'
import { requiredCapabilityForExtension } from '@/lib/entitlements/keys'
import { ExtensionSandboxLockState } from '@/components/extensions/ExtensionSandboxLockState'
import { extensionDescriptionKey, extensionNameKey } from '@/lib/extensions/i18n'
import {
  getDashboardAuthContext,
  getDashboardSettings,
} from '../../../request-context'

export default async function ExtensionWorkspacePage({
  params,
}: {
  params: Promise<{ sector: string; slug: string }>
}) {
  const { sector, slug } = await params
  const { user } = await getDashboardAuthContext()

  if (!user) redirect('/login')

  const definition = getExtensionDefinition(sector, slug)
  if (!definition) notFound()

  // An extension whose entire value is an external service (invoice-inbox →
  // AI field extraction) is blocked at the page for sandbox companies, not
  // just at its API routes, so a demo user never lands on a working-looking
  // workspace whose external calls the sandbox rejects (lib/sandbox/guard.ts).
  const requiredCapability = requiredCapabilityForExtension(sector, slug)
  if (requiredCapability) {
    const settings = await getDashboardSettings()
    if (settings.data?.is_sandbox === true) {
      const t = await getTranslations('extensions')
      // The manifest ships Swedish-only name/description; the slug maps to a
      // translated pair at the render layer (lib/extensions/i18n), same as the
      // sidebar. Fall back to the manifest for a slug with no mapping yet.
      const nameKey = extensionNameKey(slug)
      const descriptionKey = extensionDescriptionKey(slug)
      return (
        <ExtensionSandboxLockState
          iconName={definition.icon}
          title={t('sandbox_locked_title', { name: nameKey ? t(nameKey) : definition.name })}
          description={descriptionKey ? t(descriptionKey) : definition.description}
          note={t('sandbox_locked_note')}
          ctaLabel={t('sandbox_locked_cta')}
        />
      )
    }
  }

  return (
    <ExtensionWorkspaceLoader
      sector={sector}
      slug={slug}
      definition={definition}
      userId={user.id}
    />
  )
}
