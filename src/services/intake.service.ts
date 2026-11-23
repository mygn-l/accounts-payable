import { query, tx } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import type { User } from "@/lib/types";
import { submitForm, submitPdf } from "./rawIntake.service";
import { pollInbox } from "./inboxPolling.service";
import { readRawItem } from "./pipeline.service";

// How invoices come in. A form is the invoice itself and becomes a parsed invoice at once.
// An upload or a polled email is stored, answered, then read in the background, five at a time (the reading itself is
// what takes long; storing and checking each one still happens in turn, see readRawItem).

const READERS = 5;
const queue: { organizationId: string; rawItemId: string }[] = [];
const queued = new Set<string>();
let readers = 0;

function queueReading(organizationId: string, rawItemId: string) {
  if (queued.has(rawItemId)) return;
  queued.add(rawItemId);
  queue.push({ organizationId, rawItemId });
  while (readers < Math.min(READERS, queue.length)) void readQueue();
}

async function readQueue() {
  readers++;
  while (queue.length) {
    const job = queue.shift()!;
    try {
      await readRawItem(job.organizationId, job.rawItemId);
    } catch (e) {
      // recording the failure must not stop the queue, nor the server
      await markFailed(job.organizationId, job.rawItemId, e instanceof Error ? e.message : String(e)).catch((err) => console.error("could not record a reading failure", err));
    } finally {
      queued.delete(job.rawItemId);
    }
  }
  readers--;
}

// A raw item that could not be read keeps the reason; the next poll tries it again.
async function markFailed(organizationId: string, rawItemId: string, reason: string) {
  await tx(async (c) => {
    const rows = await query("UPDATE raw_items SET status='failed', failure_reason=$2 WHERE raw_item_id=$1 AND status IN ('new','failed') RETURNING 1", [rawItemId, reason], c);
    if (rows.length) await writeAudit(c, { organizationId, actor: null, action: "raw_item.read_failed", entityType: "raw_item", entityId: rawItemId, note: reason });
  });
}

// Every raw item of the organization still to be read: new ones, and ones that failed before.
async function queueUnread(organizationId: string) {
  const rows = await query<{ raw_item_id: string }>(
    "SELECT raw_item_id FROM raw_items WHERE organization_id=$1 AND status IN ('new','failed') ORDER BY received_at",
    [organizationId],
  );
  for (const r of rows) queueReading(organizationId, r.raw_item_id);
  return rows.length;
}

// An uploaded file: stored as it is, then read.
export async function uploadInvoice(actor: User | null, fileName: string, bytes: Buffer) {
  const id = await submitPdf(actor, fileName, bytes);
  queueReading(actor!.organization_id!, id);
  return id;
}

// The AP inbox: new emails are stored, then every unread raw item is read, failed ones included.
export async function pollAndRead(actor: User | null) {
  const r = await pollInbox(actor);
  const reading = await queueUnread(actor!.organization_id!);
  return { ...r, reading };
}

// The invoice form: checked, stored as typed, and turned into a parsed invoice for the clerk's review in the same request.
export async function submitInvoiceForm(actor: User | null, form: Record<string, unknown>, opts: { scan?: { fileName: string; bytes: Buffer } } = {}) {
  const rawItemId = await submitForm(actor, form, opts);
  const { parsed } = await readRawItem(actor!.organization_id!, rawItemId);
  return { id: rawItemId, parsed_invoice_id: parsed[0] ?? null };
}

// After a restart, anything left unread is read.
export async function resumeReading() {
  const orgs = await query<{ organization_id: string }>("SELECT DISTINCT organization_id FROM raw_items WHERE status='new'");
  for (const o of orgs) {
    const rows = await query<{ raw_item_id: string }>("SELECT raw_item_id FROM raw_items WHERE organization_id=$1 AND status='new' ORDER BY received_at", [o.organization_id]);
    for (const r of rows) queueReading(o.organization_id, r.raw_item_id);
  }
}
