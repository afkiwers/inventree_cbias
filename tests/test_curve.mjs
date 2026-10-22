// The panel's JavaScript against GroundTruth: tests/reference.json (tests/make_reference.py writes it with
// GroundTruth itself) holds what GroundTruth makes of the same texts and values. Run: node --test tests/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  cAt, checkPoints, describeCurve, parseBias, parseQuantity, pointText, resolve
} from '../inventree_cbias/static/cbias_panel.js';

const ref = JSON.parse(readFileSync(new URL('./reference.json', import.meta.url), 'utf-8'));

/** Two numbers the same to rel (both null counts as the same). */
function close(a, b, rel = 1e-12) {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b), 1e-300);
}

test('parse_quantity as GroundTruth', () => {
  for (const q of ref.quantities) {
    const [value, why] = parseQuantity(q.text, q.quantity, q.assumed);
    assert.ok(close(value, q.result[0]), `${q.text}: ${value} vs ${q.result[0]}`);
    assert.equal(why, q.result[1], q.text);
  }
});

test('parse_bias as GroundTruth: points, their text and the problems', () => {
  for (const p of ref.parses) {
    const [points, problems] = parseBias(p.text);
    assert.deepEqual(problems, p.problems, p.text);
    assert.equal(points.length, p.points.length, p.text);
    points.forEach((got, k) => {
      const want = p.points[k];
      for (const key of ['c', 'pct', 'v']) assert.ok(close(got[key], want[key]), `${p.text} ${key}`);
      assert.equal(pointText(got), p.texts[k], p.text);
    });
  }
});

test('c_at as GroundTruth (PCHIP, one-point curve, the tail)', () => {
  let n = 0;
  for (const c of ref.curves) {
    const [points] = parseBias(c.text);
    const [curve, how] = resolve(points, c.c0, c.v_default);
    assert.equal(how, c.how, c.text);
    curve.forEach(([v, cc], k) => assert.ok(close(v, c.curve[k][0]) && close(cc, c.curve[k][1]), c.text));
    assert.deepEqual(checkPoints(points, c.c0), c.check, c.text);
    for (const [v, want] of c.at) {
      const got = cAt(curve, c.c0, v);
      assert.ok(close(got, want, 1e-11), `${c.text} at ${v} V: ${got} vs ${want}`);
      n++;
    }
  }
  assert.ok(n > 1000, `only ${n} values compared`);
});

/** A part's parameters as the panel gets them from the API. */
const params = (rows) => rows.map(([name, data, units = '']) => ({ name, data, units }));

test('the X6S 1 µF of the screenshot: its curve to the rated voltage', () => {
  const m = describeCurve(params([
    ['Capacitance', '1u', 'F'], ['Dielectric', 'X6S'], ['Rated Voltage', '6.3', 'V'], ['Cbias', '750n', 'F'],
    ['Cbias Curve', '-3.7%@0.63V, -16%@1.58V, -43%@3.15V, -60%@4.73V, -71%@6.3V']
  ]));
  assert.equal(m.status, 'curve');
  assert.equal(m.source, 'Cbias Curve');
  assert.ok(close(m.c0, 1e-6));
  assert.equal(m.vMax, 6.3);
  assert.ok(close(cAt(m.curve, m.c0, 3.15), 0.57e-6));
  assert.deepEqual(m.warnings, []);
});

test('no curve: "No DC-bias curve available"; class I says why', () => {
  assert.equal(describeCurve(params([['Capacitance', '10u', 'F']])).reason, 'No DC-bias curve available');
  const c0g = describeCurve(params([['Capacitance', '1n', 'F'], ['Dielectric', 'C0G']]));
  assert.equal(c0g.status, 'none');
  assert.match(c0g.reason, /class I/);
});

test('one Cbias value: at Cbias Voltage, else at half the rating, else no curve', () => {
  const base = [['Capacitance', '1u', 'F'], ['Cbias', '750n', 'F']];
  const atVoltage = describeCurve(params([...base, ['Cbias Voltage', '2', 'V'], ['Rated Voltage', '6.3', 'V']]));
  assert.deepEqual(atVoltage.curve.map((p) => p[0]), [2]);
  const atHalf = describeCurve(params([...base, ['Rated Voltage', '6.3', 'V']]));
  assert.equal(atHalf.how, 'default voltage');
  assert.ok(close(atHalf.curve[0][0], 3.15));
  assert.equal(describeCurve(params(base)).status, 'none');
});

test('template units for bare numbers; unreadable text and a missing C are errors', () => {
  const uf = describeCurve(params([['Capacitance', '1', 'uF'], ['Cbias Curve', '-50%@10V']]));
  assert.ok(close(uf.c0, 1e-6));
  assert.equal(describeCurve(params([['Capacitance', '1u'], ['Cbias Curve', 'abc@10V']])).status, 'error');
  assert.equal(describeCurve(params([['Cbias Curve', '-50%@10V']])).status, 'error');
  // a point above 1.2 × C0 (750nF typed for 75nF): drawn, with a warning
  assert.equal(describeCurve(params([['Capacitance', '100n'], ['Cbias Curve', '750nF@10V']])).warnings.length, 1);
});

test('renamed parameters (the plugin settings)', () => {
  const m = describeCurve(params([['C', '1u'], ['Derating', '-50%@10V']]),
    { curve: 'Derating', cbias: 'Cbias', cbiasVoltage: '', capacitance: 'C', ratedVoltage: 'Vr', dielectric: '' });
  assert.equal(m.status, 'curve');
});
