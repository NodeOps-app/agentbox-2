# Workspaces, Tasks and the Manager

## Context

Running several boxes in parallel is the point of AgentBox, but deciding *what* each one should do —
and making sure two of them do not fight over the same files — is entirely manual today. The
"Agents Manager" design (`../agentbox-design/AgentBox Tray App v2.html`) closes that: a coding agent
running **locally** in a folder reads a task list, groups the tasks into boxes so their diffs do not
collide, creates the boxes, and watches their PRs. Three things had to exist first:

1. a **Workspace** — a host folder grouping one or more projects (subfolders with a `.git` or an
   `agentbox.yaml`, or the folder itself). The existing "project" entity is one repo; the unit a
   human plans across is usually a folder holding several of them;
2. a **Task** — a unit of work both the human and the manager create and prioritize. Many tasks map
   to one box on purpose: the manager puts the three tasks that touch `src/payments` in one box and
   the two copy-only ones in another;
3. a **Manager session** — the agent process itself, running in the workspace root with the
   `agentbox` CLI on PATH.

Phase 1 (this doc's subject) builds the entities, the store, the hub API and the CLI. The GUIs and
the manager's own instructions come after.

### Decisions taken

- **Names.** "Workspace", despite the internal collision with the box's `/workspace` mount and the
  `agentbox.yaml` config scope — it is what users call the thing. "Task", despite the collision with
  the `tasks:` block in `agentbox.yaml`: Linear tickets will later map 1→n onto local tasks, and
  "ticket" would then be the wrong word for both. The TS type is `WorkTask` so it never clashes with
  `@agentbox/ctl`'s `TaskSpec`; the docs call the yaml ones **setup tasks**.
- **The hub owns the manager process**, started in a detached tmux session on the hub's machine.
  Clients attach to that session rather than the hub proxying a terminal to each of them, which is
  what lets the CLI, the tray and a plain terminal all reach the same running agent.
- **Tasks are workspace-owned** with an optional `projectId` and an optional `boxId`. A backlog item
  exists before anyone knows which project it touches; forcing a project up front would mean it
  could not.
- **Assignment is reconciled on read, never trusted.** A task assigned at create time carries a job
  id until the worker records the box; a task whose box was destroyed returns to the backlog. Status
  is never touched by reconciliation — half-finished work stays half-finished.
- **The backend is split by domain.** `apps/hub/lib/hub-backend.ts` had reached 3800 lines because
  every feature appended its methods there. This work introduced `apps/hub/lib/backend/`, where a
  slice takes a narrow `BackendDeps` instead of the relay handle.

### Status

| Phase | What | State |
| --- | --- | --- |
| 1 | Store: `~/.agentbox/workspaces/<id>/` (workspace, tasks, manager) | **done** |
| 2 | Hub: `WorkspaceBackend` slice + `/api/v1/workspaces`, `/api/v1/tasks` | **done** |
| 3 | CLI: `workspace`, `tasks`, `manager`, and `--tasks` on create | **done** |
| 4 | The manager's brief: what it is told to do with the task list | planned |
| 5 | Tray: the Manager window (task list + terminal pane) | **done** |
| 6 | Hub web UI: workspace + task views | planned |
| 7 | Linear import: one ticket → several local tasks | planned |
| 8a | Managers are detected, not declared: many per workspace, `/api/v1/managers`, `Box.managerId` | **done** |
| 8b | Tray: boxes grouped by manager, the Manager window's session picker | planned |

### Known gaps

- **The manager has no instructions yet.** Phase 1 starts a plain agent in the folder with
  `AGENTBOX_WORKSPACE` set and the `agentbox tasks` CLI available. What it should *do* with them (the
  file-overlap grouping, the `box.merged` follow-up) is Phase 4.
- **A codex store holds more than sessions.** Its rollouts are flat across every project, so the
  folder comes out of each file's opening record — which also marks the agent's own internal threads
  (`guardian_review`, `subagent`). Those are skipped, as claude's `agent-*.jsonl` transcripts are: on
  a real store they were 49 of 71 files, none with a turn to name them. That opening record can also
  outgrow any fixed head read, so it is read by following the line rather than a buffer, and the
  title is scraped after it. Candidates are ranked by mtime before the read budget applies, because
  a resumed session keeps appending to its original file and a name-ordered cut would drop exactly
  the ones still in use.
- **Only claude and codex can resume a session.** Each has its own spelling — `claude --resume <id>`
  against `~/.claude/projects/<encoded-root>/<id>.jsonl`, and the SUBCOMMAND `codex resume <id>`
  against the flat `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` store, which records the folder
  inside each file rather than in its path. The remaining agents' on-disk formats are unverified, so
  `GET …/managers/sessions` answers `supported: false` for them and a `sessionId` is refused rather
  than silently starting a fresh agent that looks resumed.
- **opencode and pi are never detected as managers.** Neither exports a session id into the commands
  it runs, so a create from inside one registers nothing and its boxes land in "Other boxes".
- **Codex's sandbox hides most of this.** In the default `workspace-write` sandbox loopback is blocked
  (`curl http://127.0.0.1:8787` answers nothing), so the CLI cannot reach the hub at all and detection
  fails with a warning; it needs `[sandbox_workspace_write] network_access = true` in
  `~/.codex/config.toml`, or a full-access sandbox. Even with network access, `ps` is "operation not
  permitted" there, so the ancestor walk that finds the codex pid fails soft and a sandboxed codex
  manager never has a pid: its liveness is the 30-minute `lastSeenAt` window. `CODEX_THREAD_ID` itself
  is exported (a uuid-v7, verified on codex 0.142).
- **A remote hub probes no pid and scrapes no title.** A pid is only probed when the detect reported
  the hub's own hostname, and a title is read from the agent's store on the hub's disk; a PC session
  registered with a control box falls back to the `lastSeenAt` window and shows its short session id.
- **A remote hub's manager runs on the remote machine.** That is correct but currently unhelpful:
  the workspace CLI commands all pass `preferLocal`, so they target this laptop's hub.
- **The remaining hub-backend domains are still in the monolith.** Boxes, projects, fleet ops and the
  open-in launchers should each move to `lib/backend/<domain>.ts`; the four `// ── … ──` banners in
  `hub-backend.ts` mark the seams.
- **tmux is a new soft dependency** of the hub host, for the manager only. `agentbox doctor` warns
  when it is missing and `manager start` answers 503 with an install hint. The session is created
  with `window-size latest` (best-effort), so a tray pane and a terminal attached at the same time
  size to the most recent client instead of both being clamped to the smaller grid.

---

## Phase 1 — the store (`packages/relay/src/workspaces/`)

`~/.agentbox/workspaces/<wsId>/` holds `workspace.json`, `tasks.json`, `manager.json` and
`manager.exit`. Atomic temp+rename writes under `withFileLock`, the same shape
`packages/relay/src/queue.ts` uses; the lock windows are short because these files sit on the
dashboard poll path.

`wsId = hashProjectPath(root)` — the same key space as the project registry, so a single-project
folder registered as both shares one id and a client can join the two with no lookup table.

Task ids are `T-<n>` from a counter on the workspace record, **never reused**: a stale reference in a
manager transcript or a PR body must not resolve to different work later.

The pure halves — `reconcileTasks`, `reorderTasks`, `taskSummaryForBox`, `findWorkspaceContaining` —
are separated from the IO so they are testable without a filesystem.

## Phase 2 — the hub API

`apps/hub/lib/backend/deps.ts` declares the three seams a slice gets: `notify()` (the `/api/events`
fan-out), `liveBoxIds()` (local records **union** Store registrations — a control box's PC-created
cloud box has a registration and no local record) and `jobs()`. `createHubBackend` builds them once
and spreads `createWorkspaceBackend(deps)` into the returned object; `HubBackend extends
WorkspaceBackend`, so callers still see one object.

Routes under `app/(dashboard)/api/v1/workspaces/` plus a cross-workspace `…/api/v1/tasks`. No PATCH
(this API has none anywhere): an update is a POST on the resource, and everything else is a POST
sub-resource. Every mutation calls `deps.notify()`.

Two payload fields were added, both additive and both absent on the hosted/Postgres path, where
absence means "no data", never "zero":

- `Project.workspaceId` — set when a registered workspace lists that project id.
- `Box.tasks` — `{ total, done, current }`, matched by box id and by pending create-job id (so a
  synthetic `job:<id>` row shows its tasks while the box is still being built).

`POST …/managers/start` (then `…/manager/start`) takes its accept-list from the live agent registry, minus the agents whose
`surface` is `service` and those the host reports as not installed. Anything a picker offers can
therefore be a manager, including one added by `agentbox agent add`, while a daemon-shaped agent is
refused (it has no session to attach to, so it would leave a tmux session nobody can use) and so is
one the host cannot run — unlike a box, which installs its agent on demand, the manager runs where
nothing will, and without that check the start answers 200 and the session dies with exit 127.

There is deliberately no free-form `argv` — the manager runs on the hub's own machine, so accepting
one would turn an API token into a shell on a control box. `sessionId` is constrained to an id shape
for the same reason: it lands in the agent's argv, and a value like `--dangerously-skip-permissions`
would be read by the AGENT as a flag, starting the manager with its approval gate off. Shell quoting
does not cover that; only the shape check does.

## Phase 3 — the CLI

Three thin clients over the API. Which workspace a command means resolves `--workspace`, then
`$AGENTBOX_WORKSPACE` (set inside the manager's own session, so the manager needs no flag), then the
registered workspace whose root contains the cwd, longest root winning.

`--tasks T-11,T-12` on `agentbox create` and every agent command validates the ids **before** any box
is provisioned, then assigns after: a job id where the create returns one (hub-routed and `-i`
queued creates), a box id where it returns that instead (the inline docker path, and the cloud path
via a new `onCreated` hook). Assignment failure after the box exists is a warning, never a failed
create.

## Phase 8 — managers are detected, not declared

Before this phase a manager existed only when someone registered a workspace and started an agent in
it through the hub. In practice the manager was already there: the claude or codex session in the
user's terminal that runs `agentbox create` / `agentbox claude …`. Nobody wanted to declare a
workspace first.

**A manager is a host agent session**, many per workspace, of two kinds:

- `external` — the user's own terminal process. The hub only observes it.
- `hub` — started by the hub in a tmux session it owns (`agentbox-manager-<managerId>`), as before.

When the CLI runs inside a session it sends that session's identity (`POST /api/v1/managers/detect`);
the hub registers it and, if no workspace contains the session's folder, creates one there named after
the folder. A session already registered stays in its workspace. An external manager whose process
has ended is **resumable by the hub** (`POST /managers/:id/resume` → `claude --resume <id>` /
`codex resume <id>` in the recorded `cwd`), after which it is `hub`-run — that is what turns "the
session that made these boxes" into a manager any client can reopen.

| agent | identity in the spawned shell | liveness handle |
| --- | --- | --- |
| claude | `CLAUDE_CODE_SESSION_ID` (+ `CLAUDECODE=1`) | `CLAUDE_PID` |
| codex | `CODEX_THREAD_ID` | nearest ancestor process named `codex` (none inside its sandbox) |

**Detection** (`apps/cli/src/lib/host-session.ts`) cross-checks claude's id against a transcript,
walking up from the cwd so a command run in a subfolder records the folder the session was started in
(where `--resume` finds it). Inside an Agent-tool subagent the id is the subagent's own and has no
transcript; the fallback is the single session in that folder touched in the last five minutes, else
nothing is sent. `AGENTBOX_MANAGER=<managerId>` is exported into a hub-run manager's shell, so its
agent's own `agentbox` calls join that record instead of registering a second one. Inside a box
(`AGENTBOX_RELAY_URL` set) nothing is detected. Registration is best-effort everywhere: a failure is a
warning, never a failed create.

**Store.** `managers.json` `{version:1, managers: ManagerRecord[]}` replaces `manager.json`, with the
same locked temp+rename writes as `tasks.json`; exit codes move to `managers/<managerId>.exit`. A
legacy `manager.json` is read once into a `hub` record — keeping its old tmux session name, so a
session still running under it reads running — and then deleted. `status` is derived, never stored:
tmux for `hub`; for `external` a `kill(pid, 0)` (ESRCH = stopped, EPERM = running) when the detect
reported this host's name, else running while `lastSeenAt` is under 30 minutes old.

**Boxes and tasks.** A manager keeps `boxIds` and `boxJobIds`, reconciled on read with the same rules
as a task's assignment (job → box, a failed job dropped, a gone box dropped unless a create in flight
recorded it). `POST /boxes` takes `managerId` and attaches the job; the agent commands, whose docker and
cloud paths create inline, attach through the detect call itself (`boxId` / `boxJobId` on the body).
`GET /boxes` stamps `Box.managerId`. `WorkTask.managerId` is set by `agentbox tasks add` inside a
session and inherited from the box on assignment; `?managerId=` filters both task listings.
`WorkspaceView.manager` became `managers: { running, total }`, and a workspace cannot be removed while
any of its managers runs.

**API.** The three `workspaces/:id/manager*` routes are gone. `GET /managers`
(`?workspaceId=&status=`), `POST /managers/detect`, `GET|DELETE /managers/:id`,
`POST /managers/:id/{stop,resume}`, and per workspace `GET /workspaces/:id/managers`,
`POST …/managers/start` (a `sessionId` some manager holds resumes THAT manager) and
`GET …/managers/sessions`. Resume answers 409 while the session still runs anywhere and 503 without
tmux; stop answers 409 for a running external manager, whose process the hub never signals.

**Backend.** `apps/hub/lib/backend/managers.ts` (`createManagerBackend(deps, { workspaceView })`),
with `hostname` / `isPidAlive` seams on `BackendDeps` so the status matrix is testable anywhere.

**CLI.** `agentbox manager list | status [id] | start | resume <id> | stop <id> | attach [id] |
sessions | forget <id>`; `agentbox tasks list --manager <id> | --mine`. A `tasks` / `workspace` /
`manager` command in a folder no workspace contains registers the session instead of failing.

## Files to touch (representative)

- `packages/relay/src/workspaces/{types,workspace-store,task-store,manager}.ts` + `index.ts`
- `apps/hub/lib/backend/{deps,workspaces}.ts`; `apps/hub/lib/boxes/{types,backend-types}.ts`;
  `apps/hub/lib/hub-backend.ts` (compose + the two `getData` hooks)
- `apps/hub/app/(dashboard)/api/v1/workspaces/**`, `…/api/v1/tasks/route.ts`, `…/lib/{validate,openapi,envelope}.ts`
- `apps/cli/src/control-plane/hub-api-client.ts`; `apps/cli/src/lib/{workspace-ref,tasks-assign,text-table}.ts`;
  `apps/cli/src/commands/{workspace,tasks,manager}.ts`; `apps/cli/src/{index,help}.ts`
- `apps/cli/src/commands/create.ts`, `apps/cli/src/agents/command/{options,create-action}.ts`,
  `apps/cli/src/commands/_cloud-agent-create.ts` (the `--tasks` seam)

## Verification

```
pnpm build && pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @agentbox/hub build:standalone
AGENTBOX_HUB_BIN="$PWD/apps/hub/dist-standalone/apps/hub/server.js" node apps/cli/dist/index.js hub restart
ps -p <pid> -o args=            # confirm the fresh bundle is the one running
```

Then, against the local hub:

```
agentbox workspace add ~/Projects/AgentBox     # multi-project: subfolders discovered + registered
agentbox tasks add "Retry failed charges"      # resolves the workspace from the cwd
agentbox create -y -n wstest --tasks T-1,T-2   # assigned to the job, healed to the box id
agentbox tasks list --by-box                   # grouped like the design
agentbox tasks done T-1                        # GET /api/v1/boxes shows tasks {total:2, done:1}
agentbox destroy wstest -y                     # tasks return to the backlog, status untouched
agentbox manager start --agent claude --new    # tmux capture-pane shows the agent really running
agentbox manager stop
```

A `curl -N …/api/events` alongside any of the mutations above must emit a `change` event.
