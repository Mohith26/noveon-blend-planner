# Blend Planner for recycled sintered NdFeB (Noveon concept)

**Live demo:** https://mohith26.github.io/noveon-blend-planner/

An unofficial concept tool for an EcoFlux-style production line: choose which recycled feedstock lots and additives go into an order so that every batch lands in grade, with each lot's assay uncertainty priced in. Not affiliated with Noveon Magnetics. All data is synthetic (`scripts/generate.mjs`, seed 20261111).

## Why

Recycled feedstock is the point of M2M/EcoFlux, and it is also the hard part: an EOL lot of mixed servo motors or e-bike hubs comes with a lab assay, but its Dy content can easily be off by half a weight percent, and every batch made from that lot inherits the error. A common way to plan is to hit the grade's minimum plus a flat safety margin on the mean (for example +1 kOe Hcj). A flat margin can't tell a well-characterised in-house lot from a noisy broker lot, so it either over-spends heavy rare earth on every order or quietly loses yield when a cheap, uncertain lot ends up carrying the blend.

## How it works

1. **Property model.** Br and Hcj are fitted by least squares on 420 past batches (ICP composition vs hysteresisgraph results) as linear functions of bulk Dy, grain-boundary Dy (GBM powder), Tb, Cu, oxygen and effective rare-earth content (TRE minus the RE tied up as oxide). Inside the sintering window this is linear, and the fit's coefficient covariance is kept.
2. **Uncertainty of a blend.** For blend fractions x, the predicted property is linear, mu(x) = a.x, and its variance is batch noise + parameter uncertainty + the assay error of every lot: sigma(x)^2 = s2 + x'(F' S_beta F)x + sum_i x_i^2 g' diag(s_i^2) g. That is convex in x, and because lot errors are independent, spreading an uncertain lot thin really does shrink the variance.
3. **Chance-constrained LP.** Minimise $/kg subject to mass balance, inventory, the TRE_eff window (28.6-30.4 wt%), oxygen <= 5,500 ppm, a recycled-content floor, and P(Br >= min) and P(Hcj >= min) each >= 1 - (1 - target)/2 (Bonferroni for the joint target). Each chance constraint is the second-order cone mu(x) - z sigma(x) >= spec. I solve it with Kelley cutting planes over a small two-phase simplex written from scratch (`core/lp.js`): tangent cuts of the convex sigma(x) are added until the cone constraint holds.
4. **Validation against the true process.** Plans are scored by Monte Carlo against the generator's true coefficients (not the fitted model): lot assays are re-drawn from their uncertainty, shared by every batch from the lot, plus batch noise.

## Results (synthetic, recycled content >= 90%, target 99% first-pass yield)

| Order | Planner yield / $/kg / Dy+Tb kg/t | Flat +80 kA/m, +10 mT | Flat margin tuned to reach 99% (with hindsight) |
|---|---|---|---|
| N42UH EV rotors, 6,000 kg | 99.6% / $46.16 / 45.6 | 89.3% / $45.30 / 45.8 | +160 kA/m: 99.0% / $46.80 / 47.6 |
| N42SH servo, 4,500 kg | 99.7% / $35.95 / 36.8 | 99.1% / $35.65 / 36.7 | +90 kA/m: 99.4% / $35.84 / 36.9 |
| N45SH compressors, 5,000 kg | 99.6% / $36.59 / 36.4 | 97.5% / $36.18 / 36.3 | +100 kA/m: 99.1% / $36.56 / 36.8 |
| N38EH aerospace, 1,200 kg | 99.4% / $48.42 / 51.9 | 99.0% / $48.32 / 51.8 | +90 kA/m: 99.6% / $48.51 / 52.0 |

- On the EV order the flat margin leans on 1,700 kg of mixed servo scrap (Dy +/- 0.60 wt%) and passes 89% of batches. The planner uses 483 kg of it, spreads the rest across better-characterised lots, and passes 99.6% for $0.86/kg more. Predicted Hcj sigma drops from 69 to 44 kA/m.
- To reach 99% with a flat margin you need +160 kA/m, which costs $3,831 more on this order and 4% more Dy+Tb than the planner.
- Honest caveat: on N42SH and N45SH, a flat margin tuned with hindsight against the true process is $0.03-0.11/kg cheaper than the planner. The planner's advantage shows up when a cheap lot has a bad assay; when every candidate lot is well characterised, a well-chosen margin is about as good.

All numbers on the page are recomputed in the browser from `data/plant.json`.

## Run

```
node scripts/generate.mjs          # regenerate data/plant.json
node --test test/*.test.js         # 8 tests
python3 -m http.server             # open http://localhost:8000 (?order=0..3)
```

## Tests

LP solver on textbook problems (including phase 1 and infeasibility); fitted coefficients within 4 standard errors of the true process; variance decomposition identity; every plan obeys mass balance, inventory, TRE_eff window, oxygen cap and recycled floor; the chance constraints hold at the cutting-plane solution; simulated yield >= 98.5% for the planner and < 95% for the flat +80 kA/m margin on the EV order, and the planner beats the hindsight-tuned margin on cost and Dy+Tb there; monotone cost/yield frontier; normal CDF / inverse consistency.

## Honest limitations

- Synthetic everything: lots, assay uncertainties, prices, process coefficients and the linear property model are my assumptions, loosely anchored to public numbers (e.g. GBM additions raising coercivity more per wt% Dy than bulk Dy, as in Noveon's published work with Sepehri-Amin et al.). Real Br/Hcj are not linear across the whole window, and sintering, GBD diffusion and oxygen pickup during milling are not modelled.
- Assay errors are treated as independent Gaussian per element and per lot; correlated errors (same lab, same XRF calibration) would need a full covariance.
- The Bonferroni split of the joint yield target is conservative.
- Chance-constrained blending is a known technique in refinery blending (e.g. Yang 2023, Computers & Chemical Engineering). What's new here is applying it to recycled magnet feedstock with lot-level assay risk and a recycled-content floor.
- No in-app screenshots of Noveon software exist publicly; the UI follows the noveon.co web design system (black header, warm light-gray background, accent #05839F, mono nav). Ballinger Mono (Typekit) is substituted with IBM Plex Mono and the body grotesk with Archivo.

## Novelty

I checked noveon.co (process, EcoFlux, FAQs, publications, news through the Jan 2026 Series C and Solvay/Lynas/LG partnerships), and searched for uncertainty-aware or chance-constrained feedstock planning for recycled NdFeB. Noveon describes real-time QC with "self-correcting actions" but nothing public about planning blends against lot assay uncertainty, and I found no recycled-magnet producer describing it.
