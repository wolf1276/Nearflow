# Mandatory workflow: Ponytail

Use the **Ponytail** skill for every coding, debugging, refactoring and review task in this project. Read its `SKILL.md` before making changes; use the default `full` level unless the user chooses another level.

Current local installation:
`/home/ahir/.codex/plugins/cache/ponytail/ponytail/5.3.3/skills/ponytail/SKILL.md`

If that installation moves, locate the installed Ponytail skill. If unavailable, report it rather than claiming to have used it; follow the principles below until it is restored.

- Inspect affected code, callers, tests, fixtures and configuration first.
- Make the smallest complete change; reuse existing exchange code and installed dependencies. No speculative features or parallel spendable balances.
- Never cut authorization, trust-boundary validation, money/accounting invariants, failure recovery or accessibility.
- Test every non-trivial money/security path and preserve existing regressions.
- Preserve funded state. Storage-incompatible changes require an explicit reviewed deployment/migration policy; never reset an initialized funded contract.
- Distinguish PAPER, local Sandbox and public testnet evidence. Never invent deployment addresses, receipts or test results.
- End reports with what was skipped/not checked and material risks.

Also follow nested instructions, including `client/AGENTS.md` when touching the client.
