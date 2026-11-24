import pg from 'pg';

// DATE-Spalten als 'YYYY-MM-DD' lesen statt als JavaScript-Date (das wäre Mitternacht in der
// Zeitzone des Servers und verschiebt Tage). Der Planer rechnet mit Ortsdatum des Nutzers.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

let pool: pg.Pool | undefined;

/** Alles, was SQL ausführen kann: der Pool oder ein Client in einer Transaktion. */
export interface Queryable {
  query<R extends pg.QueryResultRow = any>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** Gemeinsamer Verbindungspool für alle Apps (Bot, später API). */
export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL fehlt (siehe .env.example)');
    pool = new pg.Pool({ connectionString, max: 5 });
  }
  return pool;
}

/** Führt fn in einer Transaktion aus; bei Fehler wird alles zurückgerollt. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
