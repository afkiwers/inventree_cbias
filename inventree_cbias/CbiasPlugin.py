"""
InvenTree plugin: a capacitor's DC-bias (derating) curve on its part page.

A "DC bias" panel on every capacitor's part page draws the curve the part's `Cbias Curve` parameter gives, read and
interpolated the way GroundTruth (github.com/afkiwers/GroundTruth, components/bias.py) does it; a capacitor without
one shows "No DC-bias curve available". The work is done in the browser (static/cbias_panel.js): it reads the part's
parameters through InvenTree's own REST API, so every request is the logged-in user's and InvenTree checks the
permissions. This class only decides on which part pages the panel appears and passes the parameter names on.
"""
import structlog

from part.models import Part
from plugin import InvenTreePlugin
from plugin.mixins import SettingsMixin, UserInterfaceMixin

from .version import CBIAS_PLUGIN_VERSION

logger = structlog.get_logger('inventree')


class CbiasPlugin(SettingsMixin, UserInterfaceMixin, InvenTreePlugin):
    """Adds the "DC bias" panel (a capacitor's derating curve) to capacitor part pages."""

    NAME = 'CbiasPlugin'
    SLUG = 'cbias'
    TITLE = 'Capacitor DC-bias curve'
    DESCRIPTION = "Plots a capacitor's DC-bias (derating) curve from its Cbias Curve parameter, as GroundTruth reads it"
    VERSION = CBIAS_PLUGIN_VERSION
    AUTHOR = 'Andre Iwers'
    MIN_VERSION = '0.17.0'      # the React UI's plugin panels

    # The parameter template names the panel reads: GroundTruth's field names by default
    PARAMETER_SETTINGS = {
        'curve': ('CURVE_PARAMETER', 'Cbias Curve',
                  'Text parameter with the curve, e.g. -5%@10V, -34%@30V or 95nF@10V, 66nF@30V'),
        'cbias': ('CBIAS_PARAMETER', 'Cbias', 'Used when there is no curve: one value, a point or a list'),
        'cbiasVoltage': ('CBIAS_VOLTAGE_PARAMETER', 'Cbias Voltage', 'The voltage a single Cbias value holds at'),
        'capacitance': ('CAPACITANCE_PARAMETER', 'Capacitance', 'The nominal capacitance (the curve starts there at 0 V)'),
        'ratedVoltage': ('RATED_VOLTAGE_PARAMETER', 'Rated Voltage', 'The rated voltage (the chart runs up to it)'),
        'dielectric': ('DIELECTRIC_PARAMETER', 'Dielectric', 'C0G / NP0: class I, no DC-bias derating'),
    }

    SETTINGS = {
        **{key: {'name': f'{default} parameter', 'description': description, 'default': default}
           for key, default, description in PARAMETER_SETTINGS.values()},
        'CATEGORY_KEYWORD': {
            'name': 'Capacitor category keyword',
            'description': 'The panel shows on parts whose category path contains this (any case), and on parts '
                           'with a Capacitance, Cbias or Cbias Curve parameter',
            'default': 'capacitor',
        },
    }

    def parameter_names(self) -> dict:
        """{panel key: parameter template name} from the settings."""
        return {key: (self.get_setting(setting) or default).strip()
                for key, (setting, default, _) in self.PARAMETER_SETTINGS.items()}

    def get_ui_panels(self, request, context, **kwargs):
        """The "DC bias" panel on a capacitor's part page; nothing on other pages."""
        context = context or {}
        if context.get('target_model') != 'part':
            return []
        try:
            pk = int(context.get('target_id'))
        except (TypeError, ValueError):
            return []
        names = self.parameter_names()
        if not self.is_capacitor(pk, names):
            return []
        return [{
            'key': 'cbias-curve',
            'title': 'DC bias',
            'description': "The capacitor's DC-bias (derating) curve",
            'icon': 'ti:chart-line:outline',
            'source': self.plugin_static_file('cbias_panel.js:renderPanel'),
            'context': {'names': names},
        }]

    def is_capacitor(self, pk: int, names: dict) -> bool:
        """Whether part pk is a capacitor: its category path contains the keyword, or it has one of the capacitor
        parameters. When the check itself fails the panel is shown (it then says what it finds)."""
        try:
            part = Part.objects.select_related('category').filter(pk=pk).first()
            if part is None:
                return False
            keyword = (self.get_setting('CATEGORY_KEYWORD') or '').strip().lower()
            if keyword and part.category is not None and keyword in (part.category.pathstring or '').lower():
                return True
            wanted = {names[k].lower() for k in ('curve', 'cbias', 'capacitance') if names.get(k)}
            return bool(wanted & self.parameter_template_names(part))
        except Exception:
            logger.exception('cbias: could not check whether part %s is a capacitor', pk)
            return True

    @staticmethod
    def parameter_template_names(part) -> set:
        """The names (lower case) of the part's parameters' templates."""
        try:
            # InvenTree 1.1+: one Parameter model for every kind of object
            from common.models import Parameter
            qs = Parameter.objects.filter(model_type=part.get_content_type(), model_id=part.pk)
        except ImportError:
            from part.models import PartParameter
            qs = PartParameter.objects.filter(part=part)
        return {name.strip().lower() for name in qs.values_list('template__name', flat=True) if name}
