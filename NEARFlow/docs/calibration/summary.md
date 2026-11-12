# Controller-only synthetic calibration v1

Completed sweep: 216 joint profiles, 8 scenarios, three training and three held-out seeds, both signs and modes.
Experimental engineering-budget winner: **c177**. Contract defaults remain unchanged.

| Profile | Mode | Split | Mean tracking error (ppm) | Total rate variation (ppm) | Wrong-sign samples | Longest wrong-sign run | Mean noise rate (absolute ppm) |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| default | BASELINE | train | 76.388 | 1083958 | 86 | 4 | 60.635 |
| default | BASELINE | holdout | 77.316 | 1085262 | 94 | 4 | 56.333 |
| default | ADAPTIVE | train | 624.014 | 207908 | 180 | 4 | 0.000 |
| default | ADAPTIVE | holdout | 618.950 | 207900 | 174 | 4 | 0.000 |
| c177 | BASELINE | train | 0.000 | 1147934 | 0 | 0 | 110.448 |
| c177 | BASELINE | holdout | 0.000 | 1151212 | 0 | 0 | 104.354 |
| c177 | ADAPTIVE | train | 511.378 | 237900 | 90 | 4 | 67.448 |
| c177 | ADAPTIVE | holdout | 512.775 | 238608 | 104 | 4 | 59.927 |

Tracking target is the exogenous raw premium clamped to 2000 ppm; this is an engineering proxy, not the economically optimal funding rate.
Lower tracking error can come with more rate variation and noise. Baseline has no adaptive slope limit and may beat adaptive tracking; smoothing is not assumed to be an improvement.
No price response, liquidity, vault feedback, custody, liquidation, costs, delta or P&L is simulated. No live-market, closed-loop calibration or deployment claim follows.

Full parameters, source hashes/revision/dirty state, per-seed/sign input hashes, all candidate metrics and selected/default per-scenario comparisons: [report.json](report.json).
Exact aggregate metrics: [results.csv](results.csv). Replay from client/: `npm run funding:calibrate`.
