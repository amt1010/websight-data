import { pathToFileURL } from 'node:url';
import { createDb } from './db/client.js';
import { promoteToAdmin } from './db/users.js';

export function parseSeedAdminArgs(argv: string[]): { email: string } {
  const [email] = argv;
  if (!email) throw new Error('Usage: seed:admin <email>');
  return { email };
}

async function main() {
  const { email } = parseSeedAdminArgs(process.argv.slice(2));
  const db = createDb();
  const user = await promoteToAdmin(db, email);
  console.log(`Promoted ${user.email} to admin`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
