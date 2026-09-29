# AI disclosure

One maintainer and a stack of AI coding agents built Writing Desk.
If AI-assisted code simply isn't acceptable to you, this project isn't for you: no hard feelings, and thanks for reading this far.

## How the code is built

- **Most of the code was written by AI coding agents.** At the time of writing the
  work ran on a model fleet of GLM 5.3 Flash, DeepSeek v4.1 Flash, and Gemma4 31B,
  with GPT 5.6 Luna alongside — from written specifications, in a spec-driven loop:
  requirement → plan → decision record → tests → review → merge. Nothing skips the
  loop, including AI-authored changes.
- **Agent output is untrusted input until it survives review.** It doesn't count as
  engineering because a model produced it; it counts when it passes the same gates
  any human change would face. And this codebase is not "human-written" either — no
  AI-washing in either direction.
- **The human owns the decisions.** Architecture, requirements, security
  boundaries, dependency approvals, and release calls stay with the maintainer;
  agents propose and never decide. The product runs on the same rule — the review
  gate described in the README's structural guarantees is this principle, enforced
  in code.
- **What ships is never patched in place.** Deployed instances run immutable `.deb`
  artifacts; every change is a new package replacing an old one.

## What you can verify here

Publishing deliberately strips the internal documentation. What remains is the
source, the tests that gate it, the packaging, and the license record. The deeper
engineering record — decision records, session reports — exists and stays private.
Judge the release by what is here, not by promises about process.

## Credits

- **[OpenWriter](https://github.com/travsteward/openwriter)** (MIT) — see the
  README's lineage section: the editor chrome descends from it; the review gate,
  agent loop, orchestrator, and packaging are new. © OpenWriter contributors, MIT,
  preserved in [LICENSE](LICENSE).
- **GLM 5.3 Flash · DeepSeek v4.1 Flash · Gemma4 31B · GPT 5.6 Luna** — the model
  fleet driving the coding agents, at the time of writing. It changes as better
  options appear; no single model is represented as the author of this project.
- **[Superpowers](https://github.com/obra/superpowers)** — the open-source skill
  library this engineering loop runs on.

## Corrections

A wrong credit, a missing license notice, or an attribution defect is an
engineering defect like any other: open an issue on this repository and it goes
through the normal fix flow.