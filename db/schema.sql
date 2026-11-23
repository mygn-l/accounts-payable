-- AP automation schema. Every table belongs to one organization except Brim employees.

CREATE TABLE organizations (
  organization_id text PRIMARY KEY,
  legal_name      text NOT NULL,
  gst_hst_number  text,
  base_currency   text NOT NULL DEFAULT 'CAD',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE departments (
  department_id   text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations,
  name            text NOT NULL,
  cost_centre     text,
  manager_user_id text
);

CREATE TABLE users (
  user_id            text PRIMARY KEY,
  organization_id    text REFERENCES organizations,
  full_name          text NOT NULL,
  email              text NOT NULL UNIQUE,
  title              text,
  department_id      text REFERENCES departments,
  manager_id         text REFERENCES users,
  role               text NOT NULL CHECK (role IN ('brim_employee','employee','ap_clerk','approver','finance_manager','controller_admin','auditor')),
  -- the most this person may approve, whatever the policy; empty: no personal cap, only the policies apply
  approval_limit_cad numeric(14,2),
  work_province      text,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_leave','terminated')),
  status_since       date,
  delegate_user_id   text REFERENCES users
);

ALTER TABLE departments ADD FOREIGN KEY (manager_user_id) REFERENCES users DEFERRABLE INITIALLY DEFERRED;

-- Each user's dashboard preferences: only the settings they changed, merged over the defaults in code (src/lib/preferences.ts).
CREATE TABLE user_preferences (
  user_id    text PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  prefs      jsonb NOT NULL DEFAULT '{}'::jsonb,
  version    integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Kept apart from users so that no read of users, nor the audit log of a user change, can carry a password hash.
CREATE TABLE user_passwords (
  user_id       text PRIMARY KEY REFERENCES users,
  password_hash text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Personal access tokens: an employee's agent signs in with one. Only a hash is kept; the token is shown once.
CREATE TABLE api_tokens (
  token_id     text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE gl_accounts (
  account_number  text NOT NULL,
  organization_id text NOT NULL REFERENCES organizations,
  name            text NOT NULL,
  account_type    text NOT NULL,
  PRIMARY KEY (organization_id, account_number)
);

-- When [field] [operator] [value], require [required]. The fields, operators and roles each type allows are in src/lib/policies.ts.
CREATE TABLE approval_policies (
  rule_id         text NOT NULL,
  organization_id text NOT NULL REFERENCES organizations,
  rule_type       text NOT NULL CHECK (rule_type IN ('approval','match','payment_release')),
  field           text NOT NULL,
  operator        text NOT NULL CHECK (operator IN ('<=','>','is','in','always')),
  value           text,
  required        text[] NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  updated_by      text REFERENCES users,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, rule_id)
);

CREATE TABLE vendors (
  vendor_id                text PRIMARY KEY,
  organization_id          text NOT NULL REFERENCES organizations,
  legal_name               text NOT NULL,
  category                 text,
  default_gl_account       text,
  address                  text,
  province_or_state        text,
  country                  text,
  gst_hst_number           text,
  qst_number               text,
  payment_terms_days       integer,
  early_pay_discount       text,
  preferred_payment_method text CHECK (preferred_payment_method IN ('EFT','CHEQUE','CARD')),
  accepts_card_payment     boolean NOT NULL DEFAULT false,
  bank_institution         text,
  bank_transit             text,
  bank_account             text,
  ap_contact_email         text,
  phone                    text,
  requires_po              boolean NOT NULL DEFAULT false,
  status                   text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('active','pending_review','on_hold')),
  onboarded_at             date,
  onboarded_by             text REFERENCES users,
  approved_by              text REFERENCES users
);

CREATE TABLE vendor_bank_changes (
  change_id            text PRIMARY KEY,
  vendor_id            text NOT NULL REFERENCES vendors,
  requested_at         timestamptz NOT NULL DEFAULT now(),
  requested_by         text REFERENCES users,
  request_channel      text NOT NULL,
  new_institution      text,
  new_transit          text,
  new_account          text NOT NULL,
  verified_by_callback boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approved_by          text REFERENCES users,
  approved_at          timestamptz
);

CREATE TABLE contracts (
  contract_id            text PRIMARY KEY,
  vendor_id              text NOT NULL REFERENCES vendors,
  description            text,
  monthly_fee            numeric(14,2),
  currency               text NOT NULL DEFAULT 'CAD',
  hourly_rate_cap        numeric(14,2),
  fuel_surcharge_cap_pct numeric(6,2),
  not_to_exceed_monthly  numeric(14,2),
  start_date             date,
  end_date               date,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired'))
);

CREATE TABLE purchase_orders (
  po_id             text PRIMARY KEY,
  vendor_id         text NOT NULL REFERENCES vendors,
  department_id     text REFERENCES departments,
  requester_user_id text REFERENCES users,
  issue_date        date,
  description       text,
  total_amount      numeric(14,2) NOT NULL,
  currency          text NOT NULL DEFAULT 'CAD',
  status            text NOT NULL CHECK (status IN ('open','partially_invoiced','closed')),
  approved_by       text REFERENCES users
);

CREATE TABLE raw_items (
  raw_item_id       text PRIMARY KEY,
  organization_id   text NOT NULL REFERENCES organizations,
  kind              text NOT NULL CHECK (kind IN ('email','pdf','form')),
  received_at       timestamptz NOT NULL DEFAULT now(),
  from_name         text,
  from_address      text,
  subject           text,
  body              text,
  files             jsonb NOT NULL DEFAULT '[]',
  form_json         jsonb,
  submitted_by      text REFERENCES users,
  -- new: waiting to be read; failed: reading failed (failure_reason), retried on the next poll
  status            text NOT NULL DEFAULT 'new' CHECK (status IN ('new','extracted','no_invoice','failed')),
  no_invoice_reason text,
  failure_reason    text,
  extracted_by      text REFERENCES users,
  extracted_at      timestamptz,
  source_ref        text,
  UNIQUE (organization_id, source_ref)
);

-- How AP dealt with a raw item that holds no invoice or could not be read (rawItemHandling.service.ts).
-- The raw item is never changed; each handling is a new row and the latest one is the item's state. Append-only.
CREATE TABLE raw_item_handling (
  handling_id          bigserial PRIMARY KEY,
  organization_id      text NOT NULL REFERENCES organizations,
  raw_item_id          text NOT NULL REFERENCES raw_items,
  -- requested: asked the sender to send it again, waiting on them; reviewed: looked at and filed;
  -- answered: replied to the sender; forwarded: sent to the person it is for; dismissed: nothing to do (marketing, spam)
  outcome              text NOT NULL CHECK (outcome IN ('requested','reviewed','answered','forwarded','dismissed')),
  forwarded_to_user_id text REFERENCES users,
  note                 text NOT NULL,
  handled_by           text NOT NULL REFERENCES users,
  handled_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'forwarded') = (forwarded_to_user_id IS NOT NULL))
);
CREATE INDEX raw_item_handling_latest ON raw_item_handling (raw_item_id, handling_id DESC);

CREATE FUNCTION raw_item_handling_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'raw_item_handling is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER raw_item_handling_no_change BEFORE UPDATE OR DELETE ON raw_item_handling
  FOR EACH ROW EXECUTE FUNCTION raw_item_handling_append_only();

CREATE TABLE parsed_invoices (
  parsed_invoice_id   text PRIMARY KEY,
  organization_id     text NOT NULL REFERENCES organizations,
  raw_item_id         text NOT NULL REFERENCES raw_items,
  file_name           text,
  sha256              text,
  extraction_model    text,
  extraction_language text,
  invoice_json        jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by         text REFERENCES users,
  reviewed_at         timestamptz,
  rejection_reason    text,
  invoice_id          text
);

CREATE TABLE invoices (
  invoice_id              text PRIMARY KEY,
  organization_id         text NOT NULL REFERENCES organizations,
  parsed_invoice_id       text REFERENCES parsed_invoices,
  is_historical           boolean NOT NULL DEFAULT false,
  type                    text NOT NULL DEFAULT 'invoice' CHECK (type IN ('invoice','credit_note')),
  status                  text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','approved','scheduled','paid','rejected','void')),
  vendor_id               text REFERENCES vendors,
  vendor_invoice_number   text,
  number_normalized       text,
  invoice_date            date,
  received_date           date,
  due_date                date,
  currency                text NOT NULL DEFAULT 'CAD',
  subtotal                numeric(14,2),
  gst_hst_amount          numeric(14,2) NOT NULL DEFAULT 0,
  pst_qst_amount          numeric(14,2) NOT NULL DEFAULT 0,
  total                   numeric(14,2),
  fx_rate_to_cad          numeric(10,4) NOT NULL DEFAULT 1,
  total_cad               numeric(14,2),
  department_id           text REFERENCES departments,
  requester_user_id       text REFERENCES users,
  po_id                   text REFERENCES purchase_orders,
  contract_id             text REFERENCES contracts,
  bill_to_name            text,
  bill_to_tax_number      text,
  bill_to_address         text,
  ship_to_province        text,
  remit_institution       text,
  remit_transit           text,
  remit_account           text,
  lines                   jsonb NOT NULL DEFAULT '[]',
  duplicate_of_invoice_id text REFERENCES invoices,
  credit_for_invoice_id   text REFERENCES invoices,
  created_by              text REFERENCES users,
  created_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE parsed_invoices ADD FOREIGN KEY (invoice_id) REFERENCES invoices;
CREATE INDEX invoices_vendor_idx ON invoices (organization_id, vendor_id, invoice_date);

CREATE TABLE invoice_flags (
  flag_id              text PRIMARY KEY,
  parsed_invoice_id    text NOT NULL REFERENCES parsed_invoices,
  line_no              integer,
  check_code           text NOT NULL,
  category             text NOT NULL CHECK (category IN ('extraction','vendor','po','contract','tax','math','date','policy','fraud','duplicate')),
  severity             text NOT NULL CHECK (severity IN ('info','warning','blocking')),
  message              text NOT NULL,
  evidence_json        jsonb,
  related_invoice_id   text REFERENCES invoices,
  related_card_txn_ref text,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','overridden')),
  resolved_by          text REFERENCES users,
  resolved_at          timestamptz,
  resolution_note      text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
  approval_id          text PRIMARY KEY,
  invoice_id           text NOT NULL REFERENCES invoices,
  step_no              integer NOT NULL,
  rule_id              text,
  assigned_user_id     text REFERENCES users,
  original_user_id     text REFERENCES users,
  -- over_limit: the invoice is above the assignee's own approval limit, so the step went to their manager
  reassign_reason      text CHECK (reassign_reason IN ('delegate','requester_is_approver','terminated','over_limit')),
  status               text NOT NULL CHECK (status IN ('waiting','pending','approved','rejected')),
  acted_by             text REFERENCES users,
  on_behalf_of_user_id text REFERENCES users,
  comment              text,
  acted_at             timestamptz
);

CREATE TABLE payments (
  payment_id           text PRIMARY KEY,
  organization_id      text NOT NULL REFERENCES organizations,
  invoice_id           text NOT NULL REFERENCES invoices,
  vendor_id            text NOT NULL REFERENCES vendors,
  method               text NOT NULL CHECK (method IN ('EFT','CHEQUE','CARD')),
  scheduled_date       date,
  paid_date            date,
  currency             text NOT NULL,
  amount               numeric(14,2) NOT NULL,
  fx_rate_to_cad       numeric(10,4) NOT NULL DEFAULT 1,
  amount_cad           numeric(14,2) NOT NULL,
  discount_taken       numeric(14,2) NOT NULL DEFAULT 0,
  status               text NOT NULL CHECK (status IN ('scheduled','released','outstanding','settled','failed','cancelled')),
  prepared_by          text REFERENCES users,
  released_by          text REFERENCES users,
  released_at          timestamptz,
  snapshot_institution text,
  snapshot_transit     text,
  snapshot_account     text,
  bank_reference       text,
  card_reference       text,
  -- a cheque's number, given when it is issued; the bank statement reports it when the cheque clears
  cheque_number        integer,
  failure_reason       text,
  -- a scheduled payment stopped before release: who stopped it, when and why
  cancelled_by         text REFERENCES users,
  cancelled_at         timestamptz,
  cancel_reason        text
);

-- What the bank and the card feed report: bank statement lines (EFT payments, cleared cheques, fees) and virtual card charges.
-- A line that settles a payment points to it.
CREATE TABLE statement_lines (
  line_id         text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations,
  source          text NOT NULL CHECK (source IN ('bank','card')),
  posted_date     date NOT NULL,
  description     text NOT NULL,
  -- money out, in CAD
  amount          numeric(14,2) NOT NULL,
  -- what it is, read from the line: an EFT payment (reference: the last 6 digits of the payment's), a cleared cheque (its number),
  -- a virtual card charge (the card), a payment the bank sent back (its method and reference), or anything else, such as a bank fee
  kind            text NOT NULL CHECK (kind IN ('eft','cheque','card','return','other')),
  reference       text,
  payment_id      text REFERENCES payments,
  imported_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  event_id             bigserial PRIMARY KEY,
  organization_id      text REFERENCES organizations,
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  actor_user_id        text REFERENCES users,
  actor_role           text,
  on_behalf_of_user_id text REFERENCES users,
  action               text NOT NULL,
  entity_type          text NOT NULL,
  entity_id            text NOT NULL,
  invoice_id           text,
  payment_id           text,
  vendor_id            text,
  before_json          jsonb,
  after_json           jsonb,
  note                 text,
  -- where the action came from: the website and REST API ("web"), or an employee's agent through MCP ("agent")
  channel              text NOT NULL DEFAULT 'web'
);

-- The audit log is append-only.
CREATE FUNCTION audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_events_no_change BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

-- The one Brim employee who creates organizations.
INSERT INTO users (user_id, full_name, email, title, role)
VALUES ('B001', 'Brim Operations', 'ops@brim.example', 'Brim Employee', 'brim_employee');
