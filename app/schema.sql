-- elec-board schema (SQLite). Applied once when PRAGMA user_version = 0.
-- Every business table carries org_id; every query in app/ is scoped by it.

CREATE TABLE organizations (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  rev         INTEGER NOT NULL DEFAULT 0,      -- bumps on every write; clients poll it
  created_at  TEXT NOT NULL
);

CREATE TABLE users (
  id             INTEGER PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- One membership per user. roles = comma list of admin / worker / reviewer.
-- board_slot 1..4 = the user's column on the magnet board.
CREATE TABLE memberships (
  id              INTEGER PRIMARY KEY,
  org_id          INTEGER NOT NULL REFERENCES organizations(id),
  user_id         INTEGER NOT NULL UNIQUE REFERENCES users(id),
  roles           TEXT NOT NULL,
  board_slot      INTEGER CHECK (board_slot BETWEEN 1 AND 4),
  initials        TEXT NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  deactivated_at  TEXT
);
CREATE UNIQUE INDEX ux_memberships_slot ON memberships(org_id, board_slot)
  WHERE board_slot IS NOT NULL AND active = 1;

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  csrf        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE TABLE invitations (
  id           INTEGER PRIMARY KEY,
  org_id       INTEGER NOT NULL REFERENCES organizations(id),
  email        TEXT NOT NULL COLLATE NOCASE,
  name         TEXT NOT NULL,
  roles        TEXT NOT NULL,
  board_slot   INTEGER CHECK (board_slot BETWEEN 1 AND 4),
  token_hash   TEXT NOT NULL UNIQUE,
  invited_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  accepted_at  TEXT,
  revoked_at   TEXT
);

-- 현장. Identified by a name/code rather than a street address.
CREATE TABLE sites (
  id               INTEGER PRIMARY KEY,
  org_id           INTEGER NOT NULL REFERENCES organizations(id),
  name             TEXT NOT NULL,
  code             TEXT NOT NULL DEFAULT '',
  description      TEXT NOT NULL DEFAULT '',
  retention_years  INTEGER NOT NULL DEFAULT 4 CHECK (retention_years BETWEEN 1 AND 50),
  archived         INTEGER NOT NULL DEFAULT 0,
  created_by       INTEGER NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL
);

CREATE TABLE site_members (
  site_id  INTEGER NOT NULL REFERENCES sites(id),
  user_id  INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (site_id, user_id)
);

-- Inspection templates are immutable; a revision is a new row (version + 1).
CREATE TABLE inspection_templates (
  id          INTEGER PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES organizations(id),
  name        TEXT NOT NULL,
  asset_type  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  items_json  TEXT NOT NULL,                  -- [{key, label, section}]
  is_sample   INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL
);

CREATE TABLE assets (
  id                        INTEGER PRIMARY KEY,
  org_id                    INTEGER NOT NULL REFERENCES organizations(id),
  site_id                   INTEGER NOT NULL REFERENCES sites(id),
  name                      TEXT NOT NULL,
  asset_type                TEXT NOT NULL,
  location                  TEXT NOT NULL DEFAULT '',
  template_id               INTEGER REFERENCES inspection_templates(id),
  public_token              TEXT NOT NULL UNIQUE,   -- random, printed in the QR
  installed_on              TEXT,                   -- YYYY-MM-DD
  service_life_years        INTEGER,                -- 내용연수
  inspection_interval_days  INTEGER,
  archived                  INTEGER NOT NULL DEFAULT 0,
  created_at                TEXT NOT NULL
);

CREATE TABLE tasks (
  id                   INTEGER PRIMARY KEY,
  org_id               INTEGER NOT NULL REFERENCES organizations(id),
  site_id              INTEGER NOT NULL REFERENCES sites(id),
  title                TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  kind                 TEXT NOT NULL DEFAULT 'general'
                         CHECK (kind IN ('general', 'inspection', 'finding')),
  asset_id             INTEGER REFERENCES assets(id),
  primary_assignee_id  INTEGER NOT NULL REFERENCES users(id),
  status               TEXT NOT NULL
                         CHECK (status IN ('scheduled', 'in_progress', 'review', 'done')),
  priority             TEXT NOT NULL DEFAULT 'normal'
                         CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_date             TEXT,
  completed_at         TEXT,
  version              INTEGER NOT NULL DEFAULT 1,
  created_by           INTEGER NOT NULL REFERENCES users(id),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX ix_tasks_org ON tasks(org_id, status, primary_assignee_id);
CREATE INDEX ix_tasks_site ON tasks(site_id);

-- Collaborators never decide the board column; only primary_assignee_id does.
CREATE TABLE task_collaborators (
  task_id  INTEGER NOT NULL REFERENCES tasks(id),
  user_id  INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE task_check_items (
  id        INTEGER PRIMARY KEY,
  task_id   INTEGER NOT NULL REFERENCES tasks(id),
  label     TEXT NOT NULL,
  done      INTEGER NOT NULL DEFAULT 0,
  position  INTEGER NOT NULL,
  done_by   INTEGER REFERENCES users(id),
  done_at   TEXT
);

CREATE TABLE task_events (
  id          INTEGER PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES organizations(id),
  task_id     INTEGER NOT NULL REFERENCES tasks(id),
  actor_id    INTEGER NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL,       -- created / assignee / status / edited / check_item / collaborators
  from_value  TEXT,
  to_value    TEXT,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_task_events_task ON task_events(task_id);

CREATE TABLE attachments (
  id            INTEGER PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(id),
  owner_type    TEXT NOT NULL CHECK (owner_type IN
                  ('inspection', 'inspection_item', 'signature', 'report', 'finding', 'task', 'site')),
  owner_id      INTEGER NOT NULL,
  item_key      TEXT,
  client_id     TEXT UNIQUE,          -- idempotency key from the device queue
  filename      TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  uploaded_by   INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX ix_attachments_owner ON attachments(owner_type, owner_id);

CREATE TABLE inspections (
  id                       INTEGER PRIMARY KEY,
  org_id                   INTEGER NOT NULL REFERENCES organizations(id),
  site_id                  INTEGER NOT NULL REFERENCES sites(id),
  asset_id                 INTEGER NOT NULL REFERENCES assets(id),
  template_id              INTEGER NOT NULL REFERENCES inspection_templates(id),
  task_id                  INTEGER REFERENCES tasks(id),
  client_id                TEXT NOT NULL UNIQUE,
  inspector_id             INTEGER NOT NULL REFERENCES users(id),
  status                   TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'submitted', 'rejected', 'reviewed', 'approved')),
  corrects_id              INTEGER REFERENCES inspections(id),
  draft_version            INTEGER NOT NULL DEFAULT 1,
  gps_lat                  REAL,
  gps_lng                  REAL,
  gps_accuracy             REAL,
  signer_name              TEXT,
  signature_attachment_id  INTEGER REFERENCES attachments(id),
  summary_note             TEXT NOT NULL DEFAULT '',
  submit_key               TEXT UNIQUE,
  submitted_at             TEXT,
  content_hash             TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX ix_inspections_org ON inspections(org_id, status);

CREATE TABLE inspection_items (
  id             INTEGER PRIMARY KEY,
  inspection_id  INTEGER NOT NULL REFERENCES inspections(id),
  item_key       TEXT NOT NULL,
  section        TEXT NOT NULL DEFAULT '',
  label          TEXT NOT NULL,
  position       INTEGER NOT NULL,
  result         TEXT CHECK (result IN ('good', 'bad', 'na')),
  memo           TEXT NOT NULL DEFAULT '',
  gps_lat        REAL,
  gps_lng        REAL,
  UNIQUE (inspection_id, item_key)
);

-- Append-only review trail.
CREATE TABLE inspection_reviews (
  id                 INTEGER PRIMARY KEY,
  inspection_id      INTEGER NOT NULL REFERENCES inspections(id),
  reviewer_id        INTEGER NOT NULL REFERENCES users(id),
  decision           TEXT NOT NULL CHECK (decision IN ('reviewed', 'rejected')),
  comment            TEXT NOT NULL DEFAULT '',
  item_comments_json TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL
);

CREATE TABLE findings (
  id               INTEGER PRIMARY KEY,
  org_id           INTEGER NOT NULL REFERENCES organizations(id),
  site_id          INTEGER NOT NULL REFERENCES sites(id),
  inspection_id    INTEGER NOT NULL REFERENCES inspections(id),
  item_key         TEXT NOT NULL,
  description      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  assignee_id      INTEGER NOT NULL REFERENCES users(id),
  due_date         TEXT,
  task_id          INTEGER REFERENCES tasks(id),
  resolution_note  TEXT,
  resolved_by      INTEGER REFERENCES users(id),
  resolved_at      TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE reports (
  id                 INTEGER PRIMARY KEY,
  org_id             INTEGER NOT NULL REFERENCES organizations(id),
  inspection_id      INTEGER NOT NULL REFERENCES inspections(id),
  version            INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by       INTEGER NOT NULL REFERENCES users(id),
  requested_at       TEXT NOT NULL,
  decided_by         INTEGER REFERENCES users(id),
  decided_at         TEXT,
  decision_comment   TEXT NOT NULL DEFAULT '',
  pdf_attachment_id  INTEGER REFERENCES attachments(id),
  content_hash       TEXT NOT NULL,
  UNIQUE (inspection_id, version)
);

CREATE TABLE kpi_definitions (
  id                 INTEGER PRIMARY KEY,
  org_id             INTEGER NOT NULL REFERENCES organizations(id),
  key                TEXT NOT NULL,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL,
  numerator_label    TEXT NOT NULL,
  denominator_label  TEXT NOT NULL,
  unit               TEXT NOT NULL DEFAULT '%',
  good_direction     TEXT NOT NULL DEFAULT 'up' CHECK (good_direction IN ('up', 'down')),
  target             REAL NOT NULL,
  weight             REAL NOT NULL,
  position           INTEGER NOT NULL,
  UNIQUE (org_id, key)
);

-- Frozen KPI results for a closed period (evaluation record).
CREATE TABLE kpi_snapshots (
  id            INTEGER PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES organizations(id),
  scope         TEXT NOT NULL CHECK (scope IN ('team', 'user')),
  user_id       INTEGER REFERENCES users(id),
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL
);

-- Links + short summaries only. Full legal texts are never copied here.
CREATE TABLE knowledge_items (
  id             INTEGER PRIMARY KEY,
  org_id         INTEGER NOT NULL REFERENCES organizations(id),
  title          TEXT NOT NULL,
  category       TEXT NOT NULL CHECK (category IN ('law', 'kec', 'ks', 'inspection', 'education')),
  summary        TEXT NOT NULL DEFAULT '',
  keywords       TEXT NOT NULL DEFAULT '',     -- comma separated
  standard_no    TEXT NOT NULL DEFAULT '',
  source_name    TEXT NOT NULL,
  source_url     TEXT NOT NULL,
  verified_at    TEXT NOT NULL,                -- YYYY-MM-DD
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  review_due_at  TEXT NOT NULL,                -- YYYY-MM-DD; past = stale
  updated_by     INTEGER REFERENCES users(id),
  updated_at     TEXT NOT NULL
);

CREATE TABLE knowledge_views (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  item_id    INTEGER NOT NULL REFERENCES knowledge_items(id),
  viewed_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

-- Hash-chained audit trail (per organization).
CREATE TABLE audit_logs (
  id           INTEGER PRIMARY KEY,
  org_id       INTEGER NOT NULL REFERENCES organizations(id),
  actor_id     INTEGER REFERENCES users(id),
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    INTEGER,
  detail_json  TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);
CREATE INDEX ix_audit_org ON audit_logs(org_id, id);

-- ---------------------------------------------------------------------------
-- Integrity guards: submitted inspection records are append-only.
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_inspections_freeze
BEFORE UPDATE OF org_id, site_id, asset_id, template_id, task_id, client_id, inspector_id,
                 corrects_id, draft_version, gps_lat, gps_lng, gps_accuracy, signer_name,
                 signature_attachment_id, summary_note, submit_key, submitted_at, content_hash,
                 created_at
ON inspections
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'submitted inspection is immutable');
END;

CREATE TRIGGER trg_inspections_no_reopen
BEFORE UPDATE OF status ON inspections
WHEN OLD.status <> 'draft' AND NEW.status = 'draft'
BEGIN
  SELECT RAISE(ABORT, 'submitted inspection cannot return to draft');
END;

CREATE TRIGGER trg_inspections_no_delete
BEFORE DELETE ON inspections
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'submitted inspection cannot be deleted');
END;

CREATE TRIGGER trg_inspection_items_freeze
BEFORE UPDATE ON inspection_items
WHEN (SELECT status FROM inspections WHERE id = OLD.inspection_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'submitted inspection is immutable');
END;

CREATE TRIGGER trg_inspection_items_no_insert
BEFORE INSERT ON inspection_items
WHEN (SELECT status FROM inspections WHERE id = NEW.inspection_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'submitted inspection is immutable');
END;

CREATE TRIGGER trg_inspection_items_no_delete
BEFORE DELETE ON inspection_items
WHEN (SELECT status FROM inspections WHERE id = OLD.inspection_id) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'submitted inspection is immutable');
END;

CREATE TRIGGER trg_inspection_reviews_no_update
BEFORE UPDATE ON inspection_reviews
BEGIN
  SELECT RAISE(ABORT, 'inspection reviews are append-only');
END;

CREATE TRIGGER trg_inspection_reviews_no_delete
BEFORE DELETE ON inspection_reviews
BEGIN
  SELECT RAISE(ABORT, 'inspection reviews are append-only');
END;

CREATE TRIGGER trg_attachments_no_update
BEFORE UPDATE ON attachments
BEGIN
  SELECT RAISE(ABORT, 'attachments are immutable');
END;

CREATE TRIGGER trg_attachments_evidence_no_delete
BEFORE DELETE ON attachments
WHEN OLD.owner_type IN ('report', 'finding', 'task', 'site')
  OR (OLD.owner_type IN ('inspection', 'inspection_item', 'signature')
      AND (SELECT status FROM inspections WHERE id = OLD.owner_id) <> 'draft')
BEGIN
  SELECT RAISE(ABORT, 'evidence attachments cannot be deleted');
END;

CREATE TRIGGER trg_reports_no_delete
BEFORE DELETE ON reports
BEGIN
  SELECT RAISE(ABORT, 'reports cannot be deleted');
END;

CREATE TRIGGER trg_reports_freeze_decided
BEFORE UPDATE ON reports
WHEN OLD.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'decided report is immutable');
END;

CREATE TRIGGER trg_audit_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;

CREATE TRIGGER trg_audit_no_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit log is append-only');
END;

CREATE TRIGGER trg_task_events_no_update
BEFORE UPDATE ON task_events
BEGIN
  SELECT RAISE(ABORT, 'task events are append-only');
END;

CREATE TRIGGER trg_task_events_no_delete
BEFORE DELETE ON task_events
BEGIN
  SELECT RAISE(ABORT, 'task events are append-only');
END;
