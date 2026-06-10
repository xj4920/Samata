import type { MigrationContext } from '../migrate.js';

export async function up(_context: MigrationContext): Promise<void> {
  // This migration intentionally has no data side effects. Its recorded ID proves
  // the Umzug runner is wired to the existing SQLite migrations table.
}
