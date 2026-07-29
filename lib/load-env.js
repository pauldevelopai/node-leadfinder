// load-env.js — load the Node's .env BEFORE anything else.
//
// This MUST be the first import in the entry files. Green Index builds its own pg pool
// at module-import time (lib/pool.js), and in ES modules all `import`s are evaluated
// before any body statement — so a body-level `dotenv.config()` would run too late and
// pool.js would see no DATABASE_URL (→ "SASL: client password must be a string"). By
// doing dotenv.config() as a side-effect of THIS imported module, it runs during import
// resolution, before pool.js is evaluated. override:true so the box .env wins over any
// stale pm2 environment.
import dotenv from 'dotenv';
dotenv.config({ override: true });
