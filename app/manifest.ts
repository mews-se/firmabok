import type { MetadataRoute } from 'next'
import { ensureInitialized } from '@/lib/init'
import { getBranding } from '@/lib/branding/service'

// Guarantee branding extensions have registered before the manifest is built.
ensureInitialized()

export default function manifest(): MetadataRoute.Manifest {
  const b = getBranding()
  const sizes = [72, 96, 128, 144, 152, 192, 384, 512]
  // Next.js's Icon type doesn't accept the space-separated "any maskable" purpose
  // that the original public/manifest.json used. Cast preserves the same JSON
  // output so PWA install prompts behave identically to before.
  const icons = sizes.map((size) => ({
    src: `${b.pwaIconBasePath}/icon-${size}.png`,
    sizes: `${size}x${size}`,
    type: 'image/png',
    purpose: 'any maskable',
  })) as unknown as MetadataRoute.Manifest['icons']
  return {
    name: b.appName,
    short_name: b.appName,
    description: b.appDescription,
    start_url: '/',
    display: 'standalone',
    background_color: b.manifestBackgroundColor,
    theme_color: b.manifestThemeColor,
    orientation: 'portrait-primary',
    icons,
    categories: ['business', 'finance', 'productivity'],
    lang: 'sv-SE',
  }
}
