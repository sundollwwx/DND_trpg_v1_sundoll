"""Calendar and climate transitions with injectable random source."""
import math, random
from .values import finite_number
WORLD_SECONDS_PER_DAY = 24 * 60 * 60
WORLD_DAYS_PER_WEEK = 7
WORLD_WEEKS_PER_YEAR = 52
WEATHER_ROLLOVER_SECONDS = 8 * 60 * 60
MAX_WEATHER_CATCHUP_DAYS = 3660
WEATHER_KEYS = ('clear', 'cloudy', 'rain', 'storm', 'fog', 'snow', 'wind', 'heat')
WIND_KEYS = ('calm', 'breeze', 'strong', 'gale')
WEATHER_TEMPERATURE_DELTAS = {
    'clear': 2, 'cloudy': 0, 'rain': -3, 'storm': -5,
    'fog': -2, 'snow': -7, 'wind': -2, 'heat': 7,
}
WEATHER_MARKOV_TRANSITIONS = {
    'clear':  {'clear': 7, 'cloudy': 3, 'rain': .6, 'storm': .15, 'fog': .8, 'snow': .4, 'wind': 1.2, 'heat': 2},
    'cloudy': {'clear': 2.5, 'cloudy': 6, 'rain': 4, 'storm': 1.5, 'fog': 2.5, 'snow': 3, 'wind': 1.5, 'heat': .3},
    'rain':   {'clear': 1.2, 'cloudy': 4, 'rain': 6, 'storm': 2.5, 'fog': 2, 'snow': .8, 'wind': 1.4, 'heat': .1},
    'storm':  {'clear': .8, 'cloudy': 4, 'rain': 5, 'storm': 2, 'fog': .6, 'snow': .5, 'wind': 3, 'heat': .1},
    'fog':    {'clear': 2, 'cloudy': 4, 'rain': 2, 'storm': .4, 'fog': 5, 'snow': 1.5, 'wind': .8, 'heat': .2},
    'snow':   {'clear': 1.5, 'cloudy': 4, 'rain': .8, 'storm': .4, 'fog': 1.8, 'snow': 7, 'wind': 2, 'heat': .05},
    'wind':   {'clear': 2.5, 'cloudy': 3, 'rain': 1.5, 'storm': 2, 'fog': .5, 'snow': 1.5, 'wind': 5, 'heat': 1},
    'heat':   {'clear': 4, 'cloudy': 1, 'rain': .4, 'storm': .8, 'fog': .1, 'snow': .01, 'wind': 2, 'heat': 7},
}
WIND_MARKOV_TRANSITIONS = {
    'calm': {'calm': 6, 'breeze': 4, 'strong': .5, 'gale': .1},
    'breeze': {'calm': 2, 'breeze': 6, 'strong': 2, 'gale': .3},
    'strong': {'calm': .4, 'breeze': 3, 'strong': 5, 'gale': 2},
    'gale': {'calm': .2, 'breeze': 2, 'strong': 5, 'gale': 3},
}
WEATHER_WIND_WEIGHTS = {
    'clear': {'calm': 4, 'breeze': 6, 'strong': 1, 'gale': .05},
    'cloudy': {'calm': 2, 'breeze': 6, 'strong': 2, 'gale': .2},
    'rain': {'calm': .8, 'breeze': 4, 'strong': 3, 'gale': .8},
    'storm': {'calm': .05, 'breeze': .3, 'strong': 4, 'gale': 8},
    'fog': {'calm': 5, 'breeze': 3, 'strong': .4, 'gale': .05},
    'snow': {'calm': 1.5, 'breeze': 4, 'strong': 3, 'gale': .8},
    'wind': {'calm': .1, 'breeze': 1, 'strong': 7, 'gale': 3},
    'heat': {'calm': 3, 'breeze': 5, 'strong': 1.5, 'gale': .1},
}
CLIMATE_PROFILES = {
    'temperate': {
        'temperatures': {'spring': 14, 'summer': 25, 'autumn': 15, 'winter': 3},
        'weather': {
            'spring': ['clear', 'cloudy', 'rain', 'rain', 'fog', 'wind'],
            'summer': ['clear', 'clear', 'cloudy', 'rain', 'storm', 'heat'],
            'autumn': ['clear', 'cloudy', 'rain', 'fog', 'wind', 'wind'],
            'winter': ['clear', 'cloudy', 'snow', 'snow', 'fog', 'wind'],
        },
    },
    'cold': {
        'temperatures': {'spring': 0, 'summer': 12, 'autumn': 2, 'winter': -15},
        'weather': {
            'spring': ['cloudy', 'snow', 'rain', 'wind', 'fog'],
            'summer': ['clear', 'cloudy', 'rain', 'fog', 'wind'],
            'autumn': ['cloudy', 'rain', 'snow', 'wind', 'fog'],
            'winter': ['snow', 'snow', 'clear', 'wind', 'fog'],
        },
    },
    'tropical': {
        'temperatures': {'spring': 27, 'summer': 29, 'autumn': 28, 'winter': 26},
        'weather': {
            'spring': ['clear', 'rain', 'rain', 'storm', 'fog'],
            'summer': ['clear', 'heat', 'rain', 'storm', 'storm'],
            'autumn': ['clear', 'rain', 'rain', 'storm', 'cloudy'],
            'winter': ['clear', 'clear', 'cloudy', 'rain', 'fog'],
        },
    },
    'arid': {
        'temperatures': {'spring': 22, 'summer': 36, 'autumn': 25, 'winter': 14},
        'weather': {
            'spring': ['clear', 'clear', 'heat', 'wind', 'cloudy'],
            'summer': ['clear', 'heat', 'heat', 'wind', 'storm'],
            'autumn': ['clear', 'clear', 'heat', 'wind', 'cloudy'],
            'winter': ['clear', 'clear', 'cloudy', 'wind', 'rain'],
        },
    },
    'coastal': {
        'temperatures': {'spring': 15, 'summer': 23, 'autumn': 17, 'winter': 9},
        'weather': {
            'spring': ['cloudy', 'rain', 'fog', 'wind', 'clear'],
            'summer': ['clear', 'cloudy', 'rain', 'fog', 'storm'],
            'autumn': ['cloudy', 'rain', 'wind', 'storm', 'fog'],
            'winter': ['cloudy', 'rain', 'wind', 'fog', 'snow'],
        },
    },
    'highland': {
        'temperatures': {'spring': 5, 'summer': 16, 'autumn': 7, 'winter': -6},
        'weather': {
            'spring': ['clear', 'cloudy', 'fog', 'rain', 'snow'],
            'summer': ['clear', 'cloudy', 'rain', 'storm', 'wind'],
            'autumn': ['cloudy', 'fog', 'rain', 'snow', 'wind'],
            'winter': ['snow', 'snow', 'clear', 'fog', 'wind'],
        },
    },
}


def weather_day_index(total_seconds):
    total = max(0, int(finite_number(total_seconds) or 0))
    return int(math.floor((total - WEATHER_ROLLOVER_SECONDS) / float(WORLD_SECONDS_PER_DAY)))


def weather_season(total_seconds):
    total = max(0, int(finite_number(total_seconds) or 0))
    day_index = total // WORLD_SECONDS_PER_DAY
    day_of_year = day_index % (WORLD_DAYS_PER_WEEK * WORLD_WEEKS_PER_YEAR)
    week = day_of_year // WORLD_DAYS_PER_WEEK + 1
    if week <= 13:
        return 'spring'
    if week <= 26:
        return 'summer'
    if week <= 39:
        return 'autumn'
    return 'winter'


def normalize_weather(raw, total_seconds=None):
    source = raw if isinstance(raw, dict) else {}
    climate = source.get('climate') if source.get('climate') in CLIMATE_PROFILES else 'temperate'
    condition = source.get('condition') if source.get('condition') in WEATHER_KEYS else 'clear'
    wind = source.get('wind') if source.get('wind') in WIND_KEYS else 'breeze'
    temperature = finite_number(source.get('temperature'))
    temperature = max(-100, min(100, int(round(temperature if temperature is not None else 18))))
    generated_day = finite_number(source.get('generatedDay'))
    if generated_day is None:
        generated_day = weather_day_index(total_seconds if total_seconds is not None else WEATHER_ROLLOVER_SECONDS)
    return {
        'climate': climate,
        'condition': condition,
        'temperature': temperature,
        'wind': wind,
        'generatedDay': int(generated_day),
    }


def weighted_weather_choice(weights, random_fn=random.random):
    options = [(key, float(weights.get(key, 0))) for key in weights if float(weights.get(key, 0)) > 0]
    total = sum(weight for _, weight in options)
    if not options or total <= 0:
        return None
    sample = finite_number(random_fn())
    sample = max(0.0, min(0.999999999999, sample if sample is not None else 0.0))
    cursor = sample * total
    for key, weight in options:
        cursor -= weight
        if cursor < 0:
            return key
    return options[-1][0]


def climate_weather_weights(profile, season, previous_condition):
    base = {}
    for condition in profile.get('weather', {}).get(season, profile.get('weather', {}).get('spring', [])):
        if condition in WEATHER_KEYS:
            base[condition] = base.get(condition, 0) + 1
    transition = WEATHER_MARKOV_TRANSITIONS.get(previous_condition, WEATHER_MARKOV_TRANSITIONS['clear'])
    return dict((condition, weight * float(transition.get(condition, .01)))
                for condition, weight in base.items())


def weather_wind_weights(condition, previous_wind):
    weather_weights = WEATHER_WIND_WEIGHTS.get(condition, WEATHER_WIND_WEIGHTS['clear'])
    transition = WIND_MARKOV_TRANSITIONS.get(previous_wind, WIND_MARKOV_TRANSITIONS['breeze'])
    return dict((wind, float(weather_weights.get(wind, .01)) * float(transition.get(wind, .01)))
                for wind in WIND_KEYS)


def generate_climate_weather(encounter, climate_key=None, total_seconds=None,
                             random_fn=random.random, generated_day=None):
    """运行一次天气马尔可夫转移；温度保留昨日惯性，风力也按独立链转移。"""
    world = encounter.get('worldTime') if isinstance(encounter.get('worldTime'), dict) else {}
    if total_seconds is None:
        total_seconds = max(0, int(finite_number(world.get('totalSeconds')) or 0))
    previous = normalize_weather(encounter.get('weather'), total_seconds)
    climate = climate_key if climate_key in CLIMATE_PROFILES else previous['climate']
    profile = CLIMATE_PROFILES[climate]
    season = weather_season(total_seconds)
    condition = weighted_weather_choice(
        climate_weather_weights(profile, season, previous['condition']), random_fn
    ) or 'clear'
    expected = profile['temperatures'][season] + WEATHER_TEMPERATURE_DELTAS[condition]
    noise = (max(0.0, min(1.0, finite_number(random_fn()) or 0.0)) * 4) - 2
    temperature = max(-100, min(100, int(round(expected * .65 + previous['temperature'] * .35 + noise))))
    wind = weighted_weather_choice(weather_wind_weights(condition, previous['wind']), random_fn) or 'breeze'
    day = int(generated_day) if generated_day is not None else weather_day_index(total_seconds)
    encounter['weather'] = {
        'climate': climate,
        'condition': condition,
        'temperature': temperature,
        'wind': wind,
        'generatedDay': day,
    }
    return encounter['weather']


def refresh_scheduled_weather(encounter, total_seconds, random_fn=random.random):
    """跨过每日 08:00 时逐日推演，超长时间跳跃最多补算十年。"""
    encounter['weather'] = normalize_weather(encounter.get('weather'), total_seconds)
    current_day = weather_day_index(total_seconds)
    generated_day = encounter['weather']['generatedDay']
    if current_day < generated_day:
        encounter['weather']['generatedDay'] = current_day
        return None
    if current_day == generated_day:
        return None
    missing_days = current_day - generated_day
    first_day = (current_day - MAX_WEATHER_CATCHUP_DAYS + 1
                 if missing_days > MAX_WEATHER_CATCHUP_DAYS else generated_day + 1)
    for day in range(first_day, current_day + 1):
        rollover_seconds = max(0, day * WORLD_SECONDS_PER_DAY + WEATHER_ROLLOVER_SECONDS)
        generate_climate_weather(
            encounter,
            encounter['weather']['climate'],
            rollover_seconds,
            random_fn,
            day,
        )
    return encounter['weather']


