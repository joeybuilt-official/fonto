# UI Design System

> Applies to Fonto web and Flutter surfaces. Web values below are verified from `app/globals.css`, `lib/design-tokens.ts`, `components.json`, and sampled components.

## Reference and visual language

**External design reference:** none. Follow Fonto's existing Material Design 3 token system.

| Axis | Fonto choice |
| --- | --- |
| Chrome weight | Outlined cards with hairline `border border-border`; use token elevation selectively. |
| Palette | Teal primary with semantic secondary, tertiary, error, and success roles. |
| Density | Balanced overall, denser library grids and toolbar controls. |
| Default text | `text-sm` / 14px body UI. |
| Motion | Light transitions; respect reduced-motion preferences. |

## Component boundaries

- Generic primitives live in `components/ui/`; product-aware components live in `app/(app)/app/_components/` and `components/`.
- Compose existing primitives before adding one. Variants belong on the primitive, not as call-site overrides.
- Presentation maps known states to styles; it does not decide business eligibility or permissions.
- Use `lucide-react` with `h-4 w-4` as the default icon size. Larger media or empty-state icons are deliberate exceptions.
- Style through Tailwind CSS 4 and the `--ft-*` variables in `app/globals.css`.

## Typography and spacing vocabulary

| Role | Fonto value |
| --- | --- |
| Section header | `text-sm font-semibold text-foreground` |
| Field label | `text-xs font-medium text-muted-foreground` |
| Field value | `text-sm text-foreground` |
| Section padding | `p-4` |
| Element gap | `gap-3` / `space-y-3` |
| Borders | `border border-border` or the matching `--ft-color-outline-variant` token |

Use the existing `--ft-*` shape, color, type, space, and elevation tokens before adding a literal.

## Page and form patterns

- Detail pages keep the asset/document as the primary pane and metadata/actions secondary.
- Lists place search and filters above one consistent list/paging mechanism.
- Empty states explain what belongs there and offer the next useful action; skeletons match final layout.
- Labels sit above inputs. Pair only genuinely related short fields.
- Keep primary/cancel placement consistent and preserve entered data on failed submission.
- Put validation errors beside the field; reserve banners for submission failures.

## Consistency check

Before calling a UI change done: check the token system, loading/empty/error states, keyboard/focus behavior, icon size, responsive layout at narrow and wide widths, and reduced-motion behavior.
