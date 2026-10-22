/**
 * The "DC bias" panel on a capacitor's part page: the capacitance against the DC voltage across it, drawn from the
 * part's `Cbias Curve` parameter the way GroundTruth (github.com/afkiwers/GroundTruth) reads and interpolates it.
 *
 * The numbers are a port of GroundTruth's components/values.py (parse_quantity) and components/bias.py (parse_bias,
 * c_at, resolve) and must stay so: tests/test_curve.mjs checks them against tests/reference.json, which
 * tests/make_reference.py writes with GroundTruth itself.
 *
 *   one point (75nF@50V)      the curve C0 / (1 + (V/V1)^2) through it [GroundTruth A56]
 *   several points            a monotone piecewise cubic (PCHIP [Fritsch 1980], scipy's derivatives) through
 *                             (0 V, C0) and the points; above the last point the one-point curve through it
 *   one value, no voltage     at the Cbias Voltage parameter, else at half the Rated Voltage [GroundTruth A57]
 *
 * InvenTree loads this file as an ES module and calls renderPanel(target, context) (the two-argument form: the
 * panel builds its own DOM, so no React build step is needed). Parameter text is user data: it only ever reaches
 * the page through textContent and SVG attributes, never as HTML.
 */

// ---------------------------------------------------------------------------------------------------------------
// Values (GroundTruth components/values.py)
// ---------------------------------------------------------------------------------------------------------------

const MULT = {
  p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9,
  R: 1.0, r: 1.0, 'Ω': 1.0, E: 1.0, F: 1.0, H: 1.0, '': 1.0
};
const INFIX = /^(\d+)([pnuµμmkKMGRrΩE])(\d+)/;           // 4n7, 1R5: the multiplier is the decimal point
const FRACTION = /^(\d+)\/(\d+)(?![\d.])(.*)$/;           // 1/16W
const NUMBER = /^([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)(.*)$/;
// in GroundTruth's order: the first word that starts the text wins
const PREFIX_WORDS = [['pico', 1e-12], ['nano', 1e-9], ['micro', 1e-6], ['milli', 1e-3], ['kilo', 1e3],
  ['mega', 1e6], ['giga', 1e9]];
const PREFIX_SYMBOLS = new Map([['p', 1e-12], ['n', 1e-9], ['u', 1e-6], ['µ', 1e-6], ['μ', 1e-6], ['m', 1e-3],
  ['k', 1e3], ['K', 1e3], ['M', 1e6], ['G', 1e9]]);
// unit words and symbols (lower case) -> quantity; InvenTree reports parameters with pint's names ("616 picofarad")
const UNITS = {
  ohms: 'ohm', ohm: 'ohm', 'ω': 'ohm', r: 'ohm', farads: 'F', farad: 'F', f: 'F',
  henries: 'H', henrys: 'H', henry: 'H', h: 'H', coulombs: 'C', coulomb: 'C', c: 'C',
  volts: 'V', volt: 'V', v: 'V', amperes: 'A', ampere: 'A', amps: 'A', amp: 'A', a: 'A',
  hertz: 'Hz', hz: 'Hz', watts: 'W', watt: 'W', w: 'W'
};
const UNITS_LONGEST_FIRST = Object.keys(UNITS).sort((a, b) => b.length - a.length);   // "ohms" before "ohm"
const QUANTITY_NAMES = {
  ohm: 'a resistance', F: 'a capacitance', H: 'an inductance', C: 'a charge',
  V: 'a voltage', A: 'a current', Hz: 'a frequency', W: 'a power', s: 'a time'
};

/** [prefix factor, quantity or '', what follows] of the text after a number, or null if it is not a unit. */
function unitOf(rest) {
  let factor = 1.0;
  let low = rest.toLowerCase();
  // a prefix written out ("milli") or as a symbol ("m"); but "m" of "mOhm" is a prefix while "h" of "henry" or
  // "f" of "farad" are units: unit words are excluded from the symbol test
  const word = PREFIX_WORDS.find(([w]) => low.startsWith(w));
  if (word) {
    factor = word[1];
    rest = rest.slice(word[0].length);
  } else if (PREFIX_SYMBOLS.has(rest.slice(0, 1)) &&
             !['ohm', 'hz', 'henr', 'farad', 'coulomb'].some((u) => low.startsWith(u))) {
    factor = PREFIX_SYMBOLS.get(rest[0]);
    rest = rest.slice(1);
  }
  low = rest.toLowerCase();
  const unit = UNITS_LONGEST_FIRST.find((u) => low.startsWith(u));
  const after = unit ? rest.slice(unit.length) : rest;
  if (/^\p{L}/u.test(after)) {                // "3.8 mOhmz": not a unit we know
    return null;
  }
  return [factor, unit ? UNITS[unit] : '', after];
}

/** Python's str.strip(chars) for a set of single characters. */
function stripChars(s, chars) {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

/**
 * A parameter's value: [value in SI units, or null; why not / what was assumed]. Reads InvenTree's (pint) strings
 * ("616 picofarad", "100V") and datasheet notation ("616p", "4n7", "2.2 uF", "10uF/16V"). quantity: "F", "V" ...;
 * a unit of another quantity is refused. A bare number is in `assumed` units.
 */
export function parseQuantity(text, quantity, assumed = 1.0) {
  if (text === null || text === undefined || !String(text).trim()) {
    return [null, 'empty'];
  }
  let s = String(text).trim().replace(/,/g, '.').replace(/ /g, '');
  const f = FRACTION.exec(s);
  if (f && parseInt(f[2], 10)) {
    s = String(parseInt(f[1], 10) / parseInt(f[2], 10)) + f[3];
  }
  let value;
  let unit;
  const m = INFIX.exec(s);
  if (m) {
    const [, whole, mult, frac] = m;
    value = parseFloat(`${whole}.${frac}`) * MULT[mult];
    const rest = s.slice(m[0].length);
    const u = rest ? unitOf(rest) : [1.0, '', ''];
    if (u === null || u[0] !== 1.0) {
      return [null, `'${text}': unit not understood`];
    }
    unit = 'RrΩE'.includes(mult) ? 'ohm' : u[1];
  } else {
    const n = NUMBER.exec(s);
    if (!n) {
      return [null, `'${text}': not a number`];
    }
    const u = n[2] ? unitOf(n[2]) : [1.0, '', ''];
    if (u === null) {
      return [null, `'${text}': unit not understood`];
    }
    const factor = u[0];
    unit = u[1];
    value = parseFloat(n[1]) * factor;
    if (!unit && factor === 1.0 && !stripChars(n[2], '/@') && !n[1].toLowerCase().includes('e')) {
      return [value * assumed, 'unit assumed'];        // "1e-9" is written in SI units already
    }
  }
  if (unit && unit !== quantity) {
    return [null, `'${text}': not ${QUANTITY_NAMES[quantity]}`];
  }
  return [value, ''];
}

/** Python's '%g' with p significant digits (no trailing zeros; exponent form outside 1e-4 ... 1e p). */
export function fmtG(x, p = 6) {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(Number(x.toPrecision(p)))));
  if (exp < -4 || exp >= p) {
    const [mant, e] = x.toExponential(p - 1).split('e');
    const m = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
    const en = parseInt(e, 10);
    return `${m}e${en < 0 ? '-' : '+'}${String(Math.abs(en)).padStart(2, '0')}`;
  }
  const t = x.toFixed(Math.max(0, p - 1 - exp));
  return t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') : t;
}

/** A value with an SI prefix ("4.7µF"), p significant digits; null -> "?". sep goes between the number and the
 * unit (the panel writes "4.7 µF"; GroundTruth's own text "4.7µF"). */
export function formatSi(value, unit = '', p = 6, sep = '') {
  if (value === null || value === undefined) return '?';
  if (value === 0) return `0${sep}${unit}`;
  for (const [mult, prefix] of [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'],
    [1e-9, 'n'], [1e-12, 'p']]) {
    if (Math.abs(value) >= mult * 0.999) {     // 0.999: rounding (999.9999e-9) still gets the larger prefix
      return `${fmtG(value / mult, p)}${sep}${prefix}${unit}`;
    }
  }
  return `${fmtG(value, 3)}${sep}${unit}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The DC-bias curve (GroundTruth components/bias.py)
// ---------------------------------------------------------------------------------------------------------------

export const BIAS_POINTS_MAX = 12;     // more points add nothing a datasheet curve read by eye can give
export const C_MAX_RATIO = 1.2;        // a point at most this many times the nominal (some X7R curves rise ~1 % near 0 V)
const PCT_RANGE = [-99.0, 20.0];       // a percent point's allowed change from the nominal
export const DEFAULT_SHARE = 0.5;      // a Cbias without its voltage holds at this share of the rated voltage [A57]
const CLASS_ONE = /\b(C0G|COG|NP0|NPO)\b/i;   // class I ceramics: no DC-bias loss

/** Python's float() of a short text: a decimal number, or null. */
function pyFloat(text) {
  const t = text.trim();
  return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t) ? Number(t) : null;
}

/** A point's capacitance with the nominal c0 (a percent point is relative to it). */
export function pointCapacitance(p, c0) {
  return p.pct !== null ? c0 * (1 + p.pct / 100) : p.c;
}

/** A point as the field writes it: '75nF@50V', '-50%@40V', '75nF'. */
export function pointText(p) {
  const head = p.pct !== null
    ? `${p.pct >= 0 ? '+' : ''}${fmtG(p.pct, 3)}%`
    : formatSi(Number(p.c.toPrecision(4)), 'F');
  return head + (p.v !== null ? `@${fmtG(p.v, 4)}V` : '');
}

/** One point from its text ('75nF@50V', '-5%@10V', '75n'): [point or null, why]. */
function parseToken(tok) {
  const at = tok.indexOf('@');
  const head = at < 0 ? tok : tok.slice(0, at);
  const volt = at < 0 ? '' : tok.slice(at + 1);
  let v = null;
  if (volt) {
    const [vv] = parseQuantity(volt, 'V', 1.0);
    if (vv === null) {
      return [null, `'${tok}': '${volt}' is not a voltage`];
    }
    if (!(vv > 0)) {
      return [null, `'${tok}': the voltage must be above 0 V (0 V is the nominal C itself)`];
    }
    v = vv;
  }
  if (head.endsWith('%')) {
    const pct = pyFloat(head.slice(0, -1).replace(/,/g, '.'));
    if (pct === null) {
      return [null, `'${tok}': '${head}' is not a percentage`];
    }
    if (!(PCT_RANGE[0] <= pct && pct <= PCT_RANGE[1])) {
      return [null, `'${tok}': a change of ${fmtG(pct)} % is outside ${fmtG(PCT_RANGE[0])} … +${fmtG(PCT_RANGE[1])} %`];
    }
    return [{ c: null, pct, v }, ''];
  }
  const [c] = parseQuantity(head, 'F', 1e-6);         // a bare number is in µF, as GroundTruth's Cbias always was
  if (c === null) {
    return [null, `'${tok}': '${head}' is not a capacitance`];
  }
  if (!(c > 0)) {
    return [null, `'${tok}': the capacitance must be above 0`];
  }
  return [{ c, pct: null, v }, ''];
}

/**
 * A DC-bias curve from its text: [points sorted by voltage, problems]. Separators: commas, semicolons or spaces;
 * "75 nF @ 50 V" is one point. An empty text gives no points and no problem.
 */
export function parseBias(text) {
  if (text === null || text === undefined) {
    return [[], []];
  }
  let t = String(text).trim();
  if (!t) {
    return [[], []];
  }
  // glue "75 nF @ 50 V" into one token, then split at commas, semicolons and the spaces left
  t = t.replace(/\s*@\s*/g, '@');
  t = t.replace(/(\d)\s+(?=[a-zA-Zµμ%])/g, '$1');
  const tokens = t.split(/[;,\s]+/).filter(Boolean);
  const points = [];
  const problems = [];
  for (const tok of tokens) {
    const [p, why] = parseToken(tok);
    if (p === null) problems.push(why);
    else points.push(p);
  }
  if (points.length > BIAS_POINTS_MAX) {
    problems.push(`${points.length} points: at most ${BIAS_POINTS_MAX}`);
  }
  if (points.length > 1 && points.some((p) => p.v === null)) {
    problems.push('with more than one point, each needs its voltage (75nF@50V)');
  }
  const volts = points.filter((p) => p.v !== null).map((p) => p.v);
  if (new Set(volts).size !== volts.length) {
    problems.push('two points at the same voltage');
  }
  if (problems.length) {
    return [[], problems];
  }
  return [[...points].sort((a, b) => (a.v || 0) - (b.v || 0)), []];
}

/** Problems of a curve against its nominal c0: a point above C_MAX_RATIO × c0 (a typo: 750nF for 75nF). */
export function checkPoints(points, c0) {
  const out = [];
  for (const p of points) {
    const c = pointCapacitance(p, c0);
    if (c0 > 0 && c > C_MAX_RATIO * c0) {
      out.push(`${pointText(p)} is more than ${fmtG(C_MAX_RATIO)} × the nominal ${formatSi(c0, 'F')}`);
    }
  }
  return out;
}

/** V1 of the curve C0 / (1 + (V/V1)^2) [A56] through (v, c); null when the point is at or above the nominal. */
export function v1Through(c0, c, v) {
  if (!(c0 > 0 && c > 0 && c < c0 && v > 0)) {
    return null;
  }
  return v / Math.sqrt(c0 / c - 1);
}

/** The one-point curve's capacitance at v: C0 / (1 + (v/V1)^2) [A56]; c0 when V1 is null. */
export function onePoint(c0, v1, v) {
  return v1 === null ? c0 : c0 / (1 + (v / v1) ** 2);
}

/** scipy's PchipInterpolator._edge_case: a one-sided three-point end slope, kept shape-preserving. */
function pchipEdge(h0, h1, m0, m1) {
  let d = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
  if (Math.sign(d) !== Math.sign(m0)) {
    d = 0.0;
  } else if (Math.sign(m0) !== Math.sign(m1) && Math.abs(d) > 3.0 * Math.abs(m0)) {
    d = 3.0 * m0;
  }
  return d;
}

/**
 * The monotone piecewise cubic through (xs, ys) at x [Fritsch 1980], with scipy's PchipInterpolator's slopes
 * (Fritsch-Butland weighted harmonic mean inside, pchipEdge at the ends) and its polynomial evaluation, so the
 * curve is GroundTruth's to rounding. xs strictly increasing, at least 2 points.
 */
export function pchip(xs, ys, x) {
  const n = xs.length;
  const h = [];
  const m = [];
  for (let k = 0; k < n - 1; k++) {
    h.push(xs[k + 1] - xs[k]);
    m.push((ys[k + 1] - ys[k]) / h[k]);
  }
  const d = new Array(n).fill(0.0);
  if (n === 2) {
    d[0] = m[0];
    d[1] = m[0];
  } else {
    for (let k = 1; k < n - 1; k++) {
      // a local extremum or a flat side: slope 0; else the weighted harmonic mean of the two secants
      if (Math.sign(m[k]) !== Math.sign(m[k - 1]) || m[k] === 0 || m[k - 1] === 0) {
        d[k] = 0.0;
      } else {
        const w1 = 2 * h[k] + h[k - 1];
        const w2 = h[k] + 2 * h[k - 1];
        d[k] = 1.0 / ((w1 / m[k - 1] + w2 / m[k]) / (w1 + w2));
      }
    }
    d[0] = pchipEdge(h[0], h[1], m[0], m[1]);
    d[n - 1] = pchipEdge(h[n - 2], h[n - 3], m[n - 2], m[n - 3]);
  }
  // the interval: the last knot at or below x (scipy's find_interval; the ends extrapolate)
  let k = 0;
  while (k < n - 2 && x >= xs[k + 1]) k++;
  // scipy's CubicHermiteSpline coefficients and PPoly's evaluation order
  const t = (d[k] + d[k + 1] - 2 * m[k]) / h[k];
  const c = [t / h[k], (m[k] - d[k]) / h[k] - t, d[k], ys[k]];
  const s = x - xs[k];
  let res = 0.0;
  let z = 1.0;
  for (let kp = 0; kp < 4; kp++) {
    res += c[3 - kp] * z;
    if (kp < 3) z *= s;
  }
  return res;
}

/**
 * The capacitance at |v| volts from a curve [[V, C]] (voltages > 0, sorted) and the nominal c0. No point: c0. One
 * point: C0 / (1 + (V/V1)^2) through it [A56]. Several: the monotone cubic through (0, c0) and the points; above the
 * last point the one-point curve through it (they meet there, so the curve is continuous).
 */
export function cAt(points, c0, v) {
  v = Math.abs(Number(v));
  if (!points.length || c0 <= 0) {
    return c0;
  }
  if (points.length === 1) {
    const [[vb, cb]] = points;
    return onePoint(c0, v1Through(c0, cb, vb), v);
  }
  const [vLast, cLast] = points[points.length - 1];
  if (v >= vLast) {
    const v1 = v1Through(c0, cLast, vLast);
    return v1 === null ? cLast : cLast * onePoint(c0, v1, v) / onePoint(c0, v1, vLast);
  }
  return pchip([0.0, ...points.map((p) => p[0])], [c0, ...points.map((p) => p[1])], v);
}

/**
 * The curve as [[V, C]] for cAt: percent points against c0; a single point without a voltage taken at v_default
 * (half the Rated Voltage [A57]) or, without one, flat (an empty curve). Returns [curve, how] with how one of
 * 'curve', 'default voltage', 'flat'.
 */
export function resolve(points, c0, vDefault) {
  if (points.length === 1 && points[0].v === null) {
    const c = pointCapacitance(points[0], c0);
    if (vDefault && vDefault > 0) {
      return [[[vDefault, c]], 'default voltage'];
    }
    return [[], 'flat'];
  }
  return [points.map((p) => [p.v, pointCapacitance(p, c0)]), 'curve'];
}

// ---------------------------------------------------------------------------------------------------------------
// A part's parameters -> what the panel shows
// ---------------------------------------------------------------------------------------------------------------

/** The parameter template names the panel reads (the plugin's settings may rename them). */
export const DEFAULT_NAMES = {
  curve: 'Cbias Curve',
  cbias: 'Cbias',
  cbiasVoltage: 'Cbias Voltage',
  capacitance: 'Capacitance',
  ratedVoltage: 'Rated Voltage',
  dielectric: 'Dielectric'
};

/** The factor of a template's units in SI ("uF" -> 1e-6, "V" -> 1), or fallback when there are none. */
function unitFactor(units, quantity, fallback) {
  if (!units || !String(units).trim()) return fallback;
  const [f, why] = parseQuantity(`1${String(units).trim()}`, quantity, 1.0);
  return f !== null && why !== 'unit assumed' ? f : fallback;
}

/**
 * What the panel shows for a part's parameters [{name, units, data}]: an object with status 'curve' (curve [[V, C]],
 * points, c0, vMax), 'none' (reason) or 'error' (problems), and notes / warnings. Follows GroundTruth's
 * fields.bias_reading: the curve parameter first, else Cbias; a single value without a voltage at Cbias Voltage,
 * else at half the Rated Voltage. A bare Capacitance / Rated Voltage takes its template's units (GroundTruth: F, V).
 */
export function describeCurve(params, names = DEFAULT_NAMES) {
  const get = (key) => {
    const want = String(names[key] || '').trim().toLowerCase();
    if (!want) return null;
    const p = params.find((q) => String(q.name || '').trim().toLowerCase() === want && String(q.data ?? '').trim());
    return p ? { name: p.name, units: p.units || '', text: String(p.data).trim() } : null;
  };
  const quantity = (p, q, assumed) => (p ? parseQuantity(p.text, q, unitFactor(p.units, q, assumed))[0] : null);

  const out = {
    status: 'none', reason: '', c0: null, rated: null, dielectric: null, source: null, text: null,
    points: [], curve: [], how: null, vMax: null, notes: [], warnings: [], problems: []
  };
  const cap = get('capacitance');
  out.c0 = quantity(cap, 'F', 1.0);
  out.rated = quantity(get('ratedVoltage'), 'V', 1.0);
  const diel = get('dielectric');
  out.dielectric = diel ? diel.text : null;
  const classOne = !!diel && CLASS_ONE.test(diel.text);

  const src = get('curve') || get('cbias');
  if (!src) {
    out.reason = classOne ? `${diel.text} is a class I dielectric: no DC-bias derating` : 'No DC-bias curve available';
    return out;
  }
  out.source = src.name;
  out.text = src.text;
  const [parsed, problems] = parseBias(src.text);
  if (problems.length) {
    out.status = 'error';
    out.problems = problems;
    return out;
  }
  let points = parsed;
  if (points.length === 1 && points[0].v === null) {
    const vb = get('cbiasVoltage');
    const v = quantity(vb, 'V', 1.0);
    if (v !== null && v > 0) {
      points = [{ ...points[0], v }];
      out.notes.push(`The single value is placed at ${vb.name} ${vb.text}.`);
    }
  }
  out.points = points;
  if (!(out.c0 > 0)) {
    out.status = 'error';
    out.problems = [cap
      ? `${cap.name} '${cap.text}' is not a capacitance`
      : `The part has no ${names.capacitance} parameter: the curve starts at the nominal capacitance at 0 V.`];
    return out;
  }
  const [curve, how] = resolve(points, out.c0, out.rated > 0 ? DEFAULT_SHARE * out.rated : null);
  out.how = how;
  if (how === 'flat') {
    out.reason = `${src.name} ${src.text} has no voltage, and the part has neither ${names.cbiasVoltage} nor ` +
      `${names.ratedVoltage} to place it.`;
    return out;
  }
  if (how === 'default voltage') {
    out.notes.push(`${src.name} has no voltage: taken at half the ${names.ratedVoltage} ` +
      `(${formatSi(DEFAULT_SHARE * out.rated, 'V', 4)}), as GroundTruth does.`);
  }
  if (classOne) {
    out.notes.push(`${diel.text} is a class I dielectric: GroundTruth keeps the nominal capacitance and does not ` +
      'apply this curve.');
  }
  out.warnings = checkPoints(points, out.c0);
  out.curve = curve;
  out.status = 'curve';
  const vLast = curve[curve.length - 1][0];
  out.vMax = out.rated > 0 ? Math.max(out.rated, vLast) : 1.25 * vLast;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
// Mantine's own CSS variables (InvenTree's theme), so the panel follows its light and dark modes and primary colour
const V = {
  text: 'var(--mantine-color-text, #212529)',
  dimmed: 'var(--mantine-color-dimmed, #868e96)',
  border: 'var(--mantine-color-default-border, #dee2e6)',
  body: 'var(--mantine-color-body, #ffffff)',
  field: 'var(--mantine-color-default, #ffffff)',
  hover: 'var(--mantine-color-default-hover, #f8f9fa)',
  accent: 'var(--mantine-primary-color-filled, #228be6)',
  accentLight: 'var(--mantine-primary-color-light, rgba(34, 139, 230, 0.1))',
  radius: 'var(--mantine-radius-md, 8px)',
  mono: 'var(--mantine-font-family-monospace, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
  warnBg: 'var(--mantine-color-orange-light, rgba(253, 126, 20, 0.1))',
  warn: 'var(--mantine-color-orange-filled, #fd7e14)',
  errorBg: 'var(--mantine-color-red-light, rgba(250, 82, 82, 0.1))',
  error: 'var(--mantine-color-red-filled, #fa5252)'
};

// The panel's stylesheet: every class starts with "cbias-", so nothing leaks into InvenTree's page. The layout keys
// off the panel's own width (a container query), not the window's.
const CSS = `
.cbias { container-type: inline-size; color: ${V.text}; font-size: 14px; line-height: 1.45; }
.cbias *, .cbias *::before, .cbias *::after { box-sizing: border-box; }
.cbias-stack { display: flex; flex-direction: column; gap: 16px; }
.cbias-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.cbias-toolbar-text { color: ${V.dimmed}; font-size: 13px; }
.cbias-btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; font: inherit;
  font-size: 13px; font-weight: 500; color: ${V.text}; background: ${V.field}; border: 1px solid ${V.border};
  border-radius: 4px; cursor: pointer; transition: background-color 120ms; }
.cbias-btn:hover { background: ${V.hover}; }
.cbias-btn:focus-visible, .cbias-seg button:focus-visible, .cbias-icon-btn:focus-visible {
  outline: 2px solid ${V.accent}; outline-offset: 2px; }
.cbias-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
  flex: none; color: ${V.dimmed}; background: transparent; border: 0; border-radius: 4px; cursor: pointer; }
.cbias-icon-btn:hover { background: ${V.hover}; color: ${V.text}; }
.cbias-card { min-width: 0; padding: 16px; background: ${V.body}; border: 1px solid ${V.border};
  border-radius: ${V.radius}; }
.cbias-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  flex-wrap: wrap; margin-bottom: 12px; }
.cbias-card-title { font-size: 14px; font-weight: 600; }
.cbias-card-note { color: ${V.dimmed}; font-size: 12px; }
.cbias-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.cbias-tile-label { color: ${V.dimmed}; font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
  text-transform: uppercase; }
.cbias-tile-value { margin-top: 6px; font-size: 26px; font-weight: 600; line-height: 1.2;
  font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.cbias-tile-note { margin-top: 4px; color: ${V.dimmed}; font-size: 12px; font-variant-numeric: tabular-nums; }
.cbias-tile-bar { height: 4px; margin-top: 10px; overflow: hidden; background: ${V.hover}; border-radius: 2px; }
.cbias-tile-bar > div { height: 100%; background: ${V.accent}; border-radius: 2px; }
.cbias-main { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
.cbias-side { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
@container (max-width: 980px) {
  .cbias-main { grid-template-columns: minmax(0, 1fr); }
  .cbias-side { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); align-items: start; }
  .cbias-side > :last-child { grid-column: 1 / -1; }
}
.cbias-seg { display: inline-flex; padding: 3px; background: ${V.hover}; border: 1px solid ${V.border};
  border-radius: 6px; }
.cbias-seg button { padding: 4px 12px; font: inherit; font-size: 12px; font-weight: 500; color: ${V.dimmed};
  background: transparent; border: 0; border-radius: 4px; cursor: pointer; }
.cbias-seg button[aria-pressed="true"] { color: ${V.text}; background: ${V.body};
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12); }
.cbias-chart { position: relative; width: 100%; }
.cbias-chart svg { display: block; width: 100%; font-family: inherit; cursor: crosshair; user-select: none;
  touch-action: pan-y; }
.cbias-tip { position: absolute; z-index: 2; display: none; min-width: 150px; padding: 8px 10px;
  pointer-events: none; font-size: 12px; color: ${V.text}; background: ${V.body}; border: 1px solid ${V.border};
  border-radius: 6px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14); }
.cbias-tip-title { margin-bottom: 4px; font-weight: 600; font-variant-numeric: tabular-nums; }
.cbias-tip-row { display: flex; justify-content: space-between; gap: 16px; font-variant-numeric: tabular-nums; }
.cbias-tip-row span:first-child { color: ${V.dimmed}; }
.cbias-pill { display: inline-block; margin-top: 6px; padding: 1px 8px; font-size: 11px; font-weight: 600;
  color: ${V.dimmed}; background: ${V.hover}; border-radius: 999px; }
.cbias-legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 10px; color: ${V.dimmed}; font-size: 12px; }
.cbias-legend > span { display: inline-flex; align-items: center; gap: 6px; }
.cbias-input-wrap { position: relative; }
.cbias-input { width: 100%; height: 36px; padding: 0 34px 0 12px; font: inherit; font-size: 15px;
  font-variant-numeric: tabular-nums; color: ${V.text}; background: ${V.field}; border: 1px solid ${V.border};
  border-radius: 4px; outline: none; transition: border-color 120ms; }
.cbias-input:focus { border-color: ${V.accent}; }
.cbias-input-unit { position: absolute; top: 50%; right: 12px; transform: translateY(-50%); color: ${V.dimmed};
  pointer-events: none; }
.cbias-readout { margin-top: 14px; }
.cbias-readout-value { font-size: 28px; font-weight: 600; line-height: 1.15; font-variant-numeric: tabular-nums; }
.cbias-readout-note { margin-top: 2px; color: ${V.dimmed}; font-size: 13px; font-variant-numeric: tabular-nums; }
.cbias-hint { margin-top: 10px; color: ${V.dimmed}; font-size: 12px; }
.cbias-table { width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; border-collapse: collapse; }
.cbias-table th { padding: 0 8px 8px; color: ${V.dimmed}; font-size: 11px; font-weight: 700; letter-spacing: 0.05em;
  text-align: right; text-transform: uppercase; border-bottom: 1px solid ${V.border}; }
.cbias-table td { padding: 7px 8px; text-align: right; border-bottom: 1px solid ${V.border}; }
.cbias-table th:first-child, .cbias-table td:first-child { text-align: left; }
.cbias-table tr:last-child td { border-bottom: 0; }
.cbias-table tbody tr:hover td { background: ${V.hover}; }
.cbias-table tr.cbias-nominal td { color: ${V.dimmed}; }
.cbias-code { display: flex; align-items: flex-start; gap: 8px; padding: 8px 4px 8px 10px; font-family: ${V.mono};
  font-size: 12px; line-height: 1.6; word-break: break-word; background: ${V.hover}; border-radius: 6px; }
.cbias-code > span { flex: 1; min-width: 0; padding-top: 2px; }
.cbias-alert { display: flex; gap: 10px; padding: 12px 14px; border-radius: ${V.radius}; }
.cbias-alert > svg { flex: none; margin-top: 1px; }
.cbias-alert.cbias-warn { background: ${V.warnBg}; }
.cbias-alert.cbias-warn > svg { color: ${V.warn}; }
.cbias-alert.cbias-error { background: ${V.errorBg}; }
.cbias-alert.cbias-error > svg { color: ${V.error}; }
.cbias-alert-title { font-weight: 600; }
.cbias-alert ul { margin: 6px 0 0; padding-left: 18px; }
.cbias-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 48px 16px;
  text-align: center; border: 1px dashed ${V.border}; border-radius: ${V.radius}; }
.cbias-empty-icon { display: flex; align-items: center; justify-content: center; width: 48px; height: 48px;
  margin-bottom: 6px; color: ${V.accent}; background: ${V.accentLight}; border-radius: 50%; }
.cbias-empty-title { font-size: 16px; font-weight: 600; }
.cbias-empty-text { max-width: 520px; color: ${V.dimmed}; font-size: 13px; }
.cbias-empty-text code { font-family: ${V.mono}; font-size: 12px; }
.cbias-foot { color: ${V.dimmed}; font-size: 12px; line-height: 1.6; }
.cbias-skel { background: ${V.hover}; border-radius: ${V.radius}; animation: cbias-pulse 1.4s ease-in-out infinite; }
@keyframes cbias-pulse { 50% { opacity: 0.45; } }
@media (prefers-reduced-motion: reduce) { .cbias-skel { animation: none; } }
`;

/** Put the panel's stylesheet into the page once (replaced when a newer copy of this file runs). */
function installStyle() {
  let style = document.getElementById('cbias-panel-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'cbias-panel-style';
    document.head.appendChild(style);
  }
  if (style.textContent !== CSS) style.textContent = CSS;
}

/** An HTML element with a class, text and children (text only ever goes in as text, never as HTML). */
function el(tag, cls = '', text = null, children = []) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== null) e.textContent = text;
  for (const c of children) if (c) e.appendChild(c);
  return e;
}

/** An SVG element with attributes. */
function svgEl(tag, attrs = {}, text = null) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== null) e.textContent = text;
  return e;
}

// Outline icons from Tabler Icons (MIT), the set InvenTree uses: their 24 × 24 paths
const ICONS = {
  refresh: ['M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4', 'M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4'],
  copy: ['M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 ' +
    '-2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z',
  'M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1'],
  check: ['M5 12l5 5l10 -10'],
  chart: ['M4 19l16 0', 'M4 15l4 -6l4 2l4 -5l4 4'],
  alert: ['M12 9v4', 'M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 ' +
    '-2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z', 'M12 16h.01']
};

/** A Tabler icon as inline SVG, in the text's colour. */
function icon(name, size = 16) {
  const s = svgEl('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  for (const d of ICONS[name]) s.appendChild(svgEl('path', { d }));
  return s;
}

/** A capacitance or voltage as the panel shows it: "129.3 nF", "50 V". */
const cap = (c) => formatSi(c, 'F', 4, ' ');
const volts = (v) => `${fmtG(Number(v.toPrecision(4)), 4)} V`;

/** A ΔC percentage with a real minus sign: "−41.2 %". */
function pctText(pct) {
  const r = Math.abs(pct) < 0.05 ? 0 : pct;
  return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r).toFixed(1)} %`;
}

/** A tick step near span / target: 1, 2 or 5 × 10^n. */
function niceStep(span, target) {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const r = raw / mag;
  return (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag;
}

/** Ticks from lo to hi (inclusive) every step, without the drift repeated addition gives. */
function ticks(lo, hi, step) {
  const out = [];
  for (let k = 0; lo + k * step <= hi + step * 1e-9; k++) out.push(Number((lo + k * step).toPrecision(12)));
  return out;
}

/** A remembered choice of this viewer (the chart's scale); storage may be unavailable, the default then holds. */
function remember(key, value) {
  try {
    if (value === undefined) return window.localStorage.getItem(`cbias.${key}`);
    window.localStorage.setItem(`cbias.${key}`, value);
  } catch (error) {
    // private window or blocked storage: nothing is remembered
  }
  return null;
}

/** The part's parameters [{name, units, data}] through InvenTree's API (InvenTree 1.1+, else the older endpoint). */
async function fetchParameters(api, partId) {
  const rows = (data) => (Array.isArray(data) ? data : (data?.results ?? [])).map((p) => ({
    name: p.template_detail?.name ?? '',
    units: p.template_detail?.units ?? '',
    data: p.data ?? ''
  }));
  try {
    // InvenTree 1.1+: parameters of every model under /api/parameter/
    const r = await api.get('/api/parameter/', { params: { model_type: 'part.part', model_id: partId, limit: 500 } });
    return rows(r.data);
  } catch (error) {
    if (error?.response?.status !== 404) throw error;
  }
  const r = await api.get('/api/part/parameter/', { params: { part: partId, limit: 500 } });
  return rows(r.data);
}

let chartIds = 0;      // a unique id per chart for its SVG gradient

/**
 * The chart, drawn at `host`'s pixel width (text stays its size at any width): the curve against the DC voltage as
 * ΔC (%) or as capacitance (state.mode), the capacitance lost shaded between it and the nominal, the given points,
 * the rated voltage, the voltage picked (state.lookupV) and a hover readout. onPick(v): a click on the chart.
 */
function drawChart(host, model, state, onPick) {
  const { curve, c0, vMax, rated } = model;
  const width = Math.max(280, Math.floor(host.clientWidth));
  const height = Math.round(Math.min(500, Math.max(260, width * 0.42)));
  const pct = state.mode !== 'abs';
  const pad = { l: pct ? 52 : 66, r: 16, t: 16, b: 46 };
  const vLast = curve[curve.length - 1][0];
  const val = (c) => (pct ? 100 * (c / c0 - 1) : c);
  const at = (v) => val(cAt(curve, c0, v));

  // the curve sampled about every 2 px: solid to the last point (through every point), dashed beyond it
  const n = Math.max(150, Math.min(600, Math.round(width / 2)));
  const grid = Array.from({ length: n + 1 }, (_, k) => (vMax * k) / n);
  const solid = [...new Set([...grid.filter((v) => v <= vLast), ...curve.map((p) => p[0])])].sort((a, b) => a - b);
  const dashed = vLast < vMax ? [vLast, ...grid.filter((v) => v > vLast)] : [];
  const values = [...solid, ...dashed].map(at);

  let yLo;
  let yHi;
  let yStep;
  if (pct) {
    const lo = Math.min(...values, -10);
    const hi = Math.max(...values, 0);
    yStep = niceStep(hi - lo, 5);
    yLo = Math.max(-100, Math.floor(lo / yStep) * yStep);
    yHi = Math.ceil((hi + 0.04 * (hi - lo)) / yStep) * yStep;
  } else {
    const hi = Math.max(...values, c0);
    yStep = niceStep(hi, 5);
    yLo = 0;
    yHi = Math.ceil((hi * 1.04) / yStep) * yStep;
  }
  const xStep = niceStep(vMax, Math.max(3, Math.floor(width / 110)));
  const x = (v) => pad.l + (v / vMax) * (width - pad.l - pad.r);
  const y = (p) => pad.t + ((yHi - p) / (yHi - yLo)) * (height - pad.t - pad.b);
  const yLabel = (t) => (pct ? (Math.abs(t) < 1e-9 ? '0 %' : `${t > 0 ? '+' : '−'}${fmtG(Math.abs(t), 4)} %`)
    : formatSi(t, 'F', 3, ' '));

  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img',
    'aria-label': `DC-bias curve: ${pct ? 'change of capacitance' : 'capacitance'} against the DC voltage, ` +
      `0 to ${volts(vMax)}` });
  const id = `cbias-grad-${++chartIds}`;
  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': V.accent, 'stop-opacity': 0.04 }));
  grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': V.accent, 'stop-opacity': 0.2 }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  const small = { 'font-size': 12, fill: V.dimmed };
  for (const t of ticks(yLo, yHi, yStep)) {                  // horizontal grid and the y labels
    svg.appendChild(svgEl('line', { x1: pad.l, x2: width - pad.r, y1: y(t), y2: y(t), stroke: V.border }));
    svg.appendChild(svgEl('text', { x: pad.l - 10, y: y(t) + 4, 'text-anchor': 'end', ...small }, yLabel(t)));
  }
  for (const v of ticks(0, vMax, xStep)) {                   // vertical grid and the voltage labels
    svg.appendChild(svgEl('line', { x1: x(v), x2: x(v), y1: pad.t, y2: height - pad.b, stroke: V.border,
      'stroke-opacity': 0.55 }));
    svg.appendChild(svgEl('text', { x: x(v), y: height - pad.b + 18, 'text-anchor': 'middle', ...small },
      `${fmtG(v, 4)} V`));
  }
  svg.appendChild(svgEl('text', { x: (pad.l + width - pad.r) / 2, y: height - 6, 'text-anchor': 'middle',
    ...small }, 'DC bias across the capacitor'));

  // the capacitance lost: between the nominal and the curve
  const yNom = y(val(c0));
  const line = [...solid, ...dashed.slice(1)];
  const area = [`${x(0)},${yNom}`, ...line.map((v) => `${x(v).toFixed(2)},${y(at(v)).toFixed(2)}`),
    `${x(line[line.length - 1]).toFixed(2)},${yNom}`];
  svg.appendChild(svgEl('polygon', { points: area.join(' '), fill: `url(#${id})` }));
  svg.appendChild(svgEl('line', { x1: pad.l, x2: width - pad.r, y1: yNom, y2: yNom, stroke: V.dimmed,
    'stroke-width': 1, 'stroke-dasharray': '4 4' }));
  svg.appendChild(svgEl('text', { x: pad.l + 8, y: yNom - 6, ...small, 'font-size': 11 },
    `nominal ${cap(c0)}`));

  if (rated > 0 && rated <= vMax) {                          // the rated voltage
    svg.appendChild(svgEl('line', { x1: x(rated), x2: x(rated), y1: pad.t, y2: height - pad.b, stroke: V.dimmed,
      'stroke-dasharray': '4 4' }));
    svg.appendChild(svgEl('text', { x: x(rated) - 6, y: pad.t + 12, 'text-anchor': 'end', ...small,
      'font-size': 11 }, `rated ${volts(rated)}`));
  }

  const path = (vs, dash) => svgEl('polyline', {
    points: vs.map((v) => `${x(v).toFixed(2)},${y(at(v)).toFixed(2)}`).join(' '),
    fill: 'none', stroke: V.accent, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    ...(dash ? { 'stroke-dasharray': '6 6' } : {})
  });
  svg.appendChild(path(solid, false));
  if (dashed.length > 1) svg.appendChild(path(dashed, true));
  for (const [v, c] of curve) {                              // the given points
    const dot = svgEl('circle', { cx: x(v), cy: y(val(c)), r: 5, fill: V.accent, stroke: V.body, 'stroke-width': 2 });
    dot.appendChild(svgEl('title', {}, `${volts(v)}: ${cap(c)} (${pctText(100 * (c / c0 - 1))}), given`));
    svg.appendChild(dot);
  }

  if (state.lookupV !== null && state.lookupV >= 0 && state.lookupV <= vMax) {     // the voltage picked
    const v = state.lookupV;
    const c = cAt(curve, c0, v);
    const px = x(v);
    const py = y(val(c));
    svg.appendChild(svgEl('line', { x1: px, x2: px, y1: pad.t, y2: height - pad.b, stroke: V.accent,
      'stroke-opacity': 0.6, 'stroke-dasharray': '2 3' }));
    svg.appendChild(svgEl('circle', { cx: px, cy: py, r: 6.5, fill: V.body, stroke: V.accent, 'stroke-width': 2.5 }));
    const right = px < width * 0.7;
    // a halo in the background colour keeps the label readable over the grid and the curve
    svg.appendChild(svgEl('text', { x: px + (right ? 12 : -12), y: Math.max(pad.t + 14, py - 12),
      'text-anchor': right ? 'start' : 'end', 'font-size': 12, 'font-weight': 600, fill: V.text,
      stroke: V.body, 'stroke-width': 4, 'paint-order': 'stroke', 'stroke-linejoin': 'round' },
    `${volts(v)} · ${cap(c)}`));
  }

  // the hover layer: a crosshair, a ring on the curve and a readout
  const cross = svgEl('line', { y1: pad.t, y2: height - pad.b, stroke: V.dimmed, visibility: 'hidden' });
  const ring = svgEl('circle', { r: 5, fill: V.body, stroke: V.accent, 'stroke-width': 2, visibility: 'hidden' });
  const hit = svgEl('rect', { x: pad.l, y: pad.t, width: width - pad.l - pad.r, height: height - pad.t - pad.b,
    fill: 'transparent' });
  svg.appendChild(cross);
  svg.appendChild(ring);
  svg.appendChild(hit);

  const tipV = el('div', 'cbias-tip-title');
  const tipC = el('span');
  const tipP = el('span');
  const tipX = el('div', 'cbias-pill', 'extrapolated');
  const tip = el('div', 'cbias-tip', null, [tipV, el('div', 'cbias-tip-row', null, [el('span', '', 'Capacitance'),
    tipC]), el('div', 'cbias-tip-row', null, [el('span', '', 'Change'), tipP]), tipX]);
  const voltageAt = (e) => {
    const box = svg.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * width;
    return Math.min(vMax, Math.max(0, ((sx - pad.l) / (width - pad.l - pad.r)) * vMax));
  };
  hit.addEventListener('pointermove', (e) => {
    const v = voltageAt(e);
    const c = cAt(curve, c0, v);
    const px = x(v);
    const py = y(val(c));
    for (const [k, value] of [['x1', px], ['x2', px]]) cross.setAttribute(k, value);
    ring.setAttribute('cx', px);
    ring.setAttribute('cy', py);
    cross.setAttribute('visibility', 'visible');
    ring.setAttribute('visibility', 'visible');
    tipV.textContent = volts(v);
    tipC.textContent = cap(c);
    tipP.textContent = pctText(100 * (c / c0 - 1));
    tipX.style.display = v > vLast * (1 + 1e-9) ? 'inline-block' : 'none';
    tip.style.display = 'block';
    const flip = px > width * 0.62;                       // keep the readout inside the chart
    tip.style.left = flip ? '' : `${px + 16}px`;
    tip.style.right = flip ? `${width - px + 16}px` : '';
    tip.style.top = `${Math.min(height - pad.b - 90, Math.max(0, py - 40))}px`;
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    ring.setAttribute('visibility', 'hidden');
    tip.style.display = 'none';
  });
  hit.addEventListener('click', (e) => onPick(Number(voltageAt(e).toPrecision(3))));

  host.replaceChildren(svg, tip);
}

/** The key under the chart: the line styles and the shading. */
function legend(model) {
  const swatch = (draw) => {
    const s = svgEl('svg', { width: 26, height: 12, 'aria-hidden': 'true' });
    draw(s);
    return s;
  };
  const lineKey = (dash) => swatch((s) => s.appendChild(svgEl('line', { x1: 2, x2: 24, y1: 6, y2: 6, stroke: V.accent,
    'stroke-width': 2.5, 'stroke-linecap': 'round', ...(dash ? { 'stroke-dasharray': '5 4' } : {}) })));
  const items = [
    [lineKey(false), model.curve.length === 1 ? 'one-point curve C0 / (1 + (V/V1)²)' : 'interpolated (monotone cubic)'],
    [swatch((s) => s.appendChild(svgEl('circle', { cx: 13, cy: 6, r: 4.5, fill: V.accent }))), 'given point']
  ];
  if (model.curve[model.curve.length - 1][0] < model.vMax) items.push([lineKey(true), 'extrapolated']);
  items.push([swatch((s) => s.appendChild(svgEl('rect', { x: 2, y: 1, width: 22, height: 10, rx: 2, fill: V.accent,
    'fill-opacity': 0.18 }))), 'capacitance lost to DC bias']);
  return el('div', 'cbias-legend', null, items.map(([s, t]) => el('span', '', null, [s, el('span', '', t)])));
}

/** A summary tile: a label, a large value, a note and, for a capacitance, a bar of what is left of the nominal. */
function tile(label, value, note, share = null) {
  const bar = share === null ? null : el('div', 'cbias-tile-bar', null, [el('div')]);
  if (bar) bar.firstChild.style.width = `${Math.max(0, Math.min(1, share)) * 100}%`;
  return el('div', 'cbias-card', null, [el('div', 'cbias-tile-label', label), el('div', 'cbias-tile-value', value),
    el('div', 'cbias-tile-note', note), bar]);
}

/** The summary tiles: the nominal, the curve at half and at the full rated voltage (else at its last point), the data. */
function tiles(model) {
  const { c0, rated, curve, vMax } = model;
  const vLast = curve[curve.length - 1][0];
  const atV = (v, label, what) => {
    const c = cAt(curve, c0, v);
    return tile(label, cap(c), `${pctText(100 * (c / c0 - 1))} · ${what}`, c / c0);
  };
  const out = [tile('Nominal', cap(c0), [model.dielectric, rated > 0 ? `${volts(rated)} rated` : null]
    .filter(Boolean).join(' · ') || 'at 0 V', 1)];
  if (rated > 0) {
    out.push(atV(DEFAULT_SHARE * rated, `At ${volts(DEFAULT_SHARE * rated)}`, 'half the rating'));
    out.push(atV(rated, `At ${volts(rated)}`, 'the rated voltage'));
  } else {
    out.push(atV(vLast, `At ${volts(vLast)}`, 'the last point'));
  }
  const nPoints = model.how === 'curve' ? curve.length : 1;
  out.push(tile('Curve data', `${nPoints} point${nPoints === 1 ? '' : 's'}`,
    `0 – ${volts(vLast)}${vLast < vMax ? ', extrapolated above' : ''}`));
  return el('div', 'cbias-tiles', null, out);
}

/** The "Capacitance at" card: a voltage box and the curve's value there; returns {card, set(v)}. */
function lookupCard(model, onChange) {
  const input = el('input', 'cbias-input');
  input.type = 'number';
  input.min = '0';
  input.step = 'any';
  input.inputMode = 'decimal';
  input.setAttribute('aria-label', 'DC voltage in volts');
  const value = el('div', 'cbias-readout-value', '–');
  const note = el('div', 'cbias-readout-note', '');
  const vLast = model.curve[model.curve.length - 1][0];
  const show = (v) => {
    if (!(v >= 0)) {
      value.textContent = '–';
      note.textContent = 'Type a voltage';
      return;
    }
    const c = cAt(model.curve, model.c0, v);
    value.textContent = cap(c);
    note.textContent = `${pctText(100 * (c / model.c0 - 1))} from nominal` +
      (v > vLast * (1 + 1e-9) ? ` · extrapolated above ${volts(vLast)}` : '');
  };
  input.addEventListener('input', () => {
    const v = input.value.trim() === '' ? null : parseFloat(input.value);
    show(v);
    onChange(v !== null && v >= 0 ? v : null);
  });
  const card = el('div', 'cbias-card', null, [
    el('div', 'cbias-card-head', null, [el('div', 'cbias-card-title', 'Capacitance at')]),
    el('div', 'cbias-input-wrap', null, [input, el('span', 'cbias-input-unit', 'V')]),
    el('div', 'cbias-readout', null, [value, note]),
    el('div', 'cbias-hint', 'Or click a voltage on the chart.')
  ]);
  return {
    card,
    set: (v) => {
      input.value = v === null ? '' : String(v);
      show(v);
    }
  };
}

/** The given points as a table, with the nominal at 0 V. */
function pointsCard(model) {
  const row = (cells, cls = '') => el('tr', cls, null, cells.map((t) => el('td', '', t)));
  const head = el('tr', '', null, ['DC bias', 'Capacitance', 'ΔC'].map((t) => el('th', '', t)));
  const body = [row(['0 V', cap(model.c0), 'nominal'], 'cbias-nominal'),
    ...model.curve.map(([v, c]) => row([volts(v), cap(c), pctText(100 * (c / model.c0 - 1))]))];
  return el('div', 'cbias-card', null, [
    el('div', 'cbias-card-head', null, [el('div', 'cbias-card-title', 'Points'),
      el('div', 'cbias-card-note', model.how === 'default voltage' ? 'placed at half the rating' : '')]),
    el('table', 'cbias-table', null, [el('thead', '', null, [head]), el('tbody', '', null, body)])
  ]);
}

/** A block of parameter text with a copy button (when the browser allows the clipboard). */
function codeBlock(text) {
  const children = [el('span', '', text)];
  if (navigator.clipboard?.writeText) {
    const btn = el('button', 'cbias-icon-btn', null, [icon('copy', 15)]);
    btn.type = 'button';
    btn.title = 'Copy';
    btn.setAttribute('aria-label', 'Copy the parameter text');
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => {
        btn.replaceChildren(icon('check', 15));
        setTimeout(() => btn.replaceChildren(icon('copy', 15)), 1500);
      }).catch(() => {});
    });
    children.push(btn);
  }
  return el('div', 'cbias-code', null, children);
}

/** The parameter the curve comes from, as written. */
function sourceCard(model) {
  return el('div', 'cbias-card', null, [
    el('div', 'cbias-card-head', null, [el('div', 'cbias-card-title', model.source),
      el('div', 'cbias-card-note', 'part parameter')]),
    codeBlock(model.text)
  ]);
}

/** An alert box (warn / error) with a title and an optional body. */
function alertBox(kind, title, body = []) {
  return el('div', `cbias-alert cbias-${kind}`, null, [icon('alert', 18),
    el('div', '', null, [el('div', 'cbias-alert-title', title), ...body])]);
}

/** The loading placeholder: the layout's shape, pulsing. */
function skeleton() {
  const block = (h) => {
    const b = el('div', 'cbias-skel');
    b.style.height = `${h}px`;
    return b;
  };
  return el('div', 'cbias-stack', null, [
    el('div', 'cbias-tiles', null, [block(104), block(104), block(104), block(104)]),
    block(360)
  ]);
}

/** The panel's content for a model from describeCurve; returns a function that stops its resize watching. */
function renderModel(host, model, names) {
  if (model.status === 'none') {
    const generic = !model.reason || model.reason === 'No DC-bias curve available';
    const text = el('div', 'cbias-empty-text');
    if (generic) {
      text.append('Add a ', el('code', '', names.curve), ' parameter to this part, e.g. ',
        el('code', '', '-5%@10V, -34%@30V, -61%@50V'), ', read off the maker\'s DC-bias chart.');
    } else {
      text.textContent = model.reason;
    }
    host.replaceChildren(el('div', 'cbias-empty', null, [el('div', 'cbias-empty-icon', null, [icon('chart', 24)]),
      el('div', 'cbias-empty-title', 'No DC-bias curve available'), text]));
    return () => {};
  }
  if (model.status === 'error') {
    const body = [];
    if (model.text) body.push(el('div', '', null, [codeBlock(model.text)]));
    body.push(el('ul', '', null, model.problems.map((p) => el('li', '', p))));
    body[0].style.margin = '8px 0 0';
    host.replaceChildren(alertBox('error', `${model.source ?? 'The curve'} can't be read`, body));
    return () => {};
  }

  const state = { mode: remember('mode') === 'abs' ? 'abs' : 'pct', lookupV: null };
  const chartHost = el('div', 'cbias-chart');
  const redraw = () => drawChart(chartHost, model, state, (v) => {
    state.lookupV = v;
    lookup.set(v);
    redraw();
  });
  const lookup = lookupCard(model, (v) => {
    state.lookupV = v;
    redraw();
  });

  const seg = el('div', 'cbias-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Chart scale');
  for (const [mode, label] of [['pct', 'ΔC %'], ['abs', 'Capacitance']]) {
    const b = el('button', '', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.mode === mode));
    b.addEventListener('click', () => {
      state.mode = mode;
      remember('mode', mode);
      for (const other of seg.children) other.setAttribute('aria-pressed', String(other === b));
      redraw();
    });
    seg.appendChild(b);
  }

  const chartCard = el('div', 'cbias-card', null, [
    el('div', 'cbias-card-head', null, [el('div', 'cbias-card-title', 'Capacitance against DC bias'), seg]),
    chartHost,
    legend(model)
  ]);
  const notes = [...model.notes, 'Interpolated as GroundTruth does it. Typical small-signal values at 25 °C; ' +
    'above the last point the curve is extrapolated.'];
  host.replaceChildren(el('div', 'cbias-stack', null, [
    ...model.warnings.map((w) => alertBox('warn', w)),
    tiles(model),
    el('div', 'cbias-main', null, [chartCard,
      el('div', 'cbias-side', null, [lookup.card, pointsCard(model), sourceCard(model)])]),
    el('div', 'cbias-foot', null, notes.map((t) => el('div', '', t)))
  ]));

  const start = model.rated > 0 ? Number((DEFAULT_SHARE * model.rated).toPrecision(3)) : null;
  state.lookupV = start;
  lookup.set(start);
  // redraw when the panel's width changes (the window, InvenTree's side bar), at most once a frame
  let lastWidth = -1;
  let frame = 0;
  const observer = new ResizeObserver(() => {
    if (chartHost.clientWidth === lastWidth) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      lastWidth = chartHost.clientWidth;
      redraw();
    });
  });
  observer.observe(chartHost);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
  };
}

/**
 * InvenTree's entry point (the panel's source names it): draw the part's DC-bias curve into `target`. context.id is
 * the part, context.api InvenTree's authenticated API client, context.context.names the parameter names the plugin's
 * settings give.
 */
export function renderPanel(target, context) {
  installStyle();
  target._cbiasStop?.();                       // a previous render into this element: stop its resize watching
  const names = { ...DEFAULT_NAMES, ...(context?.context?.names ?? {}) };
  const reload = el('button', 'cbias-btn', null, [icon('refresh', 15), el('span', '', 'Reload')]);
  reload.type = 'button';
  const content = el('div');
  target.replaceChildren(el('div', 'cbias', null, [el('div', 'cbias-stack', null, [
    el('div', 'cbias-toolbar', null, [
      el('div', 'cbias-toolbar-text', `The capacitance against the DC voltage across it, from the part's ` +
        `${names.curve} parameter.`),
      reload]),
    content])]));

  let stop = () => {};
  target._cbiasStop = () => stop();
  const load = () => {
    stop();
    stop = () => {};
    content.replaceChildren(skeleton());
    if (!context?.api || context?.id === undefined || context?.id === null) {
      content.replaceChildren(alertBox('error', 'No part to show.'));
      return;
    }
    fetchParameters(context.api, context.id)
      .then((params) => {
        stop = renderModel(content, describeCurve(params, names), names);
      })
      .catch((error) => {
        console.error('cbias panel: could not load the parameters', error);
        content.replaceChildren(alertBox('error', 'Could not load the part\'s parameters',
          [el('div', '', String(error?.response?.status ?? error?.message ?? error))]));
      });
  };
  reload.addEventListener('click', load);
  load();
}
