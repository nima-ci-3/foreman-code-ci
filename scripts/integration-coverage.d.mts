/** Per repository source file, a [line, column] inside each function the test ran. */
export type FunctionStarts = Record<string, [number, number][]>
export function startFileCoverage(): Promise<{
  (root: string, tracked: Set<string>): Promise<string[]>
  requiresStatic?: boolean
  functions?: FunctionStarts
}>
export function writeFileCoverage(directory: string, file: string, files: string[], requiresStatic?: boolean,
  functions?: FunctionStarts): void
