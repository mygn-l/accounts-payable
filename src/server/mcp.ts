import { Router } from "express";
import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { bearer, userFromToken } from "@/lib/auth";
import { auditChannel } from "@/lib/audit";
import { can, type Action } from "@/lib/authz";
import { AppError, fromDatabase } from "@/lib/errors";
import type { User } from "@/lib/types";
import {
  getInvoiceRecord, getParsedInvoiceRecord, getPaymentRecord, getRawItemRecord, listInvoices, listParsedInvoices, listPayments, listRawItems,
  listWaitingApprovals,
} from "@/services/read.service";
import { invoiceTrail } from "@/services/audit.service";
import { getOrganization } from "@/services/organization.service";
import { deleteRecord, getRecord, listRecords } from "@/services/records.service";
import { getVendor, listBankChanges, listVendorChoices, listVendors, requestBankChange } from "@/services/vendor.service";
import { pollAndRead, submitInvoiceForm } from "@/services/intake.service";
import { approve, reject, resolveFlag, runChecksAgain, saveEdits } from "@/services/parsedInvoiceReview.service";
import { readParsedAgain } from "@/services/pipeline.service";
import { linkPurchaseOrder, purchaseOrderChoices } from "@/services/purchaseOrderLink.service";
import { handleRawItem } from "@/services/rawItemHandling.service";
import { deleteRawItem } from "@/services/itemDelete.service";
import { HANDLING_OUTCOMES } from "@/lib/handling";
import { decide } from "@/services/approval.service";
import { cancelPayment, failPayment, preparePayment, releasePayment } from "@/services/payment.service";

// The MCP server at /mcp: an employee's agent signs in with a personal access token and gets one tool per thing
// the employee's role may do. Each tool calls the same service as the REST route, so permissions and the audit log are the same;
// actions taken this way are marked "agent" in the audit log.

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (data: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }, null, 2) }] });

// A refusal from the services (not allowed, not found, not in that state) goes back to the agent as a tool error it can read.
async function attempt(f: () => Promise<unknown>): Promise<Result> {
  try {
    return ok(await f());
  } catch (err) {
    const e = fromDatabase(err) ?? err;
    if (e instanceof AppError) return { isError: true, content: [{ type: "text", text: e.message }] };
    console.error(err);
    return { isError: true, content: [{ type: "text", text: "The server could not do this." }] };
  }
}

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const page = z.number().int().min(1).optional().describe("Page number, 20 rows per page");

export function serverFor(user: User) {
  const org = user.organization_id!;
  const server = new McpServer({ name: "brim-ap", version: "1.0.0" });
  // a tool is offered only when the user's role allows it; the services check again on every call
  const tool = <S extends z.ZodRawShape>(name: string, needs: Action | null, description: string, input: S, write: boolean, run: (a: z.infer<z.ZodObject<S>>) => Promise<unknown>) => {
    if (needs && !can(user, needs)) return;
    server.registerTool(name, { description, inputSchema: input, annotations: write ? WRITE : READ }, ((a: z.infer<z.ZodObject<S>>) => attempt(() => run(a))) as never);
  };

  // --- reading ---
  tool("whoami", null, "The signed-in employee: name, role, department and organization.", {}, false, async () => ({
    user_id: user.user_id, full_name: user.full_name, role: user.role, title: user.title, department_id: user.department_id,
    organization: (await getOrganization(user, org)).legal_name,
  }));
  tool("list_invoices", null, "Invoices the employee may see, those waiting on their approval first. Filter by status (pending_approval, approved, scheduled, paid, rejected), vendor, purchase order or contract; q searches the invoice id, the vendor's number and the vendor's name.",
    { status: z.string().optional(), vendor_id: z.string().optional(), po_id: z.string().optional(), contract_id: z.string().optional(), q: z.string().optional(), page }, false,
    (a) => listInvoices(user, org, { status: a.status, vendor_id: a.vendor_id, po_id: a.po_id, contract_id: a.contract_id, q: a.q, page: a.page }));
  tool("get_invoice", null, "One invoice with its lines, approval chain (each step says whether the employee can act on it) and payments.",
    { invoice_id: z.string().describe("e.g. AP-00427") }, false, (a) => getInvoiceRecord(user, org, a.invoice_id));
  tool("get_invoice_audit_trail", null, "Everything that happened to an invoice, its parsed invoice and raw item, oldest first.",
    { invoice_id: z.string() }, false, (a) => invoiceTrail(user, org, a.invoice_id));
  tool("list_approvals_waiting_on_me", "approval.act", "Approval steps waiting on the employee, or on a colleague on leave they cover.", {}, false,
    () => listWaitingApprovals(user, org));
  tool("list_raw_items", null, "Raw items as they arrived (emails, uploads, forms): the AP clerk sees all, anyone else their own submissions. Filter by kind (email, pdf, form) or by state: reading, needs (no invoice in it or not readable, not dealt with), waiting (asked the sender again), handled, read (became a parsed invoice). q searches the id, sender, subject and file names; from/to bound the day received.",
    {
      kind: z.enum(["email", "pdf", "form"]).optional(),
      state: z.enum(["reading", "needs", "waiting", "handled", "read"]).optional(),
      q: z.string().optional(), from: z.string().optional().describe("YYYY-MM-DD"), to: z.string().optional().describe("YYYY-MM-DD"), page,
    }, false,
    (a) => listRawItems(user, org, { kind: a.kind, attention: a.state, q: a.q, from: a.from, to: a.to, page: a.page }));
  tool("get_raw_item", null, "One raw item: the email, form or upload as received (file names, not file contents).",
    { raw_item_id: z.string() }, false, async (a) => {
      const r = await getRawItemRecord(user, org, a.raw_item_id);
      return { ...r, files: r.files.map((f) => ({ file_name: f.file_name, mime_type: f.mime_type })) };
    });
  tool("list_parsed_invoices", null, "Parsed invoices waiting for the AP clerk's review (status pending), each with its vendor, number, date, total and count of open blocking and warning flags. get_parsed_invoice has every field and the flags themselves.",
    {
      status: z.string().optional().describe("pending (the default list), approved or rejected"),
      flags: z.enum(["blocking", "warning", "clear"]).optional().describe("only those with open blocking flags, with warnings, or with none"),
      q: z.string().optional().describe("searches the parsed id, the vendor and the invoice number"), page,
    }, false, async (a) =>
      (await listParsedInvoices(user, org, { status: a.status, flags: a.flags, q: a.q, page: a.page })).map((p) => ({
        parsed_invoice_id: p.parsed_invoice_id, status: p.status, vendor: p.vendor_name ?? p.invoice_json.vendor_name, vendor_invoice_number: p.invoice_json.vendor_invoice_number,
        invoice_date: p.invoice_json.invoice_date, total: p.invoice_json.total, currency: p.invoice_json.currency, blocking_flags: p.blocking, warning_flags: p.warnings,
        invoice_id: p.invoice_id, total_count: p.total_count,
      })));
  tool("get_parsed_invoice", null, "One parsed invoice with every field read from the document and its flags.",
    { parsed_invoice_id: z.string().describe("e.g. PRS-0428") }, false, (a) => getParsedInvoiceRecord(user, org, a.parsed_invoice_id));
  tool("list_payments", "payment.view", "Payments; for scheduled and released ones the earliest due first, and whether the employee may release each.",
    { status: z.string().optional().describe("scheduled, released, outstanding, settled, failed or cancelled"), q: z.string().optional().describe("searches the payment, the invoice and the vendor"), page }, false,
    (a) => listPayments(user, org, { status: a.status, q: a.q, page: a.page }));
  tool("get_payment", "payment.view", "One payment: method, amount, dates, who prepared and released it, the bank account paid.",
    { payment_id: z.string() }, false, (a) => getPaymentRecord(user, org, a.payment_id));
  tool("list_vendor_names", null, "The organization's vendors by name and id, to pick the vendor of an invoice.", {}, false, () => listVendorChoices(user, org));
  tool("list_vendors", "vendor.view", "Vendors with their status, number of invoices, unverified bank changes and lookalike names. Filter by status (active, pending_review, on_hold).",
    { status: z.string().optional(), q: z.string().optional().describe("searches the vendor's name and id"), page }, false, (a) => listVendors(user, org, { status: a.status, q: a.q, page: a.page }));
  tool("get_vendor", "vendor.view", "One vendor's details and bank details changes.", { vendor_id: z.string() }, false, async (a) => ({
    ...(await getVendor(user, org, a.vendor_id)), bank_changes: await listBankChanges(user, org, { vendorId: a.vendor_id }),
  }));
  tool("list_purchase_orders", null, "Purchase orders with their vendor, total, billed so far and status. Filter by status (open, partially_invoiced, closed) or vendor; q searches the id, the vendor and the description.",
    { status: z.string().optional(), vendor_id: z.string().optional(), q: z.string().optional(), page }, false,
    (a) => listRecords(user, org, "purchase_orders", Object.fromEntries(Object.entries({ status: a.status, vendor_id: a.vendor_id, q: a.q, page: a.page && String(a.page), size: "20" }).filter(([, v]) => v)) as Record<string, string>));
  tool("get_purchase_order", null, "One purchase order: vendor, department, requester, total, billed and remaining, and the invoices against it.",
    { po_id: z.string().describe("e.g. PO-2026-0046") }, false, async (a) => ({
      ...(await getRecord(user, org, "purchase_orders", a.po_id)), invoices: await listInvoices(user, org, { po_id: a.po_id, size: 50 }),
    }));
  tool("list_contracts", null, "Vendor contracts with their terms (monthly fee, hourly rate cap, fuel surcharge cap, monthly limit) and dates. Filter by status (active, expired) or vendor.",
    { status: z.string().optional(), vendor_id: z.string().optional(), page }, false,
    (a) => listRecords(user, org, "contracts", Object.fromEntries(Object.entries({ status: a.status, vendor_id: a.vendor_id, page: a.page && String(a.page), size: "20" }).filter(([, v]) => v)) as Record<string, string>));
  tool("get_contract", null, "One contract: its terms and dates, and the invoices billed under it.",
    { contract_id: z.string().describe("e.g. C025") }, false, async (a) => ({
      ...(await getRecord(user, org, "contracts", a.contract_id)), invoices: await listInvoices(user, org, { contract_id: a.contract_id, size: 50 }),
    }));
  tool("list_departments", null, "The organization's departments, for coding an invoice.", {}, false, () => listRecords(user, org, "departments"));
  tool("list_gl_accounts", null, "Expense GL accounts, for coding invoice lines.", {}, false, () => listRecords(user, org, "gl_accounts", { account_type: "expense" }));

  // --- acting ---
  tool("submit_invoice", "raw.submit", "Submits an invoice the employee received, as a form. It becomes a parsed invoice at once, checked, for accounts payable to review. Totals are added up from the lines and taxes.", {
    vendor_id: z.string().describe("from list_vendor_names"),
    vendor_invoice_number: z.string(),
    invoice_date: z.string().describe("YYYY-MM-DD"),
    due_date: z.string().optional().describe("YYYY-MM-DD"),
    currency: z.enum(["CAD", "USD"]).default("CAD"),
    po_reference: z.string().optional().describe("one of the vendor's purchase order ids"),
    ship_to_province: z.enum(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]).describe("province the goods or services were delivered to; the tax depends on it"),
    bill_to_address: z.string().optional().describe("delivery address, if known"),
    lines: z.array(z.object({ description: z.string(), quantity: z.number().positive(), unit_price: z.number(), line_type: z.enum(["goods", "services"]).default("services") })).min(1),
    taxes: z.array(z.object({ label: z.string().describe("GST, HST, QST or PST"), amount: z.number() })).default([]),
  }, true, async (a) => {
    const lines = a.lines.map((l, i) => ({ line_no: i + 1, description: l.description, quantity: l.quantity, unit_price: l.unit_price, line_type: l.line_type, amount: Math.round(l.quantity * l.unit_price * 100) / 100 }));
    const subtotal = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
    const tax = a.taxes.reduce((s, t) => s + t.amount, 0);
    return submitInvoiceForm(user, {
      document_type: "invoice", vendor_id: a.vendor_id, vendor_invoice_number: a.vendor_invoice_number, invoice_date: a.invoice_date, due_date: a.due_date ?? null,
      currency: a.currency, po_reference: a.po_reference ?? null, ship_to_province: a.ship_to_province, bill_to_address: a.bill_to_address ?? null, bill_to_name: (await getOrganization(user, org)).legal_name,
      subtotal, taxes: a.taxes.map((t) => ({ label: t.label, rate: null, amount: t.amount })), total: Math.round((subtotal + tax) * 100) / 100, lines, manual: ["vendor_id", "ship_to_province"],
    });
  });
  tool("poll_inbox", "raw.poll", "Reads the AP inbox and stores each new email as a raw item; new and earlier unread items are then read in the background into parsed invoices.", {}, true, () => pollAndRead(user));
  tool("edit_parsed_invoice", "parsed.review", "The clerk's corrections on a pending parsed invoice: header fields and line coding. The checks do not run again until run_checks_again.", {
    parsed_invoice_id: z.string(),
    header: z.object({
      vendor_id: z.string().nullable(), vendor_invoice_number: z.string().nullable(), invoice_date: z.string().nullable(), due_date: z.string().nullable(),
      department_id: z.string().nullable(), requester_user_id: z.string().nullable(), po_id: z.string().nullable(), ship_to_province: z.string().nullable(),
    }).partial().default({}),
    lines: z.array(z.object({ line_no: z.number().int(), gl_account: z.string().nullable(), department_id: z.string().nullable(), line_type: z.enum(["goods", "services"]) })).default([]),
  }, true, async (a) => {
    await saveEdits(user, org, a.parsed_invoice_id, { header: a.header, lines: a.lines });
    return getParsedInvoiceRecord(user, org, a.parsed_invoice_id);
  });
  tool("read_again", "raw.extract", "Reads a parsed invoice's file again. The parsed invoice, with its edits and flags, is deleted and the new reading takes its place under a new id. Not for one already approved into the invoices.",
    { parsed_invoice_id: z.string() }, true, async (a) => ({ parsed_invoice_id: await readParsedAgain(user, org, a.parsed_invoice_id) }));
  tool("purchase_order_choices", "po.manage", "The purchase orders an invoice could be linked to, closest match first: the vendor's own, then those whose remaining balance covers the invoice.",
    { parsed_invoice_id: z.string().describe("the invoice's parsed invoice id (get_invoice gives it)") }, false, (a) => purchaseOrderChoices(user, org, a.parsed_invoice_id));
  tool("link_purchase_order", "po.manage", "Links an invoice to a purchase order, or unlinks it with null, at any stage. The checks do not run again by themselves.",
    { parsed_invoice_id: z.string(), po_id: z.string().nullable() }, true, async (a) => {
      await linkPurchaseOrder(user, org, a.parsed_invoice_id, a.po_id);
      return getParsedInvoiceRecord(user, org, a.parsed_invoice_id);
    });
  tool("handle_raw_item", "parsed.review", `Deals with a raw item that holds no invoice or could not be read, with a note: ${Object.entries(HANDLING_OUTCOMES).map(([k, v]) => `${k} (${v})`).join(", ")}. Forwarding names the colleague.`,
    {
      raw_item_id: z.string(),
      outcome: z.enum(Object.keys(HANDLING_OUTCOMES) as [string, ...string[]]),
      note: z.string().min(1),
      forwarded_to: z.string().optional().describe("user id, only to forward"),
    }, true, async (a) => {
      await handleRawItem(user, org, a.raw_item_id, { outcome: a.outcome, note: a.note, forwardedTo: a.forwarded_to });
      return getRawItemRecord(user, org, a.raw_item_id);
    });
  tool("delete_submission", "raw.submit", "Deletes the employee's own submission (an upload or a form): the raw item, its files and the parsed invoice read from it. Refused once it became an invoice.",
    { raw_item_id: z.string() }, true, (a) => deleteRawItem(user, org, a.raw_item_id));
  tool("run_checks_again", "parsed.review", "Runs the checks and duplicate detection again on a pending parsed invoice, as it is now, and gives back its flags.",
    { parsed_invoice_id: z.string() }, true, async (a) => {
      await runChecksAgain(user, org, a.parsed_invoice_id);
      return getParsedInvoiceRecord(user, org, a.parsed_invoice_id);
    });
  tool("resolve_flag", null, "Closes a flag with a note of what was checked: resolved, or overridden. The AP clerk closes flags on a parsed invoice under review; a fraud flag is closed only by a finance manager or the controller, and also once the invoice is created.",
    { flag_id: z.string(), status: z.enum(["resolved", "overridden"]), note: z.string().min(1) }, true,
    (a) => resolveFlag(user, org, a.flag_id, a.status, a.note));
  tool("approve_parsed_invoice", "parsed.review", "Adds a reviewed parsed invoice to the invoices and starts its approval chain. Refused while blocking flags are open.",
    { parsed_invoice_id: z.string() }, true, async (a) => ({ invoice_id: await approve(user, org, a.parsed_invoice_id) }));
  tool("reject_parsed_invoice", "parsed.review", "Rejects a parsed invoice, with the reason.", { parsed_invoice_id: z.string(), reason: z.string().min(1) }, true,
    (a) => reject(user, org, a.parsed_invoice_id, a.reason));
  tool("decide_approval", "approval.act", 'Approves or rejects an approval step waiting on the employee: decision "approve" or "reject". A rejection needs a comment.',
    { approval_id: z.string().describe("from list_approvals_waiting_on_me or get_invoice"), decision: z.enum(["approve", "reject"]).describe('"approve" or "reject"'), comment: z.string().optional().describe("required to reject") }, true,
    (a) => decide(user, org, a.approval_id, a.decision === "approve" ? "approved" : "rejected", a.comment ?? null));
  tool("prepare_payment", "payment.prepare", "Schedules the payment of an approved invoice for its due date, by the vendor's payment method.",
    { invoice_id: z.string() }, true, async (a) => ({ payment_id: await preparePayment(user, org, a.invoice_id) }));
  tool("release_payment", "payment.release", "Releases a scheduled payment to the bank run. Refused above the employee's limit, for an invoice they approved, or while the vendor's bank change is unverified.",
    { payment_id: z.string() }, true, async (a) => {
      await releasePayment(user, org, a.payment_id);
      return getPaymentRecord(user, org, a.payment_id);
    });
  tool("cancel_payment", "payment.cancel", "Cancels a scheduled payment before it is released, with the reason; its invoice goes back to approved. An AP clerk may cancel only payments they prepared.",
    { payment_id: z.string(), reason: z.string().min(1) }, true, async (a) => {
      await cancelPayment(user, org, a.payment_id, a.reason);
      return getPaymentRecord(user, org, a.payment_id);
    });
  tool("fail_payment", "payment.release", "Marks a released or outstanding payment failed, with the reason (a lost cheque, a transfer the bank returned); its invoice goes back to approved, to be paid again.",
    { payment_id: z.string(), reason: z.string().min(1) }, true, async (a) => {
      await failPayment(user, org, a.payment_id, a.reason);
      return getPaymentRecord(user, org, a.payment_id);
    });
  tool("close_purchase_order", "po.manage", "Closes a purchase order: it stays on record and is no longer offered for invoices.",
    { po_id: z.string() }, true, async (a) => {
      await deleteRecord(user, org, "purchase_orders", a.po_id);
      return getRecord(user, org, "purchase_orders", a.po_id);
    });
  tool("end_contract", "contract.manage", "Ends a contract: it is marked expired and no longer matched to new invoices.",
    { contract_id: z.string() }, true, async (a) => {
      await deleteRecord(user, org, "contracts", a.contract_id);
      return getRecord(user, org, "contracts", a.contract_id);
    });
  tool("request_bank_change", "bank_change.request", "Requests a change of a vendor's bank details; the finance manager approves it after calling the vendor.", {
    vendor_id: z.string(), institution: z.string(), transit: z.string(), account: z.string(),
    channel: z.enum(["email_request", "phone", "vendor_portal"]).describe("how the vendor asked"),
  }, true, async (a) => ({ change_id: await requestBankChange(user, org, a.vendor_id, { institution: a.institution, transit: a.transit, account: a.account, channel: a.channel }) }));

  return server;
}

export const mcp = Router();
// local only: refuses requests whose Host header is not localhost (DNS rebinding)
mcp.use(localhostHostValidation());

// Stateless: each POST carries the token and gets a server for that employee.
mcp.post("/", async (req, res) => {
  const user = await userFromToken(bearer(req.headers.authorization));
  if (!user) {
    res.status(401).set("WWW-Authenticate", 'Bearer realm="brim-ap"').json({ jsonrpc: "2.0", error: { code: -32001, message: "Send a personal access token: Authorization: Bearer brim_…" }, id: null });
    return;
  }
  if (!user.organization_id) {
    res.status(403).json({ jsonrpc: "2.0", error: { code: -32003, message: "Agents work for organization users; Brim employees use the website." }, id: null });
    return;
  }
  const server = serverFor(user);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await auditChannel.run("agent", () => transport.handleRequest(req, res, req.body));
});

// No sessions, so no event stream to open or session to end.
const notAllowed = (_req: unknown, res: import("express").Response) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
};
mcp.get("/", notAllowed);
mcp.delete("/", notAllowed);
