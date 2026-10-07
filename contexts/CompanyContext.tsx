'use client'

import { createContext, useContext } from 'react'
import type { Company, CompanyRole } from '@/types'

interface CompanyContextValue {
  company: Company | null
  role: CompanyRole | null
  isSandbox: boolean
}

const CompanyContext = createContext<CompanyContextValue | null>(null)

export function CompanyProvider({
  children,
  value,
}: {
  children: React.ReactNode
  value: CompanyContextValue
}) {
  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>
}

export function useCompany() {
  const ctx = useContext(CompanyContext)
  if (!ctx) throw new Error('useCompany must be used within CompanyProvider')
  return ctx
}

export function useCompanyOptional() {
  return useContext(CompanyContext)
}
