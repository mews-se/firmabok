/**
 * Service Worker Registration Script
 * Include this in the main layout to register the service worker
 */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
      })

      console.log('Service Worker registered:', registration.scope)

      // Check for updates periodically
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // New service worker available
              console.log('New Service Worker available')
            }
          })
        }
      })
    } catch (error) {
      console.error('Service Worker registration failed:', error)
    }
  })
}
