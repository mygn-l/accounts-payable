# Brim AP

Accounts payable for Brim business card customers: an Express API over Postgres, and a React app built with Vite.

- `src/server` — the Express app: routes under `/api`, which check the role and call the services.
- `src/services` — business rules and permissions.
- `src/lib` — database, auth, permissions, shared helpers.
- `src/web` — the React app; it reaches the server only through `/api`.
- `scripts` — database reset, the loader for the dataset's existing records, and `bank.ts`, which plays the bank outside the app.

## Run

```bash
npm run dev
```

Express serves the API and, in development, the React app through Vite on http://localhost:3000. Each start first clears the database and loads the dataset's existing records again, so every run begins from the same data (`npm run dev -- --keep-data` keeps the data instead). The same command starts the simulated bank (below), and the server brings an existing database up to date with `db/migrations`.

Every loaded account, and the Brim employee `ops@brim.example`, gets the password in `DEMO_PASSWORD` in `.env.local`.

Invoices are read by Claude: put your Anthropic API key in `ANTHROPIC_API_KEY` in `.env.local` and start (or restart) the server. Emails, uploads and scans are then read as they arrive, and anything left unread is read at startup. Without a key, `scripts/reader.ts` stands in for the API with readings of the dataset's own documents; `.env.example` says how to point the app at it.

### Another dataset

`brim_ap_dataset` can be replaced by another folder in the same format (or `DATASET_DIR` and `FEEDS_DIR` pointed at one); the next start loads it. The loader takes from it:

- the organization's name from the README's title (`# <name> AP dataset`), and the app's date from its `**As-of date:**` line;
- the approval rules from `approval_policies.csv`, read in the same wording (a rule worded otherwise is skipped, with a warning at start);
- the tax names and rates from `tax_codes.csv`, and the AP clerk who polls the inbox from `users.csv`.

The organization's own GST/HST number is not in the dataset: set `ORG_GST_HST_NUMBER` to it, or leave it empty.

Load the dataset's existing records, then poll the AP inbox (the last step needs the server running):

```bash
./scripts/reset-db.sh && npx tsx scripts/ingest.ts setup && npx tsx scripts/ingest.ts history && npx tsx scripts/ingest.ts inbox
```

## Payments and the bank

Releasing a payment sends it to the bank: its instruction goes to `BANK_DIR/outbox`. Outside the app, `scripts/bank.ts` plays the bank: run it alongside the server and it answers each released payment 10 to 20 seconds later, at random. Most are paid (a statement line or a virtual card charge); about one in five comes back returned, with a reason such as an account closed or a cheque stopped.

`npm run dev` and `npm start` run it alongside the server; `npm run bank` runs it on its own. The app reads the bank every few seconds: a paid line settles its payment and the invoice is paid; a returned one marks the payment failed, with the bank's reason, and the invoice goes back to approved so a new payment can be prepared.

## Agents (MCP)

Employees can let an AI agent work in the app for them. The MCP server is at `/mcp` (Streamable HTTP).

1. Log in, open the Account tab, and create a token under Agent access. It is shown once.
2. Add the server to your agent, for example Claude Code:

```bash
claude mcp add --transport http brim-ap http://localhost:3000/mcp --header "Authorization: Bearer brim_…"
```

The agent acts as you: it is offered only the tools your role allows, the same rules apply as in the website, and every action it takes is marked "agent" in the audit log. Revoke the token on the Account page to cut it off. The same token also works as `Authorization: Bearer` on the REST API.
