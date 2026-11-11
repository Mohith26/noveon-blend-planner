import * as B from './core/blend.js';

const $ = (id) => document.getElementById(id);
const pct = (v, d = 1) => (v * 100).toFixed(d) + '%';
const usd = (v) => '$' + v.toFixed(2);
const fmt = (v, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const STD = { kind: 'margin', hcj: 80, br: 0.01 };
let S = { data: null, models: null, order: 0 };

async function main() {
  const data = await (await fetch('data/plant.json')).json();
  S.data = data;
  S.models = { Br: B.fit(data.history, 'Br'), Hcj: B.fit(data.history, 'Hcj') };
  const q = new URLSearchParams(location.search);
  S.order = Math.max(0, Math.min(data.orders.length - 1, +(q.get('order') || 0)));
  $('orders').innerHTML = data.orders.map((o, i) => `<button data-i="${i}"><span>${o.id} &middot; due ${o.due}</span><b>${o.grade} &middot; ${fmt(o.kg)} kg</b><span>${o.customer}</span></button>`).join('');
  $('orders').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { S.order = +b.dataset.i; run(); }));
  $('yieldSel').onchange = run;
  $('recSel').oninput = () => { $('recVal').textContent = pct(+$('recSel').value, 0); };
  $('recSel').onchange = run;
  $('recVal').textContent = pct(+$('recSel').value, 0);
  renderModel();
  run();
}

function run() {
  const { data, models } = S;
  const o = data.orders[S.order];
  document.querySelectorAll('.nv-orders button').forEach((b) => b.classList.toggle('is-active', +b.dataset.i === S.order));
  const Y = +$('yieldSel').value, R = +$('recSel').value;
  const lots = data.lots;
  const P = B.plan(lots, models, o.grade, o.kg, { kind: 'chance', yield: Y, minRecycled: R });
  const T = B.plan(lots, models, o.grade, o.kg, { ...STD, minRecycled: R });
  if (P.status !== 'optimal' || T.status !== 'optimal') {
    $('kpis').innerHTML = `<div class="nv-kpi"><div class="nv-kpi__label">No feasible blend</div><div class="nv-kpi__value">-</div><div class="nv-kpi__cmp">Lower the recycled-content floor or the yield target.</div></div>`;
    return;
  }
  const simP = B.simulateYield(lots, P.x, data.truth, o.grade);
  const simT = B.simulateYield(lots, T.x, data.truth, o.grade);
  const matched = B.marginForYield(lots, models, data.truth, o.grade, o.kg, Y, 99, R);
  S.last = { o, P, T, simP, simT, matched, Y, R };
  renderKpis();
  renderBlend();
  renderHcj();
  renderVar();
  renderFrontier();
}

function renderKpis() {
  const { o, P, T, simP, simT, matched, Y } = S.last;
  const m = matched.margin !== null ? matched : null;
  const hreSave = m ? 1 - P.hreKgPerT / m.plan.hreKgPerT : null;
  const costDiff = m ? m.plan.costPerKg - P.costPerKg : null;
  const failT = 1 - simT.yield, failP = 1 - simP.yield;
  $('kpis').innerHTML = `
    <div class="nv-kpi"><div class="nv-kpi__label">First-pass yield (simulated)</div><div class="nv-kpi__value">${pct(simP.yield)}</div>
      <div class="nv-kpi__cmp">Flat margin: <b>${pct(simT.yield)}</b> &middot; <span class="up">${(failT / Math.max(failP, 1e-4)).toFixed(0)}x fewer rejects</span></div></div>
    <div class="nv-kpi"><div class="nv-kpi__label">Blend cost</div><div class="nv-kpi__value">${usd(P.costPerKg)}<small>/kg</small></div>
      <div class="nv-kpi__cmp">Flat margin: <b>${usd(T.costPerKg)}</b> &middot; ${m ? `margin for ${pct(Y, 0)}: <b>${usd(m.plan.costPerKg)}</b>` : 'no flat margin reaches the target'}</div></div>
    <div class="nv-kpi"><div class="nv-kpi__label">Dy + Tb in the blend</div><div class="nv-kpi__value">${P.hreKgPerT.toFixed(1)}<small> kg/t</small></div>
      <div class="nv-kpi__cmp">${m ? `Flat margin at ${pct(Y, 0)} yield (+${m.margin} kA/m): <b>${m.plan.hreKgPerT.toFixed(1)}</b> &middot; <span class="${hreSave >= 0 ? 'up' : 'down'}">${pct(Math.abs(hreSave))} ${hreSave >= 0 ? 'less' : 'more'}</span>` : ''}</div></div>
    <div class="nv-kpi"><div class="nv-kpi__label">Recycled content</div><div class="nv-kpi__value">${pct(P.recycledShare, 0)}</div>
      <div class="nv-kpi__cmp">${fmt(P.recycledShare * o.kg)} kg of ${fmt(o.kg)} kg from EOL and in-house scrap${costDiff !== null ? ` &middot; saves <b>$${fmt(costDiff * o.kg)}</b> vs matched margin` : ''}</div></div>`;
}

function renderBlend() {
  const { o, P, T } = S.last;
  const lots = S.data.lots;
  const maxF = Math.max(...P.x, ...T.x);
  const rows = lots.map((l, i) => ({ l, p: P.x[i], t: T.x[i] })).filter((r) => r.p > 1e-4 || r.t > 1e-4);
  $('blendTag').textContent = `${o.grade}: Br ≥ ${B.GRADES[o.grade].Br.toFixed(2)} T · Hcj ≥ ${fmt(B.GRADES[o.grade].Hcj)} kA/m`;
  const dyCell = (l) => {
    const dy = l.assay.DyB + l.assay.DyGB, sd = Math.hypot(l.sd.DyB, l.sd.DyGB);
    const tb = l.assay.Tb ? ` <span class="nv-dim">Tb ${l.assay.Tb.toFixed(2)}</span>` : '';
    return `${dy.toFixed(2)} <span class="${sd >= 0.4 ? 'nv-risk' : 'nv-dim'}">± ${sd.toFixed(2)}</span>${tb}`;
  };
  $('blendTable').innerHTML = `<thead><tr><th>Lot</th><th>Plan kg</th><th>Flat kg</th><th>Dy wt% ± 1σ</th><th>O ppm</th><th>$/kg</th></tr></thead><tbody>${rows.map(({ l, p, t }) => `
    <tr><td><span class="lot">${l.id}</span> ${l.name}<span class="src">${l.source}</span></td>
    <td><span class="nv-bar" style="width:${(p / maxF) * 60}px"></span>${fmt(p * o.kg)}</td>
    <td><span class="nv-bar nv-bar--gray" style="width:${(t / maxF) * 60}px"></span>${fmt(t * o.kg)}</td>
    <td>${dyCell(l)}</td><td>${fmt(l.assay.O)}</td><td>${fmt(l.cost)}</td></tr>`).join('')}</tbody>`;
  const risky = lots.map((l, i) => ({ l, d: T.x[i] - P.x[i] })).filter((r) => Math.hypot(r.l.sd.DyB, r.l.sd.DyGB) >= 0.4 && r.d > 0.01).sort((a, b) => b.d - a.d);
  $('blendNote').innerHTML = risky.length
    ? `The flat margin leans on <b>${risky[0].l.id}</b> (${risky[0].l.name}, Dy ± ${Math.hypot(risky[0].l.sd.DyB, risky[0].l.sd.DyGB).toFixed(2)} wt%): ${fmt(T.x[lots.indexOf(risky[0].l)] * o.kg)} kg vs ${fmt(P.x[lots.indexOf(risky[0].l)] * o.kg)} kg in the plan. One mis-assayed lot moves every batch made from it, so the planner spreads uncertain scrap thin and buys certainty with cheaper, well-characterised lots.`
    : 'Both methods pick similar lots for this order; the planner mainly adjusts additive levels.';
}

function hist(draws, lo, hi, nb) {
  const h = new Array(nb).fill(0);
  for (const v of draws) { const b = Math.floor(((v - lo) / (hi - lo)) * nb); if (b >= 0 && b < nb) h[b]++; }
  return h.map((c) => c / draws.length);
}

function renderHcj() {
  const { o, simP, simT } = S.last;
  const spec = B.GRADES[o.grade].Hcj;
  const all = [...simP.hcjDraws, ...simT.hcjDraws].sort((a, b) => a - b);
  const lo = Math.floor((all[Math.floor(all.length * 0.002)] - 20) / 20) * 20, hi = Math.ceil((all[Math.floor(all.length * 0.998)] + 20) / 20) * 20;
  const nb = 44, W = 540, H = 250, L = 40, R = 12, Tp = 24, Bt = 34;
  const hp = hist(simP.hcjDraws, lo, hi, nb), ht = hist(simT.hcjDraws, lo, hi, nb);
  const maxH = Math.max(...hp, ...ht);
  const X = (v) => L + ((v - lo) / (hi - lo)) * (W - L - R);
  const Y = (f) => H - Bt - (f / maxH) * (H - Bt - Tp);
  const bw = (W - L - R) / nb;
  let g = '';
  for (let t = 0; t <= 4; t++) { const y = Tp + ((H - Bt - Tp) * t) / 4; g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="#e3e2db"/>`; }
  ht.forEach((f, b) => { if (f > 0) g += `<rect x="${L + b * bw + 1}" y="${Y(f)}" width="${bw - 2}" height="${H - Bt - Y(f)}" fill="#A9A8A2" fill-opacity="0.75"/>`; });
  hp.forEach((f, b) => { if (f > 0) g += `<rect x="${L + b * bw + bw * 0.22}" y="${Y(f)}" width="${bw * 0.56}" height="${H - Bt - Y(f)}" fill="#05839F"/>`; });
  g += `<line x1="${X(spec)}" x2="${X(spec)}" y1="${Tp - 10}" y2="${H - Bt}" stroke="#b5541c" stroke-width="2" stroke-dasharray="5 4"/>`;
  g += `<text x="${X(spec) + 6}" y="${Tp - 2}" style="fill:#b5541c" font-weight="600">Hcj min ${fmt(spec)} kA/m</text>`;
  g += `<rect x="${X(spec) + 3}" y="${Tp + 1}" width="292" height="15" fill="#fff" fill-opacity="0.92"/>`;
  g += `<text x="${X(spec) + 6}" y="${Tp + 12}" style="fill:#b5541c">below min: ${pct(1 - simT.yieldHcj)} flat margin, ${pct(1 - simP.yieldHcj)} planner</text>`;
  const step = (hi - lo) > 400 ? 100 : 50;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) g += `<text x="${X(v)}" y="${H - Bt + 15}" text-anchor="middle">${v}</text>`;
  g += `<text x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">Hcj at 20 °C (kA/m), 4,000 simulated batches per method</text>`;
  $('hcjChart').innerHTML = `<svg viewBox="0 0 ${W} ${H}">${g}</svg>`;
  $('simTag').textContent = 'true process, lot assays re-drawn';
}

function renderVar() {
  const { P, T } = S.last;
  const parts = (v) => { const tot = v.noise + v.param + v.assay; return [v.noise / tot, v.param / tot, v.assay / tot, Math.sqrt(tot)]; };
  const cols = ['#45484A', '#A9A8A2', '#05839F'];
  const row = (name, v) => { const p = parts(v); return `<div class="nv-var__row"><span>${name}</span><div class="nv-var__track">${p.slice(0, 3).map((f, i) => `<i style="width:${f * 100}%;background:${cols[i]}"></i>`).join('')}</div><span class="mono">σ ${p[3].toFixed(0)}</span></div>`; };
  $('varParts').innerHTML = `<div class="nv-panel__head" style="margin:0 0 4px"><h2 style="font-size:15px">Where the Hcj uncertainty comes from</h2></div>
    ${row('Planner', P.varHcj)}${row('Flat margin', T.varHcj)}
    <div class="nv-var__key"><span><i class="sw" style="background:${cols[0]}"></i> batch noise</span><span><i class="sw" style="background:${cols[1]}"></i> model coefficients</span><span><i class="sw" style="background:${cols[2]}"></i> lot assays</span></div>
    <table class="nv-table nv-table--tight" style="margin-top:14px"><thead><tr><th>Model check</th><th>Br, T</th><th>P in spec</th><th>Hcj, kA/m</th><th>P in spec</th></tr></thead><tbody>
    ${[['Planner', P], ['Flat margin', T]].map(([n, p]) => `<tr><td>${n}</td><td>${p.Br.mu.toFixed(3)} ± ${p.Br.sd.toFixed(3)}</td><td>${pct(p.pBr, 2)}</td><td>${fmt(p.Hcj.mu)} ± ${fmt(p.Hcj.sd)}</td><td>${pct(p.pHcj, 2)}</td></tr>`).join('')}</tbody></table>`;
}

function renderFrontier() {
  const { o, R } = S.last;
  const { data, models } = S;
  const lots = data.lots;
  const plannerPts = [0.9, 0.95, 0.975, 0.99, 0.995].map((y) => {
    const p = B.plan(lots, models, o.grade, o.kg, { kind: 'chance', yield: y, minRecycled: R });
    if (p.status !== 'optimal') return null;
    return { hre: p.hreKgPerT, y: B.simulateYield(lots, p.x, data.truth, o.grade, 3000).yield, label: pct(y, 1) };
  }).filter(Boolean);
  const marginPts = [0, 40, 80, 120, 160, 200, 250].map((m) => {
    const p = B.plan(lots, models, o.grade, o.kg, { kind: 'margin', hcj: m, br: m * 0.000125, minRecycled: R });
    if (p.status !== 'optimal') return null;
    return { hre: p.hreKgPerT, y: B.simulateYield(lots, p.x, data.truth, o.grade, 3000).yield, label: '+' + m };
  }).filter(Boolean);
  const all = [...plannerPts, ...marginPts];
  const W = 540, H = 260, L = 46, Rr = 14, Tp = 14, Bt = 36;
  const xlo = Math.floor(Math.min(...all.map((p) => p.hre)) - 0.5), xhi = Math.ceil(Math.max(...all.map((p) => p.hre)) + 0.5);
  const ylo = Math.max(0, Math.floor(Math.min(...all.map((p) => p.y)) * 10) / 10), yhi = 1;
  const X = (v) => L + ((v - xlo) / (xhi - xlo)) * (W - L - Rr);
  const Y = (v) => H - Bt - ((v - ylo) / (yhi - ylo)) * (H - Bt - Tp);
  let g = '';
  for (let v = ylo; v <= yhi + 1e-9; v += 0.1) { g += `<line x1="${L}" x2="${W - Rr}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e3e2db"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${pct(v, 0)}</text>`; }
  for (let v = xlo; v <= xhi; v += Math.max(1, Math.round((xhi - xlo) / 6))) g += `<text x="${X(v)}" y="${H - Bt + 15}" text-anchor="middle">${v}</text>`;
  const line = (pts, col, labelAll) => `<polyline fill="none" stroke="${col}" stroke-width="2" points="${pts.map((p) => `${X(p.hre)},${Y(p.y)}`).join(' ')}"/>` + pts.map((p, i) => `<circle cx="${X(p.hre)}" cy="${Y(p.y)}" r="4" fill="${col}"/>` + (labelAll || i === 0 || i === pts.length - 1 ? `<text x="${X(p.hre) + (labelAll ? 6 : i === 0 ? -6 : 6)}" y="${Y(p.y) + (labelAll ? 14 : -8)}" text-anchor="${labelAll || i > 0 ? 'start' : 'end'}" style="fill:${labelAll ? '#5d5f5f' : '#05839F'}">${labelAll ? p.label : (i === 0 ? 'target ' : '') + p.label}</text>` : '')).join('');
  g += line(marginPts.sort((a, b) => a.hre - b.hre), '#A9A8A2', true) + line(plannerPts.sort((a, b) => a.hre - b.hre), '#05839F', false);
  g += `<text x="${(L + W - Rr) / 2}" y="${H - 4}" text-anchor="middle">Dy + Tb in the blend (kg per tonne of magnet)</text>`;
  $('frontier').innerHTML = `<svg viewBox="0 0 ${W} ${H}">${g}</svg>`;
  $('frontierNote').textContent = 'Each point is a full optimised blend, scored on 3,000 simulated batches against the true process. Up and to the left is better: more first-pass yield for less heavy rare earth.';
}

function renderModel() {
  const { Br, Hcj } = S.models;
  const se = (m, j) => Math.sqrt(m.cov[j][j]);
  const units = ['', 'per wt%', 'per wt%', 'per wt%', 'per wt%', 'per 1000 ppm', 'per wt%'];
  $('modelTag').textContent = `${Hcj.n} batches · RMSE ${Hcj.rmse.toFixed(0)} kA/m, ${(Br.rmse * 1000).toFixed(1)} mT`;
  $('modelTable').innerHTML = `<thead><tr><th>Term</th><th>Hcj (kA/m)</th><th>Br (mT)</th></tr></thead><tbody>${B.FEATURES.map((f, j) => `<tr><td>${f} <span class="nv-dim">${units[j]}</span></td><td>${Hcj.beta[j].toFixed(j === 0 ? 0 : 1)} ± ${se(Hcj, j).toFixed(1)}</td><td>${(Br.beta[j] * 1000).toFixed(1)} ± ${(se(Br, j) * 1000).toFixed(1)}</td></tr>`).join('')}</tbody>`;
}

main().catch((e) => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<pre>${e.stack}</pre>`); });
