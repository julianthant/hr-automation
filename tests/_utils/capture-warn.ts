import { log } from '../../src/utils/log.js'

/**
 * Stub `log.warn` for the duration of `fn`, collecting message strings.
 * Restores the original implementation on success or failure.
 */
export async function captureLogWarn<T>(
  fn: () => Promise<T>,
): Promise<{ warnings: string[]; result: T }> {
  const original = log.warn
  const warnings: string[] = []
  log.warn = (msg: Parameters<typeof log.warn>[0]) => {
    warnings.push(typeof msg === 'string' ? msg : msg.message)
  }
  try {
    const result = await fn()
    return { warnings, result }
  } finally {
    log.warn = original
  }
}

export function detailFieldNeverPopulatedWarnings(warnings: string[]): string[] {
  return warnings.filter(
    (m) => m.includes("detailField '") && m.includes('never populated'),
  )
}
