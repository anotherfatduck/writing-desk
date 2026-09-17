# writing-desk — ops runbook (M4d)

One package installs everything: front door + git orchestrator + units + nginx
claim (ADR-0001: immutable .deb, dpkg is the idempotency engine, rollback =
install the previous version). The front door spawns and idle-stops per-user
editor slots itself (ADR-0008) — **there are no per-writer units or env
templates to provision**.

## One-time host prereqs (human, before first install)

1. Gitea bot user `writer-orchestrator`; invite as collaborator (write) on the
   library repo **only** — the membership is the permission boundary. No 2FA (bot
   accounts), no other memberships.
2. Edge rider (optional): put `TUNNEL_TOKEN=<token>` in
   `/etc/writer-host-01/cloudflared.env` — postinst enables
   `writing-desk-cloudflared.service` only when that token is non-empty.

## Install

    bash scripts/build-deb        # off-host (npm-only LXC per ADR-0001); runs both suites
    scp artifacts/deb/writing-desk_<ver>_all.deb writer-host-01:/tmp/
    ssh writer-host-01 sudo dpkg -i /tmp/writing-desk_<ver>_all.deb

postinst (idempotent) creates the service users + state dirs, makes
`/etc/writing-desk/runtime` and `/var/lib/writing-desk` setgid 2750
group `writing-desk` and adds `writing-desk-orch` to that group — the shared
group is how the orchestrator reads the encrypted store and the master key —
claims the nginx vhost, and self-enables + restarts `writing-desk.service`
+ `writing-desk-orchestrator.service` (restart, not `--now`, so an upgrade also
swaps the running processes). Nothing to enable by hand: the app boots to
"not configured" — the first visit to the URL serves the init wizard (M4e: no
setup token; first claim wins); the orchestrator idles until the store exists.

## Config + env (static layout only)

- `/etc/writing-desk/orchestrator.config.json` (packaged conffile,
  root:writing-desk 0640, read by the orchestrator via the shared group):
  static layout only — workspacesBase, cloneDir, mainBranch, mergeDir,
  branchPrefix, pollIntervalMs, stateDir, git identity, Gitea API base. NO
  `writerRoots`, NO `repo`: the roster, repo URL, and Gitea creds are read from
  the encrypted store on every poll, so init/add-writer/cred changes need no
  config edit and no restart. Reference shape:
  `orchestrator/deploy/config.example.json`.
- Per-host env contract (infra-owned 0600; template
  `/usr/lib/writing-desk/templates/writer.env.example`):
  writer-host-01 → `/etc/writer-host-01/writer.env` (`WRITER1_*` names);
  writer-host-02 → `/etc/writer-host-02/writer.env` (`WRITER2_*` names).
  Carries the site URL + LiteLLM stunnel base (port 11440); the units source
  both dash-prefixed, so only the host's own file needs to exist.
- `/etc/writing-desk/app.env` (app-owned packaged conffile, 0640):
  `AGENT_MODEL` — the fixed estate route alias. App secrets never go in env
  files: the store holds them (ADR-0009).
  Per-batch editor-slot knobs (`WRITER_SLOT_PORT_BASE`, `WRITER_SLOT_IDLE_MS`) stay code-level defaults (5100 / 15 min) — undocumented in env files on purpose; raise an ops change if a host ever needs different values.

## Secrets (ADR-0009)

App-collected secrets (Gitea collab credentials, per-user VKs) live only in the
encrypted store `/var/lib/writing-desk/settings.enc` (master key in
`/etc/writing-desk/runtime`) and are typed into the browser at setup — no
sops, no secret env files. The `GITEA_BASIC_USER` / `GITEA_BASIC_PASS`
environment fallback in `orchestrator/gitea.ts` is test/dev only; prod reads
the store. Infra-owned files (tunnel token) follow ADR-0001 as before.

## First run (the operator's part)

1. Visit the site once and complete setup: your name, library URL, Gitea
   credentials, optional model key. The wizard is first-claim (M4e dropped the
   setup token — the only audience was the installer, and the secrets are
   disposable), so on a fresh install fill it in promptly.
2. Log in with the admin token (shown once at init — copy it now); create
   writers, replace VKs and Gitea creds at `/admin`.

## Verify (checklist)

    1. systemctl status writing-desk writing-desk-orchestrator — both active
    2. curl -k https://<host>/api/status — 200; "configured":false until setup
    3. One real chat turn from the browser UI — conductor answers through stunnel
    4. Review-accept a chat proposal — pending overlay resolves, provenance lands
    5. First real submit-cycle: draft → chat proposes → Review accept → submit →
       orchestrator ships the PR to the library → merge in Gitea

## Rollback + durable rules

- Rollback: install the previous .deb (dpkg -i downgrade). Code under
  /opt/writing-desk is dpkg-owned; state under /srv/writer-app and the
  store are never touched by the package.
- ⚠ Collision rule (durable): once installed, the provisioning play
  must never be re-run unconditionally — it re-renders the placeholder vhost
  and re-asserts root:root on the state tree, reverting the app's claims.
  Coordinate with infra before any re-run (the infra-collision gotcha in
  internal ops notes).
- Backups gate: hypervisor-side nightly backup (≥14d retention) confirmed **and
  restore-tested** before pilot traffic; until then Gitea stays the durable
  copy for committed content (no app-level backup transport).