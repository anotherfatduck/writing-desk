# Writing Desk

A hosted writing app where writers work with an AI agent in plain language — and a human approves every change before it ships.

Writers open a browser and get a desk: a Markdown editor, a library of past articles, and a chat rail. They describe what they want in ordinary language — "tighten the intro, keep my voice" — and an agent proposes edits. The proposals never touch the document directly: they wait on a Review tab as pending changes, shown side by side, until the writer accepts or rejects them. Accepted work is submitted for review, committed to a git branch, and ships only when a human merges it.

The agent is good company and a fast pair of hands; the human is the editor of record. That division is not a UI choice — it is enforced structurally.

## The structural guarantees

- **The chat cannot commit, publish, or run commands.** Not "isn't allowed to" — the tools do not exist in its process. Its entire surface is: read documents, read the workspace, propose edits.
- **Proposed changes live outside the canonical text.** A proposal becomes a pending overlay on the Review tab, never an in-place rewrite. Disk is canonical: plain Markdown files with frontmatter, written atomically, guarded against corruption.
- **Git work happens in a separate process.** An out-of-band orchestrator turns accepted submissions into commits and pull requests, stamps review state, and merges back — no writer process and no chat can touch git.
- **One writer, one process.** A front door handles login and setup, then spawns an isolated child process per writer (idle-stopped when they leave) and proxies to it with per-slot credentials.
- **Secrets are not in env files.** Credentials and per-user model keys live in an AES-256-GCM encrypted store created at first run; the packaged env files carry non-secret configuration only.
- **Models are configuration, not code.** All model access goes through an OpenAI-compatible gateway addressed by an alias, so swapping providers is a settings change.

## The repo

- `server/`, `bin/` — the front door (first-run wizard, auth, per-writer slots, proxy) and the per-writer app server (editor backend, review gate, chat loop)
- `src/` — the editor UI: document tree, review overlay, chat rail, themes, first-run tour
- `orchestrator/` — the git-side state machine: submit → pull request → merge → merge-back, with review stamps and conflict guards
- `shared/` — the encrypted settings store and the chat persona
- `packaging/` — the immutable Debian package: systemd units, conffiles, nginx splice
- `tests/` — the gates that keep all of the above honest

## What running it takes

This was built for one small, specific deployment, and the code says so honestly. It deploys as an immutable `.deb` on a Linux host behind nginx; the approval flow expects a git server speaking Gitea's API (Gitea itself is free software); models come from any OpenAI-compatible gateway (LiteLLM works); writers need nothing but a browser. There is no quickstart — `packaging/` and `orchestrator/deploy/README-ops.md` show the intended shape, and the code is the record of how it was built.

## Lineage

Writing Desk began as a fork of [OpenWriter](https://github.com/travsteward/openwriter) (MIT) — a strong editor whose upstream went dark in July 2026. The editor chrome descends from OpenWriter; the human-approval review gate, the agent loop, the git orchestrator, and the packaging are new. See [LICENSE](LICENSE) for the full attribution.

## License

MIT — see [LICENSE](LICENSE).