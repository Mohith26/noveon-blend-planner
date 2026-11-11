// Chance-constrained feedstock blend planner for recycled sintered NdFeB.
//
// Property model: Br and Hcj are linear in a handful of composition features inside the sintering window
// (bulk Dy, grain-boundary Dy from GBM powder, Tb, Cu, oxygen, effective rare-earth content). It is fitted
// by least squares on past production batches, which also gives the parameter covariance.
// Uncertainty of a planned blend has three parts:
//   batch noise (residual sigma^2) + parameter uncertainty f' S_beta f + assay error of each lot sum_i x_i^2 g' diag(s_i^2) g
// so sigma(x)^2 = s2 + x' M x with M positive semidefinite. A spec "P(Hcj >= spec) >= 1 - a" becomes the
// second-order-cone constraint mu(x) - z * sigma(x) >= spec, solved with Kelley cutting planes over an LP.

import { solveLP } from './lp.js';
import { mulberry32, normal } from './rng.js';

export const COMP = ['Nd', 'Pr', 'DyB', 'DyGB', 'Tb', 'Co', 'Cu', 'O']; // wt%; O in ppm
export const FEATURES = ['intercept', 'Dy (bulk)', 'Dy (grain boundary)', 'Tb', 'Cu', 'O (1000 ppm)', 'TRE_eff - 29'];
export const WINDOW = { treEffMin: 28.6, treEffMax: 30.4, oMax: 5500 };
export const GRADES = {
  N42SH: { Br: 1.29, Hcj: 1592, use: 'Industrial servo motors' },
  N42UH: { Br: 1.28, Hcj: 1990, use: 'EV traction rotors' },
  N45SH: { Br: 1.32, Hcj: 1592, use: 'Compressor motors' },
  N38EH: { Br: 1.22, Hcj: 2388, use: 'Aerospace actuators' },
};

export const tre = (c) => c.Nd + c.Pr + c.DyB + c.DyGB + c.Tb;
export const treEff = (c) => tre(c) - 0.0006 * c.O;
export const hre = (c) => c.DyB + c.DyGB + c.Tb;

export function features(c) {
  return [1, c.DyB, c.DyGB, c.Tb, c.Cu, c.O / 1000, treEff(c) - 29];
}
// d(feature)/d(composition) for each composition key (constant matrix, rows = features)
export function featureJacobian() {
  const J = FEATURES.map(() => Object.fromEntries(COMP.map((k) => [k, 0])));
  J[1].DyB = 1; J[2].DyGB = 1; J[3].Tb = 1; J[4].Cu = 1; J[5].O = 1 / 1000;
  for (const k of ['Nd', 'Pr', 'DyB', 'DyGB', 'Tb']) J[6][k] = 1;
  J[6].O = -0.0006;
  return J;
}

export function mix(lots, x) {
  const c = Object.fromEntries(COMP.map((k) => [k, 0]));
  lots.forEach((l, i) => { for (const k of COMP) c[k] += x[i] * l.assay[k]; });
  return c;
}

// ---------- small dense linear algebra ----------
export function invert(A) {
  const n = A.length;
  const M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const pv = M[c][c];
    if (Math.abs(pv) < 1e-14) throw new Error('singular matrix');
    for (let j = 0; j < 2 * n; j++) M[c][j] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f) for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((r) => r.slice(n));
}
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const matVec = (A, v) => A.map((r) => dot(r, v));

// ---------- fit ----------
export function fit(history, prop) {
  const X = history.map((h) => features(h.comp));
  const y = history.map((h) => h[prop]);
  const p = X[0].length, n = X.length;
  const XtX = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0)));
  const Xty = Array.from({ length: p }, (_, i) => X.reduce((s, r, k) => s + r[i] * y[k], 0));
  const XtXi = invert(XtX);
  const beta = matVec(XtXi, Xty);
  const rss = X.reduce((s, r, k) => s + (y[k] - dot(r, beta)) ** 2, 0);
  const s2 = rss / (n - p);
  const cov = XtXi.map((r) => r.map((v) => v * s2));
  // gradient of the mean w.r.t. composition (for assay-error propagation)
  const J = featureJacobian();
  const grad = Object.fromEntries(COMP.map((k) => [k, J.reduce((s, row, f) => s + row[k] * beta[f], 0)]));
  return { prop, beta, s2, cov, grad, n, rmse: Math.sqrt(s2) };
}

// ---------- prediction for a blend ----------
export function blendTerms(lots, model) {
  const F = lots.map((l) => features(l.assay)); // feature vector of each lot (affine map + sum x = 1)
  const a = F.map((f) => dot(model.beta, f)); // mean is linear: mu(x) = a.x
  const n = lots.length;
  const M = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => dot(F[i], matVec(model.cov, F[j]))));
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (const k of COMP) d += (model.grad[k] * lots[i].sd[k]) ** 2;
    M[i][i] += d;
  }
  return { a, M, s2: model.s2 };
}
export function predict(terms, x) {
  const mu = dot(terms.a, x);
  const sd = Math.sqrt(terms.s2 + dot(x, matVec(terms.M, x)));
  return { mu, sd };
}
// decompose the predictive variance into its three sources
export function varianceParts(lots, model, x) {
  const F = lots.map((l) => features(l.assay));
  const f = F[0].map((_, j) => F.reduce((s, fi, i) => s + x[i] * fi[j], 0));
  const param = dot(f, matVec(model.cov, f));
  let assay = 0;
  lots.forEach((l, i) => { for (const k of COMP) assay += (x[i] * model.grad[k] * l.sd[k]) ** 2; });
  return { noise: model.s2, param, assay };
}

// inverse standard normal CDF (Acklam)
export function invNorm(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) return -invNorm(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
export function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

// ---------- planner ----------
// policy: { kind: 'chance', yield } (joint first-pass yield target, split evenly over Br and Hcj)
//      or { kind: 'margin', hcj, br } (deterministic: mean >= spec + flat margin, ignores lot uncertainty)
export function plan(lots, models, grade, orderKg, policy) {
  const n = lots.length;
  const spec = GRADES[grade];
  const tB = blendTerms(lots, models.Br), tH = blendTerms(lots, models.Hcj);
  const cost = lots.map((l) => l.cost);
  const base = [];
  base.push({ a: Array(n).fill(1), type: '=', b: 1 });
  lots.forEach((l, i) => { const a = Array(n).fill(0); a[i] = 1; base.push({ a, type: '<=', b: l.availKg / orderKg }); });
  base.push({ a: lots.map((l) => treEff(l.assay)), type: '>=', b: WINDOW.treEffMin });
  base.push({ a: lots.map((l) => treEff(l.assay)), type: '<=', b: WINDOW.treEffMax });
  base.push({ a: lots.map((l) => l.assay.O), type: '<=', b: WINDOW.oMax });
  if (policy.minRecycled) base.push({ a: lots.map((l) => (l.recycled ? 1 : 0)), type: '>=', b: policy.minRecycled });

  if (policy.kind === 'margin') {
    const rows = [...base,
      { a: tH.a, type: '>=', b: spec.Hcj + policy.hcj },
      { a: tB.a, type: '>=', b: spec.Br + policy.br }];
    const r = solveLP(cost, rows);
    if (r.status !== 'optimal') return { status: r.status };
    return finish(lots, models, grade, r.x, tB, tH, { ...policy }, 0);
  }
  const zEach = invNorm(1 - (1 - policy.yield) / 2);
  const cuts = [];
  let x = null, iters = 0;
  for (iters = 0; iters < 80; iters++) {
    const rows = [...base,
      { a: tH.a, type: '>=', b: spec.Hcj },
      { a: tB.a, type: '>=', b: spec.Br },
      ...cuts];
    const r = solveLP(cost, rows);
    if (r.status !== 'optimal') return { status: r.status, iters };
    x = r.x;
    let worst = 0;
    for (const [t, s] of [[tH, spec.Hcj], [tB, spec.Br]]) {
      const { mu, sd } = predict(t, x);
      const viol = s - (mu - zEach * sd);
      const scale = t === tH ? 1 : 1000; // compare Br violations in mT
      if (viol * scale > 1e-4) {
        worst = Math.max(worst, viol * scale);
        // tangent cut of the convex sigma(x): sigma(x) >= g.x + s2/sigma_k, g = M x_k / sigma_k
        const g = matVec(t.M, x).map((v) => v / sd);
        cuts.push({ a: t.a.map((ai, i) => ai - zEach * g[i]), type: '>=', b: s + zEach * (t.s2 / sd) });
      }
    }
    if (worst === 0) break;
  }
  return finish(lots, models, grade, x, tB, tH, { ...policy, zEach }, iters);
}

function finish(lots, models, grade, x, tB, tH, policy, iters) {
  const spec = GRADES[grade];
  const c = mix(lots, x);
  const pB = predict(tB, x), pH = predict(tH, x);
  const costPerKg = lots.reduce((s, l, i) => s + x[i] * l.cost, 0);
  const recycled = lots.reduce((s, l, i) => s + (l.recycled ? x[i] : 0), 0);
  return {
    status: 'optimal', x, comp: c, policy, iters,
    Br: pB, Hcj: pH,
    pBr: normCdf((pB.mu - spec.Br) / pB.sd), pHcj: normCdf((pH.mu - spec.Hcj) / pH.sd),
    costPerKg, hreKgPerT: hre(c) * 10, recycledShare: recycled,
    varHcj: varianceParts(lots, models.Hcj, x), varBr: varianceParts(lots, models.Br, x),
  };
}

// ---------- Monte Carlo against the true process ----------
// Lot assays are wrong by a draw from each lot's assay error (shared by every batch made from that lot),
// and every batch adds process noise. Truth uses the generator's coefficients, not the fitted ones.
export function simulateYield(lots, x, truth, grade, nSim = 4000, seed = 99) {
  const rand = mulberry32(seed);
  const spec = GRADES[grade];
  let pass = 0, passB = 0, passH = 0;
  const hcjDraws = [];
  for (let s = 0; s < nSim; s++) {
    const trueLots = lots.map((l) => ({ assay: Object.fromEntries(COMP.map((k) => [k, l.assay[k] + l.sd[k] * normal(rand)])) }));
    const c = mix(trueLots, x);
    const f = features(c);
    const Br = dot(truth.Br.beta, f) + truth.Br.sd * normal(rand);
    const Hcj = dot(truth.Hcj.beta, f) + truth.Hcj.sd * normal(rand);
    const okB = Br >= spec.Br, okH = Hcj >= spec.Hcj;
    passB += okB; passH += okH; pass += okB && okH;
    hcjDraws.push(Hcj);
  }
  return { yield: pass / nSim, yieldBr: passB / nSim, yieldHcj: passH / nSim, hcjDraws };
}

// Smallest flat Hcj margin (Br margin scaled alongside) whose plan reaches the target yield in simulation.
export function marginForYield(lots, models, truth, grade, orderKg, target, seed = 99, minRecycled = 0) {
  const sweep = [];
  for (let m = 0; m <= 400; m += 10) {
    const p = plan(lots, models, grade, orderKg, { kind: 'margin', hcj: m, br: m * 0.000125, minRecycled });
    if (p.status !== 'optimal') { sweep.push({ margin: m, status: p.status }); continue; }
    const sim = simulateYield(lots, p.x, truth, grade, 3000, seed);
    sweep.push({ margin: m, plan: p, sim });
    if (sim.yield >= target) return { margin: m, plan: p, sim, sweep };
  }
  return { margin: null, sweep };
}
