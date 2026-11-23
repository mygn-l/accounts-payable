import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { actionName } from "@/lib/auditActions";
import { can } from "@/lib/authz";
import { money } from "@/lib/format";
import type { InvoiceLine, User } from "@/lib/types";
import type { RawItem } from "@/services/rawIntake.service";
import type { getInvoiceRecord, getParsedInvoiceRecord, getRawItemRecord } from "@/services/read.service";
import { HANDLING_HINTS, HANDLING_OUTCOMES, type HandlingOutcome } from "@/lib/handling";
import type { TrailEvent } from "@/services/audit.service";
import type { PurchaseOrderChoice } from "@/services/purchaseOrderLink.service";
import { ApiError, call, del, get, patch, post, useLoad } from "../api";
import { org, useUser } from "../session";
import { ApiForm, str } from "../components/ApiForm";
import { InvoiceEntry, type EnteredInvoice } from "./InvoiceIntake";
import { A, Badge, Card, Field, PageTitle, Show, Status, Table, Td, btn, btnDanger, btnLight, date, dateTime, input } from "../components/ui";
import { VendorLink } from "../components/VendorLink";

type InvoiceRecord = Awaited<ReturnType<typeof getInvoiceRecord>>;
type RawRecord = Awaited<ReturnType<typeof getRawItemRecord>>;
type ParsedRecord = Awaited<ReturnType<typeof getParsedInvoiceRecord>>;

// A record the user may not see (404) is left out of the screen.
const unlessHidden = <T,>(p: Promise<T>) =>
  p.catch((e) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });

// One invoice: the raw item beside the parsed invoice, the clerk's review, flags, approval chain, payment and audit trail.
// The id is a parsed invoice (PRS-…) or an invoice.
export function Invoice() {
  const user = useUser();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const load = useLoad(async () => {
    let invoice: InvoiceRecord | null = null;
    let parsed: ParsedRecord | null = null;
    // a submission not yet read: the raw item on its own
    if (id.startsWith("RAW-")) {
      const [raw, vendors, users] = await Promise.all([
        get<RawRecord>(org(user, `/raw-items/${id}`)),
        get<{ vendor_id: string; legal_name: string; status: string }[]>(org(user, "/vendor-choices")),
        // who an email with no invoice can be forwarded to
        can(user, "parsed.review") ? get<User[]>(org(user, "/user-choices")) : Promise.resolve([] as User[]),
      ]);
      const people = users.filter((u) => u.status !== "terminated");
      return { invoice, parsed, raw, audit: [] as TrailEvent[], vendors, depts: [], gls: [], people };
    }
    if (id.startsWith("PRS-")) {
      parsed = await get<ParsedRecord>(org(user, `/parsed-invoices/${id}`));
      if (parsed.invoice_id) invoice = await unlessHidden(get<InvoiceRecord>(org(user, `/invoices/${parsed.invoice_id}`)));
    } else {
      invoice = await get<InvoiceRecord>(org(user, `/invoices/${id}`));
      if (invoice.parsed_invoice_id) parsed = await unlessHidden(get<ParsedRecord>(org(user, `/parsed-invoices/${invoice.parsed_invoice_id}`)));
    }
    const [raw, audit, vendors, depts, gls, users] = await Promise.all([
      parsed ? unlessHidden(get<RawRecord>(org(user, `/raw-items/${parsed.raw_item_id}`))) : null,
      get<TrailEvent[]>(org(user, invoice ? `/invoices/${invoice.invoice_id}/audit-events` : `/parsed-invoices/${parsed!.parsed_invoice_id}/audit-events`)),
      get<{ vendor_id: string; legal_name: string; status: string }[]>(org(user, "/vendor-choices")),
      get<{ department_id: string; name: string }[]>(org(user, "/departments")),
      get<{ account_number: string; name: string }[]>(org(user, "/gl-accounts?account_type=expense")),
      get<User[]>(org(user, "/user-choices")),
    ]);
    const people = users.filter((u) => u.status !== "terminated");
    return { invoice, parsed, raw, audit, vendors, depts, gls, people };
  }, id);
  const after = (msg: string) => {
    load.reload();
    return msg;
  };
  // the clerk's edit: the invoice as on the invoice form, with its coding, opened only on Edit
  const [editing, setEditing] = useState(false);

  return (
    <Show load={load}>
      {({ invoice, parsed, raw, audit, vendors, depts, gls, people }) => {
        // a created invoice shows its flags except those about reading the document; before that, all the parsed invoice's flags
        const flags = invoice ? invoice.flags : parsed?.flags ?? [];
        const steps = invoice?.approvals ?? [];
        const payments = invoice?.payments ?? [];
        const reviewing = parsed?.status === "pending" && can(user, "parsed.review");
        const d = parsed?.invoice_json;
        // a form is the invoice as typed, already shown as the invoice; only an attached copy of the document is worth showing beside it
        const showRaw = !(raw?.kind === "form" && !raw.files.length);
        const vendorName = (vid: string | null | undefined) => vendors.find((v) => v.vendor_id === vid)?.legal_name;
        const title = invoice
          ? `${invoice.invoice_id} · ${invoice.vendor_name} ${invoice.vendor_invoice_number}`
          : parsed
            ? `${parsed.parsed_invoice_id} · ${vendorName(d?.vendor_id) ?? d?.vendor_name ?? "Unknown vendor"} ${d?.vendor_invoice_number ?? ""}`
            : `${raw!.raw_item_id} · ${raw!.kind === "form" ? `form ${raw!.form_json?.vendor_invoice_number ?? ""}` : raw!.kind === "pdf" ? raw!.files[0]?.file_name ?? "upload" : raw!.subject ?? "email"}`;
        const mySteps = steps.filter((s) => s.can_act);

        const enter = async (entry: EnteredInvoice) => {
          await call("PUT", org(user, `/parsed-invoices/${parsed!.parsed_invoice_id}/entry`), entry);
          setEditing(false);
          return after("Saved. Run the checks again to see what changed.");
        };
        const readAgain = async () => {
          const r = await post<{ id: string }>(org(user, `/parsed-invoices/${parsed!.parsed_invoice_id}/read-again`));
          navigate(`/invoices/${r.id}`);
        };
        const deleteSubmission = async () => {
          await del(org(user, `/raw-items/${raw!.raw_item_id}`));
          navigate("/invoices", { state: { notice: `Submission ${raw!.raw_item_id} deleted.` } });
        };
        const runChecks = async () => {
          await post(org(user, `/parsed-invoices/${parsed!.parsed_invoice_id}/checks`));
          return after("Checks ran again.");
        };
        const resolveFlag = (flagId: string) => async (fd: FormData) => {
          await patch(org(user, `/flags/${flagId}`), { status: str(fd, "status") ?? "resolved", note: str(fd, "note") ?? "" });
          return after("Flag updated.");
        };
        const approveParsed = async () => {
          const r = await post<{ id: string }>(org(user, `/parsed-invoices/${parsed!.parsed_invoice_id}/approve`));
          navigate(`/invoices/${r.id}`);
        };
        const rejectParsed = async (fd: FormData) => {
          await post(org(user, `/parsed-invoices/${parsed!.parsed_invoice_id}/reject`), { reason: str(fd, "reason") ?? "" });
          return after("Rejected.");
        };
        const decide = (approvalId: string) => async (fd: FormData) => {
          const rejected = str(fd, "decision") === "rejected";
          await post(org(user, `/approvals/${approvalId}/${rejected ? "reject" : "approve"}`), { comment: str(fd, "comment") });
          return after(rejected ? "Rejected." : "Approved.");
        };
        const prepare = async () => {
          await post(org(user, "/payments"), { invoice_id: invoice!.invoice_id });
          return after("Payment scheduled.");
        };

        return (
          <div className="space-y-5">
            <PageTitle sub={
              <span className="flex flex-wrap items-center gap-2">
                <Status value={invoice?.status ?? parsed?.status ?? raw?.status} />
                {invoice?.type === "credit_note" && <Badge tone="violet">credit note</Badge>}
                {/* where it came from, as the raw item records it */}
                {raw && <><Badge>{raw.kind}</Badge><span className="text-xs muted">received {dateTime(raw.received_at)}</span></>}
              </span>
            }>
              {title}
            </PageTitle>

            {/* the approver's decision comes first, above the documents */}
            {invoice && mySteps.map((s) => (
              <Card key={s.approval_id} title={`Your decision · step ${s.step_no}${s.assigned_user_id !== user.user_id ? ` on behalf of ${s.assignee}` : ""}`}>
                <p className="mb-3 text-sm">{invoice.vendor_name} · {invoice.vendor_invoice_number} · {money(invoice.total, invoice.currency)}{invoice.department && ` · ${invoice.department}`}</p>
                <ApiForm submit={decide(s.approval_id)} className="flex flex-wrap gap-2" confirm={(fd) => `${fd.get("decision") === "rejected" ? "Reject" : "Approve"} ${invoice.vendor_name} ${invoice.vendor_invoice_number} for ${money(invoice.total, invoice.currency)}?`}>
                  <input name="comment" placeholder="Comment (required to reject)" className={`${input} max-w-md`} />
                  <button name="decision" value="approved" className={btn}>Approve</button>
                  <button name="decision" value="rejected" className={btnDanger}>Reject</button>
                </ApiForm>
              </Card>
            ))}
            {!parsed && raw?.no_invoice_reason && <p className="text-sm muted">No invoice found: {raw.no_invoice_reason}</p>}
            {!parsed && raw?.status === "new" && <p className="text-sm muted">Being read; the invoice appears here when it is done.</p>}
            {!parsed && raw?.status === "failed" && <p className="form-error">Could not be read: {raw.failure_reason}</p>}
            {!parsed && raw && (raw.status === "no_invoice" || raw.status === "failed") && (
              <HandlingCard
                raw={raw}
                people={people}
                canHandle={can(user, "parsed.review")}
                submit={async (fd) => {
                  await post(org(user, `/raw-items/${raw.raw_item_id}/handle`), {
                    outcome: str(fd, "outcome"),
                    note: str(fd, "note"),
                    forwardedTo: str(fd, "forwardedTo"),
                  });
                  return after("Recorded.");
                }}
              />
            )}

            <div className={`grid gap-5 ${showRaw ? (editing && reviewing ? "xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" : "xl:grid-cols-2") : ""}`}>
              {showRaw && (
                <Card title="As received">
                  <RawView raw={raw} file={parsed?.file_name ?? null} />
                </Card>
              )}

              <div className="space-y-5">
                {d && (
                  <Card
                    title={invoice ? "Invoice" : "Parsed invoice"}
                    actions={
                      <span className="flex flex-wrap items-center gap-2">
                        {parsed?.extraction_model && <span className="text-xs muted">read by {parsed.extraction_model}{parsed.extraction_language === "fr" ? " · French" : ""}</span>}
                        {reviewing && !editing && <button type="button" className={btnLight} onClick={() => setEditing(true)}>Edit</button>}
                        {parsed && parsed.status !== "approved" && parsed.file_name && can(user, "raw.extract") && (
                          <ApiForm inline submit={readAgain} confirm={`Read ${parsed.file_name} again? ${parsed.parsed_invoice_id}, with its edits and flags, is deleted and replaced by the new reading.`}>
                            <button className={btnLight}>Read again</button>
                          </ApiForm>
                        )}
                      </span>
                    }
                  >
                    {reviewing && editing ? (
                      <InvoiceEntry
                        start={{ ...d, lines: d.lines, taxes: d.taxes }}
                        submitLabel="Save changes"
                        onSubmit={enter}
                        cancel={<button type="button" className={btnLight} onClick={() => setEditing(false)}>Cancel</button>}
                        coding={{ depts, gls, people }}
                      />
                    ) : (
                      <div className="space-y-4">
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                          <Item k="Vendor">{invoice ? <VendorLink id={invoice.vendor_id}>{invoice.vendor_name}</VendorLink> : vendorName(d.vendor_id) ?? d.vendor_name}</Item>
                          <Item k="Invoice number">{d.vendor_invoice_number}</Item>
                          <Item k="Invoice date">{date(d.invoice_date)}</Item>
                          <Item k="Due date">{date(d.due_date)}</Item>
                          <Item k="Department">{depts.find((x) => x.department_id === d.department_id)?.name ?? "—"}</Item>
                          <Item k="Requester">{people.find((p) => p.user_id === d.requester_user_id)?.full_name ?? "—"}</Item>
                          <Item k="Purchase order">
                            <PurchaseOrderField parsedId={parsed && parsed.status !== "rejected" && can(user, "po.manage") ? parsed.parsed_invoice_id : null} current={d.po_id ?? null} onLinked={() => load.reload()} />
                          </Item>
                          <Item k="Contract">{d.contract_id ?? "—"}</Item>
                          <Item k="Delivered to">{d.ship_to_province ?? "—"}</Item>
                          <Item k="Total">{money(d.total, d.currency)}{d.currency !== "CAD" && ` (${money(d.total_cad)})`}</Item>
                          {invoice?.duplicate_of_invoice_id && <Item k="Duplicate of"><A href={`/invoices/${invoice.duplicate_of_invoice_id}`}>{invoice.duplicate_of_invoice_id}</A></Item>}
                          {invoice?.credit_for_invoice_id && <Item k="Credit for"><A href={`/invoices/${invoice.credit_for_invoice_id}`}>{invoice.credit_for_invoice_id}</A></Item>}
                        </dl>
                        <LinesTable lines={invoice?.lines ?? d.lines} gls={gls} depts={depts} currency={d.currency} />
                        <Taxes d={d} />
                      </div>
                    )}
                  </Card>
                )}

                {(invoice ? flags.length > 0 : !!parsed) && (
                  <Card
                    title={`Flags (${flags.filter((f) => f.status === "open").length} open)`}
                    actions={reviewing && <ApiForm inline submit={runChecks}><button className={btnLight}>Run checks again</button></ApiForm>}
                  >
                    {flags.length === 0 && <p className="text-sm text-green">No problems found.</p>}
                    <ul className="space-y-3">
                      {flags.map((f) => (
                        <li key={f.flag_id} className={`flag ${f.status !== "open" ? "flag--closed" : `flag--${f.severity}`}`}>
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="mb-1 flex gap-1"><Status value={f.severity} /><Badge>{f.category === "po" ? "purchase order" : f.category}</Badge>{f.line_no && <Badge>line {f.line_no}</Badge>}{f.status !== "open" && <Status value={f.status} />}</div>
                              <p className="text-sm">{f.message} {f.related_invoice_id && <A href={`/invoices/${f.related_invoice_id}`}>Open {f.related_invoice_id}</A>}</p>
                              {f.resolution_note && <p className="mt-1 text-xs muted">{f.resolver ? `${f.resolver}: ` : ""}{f.resolution_note}</p>}
                            </div>
                          </div>
                          {f.status === "open" && f.category === "fraud" && !can(user, "flag.resolve_fraud") && (parsed?.status === "pending" || !!invoice) && (
                            <p className="mt-2 text-xs muted">A fraud flag is closed by a finance manager or the controller.</p>
                          )}
                          {f.status === "open" && (f.category === "fraud" ? can(user, "flag.resolve_fraud") && (parsed?.status === "pending" || !!invoice) : reviewing) && (
                            <ApiForm submit={resolveFlag(f.flag_id)} className="mt-2 flex gap-2" confirm={(fd) => (fd.get("status") === "overridden" ? `Override this ${f.severity} flag? The invoice goes ahead despite it.` : null)}>
                              <input name="note" placeholder="What you checked or decided" className={input} required />
                              <select name="status" className="input w-36"><option value="resolved">Resolved</option><option value="overridden">Override</option></select>
                              <button className={btnLight}>Save</button>
                            </ApiForm>
                          )}
                        </li>
                      ))}
                    </ul>
                    {reviewing && (
                      <div className="mt-4 flex flex-wrap items-start gap-3 border-t border-line pt-4">
                        <ApiForm submit={approveParsed} confirm="Approve this into the invoices? Its approval chain starts.">
                          <button className={btn}>Approve into invoices</button>
                        </ApiForm>
                        <ApiForm submit={rejectParsed} className="flex gap-2" confirm="Reject this parsed invoice?">
                          <input name="reason" placeholder="Reason" className={input} required />
                          <button className={btnDanger}>Reject</button>
                        </ApiForm>
                      </div>
                    )}
                    {parsed?.status === "rejected" && <p className="mt-3 text-sm text-flag">Rejected: {parsed.rejection_reason}</p>}
                  </Card>
                )}

                {invoice && (
                  <Card title="Approval chain">
                    <Table head={["Step", "Approver", "Status", "Decision"]} empty="No approval steps.">
                      {steps.map((s) => (
                        <tr key={s.approval_id}>
                          <Td>{s.step_no}{s.rule_id && <span className="ml-1 text-xs muted">{s.rule_id}</span>}</Td>
                          <Td>
                            {s.assignee}
                            {s.reassign_reason && (
                              <div className="text-xs muted">
                                {s.reassign_reason === "delegate" ? `delegate for ${s.original}`
                                  : s.reassign_reason === "requester_is_approver" ? `${s.original} requested it; escalated`
                                    : s.reassign_reason === "over_limit" ? `above ${s.original}'s approval limit; escalated`
                                      : `${s.original} has left; escalated`}
                              </div>
                            )}
                          </Td>
                          <Td><Status value={s.status} /></Td>
                          <Td>
                            {s.actor && <div className="text-xs">{s.actor}{s.on_behalf && ` on behalf of ${s.on_behalf}`} · {dateTime(s.acted_at)}{s.comment && ` · “${s.comment}”`}</div>}
                            {s.can_act && <span className="text-xs muted">your decision, at the top</span>}
                            {s.blocked && <span className="text-xs text-flag">{s.blocked}</span>}
                          </Td>
                        </tr>
                      ))}
                    </Table>
                  </Card>
                )}

                {invoice && (can(user, "payment.view") || payments.length > 0) && (
                  <Card title="Payment" actions={invoice.status === "approved" && invoice.type === "invoice" && can(user, "payment.prepare") && (
                    <ApiForm submit={prepare}><button className={btn}>Prepare payment</button></ApiForm>
                  )}>
                    <Table head={["Payment", "Method", "Amount", "Scheduled", "Paid", "Status"]} empty={invoice.type === "credit_note" ? "Credit notes are not paid." : "No payment yet."}>
                      {payments.map((p) => (
                        <tr key={p.payment_id}>
                          <Td><A href={`/payments/${p.payment_id}`}>{p.payment_id}</A></Td>
                          <Td>{p.method}</Td>
                          <Td>{money(p.amount, p.currency)}</Td>
                          <Td>{date(p.scheduled_date)}</Td>
                          <Td>{date(p.paid_date)}</Td>
                          <Td><Status value={p.status} /></Td>
                        </tr>
                      ))}
                    </Table>
                  </Card>
                )}
              </div>
            </div>

            {(invoice || parsed) && (
              <Card title="Audit trail">
                <Table head={["When", "Who", "Action", "On", "Note"]} empty="No events.">
                  {audit.map((e) => (
                    <tr key={e.event_id}>
                      <Td className="whitespace-nowrap text-xs">{dateTime(e.occurred_at)}</Td>
                      <Td>{e.actor ?? "system"}{e.actor_role && <span className="ml-1 text-xs muted">{e.actor_role.replace(/_/g, " ")}</span>}{e.on_behalf && <div className="text-xs muted">on behalf of {e.on_behalf}</div>}</Td>
                      <Td className="text-xs">{actionName(e.action)}{e.channel === "agent" && <Badge tone="purple">agent</Badge>}</Td>
                      <Td className="font-mono text-xs">{e.entity_id}</Td>
                      <Td className="text-xs">{e.note}</Td>
                    </tr>
                  ))}
                </Table>
              </Card>
            )}

            {/* your own submission, until it becomes an invoice: delete it, with what was read from it */}
            {raw && raw.submitted_by === user.user_id && can(user, "raw.submit") && !invoice && parsed?.status !== "approved" && (
              <ApiForm
                submit={deleteSubmission}
                confirm={`Delete your submission ${raw.raw_item_id}${parsed ? ` and ${parsed.parsed_invoice_id}, read from it` : ""}? This cannot be undone.`}
                className="border-t border-line pt-5"
              >
                <button className={btnDanger}>Delete submission</button>
              </ApiForm>
            )}
          </div>
        );
      }}
    </Show>
  );
}

// The invoice's purchase order; whoever may link one changes it after pressing Change.
function PurchaseOrderField({ parsedId, current, onLinked }: { parsedId: string | null; current: string | null; onLinked: () => void }) {
  const [open, setOpen] = useState(false);
  if (parsedId && open) return <PurchaseOrderPicker parsedId={parsedId} current={current} onLinked={() => { setOpen(false); onLinked(); }} onCancel={() => setOpen(false)} />;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {current ? <A href={`/purchase-orders/${current}`}>{current}</A> : "—"}
      {parsedId && <button type="button" className={btnLight} onClick={() => setOpen(true)}>Change</button>}
    </span>
  );
}

// Links the invoice to one of its vendor's purchase orders, listed closest match first, at any stage of the invoice.
function PurchaseOrderPicker({ parsedId, current, onLinked, onCancel }: { parsedId: string; current: string | null; onLinked: () => void; onCancel: () => void }) {
  const user = useUser();
  const choices = useLoad(() => get<PurchaseOrderChoice[]>(org(user, `/parsed-invoices/${parsedId}/purchase-order-choices`)), `${parsedId}:${current}`);
  const [picked, setPicked] = useState(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const link = async () => {
    setError(null);
    try {
      await call("PUT", org(user, `/parsed-invoices/${parsedId}/purchase-order`), { po_id: picked || null });
      onLinked();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  if (choices.data && !choices.data.length && !current) {
    return <span className="flex items-center gap-2"><span className="muted">— (no open purchase order)</span><button type="button" className={btnLight} onClick={onCancel}>Cancel</button></span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <select value={picked} onChange={(e) => setPicked(e.target.value)} className={`${input} max-w-md`}>
        <option value="">— none —</option>
        {(choices.data ?? []).map((o) => (
          <option key={o.po_id} value={o.po_id}>
            {o.po_id} · {o.same_vendor ? "" : `${o.vendor_name} (other vendor) · `}{money(o.remaining, o.currency)} left of {money(o.total_amount, o.currency)}{o.fits ? "" : " · too little left"}{o.description ? ` · ${o.description}` : ""}
          </option>
        ))}
      </select>
      <button type="button" className={btnLight} disabled={picked === (current ?? "")} onClick={link}>{!picked && current ? "Unlink" : "Link"}</button>
      <button type="button" className={btnLight} onClick={onCancel}>Cancel</button>
      {error && <span className="form-error">{error}</span>}
    </span>
  );
}

function Item({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs muted">{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// An item with no invoice, or one not readable: what has been done about it, and, for the AP clerk, a way to deal with it.
function HandlingCard({
  raw,
  people,
  canHandle,
  submit,
}: {
  raw: RawRecord;
  people: User[];
  canHandle: boolean;
  submit: (fd: FormData) => Promise<string | void>;
}) {
  const latest = raw.handling.at(-1);
  const [outcome, setOutcome] = useState<HandlingOutcome>(latest ? "reviewed" : raw.status === "failed" || /missing attachment/i.test(raw.no_invoice_reason ?? "") ? "requested" : "reviewed");
  const open = !latest || latest.outcome === "requested";
  return (
    <Card
      title="Deal with this email"
      actions={
        !latest ? <Badge tone="red">needs attention</Badge>
          : latest.outcome === "requested" ? <Badge tone="gold">waiting on sender</Badge>
          : <Badge tone="green">handled</Badge>
      }
    >
      <div className="space-y-4">
        {raw.handling.length > 0 && (
          <ul className="m-0 list-none space-y-2 p-0 text-sm">
            {raw.handling.map((h) => (
              <li key={h.handling_id}>
                <span className="font-medium">{HANDLING_OUTCOMES[h.outcome]}</span>
                {h.forwarded_to_name && <> to {h.forwarded_to_name}</>}
                <span className="muted"> · {h.handled_by_name}, {dateTime(h.handled_at)}</span>
                <div className="muted">{h.note}</div>
              </li>
            ))}
          </ul>
        )}
        {!canHandle ? (
          !latest && <p className="m-0 text-sm muted">An AP clerk deals with emails that hold no invoice.</p>
        ) : (
          <ApiForm submit={submit} reset className="flex flex-col gap-3">
            <p className="m-0 text-sm muted">
              {open
                ? "This email holds no invoice to pay. Say what you did about it, so it leaves Needs attention."
                : "Already dealt with. Add another step if something changed, e.g. the sender answered."}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="What you did">
                <select name="outcome" className={input} value={outcome} onChange={(e) => setOutcome(e.target.value as HandlingOutcome)}>
                  {(Object.keys(HANDLING_OUTCOMES) as HandlingOutcome[]).map((k) => (
                    <option key={k} value={k}>{HANDLING_OUTCOMES[k]}</option>
                  ))}
                </select>
              </Field>
              {outcome === "forwarded" && (
                <Field label="Forwarded to">
                  <select name="forwardedTo" className={input} required defaultValue="">
                    <option value="" disabled>Choose a person</option>
                    {people.map((p) => <option key={p.user_id} value={p.user_id}>{p.full_name}</option>)}
                  </select>
                </Field>
              )}
            </div>
            <p className="m-0 text-xs muted">{HANDLING_HINTS[outcome]}</p>
            <Field label="Note">
              <input
                name="note"
                className={input}
                required
                minLength={3}
                placeholder={outcome === "requested" ? "e.g. Emailed ar@polarfreight to resend the October statement" : "What you did, in a sentence"}
              />
            </Field>
            <button className={btn}>Record</button>
          </ApiForm>
        )}
      </div>
    </Card>
  );
}

function RawView({ raw, file }: { raw: RawItem | null; file: string | null }) {
  if (!raw) return <p className="text-sm muted">No raw item.</p>;
  const f = raw.files.find((x) => x.file_name === file) ?? raw.files[0];
  const url = f ? `/api/organizations/${raw.organization_id}/raw-items/${raw.raw_item_id}/files/${encodeURIComponent(f.file_name)}` : null;
  return (
    <div className="space-y-3 text-sm">
      <div className="text-xs muted"><span className="font-mono">{raw.raw_item_id}</span></div>
      {raw.kind === "email" && (
        <div className="rounded-[6px] border-2 border-border bg-surface-2 p-3">
          <div><span className="muted">From:</span> {raw.from_name} &lt;{raw.from_address}&gt;</div>
          <div><span className="muted">Subject:</span> {raw.subject}</div>
          <p className="mt-2 whitespace-pre-wrap muted">{raw.body}</p>
        </div>
      )}
      {url && f && (f.mime_type === "application/pdf" ? <iframe src={url} className="h-[720px] w-full rounded-[6px] border-2 border-border" /> : f.mime_type.startsWith("image/") ? <img src={url} alt={f.file_name} className="w-full rounded-[6px] border-2 border-border" /> : <a href={url}>{f.file_name}</a>)}
    </div>
  );
}

function LinesTable({ lines, gls, depts, editable, currency }: { lines: InvoiceLine[]; gls: { account_number: string; name: string }[]; depts: { department_id: string; name: string }[]; editable?: boolean; currency: string }) {
  return (
    <Table head={["#", "Description", "Qty", "Unit", "Amount", "GL account", "Department", "Type"]}>
      {lines.map((l) => (
        <tr key={l.line_no}>
          <Td>{l.line_no}</Td>
          <Td>
            {l.description}
            {l.suggestion_reason && <div className="text-xs muted">Suggested: {l.suggested_gl_account ?? "—"} · {l.suggestion_reason}{l.coding_status && l.coding_status !== "suggested" && ` · ${l.coding_status}`}</div>}
          </Td>
          <Td>{l.quantity}</Td>
          <Td className="whitespace-nowrap">{money(l.unit_price, currency)}</Td>
          <Td className="whitespace-nowrap">{money(l.amount, currency)}</Td>
          <Td>
            {editable ? (
              <select name={`gl_${l.line_no}`} defaultValue={l.gl_account ?? ""} className={input}>
                <option value="">—</option>
                {gls.map((g) => <option key={g.account_number} value={g.account_number}>{g.account_number} {g.name}</option>)}
              </select>
            ) : `${l.gl_account ?? "—"} ${gls.find((g) => g.account_number === l.gl_account)?.name ?? ""}`}
          </Td>
          <Td>
            {editable ? (
              <select name={`dept_${l.line_no}`} defaultValue={l.department_id ?? ""} className={input}>
                <option value="">—</option>
                {depts.map((x) => <option key={x.department_id} value={x.department_id}>{x.name}</option>)}
              </select>
            ) : depts.find((x) => x.department_id === l.department_id)?.name ?? "—"}
          </Td>
          <Td>
            {editable ? (
              <select name={`type_${l.line_no}`} defaultValue={l.line_type ?? "services"} className={input}>
                <option>services</option><option>goods</option>
              </select>
            ) : l.line_type}
          </Td>
        </tr>
      ))}
    </Table>
  );
}

function Taxes({ d }: { d: { subtotal: number | null; taxes: { label: string; amount: number }[]; total: number | null; currency: string } }) {
  return (
    <dl className="ml-auto w-64 space-y-1 text-sm">
      <div className="flex justify-between"><dt className="muted">Subtotal</dt><dd>{money(d.subtotal, d.currency)}</dd></div>
      {d.taxes.map((t, i) => <div key={i} className="flex justify-between"><dt className="muted">{t.label}</dt><dd>{money(t.amount, d.currency)}</dd></div>)}
      <div className="flex justify-between border-t border-line pt-1 font-medium"><dt>Total</dt><dd>{money(d.total, d.currency)}</dd></div>
    </dl>
  );
}
