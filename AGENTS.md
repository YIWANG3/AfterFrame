# AGENTS.md

Instructions for coding agents (Claude Code, Codex and others) working in this
repository. People: start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Rules

- [CONTRIBUTING.md](CONTRIBUTING.md) applies to agent-made changes too. In
  particular: run `npm run check` and the end-to-end specs for the area you
  touched before you say a change is done, and report which commands you ran
  and what they printed. Don't describe a change as tested when it wasn't.
- New user-visible behaviour gets an end-to-end test in `apps/desktop/e2e/`.
- If an existing spec fails because of your change, find out whether the
  behaviour it checks was meant to change. If it was, update the spec and say
  so; if it wasn't, fix the code. Never weaken a spec just to get a green run.
- Don't change a default or an established behaviour without saying so
  explicitly in the pull request.
- One change per branch, branched from `main`. Don't stack branches.
- Every UI string goes in `apps/desktop/src/i18n/locales/en/` and `zh-CN/`.

## Map

| Path | What |
| --- | --- |
| `apps/desktop/src/` | React renderer |
| `apps/desktop/electron/` | Electron main process, IPC, the MCP server |
| `apps/desktop/e2e/` | Playwright end-to-end specs, run against `dist/` |
| `apps/desktop/native/` | Swift helpers (built, not committed) |
| `services/sidecar/` | Python sidecar: catalog, metadata, jobs |
| `tests/` | Python unit tests |
| `docs/` | Design docs and plans; `docs/developer-setup.md` is the reference |
| `docs/review/` | Code reviews, one file per review: `YYYY-MM-DD-topic.md` |

## Commands

```bash
npm run check                    # lint + unit tests + build (repository root)
npm test                         # unit tests only
cd apps/desktop && npm run build && npx playwright test e2e/<spec>.spec.js
npm run test:e2e                 # the whole e2e suite (~30 min)
```

The specs launch the built renderer (`apps/desktop/dist/`), so rebuild after
every renderer change before running them. They run one at a time and each
launches its own Electron app with a throwaway user-data directory.

## Gotchas

- See "Easy to break" in [CONTRIBUTING.md](CONTRIBUTING.md): catalog schema,
  committed fixtures, the lightbox's CSS layout, hover-only controls, dev
  restarts, native helpers.
- The real catalog belongs to the user. Don't point a dev run or a script at
  a catalog outside the repository unless asked to.
