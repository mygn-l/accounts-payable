import { Router } from "express";
import multer from "multer";
import { NotFoundError, ValidationError } from "@/lib/errors";
import {
  getInvoiceRecord, getParsedInvoiceRecord, getRawItemRecord, listInvoices, listParsedInvoices, listRawItems, listWaitingApprovals,
} from "@/services/read.service";
import { invoiceTrail, parsedInvoiceTrail } from "@/services/audit.service";
import { readStoredFile } from "@/services/rawIntake.service";
import { deleteRawItem } from "@/services/itemDelete.service";
import { attentionCounts, handleRawItem } from "@/services/rawItemHandling.service";
import { pollAndRead, submitInvoiceForm, uploadInvoice } from "@/services/intake.service";
import { approve, editParsedInvoice, reject, resolveFlag, runChecksAgain, saveEdits, type ReviewEdit } from "@/services/parsedInvoiceReview.service";
import { readParsedAgain } from "@/services/pipeline.service";
import { decide } from "@/services/approval.service";
import { linkPurchaseOrder, purchaseOrderChoices } from "@/services/purchaseOrderLink.service";
import { pagingOf, param, route } from "../http";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// /api/organizations/:orgId: raw items, parsed invoices, invoices and their approvals.
export const invoices = Router({ mergeParams: true });

// --- raw items ---
// attention=reading | needs | waiting | handled | read: one state each, none overlapping; q searches id, sender, subject and file names;
// from/to (YYYY-MM-DD) bound the day received.
invoices.get("/raw-items", route(async ({ user, params, query }) => (
  listRawItems(user, params.orgId, {
    kind: param(query, "kind"), status: param(query, "status"), attention: param(query, "attention"),
    q: param(query, "q"), from: param(query, "from"), to: param(query, "to"), ...pagingOf(query),
  })
)));
// The clerk's raw-item workload: { reading, needs, waiting, todo, open }.
invoices.get("/raw-items/attention", route(async ({ user, params }) => attentionCounts(user, params.orgId), { gate: "parsed.review" }));
// Multipart body with the file in field "file". It is read in the background; its raw item shows the result.
invoices.post("/raw-items/uploads", upload.single("file"), route(async ({ req, user }) => {
  if (!req.file || req.file.size === 0) throw new ValidationError("Send the file in a multipart field named file");
  return { id: await uploadInvoice(user, req.file.originalname, req.file.buffer) };
}, { gate: "raw.submit" }));
// The invoice as typed into the form: checked, then a parsed invoice for review at once. Answers the raw item and parsed invoice ids.
// JSON, or multipart with the invoice as JSON in field "invoice" and the scan of the paper invoice in field "file".
invoices.post("/raw-items/forms", upload.single("file"), route(async ({ req, user, body }) => {
  let form = body;
  if (req.file || typeof body.invoice === "string") {
    try {
      form = JSON.parse(String(body.invoice));
    } catch {
      throw new ValidationError("Send the invoice as JSON in the field named invoice");
    }
  }
  const scan = req.file ? { fileName: req.file.originalname, bytes: req.file.buffer } : undefined;
  return submitInvoiceForm(user, form, { scan });
}, { gate: "raw.submit" }));
// Reads the AP inbox, stores each new email as a raw item, and starts reading everything not yet read.
invoices.post("/raw-items/poll", route(async ({ user }) => pollAndRead(user), { gate: "raw.poll" }));
invoices.get("/raw-items/:id", route(async ({ user, params }) => getRawItemRecord(user, params.orgId, params.id)));
// Records how an item with no invoice, or one not readable, was dealt with: { outcome, note, forwardedTo? }.
invoices.post("/raw-items/:id/handle", route(async ({ user, params, body }) => {
  await handleRawItem(user, params.orgId, params.id, { outcome: body.outcome, note: body.note, forwardedTo: body.forwardedTo });
  return getRawItemRecord(user, params.orgId, params.id);
}, { gate: "parsed.review" }));
// Deletes a submission: the raw item, its files and the parsed invoice read from it. Only whoever submitted it, and
// not once it became an invoice.
invoices.delete("/raw-items/:id", route(async ({ user, params }) => deleteRawItem(user, params.orgId, params.id)));
// The stored attachment, as it arrived.
invoices.get("/raw-items/:id/files/:name", route(async ({ res, user, params }) => {
  const raw = await getRawItemRecord(user, params.orgId, params.id);
  const f = raw.files.find((x) => x.file_name === params.name);
  if (!f) throw new NotFoundError("No such file");
  res.set({ "content-type": f.mime_type, "content-disposition": `inline; filename="${f.file_name}"` }).send(readStoredFile(f));
}));

// --- parsed invoices ---
invoices.get("/parsed-invoices", route(async ({ user, params, query }) => listParsedInvoices(user, params.orgId, { status: param(query, "status"), q: param(query, "q"), flags: param(query, "flags"), ...pagingOf(query) })));
invoices.get("/parsed-invoices/:id", route(async ({ user, params }) => getParsedInvoiceRecord(user, params.orgId, params.id)));
// Clerk edits: header fields and line coding. Resolution runs again; the checks run again only when asked (below).
invoices.patch("/parsed-invoices/:id", route(async ({ user, params, body }) => {
  const edit = body as Partial<ReviewEdit>;
  await saveEdits(user, params.orgId, params.id, { header: edit.header ?? {}, lines: edit.lines ?? [] });
  return getParsedInvoiceRecord(user, params.orgId, params.id);
}, { gate: "parsed.review" }));
// The clerk's edit, made as on the invoice form, in place of what was read.
invoices.put("/parsed-invoices/:id/entry", route(async ({ user, params, body }) => {
  await editParsedInvoice(user, params.orgId, params.id, body as Record<string, unknown>);
  return getParsedInvoiceRecord(user, params.orgId, params.id);
}, { gate: "parsed.review" }));
// Reads the parsed invoice's file again; the old parsed invoice is deleted and the new one has a new id.
invoices.post("/parsed-invoices/:id/read-again", route(async ({ user, params }) => ({ id: await readParsedAgain(user, params.orgId, params.id) }), { gate: "raw.extract" }));
// Runs the checks and duplicate detection again on the invoice under review.
invoices.post("/parsed-invoices/:id/checks", route(async ({ user, params }) => {
  await runChecksAgain(user, params.orgId, params.id);
  return getParsedInvoiceRecord(user, params.orgId, params.id);
}, { gate: "parsed.review" }));
// The vendor's purchase orders for the invoice, closest match first; linking one works at any stage.
invoices.get("/parsed-invoices/:id/purchase-order-choices", route(async ({ user, params }) => purchaseOrderChoices(user, params.orgId, params.id), { gate: "po.manage" }));
invoices.put("/parsed-invoices/:id/purchase-order", route(async ({ user, params, body }) => {
  await linkPurchaseOrder(user, params.orgId, params.id, ((body as { po_id?: string | null }).po_id || null));
  return getParsedInvoiceRecord(user, params.orgId, params.id);
}, { gate: "po.manage" }));
// Adds the parsed invoice to the invoices and starts its approval chain.
invoices.post("/parsed-invoices/:id/approve", route(async ({ user, params }) => {
  return { id: await approve(user, params.orgId, params.id) };
}, { gate: "parsed.review" }));
invoices.post("/parsed-invoices/:id/reject", route(async ({ user, params, body }) => {
  await reject(user, params.orgId, params.id, String(body.reason ?? ""));
}, { gate: "parsed.review" }));
// Resolve or override a flag, with a note.
invoices.patch("/flags/:id", route(async ({ user, params, body }) => {
  if (body.status !== "resolved" && body.status !== "overridden") throw new ValidationError("status is resolved or overridden");
  await resolveFlag(user, params.orgId, params.id, body.status, String(body.note ?? ""));
}));

// --- invoices ---
invoices.get("/invoices", route(async ({ user, params, query }) => (
  listInvoices(user, params.orgId, { q: param(query, "q"), status: param(query, "status"), vendor_id: param(query, "vendor_id"), type: param(query, "type"), po_id: param(query, "po_id"), contract_id: param(query, "contract_id"), ...pagingOf(query) })
)));
// The invoice with its approval chain (each step saying whether you may act on it) and payments.
invoices.get("/invoices/:id", route(async ({ user, params }) => getInvoiceRecord(user, params.orgId, params.id)));
// What happened to the invoice, its parsed invoice and raw item.
invoices.get("/invoices/:id/audit-events", route(async ({ user, params }) => invoiceTrail(user, params.orgId, params.id)));
invoices.get("/parsed-invoices/:id/audit-events", route(async ({ user, params }) => parsedInvoiceTrail(user, params.orgId, params.id)));
// A past invoice with its recorded approvals and payments, for an organization being set up.

// --- approvals ---
// ?waiting_on=me: the steps waiting on the signed-in user, or on someone on leave they cover.
invoices.get("/approvals", route(async ({ user, params, query }) => {
  if (query.get("waiting_on") !== "me") throw new ValidationError("List approvals with ?waiting_on=me");
  return listWaitingApprovals(user, params.orgId);
}));
for (const [path, decision] of [["approve", "approved"], ["reject", "rejected"]] as const) {
  invoices.post(`/approvals/:id/${path}`, route(async ({ user, params, body }) => {
    await decide(user, params.orgId, params.id, decision, typeof body.comment === "string" ? body.comment : null);
  }, { gate: "approval.act" }));
}
