// Spielt alle noch nicht angewendeten SQL-Dateien aus ../migrations in Namensreihenfolge ein.
// Jede Datei läuft in einer eigenen Transaktion. Angewendete Dateien nie nachträglich ändern,
// sondern eine neue Datei anlegen.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getPool, withTransaction, closePool } from './pool.ts';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function main(): Promise<void> {
  await getPool().query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const done = new Set(
    (await getPool().query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  let applied = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    await withTransaction(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    console.log(`✔ ${file}`);
    applied++;
  }
  console.log(applied ? `${applied} Migration(en) angewendet.` : 'Datenbank ist aktuell.');
}

main()
  .catch((err) => {
    console.error('Migration fehlgeschlagen:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
