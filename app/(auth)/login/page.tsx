import { Suspense } from 'react'
import { AuthPageSkeleton } from '@/components/auth/AuthPageSkeleton'
import { LoginClient } from './login-client'

// The Suspense wrapper is required because the client component uses
// useSearchParams(), which forces dynamic rendering in Next.js 16.
export default function LoginPage() {
  return (
    <Suspense fallback={<AuthPageSkeleton />}>
      <LoginClient />
    </Suspense>
  )
}
