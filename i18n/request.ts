import { getRequestConfig } from 'next-intl/server'
import { APP_TIME_ZONE } from './config'

// the UI is Swedish only; no cookie or preference picks another locale
export default getRequestConfig(async () => {
  const messages = (await import('../messages/sv.json')).default

  return { locale: 'sv', messages, timeZone: APP_TIME_ZONE }
})
