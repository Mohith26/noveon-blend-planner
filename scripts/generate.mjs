// Seeded synthetic feedstock inventory, production history and an open order.
// node scripts/generate.mjs -> data/plant.json
import { writeFileSync, mkdirSync } from 'node:fs';
import { mulberry32, normal, uniform } from '../core/rng.js';
import { COMP, features } from '../core/blend.js';

const SEED = 20261111;
const rand = mulberry32(SEED);
const N = (s = 1) => s * normal(rand);
const r2 = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

// "True" process (unknown to the planner): Br in tesla, Hcj in kA/m, linear inside the sintering window.
const TRUTH = {
  Br: { beta: [1.452, -0.0158, -0.0095, -0.0125, -0.006, -0.0045, -0.017], sd: 0.0065 },
  Hcj: { beta: [770, 288, 425, 545, 150, -52, 38], sd: 28 },
};

// Feedstock lots on hand (assay = lab result used for planning, sd = assay + within-lot uncertainty).
const z = () => Object.fromEntries(COMP.map((k) => [k, 0]));
const lot = (id, name, source, kg, cost, assay, sd, recycled = true) => ({ id, name, source, availKg: kg, cost, assay: { ...z(), ...assay }, sd: { ...z(), ...sd }, recycled });
const lots = [
  lot('L-2611', 'HDD voice-coil magnets', 'Data-center decommissioning', 2600, 38, { Nd: 23.4, Pr: 6.1, DyB: 0.35, Co: 1.1, Cu: 0.12, O: 4100 }, { Nd: 0.5, Pr: 0.3, DyB: 0.06, Cu: 0.02, O: 350 }),
  lot('L-2614', 'EV traction rotors (mixed OEM)', '2nd-life EV recycler', 1400, 61, { Nd: 20.6, Pr: 5.2, DyB: 5.1, Tb: 0.38, Co: 1.3, Cu: 0.14, O: 3000 }, { Nd: 0.6, Pr: 0.4, DyB: 0.42, Tb: 0.12, Cu: 0.03, O: 420 }),
  lot('L-2617', 'Compressor motors (M2M program)', 'Appliance take-back', 1900, 47, { Nd: 22.8, Pr: 5.6, DyB: 2.15, Co: 0.9, Cu: 0.11, O: 3500 }, { Nd: 0.4, Pr: 0.3, DyB: 0.14, Cu: 0.02, O: 300 }),
  lot('L-2620', 'Wind generator segments', 'Repowering contractor', 1200, 55, { Nd: 21.9, Pr: 5.5, DyB: 3.4, Co: 0.6, Cu: 0.1, O: 2600 }, { Nd: 0.3, Pr: 0.2, DyB: 0.11, Cu: 0.02, O: 220 }),
  lot('L-2622', 'Grinding swarf (in-house)', 'San Marcos finishing line', 3000, 22, { Nd: 22.1, Pr: 5.6, DyB: 2.8, Co: 1.0, Cu: 0.12, O: 7400 }, { Nd: 0.2, Pr: 0.1, DyB: 0.04, Cu: 0.01, O: 380 }),
  lot('L-2625', 'Servo motor scrap (mixed)', 'Industrial broker', 1700, 41, { Nd: 21.7, Pr: 5.4, DyB: 3.0, Co: 2.0, Cu: 0.13, O: 3900 }, { Nd: 0.8, Pr: 0.5, DyB: 0.6, Cu: 0.04, O: 850 }),
  lot('L-2628', 'Off-spec sintered blocks', 'In-house QA hold', 900, 30, { Nd: 22.3, Pr: 5.7, DyB: 3.1, Co: 1.0, Cu: 0.12, O: 2800 }, { Nd: 0.15, Pr: 0.1, DyB: 0.03, Cu: 0.01, O: 150 }),
  lot('L-2630', 'E-bike hub motors (mixed)', 'Micromobility recycler', 1100, 33, { Nd: 23.0, Pr: 6.0, DyB: 1.4, Co: 0.8, Cu: 0.1, O: 3800 }, { Nd: 0.7, Pr: 0.5, DyB: 0.5, Cu: 0.03, O: 700 }),
  lot('A-GBM', 'GBM powder (Dy-Co-Cu)', 'Grain-boundary additive', 900, 420, { Nd: 12, DyGB: 45, Co: 14, Cu: 2.0, O: 1200 }, { Nd: 0.2, DyGB: 0.4, Cu: 0.05, O: 100 }, false),
  lot('A-TBCU', 'Tb-Cu GBD alloy', 'Grain-boundary additive', 300, 1350, { Tb: 60, Cu: 25, O: 900 }, { Tb: 0.4, Cu: 0.3, O: 80 }, false),
  lot('A-NDPR', 'NdPr metal (virgin)', 'Lynas / Solvay oxide, reduced', 2500, 95, { Nd: 75, Pr: 25, O: 600 }, { Nd: 0.3, Pr: 0.3, O: 60 }, false),
  lot('A-FEB', 'Fe-B master alloy', 'RE-free diluent', 4000, 4, { O: 300 }, { O: 40 }, false),
];

// Production history: 420 batches with ICP-measured blend composition and hysteresisgraph Br / Hcj.
const history = [];
for (let i = 0; i < 420; i++) {
  const c = { Nd: 21.5 + N(0.8), Pr: 5.5 + N(0.35), DyB: Math.max(0, uniform(rand, 0, 5.5)), DyGB: Math.max(0, rand() < 0.45 ? uniform(rand, 0, 2.2) : 0), Tb: rand() < 0.3 ? uniform(rand, 0, 0.8) : Math.max(0, N(0.05)), Co: 1 + N(0.3), Cu: Math.max(0.05, 0.12 + (rand() < 0.3 ? uniform(rand, 0, 0.4) : 0) + N(0.02)), O: Math.max(1500, 3600 + N(900)) };
  // keep the effective rare earth inside the sintering window, as production does
  const target = uniform(rand, 28.7, 30.3);
  const te = c.Nd + c.Pr + c.DyB + c.DyGB + c.Tb - 0.0006 * c.O;
  c.Nd += target - te;
  const f = features(c);
  const Br = TRUTH.Br.beta.reduce((s, b, j) => s + b * f[j], 0) + N(TRUTH.Br.sd);
  const Hcj = TRUTH.Hcj.beta.reduce((s, b, j) => s + b * f[j], 0) + N(TRUTH.Hcj.sd);
  history.push({ batch: 'B-' + (24000 + i), comp: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, k === 'O' ? Math.round(v) : r2(v, 3)])), Br: r2(Br, 4), Hcj: Math.round(Hcj) });
}

const orders = [
  { id: 'SO-26-1148', customer: 'EV traction program (Tier 1)', grade: 'N42UH', kg: 6000, due: '2026-12-18' },
  { id: 'SO-26-1152', customer: 'Industrial servo OEM', grade: 'N42SH', kg: 4500, due: '2027-01-08' },
  { id: 'SO-26-1157', customer: 'Compressor motors (appliance)', grade: 'N45SH', kg: 5000, due: '2027-01-15' },
  { id: 'SO-26-1160', customer: 'Aerospace actuator prime', grade: 'N38EH', kg: 1200, due: '2027-02-02' },
];

mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/plant.json', import.meta.url), JSON.stringify({ meta: { seed: SEED, generated: 'scripts/generate.mjs', asOf: '2026-11-10' }, truth: TRUTH, lots, history, orders }, null, 0));
console.log(`lots=${lots.length} history=${history.length} orders=${orders.length}`);
