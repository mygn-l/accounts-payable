// The bank and the card processor, outside the app. Runs alongside the server and watches the payment instructions the app
// leaves in BANK_DIR/outbox when a payment is released. Each one is answered 10 to 20 seconds later, at random:
// - mostly paid, as the bank reports it: an EFT on the statement with the last 6 digits of its reference, a cheque when it
//   clears, a card payment as a charge on the virtual card made for the invoice;
// - sometimes returned: a "PAYMENT RETURNED" line on the statement with the reason (an account closed, a cheque stopped,
//   a card declined); the app then marks the payment failed and the invoice can be paid again.
// The app reads what the bank wrote every few seconds. npm run dev and npm start run it alongside the server; on its own: npm run bank.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { useDatasetDate } from "../src/lib/asOfDate";

process.loadEnvFile(path.join(import.meta.dirname, "../.env.local"));
if (!process.env.BANK_DIR) throw new Error("Set BANK_DIR in .env.local");
const DIR = path.resolve(import.meta.dirname, "..", process.env.BANK_DIR);
// the date the bank posts on: the app's business date
useDatasetDate(path.resolve(import.meta.dirname, ".."));
const today = process.env.AS_OF_DATE || new Date().toLocaleDateString("en-CA");

const RETURN_SHARE = 0.2; // about one payment in five comes back
const REASONS = { EFT: ["account closed", "invalid account number"], CHEQUE: ["stopped by the vendor", "lost in the mail"], CARD: ["card declined"] };

type Instruction = {
  payment_id: string; invoice_id: string; method: "EFT" | "CHEQUE" | "CARD"; scheduled_date: string | null; currency: string; amount: number;
  amount_cad: number; vendor: string; reference: string; cheque_number: number | null; card_id: string | null; released_by: string;
};

const outbox = path.join(DIR, "outbox");
const done = path.join(outbox, "done");
mkdirSync(done, { recursive: true });

const cell = (v: string | number | null) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const row = (vs: (string | number | null)[]) => vs.map(cell).join(",");
const write = (sub: string, header: string, line: string) => {
  mkdirSync(path.join(DIR, sub), { recursive: true });
  writeFileSync(path.join(DIR, sub, `${sub}-${Date.now()}.csv`), `${header}\n${line}\n`);
};
const STATEMENT = "bank_txn_id,posted_date,description,debit,credit";
const CARD = "txn_id,card_id,cardholder_user_id,posted_date,merchant_descriptor,mcc,amount,currency,amount_cad,source,receipt_attached,memo";
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

// The bank's answer to one instruction.
function answer(i: Instruction) {
  const id = `${today.replace(/-/g, "")}-${i.payment_id}`;
  const ref = i.method === "EFT" ? i.reference.slice(-6) : i.method === "CHEQUE" ? String(i.cheque_number) : i.card_id!;
  if (Math.random() < RETURN_SHARE) {
    const reason = pick(REASONS[i.method]);
    // the money comes back: a credit
    write("statements", STATEMENT, row([`BK-${id}`, today, `PAYMENT RETURNED ${i.method} ${ref} ${reason}`, "", i.amount_cad.toFixed(2)]));
    console.log(`${i.payment_id} (${i.method} ${i.vendor}): returned, ${reason}`);
  } else if (i.method === "CARD") {
    write("card", CARD, row([`CT-${id}`, i.card_id, i.released_by, today, i.vendor.toUpperCase(), "", i.amount.toFixed(2), i.currency, i.amount_cad.toFixed(2), "ap_virtual_card", "yes", `AP payment ${i.invoice_id}`]));
    console.log(`${i.payment_id} (CARD ${i.vendor}): charged`);
  } else {
    const description = i.method === "EFT" ? `EFT PMT ${i.vendor.toUpperCase().slice(0, 25)} ${ref}` : `CHEQUE ${ref} CLEARED`;
    write("statements", STATEMENT, row([`BK-${id}`, today, description, i.amount_cad.toFixed(2), ""]));
    console.log(`${i.payment_id} (${i.method} ${i.vendor}): paid`);
  }
}

// Every instruction is answered once: it is taken out of the outbox when picked up, and answered 10 to 20 seconds later.
function look() {
  for (const file of readdirSync(outbox).filter((f) => f.endsWith(".json"))) {
    const i = JSON.parse(readFileSync(path.join(outbox, file), "utf8")) as Instruction;
    renameSync(path.join(outbox, file), path.join(done, file));
    const wait = 10 + Math.random() * 10;
    console.log(`${i.payment_id}: received, answering in ${wait.toFixed(0)} s`);
    setTimeout(() => answer(i), wait * 1000);
  }
}

console.log(`The bank is watching ${outbox}`);
if (existsSync(outbox)) look();
setInterval(look, 2000);
