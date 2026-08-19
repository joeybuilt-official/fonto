
# UI Design System

> **Applies when:** the project ships screens a human looks at (web app, desktop app, mobile app, or a styled docs/marketing surface).
> **Delete this file (and its `@` import in `CLAUDE.md`) if:** the project has no user interface — a library, CLI, service, or job runner. Nothing here applies to terminal output.

## Design reference

**This UI should feel like: `Immich (self-hosted photo library) — clean, dense media grids`** — same aesthetic family as `shadcn/ui (base-nova, neutral) + Material Design 3 (ADR 0009)`.

> _Inferred at setup from `components.json` (base-nova / neutral), `adr/0009-material-design-3.md`, and the product (self-hosted photo/document manager) — no design reference was supplied. **Confirm or correct** the reference and the token tables below against the real components._

Name a real product, not adjectives. "Clean and modern" means nothing shared; a named product is a target the model has already seen thousands of screens of, so every unstated decision (border weight, empty-state tone, how a table row highlights) resolves the same way instead of being invented per screen.

## Visual style

Pick one value per axis and hold it everywhere. An inconsistent axis is more noticeable than a "wrong" one.

| Axis | The choice to make | This project |
| --- | --- | --- |
| Chrome weight | flat/hairline borders → soft cards → heavy shadowed surfaces | `soft cards + hairline borders (shadcn neutral; MD3 elevation on surfaces)` |
| Palette strategy | monochrome + one accent → two-tone brand → full multi-hue | `monochrome neutral base + one theme accent; status colors reserved for badges` |
| Density | dense (max info per viewport) → balanced → airy/marketing | `dense media grids, balanced chrome elsewhere` |
| Default text size | small-body UI → standard-body → large/accessible-first | `standard body (text-sm UI default, shadcn)` |
| Hover & motion | near-static, tint-only → light transitions → animated/expressive | `light transitions (tw-animate-css); respect reduced-motion` |

*Worked example (one product's answers — an illustration, not a mandate):* hairline borders and no drop shadows; monochrome with a single accent reserved for links and interactive affordances; dense layout with minimal padding; small body text with an even smaller label size; hover = a faint background tint, never a color jump.

## Layout patterns by page archetype

- **Detail / record page** — the primary pane is whatever the user actually came to see (the timeline, the document, the run log), not a grid of metadata. Metadata, related records, and destructive actions go in a secondary sidebar. A full-width header carries back-navigation, the record's name, and status. Getting this backwards — fields center-stage, real content in a tab — is the single most common design regression.
- **List / index page** — full-width table or list, search plus filters directly above it, one consistent pagination or infinite-scroll mechanism, row click navigates to the detail page, primary "create" action top-right. Do not mix pagination styles across lists.
- **Dashboard** — a scannable summary row on top, detail below; every tile states its time window and links to the filtered list it summarizes. A number with no drill-through is decoration.
- **Form / wizard** — one column, grouped into labelled sections; multi-step only when steps are genuinely sequential, and then show step position and allow going back without data loss.
- **Empty, loading, and error states** — designed, never default. Empty states name what would appear here and offer the action that creates it; loading uses skeletons matching the real layout so nothing jumps; error states say what failed and what to do next. See `error-handling.md`; these three are required for every async surface (see `frontend.md`).

## Component conventions

- **Primitives vs. domain components.** Generic, reusable, product-unaware primitives live in `components/ui` (button, input, select, badge, dialog). Components that know about the product's nouns live in `components`. Mixing them makes primitives unreusable and domain components untestable.
- **Assemble before you invent.** A new component is composed from existing primitives first. Add a new primitive only when no combination expresses it — then add it to `components/ui` so the next person finds it instead of building a third variant.
- **Variants are a closed, named set**, declared on the primitive and reused verbatim (an illustrative set: `default`, `primary`, `success`, `warning`, `destructive`, `info`). Never style a one-off by overriding a primitive's internals from the call site — that override becomes the fourth unofficial variant.
- **Presentation never encodes a business rule.** A badge's variant map — which status renders as destructive — is presentation and belongs here. *What makes a record "at risk"* is a domain rule and does not (see `clean-architecture.md`). A component that decides eligibility has made that rule unavailable to every other surface, and the two will disagree.
- **One icon library and one icon size.** Use `lucide-react` at `size-4 (16px)` everywhere; deviate only for a deliberate hero/empty-state graphic. Mixed icon sets and drifting sizes read as broken before anyone can say why.
- Styling goes through `Tailwind CSS 4 (+ shadcn/ui, cva, tailwind-merge)`. Do not introduce a second styling mechanism alongside it.

## Typography & spacing scale

Fill each row from the project's own tokens, then treat the table as the vocabulary — no ad-hoc sizes at call sites.

| Role | This project | Worked example (illustration only) |
| --- | --- | --- |
| Section header | `text-sm font-semibold text-muted-foreground` | small, semibold, muted, uppercase with slight letter-spacing |
| Field label | `text-xs text-muted-foreground` | one step below body, muted foreground |
| Field value | `text-sm text-foreground` | body size, full-contrast foreground |
| Section padding | `p-4 (~16px)` | one padding step (~16px) on every panel |
| Element gap | `gap-3 / gap-4 (~12-16px)` | one vertical rhythm step (~12–16px) between stacked elements |
| Borders | `border-border token; lower-opacity border for row dividers` | 1px solid border token; a lower-opacity variant for row dividers |

Two sizes of the same thing is a bug: if a screen needs a size not in this table, extend the table rather than hardcoding a value.

## Forms

- **Labels above inputs**, never beside. Left-aligned labels break at narrow widths and force a second layout.
- **Pair related fields in a two-column grid** (first/last name, start/end date) so the form reads as groups; keep single-column for anything long or free-text.
- **Progressive disclosure driven by earlier answers** — fields that only apply to a chosen type appear after that choice. Do not render disabled fields that may never apply; disabled controls read as broken.
- **Button placement is consistent across every form in the app**: primary submit and its cancel neighbour in the same position and order everywhere. Pick one and never vary it per screen.
- **Errors are inline, adjacent to the offending field**, in the small destructive-text style, and the field itself gains an error border. A form-level banner is for submission failures only, not field validation.
- Preserve entered data on failed submission. Re-typing a form because the server rejected one field is the fastest way to lose a user.

## Consistency check

Run this against any new or changed screen before calling it done:

1. Does it match `Immich (self-hosted photo library) — clean, dense media grids`, or did it drift toward a different product's look?
2. Every visual-style axis above matches the rest of the app (chrome, palette, density, text size, hover).
3. It follows its page archetype's layout — and on a detail page, the primary pane holds real content, not metadata.
4. Loading, empty, and error states all exist and were actually viewed, not assumed.
5. No new primitive that an existing one could have covered; no primitive overridden from a call site.
6. All icons from one library at the standard size.
7. Every size, spacing, and border value comes from the scale table — no ad-hoc values.
8. Forms: labels above, consistent button placement, inline field errors, input preserved on failure.
9. Keyboard and focus behavior verified per `frontend.md` — the design is not done if it is mouse-only.

