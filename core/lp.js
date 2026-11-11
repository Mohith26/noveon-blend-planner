// Dense two-phase simplex (Bland's rule) for small LPs:
//   minimize c.x  subject to  rows: a.x (<= | >= | =) b,  x >= 0.
// Returns { status: 'optimal' | 'infeasible' | 'unbounded', x, value }.

const EPS = 1e-9;

export function solveLP(c, rows) {
  const n = c.length;
  const m = rows.length;
  // normalise to b >= 0
  const R = rows.map((r) => {
    let a = r.a.slice(), b = r.b, type = r.type;
    if (b < 0) {
      a = a.map((v) => -v); b = -b;
      type = type === '<=' ? '>=' : type === '>=' ? '<=' : '=';
    }
    return { a, b, type };
  });
  // column layout: x (n) | slack/surplus (one per inequality) | artificial (one per >= or =)
  let nSlack = 0, nArt = 0;
  for (const r of R) { if (r.type !== '=') nSlack++; if (r.type !== '<=') nArt++; }
  const N = n + nSlack + nArt;
  const T = []; // m rows x (N + 1)
  const basis = [];
  let si = n, ai = n + nSlack;
  for (let i = 0; i < m; i++) {
    const r = R[i];
    const row = new Float64Array(N + 1);
    for (let j = 0; j < n; j++) row[j] = r.a[j];
    row[N] = r.b;
    if (r.type === '<=') { row[si] = 1; basis.push(si); si++; }
    else if (r.type === '>=') { row[si] = -1; si++; row[ai] = 1; basis.push(ai); ai++; }
    else { row[ai] = 1; basis.push(ai); ai++; }
    T.push(row);
  }
  const isArt = (j) => j >= n + nSlack;

  function pivot(pr, pc) {
    const prow = T[pr];
    const pv = prow[pc];
    for (let j = 0; j <= N; j++) prow[j] /= pv;
    for (let i = 0; i < m; i++) {
      if (i === pr) continue;
      const f = T[i][pc];
      if (Math.abs(f) < EPS) continue;
      const row = T[i];
      for (let j = 0; j <= N; j++) row[j] -= f * prow[j];
    }
    basis[pr] = pc;
  }

  function run(cost, allowed) {
    for (let iter = 0; iter < 5000; iter++) {
      // reduced costs
      let enter = -1;
      for (let j = 0; j < N; j++) {
        if (!allowed(j) || basis.includes(j)) continue;
        let rc = cost[j];
        for (let i = 0; i < m; i++) rc -= cost[basis[i]] * T[i][j];
        if (rc < -1e-10) { enter = j; break; } // Bland: first improving column
      }
      if (enter < 0) return 'optimal';
      let leave = -1, best = Infinity;
      for (let i = 0; i < m; i++) {
        const a = T[i][enter];
        if (a > EPS) {
          const ratio = T[i][N] / a;
          if (ratio < best - 1e-12 || (Math.abs(ratio - best) <= 1e-12 && basis[i] < basis[leave])) { best = ratio; leave = i; }
        }
      }
      if (leave < 0) return 'unbounded';
      pivot(leave, enter);
    }
    return 'iteration_limit';
  }

  // Phase 1
  if (nArt > 0) {
    const c1 = new Float64Array(N);
    for (let j = n + nSlack; j < N; j++) c1[j] = 1;
    run(c1, () => true);
    let infeas = 0;
    for (let i = 0; i < m; i++) if (isArt(basis[i])) infeas += T[i][N];
    if (infeas > 1e-7) return { status: 'infeasible' };
    // drive remaining (zero-level) artificials out of the basis
    for (let i = 0; i < m; i++) {
      if (!isArt(basis[i])) continue;
      let pc = -1;
      for (let j = 0; j < n + nSlack; j++) if (Math.abs(T[i][j]) > 1e-9) { pc = j; break; }
      if (pc >= 0) pivot(i, pc);
    }
  }
  // Phase 2
  const c2 = new Float64Array(N);
  for (let j = 0; j < n; j++) c2[j] = c[j];
  const st = run(c2, (j) => !isArt(j));
  if (st !== 'optimal') return { status: st };
  const x = new Array(n).fill(0);
  for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] = T[i][N];
  const value = x.reduce((s, v, j) => s + v * c[j], 0);
  return { status: 'optimal', x, value };
}
