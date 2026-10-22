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

/** A value with an SI prefix ("4.7µF"), p significant digits; null -> "?". */
export function formatSi(value, unit = '', p = 6) {
  if (value === null || value === undefined) return '?';
  if (value === 0) return `0${unit}`;
  for (const [mult, prefix] of [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'],
    [1e-9, 'n'], [1e-12, 'p']]) {
    if (Math.abs(value) >= mult * 0.999) {     // 0.999: rounding (999.9999e-9) still gets the larger prefix
      return `${fmtG(value / mult, p)}${prefix}${unit}`;
    }
  }
  return `${fmtG(value, 3)}${unit}`;
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
// Mantine's own CSS variables, so the chart follows InvenTree's light and dark themes
const COLOR = {
  text: 'var(--mantine-color-text, #212529)',
  muted: 'var(--mantine-color-dimmed, #868e96)',
  grid: 'var(--mantine-color-default-border, #dee2e6)',
  accent: 'var(--mantine-primary-color-filled, #228be6)',
  surface: 'var(--mantine-color-body, #ffffff)',
  warn: 'var(--mantine-color-orange-filled, #fd7e14)',
  error: 'var(--mantine-color-red-filled, #fa5252)'
};

/** An HTML element with style, text and children. */
function el(tag, style = {}, text = null, children = []) {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  if (text !== null) e.textContent = text;
  for (const c of children) e.appendChild(c);
  return e;
}

/** An SVG element with attributes. */
function svgEl(tag, attrs = {}, text = null) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== null) e.textContent = text;
  return e;
}

/** A ΔC percentage as the panel writes it: "−42.9 %" (a real minus sign). */
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

/** The chart: ΔC (%) against the DC voltage, the points, a crosshair readout; appended to `host`. */
function drawChart(host, model) {
  const { curve, c0, vMax, rated } = model;
  const W = 720;
  const H = 340;
  const left = 56;
  const right = 20;
  const top = 16;
  const bottom = 46;
  const vLast = curve[curve.length - 1][0];
  const pctAt = (v) => 100 * (cAt(curve, c0, v) / c0 - 1);

  // the curve sampled: solid to the last point (through every point), dashed beyond it
  const N = 300;
  const grid = Array.from({ length: N + 1 }, (_, k) => (vMax * k) / N);
  const solid = [...new Set([...grid.filter((v) => v <= vLast), ...curve.map((p) => p[0])])].sort((a, b) => a - b);
  const dashed = vLast < vMax ? [vLast, ...grid.filter((v) => v > vLast)] : [];
  const all = [...solid, ...dashed].map(pctAt);
  const lo = Math.min(...all, -10);
  const hi = Math.max(...all, 0);
  const yStep = niceStep(hi - lo, 5);
  const yLo = Math.max(-100, Math.floor(lo / yStep) * yStep);
  const yHi = Math.ceil((hi + 0.02 * (hi - lo)) / yStep) * yStep;
  const xStep = niceStep(vMax, 6);

  const x = (v) => left + (v / vMax) * (W - left - right);
  const y = (p) => top + ((yHi - p) / (yHi - yLo)) * (H - top - bottom);

  const wrap = el('div', { position: 'relative', width: '100%', maxWidth: '900px' });
  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img',
    'aria-label': `DC-bias curve: capacitance change against DC voltage, 0 to ${fmtG(vMax, 4)} V`
  });
  svg.style.display = 'block';
  svg.style.height = 'auto';
  svg.style.fontFamily = 'inherit';

  for (let p = yLo; p <= yHi + 1e-9; p += yStep) {              // horizontal grid and the ΔC labels
    svg.appendChild(svgEl('line', { x1: left, x2: W - right, y1: y(p), y2: y(p), stroke: COLOR.grid,
      'stroke-width': Math.abs(p) < 1e-9 ? 1.5 : 1 }));
    svg.appendChild(svgEl('text', { x: left - 8, y: y(p) + 4, 'text-anchor': 'end', 'font-size': 11,
      fill: COLOR.muted }, Math.abs(p) < 1e-9 ? '0 %' : `${p > 0 ? '+' : '−'}${fmtG(Math.abs(p), 4)} %`));
  }
  for (let v = 0; v <= vMax + 1e-9 * vMax; v += xStep) {           // vertical grid and the voltage labels
    svg.appendChild(svgEl('line', { x1: x(v), x2: x(v), y1: top, y2: H - bottom, stroke: COLOR.grid,
      'stroke-width': 1 }));
    svg.appendChild(svgEl('text', { x: x(v), y: H - bottom + 16, 'text-anchor': 'middle', 'font-size': 11,
      fill: COLOR.muted }, `${fmtG(Number(v.toPrecision(6)), 4)} V`));
  }
  svg.appendChild(svgEl('text', { x: (left + W - right) / 2, y: H - 6, 'text-anchor': 'middle', 'font-size': 12,
    fill: COLOR.text }, 'DC voltage across the capacitor'));
  svg.appendChild(svgEl('text', { x: 14, y: (top + H - bottom) / 2, 'text-anchor': 'middle', 'font-size': 12,
    fill: COLOR.text, transform: `rotate(-90 14 ${(top + H - bottom) / 2})` }, 'ΔC from nominal'));

  if (rated > 0 && rated <= vMax) {                          // the rated voltage
    svg.appendChild(svgEl('line', { x1: x(rated), x2: x(rated), y1: top, y2: H - bottom, stroke: COLOR.muted,
      'stroke-width': 1, 'stroke-dasharray': '3 3' }));
    svg.appendChild(svgEl('text', { x: x(rated) - 4, y: top + 12, 'text-anchor': 'end', 'font-size': 11,
      fill: COLOR.muted }, `rated ${fmtG(rated, 4)} V`));
  }

  const poly = (vs, dash) => svgEl('polyline', {
    points: vs.map((v) => `${x(v).toFixed(2)},${y(pctAt(v)).toFixed(2)}`).join(' '),
    fill: 'none', stroke: COLOR.accent, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    ...(dash ? { 'stroke-dasharray': '7 5' } : {})
  });
  svg.appendChild(poly(solid, false));
  if (dashed.length > 1) svg.appendChild(poly(dashed, true));

  for (const [v, c] of curve) {                              // the given points
    const dot = svgEl('circle', { cx: x(v), cy: y(100 * (c / c0 - 1)), r: 4.5, fill: COLOR.accent,
      stroke: COLOR.surface, 'stroke-width': 2 });
    dot.appendChild(svgEl('title', {}, `${fmtG(v, 4)} V: ${formatSi(c, 'F', 4)} (${pctText(100 * (c / c0 - 1))})`));
    svg.appendChild(dot);
  }

  // the hover layer: a crosshair, a dot on the curve and a readout
  const cross = svgEl('line', { y1: top, y2: H - bottom, stroke: COLOR.muted, 'stroke-width': 1, visibility: 'hidden' });
  const ring = svgEl('circle', { r: 5, fill: COLOR.surface, stroke: COLOR.accent, 'stroke-width': 2,
    visibility: 'hidden' });
  const hit = svgEl('rect', { x: left, y: top, width: W - left - right, height: H - top - bottom, fill: 'transparent' });
  svg.appendChild(cross);
  svg.appendChild(ring);
  svg.appendChild(hit);
  const tip = el('div', {
    position: 'absolute', pointerEvents: 'none', display: 'none', padding: '4px 8px', borderRadius: '4px',
    fontSize: '12px', whiteSpace: 'nowrap', background: COLOR.surface, color: COLOR.text,
    border: `1px solid ${COLOR.grid}`, boxShadow: '0 1px 4px rgba(0,0,0,0.15)'
  });
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    ring.setAttribute('visibility', 'hidden');
    tip.style.display = 'none';
  };
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const scale = box.width / W;                          // the viewBox keeps its aspect ratio: one scale
    const sx = (e.clientX - box.left) / scale;
    const v = Math.min(vMax, Math.max(0, ((sx - left) / (W - left - right)) * vMax));
    const c = cAt(curve, c0, v);
    const p = 100 * (c / c0 - 1);
    cross.setAttribute('x1', x(v));
    cross.setAttribute('x2', x(v));
    ring.setAttribute('cx', x(v));
    ring.setAttribute('cy', y(p));
    cross.setAttribute('visibility', 'visible');
    ring.setAttribute('visibility', 'visible');
    tip.textContent = `${fmtG(Number(v.toPrecision(3)), 3)} V · ${formatSi(c, 'F', 4)} · ${pctText(p)}` +
      (v > vLast ? ' · beyond the last point' : '');
    tip.style.display = 'block';
    const px = x(v) * scale;
    const flip = px > box.width * 0.6;                    // keep the readout inside the chart
    tip.style.left = flip ? '' : `${px + 12}px`;
    tip.style.right = flip ? `${box.width - px + 12}px` : '';
    tip.style.top = `${Math.max(0, y(p) * scale - 34)}px`;
  });
  hit.addEventListener('pointerleave', hide);

  wrap.appendChild(svg);
  wrap.appendChild(tip);
  host.appendChild(wrap);
}

/** A line-style key under the chart: solid (through the points) and, when the chart goes past it, dashed (beyond
 * the last point). */
function legend(model) {
  const item = (dash, label) => {
    const s = svgEl('svg', { width: 28, height: 10, 'aria-hidden': 'true' });
    s.appendChild(svgEl('line', { x1: 2, x2: 26, y1: 5, y2: 5, stroke: COLOR.accent, 'stroke-width': 2,
      ...(dash ? { 'stroke-dasharray': '6 4' } : {}) }));
    return el('span', { display: 'inline-flex', alignItems: 'center', gap: '6px', marginRight: '18px' }, null,
      [s, el('span', {}, label)]);
  };
  const one = model.curve.length === 1;
  const items = [item(false, one ? 'C0 / (1 + (V/V1)²) through the point'
    : 'monotone cubic (PCHIP) through 0 V and the points')];
  if (model.curve[model.curve.length - 1][0] < model.vMax) {
    items.push(item(true, 'beyond the last point: C0 / (1 + (V/V1)²) through it'));
  }
  return el('div', { fontSize: '12px', color: COLOR.muted, display: 'flex', flexWrap: 'wrap', rowGap: '4px' }, null,
    items);
}

/** A "C at [ ] V" box: the curve at a typed voltage (the keyboard's way to read it). */
function lookup(model) {
  const out = el('span', { color: COLOR.text, fontVariantNumeric: 'tabular-nums' });
  const input = el('input', { width: '6em', padding: '2px 6px', font: 'inherit', color: COLOR.text,
    background: COLOR.surface, border: `1px solid ${COLOR.grid}`, borderRadius: '4px' });
  input.type = 'number';
  input.min = '0';
  input.step = 'any';
  input.setAttribute('aria-label', 'DC voltage');
  const update = () => {
    const v = parseFloat(input.value);
    if (!(v >= 0)) {
      out.textContent = '';
      return;
    }
    const c = cAt(model.curve, model.c0, v);
    out.textContent = `= ${formatSi(c, 'F', 4)} (${pctText(100 * (c / model.c0 - 1))})`;
  };
  input.addEventListener('input', update);
  if (model.rated > 0) {
    input.value = String(model.rated);
    update();
  }
  return el('label', { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px' }, null,
    [el('span', {}, 'Capacitance at'), input, el('span', {}, 'V'), out]);
}

/** The given points as a table: voltage, capacitance, change. */
function pointsTable(model) {
  const cell = (t, head = false) => el(head ? 'th' : 'td', {
    textAlign: 'right', padding: '4px 12px', borderBottom: `1px solid ${COLOR.grid}`,
    fontWeight: head ? '600' : '400', fontVariantNumeric: 'tabular-nums'
  }, t);
  const rows = [el('tr', {}, null, [cell('DC voltage', true), cell('Capacitance', true), cell('ΔC', true)]),
    el('tr', { color: COLOR.muted }, null, [cell('0 V'), cell(formatSi(model.c0, 'F', 4)), cell('nominal')])];
  for (const [v, c] of model.curve) {
    rows.push(el('tr', {}, null, [cell(`${fmtG(v, 4)} V`), cell(formatSi(c, 'F', 4)),
      cell(pctText(100 * (c / model.c0 - 1)))]));
  }
  return el('table', { borderCollapse: 'collapse', fontSize: '13px', alignSelf: 'flex-start' }, null,
    [el('tbody', {}, null, rows)]);
}

/** The panel's content for a model from describeCurve. */
function renderModel(body, model) {
  const muted = { color: COLOR.muted, fontSize: '13px' };
  if (model.status === 'none') {
    body.appendChild(el('div', { fontSize: '15px', padding: '8px 0' }, model.reason || 'No DC-bias curve available'));
    return;
  }
  if (model.status === 'error') {
    body.appendChild(el('div', { fontSize: '15px', color: COLOR.error }, `${model.source ?? 'The curve'} can't be read`));
    if (model.text) body.appendChild(el('code', { fontSize: '13px' }, model.text));
    body.appendChild(el('ul', { margin: '4px 0', fontSize: '13px' }, null, model.problems.map((p) => el('li', {}, p))));
    return;
  }
  const facts = [`Nominal ${formatSi(model.c0, 'F', 4)}`];
  if (model.rated > 0) facts.push(`rated ${formatSi(model.rated, 'V', 4)}`);
  if (model.dielectric) facts.push(model.dielectric);
  facts.push(`from ${model.source}`);
  body.appendChild(el('div', { fontSize: '14px' }, facts.join(' · ')));
  body.appendChild(el('code', { ...muted, wordBreak: 'break-word' }, model.text));
  for (const w of model.warnings) body.appendChild(el('div', { fontSize: '13px', color: COLOR.warn }, `⚠ ${w}`));
  drawChart(body, model);
  body.appendChild(legend(model));
  body.appendChild(lookup(model));
  body.appendChild(pointsTable(model));
  for (const n of model.notes) body.appendChild(el('div', muted, n));
  body.appendChild(el('div', muted, 'Interpolated as GroundTruth does: typical small-signal values at 25 °C; ' +
    'above the last point the curve is extrapolated.'));
}

/**
 * InvenTree's entry point (the panel's source names it): draw the part's DC-bias curve into `target`. context.id is
 * the part, context.api InvenTree's authenticated API client, context.context.names the parameter names the plugin's
 * settings give.
 */
export function renderPanel(target, context) {
  const names = { ...DEFAULT_NAMES, ...(context?.context?.names ?? {}) };
  const body = el('div', { display: 'flex', flexDirection: 'column', gap: '10px', color: COLOR.text });
  const reload = el('button', { alignSelf: 'flex-start', font: 'inherit', fontSize: '13px', padding: '2px 10px',
    cursor: 'pointer', color: COLOR.text, background: 'transparent', border: `1px solid ${COLOR.grid}`,
    borderRadius: '4px' }, 'Reload');
  const content = el('div', { display: 'flex', flexDirection: 'column', gap: '10px' });
  body.appendChild(reload);
  body.appendChild(content);
  target.replaceChildren(body);

  const load = () => {
    content.replaceChildren(el('div', { color: COLOR.muted }, 'Loading parameters…'));
    if (!context?.api || context?.id === undefined || context?.id === null) {
      content.replaceChildren(el('div', {}, 'No part to show.'));
      return;
    }
    fetchParameters(context.api, context.id)
      .then((params) => {
        content.replaceChildren();
        renderModel(content, describeCurve(params, names));
      })
      .catch((error) => {
        console.error('cbias panel: could not load the parameters', error);
        content.replaceChildren(el('div', { color: COLOR.error },
          `Could not load the part's parameters (${error?.response?.status ?? error?.message ?? error}).`));
      });
  };
  reload.addEventListener('click', load);
  load();
}
