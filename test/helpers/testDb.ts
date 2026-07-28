import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from '../../src/db/schema.js';
import { crawls, pages, clusters, integrations } from '../../src/db/schema.js';

neonConfig.webSocketConstructor = ws;

export function createTestDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL must be set to run db tests against a real Neon test branch');
  }
  const pool = new Pool({ connectionString: url });
  return drizzle(pool, { schema });
}

export type TestDb = ReturnType<typeof createTestDb>;

export async function resetDb(db: TestDb): Promise<void> {
  await db.delete(pages);
  await db.delete(clusters);
  await db.delete(integrations);
  await db.delete(crawls);
}
