-- SPDX-License-Identifier: AGPL-3.0-only
-- Migration 0036 — person groups + members
--
-- Adds a many-to-many relationship between persons and group labels
-- (Family, Friends, Colleagues, Acquaintances, Me + user-defined).
-- workspace_id = NULL on built-in groups so they appear for every workspace.

CREATE TABLE fonto.person_groups (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid,                                        -- NULL = built-in
  name         text        NOT NULL,
  color        text        NOT NULL DEFAULT '#6b7280',
  sort_order   smallint    NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_person_groups_ws_name UNIQUE (workspace_id, name)
);

INSERT INTO fonto.person_groups (id, workspace_id, name, color, sort_order) VALUES
  (gen_random_uuid(), NULL, 'Family',        '#0d9488', 10),
  (gen_random_uuid(), NULL, 'Friends',       '#7c3aed', 20),
  (gen_random_uuid(), NULL, 'Colleagues',    '#d97706', 30),
  (gen_random_uuid(), NULL, 'Acquaintances', '#475569', 40),
  (gen_random_uuid(), NULL, 'Me',            '#db2777', 50);

CREATE TABLE fonto.person_group_members (
  person_id uuid NOT NULL,
  group_id  uuid NOT NULL,
  PRIMARY KEY (person_id, group_id),
  CONSTRAINT fk_pgm_person FOREIGN KEY (person_id)
    REFERENCES fonto.persons(id) ON DELETE CASCADE,
  CONSTRAINT fk_pgm_group FOREIGN KEY (group_id)
    REFERENCES fonto.person_groups(id) ON DELETE CASCADE
);

CREATE INDEX idx_pgm_group_id  ON fonto.person_group_members(group_id);
CREATE INDEX idx_pgm_person_id ON fonto.person_group_members(person_id);
