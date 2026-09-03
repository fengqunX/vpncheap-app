# CLAUDE.md — vpncheap-app

> Release and auto-update distribution repository for the VPNCheap clients. This repository is PUBLIC: keep internal notes out of it. The rule below is duplicated in `AGENTS.md` on purpose and must stay in sync.

## ⛔ Branch hygiene — main is main

- **`main` is the only trunk of this repository.** No other actively maintained branch may act as a de facto main. This repository holds releases and auto-update metadata only; do not open working branches here.
- **Every asset published here must be built from a commit on the default branch of its source repository.** Never attach a build from a side branch, and never tag a release at a commit that is not on that default branch.
- **`archive/*` branches are read-only history.** Never merge one back.
