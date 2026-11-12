# Market / PAPER-vault feedback calibration v1

30240 deterministic runs; 15 joint profiles, 14 scenarios, 3 training + 3 independent holdout seeds, both demand signs, zero/weak/strong funding responsiveness, baseline/adaptive and vault off/on.

Training winner: **none**. Holdout-accepted profile: **none**. Contract defaults and real authority remain unchanged.

| Profile | Mode | Vault | Response ppm | Holdout mean absolute book premium ppm | Mean vault net P&L (quote atoms) | Worst drawdown (quote atoms) | Cost/run (quote atoms) | Residual-delta breach hours |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| default | BASELINE | off | 0 | 6676 | 0 | 0 | 0 | 0 |
| default | BASELINE | off | 100000 | 5332 | 0 | 0 | 0 | 0 |
| default | BASELINE | off | 1000000 | 3806 | 0 | 0 | 0 | 0 |
| default | BASELINE | on | 0 | 6517 | -168512 | 37696364 | 888163 | 144 |
| default | BASELINE | on | 100000 | 5194 | -435801 | 37633522 | 821168 | 144 |
| default | BASELINE | on | 1000000 | 3690 | -537589 | 37494019 | 728017 | 121 |
| default | ADAPTIVE | off | 0 | 6676 | 0 | 0 | 0 | 0 |
| default | ADAPTIVE | off | 100000 | 5597 | 0 | 0 | 0 | 0 |
| default | ADAPTIVE | off | 1000000 | 3918 | 0 | 0 | 0 | 0 |
| default | ADAPTIVE | on | 0 | 6510 | -527490 | 37189562 | 670604 | 144 |
| default | ADAPTIVE | on | 100000 | 5448 | -763292 | 37129477 | 638861 | 144 |
| default | ADAPTIVE | on | 1000000 | 3807 | -560758 | 36932315 | 547035 | 98 |
| c177 | BASELINE | off | 0 | 6676 | 0 | 0 | 0 | 0 |
| c177 | BASELINE | off | 100000 | 5310 | 0 | 0 | 0 | 0 |
| c177 | BASELINE | off | 1000000 | 3737 | 0 | 0 | 0 | 0 |
| c177 | BASELINE | on | 0 | 6505 | -33648 | 37698990 | 809756 | 144 |
| c177 | BASELINE | on | 100000 | 5161 | -307027 | 37644087 | 743367 | 144 |
| c177 | BASELINE | on | 1000000 | 3617 | -439767 | 37545757 | 673599 | 121 |
| c177 | ADAPTIVE | off | 0 | 6676 | 0 | 0 | 0 | 0 |
| c177 | ADAPTIVE | off | 100000 | 5461 | 0 | 0 | 0 | 0 |
| c177 | ADAPTIVE | off | 1000000 | 3848 | 0 | 0 | 0 | 0 |
| c177 | ADAPTIVE | on | 0 | 6519 | -294283 | 36541388 | 775198 | 144 |
| c177 | ADAPTIVE | on | 100000 | 5324 | -519090 | 36482438 | 720057 | 144 |
| c177 | ADAPTIVE | on | 1000000 | 3740 | -873019 | 36313958 | 615734 | 144 |

Money/base atoms use 1e6 scale. Mean P&L includes marked residual inventory; it is not settled withdrawable profit. Positive carry can lose money during a crash when the perp gain cap binds. Spot outages/counterparty exits leave visible unresolved exposure; retries stop rather than silently restoring a hedge.

All measured negative/no-improvement cases are retained. Default baseline is the fixed reference; default and candidate same-profile baseline/adaptive ablations are also included.
This completes the specified local-model calibration, not live-market validation or the runtime automation release gate. No claim of profitability, robustness outside these assumptions, production calibration or deployment approval.

Reproduce from client/: `npm run funding:feedback`. [Full provenance, assumptions, parameters, rejection reasons and scenario aggregates](report.json); [every run](runs.csv); [failure/decision replay traces](traces.json).
