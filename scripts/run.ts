// Starts everything the app needs, together. First the database is cleared and Harborline's records loaded again
// (scripts/reset-db.sh, then scripts/ingest.ts setup and history), so every start begins from the same data; then the
// server (reloading on changes for "dev", which keeps the data) and the simulated bank (scripts/bank.ts) run side by side,
// and once the server answers, the AP inbox is polled (scripts/ingest.ts inbox) and its emails read in the background.
// Ctrl+C, or either one stopping, stops both. Usage: npm run dev | npm start; add --keep-data to start without the reset.
import { spawn, spawnSync, type ChildProcess } from "child_process";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const mode = process.argv[2] === "start" ? "start" : "dev";
const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");

const run = (name: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  const child = spawn(tsx, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["inherit", "pipe", "pipe"] });
  // the bank's lines are marked, so they can be told apart from the server's
  const tag = name === "bank" ? "[bank] " : "";
  child.stdout!.on("data", (b: Buffer) => process.stdout.write(tag ? b.toString().replace(/^(?=.)/gm, tag) : b));
  child.stderr!.on("data", (b: Buffer) => process.stderr.write(tag ? b.toString().replace(/^(?=.)/gm, tag) : b));
  return child;
};

// a fresh database with Harborline's records, unless asked to keep the data
if (!process.argv.includes("--keep-data")) {
  for (const [cmd, args] of [["sh", ["scripts/reset-db.sh"]], [tsx, ["scripts/ingest.ts", "setup"]], [tsx, ["scripts/ingest.ts", "history"]]] as const) {
    const r = spawnSync(cmd, [...args], { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`Could not prepare the database (${[cmd, ...args].join(" ")}); start with --keep-data to skip this.`);
      process.exit(1);
    }
  }
}

const children: ChildProcess[] = [
  mode === "dev"
    ? run("server", ["watch", "--clear-screen=false", "src/server/index.ts"])
    : run("server", ["src/server/index.ts"], { NODE_ENV: "production" }),
  run("bank", ["scripts/bank.ts"]),
];

// once the server answers, the inbox: the emails come in and the server reads them, as when a clerk polls it
const fresh = !process.argv.includes("--keep-data");
if (fresh) {
  const base = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  void (async () => {
    for (let i = 0; i < 120; i++) {
      const up = await fetch(`${base}/api/session`).then(() => true, () => false);
      if (up) {
        spawn(tsx, ["scripts/ingest.ts", "inbox"], { cwd: ROOT, env: { ...process.env, BASE_URL: base }, stdio: "inherit" });
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.error("The server did not answer within two minutes; the inbox was not polled.");
  })();
}

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
};
for (const c of children) c.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
