type ElectronApi = NonNullable<Window['electronAPI']>

export const electronClient = typeof window === 'undefined'
  ? undefined
  : window.electronAPI as ElectronApi | undefined
