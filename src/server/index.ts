import { existsSync } from "fs";
import path from "path";
import express from "express";
import cookieParser from "cookie-parser";

const ROOT = path.resolve(import.meta.dirname, "../..");
const envFile = path.join(ROOT, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { useDatasetDate } = await import("@/lib/asOfDate");
useDatasetDate(ROOT);

const REQUIRED = ["DATABASE_URL", "SESSION_SECRET", "FEEDS_DIR", "STORAGE_DIR", "BANK_DIR"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required settings: ${missing.join(", ")}. Copy .env.example to .env.local and fill them in.`);
  process.exit(1);
}
// Feed, storage and bank paths are relative to the repo root, whatever directory the server starts from.
for (const k of ["FEEDS_DIR", "STORAGE_DIR", "BANK_DIR"]) process.env[k] = path.resolve(ROOT, process.env[k]!);

// Loaded after the environment, since the database pool reads it when imported.
// An existing database is brought up to db/schema.sql first: each migration in db/migrations, in order. Each one is written
// to be safe to run again, so they all run on every start.
const { pool } = await import("@/lib/db");
const { readdirSync, readFileSync } = await import("fs");
const migrations = path.join(ROOT, "db", "migrations");
for (const f of readdirSync(migrations).filter((x) => x.endsWith(".sql")).sort()) {
  try {
    await pool.query(readFileSync(path.join(migrations, f), "utf8"));
  } catch (e) {
    console.error(`Database migration ${f} failed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

const { errors } = await import("./http");
const { session } = await import("./routes/session");
const { organizations, organization } = await import("./routes/organizations");
const { vendors } = await import("./routes/vendors");
const { invoices } = await import("./routes/invoices");
const { payments } = await import("./routes/payments");
const { audit } = await import("./routes/audit");
const { mcp } = await import("./mcp");
const { assistant } = await import("./routes/assistant");

const app = express();
app.use(cookieParser());

const api = express.Router();
api.use(express.json({ limit: "5mb" }));
api.use(session);
api.use("/organizations", organizations);
api.use(assistant);
for (const r of [organization, vendors, invoices, payments, audit]) api.use("/organizations/:orgId", r);
api.use((_req, res) => {
  res.status(404).json({ error: "No such endpoint" });
});
api.use(errors);
app.use("/api", api);

// The MCP server for employees' agents.
app.use("/mcp", express.json({ limit: "5mb" }), mcp);

// The React app: served by Vite with hot reload in development, from the build in production.
if (process.env.NODE_ENV === "production") {
  const dist = path.join(ROOT, "dist");
  app.use(express.static(dist));
  app.get("/{*path}", (_req, res) => res.sendFile("index.html", { root: dist }));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
}

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`http://localhost:${port}`));

// raw items stored but not read before the last stop
const { resumeReading } = await import("@/services/intake.service");
void resumeReading();

// what the bank reports is taken in every few seconds, so payments settle, or fail, on their own
const { importStatements } = await import("@/services/statement.service");
const importBank = () => importStatements().catch((e) => console.error("bank statement import failed:", e instanceof Error ? e.message : e));
void importBank();
setInterval(importBank, 5_000);
