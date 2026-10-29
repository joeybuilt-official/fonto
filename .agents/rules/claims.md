<!-- MODULE:claims — KEEP IF the project ships user-visible text (a UI, a site, marketing pages, email, or generated copy). DELETE otherwise. -->

# Claims: Evidence Before Assertion

> **Applies when:** the project ships text a human reads as fact — a landing or marketing page, product copy, a pricing table, a docs site, an email, or model-generated prose.
> **Delete this file (and its `@` import in the generated agent hub) if:** nothing in the project asserts anything to a reader — a pure library, a CLI, or a batch job with no user-facing surface. Nothing here applies to terminal output or a log line.

## The rule

**Anything presented as fact is real and traceable, or it is not shown.** A statistic, a benchmark, a
testimonial, a customer logo, a count of users or records, an uptime or latency figure, a security,
privacy, compliance, or availability claim: each one is either backed by a source this project owns, or
it is deleted. There is no third option, and "illustrative" is not one — a figure a reader cannot tell
from a real one is a false statement wearing a design.

This is the same prohibition `.agents/rules/spec.md` applies to a fabricated expert and
`wireframe-first.md` applies to Lorem Ipsum, carried to the surface the reader actually sees. The kit
forbids inventing the answer in a spec; it forbids inventing the proof on the page.

## What this bans, concretely

These are the shapes that arrive by default, because a plausible number is easier than a real one and
no reviewer can tell the difference from the diff:

- **Invented metrics.** "10x faster", "0.0001ms latency", "10,000+ teams", "99.99% uptime", "3x your
  revenue" — anything with a number that came from nowhere. If the number is real, it has a source in
  the repo, a dashboard, or a cited record; name it in a comment or a doc next to the string.
- **Fake product decoration.** A terminal window reporting a made-up build time, a dashboard of
  invented usage, a live counter that counts nothing, a fake log stream, a "NEXT-GEN AI beta" pill, a
  sparkle glyph standing in for a logo. A mock is honest only when it is labelled a mock **on the
  surface the reader sees** — a grey skeleton block, not a plausible screenshot of data that does not
  exist.
- **Fabricated social proof.** Invented testimonials, invented customer names, an unattributed quoted
  reviewer, a logo wall of companies that are not customers, a star rating with no reviews behind it.
  A testimonial is only real when a real person said it and agreed to be named.
- **Unverifiable capability claims.** Security, privacy, encryption, compliance, retention, and
  availability claims the system does not enforce. "SOC 2 compliant" is a fact about an audit, not an
  aspiration; a badge is a claim.
- **Pricing and feature claims that drift.** A plan that advertises a capability the product does not
  ship, a limit higher than the enforced one. The claim and the behavior are one fact in two places;
  when the behavior changes, the claim changes in the same change.
- **Sample data presented as real.** Seeded, mocked, or generated rows on a user-facing surface must
  be labelled as sample data. A demo screen that reads like production is how a fabricated statistic
  gets a screenshot.

## Model-generated copy is subject to the same rule

Copy, summaries, and enrichment written by a model are drafts, not evidence. Never render model output
into a surface that reads as fact — a summary, a rating, a metric, a badge — without a provenance
record and a way to correct it. See `ai-features.md`: persist the model and prompt version, keep the
input reference, and let a human override it.

## Placeholders are how you fill the gap

Where real content does not exist yet, the answer is a placeholder, never a plausible invention: a
grey bar in a wireframe (`wireframe-first.md`), a `TODO` naming what is missing, or a
`[NEEDS CLARIFICATION: …]` in a draft spec (`spec.md`). An invented value in a shipped string is the
one form of placeholder that reaches the reader as truth.

## The honest limit

**No mechanical gate can detect an invented statistic.** `10,000+ teams` is well-formed, plausible, and
indistinguishable from a real number by any script that does not already know the truth — so this rule
is a review question, and the kit says so instead of shipping a gate that would only measure the easy
half. Ask it in the expert-review step (`.agents/rules/workflow.md` → Expert Review) and at the launch
record (`scripts/check-launch.sh`): *which of these claims would survive a reader asking "says who?"*
A gate that passes while a claim went unexamined would be worse than no gate, because it would read as
coverage.

## Applies to

- Marketing and landing copy, pricing tables, comparison pages.
- In-product copy: empty states, upgrade prompts, paywalls, badges, tooltips.
- Testimonials, logo walls, review widgets, case studies.
- Docs that make a security, performance, or availability claim.
- Seed and demo data on any surface a reader can reach.
- Any string a model generated and a human did not verify.
