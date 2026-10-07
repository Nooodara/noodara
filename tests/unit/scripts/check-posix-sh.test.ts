import { describe, expect, it } from "vitest";

// 06-01-PLAN.md Task 1: `scripts/check-posix-sh.mjs` is the static gate closing 06-RESEARCH.md
// Pitfall 1 -- `install.sh` is published as `curl -fsSL ... | sh`, which on Ubuntu always runs
// under dash regardless of any `#!/bin/bash` shebang, but the dev machine's `/bin/sh` is
// bash-flavoured, so a bashism written and eyeballed on macOS can look correct and still break a
// real user's VPS. This scanner catches bashisms and the `toplevel-side-effect`/`missing-guard`
// structural violations that would let a truncated `curl | sh` half-install (T-06-01).
//
// Mirrors tests/unit/scripts/check-package-provenance.test.ts's shape: import the named export
// straight from the `.mjs` file and assert on its return value, no network/filesystem I/O needed.
import { scanPosixSh } from "../../../scripts/check-posix-sh.mjs";

// The exact three-line guard block install.sh must end with (06-01-PLAN.md Task 2's `<action>`).
// Every fixture below appends this so only the behaviour under test produces a finding.
const GUARD_BLOCK = [
  'if [ "${NOODARA_INSTALL_SH_SOURCE_ONLY:-0}" != "1" ]; then',
  '  noodara_main "$@"',
  "fi",
].join("\n");

/** Wraps a single line inside a minimal function body, followed by a valid final guard block, so
 *  only the bashism on `line` itself can produce a finding -- isolates each <behavior> example
 *  from the `toplevel-side-effect`/`missing-guard` structural rules, which are tested separately
 *  below. */
function wrapInFunction(line: string): string {
  return `noodara_test_fn() {\n${line}\n}\n\n${GUARD_BLOCK}\n`;
}

describe("scanPosixSh", () => {
  it("returns [] for a strict-POSIX script", () => {
    const source = `noodara_step() {\n  printf '%s\\n' "$1"\n}\n\n${GUARD_BLOCK}\n`;

    expect(scanPosixSh(source)).toEqual([]);
  });

  describe("bashism rules (one named finding per line)", () => {
    const cases: Array<{ rule: string; line: string }> = [
      { rule: "bracket-test", line: 'if [[ -n "$x" ]]; then' },
      { rule: "euid", line: "if [ $EUID != 0 ]" },
      { rule: "pipefail", line: "set -o pipefail" },
      { rule: "local", line: "local value=1" },
      { rule: "source", line: "source ./other.sh" },
      { rule: "function-keyword", line: "function foo {" },
      { rule: "echo-flags", line: 'echo -e "a\\nb"' },
      { rule: "append-assign", line: "x+=1" },
      { rule: "herestring", line: 'read a <<< "$x"' },
      { rule: "ampersand-redirect", line: "cmd &> /dev/null" },
      { rule: "case-modifier", line: "printf '%s' \"${x,,}\"" },
      { rule: "ansi-c-quote", line: "printf '%s' $'a\\tb'" },
      { rule: "declare", line: "declare -a items" },
      { rule: "arith-command", line: "if (( n > 1 )); then" },
      { rule: "array-literal", line: "items=(a b c)" },
    ];

    it.each(cases)('detects rule $rule for "$line"', ({ rule, line }) => {
      const findings = scanPosixSh(wrapInFunction(line));

      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe(rule);
      expect(findings[0]?.line).toBe(2);
      expect(findings[0]?.excerpt).toBe(line);
    });
  });

  it("never flags a line whose first non-blank character is #", () => {
    const source = wrapInFunction(
      '  # if [[ -n "$x" ]]; then -- bashism syntax in a comment',
    );

    expect(scanPosixSh(source)).toEqual([]);
  });

  it("flags a bare top-level command as toplevel-side-effect", () => {
    const source = `apt-get update\n\n${GUARD_BLOCK}\n`;

    const findings = scanPosixSh(source);

    expect(findings).toContainEqual(
      expect.objectContaining({ line: 1, rule: "toplevel-side-effect" }),
    );
  });

  it("permits readonly/plain assignments, set, function open/close and the guard block at depth 0", () => {
    const source = [
      "set -eu",
      "readonly NOODARA_DEFAULT_PORT=3000",
      'NOODARA_INSTALL_DIR="${NOODARA_INSTALL_DIR:-/opt/noodara}"',
      "",
      "noodara_step() {",
      "  printf '%s\\n' \"$1\"",
      "}",
      "",
      GUARD_BLOCK,
      "",
    ].join("\n");

    expect(scanPosixSh(source)).toEqual([]);
  });

  it("flags a script whose final statement is not the exact three-line guard block", () => {
    const source = "noodara_step() {\n  printf '%s\\n' \"$1\"\n}\n";

    const findings = scanPosixSh(source);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("missing-guard");
  });

  it("does not flag missing-guard when the exact guard block is the final statement", () => {
    const source = `noodara_step() {\n  printf '%s\\n' "$1"\n}\n\n${GUARD_BLOCK}\n`;

    const findings = scanPosixSh(source).filter(
      (finding) => finding.rule === "missing-guard",
    );

    expect(findings).toEqual([]);
  });

  describe("false-positive regressions (14-03)", () => {
    it("does not flag $(( )) arithmetic expansion", () => {
      expect(scanPosixSh(wrapInFunction("  n=$(( n + 1 ))"))).toEqual([]);
    });

    it("does not flag nested and shifting arithmetic expansion", () => {
      expect(scanPosixSh(wrapInFunction("  n=$(( (a + b) << 2 ))"))).toEqual(
        [],
      );
    });

    it("does not flag the [[:space:]] POSIX character class", () => {
      expect(
        scanPosixSh(
          wrapInFunction(
            "  case $x in *[![:space:]]*) ;; esac; y=${x#[[:space:]]}",
          ),
        ),
      ).toEqual([]);
    });

    it("does not flag $' inside a trailing comment", () => {
      expect(scanPosixSh(wrapInFunction("  true # not $'a\\tb' here"))).toEqual(
        [],
      );
    });

    it("does not flag (( inside a heredoc body", () => {
      const body = [
        "  cat <<EOF",
        "if (( n > 1 )); then [[ x ]]; fi",
        "EOF",
      ].join("\n");
      expect(scanPosixSh(wrapInFunction(body))).toEqual([]);
    });
  });

  describe("real bashisms stay reported (14-03)", () => {
    it.each([
      ["bracket-test", '  if [[ -n "$x" ]]; then'],
      ["arith-command", "  (( n++ ))"],
      ["ansi-c-quote", "  printf '%s' $'a\\tb'"],
      ["array-literal", "  items=(a b)"],
      ["local", "  local v=1"],
      ["euid", '  [ "$EUID" = 0 ]'],
    ])("still reports %s", (rule, line) => {
      expect(scanPosixSh(wrapInFunction(line)).map((f) => f.rule)).toContain(
        rule,
      );
    });

    it("reports [[ ]] on the same line as $(( ))", () => {
      const rules = scanPosixSh(
        wrapInFunction("  n=$(( 1 + 2 )); [[ -n $n ]]"),
      ).map((f) => f.rule);
      expect(rules).toEqual(["bracket-test"]);
    });

    it("reports a real bashism before a comment containing $'", () => {
      const rules = scanPosixSh(wrapInFunction("  [[ -n $x ]] # see $'a'")).map(
        (f) => f.rule,
      );
      expect(rules).toEqual(["bracket-test"]);
    });

    it("does not treat ${#x} or $# as comments", () => {
      const rules = scanPosixSh(
        wrapInFunction("  n=${#x}; m=$#; local q=1"),
      ).map((f) => f.rule);
      expect(rules).toEqual(["local"]);
    });
  });

  describe("robustness (14-03 H1)", () => {
    it("handles an empty file", () => {
      expect(scanPosixSh("").map((f) => f.rule)).toEqual(["missing-guard"]);
    });

    it("handles a file without trailing newline", () => {
      const src = `noodara_f() {\n  :\n}\n\n${GUARD_BLOCK}`;
      expect(scanPosixSh(src)).toEqual([]);
    });

    it("handles CRLF input", () => {
      const src = wrapInFunction("  :").replace(/\n/g, "\r\n");
      expect(scanPosixSh(src)).toEqual([]);
    });

    it("reports an unterminated heredoc", () => {
      const src = `noodara_f() {\n  cat <<EOF\n  text\n}\n\n${GUARD_BLOCK}\n`;
      const rules = scanPosixSh(src).map((f) => f.rule);
      expect(rules).toContain("unterminated-heredoc");
    });

    it.each([
      ["  cat <<'EOF'\n  [[ x ]]\nEOF"],
      ['  cat <<"EOF"\n  [[ x ]]\nEOF'],
      ["  cat <<-EOF\n\t[[ x ]]\n\tEOF"],
    ])("skips quoted/dash heredoc bodies: %j", (body) => {
      expect(scanPosixSh(wrapInFunction(body))).toEqual([]);
    });

    it("reports a bashism after the heredoc terminator", () => {
      const body = "  cat <<EOF\n  x\nEOF\n  [[ -n $x ]]";
      expect(scanPosixSh(wrapInFunction(body)).map((f) => f.rule)).toEqual([
        "bracket-test",
      ]);
    });

    it("does not treat <<< as a heredoc", () => {
      const rules = scanPosixSh(wrapInFunction('  read a <<< "$x"')).map(
        (f) => f.rule,
      );
      expect(rules).toEqual(["herestring"]);
    });
  });
});
