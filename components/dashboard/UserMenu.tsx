'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { useCompany } from '@/contexts/CompanyContext'
import {
  ChevronsUpDown,
  HelpCircle,
  LogOut,
  Settings,
} from 'lucide-react'

// Both inlined at build time (next.config.ts env): the package.json version
// and, for image builds, the git commit.
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? ''
const APP_COMMIT = process.env.NEXT_PUBLIC_APP_COMMIT ?? ''

interface UserMenuProps {
  userName: string | null
  userEmail: string | null
  isSandbox: boolean
  collapsed: boolean
  onLogout: () => void
}

// Best single-character initial for the avatar. Prefers the first letter of
// the full name; falls back to the email; falls back to "?" so the circle
// never renders empty.
function accountInitial(name: string | null, email: string | null): string {
  const trimmedName = name?.trim()
  if (trimmedName && trimmedName.length > 0) return trimmedName[0]!.toUpperCase()
  const trimmedEmail = email?.trim()
  if (trimmedEmail && trimmedEmail.length > 0) return trimmedEmail[0]!.toUpperCase()
  return '?'
}

/**
 * Sticky bottom-of-sidebar user block: avatar initials, name, active company,
 * chevron. Opens an upward popover aligned with the nav column holding
 * identity, the company-switcher flyout, account links and logout.
 * Concept reference: ui_migration_plan.md PR 2.
 */
export default function UserMenu({
  userName,
  userEmail,
  isSandbox,
  collapsed,
  onLogout,
}: UserMenuProps) {
  const { company, isSandbox: companyCtxSandbox } = useCompany()
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')

  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })

  const sandbox = isSandbox || companyCtxSandbox

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || !menuRef.current) return
    const triggerRect = triggerRef.current.getBoundingClientRect()
    const menuRect = menuRef.current.getBoundingClientRect()
    const margin = 8
    // Upward popover: bottom edge sits just above the trigger, left-aligned
    // with the nav column.
    const top = Math.max(margin, triggerRect.top - menuRect.height - 6)
    const left = Math.max(margin, triggerRect.left)
    setMenuPos({ top, left })
  }, [])

  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => updatePosition())
    return () => cancelAnimationFrame(raf)
  }, [open, updatePosition])

  const close = useCallback(() => {
    setOpen(false)
  }, [])

  // Outside click. Two carve-outs: elements already removed from the DOM
  // (isConnected: clicking a row that re-renders must not read as outside,
  // known concept bug pattern), and portaled dialogs opened above the menu.
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.isConnected) return
      if (target.closest('[role="dialog"]')) return
      if (
        (!triggerRef.current || !triggerRef.current.contains(target)) &&
        (!menuRef.current || !menuRef.current.contains(target))
      ) {
        close()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open, close])

  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      // Never while a dialog is open (it handles its own Esc).
      if (document.querySelector('[role="dialog"]')) return
      close()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, close])

  const menuRow =
    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] ' +
    'text-muted-foreground hover:text-foreground hover:bg-secondary/60 ' +
    'transition-colors duration-150 cursor-pointer'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          'group flex w-full items-center rounded-lg text-left transition-colors duration-150 hover:bg-secondary/60',
          collapsed ? 'justify-center p-2' : 'gap-2.5 px-3 py-2',
        )}
      >
        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold uppercase text-foreground">
          {accountInitial(userName, userEmail)}
        </span>
        {!collapsed && (
          <>
            <span className="flex-1 min-w-0">
              <span className="block truncate text-[13px] font-medium text-foreground leading-tight">
                {userName?.trim() || userEmail || tNav('mitt_konto')}
              </span>
              {company && (
                <span className="block truncate text-[11px] text-muted-foreground leading-tight">
                  {company.name}
                </span>
              )}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground opacity-50 group-hover:opacity-100" />
          </>
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-[60] w-[232px] rounded-lg border border-border bg-popover py-1 shadow-lg animate-in fade-in slide-in-from-bottom-1 duration-150"
            style={{ top: menuPos.top, left: menuPos.left }}
          >
            {/* Identity */}
            {(userName || userEmail) && (
              <div className="border-b border-border/60 px-3 py-2.5">
                {userName && (
                  <p className="truncate text-[13px] font-medium text-foreground">{userName}</p>
                )}
                {userEmail && (
                  <p className="truncate text-[11px] text-muted-foreground">{userEmail}</p>
                )}
              </div>
            )}

            {/* Account links */}
            <div className="px-1 pb-1">
              <Link href="/settings" onClick={close} className={menuRow}>
                <Settings className="h-4 w-4 flex-shrink-0" />
                {tNav('settings')}
              </Link>
              <div className="my-1 border-t border-border/60" />
              <Link href="/help" onClick={close} className={menuRow}>
                <HelpCircle className="h-4 w-4 flex-shrink-0" />
                {tNav('help')}
              </Link>
              <div className="my-1 border-t border-border/60" />
              <button
                type="button"
                onClick={() => {
                  close()
                  onLogout()
                }}
                className={cn(menuRow, 'text-destructive hover:text-destructive')}
              >
                <LogOut className="h-4 w-4 flex-shrink-0" />
                {sandbox ? tNav('logout_sandbox') : tCommon('logout')}
              </button>
            </div>

            {APP_VERSION && (
              <div className="border-t border-border/60 px-3 pt-2 pb-1">
                <p
                  className="text-[11px] tabular-nums text-muted-foreground"
                  title={APP_COMMIT ? APP_COMMIT.slice(0, 7) : undefined}
                >
                  {tNav('version', { version: APP_VERSION })}
                </p>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
