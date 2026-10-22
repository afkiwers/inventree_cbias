"""tests/reference.json: what GroundTruth itself makes of a set of DC-bias texts and values, for tests/test_curve.mjs
to hold the panel's JavaScript port (inventree_cbias/static/cbias_panel.js) to.

Run with GroundTruth's environment (it needs groundtruth and scipy), after a change to GroundTruth's
components/bias.py or values.py:

    <GroundTruth>/.venv/Scripts/python tests/make_reference.py tests/reference.json
"""
import json
import sys

from groundtruth.components.bias import c_at, check_points, parse_bias, resolve
from groundtruth.components.values import parse_quantity

# curve texts: real ones (the user's X6S 1 µF, the help's example, the estimate tool's form), the one-point and
# no-voltage forms, rising points, and texts that must be refused
TEXTS = [
    "-3.7%@0.63V, -16%@1.58V, -43%@3.15V, -60%@4.73V, -71%@6.3V",
    "95nF@10V, 66nF@30V, 39nF@50V, 20nF@80V",
    "-5%@10V; -34%@30V; -61%@50V; -80%@80V",
    "75nF@50V",
    "75 nF @ 50 V",
    "0.075@50V",
    "750n",
    "-50%@40V",
    "101nF@3V, 99nF@10V, 80nF@20V",
    "+1%@2V, -20%@20V, -50%@40V, -85%@100V",
    "-10%@1V -20%@2V -30%@3V -40%@4V -50%@5V -55%@6V -60%@7V -65%@8V -70%@9V -75%@10V -80%@11V -85%@12V",
    "-10%@1V -20%@2V -30%@3V -40%@4V -50%@5V -55%@6V -60%@7V -65%@8V -70%@9V -75%@10V -80%@11V -85%@12V -90%@13V",
    "1.2u@25V, 0.8u@50V",
    "75nF@0V",
    "-120%@10V",
    "+30%@10V",
    "abc@10V",
    "75nF@10A",
    "75nF@10V, 60nF@10V",
    "75nF, 60nF@20V",
    "75nF@1kV, 50nF@2kV",
    "750nF@10V, 500nF@20V",
    "",
]
# value texts for parse_quantity: InvenTree's (pint) forms and datasheet notation
QUANTITIES = [
    ("1u", "F", 1.0), ("1uF", "F", 1.0), ("4n7", "F", 1.0), ("100 nanofarad", "F", 1.0), ("616 picofarad", "F", 1.0),
    ("2.2 µF", "F", 1.0), ("10uF/16V", "F", 1.0), ("0.1", "F", 1e-6), ("1e-7", "F", 1e-6), ("3", "F", 1.0),
    ("100V", "V", 1.0), ("6.3", "V", 1.0), ("6,3V", "V", 1.0), ("1kV", "V", 1.0), ("50 volts", "V", 1.0),
    ("5mV", "V", 1.0), ("10A", "V", 1.0), ("x7r", "F", 1.0), ("", "F", 1.0), ("1/16W", "V", 1.0),
    ("3.8milliohm", "F", 1.0), ("1uFz", "F", 1.0),
]
C0 = {"default": 1e-6, "nF": 100e-9}


def voltages(curve, top):
    """Voltages to compare at: a grid to 1.3 × top, every point, and just either side of each."""
    vs = {top * 1.3 * k / 97 for k in range(98)}
    for v, _ in curve:
        vs.update({v, v * (1 - 1e-9), v * (1 + 1e-9)})
    return sorted(vs)


def main(out):
    """Write the reference file."""
    parses, curves = [], []
    for text in TEXTS:
        points, problems = parse_bias(text)
        parses.append({"text": text, "problems": problems,
                       "points": [{"c": p.c, "pct": p.pct, "v": p.v} for p in points],
                       "texts": [p.text() for p in points]})
        if problems or not points:
            continue
        c0 = C0["nF"] if "nF" in text else C0["default"]
        for v_default in (None, 25.0):
            curve, how = resolve(points, c0, v_default)
            if not curve:
                continue
            top = max(v for v, _ in curve)
            curves.append({"text": text, "c0": c0, "v_default": v_default, "how": how, "curve": curve,
                           "check": check_points(points, c0),
                           "at": [[v, c_at(curve, c0, v)] for v in voltages(curve, top)]})
    quantities = [{"text": t, "quantity": q, "assumed": a, "result": list(parse_quantity(t, q, a))}
                  for t, q, a in QUANTITIES]
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"parses": parses, "curves": curves, "quantities": quantities}, f, indent=1, ensure_ascii=False)
    print(f"{out}: {len(parses)} texts, {len(curves)} curves, {sum(len(c['at']) for c in curves)} values, "
          f"{len(quantities)} quantities")


if __name__ == "__main__":
    main(sys.argv[1])
