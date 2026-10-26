export interface BrowserRuntimeDirectory {
  directory: string
  aliasDirectory: string | null
  temporaryDirectory: string
}
export function createBrowserRuntimeDirectory(storageParent: string): Promise<BrowserRuntimeDirectory | null>
export function removeBrowserRuntimeDirectory(runtime: BrowserRuntimeDirectory | null | undefined): Promise<void>
export function findBrowserVirtualDisplay(): Promise<string | null>
export function probeBrowserRuntime(descriptor: { rootDirectory: string; pythonExecutable: string; chromiumExecutable: string },
  options?: { signal?: AbortSignal; releaseDirectory?: string }): Promise<{ ready: boolean; reason: string | null }>
