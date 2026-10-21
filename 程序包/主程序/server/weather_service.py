"""Resolve optional climate content before invoking the pure weather model."""
import copy
import random

from . import daily_life
from .domain.weather import normalize_weather, refresh_scheduled_weather


CLIMATE_UNAVAILABLE_MESSAGE = '日常通用模块缺失或格式无效，请检查通用包／日常小事'


def load_climate_config(save_root):
    """Use the same normalized snapshot as clients, with no source fallback."""
    return daily_life.load_data(save_root, 'climate', public=True)


def refresh_encounter_weather(encounter, total_seconds, save_root,
                              previous_total_seconds=None, random_fn=random.random):
    """Pause unavailable weather while unrelated clock and turn work continues.

    Load one snapshot for the complete transition. Work on a copy so a failed
    source read never replaces existing weather or partially advances its
    generation marker. No engine-owned climate values are synthesized.
    """
    try:
        config = load_climate_config(save_root)
    except (OSError, ValueError):
        return None
    candidate = {'weather': copy.deepcopy(encounter.get('weather'))}
    anchor = total_seconds if previous_total_seconds is None else previous_total_seconds
    candidate['weather'] = normalize_weather(candidate.get('weather'), anchor, config)
    result = refresh_scheduled_weather(candidate, total_seconds, random_fn, config)
    encounter['weather'] = candidate['weather']
    return result
