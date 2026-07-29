// pool.js — the Node's own Postgres pool.
//
// Green Index keeps relational claims data + pgvector, so it uses a real pg pool
// (the node-analytics pattern) rather than host.store. Hosted: DATABASE_URL points
// at the shared box Postgres (where the runtime also creates node_greenindex_activity
// / _store). Local: point DATABASE_URL at any Postgres that has the `vector` and
// `uuid-ossp` extensions — this Node is hosted-first (full semantic retrieval needs
// pgvector), so a downloaded copy needs its own pgvector Postgres too.
import pg from 'pg';

const pool = new pg.Pool(
  process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}
);

export default pool;
