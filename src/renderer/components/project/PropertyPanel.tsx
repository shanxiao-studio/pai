import type { ReactNode } from 'react'

export function PropertyPanel({
  title = 'Properties',
  children,
  className = '',
}: {
  title?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <div className="bg-background/35 px-4 py-3 text-sm font-semibold">{title}</div>
      <div className="flex flex-col gap-3 p-4">{children}</div>
    </div>
  )
}

export function PropertyField({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <label className="grid min-h-8 grid-cols-[72px_minmax(0,1fr)] items-center gap-3 py-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center">{children}</div>
    </label>
  )
}
