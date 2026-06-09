import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function basename(path: string): string {
  const segments = path.replace(/[/\\]+$/, '').split(/[/\\]/)
  return segments[segments.length - 1] ?? path
}
