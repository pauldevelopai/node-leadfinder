# LeadFinder

A Node on **GROUNDED**. Overnight lead watching for businesses that sell to
contractors: pull from your sources, read each one, rank by likelihood to
convert, and drop anyone you already sell to.

```bash
npm install
cp .env.example .env      # add DATABASE_URL and ANTHROPIC_API_KEY
npm run build             # build the web UI into public/
npm start                 # local  (single newsroom)
npm run start:hosted      # hosted (multi-tenant, tracker cookie auth)
```

Read **NODE.md** before changing anything — particularly the migration-status
section, because this repo was extracted from the tracker and the cutover is not
finished.

Scoring is arithmetic, never model-decided. That is the rule the whole design
hangs off.
