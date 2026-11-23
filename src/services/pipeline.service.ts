import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { tx, query, one, nextId, Db } from "@/lib/db";
import { assertCan, assertMember } from "@/lib/authz";
import { writeAudit } from "@/lib/audit";
import type { InvoiceData, User } from "@/lib/types";
import type { RawItem, StoredFile } from "./rawIntake.service";
import { inspectFile } from "./fileInspection.service";
import { classifyEmail, extractDocument, toInvoiceData, EXTRACTION_MODEL } from "./extraction.service";
import { resolve } from "./resolution.service";
import { buildContext, runChecks } from "./validation.service";
import type { Flag } from "./checks/types";

type Found = { file_name: string | null; sha256: string | null; data: InvoiceData; language: string | null; model: string | null; extra: Flag[] };

// an invoice with nothing read yet; a form fills in what it has
export const EMPTY: InvoiceData = {
  document_type: "invoice", vendor_name: null, vendor_address: null, vendor_gst_hst_number: null, vendor_qst_number: null,
  vendor_invoice_number: null, invoice_date: null, due_date: null, payment_terms: null, po_reference: null, credit_note_reference: null,
  bill_to_name: null, bill_to_address: null, bill_to_tax_number: null, currency: "CAD", subtotal: null, taxes: [], total: null,
  remit_institution: null, remit_transit: null, remit_account: null, remit_note: null, lines: [],
};

// Step 2, run by the system as soon as a raw item is stored: a form is already an invoice; an upload or an email's attachments
// are read by Claude. Steps 3–5 follow for each invoice found. A raw item that failed before is read again.
export async function readRawItem(organizationId: string, rawItemId: string): Promise<{ parsed: string[]; noInvoice?: string }> {
  const raw = await one<RawItem>("SELECT * FROM raw_items WHERE raw_item_id=$1 AND organization_id=$2", [rawItemId, organizationId]);
  if (!raw) throw new NotFoundError("No such raw item");
  if (raw.status !== "new" && raw.status !== "failed") throw new ConflictError("Already read");
  const actor = null;

  const found: Found[] = [];
  let noInvoice: string | null = null;

  if (raw.kind === "form") {
    found.push({ file_name: null, sha256: null, data: { ...EMPTY, ...(raw.form_json as Partial<InvoiceData>) }, language: null, model: null, extra: [] });
  } else if (raw.files.length === 0) {
    const c = await classifyEmail(raw.subject ?? "", raw.body ?? "");
    noInvoice = `${c.category.replace(/_/g, " ")}: ${c.reason}`;
  } else {
    const reasons: string[] = [];
    for (const f of raw.files) {
      const r = await readFile(raw, f);
      if ("notInvoice" in r) reasons.push(`${f.file_name}: ${r.notInvoice}`);
      else found.push(r);
    }
    if (!found.length) noInvoice = reasons.join("; ") || "No invoice in the attachments";
  }

  return tx(async (c) => {
    await checkInTurn(c, raw.organization_id);
    if (noInvoice) {
      await query("UPDATE raw_items SET status='no_invoice', no_invoice_reason=$2, failure_reason=NULL, extracted_at=now() WHERE raw_item_id=$1", [raw.raw_item_id, noInvoice], c);
      await writeAudit(c, { organizationId: raw.organization_id, actor, action: "raw_item.no_invoice", entityType: "raw_item", entityId: raw.raw_item_id, note: noInvoice });
      return { parsed: [], noInvoice };
    }
    const ids: string[] = [];
    for (const f of found) {
      const id = await nextId("PRS", c);
      await query(
        `INSERT INTO parsed_invoices (parsed_invoice_id, organization_id, raw_item_id, file_name, sha256, extraction_model, extraction_language, invoice_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, raw.organization_id, raw.raw_item_id, f.file_name, f.sha256, f.model, f.language, JSON.stringify(f.data)],
        c,
      );
      await resolveAndCheck(c, id, raw, f.data, f.extra);
      await writeAudit(c, { organizationId: raw.organization_id, actor, action: "parsed_invoice.create", entityType: "parsed_invoice", entityId: id, note: f.file_name });
      ids.push(id);
    }
    await query("UPDATE raw_items SET status='extracted', failure_reason=NULL, extracted_at=now() WHERE raw_item_id=$1", [raw.raw_item_id], c);
    return { parsed: ids };
  });
}

// Readings come in several at a time, but each is stored and checked in turn, per organization (a lock held until the
// transaction ends), so the duplicate and split checks always see every invoice stored before it.
const checkInTurn = (c: Db, organizationId: string) => query("SELECT pg_advisory_xact_lock(hashtext($1))", [`checks:${organizationId}`], c);

// One stored file read: the invoice in it, or why it is not one. A file that cannot be opened gives an empty invoice, flagged.
async function readFile(raw: RawItem, f: StoredFile): Promise<Found | { notInvoice: string }> {
  const ins = inspectFile(f);
  if (!ins.readable) {
    return { file_name: f.file_name, sha256: f.sha256, data: EMPTY, language: null, model: null,
      extra: [{ check_code: "file_unreadable", category: "extraction", severity: "blocking", message: `${ins.reason}. Open the raw item and enter the invoice by hand.` }] };
  }
  const email = raw.kind === "email" ? { from: [raw.from_name, raw.from_address && `<${raw.from_address}>`].filter(Boolean).join(" "), subject: raw.subject, body: raw.body } : undefined;
  const e = await extractDocument(ins.kind, ins.bytes, email);
  if (!e.is_invoice) return { notInvoice: e.not_invoice_reason || "not an invoice" };
  return { file_name: f.file_name, sha256: f.sha256, data: toInvoiceData(e), language: e.language, model: EXTRACTION_MODEL, extra: [] };
}

// Reads a parsed invoice's file again. The old parsed invoice, its edits and its flags are deleted, and the new reading takes its
// place under a new id, checked. A parsed invoice already approved into the invoices is not read again.
export async function readParsedAgain(actor: User | null, organizationId: string, parsedInvoiceId: string) {
  assertCan(actor, "raw.extract");
  const p = await getParsed(actor, organizationId, parsedInvoiceId);
  if (!p) throw new NotFoundError("No such parsed invoice");
  if (p.status === "approved") throw new ConflictError("Already approved into the invoices.");
  const raw = (await one<RawItem>("SELECT * FROM raw_items WHERE raw_item_id=$1", [p.raw_item_id]))!;
  let found: Found;
  if (!p.file_name) {
    found = { file_name: null, sha256: null, data: { ...EMPTY, ...(raw.form_json as Partial<InvoiceData>) }, language: null, model: null, extra: [] };
  } else {
    const f = raw.files.find((x) => x.file_name === p.file_name);
    if (!f) throw new NotFoundError(`${p.file_name} is no longer stored.`);
    const r = await readFile(raw, f);
    if ("notInvoice" in r) throw new ValidationError(`Read again, ${p.file_name} is not an invoice: ${r.notInvoice}`);
    found = r;
  }
  return tx(async (c) => {
    await checkInTurn(c, organizationId);
    await query("DELETE FROM invoice_flags WHERE parsed_invoice_id=$1", [parsedInvoiceId], c);
    const gone = await query("DELETE FROM parsed_invoices WHERE parsed_invoice_id=$1 AND status<>'approved' RETURNING 1", [parsedInvoiceId], c);
    if (!gone.length) throw new ConflictError("Already approved into the invoices.");
    const id = await nextId("PRS", c);
    await query(
      `INSERT INTO parsed_invoices (parsed_invoice_id, organization_id, raw_item_id, file_name, sha256, extraction_model, extraction_language, invoice_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, organizationId, raw.raw_item_id, found.file_name, found.sha256, found.model, found.language, JSON.stringify(found.data)],
      c,
    );
    await resolveAndCheck(c, id, raw, found.data, found.extra);
    await writeAudit(c, { organizationId, actor, action: "parsed_invoice.read_again", entityType: "parsed_invoice", entityId: id, note: `replaces ${parsedInvoiceId}` });
    return id;
  });
}

// Steps 3–5 on one parsed invoice. When it turns out to be part of a split, the other pending invoices of the split are checked again,
// so each of them is flagged too, not only the last one read.
export async function resolveAndCheck(db: Db, parsedInvoiceId: string, raw: RawItem, data: InvoiceData, extra: Flag[] = [], recheckSplit = true) {
  const resolved = await resolveAndSave(db, parsedInvoiceId, raw, data);
  await checkParsed(db, parsedInvoiceId, raw, resolved, extra, recheckSplit);
  return resolved;
}

// Step 3 alone: the invoice's links to the vendor master, purchase orders and contracts, saved. The checks are not run.
export async function resolveAndSave(db: Db, parsedInvoiceId: string, raw: RawItem, data: InvoiceData) {
  const resolved = await resolve(db, raw.organization_id, data, raw);
  await query("UPDATE parsed_invoices SET invoice_json=$2 WHERE parsed_invoice_id=$1", [parsedInvoiceId, JSON.stringify(resolved)], db);
  return resolved;
}

// Steps 4–5 on the invoice as saved.
export async function checkParsed(db: Db, parsedInvoiceId: string, raw: RawItem, resolved: InvoiceData, extra: Flag[] = [], recheckSplit = true) {
  const p = await one<{ sha256: string | null }>("SELECT sha256 FROM parsed_invoices WHERE parsed_invoice_id=$1", [parsedInvoiceId], db);
  const ctx = await buildContext(db, raw.organization_id, parsedInvoiceId, p?.sha256 ?? null, resolved, raw);
  const keepExtraction = extra.length
    ? extra
    : (await query<Flag & { evidence_json: unknown }>("SELECT check_code, category, severity, message FROM invoice_flags WHERE parsed_invoice_id=$1 AND category='extraction'", [parsedInvoiceId], db));
  const flags = await runChecks(ctx, keepExtraction);
  const partners = recheckSplit ? ((flags.find((f) => f.check_code === "split_invoice")?.evidence?.related ?? []) as string[]).filter((r) => r.startsWith("PRS-")) : [];
  for (const id of partners) {
    const p = await one<{ invoice_json: InvoiceData; raw_item_id: string }>("SELECT invoice_json, raw_item_id FROM parsed_invoices WHERE parsed_invoice_id=$1 AND status='pending'", [id], db);
    const pRaw = p && (await one<RawItem>("SELECT * FROM raw_items WHERE raw_item_id=$1", [p.raw_item_id], db));
    if (p && pRaw) await checkParsed(db, id, pRaw, p.invoice_json, [], false);
  }
}

// A parsed invoice of the organization, or null when it has none with this id.
export async function getParsed(actor: User | null, organizationId: string, id: string, db?: Db) {
  assertMember(actor, organizationId, { brim: true });
  return one<ParsedInvoice>("SELECT * FROM parsed_invoices WHERE parsed_invoice_id=$1 AND organization_id=$2", [id, organizationId], db);
}

export type ParsedInvoice = {
  parsed_invoice_id: string;
  organization_id: string;
  raw_item_id: string;
  file_name: string | null;
  sha256: string | null;
  extraction_model: string | null;
  extraction_language: string | null;
  invoice_json: InvoiceData;
  status: "pending" | "approved" | "rejected";
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  invoice_id: string | null;
};
