-- Phase (faces/UX) — photo-level face ignore.
-- When a user marks a photo "no faces here", we skip face detection for it
-- and hide its existing faces from the People view. Additive + default false
-- so existing rows are unaffected.
ALTER TABLE "fonto"."assets"
  ADD COLUMN IF NOT EXISTS "faces_ignored" boolean NOT NULL DEFAULT false;
