# Phase 5: UI web - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-19
**Phase:** 05-ui-web
**Areas discussed:** Add server and connect flow, Discovery progress narrative, Server list and detail layout, Activity log and settings surface

All four proposed gray areas were selected. The user chose the recommended option on every question and gave no free-text notes.

---

## Add server and connect flow

### On save

| Option | Description | Selected |
|--------|-------------|----------|
| Save and connect | Primary button registers, fires Connect, closes the sheet, lands on detail. Quiet secondary "Save without connecting" leaves it PENDING. | ✓ |
| Save, then explicit Connect | Sheet only saves; admin lands on detail in PENDING with the "not discovered yet" empty state and a Connect button. | |
| Save and stay on the list | Sheet closes back to the list; new row is PENDING with Connect on the row. | |

**User's choice:** Save and connect (Recommended)

### First trust (TOFU)

| Option | Description | Selected |
|--------|-------------|----------|
| One-time notice plus detail row | Neutral dismissible notice after first connect with fingerprint and the ssh-keygen verify command; permanent mono row with captured date and copy. | ✓ |
| Detail row only | No notice; fingerprint is just a detail row. | |
| Require the admin to confirm | First connect pauses until the admin accepts the fingerprint; needs a new backend state and breaks one-click flow. | |

**User's choice:** One-time notice plus detail row (Recommended)

### Host key changed

| Option | Description | Selected |
|--------|-------------|----------|
| Compare, then type the name | Banner with both fingerprints stacked in mono with dates plus verify command; trusting requires typing the server name. | ✓ |
| Compare, then a simple confirm | Same banner; plain confirm dialog, no typing. | |
| Compare with a direct button | Same banner; trusts immediately. | |

**User's choice:** Compare, then type the name (Recommended)

### Credential input

| Option | Description | Selected |
|--------|-------------|----------|
| Key by default, paste or pick a file | Segmented control, key default; mono textarea plus "Choose file" read in the browser; optional passphrase; ed25519 helper; Replace on edit. | ✓ |
| Key by default, paste only | Same without the file picker. | |
| You decide | Leave input mechanics to planning. | |

**User's choice:** Key by default, paste or pick a file (Recommended)

**Notes:** User chose "Next area" after four questions.

---

## Discovery progress narrative

Context given to the user: the per-check results live only in the stored snapshot payload; no route or event exposes them, so DISC-02 cannot be met with the phase 4 API as is.

### Progress

| Option | Description | Selected |
|--------|-------------|----------|
| Live, check by check | Each check flips as the worker finishes it. Backend cost: per-check callback, new progress event, last-run read endpoint, canary extension. | ✓ |
| Full checklist on completion | Steps listed while running; all results fill in at the end. Only needs the read endpoint. | |
| You decide | Research sizes both; UI never shows progress it does not know. | |

**User's choice:** Live, check by check (Recommended)

### Checklist structure

| Option | Description | Selected |
|--------|-------------|----------|
| Six steps, expandable to raw checks | Roadmap's six steps; SSH and auth from the connect result; four groups over the eleven backend checks; expand for detail and duration. | ✓ |
| Flat list of every check | Thirteen rows, nothing hidden. | |
| Six steps only | No access to underlying checks. | |

**User's choice:** Six steps, expandable to raw checks (Recommended)

### After the run

| Option | Description | Selected |
|--------|-------------|----------|
| Detail section, latest run only | Discovery section on the detail page; live during a run; one-line summary after; Re-run lives there. | ✓ |
| Latest run plus run history | Adds a list of previous runs; needs a list endpoint. | |
| Inspector panel | Checklist in the right-hand inspector. | |

**User's choice:** Detail section, latest run only (Recommended)

### Fail vs warn

| Option | Description | Selected |
|--------|-------------|----------|
| Pass, warning, fail | Green pass; amber for failed checks that leave the server usable; red only for the check that ended the run; grey for not applicable. | ✓ |
| Strict pass or fail | Every failed check is red. | |
| You decide | Leave to the UI design contract. | |

**User's choice:** Pass, warning, fail (Recommended)

**Notes:** User chose "Next area". The mid-run page-open edge case was left to planning under the rule that the UI never shows progress it has not received.

---

## Server list and detail layout

### List style

| Option | Description | Selected |
|--------|-------------|----------|
| Rows | Hairline 44px rows: name, host:port mono, status pill, last seen; row menu for edit and delete. | ✓ |
| Cards | One entity card per server with a key fact. | |
| Rows, cards when there are few | Cards up to three servers, rows beyond. | |

**User's choice:** Rows (Recommended)

### Detail location

| Option | Description | Selected |
|--------|-------------|----------|
| Its own page | Full page with its own URL; toolbar action; back link; inspector unused. | ✓ |
| Master-detail split | List as a narrow left column. | |
| Page plus inspector preview | Read-only summary in the inspector plus the full page. | |

**User's choice:** Its own page (Recommended)

### Facts presentation

| Option | Description | Selected |
|--------|-------------|----------|
| Stat tiles plus pairs | Four tiles (CPU, RAM, disk with meter, uptime) plus grouped pairs; values labelled as of last discovery. | ✓ |
| Grouped pairs only | No tiles, no meter. | |
| You decide | Leave to the UI design contract. | |

**User's choice:** Stat tiles plus pairs (Recommended)

### Failed state

| Option | Description | Selected |
|--------|-------------|----------|
| Error banner, keep earlier facts | Distinct empty state for never connected; error banner per error code with one action; earlier facts stay dimmed and dated. | ✓ |
| Error state replaces the facts | Only the error state while in ERROR or UNREACHABLE. | |
| You decide | Leave to the UI design contract. | |

**User's choice:** Error banner, keep earlier facts (Recommended)

**Notes:** User chose "Next area". Sidebar contents, theme toggle and sign out placement were left to the design-system skill and planning.

---

## Activity log and settings surface

### Paging

| Option | Description | Selected |
|--------|-------------|----------|
| "Load older" button | First 50 grouped by day; ghost button appends the next 50. | ✓ |
| Infinite scroll | Auto-load near the bottom. | |
| You decide | Leave to planning. | |

**User's choice:** "Load older" button (Recommended)

### Row detail

| Option | Description | Selected |
|--------|-------------|----------|
| Sentence, expand for curated details | Sentence with linked server name; error code on failures; expand for per-action pairs; UI renders only known keys. | ✓ |
| Sentence only | Nothing expands. | |
| Sentence, expand for raw JSON | Formatted stored metadata on expand. | |

**User's choice:** Sentence, expand for curated details (Recommended)

### Sessions in Settings

| Option | Description | Selected |
|--------|-------------|----------|
| Not in this phase | Settings stays at SET-01; sessions screen deferred. | ✓ |
| Yes, a Sessions section | List, revoke per row, sign out everywhere. | |
| Only "Sign out everywhere" | One destructive button after a confirm. | |

**User's choice:** Not in this phase (Recommended)

### Settings content

| Option | Description | Selected |
|--------|-------------|----------|
| Instance, then an Advanced group | Version and public URL; collapsed Advanced with key fingerprint, SSH timeouts, worker concurrency. | ✓ |
| Version and public URL only | Exactly SET-01. | |
| Everything, flat | All fields in one list. | |

**User's choice:** Instance, then an Advanced group (Recommended)

**Notes:** User chose "Move on", then "I'm ready for context" instead of exploring more gray areas.

---

## Claude's Discretion

- Shape and names of the new discovery progress event and the last-run read endpoint, within the allowlist, guarded-scope, best-effort-publish and canary rules.
- What the page shows when opened in the middle of a run.
- E2E, nightly 20 of 20, 100 consecutive connections and canary job mechanics. Note recorded: the repo has no git remote and only `ci.yml`, so a nightly workflow cannot run on GitHub until the user pushes.
- Setup-token, login and lockout screens.
- Sidebar contents (Servers, Activity, Settings only), theme toggle and sign out placement, breakpoints.
- Stream-dropped experience.
- Activity refresh strategy without a new SSE event type.
- Behaviour right after trusting a new fingerprint (no auto-connect) and the Connect button while a connect is running.
- Client data layer, `packages/ui` structure, component catalogue.
- Inline validation and duplicate name or host errors in the sheet.

## Deferred Ideas

- Discovery run history UI.
- Active sessions screen in Settings, including "Sign out everywhere".
- Mandatory fingerprint confirmation on first connect (considered, not chosen).
- Inspector (third panel) usage, for v0.2+ entities.
- SSE event type for activity.
- Editable global configuration (already deferred in phase 4).
- Cards or an alternate layout for few servers (considered, not chosen).

## Constraint recorded, not discussed

- The phase 4 security audit left 4 open threats and a confirmed host-key trust bypass in `editServer`. CONTEXT.md D-17 requires those fixes before this phase executes, since the trust-fingerprint screen depends on that code path.
