import { Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import Link from 'next/link'

interface FallbackPromptProps {
  message: string
  linkHref: string
  linkLabel: string
}

export function FallbackPrompt({ message, linkHref, linkLabel }: FallbackPromptProps) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/50 p-4">
      <Upload className="h-5 w-5 shrink-0 text-muted-foreground" />
      <p className="flex-1 text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" asChild>
        <Link href={linkHref}>{linkLabel}</Link>
      </Button>
    </div>
  )
}
