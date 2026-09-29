# Installing Writing Desk

Writing Desk deploys as a single immutable Debian package: web front door,
per-writer editor slots, the git orchestrator, and the nginx claim all live in
one `.deb`. There is no Docker, no compose file, no config to wire by hand —
install the package, walk the first-run wizard, done.

## What you need

- A Linux host with `dpkg` (Debian, Ubuntu, or a derivative) and nginx available
  for the package to claim its vhost on.
- A git server speaking the Gitea API (Gitea itself is free software) hosting
  your library repo — accepted drafts become branches and pull requests there.
- An OpenAI-compatible model gateway (LiteLLM works), reachable from the host.
- Writers need nothing but a browser.

## Build

Off-host (any machine with `npm`; the build runs both test suites first):

    bash scripts/build-deb

The artifact lands at `artifacts/deb/writing-desk_<version>_all.deb`.

## Install

    scp artifacts/deb/writing-desk_<version>_all.deb your-host:/tmp/
    ssh your-host sudo dpkg -i /tmp/writing-desk_<version>_all.deb

The package's postinst is idempotent and does everything itself: creates the
service users and state directories, claims the nginx vhost, self-enables and
restarts `writing-desk.service` and `writing-desk-orchestrator.service`. Nothing
to enable by hand.

The app boots to "not configured" and the first visit to the URL serves the
init wizard.

## First run

1. Visit the site once and complete setup: your name, library repo URL, Gitea
   credentials, optional model key. Setup is first-claim — whoever completes the
   wizard owns the instance, so fill it in promptly on a fresh install.
2. Log in with the admin token (shown once at init — copy it now).
3. Under `/admin`: create writers, rotate view keys and Gitea credentials.
4. Point the model route at your gateway: the alias lives in
   `/etc/writing-desk/app.env` (`AGENT_MODEL`). App secrets are collected in the
   browser at setup and stored encrypted — env files carry non-secret
   configuration only.

## Verify

    1. systemctl status writing-desk writing-desk-orchestrator — both active
    2. curl -k https://<host>/api/status — 200; "configured":false until setup
    3. One real chat turn from the browser UI
    4. Review-accept a chat proposal — it applies to the draft
    5. Submit a draft — the orchestrator ships a PR to the library repo;
       merging it in Gitea is what publishes

## Upgrade and rollback

Every change is a new package: `dpkg -i` the new `.deb` to upgrade, the previous
`.deb` to roll back. Code is dpkg-owned and never patched in place; writer state
and the encrypted store are never touched by the package.

## The full runbook

Host prerequisites, per-host env contracts, the tunnel option, the collision
rule, and the backup gate are in [orchestrator/deploy/README-ops.md](orchestrator/deploy/README-ops.md).