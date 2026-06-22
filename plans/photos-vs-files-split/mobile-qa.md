# Mobile QA — Photos vs Files split

Manual QA for the Flutter app (`mobile/`). Run on a device/emulator built from a
`v2.0.363`+ APK, against an env where `LIBRARY_SURFACE_SPLIT_ENABLED` is ON.
(With the flag OFF the Library must look/behave exactly as before — that is QA
step 0.)

Web parity reference: each step has an equivalent in `e2e/audit/12-library-files.spec.ts`.

## 0. Flag OFF (regression guard)
- [ ] Flag OFF → Library shows the old flat lens row (Moments/Screenshots/Graphics/Documents/Videos/All). No segmented control, no Inbox banner. Grid, timeline scrubber, "On this device" strip all unchanged.

## 1. Surface segmented control (flag ON)
- [ ] Library opens on **Photos** by default (first launch).
- [ ] Segmented control shows **Photos | Files**; Photos selected.
- [ ] Photos lens chips = All / Moments / Videos only.
- [ ] "On this device" strip renders on Photos (above the server grid).
- [ ] Tapping a Photos tile opens the immersive viewer (unchanged).

## 2. Files surface
- [ ] Tap **Files** → search bar pins to top; lens chips become All / Screenshots / Graphics / Documents.
- [ ] No "On this device" strip on Files.
- [ ] Rows are a LIST: type icon + filename + snippet (OCR/source) + imported date, newest-imported first.
- [ ] Recency bands "This week" / "Earlier" appear as section headers.
- [ ] Type in the search box → results filter (server-side: filename + OCR text + source). Clearing restores the full list.
- [ ] Lens chip Screenshots/Graphics/Documents narrows the list to that KIND; All shows the union.
- [ ] Tap a row → Properties bottom sheet: preview (for images), Type, Format, Size, Imported, Captured (if any), Source, and an expandable Extracted text block when OCR exists.

## 3. Inbox
- [ ] When unclassified assets exist, an **Inbox** banner shows above the segmented control with an "N pending" badge.
- [ ] Tap it → Inbox surface (grid of NULL-kind assets); banner shows "Done" to leave.
- [ ] Banner is ABSENT when there are no unclassified assets.

## 4. Persistence + state
- [ ] Switch to Files, background/kill the app, relaunch → opens on Files (last-used surface persisted). (Inbox is NOT persisted — relaunch from Inbox returns to the last real surface.)
- [ ] Switching surface resets the lens to "All".

## 5. Offline / edge
- [ ] Photos surface still falls back to the cached grid + device strip when offline (unchanged).
- [ ] Files surface offline → shows a load error with Retry (Files is network-first in v1; no offline cache).

## Viewports
Run the above at a phone width (~390px). Capture screenshots of: Photos, Files, Files+search, Files properties sheet, Inbox (or banner).
