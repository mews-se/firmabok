'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { Bell, BellOff, Loader2 } from 'lucide-react'

interface PushPromptProps {
  onSubscribed?: () => void
  onDismissed?: () => void
}

export function PushPrompt({ onSubscribed, onDismissed }: PushPromptProps) {
  const { toast } = useToast()
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isSupported, setIsSupported] = useState(false)
  const [isSubscribed, setIsSubscribed] = useState(false)

  useEffect(() => {
    // Check if push notifications are supported
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      setIsSupported(true)
      checkSubscription()
    }
  }, [])

  const checkSubscription = async () => {
    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      setIsSubscribed(!!subscription)
    } catch (error) {
      console.error('Error checking push subscription:', error)
    }
  }

  const requestPermission = async () => {
    if (!isSupported) return

    setIsLoading(true)

    try {
      // Request notification permission
      const permission = await Notification.requestPermission()

      if (permission !== 'granted') {
        toast({
          title: 'Aviseringar avslagna',
          description: 'Du kan aktivera aviseringar senare i inställningarna.',
        })
        setIsOpen(false)
        onDismissed?.()
        return
      }

      // Get VAPID public key
      const vapidResponse = await fetch('/api/extensions/ext/push-notifications/subscribe')
      const { vapidPublicKey } = await vapidResponse.json()

      if (!vapidPublicKey) {
        throw new Error('Push notifications not configured')
      }

      // Subscribe to push notifications
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      })

      // Send subscription to server
      const response = await fetch('/api/extensions/ext/push-notifications/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      })

      if (!response.ok) {
        throw new Error('Failed to save subscription')
      }

      setIsSubscribed(true)
      setIsOpen(false)

      toast({
        title: 'Aviseringar aktiverade',
        description: 'Du kommer få påminnelser om viktiga deadlines.',
      })

      onSubscribed?.()
    } catch (error) {
      console.error('Error subscribing to push:', error)
      toast({
        title: 'Fel',
        description: 'Kunde inte aktivera aviseringar. Försök igen senare.',
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleDismiss = () => {
    setIsOpen(false)
    // Store dismissal in localStorage to not show again
    localStorage.setItem('push-prompt-dismissed', 'true')
    onDismissed?.()
  }

  // Don't show if not supported, already subscribed, or previously dismissed
  if (!isSupported || isSubscribed) {
    return null
  }

  // Show dialog after a delay or when triggered
  return (
    <>
      {/* Floating button to show prompt */}
      <Button
        variant="outline"
        size="sm"
        className="fixed bottom-4 right-4 gap-2 shadow-lg z-50"
        onClick={() => setIsOpen(true)}
      >
        <Bell className="h-4 w-4" />
        Aktivera aviseringar
      </Button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bell className="h-5 w-5 text-primary" />
              Aktivera push-aviseringar
            </DialogTitle>
            <DialogDescription>
              Få påminnelser om viktiga skattedeadlines, fakturor som förfaller och
              kampanjleveranser direkt i din webbläsare.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="grid gap-2 text-sm">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-primary rounded-full" />
                <span>Skattedeadlines (7 och 1 dag innan)</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-primary rounded-full" />
                <span>Fakturor som förfaller</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-primary rounded-full" />
                <span>Kampanjleveranser</span>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Du kan när som helst stänga av aviseringar i inställningarna.
              Vi respekterar tysta timmar (21:00-08:00).
            </p>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" onClick={handleDismiss}>
              Inte nu
            </Button>
            <Button onClick={requestPermission} disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Aktiverar...
                </>
              ) : (
                <>
                  <Bell className="mr-2 h-4 w-4" />
                  Aktivera
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * Convert base64 VAPID key to Uint8Array for subscription
 */
function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }

  return outputArray.buffer
}
