import { classifyError } from '../utils/errors.js'

export interface StepperOpts {
  workflow: string
  itemId: string
  runId: string
  emitStep: (name: string) => void
  emitData: (data: Record<string, unknown>) => void
  emitFailed: (step: string, error: string) => void
}

export class Stepper {
  private data: Record<string, unknown> = {}
  private currentStep: string | null = null

  constructor(private opts: StepperOpts) {}

  async step<R>(name: string, fn: () => Promise<R>): Promise<R> {
    this.currentStep = name
    this.opts.emitStep(name)
    try {
      return await fn()
    } catch (err) {
      const classified = classifyError(err)
      this.opts.emitFailed(name, classified)
      throw err
    }
  }

  updateData(patch: Record<string, unknown>): void {
    this.data = { ...this.data, ...patch }
    this.opts.emitData({ ...this.data })
  }

  getData(): Record<string, unknown> {
    return { ...this.data }
  }

  getCurrentStep(): string | null {
    return this.currentStep
  }
}
