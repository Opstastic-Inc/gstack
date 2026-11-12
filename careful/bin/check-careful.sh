#!/usr/bin/env bash
# check-careful.sh — PreToolUse hook for /careful skill
# Reads JSON from stdin, checks a Bash or PowerShell command for destructive
# patterns (best-effort string matching, not a security boundary).
# Two tiers:
#   HIGH   — a tiny set of catastrophic SIMPLE commands returns "deny"
#            (best-effort advisory hard-stop, not a policy boundary).
#   MEDIUM — the destructive families below return "ask" (always overridable).
# The decision MUST be nested under hookSpecificOutput — Claude Code ignores a
# top-level permissionDecision, which silently no-ops the warning.
set -euo pipefail

# Read stdin (JSON with tool_input)
INPUT=$(cat)

# Shared JSON helpers (extractor + encoder) — one copy for careful AND freeze.
# See hook-extract.sh for the drift history that motivated the shared file.
_HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=careful/bin/hook-extract.sh
# bash treats `.` on a MISSING file as fatal non-interactively; a partial
# install must degrade to an ASK (this is the ask-tier hook), never silence.
_HOOK_HELPER="$_HOOK_DIR/hook-extract.sh"
if [ ! -f "$_HOOK_HELPER" ] || ! . "$_HOOK_HELPER" 2>/dev/null; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"[careful] Hook helpers unavailable (broken install?) - cannot safety-check this command. Approve only if you know what it does."}}\n'
  exit 0
fi

# Extract the "command" field value from tool_input with a real JSON parser.
#
# The previous extractor was
#   grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"'
# whose [^"]* stops at the first escaped quote in the JSON string value. Any
# destructive command preceded by a quoted argument was therefore truncated
# away before the pattern checks ever ran:
#
#   git commit -m "wip" && rm -rf /   ->  CMD='git commit -m \'   -> allowed
#   bash -c "rm -rf /"                ->  CMD='bash -c \'         -> allowed
#   echo "x"; rm -rf ~                ->  CMD='echo \'            -> allowed
#
# Parse the payload properly instead, and fail CLOSED when it cannot be parsed
# at all — a hook that gates destructive commands must not allow-by-default on
# unreadable input.
#
# The same parser call reads tool_name: the PowerShell tool (Claude Code's
# primary shell on Windows, and the only one without Git Bash) carries its
# command in the same tool_input.command field as Bash (hooks reference,
# "PreToolUse > PowerShell"). An older hook-extract.sh without the combined
# reader (partial upgrade) still checks the command, as Bash.
TOOL_NAME=""
set +e
if command -v gstack_hook_extract_tool >/dev/null 2>&1; then
  gstack_hook_extract_tool "$INPUT" command
  EXTRACT_RC=$?
  TOOL_NAME="$GSTACK_HOOK_TOOL"
  CMD="$GSTACK_HOOK_VALUE"
else
  CMD=$(gstack_hook_extract_field "$INPUT" command)
  EXTRACT_RC=$?
fi
set -e

# No parser available, or the payload is not parseable JSON. Fail closed.
if [ "$EXTRACT_RC" -ne 0 ] && [ -n "$INPUT" ]; then
  gstack_hook_decision ask "[careful] Could not parse the tool payload to safety-check this command. Approve only if you know what it does."
  exit 0
fi

# Parsed fine, but there is genuinely no command field (non-shell payload) — allow.
if [ -z "$CMD" ]; then
  echo '{}'
  exit 0
fi

# Log a hook fire event (pattern name only, never command content).
# Shared helper respects GSTACK_HOME, so tests never write real analytics.
_careful_log_fire() { gstack_hook_log_fire careful "$1"; }

# Normalize: lowercase for case-insensitive SQL matching
CMD_LOWER=$(printf '%s' "$CMD" | tr '[:upper:]' '[:lower:]')

# --- Shell-obfuscation tripwire ---
# Every check below inspects the command as a STRING, but bash executes what the
# string MEANS after expansion. ${IFS} holds the default field separator and
# contains no literal whitespace, so
#
#   rm${IFS}-rf${IFS}/
#
# matches none of the `rm\s+` patterns while executing as a full recursive
# delete. The same holds for a command assembled by a base64 decode piped to a
# shell. Rather than try to out-parse bash, treat these splitting/decoding
# primitives as a reason to ask: they are vanishingly rare in commands a human
# actually means to run unattended.
if grep -qE '\$\{IFS\}|\$IFS|\$\(echo[^)]*base64[^)]*\)|base64[[:space:]]+(-d|--decode)[^|]*\|[[:space:]]*(sh|bash)' <<< "$CMD" 2>/dev/null; then
  gstack_hook_decision ask "[careful] Shell obfuscation detected (IFS word-splitting or base64-to-shell). Read the command carefully before approving."
  exit 0
fi

# --- git global options ---
# git accepts global options between `git` and the subcommand (git(1)
# OPTIONS): `git -C <dir> push --force`, `git -c <k>=<v> reset --hard`. The git
# patterns in both tiers expect the subcommand right after `git`, so these
# forms matched nothing and were allowed with no warning. _git_strip_global_opts
# removes the options, so `git -C app push -f` is checked as `git push -f`. An
# option argument is one shell word, made of: unquoted characters, a backslash
# and the character after it (`my\ repo`), "..." in which a backslash escapes
# the next character (`"a \"b\""`), and '...'.
_GIT_OPT_ARG=$'([^\\\\[:space:]"\']|\\\\.|"([^"\\\\]|\\\\.)*"|\'[^\']*\')+'
_GIT_GLOBAL_OPT="(-C|-c|--git-dir|--work-tree|--namespace|--config-env|--attr-source)([[:space:]]+|=)${_GIT_OPT_ARG}"
_GIT_GLOBAL_OPT="${_GIT_GLOBAL_OPT}|--(exec-path|list-cmds|super-prefix)(=${_GIT_OPT_ARG})?"
_GIT_GLOBAL_OPT="${_GIT_GLOBAL_OPT}|-p|-P|--paginate|--no-pager|--bare|--no-replace-objects|--no-lazy-fetch"
_GIT_GLOBAL_OPT="${_GIT_GLOBAL_OPT}|--no-optional-locks|--no-advice|--(literal|glob|noglob|icase)-pathspecs"
_GIT_WITH_OPT_RE='git[[:space:]]+-'
_git_strip_global_opts() {
  # No subprocess unless some `git` is followed by an option.
  if [[ $1 =~ $_GIT_WITH_OPT_RE ]]; then
    printf '%s' "$1" | sed -E "s/(^|[^[:alnum:]_.-])git([[:space:]]+(${_GIT_GLOBAL_OPT}))+[[:space:]]+/\\1git /g"
  else
    printf '%s' "$1"
  fi
}

# _shell_unquote WORD: sets _UNQUOTED to WORD with one level of shell quoting
# removed ('...', "...", and backslash escapes), as the shell passes it to git.
_shell_unquote() {
  local w=$1 c nc q="" i=0 n=${#1}
  _UNQUOTED=""
  while [ "$i" -lt "$n" ]; do
    c=${w:i:1}
    i=$((i + 1))
    case "$q" in
      "'")
        if [ "$c" = "'" ]; then q=""; else _UNQUOTED+=$c; fi
        ;;
      '"')
        case "$c" in
          '"') q="" ;;
          '\')
            nc=${w:i:1}
            case "$nc" in
              '"'|'\'|'$'|'`') _UNQUOTED+=$nc; i=$((i + 1)) ;;
              *) _UNQUOTED+=$c ;;
            esac
            ;;
          *) _UNQUOTED+=$c ;;
        esac
        ;;
      *)
        case "$c" in
          "'"|'"') q=$c ;;
          '\') _UNQUOTED+=${w:i:1}; i=$((i + 1)) ;;
          *) _UNQUOTED+=$c ;;
        esac
        ;;
    esac
  done
}

# Words of a git command line, read with the same word shape as the strip.
_GIT_WORD_RE="^[[:space:]]+(${_GIT_OPT_ARG})"

# _git_scan_inline_aliases TEXT: `-c alias.<name>=<command>` defines the
# subcommand that runs (`git -c alias.nuke='reset --hard' nuke`), so stripping
# the option would hide the destructive command. Sets _GIT_ALIAS_NAMES (lower
# case, as git looks them up) and _GIT_ALIAS_VALUES for each definition in
# TEXT, and _GIT_ALIAS_FROM_ENV=1 for `--config-env alias.<name>=<var>`, whose
# command is in an environment variable the hook cannot read.
_GIT_ALIAS_OPT_RE="(^|[[:space:]])(-c|--config-env)([[:space:]]+|=)(${_GIT_OPT_ARG})"
_git_scan_inline_aliases() {
  local rest=$1 match opt arg key name
  _GIT_ALIAS_NAMES=()
  _GIT_ALIAS_VALUES=()
  _GIT_ALIAS_FROM_ENV=0
  # No subprocess unless the text holds an alias key.
  case "$rest" in *[aA][lL][iI][aA][sS].*) ;; *) return 0 ;; esac
  while [[ $rest =~ $_GIT_ALIAS_OPT_RE ]]; do
    match=${BASH_REMATCH[0]}
    opt=${BASH_REMATCH[2]}
    arg=${BASH_REMATCH[4]}
    rest=${rest#*"$match"}
    _shell_unquote "$arg"
    key=${_UNQUOTED%%=*}
    case "$key" in [aA][lL][iI][aA][sS].?*) ;; *) continue ;; esac
    [ "$key" = "$_UNQUOTED" ] && continue
    if [ "$opt" = "--config-env" ]; then
      _GIT_ALIAS_FROM_ENV=1
      continue
    fi
    name=$(printf '%s' "${key#*.}" | tr '[:upper:]' '[:lower:]')
    _GIT_ALIAS_NAMES+=("$name")
    _GIT_ALIAS_VALUES+=("${_UNQUOTED#*=}")
  done
}

# _git_expand_inline_alias CMD: prints CMD with an aliased subcommand replaced
# by the command its alias defines (`git nuke` -> `git reset --hard`). CMD is
# a simple command with the global options already stripped.
_git_expand_inline_alias() {
  local sub i=0
  if [ "${#_GIT_ALIAS_NAMES[@]}" -gt 0 ] && [[ $1 =~ ^([[:space:]]*git[[:space:]]+)([^[:space:]]+)(.*)$ ]]; then
    sub=$(printf '%s' "${BASH_REMATCH[2]}" | tr '[:upper:]' '[:lower:]')
    while [ "$i" -lt "${#_GIT_ALIAS_NAMES[@]}" ]; do
      if [ "${_GIT_ALIAS_NAMES[$i]}" = "$sub" ]; then
        printf '%s' "${BASH_REMATCH[1]}${_GIT_ALIAS_VALUES[$i]}${BASH_REMATCH[3]}"
        return 0
      fi
      i=$((i + 1))
    done
  fi
  printf '%s' "$1"
}

# --- HIGH tier: hard deny (best-effort advisory hard-stop, NOT a policy boundary) ---
# Only SIMPLE commands are eligible: string matching cannot resolve what a
# compound command does (`cd X && git push --force` — whose cwd? which repo?),
# so anything containing ; && || | or a newline falls through to the MEDIUM ask
# families below — conservative failure = ask, never guess.
# --force-with-lease is deliberately NOT matched here (it is the safe variant).
# curl|sh stays MEDIUM/allow territory: hard-denying it would block legitimate
# installer flows, including gstack's own setup pattern.
_IS_SIMPLE=1
case "$CMD" in
  *';'*|*'&&'*|*'||'*|*'|'*|*$'\n'*) _IS_SIMPLE=0 ;;
esac
if [ "$_IS_SIMPLE" -eq 1 ]; then
  # Recursive delete aimed at the filesystem root or the whole home directory.
  # Tokenized: options (long or short, any position — --no-preserve-root may
  # trail the target) are skipped; EVERY non-option token must be a root-class
  # target (/, ~, $HOME, /*), and a recursive flag must be present. noglob is
  # forced around word-splitting so a literal /* token never expands.
  if grep -qE '^[[:space:]]*(sudo[[:space:]]+)?rm[[:space:]]' <<< "$CMD" 2>/dev/null \
    && grep -qE '(^|[[:space:]])(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)([[:space:]]|$)' <<< "$CMD" 2>/dev/null; then
    _ROOT_TARGETS=0
    _SAFE_TARGETS=0
    set -f
    for _TOK in $CMD; do
      # Strip one layer of surrounding quotes: rm -rf "/" is still rm -rf /.
      _TOK="${_TOK#\"}"; _TOK="${_TOK%\"}"; _TOK="${_TOK#\'}"; _TOK="${_TOK%\'}"
      case "$_TOK" in
        # Skip non-target decoration: options, `--`, redirections (2>/dev/null
        # is the most common suffix on agent-generated commands), backgrounding.
        sudo|rm|-*|--|[0-9]'>'*|'>'*|'<'*|'&') continue ;;
        '/'|'~'|'~/'|'$HOME'|'$HOME/'|'${HOME}'|'${HOME}/'|'/*'|'//') _ROOT_TARGETS=1 ;;
        *) _SAFE_TARGETS=1 ;;
      esac
    done
    set +f
    if [ "$_ROOT_TARGETS" -eq 1 ] && [ "$_SAFE_TARGETS" -eq 0 ]; then
      _careful_log_fire "high_rm_root"
      gstack_hook_decision deny "[careful][HIGH] Recursive delete of / or the home directory is blocked while /careful is active. If you truly mean it, end the /careful session first."
      exit 0
    fi
  fi
  # Force-push to the repo's default branch (the shared history everyone pulls).
  # Force is carried by -f/--force OR by git's plus-refspec syntax (+main,
  # +HEAD:main) which needs no flag at all. --force-with-lease never matches.
  # An inline alias is checked as the command it defines:
  # `git -c alias.fp='push -f' fp origin main` is `git push -f origin main`.
  _GIT_CMD=$(_git_strip_global_opts "$CMD")
  _git_scan_inline_aliases "$CMD"
  _GIT_CMD=$(_git_expand_inline_alias "$_GIT_CMD")
  if grep -qE '^[[:space:]]*git[[:space:]]+push([[:space:]]|$)' <<< "$_GIT_CMD" 2>/dev/null; then
    _HAS_FORCE=0
    if grep -qE '(^|[[:space:]])(-f|--force)($|[[:space:]])' <<< "$_GIT_CMD" 2>/dev/null; then
      _HAS_FORCE=1
    elif grep -qE '(^|[[:space:]])\+[^[:space:]]' <<< "$_GIT_CMD" 2>/dev/null; then
      _HAS_FORCE=1
    fi
    if [ "$_HAS_FORCE" -eq 1 ]; then
      # The default branch belongs to the repo the push runs in, so the lookups
      # get the push's location options (-C, --git-dir, --work-tree). Never -c:
      # a config value can name a program for git to run. The words are read
      # with the strip's word shape and unquoted as the shell would, so a -c
      # value with a space (`-c 'a.b=x y' -C repo`) is one word and a quoted
      # path resolves. A path the hook cannot resolve (~, $VAR) finds no
      # default branch, and the push falls through to the MEDIUM ask.
      _GIT_LOC=()
      _NEXT=""
      _REST=$CMD
      [[ $_REST =~ ^[[:space:]]*git ]] && _REST=${_REST:${#BASH_REMATCH[0]}}
      while [[ $_REST =~ $_GIT_WORD_RE ]]; do
        _REST=${_REST:${#BASH_REMATCH[0]}}
        _shell_unquote "${BASH_REMATCH[1]}"
        _TOK=$_UNQUOTED
        case "$_NEXT" in
          keep) _GIT_LOC+=("$_TOK"); _NEXT=""; continue ;;
          skip) _NEXT=""; continue ;;
        esac
        case "$_TOK" in
          -C|--git-dir|--work-tree) _GIT_LOC+=("$_TOK"); _NEXT=keep ;;
          --git-dir=*|--work-tree=*) _GIT_LOC+=("$_TOK") ;;
          -c|--namespace|--config-env|--attr-source) _NEXT=skip ;;
          -*) ;;
          *) break ;;
        esac
      done
      # Full branch path (slashed defaults like release/2.0 stay intact) and
      # FIXED-STRING token comparison — never interpolate a branch name into
      # an ERE (metacharacters would over/under-match).
      _DEFAULT_BRANCH=$(git ${_GIT_LOC[@]+"${_GIT_LOC[@]}"} symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|^refs/remotes/origin/||' || true)
      # Conductor worktrees often lack the origin/HEAD symbolic ref — without a
      # fallback the HIGH tier would be silently inert in the primary deploy
      # environment. Probe the two conventional defaults.
      if [ -z "$_DEFAULT_BRANCH" ]; then
        if git ${_GIT_LOC[@]+"${_GIT_LOC[@]}"} show-ref --verify -q refs/remotes/origin/main 2>/dev/null; then
          _DEFAULT_BRANCH="main"
        elif git ${_GIT_LOC[@]+"${_GIT_LOC[@]}"} show-ref --verify -q refs/remotes/origin/master 2>/dev/null; then
          _DEFAULT_BRANCH="master"
        fi
      fi
      if [ -n "$_DEFAULT_BRANCH" ]; then
        _TARGETS_DEFAULT=0
        set -f
        # Option arguments are gone from _GIT_CMD: `git -C main push -f origin
        # feature` must not read the directory `main` as the push target.
        for _TOK in $_GIT_CMD; do
          # Strip one layer of surrounding quotes: `git push -f origin "main"`
          # must not dodge the deny just because the ref is quoted.
          _TOK="${_TOK#\"}"; _TOK="${_TOK%\"}"; _TOK="${_TOK#\'}"; _TOK="${_TOK%\'}"
          case "$_TOK" in git|push|sudo|-*) continue ;; esac
          _REF="${_TOK#+}"          # +main -> main
          _REF="${_REF##*:}"        # HEAD:main / src:main -> main
          if [ "$_REF" = "$_DEFAULT_BRANCH" ]; then
            _TARGETS_DEFAULT=1
            break
          fi
        done
        set +f
        if [ "$_TARGETS_DEFAULT" -eq 0 ] && grep -qE '^[[:space:]]*git[[:space:]]+push([[:space:]]+(-f|--force))*[[:space:]]*$' <<< "$_GIT_CMD" 2>/dev/null; then
          # Bare `git push --force` (force flags only, no remote/ref): targets
          # the current branch's upstream — the default branch only when ON it.
          _CURRENT_BRANCH=$(git ${_GIT_LOC[@]+"${_GIT_LOC[@]}"} branch --show-current 2>/dev/null || true)
          [ -n "$_CURRENT_BRANCH" ] && [ "$_CURRENT_BRANCH" = "$_DEFAULT_BRANCH" ] && _TARGETS_DEFAULT=1
        fi
        if [ "$_TARGETS_DEFAULT" -eq 1 ]; then
          _careful_log_fire "high_force_push_default"
          gstack_hook_decision deny "[careful][HIGH] Force-push to the default branch ($_DEFAULT_BRANCH) is blocked while /careful is active. Use --force-with-lease on a feature branch, or end the /careful session if you truly mean it."
          exit 0
        fi
      fi
    fi
  fi
fi

# --- Check for safe exceptions (one standalone rm of build artifacts) ---
# Match the complete command. Parsing only the last rm is unsafe because shell
# syntax or comments can hide an earlier destructive command, for example:
#   rm -rf / # rm -rf node_modules
# Unknown syntax fails closed and falls through to the destructive checks.
# Two hardenings on top of the anchored shape (#2039 wave):
#   - flag cluster accepts capital -R (BSD/macOS recursive), so a single
#     `rm -Rf node_modules` stays allowed instead of prompting;
#   - target tokens exclude `(` and backtick, so command substitution that
#     ENDS in a whitelisted suffix (`rm -rf $(./wipe-all)/node_modules`)
#     cannot ride the whitelist. Plain $VAR expansion (no parenthesis) is
#     still allowed.
#   - multi-line commands never ride the whitelist: grep matches the anchored
#     shape against EACH line, so `rm -rf /\nrm -rf node_modules` would be
#     allowed by its second line. With the JSON-parser extraction the \n in
#     the payload is a real newline (the old grep extractor kept it as two
#     literal characters, which broke the anchored match by accident).
case "$CMD" in
  *$'\n'*) : ;; # multi-line: fall through to the destructive checks
  *)
    if grep -qE '^[[:space:]]*rm[[:space:]]+(-[a-zA-Z]*[rR][a-zA-Z]*[[:space:]]+|--recursive[[:space:]]+)(([^[:space:];&|#(`]*/)?(node_modules|\.next|dist|__pycache__|\.cache|build|\.turbo|coverage)[[:space:]]*)+$' <<< "$CMD" 2>/dev/null; then
      echo '{}'
      exit 0
    fi
    ;;
esac

# --- Destructive pattern checks (MEDIUM tier — always overridable) ---
WARN=""
PATTERN=""

# Mask quoted -m/-am/--message argument content in git commit commands so that
# descriptive commit messages do not trigger false positives (#1060). The
# quote-aware scanner lives in mask-commit-message.awk beside this hook: as a
# heredoc inside a command substitution, its quote characters are mis-parsed by
# bash 3.2 (macOS /bin/bash), which made this whole hook a syntax error there.
# A missing program or an awk failure leaves the command unmasked.
CMD_MEDIUM="$CMD"
CMD_MEDIUM_LOWER="$CMD_LOWER"
_MASK_AWK="$_HOOK_DIR/mask-commit-message.awk"
case "$CMD" in *git*commit*) _MAYBE_COMMIT=1 ;; *) _MAYBE_COMMIT=0 ;; esac
if [ "$_MAYBE_COMMIT" -eq 1 ] && [ -f "$_MASK_AWK" ]; then
  if _cmd_masked=$(printf '%s' "$CMD" | awk -f "$_MASK_AWK" 2>/dev/null); then
    CMD_MEDIUM="$_cmd_masked"
    CMD_MEDIUM_LOWER=$(printf '%s' "$CMD_MEDIUM" | tr '[:upper:]' '[:lower:]')
  fi
fi

# --- PowerShell and cmd table (#3067) ---
# Runs on the PowerShell tool's command, and on the part of any command from a
# nested `powershell`/`pwsh`/`cmd` launcher onward (`pwsh -c "..."`,
# `cmd /c rd /s /q x`, Git Bash's `cmd //c`). Plain Bash commands never reach
# it, so Bash keeps exactly its old behavior. Best-effort: PowerShell can
# build commands at runtime, so encoded and dynamic forms ask instead of being
# parsed, and Claude Code permission deny rules stay the stronger layer.
# Matching is bash [[ =~ ]] on the already-lowercased command (POSIX ERE,
# bash 3.2 compatible): no added subprocess on the per-command path.
_WIN_SCAN=""
[ "$TOOL_NAME" = "PowerShell" ] && _WIN_SCAN="$CMD_LOWER"
_WIN_LAUNCH_RE='(^|[^a-z0-9_.$-])((powershell|pwsh|cmd)(\.exe)?([[:space:]].*)?)$'
if [ -z "$_WIN_SCAN" ] && [[ $CMD_LOWER =~ $_WIN_LAUNCH_RE ]]; then
  _WIN_SCAN="${BASH_REMATCH[2]}"
fi
if [ -n "$_WIN_SCAN" ]; then
  # cmd escapes with ^ (r^d is rd) and PowerShell with a backtick
  # (Re`move-Item is Remove-Item); dropping both only joins characters.
  _WIN_SCAN="${_WIN_SCAN//^/}"
  _WIN_SCAN="${_WIN_SCAN//\`/}"
  _NL=$'\n'
  # Command position: start of text, a statement/pipeline separator, an
  # opening bracket or quote, or right after a shell launcher and its
  # switches. Names elsewhere (ord, --del, /rd/, git branch -d) never match.
  _CP="(^|[;&|({}\"'${_NL}]|(powershell|pwsh|cmd)(\.exe)?([[:space:]]+(-|/+)[a-z]+([[:space:]:=]+[a-z0-9_.-]+)?)*)[[:space:]]*"
  _STMT="[^;|${_NL}]*"
  _CMD_STMT="[^;|&${_NL}]*"
  _WHY_DYNAMIC="Encoded or dynamic PowerShell can't be inspected, so /careful cannot tell what it will run. Read it before approving; Claude Code permission deny rules (for example \"PowerShell(Remove-Item *)\") are the stronger layer."
  # One table: pattern name, ERE, warning. Parameters match any unique
  # prefix PowerShell accepts (-r/-rec/-recurse, -fo/-forc/-force; -f alone
  # is ambiguous with -Filter), with or without a :$true value.
  _WIN_RULES=(
    ps_remove_item
    "${_CP}(remove-item|rm|ri|del|erase|rd|rmdir)[[:space:]](${_STMT}[[:space:]])?-(r|re|rec|recu|recur|recurs|recurse|fo|for|forc|force)([[:space:]:]|$)"
    "Destructive: PowerShell Remove-Item (or rm/ri/del/erase/rd/rmdir) with -Recurse or -Force. This permanently removes files."
    cmd_rd_s
    "${_CP}(rd|rmdir)[[:space:]]${_CMD_STMT}/s([[:space:]/]|$)"
    "Destructive: cmd rd/rmdir /s deletes a whole directory tree."
    cmd_del_s
    "${_CP}(del|erase)[[:space:]]${_CMD_STMT}/s([[:space:]/]|$)"
    "Destructive: cmd del/erase /s deletes matching files in every subdirectory."
    ps_format_volume
    "${_CP}format-volume([[:space:]]|$)"
    "Destructive: Format-Volume erases a whole volume."
    ps_clear_disk
    "${_CP}clear-disk([[:space:]]|$)"
    "Destructive: Clear-Disk wipes every partition on a disk."
    ps_clear_content
    "${_CP}(clear-content|clc)([[:space:]]|$)"
    "Destructive: Clear-Content empties files (like truncate)."
    ps_dotnet_delete
    '\[(system\.)?io\.(directory|file)\]::delete'
    "Destructive: .NET [IO.Directory]::Delete / [IO.File]::Delete removes files without Remove-Item."
    ps_encoded_command
    "(^|[^a-z0-9_.$-])(powershell|pwsh)(\.exe)?[[:space:]](${_STMT}[[:space:]])?-(e|ec|en|enc[a-z]*)([[:space:]:]|$)"
    "PowerShell -EncodedCommand. ${_WHY_DYNAMIC}"
    ps_invoke_expression
    "${_CP}(invoke-expression|iex)([[:space:](]|$)"
    "PowerShell Invoke-Expression (iex). ${_WHY_DYNAMIC}"
    ps_start_process_shell
    "${_CP}(start-process|saps|start)[[:space:]](${_STMT}[[:space:]\"',])?(powershell|pwsh|cmd|bash|wsl|sh)(\.exe)?([[:space:]\"',]|$)"
    "Start-Process launching another shell. ${_WHY_DYNAMIC}"
    ps_call_operator
    "(^|[^&])&[[:space:]]*[\$(]"
    "PowerShell call operator on a variable or expression (& \$cmd). ${_WHY_DYNAMIC}"
  )
  _WI=0
  while [ "$_WI" -lt "${#_WIN_RULES[@]}" ]; do
    _WRE="${_WIN_RULES[$((_WI + 1))]}"
    if [[ $_WIN_SCAN =~ $_WRE ]]; then
      PATTERN="${_WIN_RULES[$_WI]}"
      WARN="${_WIN_RULES[$((_WI + 2))]} (pattern: $PATTERN)"
      break
    fi
    _WI=$((_WI + 3))
  done
fi

# rm -rf / rm -r / rm -R / rm --recursive (capital -R is BSD/macOS recursive)
if [ -z "$WARN" ] && grep -qE 'rm\s+(-[a-zA-Z]*[rR]|--recursive)' <<< "$CMD_MEDIUM" 2>/dev/null; then
  WARN="Destructive: recursive delete (rm -r). This permanently removes files."
  PATTERN="rm_recursive"
fi

# DROP TABLE / DROP DATABASE
if [ -z "$WARN" ] && grep -qE 'drop\s+(table|database)' <<< "$CMD_MEDIUM_LOWER" 2>/dev/null; then
  WARN="Destructive: SQL DROP detected. This permanently deletes database objects."
  PATTERN="drop_table"
fi

# TRUNCATE
if [ -z "$WARN" ] && grep -qE '\btruncate\b' <<< "$CMD_MEDIUM_LOWER" 2>/dev/null; then
  WARN="Destructive: SQL TRUNCATE detected. This deletes all rows from a table."
  PATTERN="truncate"
fi

# The git families match with git's global options removed (see
# _git_strip_global_opts): `git -C app reset --hard` is `git reset --hard`.
CMD_MEDIUM_GIT=$(_git_strip_global_opts "$CMD_MEDIUM")
# Each inline alias is also checked as the command it defines, wherever it is
# in the command: `git -c alias.nuke='reset --hard' nuke` adds a
# `git reset --hard` line. Asking for an alias that is defined but not run is
# the safe side.
_git_scan_inline_aliases "$CMD_MEDIUM"
_i=0
while [ "$_i" -lt "${#_GIT_ALIAS_VALUES[@]}" ]; do
  CMD_MEDIUM_GIT+=$'\n'"git ${_GIT_ALIAS_VALUES[$_i]}"
  _i=$((_i + 1))
done

# git alias from an environment variable (--config-env alias.<name>=<var>)
if [ -z "$WARN" ] && [ "$_GIT_ALIAS_FROM_ENV" -eq 1 ]; then
  WARN="Unchecked: a git alias set with --config-env runs a command from an environment variable, which /careful cannot read."
  PATTERN="git_alias_from_env"
fi

# git push --force / git push -f / plus-refspec force (git push origin +ref)
if [ -z "$WARN" ] && grep -qE 'git\s+push\s' <<< "$CMD_MEDIUM_GIT" 2>/dev/null \
  && grep -qE '(-f\b|--force|(^|[[:space:]])\+[^[:space:]])' <<< "$CMD_MEDIUM" 2>/dev/null; then
  WARN="Destructive: git force-push rewrites remote history. Other contributors may lose work."
  PATTERN="git_force_push"
fi

# git reset --hard
if [ -z "$WARN" ] && grep -qE 'git\s+reset\s+--hard' <<< "$CMD_MEDIUM_GIT" 2>/dev/null; then
  WARN="Destructive: git reset --hard discards all uncommitted changes."
  PATTERN="git_reset_hard"
fi

# git checkout . / git restore .
if [ -z "$WARN" ] && grep -qE 'git\s+(checkout|restore)\s+\.' <<< "$CMD_MEDIUM_GIT" 2>/dev/null; then
  WARN="Destructive: discards all uncommitted changes in the working tree."
  PATTERN="git_discard"
fi

# kubectl delete
if [ -z "$WARN" ] && grep -qE 'kubectl\s+delete' <<< "$CMD_MEDIUM" 2>/dev/null; then
  WARN="Destructive: kubectl delete removes Kubernetes resources. May impact production."
  PATTERN="kubectl_delete"
fi

# docker rm -f / docker system prune
if [ -z "$WARN" ] && grep -qE 'docker\s+(rm\s+-f|system\s+prune)' <<< "$CMD_MEDIUM" 2>/dev/null; then
  WARN="Destructive: Docker force-remove or prune. May delete running containers or cached images."
  PATTERN="docker_destructive"
fi

# --- Additive project patterns ---
# Config can only ADD warn rules, never remove or weaken a baseline family:
# these files are consulted AFTER the hardcoded checks and only when none of
# them matched, so no file content can suppress a baseline warning. One POSIX
# ERE per line; blank lines and #-comments skipped; an invalid regex is
# skipped (never fatal — the hook must not break on a typo in config).
if [ -z "$WARN" ]; then
  # Same state root the writer (/careful via gstack-paths) uses — see
  # gstack_hook_state_root in hook-extract.sh (#1459 class).
  if command -v gstack_hook_state_root >/dev/null 2>&1; then
    _GSTACK_HOME_DIR="$(gstack_hook_state_root; printf x)"; _GSTACK_HOME_DIR="${_GSTACK_HOME_DIR%x}"
  else
    # Older hook-extract.sh (partial upgrade): the plain chain beats dying
    # under set -e with no decision JSON — rules under $HOME/.gstack still load.
    _GSTACK_HOME_DIR="${GSTACK_HOME:-$HOME/.gstack}"
  fi
  _PATTERN_FILES="$_GSTACK_HOME_DIR/careful-patterns.txt"
  # Short-circuit: resolving the project slug costs a subprocess + git call on
  # EVERY Bash command while /careful is active — only pay it when some
  # per-project pattern file actually exists anywhere.
  _ANY_PROJ_PAT=$(find "$_GSTACK_HOME_DIR/projects" -maxdepth 2 -name careful-patterns.txt -print -quit 2>/dev/null || true)
  if [ -n "$_ANY_PROJ_PAT" ]; then
    eval "$("$_HOOK_DIR/../../bin/gstack-slug" 2>/dev/null)" 2>/dev/null || true
    if [ -n "${SLUG:-}" ]; then
      _PATTERN_FILES="$_PATTERN_FILES
$_GSTACK_HOME_DIR/projects/$SLUG/careful-patterns.txt"
    fi
  fi
  while IFS= read -r _PF; do
    [ -f "$_PF" ] || continue
    while IFS= read -r _PAT || [ -n "$_PAT" ]; do
      case "$_PAT" in ''|'#'*) continue ;; esac
      _PAT_RC=0
      printf '' | grep -qE -- "$_PAT" 2>/dev/null || _PAT_RC=$?
      [ "$_PAT_RC" -eq 2 ] && continue # invalid ERE — skip the line
      if grep -qE -- "$_PAT" <<< "$CMD_MEDIUM" 2>/dev/null; then
        WARN="Project rule matched: $_PAT"
        PATTERN="project_rule"
        break
      fi
    done < "$_PF"
    [ -n "$WARN" ] && break
  done <<EOF_PATTERN_FILES
$_PATTERN_FILES
EOF_PATTERN_FILES
fi

# --- Output ---
if [ -n "$WARN" ]; then
  _careful_log_fire "$PATTERN"
  gstack_hook_decision ask "[careful] $WARN"
else
  echo '{}'
fi
