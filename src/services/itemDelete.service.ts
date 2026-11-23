import { rmSync } from "fs";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { tx, query, one, type Db } from "@/lib/db";
import { assertMember, can } from "@/lib/authz";
import { writeAudit } from "@/lib/audit";
import type { User } from "@/lib/types";
import type { StoredFile } from "./rawIntake.service";

// Deleting a submission before it became an invoice: an upload or a form sent by mistake, with what was read from it.
// Everyone, the AP clerk included, deletes only what they submitted themselves; emails from the inbox have no submitter
// and stay. Once a parsed invoice is approved, the invoice is the record and nothing it came from can be deleted.

async function assertMayDelete(c: Db, actor: User | null, organizationId: string, rawItemId: string) {
  assertMember(actor, organizationId);
  const raw = await one<{ submitted_by: string | null }>("SELECT submitted_by FROM raw_items WHERE raw_item_id=$1", [rawItemId], c);
  if (!can(actor, "raw.submit") || raw?.submitted_by !== actor.user_id) throw new ForbiddenError("Only whoever submitted it may delete it.");
}

async function dropParsed(c: Db, parsedInvoiceId: string) {
  await query("DELETE FROM invoice_flags WHERE parsed_invoice_id=$1", [parsedInvoiceId], c);
  await query("DELETE FROM parsed_invoices WHERE parsed_invoice_id=$1", [parsedInvoiceId], c);
}

// A submission: the raw item, its stored files and the parsed invoice read from it.
export async function deleteRawItem(actor: User | null, organizationId: string, rawItemId: string) {
  assertMember(actor, organizationId);
  const files = await tx(async (c) => {
    const raw = await one<{ files: StoredFile[] }>("SELECT files FROM raw_items WHERE raw_item_id=$1 AND organization_id=$2 FOR UPDATE", [rawItemId, organizationId], c);
    if (!raw) throw new NotFoundError("No such raw item");
    await assertMayDelete(c, actor, organizationId, rawItemId);
    const parsed = await query<{ parsed_invoice_id: string; status: string; invoice_id: string | null }>(
      "SELECT parsed_invoice_id, status, invoice_id FROM parsed_invoices WHERE raw_item_id=$1", [rawItemId], c,
    );
    const approved = parsed.find((p) => p.status === "approved");
    if (approved) throw new ConflictError(`${rawItemId} became invoice ${approved.invoice_id}, so it stays as its record.`);
    // how AP dealt with it is an append-only record
    if (await one("SELECT 1 FROM raw_item_handling WHERE raw_item_id=$1", [rawItemId], c)) {
      throw new ConflictError(`How ${rawItemId} was dealt with is on record, so it stays.`);
    }
    for (const p of parsed) await dropParsed(c, p.parsed_invoice_id);
    await query("DELETE FROM raw_items WHERE raw_item_id=$1", [rawItemId], c);
    await writeAudit(c, {
      organizationId, actor, action: "raw_item.delete", entityType: "raw_item", entityId: rawItemId,
      note: [...raw.files.map((f) => f.file_name), ...parsed.map((p) => p.parsed_invoice_id)].join(", ") || undefined,
    });
    return raw.files;
  });
  // the stored copies go once nothing points at them
  for (const f of files) rmSync(f.storage_path, { force: true });
}
