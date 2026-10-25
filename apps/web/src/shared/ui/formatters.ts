/** The one file-size wording: B under 1 KB, then KB and MB with at most one decimal. */
export function formatFileSize(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`
  if (byteSize < 1024 * 1024) return `${Number((byteSize / 1024).toFixed(1))} KB`
  return `${Number((byteSize / (1024 * 1024)).toFixed(1))} MB`
}
