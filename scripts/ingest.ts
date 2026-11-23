// Loads the dataset in DATASET_DIR (the brim_ap_dataset format). setup and history write the organization's records and past invoices straight into the database,
// with the dataset's own ids and dates; each past invoice still goes through the app's resolution and checks, so its flags are raised.
// The actions the dataset records (submissions, approvals, payments, bank changes) go into the audit log under their people and times.
// inbox polls the AP inbox through the running app, the way new invoices arrive.
// Usage: npx tsx scripts/ingest.ts setup|history (database only), npx tsx scripts/ingest.ts inbox (dev server running)
import { readFileSync } from "fs";
import path from "path";
import { parseCsv } from "../src/lib/csv";

process.loadEnvFile(path.join(import.meta.dirname, "../.env.local"));
// Every loaded account gets this password (DEMO_PASSWORD in .env.local).
const PASSWORD = process.env.DEMO_PASSWORD;
if (!PASSWORD) throw new Error("Set DEMO_PASSWORD in .env.local");

const { tx, query, one, nextId, pool } = await import("../src/lib/db");
const { setPassword } = await import("../src/services/auth.service");
const { EMPTY, resolveAndCheck } = await import("../src/services/pipeline.service");
const { bankLine, cardLine, insertLine } = await import("../src/services/statement.service");
const { invoiceNumberCore } = await import("../src/lib/normalize");
type RawItem = import("../src/services/rawIntake.service").RawItem;
type InvoiceData = import("../src/lib/types").InvoiceData;

const DATA = path.resolve(import.meta.dirname, "..", process.env.DATASET_DIR ?? "brim_ap_dataset", "data");
const csv = (name: string) => parseCsv(readFileSync(path.join(DATA, `${name}.csv`), "utf8"));
const num = (s: string) => (s === "" ? null : Number(s));
const yes = (s: string) => s === "yes";
const orNull = (s: string) => (s === "" ? null : s);

// The organization is the one the dataset is about, named in its README's title ("# <name> AP dataset"); its id is ORG- and
// the name's first word. Its own GST/HST number is printed on its invoices, not in the dataset: ORG_GST_HST_NUMBER, when set.
const README = readFileSync(path.join(DATA, "..", "README.md"), "utf8");
const ORG_NAME = README.match(/^#\s+(.+?)\s+AP dataset/m)?.[1]?.trim();
if (!ORG_NAME) throw new Error("The dataset README's title should read \"# <organization> AP dataset\".");
const ORG = `ORG-${ORG_NAME.split(/\s+/)[0].toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
const ORG_GST = process.env.ORG_GST_HST_NUMBER || null;

// The dataset's rules (free-text conditions) as: when [field] [operator] [value], require [required]. The conditions are read
// in the dataset's wording; "Requester is the approver" and "Approver is on leave" are how every approval chain works, not policies.
type PolicyShape = { rule_type: string; field: string; operator: string; value: string | null; required: string[] };
const ROLE_WORDS: Record<string, string> = { controller_admin: "controller", "not the invoice approver": "not_approver" };
const amount = (s: string) => s.replace(/[$,]/g, "");
function policyShape(p: Record<string, string>): PolicyShape | "chain" | null {
  const c = p.condition.trim();
  const required = p.required.split(">").map((r) => r.trim()).map((r) => ROLE_WORDS[r] ?? r);
  let m: RegExpMatchArray | null;
  if (/^requester is the approver|^approver is on leave/i.test(c)) return "chain";
  if ((m = c.match(/^(invoice total|payment) (up to|over) \$?([\d,.]+)/i))) {
    const field = /^invoice/i.test(m[1]) ? "invoice_total" : "payment_amount";
    return { rule_type: p.rule_type, field, operator: /up to/i.test(m[2]) ? "<=" : ">", value: amount(m[3]), required };
  }
  if ((m = c.match(/^vendor status is (\w+)( or the vendor is new)?/i)))
    return { rule_type: p.rule_type, field: "vendor_status", operator: "in", value: [m[1], ...(m[2] ? ["new"] : [])].join(","), required };
  if ((m = c.match(/^vendor category is (.+)$/i))) return { rule_type: p.rule_type, field: "vendor_category", operator: "is", value: m[1].trim(), required };
  if (/^always$/i.test(c) && p.rule_type === "payment_release") return { rule_type: p.rule_type, field: "any_payment", operator: "always", value: null, required };
  // matching a purchase order: over its remaining balance goes to the role in the notes; a missing one holds the invoice
  if (/references a po/i.test(c)) {
    const role = ["finance_manager", "controller", "cfo"].find((r) => p.notes.toLowerCase().includes(r.replace("_", " "))) ?? "finance_manager";
    return { rule_type: p.rule_type, field: "po_over_balance", operator: "always", value: null, required: [role] };
  }
  if (/requires a po/i.test(c)) return { rule_type: p.rule_type, field: "po_missing", operator: "always", value: null, required: ["hold"] };
  return null;
}

// The organization, its people, accounts, policies, vendors, bank changes, contracts and purchase orders, as the dataset has them.
async function setup() {
  await tx(async (c) => {
    await query("INSERT INTO organizations (organization_id, legal_name, gst_hst_number, base_currency) VALUES ($1,$2,$3,'CAD')", [ORG, ORG_NAME, ORG_GST], c);
    // a department's manager is checked at the end of the transaction, once the users exist
    for (const d of csv("departments")) {
      await query("INSERT INTO departments (department_id, organization_id, name, cost_centre, manager_user_id) VALUES ($1,$2,$3,$4,$5)", [d.department_id, ORG, d.name, orNull(d.cost_centre), orNull(d.manager_user_id)], c);
    }
    // users first without managers and delegates, who may not exist yet; then those links
    const users = csv("users");
    for (const u of users) {
      await query(
        `INSERT INTO users (user_id, organization_id, full_name, email, title, department_id, role, approval_limit_cad, work_province, status, status_since)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [u.user_id, ORG, u.full_name, u.email, orNull(u.title), orNull(u.department_id), u.role, num(u.approval_limit_cad), orNull(u.work_province), u.status, orNull(u.status_since)],
        c,
      );
      await setPassword(c, u.user_id, PASSWORD!);
    }
    for (const u of users) {
      await query("UPDATE users SET manager_id=$2, delegate_user_id=$3 WHERE user_id=$1", [u.user_id, orNull(u.manager_id), orNull(u.delegate_user_id)], c);
    }
    for (const g of csv("gl_accounts")) {
      await query("INSERT INTO gl_accounts (account_number, organization_id, name, account_type) VALUES ($1,$2,$3,$4)", [g.account_number, ORG, g.name, g.account_type], c);
    }
    for (const p of csv("approval_policies")) {
      const shape = policyShape(p);
      if (shape === "chain") continue;
      if (!shape) {
        console.warn(`Approval rule ${p.rule_id} was not loaded: its condition "${p.condition}" is not in a form the loader reads.`);
        continue;
      }
      await query(
        "INSERT INTO approval_policies (rule_id, organization_id, rule_type, field, operator, value, required, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,true)",
        [p.rule_id, ORG, shape.rule_type, shape.field, shape.operator, shape.value, shape.required],
        c,
      );
    }
    for (const v of csv("vendors")) {
      await query(
        `INSERT INTO vendors (vendor_id, organization_id, legal_name, category, default_gl_account, address, province_or_state, country, gst_hst_number, qst_number,
           payment_terms_days, early_pay_discount, preferred_payment_method, accepts_card_payment, bank_institution, bank_transit, bank_account, ap_contact_email,
           requires_po, status, onboarded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [
          v.vendor_id, ORG, v.legal_name, orNull(v.category), orNull(v.default_gl_account), orNull(v.address), orNull(v.province_or_state), orNull(v.country),
          orNull(v.gst_hst_number), orNull(v.qst_number), num(v.payment_terms_days), orNull(v.early_pay_discount), v.preferred_payment_method || "EFT",
          yes(v.accepts_card_payment), orNull(v.bank_institution), orNull(v.bank_transit), orNull(v.bank_account), orNull(v.ap_contact_email),
          yes(v.requires_po), v.status, orNull(v.onboarded_at),
        ],
        c,
      );
    }
    for (const b of csv("bank_change_history")) {
      await query(
        `INSERT INTO vendor_bank_changes (change_id, vendor_id, requested_at, requested_by, request_channel, new_account, verified_by_callback, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'approved')`,
        [b.change_id, b.vendor_id, b.changed_at, orNull(b.changed_by_user_id), b.request_channel, b.new_account_last4, yes(b.verified_by_callback)],
        c,
      );
      await audit(c, { at: b.changed_at, by: orNull(b.changed_by_user_id), action: "bank_change.request", entityType: "vendor_bank_change", entityId: b.change_id, vendorId: b.vendor_id });
    }
    for (const k of csv("contracts")) {
      await query(
        `INSERT INTO contracts (contract_id, vendor_id, description, monthly_fee, currency, hourly_rate_cap, fuel_surcharge_cap_pct, not_to_exceed_monthly,
           start_date, end_date, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [k.contract_id, k.vendor_id, orNull(k.description), num(k.monthly_fee), k.currency, num(k.hourly_rate_cap), num(k.fuel_surcharge_cap_pct),
          num(k.not_to_exceed_monthly), orNull(k.start_date), orNull(k.end_date), k.status],
        c,
      );
    }
    for (const p of csv("purchase_orders")) {
      await query(
        `INSERT INTO purchase_orders (po_id, vendor_id, department_id, requester_user_id, issue_date, description, total_amount, currency, status, approved_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [p.po_id, p.vendor_id, orNull(p.department_id), orNull(p.requester_user_id), orNull(p.issue_date), orNull(p.description), num(p.total_amount), p.currency,
          p.status, orNull(p.approved_by)],
        c,
      );
    }
  });
  console.log("setup done");
}

// An audit entry for an action the dataset records, under the person who took it (none for the system), when they took it.
const ROLES = new Map(csv("users").map((u) => [u.user_id, u.role]));
type Entry = { at: string; by: string | null; action: string; entityType: string; entityId: string; invoiceId?: string; paymentId?: string; vendorId?: string; note?: string | null; after?: unknown };
async function audit(c: Parameters<typeof query>[2], e: Entry) {
  await query(
    `INSERT INTO audit_events (organization_id, actor_user_id, actor_role, action, entity_type, entity_id, invoice_id, payment_id, vendor_id, after_json, note, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [ORG, e.by, e.by ? ROLES.get(e.by) ?? null : null, e.action, e.entityType, e.entityId, e.invoiceId ?? null, e.paymentId ?? null, e.vendorId ?? null,
      e.after === undefined ? null : JSON.stringify(e.after), e.note ?? null, e.at],
    c,
  );
}

// Each tax code as printed on an invoice: its tax's name (the code's leading letters) and rate, as HST13 → "HST (13%)".
const TAX_CODES = csv("tax_codes").filter((t) => Number(t.rate) > 0);
const TAX_LABEL = Object.fromEntries(TAX_CODES.map((t) => [t.code, `${t.code.match(/^[A-Z]+/)![0]} (${+(Number(t.rate) * 100).toFixed(3)}%)`]));
const FEDERAL = new Set(TAX_CODES.filter((t) => /^(GST|HST)/.test(t.code)).map((t) => t.code));

// The past invoices, oldest first. Each is the requester's form received on its received date, resolved and checked by the app,
// then an invoice with the dataset's status, approvals and payments.
async function history() {
  const vendors = new Map(csv("vendors").map((v) => [v.vendor_id, v]));
  const lines = csv("invoice_lines");
  const approvals = csv("approvals");
  const payments = csv("payments");
  const invoices = csv("invoices").sort((a, b) => a.invoice_date.localeCompare(b.invoice_date) || a.invoice_id.localeCompare(b.invoice_id));
  let n = 0;
  for (const inv of invoices) {
    const v = vendors.get(inv.vendor_id)!;
    const mine = lines.filter((l) => l.invoice_id === inv.invoice_id);
    const gstCode = mine.find((l) => FEDERAL.has(l.gst_hst_code))?.gst_hst_code;
    const pstCode = mine.find((l) => l.pst_qst_code)?.pst_qst_code;
    const form = {
      document_type: Number(inv.total) < 0 ? "credit_note" : "invoice",
      vendor_name: v.legal_name, vendor_gst_hst_number: orNull(v.gst_hst_number), vendor_qst_number: orNull(v.qst_number),
      vendor_invoice_number: inv.vendor_invoice_number, invoice_date: inv.invoice_date, due_date: inv.due_date, received_date: inv.received_date,
      bill_to_name: ORG_NAME, bill_to_tax_number: ORG_GST, currency: inv.currency,
      subtotal: Number(inv.subtotal), total: Number(inv.total),
      taxes: [
        ...(Number(inv.gst_hst_amount) && gstCode ? [{ label: TAX_LABEL[gstCode], rate: null, amount: Number(inv.gst_hst_amount) }] : []),
        ...(Number(inv.pst_qst_amount) && pstCode ? [{ label: TAX_LABEL[pstCode], rate: null, amount: Number(inv.pst_qst_amount) }] : []),
      ],
      lines: mine.map((l) => ({
        line_no: Number(l.line_no), description: l.description, quantity: Number(l.quantity), unit_price: Number(l.unit_price), amount: Number(l.amount),
        gl_account: l.gl_account, department_id: l.department_id, gst_hst_code: orNull(l.gst_hst_code), pst_qst_code: orNull(l.pst_qst_code),
        line_type: l.line_type, coding_status: "accepted",
      })),
      vendor_id: inv.vendor_id, ship_to_province: inv.ship_to_province, department_id: inv.department_id, requester_user_id: inv.requester_user_id,
      po_id: orNull(inv.po_id), contract_id: orNull(inv.contract_id),
      manual: ["vendor_id", "ship_to_province", "department_id", "requester_user_id", "po_id", "contract_id"],
    };

    await tx(async (c) => {
      const rawId = await nextId("RAW", c);
      await query(
        `INSERT INTO raw_items (raw_item_id, organization_id, kind, form_json, submitted_by, received_at, status, extracted_at)
         VALUES ($1,$2,'form',$3,$4,$5,'extracted',$5)`,
        [rawId, ORG, JSON.stringify(form), inv.requester_user_id, inv.received_date],
        c,
      );
      await audit(c, { at: inv.received_date, by: inv.requester_user_id, action: "raw_item.form", entityType: "raw_item", entityId: rawId, after: form });
      const raw = (await one<RawItem>("SELECT * FROM raw_items WHERE raw_item_id=$1", [rawId], c))!;
      const parsedId = await nextId("PRS", c);
      const data = { ...EMPTY, ...form } as InvoiceData;
      await query("INSERT INTO parsed_invoices (parsed_invoice_id, organization_id, raw_item_id, invoice_json) VALUES ($1,$2,$3,$4)", [parsedId, ORG, rawId, JSON.stringify(data)], c);
      await audit(c, { at: inv.received_date, by: null, action: "parsed_invoice.create", entityType: "parsed_invoice", entityId: parsedId });
      const d = await resolveAndCheck(c, parsedId, raw, data);
      // the organization approved these before Brim AP: the flags stay on record, closed, since nobody reviewed them here; an open
      // one would make settled history look unresolved and hold its payment.
      await query(
        "UPDATE invoice_flags SET created_at=$2, status='resolved', resolved_at=$2, resolution_note='Approved before Brim AP; never reviewed here.' WHERE parsed_invoice_id=$1",
        [parsedId, inv.received_date],
        c,
      );

      const dup = await one<{ related_invoice_id: string }>(
        "SELECT related_invoice_id FROM invoice_flags WHERE parsed_invoice_id=$1 AND category='duplicate' AND related_invoice_id IS NOT NULL LIMIT 1",
        [parsedId],
        c,
      );
      const creditFor = d.document_type === "credit_note" && d.credit_note_reference
        ? await one<{ invoice_id: string }>("SELECT invoice_id FROM invoices WHERE organization_id=$1 AND vendor_id=$2 AND vendor_invoice_number=$3", [ORG, d.vendor_id, d.credit_note_reference], c)
        : null;
      await query(
        `INSERT INTO invoices (invoice_id, organization_id, parsed_invoice_id, is_historical, type, status, vendor_id, vendor_invoice_number, number_normalized,
           invoice_date, received_date, due_date, currency, subtotal, gst_hst_amount, pst_qst_amount, total, fx_rate_to_cad, total_cad, department_id,
           requester_user_id, po_id, contract_id, bill_to_name, bill_to_tax_number, ship_to_province, lines, duplicate_of_invoice_id, credit_for_invoice_id, created_at)
         VALUES ($1,$2,$3,true,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
        [
          inv.invoice_id, ORG, parsedId, d.document_type, inv.status, d.vendor_id, d.vendor_invoice_number, invoiceNumberCore(d.vendor_invoice_number),
          d.invoice_date, inv.received_date, d.due_date, d.currency, d.subtotal, d.gst_hst_amount ?? 0, d.pst_qst_amount ?? 0, d.total, d.fx_rate_to_cad ?? 1,
          d.total_cad, d.department_id, d.requester_user_id, d.po_id, d.contract_id, d.bill_to_name, d.bill_to_tax_number, d.ship_to_province,
          JSON.stringify(d.lines), dup?.related_invoice_id ?? null, creditFor?.invoice_id ?? null, inv.received_date,
        ],
        c,
      );
      await query("UPDATE parsed_invoices SET status='approved', invoice_id=$2 WHERE parsed_invoice_id=$1", [parsedId, inv.invoice_id], c);

      for (const a of approvals.filter((x) => x.invoice_id === inv.invoice_id)) {
        await query(
          `INSERT INTO approvals (approval_id, invoice_id, step_no, assigned_user_id, original_user_id, status, acted_by, comment, acted_at)
           VALUES ($1,$2,$3,$4,$4,$5,$4,$6,$7)`,
          [a.approval_id, inv.invoice_id, Number(a.step_no), a.approver_user_id, a.action, orNull(a.comment), a.acted_at],
          c,
        );
        await audit(c, { at: a.acted_at, by: a.approver_user_id, action: `approval.${a.action}`, entityType: "approval", entityId: a.approval_id, invoiceId: inv.invoice_id, vendorId: inv.vendor_id, note: orNull(a.comment) });
      }
      for (const p of payments.filter((x) => x.invoice_id === inv.invoice_id)) {
        await query(
          `INSERT INTO payments (payment_id, organization_id, invoice_id, vendor_id, method, scheduled_date, paid_date, currency, amount, fx_rate_to_cad, amount_cad,
             discount_taken, status, prepared_by, released_by, bank_reference, card_reference)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [p.payment_id, ORG, inv.invoice_id, inv.vendor_id, p.method, orNull(p.scheduled_date), orNull(p.paid_date), p.currency, Number(p.amount),
            Number(p.fx_rate_to_cad), Number(p.amount_cad), Number(p.discount_taken || 0), p.status, orNull(p.prepared_by), orNull(p.released_by),
            p.method === "CARD" ? null : p.reference, p.method === "CARD" ? p.reference : null],
          c,
        );
        const at = orNull(p.scheduled_date) ?? orNull(p.paid_date) ?? inv.received_date;
        const ids = { at, entityType: "payment", entityId: p.payment_id, invoiceId: inv.invoice_id, paymentId: p.payment_id, vendorId: inv.vendor_id };
        if (p.prepared_by) await audit(c, { ...ids, by: p.prepared_by, action: "payment.prepare" });
        if (p.released_by) await audit(c, { ...ids, by: p.released_by, action: "payment.release" });
      }
    });
    if (++n % 100 === 0) console.log(`${n} history invoices`);
  }
  // what the bank and the card feed reported for those payments: each statement line and virtual card charge, linked to the payment it settled
  await tx(async (c) => {
    for (const r of csv("bank_statement")) await insertLine(c, ORG, bankLine(r));
    for (const r of csv("card_transactions")) {
      const l = cardLine(r);
      if (l) await insertLine(c, ORG, l);
    }
    await query(
      `UPDATE statement_lines s SET payment_id=p.payment_id FROM payments p
        WHERE s.organization_id=$1 AND p.organization_id=$1 AND p.amount_cad=s.amount
          AND ((s.kind='eft' AND p.method='EFT' AND right(p.bank_reference, 6)=s.reference) OR (s.kind='card' AND p.method='CARD' AND 'VC-' || p.invoice_id=s.reference))`,
      [ORG],
      c,
    );
  });
  console.log(`history done: ${n}`);
}

// New invoices arrive the way they do in the app: an AP clerk (the dataset's first active one) polls the inbox; the running
// server reads what came in.
async function inbox() {
  const base = process.env.BASE_URL ?? "http://localhost:3000";
  const clerk = csv("users").find((u) => u.role === "ap_clerk" && u.status === "active");
  if (!clerk) throw new Error("The dataset has no active AP clerk to poll the inbox.");
  const session = await fetch(`${base}/api/session`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: clerk.email, password: PASSWORD, portal: "organization" }),
  });
  if (!session.ok) throw new Error(`Sign-in failed: ${(await session.json()).error}`);
  const cookie = session.headers.get("set-cookie")!.split(";")[0];
  const res = await fetch(`${base}/api/organizations/${ORG}/raw-items/poll`, { method: "POST", headers: { cookie } });
  const out = await res.json();
  if (!res.ok) throw new Error(`Poll failed: ${out.error}`);
  console.log(out);
}

const step = process.argv[2];
const steps: Record<string, () => Promise<void>> = { setup, history, inbox };
if (!steps[step]) {
  console.error("Usage: npx tsx scripts/ingest.ts setup|history|inbox");
  process.exit(1);
}
try {
  await steps[step]();
} catch (e) {
  console.error((e as Error).message ?? e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
