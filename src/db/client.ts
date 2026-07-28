import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from './schema.js';

// @neondatabase/serverless connects over WebSocket and only picks up an
// environment's global WebSocket implicitly (stable in Node >=22) — wire
// the `ws` package explicitly so this also works on Node 20, which the
// engines field and CI target.
neonConfig.webSocketConstructor = ws;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export function createDb(databaseUrl: string = requireEnv('DATABASE_URL')) {
  const pool = new Pool({ connectionString: databaseUrl });
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;
