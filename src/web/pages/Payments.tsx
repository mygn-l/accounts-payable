import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { can } from "@/lib/authz";
import { money } from "@/lib/format";
import type { getInvoiceRecord, InvoiceRow, PaymentRow } from "@/services/read.service";
import { get, post, qs, useLoad } from "../api";
import { org, useUser } from "../session";
import { ApiForm, str } from "../components/ApiForm";
import { useListFilter } from "../useListFilter";
import { A, Card, NotFound, PAGE_SIZE, PageTitle, Pager, SearchBox, Show, Status, Table, Td, btn, btnDanger, btnLight, date, dateTime, dimWhile, input, pageParam, withParams } from "../components/ui";

const TABS = ["scheduled", "released", "outstanding", "settled", "failed", "cancelled", "all"];

// Stops a scheduled payment, asking for the reason first; its invoice goes back to approved.
// The reload that follows removes this form, so the confirmation goes to the page through done.
function CancelPayment({ p, done }: { p: PaymentRow; done: (notice: string) => void }) {
  const user = useUser();
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className={btnLight} onClick={() => setOpen(true)}>Cancel payment</button>;
  const cancel = async (fd: FormData) => {
    await post(org(user, `/payments/${p.payment_id}/cancel`), { reason: str(fd, "reason") ?? "" });
    done(`Cancelled ${p.payment_id} (${money(p.amount, p.currency)} to ${p.vendor}). Invoice ${p.invoice_id} is back to approved.`);
  };
  return (
    <ApiForm inline submit={cancel} confirm={`Cancel the ${money(p.amount, p.currency)} payment to ${p.vendor}? Its invoice goes back to approved.`}>
      <input name="reason" placeholder="Reason" className={`${input} max-w-48`} required autoFocus />
      <button className={btnDanger}>Cancel payment</button>
      <button type="button" className={btnLight} onClick={() => setOpen(false)}>Keep</button>
    </ApiForm>
  );
}

// A released or outstanding payment that will not settle is marked failed, with the reason; its invoice can then be paid again.
function FailPayment({ p, onFailed }: { p: { payment_id: string; status: string; amount: number; currency: string; vendor: string }; onFailed: () => void }) {
  const user = useUser();
  const [open, setOpen] = useState(false);
  if ((p.status !== "released" && p.status !== "outstanding") || !can(user, "payment.release")) return null;
  if (!open) return <button type="button" className={btnDanger} onClick={() => setOpen(true)}>Mark failed</button>;
  const fail = async (fd: FormData) => {
    await post(org(user, `/payments/${p.payment_id}/failure`), { reason: String(fd.get("reason") ?? "") });
    setOpen(false);
    onFailed();
  };
  return (
    <ApiForm submit={fail} className="flex flex-col gap-2" confirm={`Mark ${p.payment_id} (${money(p.amount, p.currency)} to ${p.vendor}) failed? Its invoice goes back to approved, to be paid again.`}>
      <input name="reason" placeholder="Why it failed" className={`${input} min-w-[12rem]`} required autoFocus />
      <span className="flex gap-2">
        <button className={btnDanger}>Mark failed</button>
        <button type="button" className={btnLight} onClick={() => setOpen(false)}>Cancel</button>
      </span>
    </ApiForm>
  );
}

export function Payments() {
  const user = useUser();
  const { sp, search, draft, setDraft, term } = useListFilter();
  // the tab the user picked; with none, a search looks through every payment (so "did we pay this?" finds settled ones)
  // and no tab is highlighted
  const chosen = TABS.includes(sp.get("status") ?? "") ? sp.get("status") : null;
  const status = chosen ?? (search ? "all" : "scheduled");
  const page = pageParam(sp.get("page"));
  const readyPage = pageParam(sp.get("readyPage"));
  const path = org(user, `/payments${qs({ status: status === "all" ? null : status, q: search || null, page, size: PAGE_SIZE })}`);
  const rows = useLoad(() => get<PaymentRow[]>(path), path);
  const busy = term !== search || !!rows.stale;
  // approved invoices with no payment yet, for the clerk to prepare
  const ready = useLoad(
    () => (can(user, "payment.prepare")
      ? get<InvoiceRow[]>(org(user, `/invoices${qs({ status: "approved", type: "invoice", page: readyPage, size: PAGE_SIZE })}`))
      : Promise.resolve([] as InvoiceRow[])),
    String(readyPage),
  );
  const [notice, setNotice] = useState<string | null>(null);
  if (!can(user, "payment.view")) return <NotFound />;

  const release = (id: string) => async () => {
    await post(org(user, `/payments/${id}/release`));
    rows.reload();
    return "Released.";
  };
  const prepare = (invoiceId: string) => async () => {
    await post(org(user, "/payments"), { invoice_id: invoiceId });
    rows.reload();
    ready.reload();
    return "Scheduled.";
  };

  return (
    <div className="space-y-5">
      <PageTitle sub="The AP clerk prepares payments for approved invoices; the payment policies say who may release them; a payment settles when the bank statement shows it.">Payments</PageTitle>
      {notice && <p className="form-ok">{notice}</p>}
      {can(user, "payment.prepare") && (ready.data?.length ?? 0) > 0 && (
        <Card id="ready" title={`${ready.data![0].total_count} ready to pay`}>
          <Table head={["Invoice", "Vendor", "Invoice #", "Due", "Total", ""]}>
            {ready.data!.map((i) => (
              <tr key={i.invoice_id}>
                <Td><A href={`/invoices/${i.invoice_id}`}>{i.invoice_id}</A></Td>
                <Td>{i.vendor_name}</Td>
                <Td>{i.vendor_invoice_number}</Td>
                <Td>{date(i.due_date)}</Td>
                <Td className="whitespace-nowrap">{money(i.total, i.currency)}</Td>
                <Td><ApiForm inline submit={prepare(i.invoice_id)}><button className={btn}>Prepare payment</button></ApiForm></Td>
              </tr>
            ))}
          </Table>
          <Pager param="readyPage" page={readyPage} total={ready.data![0].total_count} />
        </Card>
      )}
      <Card
        id="payments"
        title={`${rows.data?.[0]?.total_count ?? 0} payments`}
        actions={
          <div className="flex flex-wrap items-center gap-1 text-xs">
            <SearchBox label="Filter payments" placeholder="Payment, invoice, vendor, or reference" value={draft} onChange={setDraft} />
            {TABS.map((s) => (
              <Link key={s} to={withParams(sp, { status: s, q: term || null, page: null })} className="chip" aria-current={s === status && !(search && !chosen)}>{s}</Link>
            ))}
          </div>
        }
      >
        <div aria-busy={busy} className={dimWhile(busy)}>
        <Show load={rows}>
          {(list) => (
            <>
              <Table head={["Payment", "Invoice", "Vendor", "Method", "Amount", "Scheduled", "Paid", "Prepared / released", "Status", ""]} empty={search ? "No payments match your filter." : "No payments."}>
                {list.map((p) => (
                  <tr key={p.payment_id}>
                    <Td><A href={`/payments/${p.payment_id}`}>{p.payment_id}</A></Td>
                    <Td><A href={`/invoices/${p.invoice_id}`}>{p.invoice_id}</A></Td>
                    <Td>{p.vendor}</Td>
                    <Td>{p.method}</Td>
                    <Td className="whitespace-nowrap">{money(p.amount, p.currency)}</Td>
                    <Td>{date(p.scheduled_date)}</Td>
                    <Td>{date(p.paid_date)}</Td>
                    <Td className="text-xs">{p.preparer ?? "—"} / {p.releaser ?? "—"}</Td>
                    <Td><Status value={p.status} /></Td>
                    <Td>
                      {p.can_release && <ApiForm submit={release(p.payment_id)} confirm={`Release ${money(p.amount, p.currency)} to ${p.vendor}?`}><button className={btn}>Release</button></ApiForm>}
                      {p.release_blocked && <span className="text-xs muted">{p.release_blocked}</span>}
                      {p.can_cancel && <div className="mt-1"><CancelPayment p={p} done={(n) => { setNotice(n); rows.reload(); ready.reload(); }} /></div>}
                      <FailPayment p={p} onFailed={() => { rows.reload(); ready.reload(); }} />
                    </Td>
                  </tr>
                ))}
              </Table>
              <Pager param="page" page={page} total={list[0]?.total_count ?? 0} />
            </>
          )}
        </Show>
        </div>
      </Card>
    </div>
  );
}

type PaymentView = { p: PaymentRow & { statement: { posted_date: string; description: string; amount: number } | null }; inv: Awaited<ReturnType<typeof getInvoiceRecord>>; gl: { account_number: string; name: string }[] };

// Audit-ready view: payment → bank account paid → invoice → approval chain → accounting codes.
export function Payment() {
  const user = useUser();
  const { id = "" } = useParams();
  const load = useLoad(async (): Promise<PaymentView> => {
    const p = await get<PaymentView["p"]>(org(user, `/payments/${id}`));
    const [inv, gl] = await Promise.all([get<PaymentView["inv"]>(org(user, `/invoices/${p.invoice_id}`)), get<PaymentView["gl"]>(org(user, "/gl-accounts"))]);
    return { p, inv, gl };
  }, id);
  const [notice, setNotice] = useState<string | null>(null);
  const navigate = useNavigate();
  if (!can(user, "payment.view")) return <NotFound />;
  const release = async () => {
    await post(org(user, `/payments/${id}/release`));
    load.reload();
    return "Released.";
  };
  // after a failed or cancelled payment the invoice is approved again: its next payment, prepared from here
  const prepareAnother = (invoiceId: string) => async () => {
    const r = await post<{ id: string }>(org(user, "/payments"), { invoice_id: invoiceId });
    navigate(`/payments/${r.id}`);
  };

  return (
    <Show load={load}>
      {({ p, inv, gl }) => {
        const glName = (n: string | null | undefined) => gl.find((g) => g.account_number === n)?.name ?? "";
        return (
          <div className="space-y-5">
            <PageTitle sub={<Status value={p.status} />}>{p.payment_id} · {p.vendor} · {money(p.amount, p.currency)}</PageTitle>
            {notice && <p className="form-ok">{notice}</p>}
            <div className="grid gap-5 lg:grid-cols-2">
              <Card title="Payment" actions={<div className="flex flex-wrap items-center gap-2">
                {p.can_release ? <ApiForm inline submit={release} confirm={`Release ${money(p.amount, p.currency)} to ${p.vendor}?`}><button className={btn}>Release</button></ApiForm> : p.release_blocked && <span className="text-xs muted">{p.release_blocked}</span>}
                {p.can_cancel && <CancelPayment p={p} done={(n) => { setNotice(n); load.reload(); }} />}
                <FailPayment p={p} onFailed={() => load.reload()} />
                {(p.status === "failed" || p.status === "cancelled") && inv.status === "approved" && can(user, "payment.prepare") && (
                  <ApiForm inline submit={prepareAnother(inv.invoice_id)}><button className={btn}>Prepare another payment</button></ApiForm>
                )}
              </div>}>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <dt className="muted">Method</dt><dd>{p.method}</dd>
                  <dt className="muted">Amount</dt><dd>{money(p.amount, p.currency)}{p.currency !== "CAD" && ` = ${money(p.amount_cad)} at ${p.fx_rate_to_cad}`}</dd>
                  <dt className="muted">Scheduled</dt><dd>{date(p.scheduled_date)}</dd>
                  <dt className="muted">Prepared by</dt><dd>{p.preparer ?? "—"}</dd>
                  <dt className="muted">Released by</dt><dd>{p.releaser ?? "—"} {p.released_at && `· ${dateTime(p.released_at)}`}</dd>
                  {p.status === "cancelled" && <><dt className="muted">Cancelled by</dt><dd>{p.canceller ?? "—"} · {dateTime(p.cancelled_at)}</dd><dt className="muted">Reason</dt><dd>{p.cancel_reason}</dd></>}
                  <dt className="muted">Paid</dt><dd>{date(p.paid_date)}</dd>
                  <dt className="muted">Bank account paid</dt><dd>{p.snapshot_account ? `${p.snapshot_institution}-${p.snapshot_transit}-${p.snapshot_account}` : "—"}</dd>
                  <dt className="muted">Reference</dt><dd className="font-mono text-xs">{p.bank_reference ?? p.card_reference ?? "—"}</dd>
                  {p.cheque_number && <><dt className="muted">Cheque</dt><dd>{p.cheque_number}</dd></>}
                  {p.failure_reason && <><dt className="muted">Failed</dt><dd>{p.failure_reason}</dd></>}
                  <dt className="muted">Statement line</dt>
                  <dd>{p.statement ? <>{date(p.statement.posted_date)} · <span className="font-mono text-xs">{p.statement.description}</span> · {money(p.statement.amount)}</> : "—"}</dd>
                </dl>
              </Card>
              <Card title="Invoice">
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <dt className="muted">Invoice</dt><dd><A href={`/invoices/${inv.invoice_id}`}>{inv.invoice_id}</A> ({inv.vendor_invoice_number})</dd>
                  <dt className="muted">Date</dt><dd>{date(inv.invoice_date)}</dd>
                  <dt className="muted">Requester</dt><dd>{inv.requester ?? "—"}</dd>
                  <dt className="muted">Total</dt><dd>{money(inv.total, inv.currency)}</dd>
                </dl>
              </Card>
              <Card title="Approval chain">
                <Table head={["Step", "Approved by", "Status", "When"]}>
                  {inv.approvals.map((s) => (
                    <tr key={s.step_no}><Td>{s.step_no}</Td><Td>{s.actor ?? "—"}{s.on_behalf && ` on behalf of ${s.on_behalf}`}</Td><Td><Status value={s.status} /></Td><Td>{dateTime(s.acted_at)}</Td></tr>
                  ))}
                </Table>
              </Card>
              <Card title="Accounting codes">
                <Table head={["Line", "Description", "GL account", "Amount"]}>
                  {inv.lines.map((l) => (
                    <tr key={l.line_no}><Td>{l.line_no}</Td><Td>{l.description}</Td><Td>{l.gl_account} {glName(l.gl_account)}</Td><Td>{money(l.amount, inv.currency)}</Td></tr>
                  ))}
                  {inv.gst_hst_amount !== 0 && <tr><Td /><Td>GST/HST recoverable</Td><Td>1160 {glName("1160")}</Td><Td>{money(inv.gst_hst_amount, inv.currency)}</Td></tr>}
                  {inv.pst_qst_amount !== 0 && <tr><Td /><Td>PST/QST</Td><Td>{inv.lines.some((l) => l.pst_qst_code === "QST9975") ? `1165 ${glName("1165")}` : "expensed with the lines"}</Td><Td>{money(inv.pst_qst_amount, inv.currency)}</Td></tr>}
                </Table>
              </Card>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
