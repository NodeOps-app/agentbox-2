# Workspaces / tasks / manager — backlog

Open work after Phase 9 (timeline). Design and history live in
[`workspaces-tasks-manager-plan.md`](./workspaces-tasks-manager-plan.md). Repo: **hub** = this repo
(`apps/hub`, `packages/relay`, `apps/cli`), **tray** = `../agentbox-tray`. Size: S < half a day,
M ≈ a day, L = several.

Suggested order: Phase 10a → 10b → 10c → 10d. Each phase is one session (branch, implement, smoke,
review, merge), as before.

## Phase 10a — Plan view fixes and dashboard (tray)

| # | Item | Size | Notes |
|---|------|------|-------|
| 1 | **"Start box with N selected" padding** | S | Backlog card header button (`TaskListView`): no horizontal inset; give it the `ManagerButton.horizontalPadding` treatment. |
| 2 | **Show every workspace box in Plan, even with no tasks** | S | By box mode draws a card only for boxes holding tasks. Draw an empty card (state, agent, branch, Web, `…`, "no tasks · drop one here") for the workspace's other boxes, after the ones with tasks. It is a drop target like the rest. |
| 3 | **New Box from the Manager window preselects the project** | S | `ManagerTitleBar` New Box → `CreateBoxPanel`: preselect the sidebar's selected project, else the project whose root equals the workspace root (single-project workspace), else today's default. |
| 4 | **Last 2 timeline items on top of Plan** | M | A compact strip above the Tasks header, using `TimelineRowView` in a condensed mode (no quote, one line). "View all" switches to Timeline. Fetch the timeline in Plan mode too, with `limit=2` + live rows, on the same refresh. The 60 s GitHub check must stay tied to Timeline mode (`limit=2` must not kick it), or it runs whenever the window is open. |
| 5 | **Manager terminal in the Timeline view too** | M | **Clarify first**: Plan already shows the manager terminal under the task list. Presumed intent: Timeline keeps the terminal pane under the timeline instead of hiding the whole split. Swap only the top pane (tasks ⇄ timeline) and leave the terminal attached at the same size (never resize the tmux client). |

## Phase 10b — Manager terminal (hub + tray)

The manager runs in a hub-owned tmux session (`startManagerSession`,
`packages/relay/src/workspaces/manager.ts`); the tray embeds `tmux attach` in Ghostty.

| # | Item | Size | Notes |
|---|------|------|-------|
| 6 | **Scroll wheel scrolls the screen, not up/down keys** | S | Inside tmux the wheel reaches the app as arrow keys (alternate screen, no mouse mode). Set `mouse on` on the manager session (a `set-option -t <session>` next to the existing `window-size latest`), so the wheel enters copy mode and scrolls history. Check it doesn't break click-to-focus in the Ghostty embed. |
| 7 | **Ctrl+Enter inserts a newline in the claude prompt** | S | tmux drops the modifier, so claude sees a plain Enter and submits. Options: (a) `extended-keys on` + `terminal-features '*:extkeys'` on the session so the modified key passes through; (b) the tray maps Ctrl+Enter in the embed to what claude already treats as a newline (`\` + Enter / Ctrl+J; verify for claude and codex). Prefer (a) if claude honors it through tmux; else (b). |
| 8 | **Custom footer instead of the stock tmux status bar** | M | Match the look of the attach wrapper's footer (locate it first: the in-box attach/compositor code). Set `status-format`/`status-style` on the manager session: manager name, agent · session, workspace, boxes working, hint keys. Keep it hub-side so every client attaching sees the same bar. |

## Phase 10c — Compact, pinnable Manager window (tray)

| # | Item | Size | Notes |
|---|------|------|-------|
| 9 | **Responsive layout: works as a narrow side panel** | L | Below a width threshold (~720 pt): auto-collapse the sidebar, show a workspace/manager dropdown in the header instead, and stack the header controls (By box, Clear completed, Plan \| Timeline) so nothing truncates. Tasks/timeline rows already truncate; check chips, the Web/box cluster and Approve at ~420 pt. Restore the sidebar when widened (unless the user collapsed it). |
| 10 | **Pin on top** | S | Title bar toggle "Always on top" (the mock's button): `window.level = .floating` + `collectionBehavior` so it follows spaces next to Claude desktop / Codex. Persist per window (`ManagerPinned`). |

## Phase 10d — Timeline data and the host skill (hub)

| # | Item | Size | Notes |
|---|------|------|-------|
| 11 | **+/− lines on push rows** | M | Compute when the push is recorded, from the host repo, never by a remote exec: the relay push path already has the host repo and the old/new tips, so `git diff --shortstat <old>..<new>` there is a local, sub-10 ms call. The hub-route push (`git/push`, `push-host`) does the same against the host checkout after the push. Store `additions/deletions` on the `git.push` event (the tray already renders a diff line). Skip silently when the old tip is unknown (first push → diff against the merge base with the default branch, capped). |
| 12 | **Host skill: use tasks when parallelizing** | S | `apps/cli/share/host-skills/agentbox-info/SKILL.md` (+ `plugins/agentbox`, `pnpm check:plugin-skill`): 3–4 lines max. Workspaces have tasks (`T-n`); when the user asks to split or parallelize work across boxes: `agentbox tasks add …`, then start boxes with those tasks / `agentbox tasks assign`. **Confirm**: the request said "tags"; read as tasks. |
| 13 | **Timeline notes via CLI/REST** | done | Already shipped in Phase 9: `agentbox manager note "…" [--replan\|--plan]`, `--note` on `tasks add/update/assign/reorder`, `POST /api/v1/managers/{id}/notes`. The skill's manager section already shows it; only tighten the wording while doing #12. |

## Parked (decided to look at later)

- **Realtime box activity / in-box pushes and PRs**: the relay status store and the relay timeline hooks don't fire the hub change signal, so those arrive on the 30 s poll. Fix: notify from both, debounced.
- **Menu PR state goes stale**: the GitHub PR check only runs while a Timeline is open. Option: a 5-minute background check for workspaces with boxes on a branch.
- **Cost trims**: read only the tail of `timeline.jsonl`; refresh cloud-box diff counts less often.
- **Tray menu with many boxes**: native menu scroll arrows, header/footer scroll away. Options: "N more…" per group, or a panel with a real scrollbar.
- **"Since you left" resets on a quick Plan ⇄ Timeline flip**: add a minimum-away threshold or tie it to window visibility.
- **Merged rows repeat the PR number** (title and link): drop it from the title if it reads noisy.
- **Pre-existing CLI bugs found along the way**: `agentbox create -y` still prompts for carry on the local-hub path; `agentbox destroy a b -y` destroys only the first box; `agentbox tasks rm` without `-y` outside a TTY reports "Can't reach the hub".
