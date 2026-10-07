import type { MetadataRoute } from 'next'
import { APP_NAME } from '@/lib/brand'

export default function manifest(): MetadataRoute.Manifest {
  const sizes = [72, 96, 128, 144, 152, 192, 384, 512]
  // Next.js's Icon type doesn't accept the space-separated "any maskable"
  // purpose, hence the cast.
  const icons = sizes.map((size) => ({
    src: `/icons/icon-${size}.png`,
    sizes: `${size}x${size}`,
    type: 'image/png',
    purpose: 'any maskable',
  })) as unknown as MetadataRoute.Manifest['icons']
  return {
    name: APP_NAME,
    short_name: APP_NAME,
    description: 'Ekonomihantering',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1a1a1a',
    orientation: 'portrait-primary',
    icons,
    lang: 'sv-SE',
  }
}
