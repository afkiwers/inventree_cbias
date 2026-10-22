# InvenTree DC-bias curve plugin

Shows a capacitor's DC-bias (derating) curve on its InvenTree part page, in a **DC bias** panel below Notes.
If the part has no curve, the panel says "No DC-bias curve available".

The curve comes from the part's `Cbias Curve` text parameter. It's read and interpolated exactly as
[GroundTruth](https://github.com/afkiwers/GroundTruth) reads it (`components/bias.py`), so the plot shows the same
capacitance GroundTruth uses in a simulation.

| The parameter holds | What is drawn |
|---|---|
| `-3.7%@0.63V, -16%@1.58V, -43%@3.15V` or `95nF@10V, 66nF@30V` | a monotone cubic (PCHIP) through (0 V, nominal C) and the points; above the last point, `C0 / (1 + (V/V1)²)` through it (dashed) |
| `75nF@50V` (one point) | `C0 / (1 + (V/V1)²)` through the point |
| no `Cbias Curve`, a `Cbias` of `750n` (no voltage) | the one-point curve, placed at `Cbias Voltage`, or else at half the `Rated Voltage` |
| nothing | "No DC-bias curve available" (C0G / NP0: "class I, no DC-bias derating") |

A bare number in the curve is read in µF, as in GroundTruth. Up to 12 points are allowed. The chart runs to the
rated voltage, or to 1.25 × the last point when there's no rating. Hover over the chart, or type a voltage into
"Capacitance at", to read off C and ΔC.

## Install

1. In Admin Center, Plugins, **Install Plugin**:
   - Package Name: `inventree-cbias-plugin`. It must match `setup.py`; `inventree_cbias` fails.
   - Source URL: `git+https://github.com/afkiwers/inventree_cbias.git`. Without `git+`, InvenTree passes the URL to
     pip as a package index (`pip install -i ...`), and pip finds nothing there.
2. Activate **CbiasPlugin**: the **⋯** menu on its row, then **Activate**.
3. Turn on **Enable interface integration** (Settings, Plugin settings). Panels need it.
4. If the plugin's settings say "Error loading settings", or the panel says "Failed to load module
   .../static/plugins/cbias/cbias_panel.js" (a 404), the server's processes haven't all loaded the new plugin yet.
   Activation asks the background worker to copy `cbias_panel.js` into the static files, and a worker that hasn't
   loaded the plugin skips the copy without an error. Deactivate and activate the plugin again, or run `invoke static`
   in the server container. Do the same after every upgrade of the plugin.

The panel appears on a part when its category path contains `capacitor` (case doesn't matter), or when the part has
a `Capacitance`, `Cbias` or `Cbias Curve` parameter. The parameter names and the category keyword can be changed in
the plugin's settings.

Tested against InvenTree's 0.18 plugin interface. On 1.1+ the panel reads `/api/parameter/` (parameters for every
model), and on older servers it falls back to `/api/part/parameter/`. It reads through the logged-in user's own API
session, so InvenTree's permissions apply. Parameter text is inserted only as text, never as HTML.

## Development

The interpolation is a port of GroundTruth's Python. `tests/reference.json` holds GroundTruth's own answers, and the
JavaScript is checked against them, bit for bit at the time of writing:

```sh
node --test tests/test_curve.mjs
# after a change to GroundTruth's components/bias.py or components/values.py, regenerate the reference:
<GroundTruth>/.venv/Scripts/python tests/make_reference.py tests/reference.json
```
