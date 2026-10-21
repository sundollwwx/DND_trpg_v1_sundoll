"""Hourly climate simulation; every climate value lives in the general module.

The simulation is a local model, not an official D&D weather generator. Official
environment effects are documented separately in the same content module.
"""
import math
import random

from .values import finite_number

# Structural calendar compatibility exports. The model reads its calendar from
# climate.json; this existing campaign calendar is not a universal D&D calendar.
WORLD_SECONDS_PER_DAY = 24 * 60 * 60
WORLD_DAYS_PER_WEEK = 7
WORLD_WEEKS_PER_YEAR = 52
WEATHER_ROLLOVER_SECONDS = 8 * 60 * 60  # Legacy import compatibility only.
MAX_WEATHER_CATCHUP_DAYS = 3660  # Legacy import compatibility; no longer used.

def _config_snapshot(config):
    """The service supplies a validated snapshot; the domain never loads it."""
    if config is None:
        raise ValueError('天气算法需要显式传入气候配置')
    return config


def weather_hour_index(total_seconds, config=None):
    config = _config_snapshot(config)
    total = max(0, int(finite_number(total_seconds) or 0))
    return total // int(config['schedule']['secondsPerStep'])


def weather_day_index(total_seconds):
    """Legacy callers can still ask for a calendar day; it no longer schedules."""
    return max(0, int(finite_number(total_seconds) or 0)) // WORLD_SECONDS_PER_DAY


def weather_season(total_seconds, config=None):
    config = _config_snapshot(config)
    calendar = config['calendar']
    day_seconds = int(calendar['minutesPerDay']) * 60
    days_per_week = int(calendar['daysPerWeek'])
    days_per_year = days_per_week * int(calendar['weeksPerYear'])
    total = max(0, int(finite_number(total_seconds) or 0))
    week = (total // day_seconds % days_per_year) // days_per_week + 1
    for season in config['seasons']:
        if season['firstWeek'] <= week <= season['lastWeek']:
            return season['key']
    raise ValueError('通用气候配置的季节未覆盖当前周')


def _round_tenth(value):
    # Match Math.round in the host exactly, including negative half-ties.
    return math.floor(value * 10 + .5) / 10


def normalize_weather(raw, total_seconds=None, config=None):
    config = _config_snapshot(config)
    defaults = config['defaultWeather']
    source = raw if isinstance(raw, dict) else {}
    climate = source.get('climate') if source.get('climate') in config['climates'] else defaults['climate']
    condition = source.get('condition') if source.get('condition') in config['conditions'] else defaults['condition']
    wind = source.get('wind') if source.get('wind') in config['winds'] else defaults['wind']
    temperature = finite_number(source.get('temperature'))
    temperature = temperature if temperature is not None else defaults['temperature']
    limits = config['temperature']
    temperature = _round_tenth(max(limits['min'], min(limits['max'], temperature)))
    generated_hour = finite_number(source.get('generatedHour'))
    # Old generatedDay is intentionally not expanded into years of catch-up.
    # Anchor once at the current world time, then persist the hourly marker.
    if generated_hour is None:
        generated_hour = weather_hour_index(total_seconds, config) if total_seconds is not None else None
    return {
        'climate': climate, 'condition': condition,
        'temperature': temperature, 'wind': wind,
        'generatedHour': max(0, int(generated_hour)) if generated_hour is not None else None,
        'auto': source['auto'] if isinstance(source.get('auto'), bool) else defaults['auto'],
    }


def effective_weather_temperature(raw, hour, config=None):
    """Current temperature before whole-degree UI rounding, from module data.

    Keep this derived value out of saves: its hourly offset changes with the
    clock even while a DM has fixed the background temperature manually.
    """
    config = _config_snapshot(config)
    normalized = normalize_weather(raw, config=config)
    safe_hour = max(0, min(23, int(finite_number(hour) or 0)))
    profile = config['climates'][normalized['climate']]
    offset = math.floor(profile['diurnalRange'] * config['temperature']['hourlyCurve'][safe_hour] + .5)
    settings = config['temperature']
    return max(settings['min'], min(settings['max'], normalized['temperature'] + offset))


def weighted_weather_choice(weights, random_fn=random.random):
    options = [(key, float(value)) for key, value in weights.items() if float(value) > 0]
    total = sum(weight for _, weight in options)
    if not options or total <= 0:
        return None
    sample = finite_number(random_fn())
    sample = max(0.0, min(0.9999999999999998, sample if sample is not None else 0.0))
    cursor = sample * total
    for key, weight in options:
        cursor -= weight
        if cursor < 0:
            return key
    return options[-1][0]


def climate_weather_weights(profile, season, previous_condition, config=None):
    config = _config_snapshot(config)
    base = {}
    for condition in profile['weather'].get(season, profile['weather']['spring']):
        if condition in config['conditions']:
            base[condition] = base.get(condition, 0) + 1
    transitions = profile['transitions']['weather']
    transition = transitions.get(previous_condition, transitions[config['defaultWeather']['condition']])
    return {condition: weight * float(transition.get(condition, 0))
            for condition, weight in base.items()}


def weather_wind_weights(condition, previous_wind, config=None, profile=None):
    config = _config_snapshot(config)
    profile = profile if profile is not None else config['climates'][config['defaultWeather']['climate']]
    local = profile['transitions']
    weather_weights = local['weatherWind'].get(
        condition, local['weatherWind'][config['defaultWeather']['condition']])
    transitions = local['wind']
    transition = transitions.get(previous_wind, transitions[config['defaultWeather']['wind']])
    return {wind: float(weather_weights.get(wind, 0)) * float(transition.get(wind, 0))
            for wind in config['winds']}


def generate_climate_weather(encounter, climate_key=None, total_seconds=None,
                             random_fn=random.random, generated_hour=None, config=None):
    """One hourly Markov transition with slow temperature and wind inertia."""
    config = _config_snapshot(config)
    world = encounter.get('worldTime') if isinstance(encounter.get('worldTime'), dict) else {}
    if total_seconds is None:
        total_seconds = max(0, int(finite_number(world.get('totalSeconds')) or 0))
    previous = normalize_weather(encounter.get('weather'), total_seconds, config)
    climate = climate_key if climate_key in config['climates'] else previous['climate']
    switched_climate = climate != previous['climate']
    profile = config['climates'][climate]
    season = weather_season(total_seconds, config)
    condition = weighted_weather_choice(
        climate_weather_weights(profile, season, previous['condition'], config), random_fn
    ) or config['defaultWeather']['condition']
    expected = profile['temperatures'][season] + config['conditions'][condition]['temperatureDelta']
    settings = config['temperature']
    noise_sample = finite_number(random_fn())
    noise = (max(0.0, min(1.0, noise_sample if noise_sample is not None else 0.0)) * 2 - 1) * settings['noise']
    # A move between climates reanchors to the destination. Within one climate,
    # hourly background temperature changes remain small and retain memory.
    if switched_climate:
        temperature = expected + noise
    else:
        step = (expected - previous['temperature']) * (1 - settings['inertia']) + noise
        step = max(-settings['maxHourlyStep'], min(settings['maxHourlyStep'], step))
        temperature = previous['temperature'] + step
    temperature = _round_tenth(max(settings['min'], min(settings['max'], temperature)))
    # Ordinary precipitation must agree with the current temperature, while
    # retaining slow thermal inertia. The module's cutoff is a model choice,
    # not an official D&D temperature threshold for snowfall.
    hour_of_day = (max(0, int(finite_number(total_seconds) or 0)) // 3600) % 24
    if (previous['auto'] and condition in ('snow', 'heavySnow')
            and effective_weather_temperature({'climate': climate, 'temperature': temperature}, hour_of_day, config)
            > settings['maxSnowTemperature']):
        condition = 'heavyRain' if condition == 'heavySnow' else 'rain'
    wind = weighted_weather_choice(weather_wind_weights(condition, previous['wind'], config, profile), random_fn) or config['defaultWeather']['wind']
    hour = max(0, int(generated_hour)) if generated_hour is not None else weather_hour_index(total_seconds, config)
    encounter['weather'] = {
        'climate': climate, 'condition': condition, 'temperature': temperature,
        'wind': wind, 'generatedHour': hour, 'auto': previous['auto'],
    }
    return encounter['weather']


def refresh_scheduled_weather(encounter, total_seconds, random_fn=random.random, config=None):
    """Advance once per crossed hour; rewind or manual mode only reanchors.

    Exact catch-up is bounded by the module's maxCatchupHours. Longer jumps run
    only the final bounded interval; climate.json documents that approximation.
    """
    config = _config_snapshot(config)
    encounter['weather'] = normalize_weather(encounter.get('weather'), total_seconds, config)
    current_hour = weather_hour_index(total_seconds, config)
    generated_hour = encounter['weather']['generatedHour']
    if not encounter['weather']['auto'] or current_hour < generated_hour:
        encounter['weather']['generatedHour'] = current_hour
        return None
    if current_hour == generated_hour:
        return None
    first_hour = max(generated_hour + 1, current_hour - int(config['schedule']['maxCatchupHours']) + 1)
    for hour in range(first_hour, current_hour + 1):
        generate_climate_weather(
            encounter, encounter['weather']['climate'],
            hour * int(config['schedule']['secondsPerStep']),
            random_fn, hour, config,
        )
    return encounter['weather']
