#!/usr/bin/env sh
# check-comments.sh — a change may not ADD a slop comment to the codebase.
#
# WHY THIS EXISTS
#   A comment is the one part of a diff nobody reviews against a standard, so it is where the tells
#   collect: a banner wrapped in punctuation, an emoji section marker, "Step 1:" narrating control
#   flow that is already visible, "end if" marking a brace, and a label that names a category
#   instead of a fact. None of these are formatting preferences — each one is decoration occupying
#   the place where the reason the code exists should be. The code-style module states the doctrine
#   (`.agents/rules/code-style.md` -> Comments); this gate is the half of it that a script can see.
#
#   It is CHANGE-SCOPED on purpose. The rule was adopted long after this tree was written, and the
#   tree carries pre-existing banner comments; grading the whole tree would red every PR for debt
#   that predates the rule and teach people to avoid touching those files. Grade only the lines THIS
#   change adds. `--tree` exists to MEASURE that pre-existing debt, not to fail it.
#
# USAGE
#   sh scripts/check-comments.sh                 # change-scoped: vs origin/<base>, else HEAD~1
#   sh scripts/check-comments.sh --since SHA     # explicit base (CI passes the PR base SHA)
#   sh scripts/check-comments.sh --staged        # the index (pre-commit context)
#   sh scripts/check-comments.sh --tree          # audit every tracked text file (reports history)
#   COMMENTS_OFF=1                               # deliberate exception (say so out loud)
#
# WHAT IT CANNOT DO — read this before trusting a green run
#   It cannot judge whether a comment is WORTH keeping. A comment restating the line below it is the
#   most common slop of all, and no pattern catches it without false positives on honest prose, so
#   that one stays a review question. Nor does it see a trailing `#` or `--` comment (only a trailing
#   `//`, guarded against a URL), a comment inside a quoted string, or a `*`-continuation line
#   outside a `/* ... */` block. Narration means the `Step N` and ordinal-word forms: a numbered list
#   inside an explanatory comment is prose, and flagging it would red this kit's own gate headers.
#   An all-caps label is reported as a NOTE and never fails the gate, because TODO/FIXME and acronyms
#   share its shape; a multi-word all-caps heading is prose, so only a single token counts. Those
#   limits are stated in the refusal text and here, rather than papered over.
#
#   Documentation files (`*.md`, `*.rst`, `*.txt`, ...) are NOT scanned: a rule module, a plan, or a
#   changelog quoting `// ===== Auth =====` is discussing the convention, not using it. Matching a
#   convention's own documentation is the failure mode every pattern gate in this kit has had to fix
#   once, so the docs exemption and `SELF_EXCLUDE` are both asserted by the canary.
#
# Exit 0 clean, 1 on a finding, 2 when it cannot determine an answer.
set -u

if [ "${COMMENTS_OFF:-0}" = "1" ]; then
  echo "check-comments: disabled (COMMENTS_OFF=1)"
  exit 0
fi

# Byte-oriented matching. The emoji and box-drawing tests below are built from raw byte prefixes, so
# the locale must not reinterpret them as characters.
LC_ALL=C
export LC_ALL

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

# This gate's own sources and the module that documents the convention. The refusal text and the
# canary both quote the banned shapes verbatim; a pattern gate that flags its own documentation
# reports a correct repo as broken. Kept as one list, consulted once.
SELF_EXCLUDE=" scripts/check-comments.sh scripts/check-comments.test.sh .agents/rules/code-style.md "
DOC_RE='\.(md|markdown|mdx|rst|txt|adoc)$'
BIN_RE='\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|woff2?|ttf|otf|eot|mp[34]|mov|webm|wasm|so|dylib|dll|exe|bin)$'

MODE="git"
SINCE=""
BASE=""
case "${1:-}" in
  --tree)   MODE="tree" ;;
  --staged) MODE="staged" ;;
  --since)
    MODE="since"
    SINCE="${2:-}"
    if [ -z "$SINCE" ]; then
      echo "check-comments: --since needs a base ref — set COMMENTS_OFF=1 for a deliberate skip." >&2
      exit 2
    fi
    ;;
  "") ;;
  *) echo "check-comments: unknown argument '$1'" >&2; exit 2 ;;
esac

# The emoji byte prefixes we can NAME. A byte-prefix test is locale-independent and needs no PCRE,
# which POSIX grep does not have. The ranges are the emoji blocks: U+1F000-1FAFF (F0 9F xx xx),
# U+2600-27BF (E2 98..9E), U+2B00-2BFF (E2 AC..AF), plus the U+FE0F variation selector. Typography
# (E2 80-84: curly quotes, dashes), arrows (E2 86-87) and math (E2 88-8B) are deliberately absent —
# they are not emoji, and flagging them would turn this into an ASCII-only lint by accident.
EMOJI_PREFIXES=""
for _oct in '\360\237' '\342\230' '\342\231' '\342\232' '\342\233' '\342\234' '\342\235' '\342\236' \
            '\342\254' '\342\255' '\342\256' '\342\257' '\357\270\217'; do
  EMOJI_PREFIXES="$EMOJI_PREFIXES $(printf '%b' "$_oct")"
done
# Box-drawing bytes: U+2500 (─), U+2501 (━), U+2550 (═). A banner drawn with these is the same
# decoration as one drawn with `=`, and it is invisible to a grep for punctuation.
BOX_PREFIXES=" $(printf '\342\224\200') $(printf '\342\224\201') $(printf '\342\225\220') "

_has_byte_prefix() {
  _hay="$1"
  _list="$2"
  for _p in $_list; do
    case "$_hay" in
      *"$_p"*) return 0 ;;
    esac
  done
  return 1
}

# Labels that are legitimately all-caps in a comment. Kept short and stated: an unknown all-caps
# label is a NOTE, never a failure, because TODO/FIXME and acronyms share the shape.
CAPS_ALLOW='^(TODO|FIXME|HACK|XXX|NOTE|WIP|TBD|API|SQL|HTTP|HTTPS|URL|URI|JSON|XML|HTML|CSS|YAML|TOML|CLI|UUID|GUID|ID|DB|OS|CPU|GPU|RAM|TTL|SHA|PR|CI|CD|ENV|UI|UX|AI|LLM|MCP|RPC|REST|GRPC|DNS|SSL|TLS|TCP|UDP|IP|AWS|GCP|SDK|JWT|CORS|CRUD|EOF|STDIN|STDOUT|STDERR|UTF8|ASCII)([[:space:]:.,-].*)?$'

SCAN="$(mktemp)" || exit 2
trap 'rm -f "$SCAN"' EXIT INT TERM

FINDINGS=""
NOTES=""
FINDING_N=0
NOTE_N=0
COMMENT_N=0
FILE_N=0

# Emits "<lineno> <body>" for each selected line that is a comment, with the marker stripped.
# `want` is a comma-separated set of added line numbers, or ALL in --tree mode. The block-comment
# state is tracked per file so a ` * ` continuation line is read as a comment without treating a
# multiplication or a dereference as one.
_scan_file() {
  _file="$1"
  _want="$2"
  awk -v want="$_want" '
    BEGIN {
      n = split(want, w, ",")
      for (i = 1; i <= n; i++) if (w[i] != "") W[w[i] + 0] = 1
      allmode = (want == "ALL")
      inblk = 0
    }
    {
      line = $0
      t = line
      sub(/^[ \t]+/, "", t)
      sel = (allmode || (NR in W))
      iscmt = 0
      body = ""
      if (inblk) { iscmt = 1; body = line }
      else if (t ~ /^\/\// || t ~ /^\/\*/) { iscmt = 1; body = t }
      else if (t ~ /^#/) {
        # A shebang, an attribute (Rust/C#, `#[...]`), and a C preprocessor directive are not comments.
        if (t !~ /^#!/ && t !~ /^#\[/ && t !~ /^#(include|define|if|ifdef|ifndef|else|elif|endif|undef|pragma|error|line)([^A-Za-z_]|$)/) { iscmt = 1; body = t }
      }
      else if (t ~ /^--/ || t ~ /^;/) { iscmt = 1; body = t }
      if (!iscmt) {
        # A trailing `//` comment, guarded against a URL ("https://…"): the `//` of a scheme is
        # preceded by a colon and is not a comment.
        i = index(line, "//")
        if (i > 0 && (i == 1 || substr(line, i - 1, 1) != ":")) { iscmt = 1; body = substr(line, i) }
      }
      b = body
      sub(/^[ \t]*/, "", b)
      sub(/^\/\//, "", b)
      sub(/^\/\*/, "", b)
      sub(/^#+[ \t]*/, "", b)
      sub(/^--[ \t]*/, "", b)
      sub(/^;[ \t]*/, "", b)
      sub(/[ \t]*\*\/[ \t]*$/, "", b)
      sub(/[ \t]+$/, "", b)
      o = line; no = gsub(/\/\*/, "", o)
      c = line; nc = gsub(/\*\//, "", c)
      if (inblk) { if (nc > 0) inblk = 0 } else { if (no > nc) inblk = 1 }
      if (sel && iscmt && b != "") printf "%d %s\n", NR, b
    }
  ' "$_file"
}

# Added line numbers for one file in the range, comma-separated. With --unified=0 only added lines
# appear, so the new-file counter advances on `+` lines alone.
_added_lines() {
  _base="$1"
  _file="$2"
  if [ "$MODE" = "staged" ]; then
    _diff="$(git diff --cached -U0 --diff-filter=ACMR -- "$_file" 2>/dev/null)"
  else
    _diff="$(git diff "$_base"...HEAD -U0 --diff-filter=ACMR -- "$_file" 2>/dev/null)"
  fi
  printf '%s\n' "$_diff" | awk '
    /^@@/ { m = $0; sub(/^.*\+/, "", m); sub(/[^0-9].*$/, "", m); n = m + 0; next }
    /^\+\+\+/ { next }
    /^\+/ { if (n > 0) printf "%d,", n; n++; next }
  '
}

# One added comment is judged here, in the order the module lists the shapes.
_judge() {
  # $1 = "file:line", $2 = comment body (marker stripped)
  _where="$1"
  _body="$2"
  _why=""

  # 1. A separator or banner: a run of four or more identical punctuation characters, or a
  #    box-drawing run. The decoration IS the message — the label should be a plain line, or nothing.
  case "$_body" in
    *"===="*|*"----"*|*"****"*|*"####"*|*"////"*|*"~~~~"*|*"____"*|*"++++"*) _why="decorative separator or banner" ;;
  esac
  # 2. Emoji used as a section marker or bullet rather than as prose.
  if [ -z "$_why" ] && _has_byte_prefix "$_body" "$EMOJI_PREFIXES"; then
    _why="emoji in a comment"
  fi
  if [ -z "$_why" ] && _has_byte_prefix "$_body" "$BOX_PREFIXES"; then
    _why="decorative separator or banner"
  fi
  # 3. Workflow narration: the control flow is already visible in the code. The `Step N` and
  #    ordinal-word forms only — a numbered list inside an explanatory comment is prose, not
  #    narration, and flagging it would red the gate headers the kit itself writes.
  if [ -z "$_why" ] && printf '%s' "$_body" | grep -Eq \
       '^([Ss][Tt][Ee][Pp][[:space:]]*[0-9]|([Ff]irst|[Ss]econd|[Tt]hird|[Nn]ext|[Tt]hen|[Ff]inally|[Ll]astly)[,[:space:]])'; then
    _why="workflow narration (Step 1 / First, / Finally,)"
  fi
  # 4. An end marker: the closing brace already ends the block.
  if [ -z "$_why" ] && printf '%s' "$_body" | grep -Eq \
       '^[Ee][Nn][Dd]([[:space:]]+(of|if|else|for|foreach|while|do|switch|case|try|function|func|def|class|method|block|section|loop|process|handler|module|file)|[[:space:]]+[A-Za-z_][A-Za-z0-9_]*[[:space:]]*$|[[:space:]]*$)'; then
    _why="end marker"
  fi

  if [ -n "$_why" ]; then
    FINDING_N=$((FINDING_N + 1))
    if [ "$FINDING_N" -le 10 ]; then
      FINDINGS="$FINDINGS  $_where: $_why
    $_body
"
    fi
    return 0
  fi

  # 5. An all-caps label is a NOTE, never a failure: it is the shape of a legitimate TODO or acronym
  #    as well as the shape of an empty label. A failure bucket that cannot distinguish the two is
  #    an always-red gate, which is the failure mode this kit refuses.
  case "$_body" in
    *[a-z]*) : ;;
    *)
      if printf '%s' "$_body" | grep -Eq '^[A-Z][A-Z0-9_-]{2,30}$' \
         && ! printf '%s' "$_body" | grep -Eq "$CAPS_ALLOW"; then
        NOTE_N=$((NOTE_N + 1))
        if [ "$NOTE_N" -le 5 ]; then
          NOTES="$NOTES  $_where: all-caps label — name the fact, or delete it
"
        fi
      fi
      ;;
  esac
  return 0
}

# --- collect the files ---------------------------------------------------------
if [ "$MODE" = "tree" ]; then
  FILES="$(git grep -Il '' 2>/dev/null || true)"
  LABEL="the tracked tree (audit mode — reports history, not this change)"
elif [ "$MODE" = "staged" ]; then
  FILES="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"
  LABEL="staged change"
else
  if [ "$MODE" = "since" ]; then
    BASE="$SINCE"
  elif [ -n "${GITHUB_BASE_REF:-}" ]; then
    BASE="origin/${GITHUB_BASE_REF}"
  elif git rev-parse -q --verify HEAD~1 >/dev/null 2>&1; then
    BASE="HEAD~1"
  else
    echo "check-comments: no diff base to compare against (first commit or shallow checkout)." >&2
    echo "  Pass --since <sha> (CI passes the PR base SHA), or set COMMENTS_OFF=1 for a" >&2
    echo "  deliberate skip — refusing to report a pass about a comparison that never happened." >&2
    exit 2
  fi
  # A base that does not resolve yields an EMPTY diff, which reads as a clean tree — the failure
  # mode this gate must never report. Refuse instead.
  if ! git rev-parse -q --verify "${BASE}^{commit}" >/dev/null 2>&1; then
    echo "check-comments: diff base '$BASE' does not resolve in this checkout (shallow clone or" >&2
    echo "  wrong ref). Pass the PR base SHA explicitly, or set COMMENTS_OFF=1 for a deliberate" >&2
    echo "  skip." >&2
    exit 2
  fi
  FILES="$(git diff --name-only --diff-filter=ACMR "$BASE"...HEAD 2>/dev/null || true)"
  LABEL="change since $BASE"
fi

for f in $FILES; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  case " $SELF_EXCLUDE " in *" $f "*) continue ;; esac
  printf '%s' "$f" | grep -Eq "$DOC_RE" && continue
  printf '%s' "$f" | grep -Eq "$BIN_RE" && continue

  if [ "$MODE" = "tree" ]; then
    WANT="ALL"
  else
    WANT="$(_added_lines "$BASE" "$f")"
    WANT="${WANT%,}"
    [ -n "$WANT" ] || continue
  fi
  FILE_N=$((FILE_N + 1))
  _scan_file "$f" "$WANT" | sed "s|^|$f:|" >> "$SCAN"
done

# --- judge what was found ------------------------------------------------------
while IFS=" " read -r _where _body; do
  [ -n "${_where:-}" ] || continue
  COMMENT_N=$((COMMENT_N + 1))
  _judge "$_where" "$_body"
done < "$SCAN"

# --- report --------------------------------------------------------------------
# Notes are printed before the refusal so a NOTE is never hidden by a sibling finding on another
# line. They never change the exit code.
if [ "$NOTE_N" -gt 0 ]; then
  echo "check-comments: note — all-caps label(s) in $LABEL (not a failure; name the fact or delete):" >&2
  printf '%s' "$NOTES" >&2
fi

if [ "$FINDING_N" -gt 0 ]; then
  echo "check-comments: slop comment(s) added in $LABEL:" >&2
  printf '%s' "$FINDINGS" >&2
  if [ "$FINDING_N" -gt 10 ]; then
    echo "  ... and $((FINDING_N - 10)) more" >&2
  fi
  echo "" >&2
  echo "  A comment earns its place by saying WHY — the reason, the gotcha, the constraint that is" >&2
  echo "  not visible in the code. Decoration, narration, emoji and end markers say nothing:" >&2
  echo "" >&2
  echo "    // ================ Authentication ================   ->  // Sessions expire after 30 idle min" >&2
  echo "    // Step 1: validate the input                       ->  (delete; the next line says it)" >&2
  echo "    } // end if                                        ->  (delete; the brace already ends it)" >&2
  echo "" >&2
  echo "  Delete the decoration and keep the fact, or set COMMENTS_OFF=1 for a deliberate skip." >&2
  echo "  Doctrine: .agents/rules/code-style.md -> Comments. This gate cannot judge whether a" >&2
  echo "  comment is worth keeping — a comment that restates the line below it is a review question." >&2
  exit 1
fi

# A count of what was actually compared, and a DISTINCT message at zero: a gate that inspected
# nothing must not print the same line as a gate that inspected twenty files and found nothing.
if [ "$COMMENT_N" -eq 0 ]; then
  echo "check-comments: OK (0 comment lines in $LABEL — nothing to compare)"
else
  echo "check-comments: OK ($COMMENT_N comment line(s) inspected, no slop; $FILE_N file(s) in $LABEL)"
fi
exit 0
