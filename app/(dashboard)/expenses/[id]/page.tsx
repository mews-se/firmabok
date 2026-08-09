import { redirect } from 'next/navigation'

export default async function ExpenseDetailRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  redirect(`/supplier-invoices/${id}`)
}
