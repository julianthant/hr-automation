import type { TaskRow, TaskTransitionOutcome } from '../task-store/index.js'

type DesiredTerminalState = 'done' | 'failed' | 'cancelled'

export type TerminalizationResult =
  | { kind: 'applied' }
  | { kind: 'reconciled' }
  | { kind: 'lease-lost' }
  | { kind: 'not-found' }
  | { kind: 'blocked-uncertain'; error: string }
  | { kind: 'conflict-terminal'; state: DesiredTerminalState }
  | { kind: 'unconfirmed'; error: string }

/**
 * Persist a terminal state under a bounded retry/read-reconcile loop. If the
 * write remains uncertain while the exact claim is still active, move it to a
 * durable blocked state; never return it to the executable queue.
 */
export async function terminalizeWithReconciliation(args: {
  desiredState: DesiredTerminalState
  transition: () => TaskTransitionOutcome | Promise<TaskTransitionOutcome>
  readTask: () => TaskRow | null
  blockUncertain: (reason: string) => TaskTransitionOutcome | Promise<TaskTransitionOutcome>
  maxAttempts?: number
}): Promise<TerminalizationResult> {
  const maxAttempts = args.maxAttempts ?? 3
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const outcome = await args.transition()
      const resolved = resolveOutcome(outcome, args.desiredState)
      if (resolved) return resolved
    } catch (err) {
      lastError = err
    }

    const current = args.readTask()
    if (!current) return { kind: 'not-found' }
    if (current.state === args.desiredState) return { kind: 'reconciled' }
    if (isTerminal(current.state) || current.state === 'blocked') return { kind: 'lease-lost' }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  const reason = `Uncertain persistence of terminal state '${args.desiredState}' after ${maxAttempts} attempts: ${message}`
  let blocked: TaskTransitionOutcome
  try {
    blocked = await args.blockUncertain(reason)
  } catch (err) {
    return { kind: 'unconfirmed', error: err instanceof Error ? err.message : String(err) }
  }
  if (blocked.kind === 'applied') return { kind: 'blocked-uncertain', error: reason }
  if (blocked.kind === 'not-found') {
    return { kind: 'unconfirmed', error: `uncertainty block target disappeared: ${reason}` }
  }
  const resolved = resolveOutcome(blocked, args.desiredState)
  return resolved ?? { kind: 'unconfirmed', error: `uncertainty block was not confirmed: ${reason}` }
}

function resolveOutcome(
  outcome: TaskTransitionOutcome,
  desiredState: DesiredTerminalState,
): TerminalizationResult | undefined {
  if (outcome.kind === 'applied') return { kind: 'applied' }
  if (outcome.kind === 'not-found') return { kind: 'not-found' }
  if (outcome.kind === 'lease-lost') return { kind: 'lease-lost' }
  if (outcome.state === desiredState) return { kind: 'reconciled' }
  return { kind: 'conflict-terminal', state: outcome.state }
}

function isTerminal(state: TaskRow['state']): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled'
}
