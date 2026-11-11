import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as B from '../core/blend.js';
import { solveLP } from '../core/lp.js';

const data = JSON.parse(readFileSync(new URL('../data/plant.json', import.meta.url)));
const models = { Br: B.fit(data.history, 'Br'), Hcj: B.fit(data.history, 'Hcj') };
const order = data.orders[0]; // N42UH, 6,000 kg

test('LP solver: textbook problems', () => {
  // max 3x + 5y s.t. x <= 4, 2y <= 12, 3x + 2y <= 18  -> (2, 6), 36
  const r = solveLP([-3, -5], [
    { a: [1, 0], type: '<=', b: 4 }, { a: [0, 2], type: '<=', b: 12 }, { a: [3, 2], type: '<=', b: 18 }]);
  assert.equal(r.status, 'optimal');
  assert.ok(Math.abs(r.x[0] - 2) < 1e-9 && Math.abs(r.x[1] - 6) < 1e-9 && Math.abs(r.value + 36) < 1e-9);
  // equality + >= needs phase 1: min x + y s.t. x + 2y >= 4, x - y = 1 -> (2, 1)
  const r2 = solveLP([1, 1], [{ a: [1, 2], type: '>=', b: 4 }, { a: [1, -1], type: '=', b: 1 }]);
  assert.ok(Math.abs(r2.x[0] - 2) < 1e-9 && Math.abs(r2.x[1] - 1) < 1e-9);
  assert.equal(solveLP([1], [{ a: [1], type: '<=', b: 1 }, { a: [1], type: '>=', b: 2 }]).status, 'infeasible');
});

test('property model recovers the true process coefficients', () => {
  for (const prop of ['Br', 'Hcj']) {
    const m = models[prop];
    m.beta.forEach((b, j) => {
      const t = data.truth[prop].beta[j];
      const se = Math.sqrt(m.cov[j][j]);
      assert.ok(Math.abs(b - t) < 4 * se, `${prop} coef ${j}: ${b} vs ${t} (se ${se})`);
    });
    assert.ok(Math.abs(m.rmse - data.truth[prop].sd) / data.truth[prop].sd < 0.15);
  }
});

test('predictive variance matches its three-part decomposition', () => {
  const x = data.lots.map(() => 1 / data.lots.length);
  const t = B.blendTerms(data.lots, models.Hcj);
  const { sd } = B.predict(t, x);
  const v = B.varianceParts(data.lots, models.Hcj, x);
  assert.ok(Math.abs(sd * sd - (v.noise + v.param + v.assay)) < 1e-6 * sd * sd);
});

test('every plan respects mass balance, inventory, the sintering window and the recycled floor', () => {
  for (const o of data.orders) {
    for (const policy of [{ kind: 'chance', yield: 0.99, minRecycled: 0.9 }, { kind: 'margin', hcj: 80, br: 0.01, minRecycled: 0.9 }]) {
      const p = B.plan(data.lots, models, o.grade, o.kg, policy);
      assert.equal(p.status, 'optimal');
      assert.ok(Math.abs(p.x.reduce((a, b) => a + b, 0) - 1) < 1e-9);
      p.x.forEach((xi, i) => { assert.ok(xi >= -1e-12); assert.ok(xi * o.kg <= data.lots[i].availKg + 1e-6); });
      const te = B.treEff(p.comp);
      assert.ok(te >= B.WINDOW.treEffMin - 1e-9 && te <= B.WINDOW.treEffMax + 1e-9);
      assert.ok(p.comp.O <= B.WINDOW.oMax + 1e-6);
      assert.ok(p.recycledShare >= 0.9 - 1e-9);
    }
  }
});

test('chance constraint holds at the solution (cutting planes converged)', () => {
  const p = B.plan(data.lots, models, order.grade, order.kg, { kind: 'chance', yield: 0.99, minRecycled: 0.9 });
  const spec = B.GRADES[order.grade];
  assert.ok(p.Hcj.mu - p.policy.zEach * p.Hcj.sd >= spec.Hcj - 1e-3);
  assert.ok(p.Br.mu - p.policy.zEach * p.Br.sd >= spec.Br - 1e-6);
  assert.ok(p.pBr * p.pHcj >= 0.99 - 1e-3);
});

test('planned yield holds against the true process; flat 80 kA/m margin does not on the EV order', () => {
  const p = B.plan(data.lots, models, order.grade, order.kg, { kind: 'chance', yield: 0.99, minRecycled: 0.9 });
  const t = B.plan(data.lots, models, order.grade, order.kg, { kind: 'margin', hcj: 80, br: 0.01, minRecycled: 0.9 });
  const sp = B.simulateYield(data.lots, p.x, data.truth, order.grade, 4000, 7);
  const st = B.simulateYield(data.lots, t.x, data.truth, order.grade, 4000, 7);
  assert.ok(sp.yield >= 0.985, `planner ${sp.yield}`);
  assert.ok(st.yield < 0.95, `flat ${st.yield}`);
  // and it is cheaper and leaner in Dy+Tb than the flat margin that reaches the same yield
  const m = B.marginForYield(data.lots, models, data.truth, order.grade, order.kg, 0.99, 99, 0.9);
  assert.ok(m.margin !== null);
  assert.ok(p.costPerKg < m.plan.costPerKg);
  assert.ok(p.hreKgPerT < m.plan.hreKgPerT);
});

test('higher yield targets cost more and never lower predicted yield (monotone frontier)', () => {
  let prev = null;
  for (const y of [0.9, 0.95, 0.99, 0.995]) {
    const p = B.plan(data.lots, models, order.grade, order.kg, { kind: 'chance', yield: y, minRecycled: 0.9 });
    if (prev) { assert.ok(p.costPerKg >= prev.costPerKg - 1e-9); assert.ok(p.pBr * p.pHcj >= prev.pBr * prev.pHcj - 1e-6); }
    prev = p;
  }
});

test('inverse normal and normal CDF agree', () => {
  for (const p of [0.001, 0.025, 0.5, 0.9, 0.995]) assert.ok(Math.abs(B.normCdf(B.invNorm(p)) - p) < 2e-6);
});
