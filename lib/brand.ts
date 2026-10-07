// product name for the UI, exports and manifest; docker-compose sets it per
// box through NEXT_PUBLIC_BRANDING_APP_NAME (inlined at build, substituted by
// docker-entrypoint.sh)
export const APP_NAME = process.env.NEXT_PUBLIC_BRANDING_APP_NAME || 'Accounted'
