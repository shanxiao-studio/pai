type ElectronApi = NonNullable<Window['electronAPI']>

export const electronClient = window.electronAPI as ElectronApi | undefined
