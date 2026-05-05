import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../tracker/state/schema.js'

export const CONTROL_SCHEMA_VERSION = LATEST_SCHEMA_VERSION

export interface ControlMigration {
  version: number
  sql: string
}

export const CONTROL_MIGRATIONS: readonly ControlMigration[] = MIGRATIONS
