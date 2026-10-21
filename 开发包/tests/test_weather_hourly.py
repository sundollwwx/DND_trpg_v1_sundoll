"""Meaningful hourly scheduling, migration, and simulation invariants."""
from project_test_paths import DAILY_LIFE_FIXTURE, PACKAGE_ROOT
import copy
import json
import random
import unittest
from unittest import mock

from server.domain import weather

CONFIG = json.loads((DAILY_LIFE_FIXTURE / '资料/climate.json').read_text('utf-8'))


def encounter(hour=8, auto=True):
    return {'worldTime': {'totalSeconds': hour * 3600}, 'weather': {
        **CONFIG['defaultWeather'], 'generatedHour': hour, 'auto': auto,
    }}


class HourlyWeatherTests(unittest.TestCase):
    def test_module_manual_default_applies_when_no_boolean_auto_is_saved(self):
        config = copy.deepcopy(CONFIG)
        config['defaultWeather']['auto'] = False
        for raw in (None, {}, {'auto': None}, {'auto': 'true'}, {'auto': 1}):
            with self.subTest(raw=raw):
                self.assertFalse(weather.normalize_weather(raw, 3600, config=config)['auto'])
        self.assertTrue(weather.normalize_weather({'auto': True}, 3600, config=config)['auto'])
        self.assertFalse(weather.normalize_weather({'auto': False}, 3600, config=CONFIG)['auto'])
        value = {'weather': {'generatedHour': 8}}
        self.assertIsNone(weather.refresh_scheduled_weather(value, 99 * 3600,
            random_fn=lambda: self.fail('the module defaults to manual weather'), config=config))
        self.assertFalse(value['weather']['auto'])
        self.assertEqual(value['weather']['generatedHour'], 99)

    def test_old_daily_state_anchors_once_without_decades_of_random_rolls(self):
        value = {'weather': {**CONFIG['defaultWeather'], 'generatedDay': 0}}
        with mock.patch.object(weather.random, 'random', side_effect=AssertionError('must not roll')):
            result = weather.refresh_scheduled_weather(value, 364 * 60 * 86400, lambda: self.fail('must not roll'), config=CONFIG)
        self.assertIsNone(result)
        self.assertEqual(value['weather']['generatedHour'], 364 * 60 * 24)
        self.assertNotIn('generatedDay', value['weather'])

    def test_crossed_hours_are_each_generated_once_and_repeated_calls_do_not_roll(self):
        value = encounter()
        calls = []
        sample = lambda: calls.append(True) or .42
        self.assertIsNotNone(weather.refresh_scheduled_weather(value, 11 * 3600 + 123, sample, config=CONFIG))
        self.assertEqual(len(calls), 9)
        self.assertEqual(value['weather']['generatedHour'], 11)
        previous = copy.deepcopy(value['weather'])
        self.assertIsNone(weather.refresh_scheduled_weather(value, 11 * 3600 + 599, sample, config=CONFIG))
        self.assertEqual(value['weather'], previous)
        self.assertEqual(len(calls), 9)

    def test_one_large_jump_equals_the_same_hourly_path_with_identical_rng(self):
        first, second = encounter(), encounter()
        random_a, random_b = random.Random(741), random.Random(741)
        weather.refresh_scheduled_weather(first, 42 * 3600 + 1, random_a.random, config=CONFIG)
        for hour in range(9, 43):
            weather.refresh_scheduled_weather(second, hour * 3600 + 1, random_b.random, config=CONFIG)
        self.assertEqual(first['weather'], second['weather'])

    def test_manual_weather_survives_hours_and_rewind_only_reanchors(self):
        value = encounter(auto=False)
        original = copy.deepcopy(value['weather'])
        no_roll = lambda: self.fail('manual weather cannot roll')
        self.assertIsNone(weather.refresh_scheduled_weather(value, 99 * 3600, no_roll, config=CONFIG))
        self.assertEqual(value['weather'], {**original, 'generatedHour': 99})
        self.assertIsNone(weather.refresh_scheduled_weather(value, 4 * 3600, no_roll, config=CONFIG))
        self.assertEqual(value['weather'], {**original, 'generatedHour': 4})
        value['weather']['auto'] = True
        self.assertIsNotNone(weather.refresh_scheduled_weather(value, 5 * 3600, lambda: .42, config=CONFIG))
        self.assertEqual(value['weather']['generatedHour'], 5)

    def test_automatic_rewind_does_not_invent_past_weather(self):
        value = encounter(hour=88)
        old = copy.deepcopy(value['weather'])
        self.assertIsNone(weather.refresh_scheduled_weather(value, 3 * 3600, lambda: self.fail('rewind must not roll'), config=CONFIG))
        self.assertEqual(value['weather'], {**old, 'generatedHour': 3})

    def test_temperature_moves_slowly_but_a_climate_move_reanchors(self):
        value = encounter()
        value['weather']['temperature'] = -50
        old = value['weather']['temperature']
        result = weather.generate_climate_weather(value, 'temperate', 9 * 3600, lambda: .42, config=CONFIG)
        self.assertLessEqual(abs(result['temperature'] - old), CONFIG['temperature']['maxHourlyStep'] + .051)
        changed = weather.generate_climate_weather(value, 'tropical', 10 * 3600, lambda: .42, config=CONFIG)
        expected = CONFIG['climates']['tropical']['temperatures']['spring'] + CONFIG['conditions'][changed['condition']]['temperatureDelta']
        self.assertAlmostEqual(changed['temperature'], expected, delta=CONFIG['temperature']['noise'] + .051)
        self.assertGreater(changed['temperature'], 15)

    def test_long_catchup_bound_and_season_changes(self):
        config = copy.deepcopy(CONFIG)
        config['schedule']['maxCatchupHours'] = 3
        value, calls = encounter(hour=0), []
        weather.refresh_scheduled_weather(value, 99999 * 3600, lambda: calls.append(True) or .5, config=config)
        self.assertEqual(len(calls), 9)
        self.assertEqual(value['weather']['generatedHour'], 99999)
        self.assertEqual(weather.weather_season(13 * 7 * 86400 - 1, config=CONFIG), 'spring')
        self.assertEqual(weather.weather_season(13 * 7 * 86400, config=CONFIG), 'summer')
        self.assertEqual(weather.weather_season(52 * 7 * 86400, config=CONFIG), 'spring')

    def test_transition_retains_memory_and_no_seasonally_absent_snow(self):
        profile = CONFIG['climates']['temperate']
        rain = weather.climate_weather_weights(profile, 'spring', 'rain', config=CONFIG)
        clear = weather.climate_weather_weights(profile, 'spring', 'clear', config=CONFIG)
        self.assertGreater(rain['rain'] / sum(rain.values()), .80)
        self.assertGreater(clear['clear'] / sum(clear.values()), .80)
        value = encounter()
        summer = 14 * 7 * 86400
        for hour in range(120):
            weather.generate_climate_weather(value, 'temperate', summer + hour * 3600, config=CONFIG)
            self.assertNotEqual(value['weather']['condition'], 'snow')

    def test_environment_thresholds_use_current_temperature_before_display_rounding(self):
        cold, hot = (0 - 32) * 5 / 9, (100 - 32) * 5 / 9
        for base, expect_cold, expect_hot in ((37.7, False, False), (37.8, False, True),
                                            (-17.7, False, False), (-17.8, True, False)):
            current = weather.effective_weather_temperature({'temperature': base}, 8, config=CONFIG)
            self.assertEqual(current, base)
            self.assertEqual(current <= cold, expect_cold)
            self.assertEqual(current >= hot, expect_hot)

    def test_automatic_snow_changes_to_rain_above_the_model_cutoff_without_a_temperature_jump(self):
        climate, season, hour = 'coastal', 'winter', 14
        week = next(item['firstWeek'] for item in CONFIG['seasons'] if item['key'] == season)
        total = (week - 1) * 7 * 86400 + hour * 3600
        weights = weather.climate_weather_weights(CONFIG['climates'][climate], season, 'snow', config=CONFIG)
        preceding = 0
        for key, weight in weights.items():
            if key == 'snow':
                break
            preceding += weight
        selection = (preceding + weights['snow'] / 2) / sum(weights.values())
        for initial, expected in ((2, 'snow'), (2.1, 'rain'), (15, 'rain')):
            value = encounter(total // 3600)
            value['weather'].update(climate=climate, condition='snow', temperature=initial)
            samples = iter((selection, .5, .5))
            result = weather.generate_climate_weather(value, climate, total, lambda: next(samples), config=CONFIG)
            self.assertEqual(result['condition'], expected)
            self.assertLessEqual(abs(result['temperature'] - initial), CONFIG['temperature']['maxHourlyStep'] + .051)
            if expected == 'snow':
                self.assertLessEqual(weather.effective_weather_temperature(result, hour, config=CONFIG), CONFIG['temperature']['maxSnowTemperature'])
            else:
                self.assertGreater(weather.effective_weather_temperature(result, hour, config=CONFIG), CONFIG['temperature']['maxSnowTemperature'])
            with self.assertRaises(StopIteration):
                next(samples)

    def test_automatic_fog_never_keeps_strong_wind_but_manual_scene_is_preserved(self):
        for climate, profile in CONFIG['climates'].items():
            for condition in ('fog', 'lightFog'):
                for previous in CONFIG['winds']:
                    with self.subTest(climate=climate, condition=condition, previous=previous):
                        weights = weather.weather_wind_weights(condition, previous, config=CONFIG, profile=profile)
                        self.assertEqual(weights['strong'], 0)
                        self.assertEqual(weights['gale'], 0)
                        self.assertGreater(weights['calm'] + weights['breeze'], 0)
                        for sample in (0, .5, .999999):
                            self.assertIn(weather.weighted_weather_choice(weights, lambda: sample), ('calm', 'breeze'))
        value = encounter(auto=False)
        value['weather'].update(condition='fog', wind='gale')
        weather.refresh_scheduled_weather(value, 14 * 3600, lambda: self.fail('manual scene cannot roll'), config=CONFIG)
        self.assertEqual((value['weather']['condition'], value['weather']['wind']), ('fog', 'gale'))

    def test_six_profiles_have_distinct_weather_and_wind_probabilities(self):
        weather_rows, wind_rows = set(), set()
        for climate, profile in CONFIG['climates'].items():
            rain = weather.climate_weather_weights(profile, 'spring', 'rain', config=CONFIG)
            winds = weather.weather_wind_weights('rain', 'breeze', config=CONFIG, profile=profile)
            weather_rows.add(tuple(sorted((key, round(weight / sum(rain.values()), 8)) for key, weight in rain.items())))
            wind_rows.add(tuple(round(weight / sum(winds.values()), 8) for weight in winds.values()))
            for row in profile['transitions']['weather'].values():
                self.assertEqual((row['wind'], row['heat']), (0, 0))
            if climate in ('arid', 'tropical'):
                self.assertFalse(any(key in ('snow', 'heavySnow') for pool in profile['weather'].values() for key in pool))
            if climate in ('cold', 'highland'):
                for season in ('autumn', 'winter'):
                    self.assertIn('snow', profile['weather'][season])
                    self.assertIn('heavySnow', profile['weather'][season])
        self.assertEqual(len(weather_rows), 6)
        self.assertEqual(len(wind_rows), 6)
        # An arid rainy episode is more likely to clear next hour than a
        # coastal one; regional behavior is not only a relabelled climate.
        dry = weather.climate_weather_weights(CONFIG['climates']['arid'], 'spring', 'rain', config=CONFIG)
        coast = weather.climate_weather_weights(CONFIG['climates']['coastal'], 'spring', 'rain', config=CONFIG)
        self.assertGreater(dry['clear'] / sum(dry.values()), coast['clear'] / sum(coast.values()))

    def test_generation_uses_the_destination_regions_wind_chain(self):
        config = copy.deepcopy(CONFIG)
        for climate, forced in (('temperate', 'calm'), ('coastal', 'gale')):
            profile = config['climates'][climate]
            profile['weather']['spring'] = ['rain']
            profile['transitions']['weatherWind']['rain'] = {key: int(key == forced) for key in config['winds']}
        first, second = encounter(), encounter()
        self.assertEqual(weather.generate_climate_weather(first, 'temperate', 9*3600, lambda: .42, config=config)['wind'], 'calm')
        self.assertEqual(weather.generate_climate_weather(second, 'coastal', 9*3600, lambda: .42, config=config)['wind'], 'gale')

    def test_legacy_weather_labels_preserve_manual_state_and_leave_automatic_generation(self):
        for condition in ('wind', 'heat'):
            manual = encounter(auto=False)
            manual['weather'].update(condition=condition, temperature=39.4, wind='gale')
            before = copy.deepcopy(manual['weather'])
            weather.refresh_scheduled_weather(manual, 24*3600, lambda: self.fail('manual weather must not roll'), config=CONFIG)
            self.assertEqual(manual['weather'], {**before, 'generatedHour': 24})
            for climate in CONFIG['climates']:
                automatic = encounter()
                automatic['weather'].update(condition=condition, climate=climate)
                result = weather.generate_climate_weather(automatic, climate, 9*3600, lambda: .42, config=CONFIG)
                self.assertNotIn(result['condition'], ('wind', 'heat'))

    def test_automatic_heavy_snow_changes_to_heavy_rain_when_warm(self):
        climate, season, hour = 'coastal', 'winter', 14
        week = next(item['firstWeek'] for item in CONFIG['seasons'] if item['key'] == season)
        total = (week - 1) * 7 * 86400 + hour * 3600
        weights = weather.climate_weather_weights(CONFIG['climates'][climate], season, 'heavySnow', config=CONFIG)
        preceding = 0
        for key, weight in weights.items():
            if key == 'heavySnow': break
            preceding += weight
        selection = (preceding + weights['heavySnow'] / 2) / sum(weights.values())
        for initial, expected in ((-6, 'heavySnow'), (15, 'heavyRain')):
            value = encounter(total // 3600)
            value['weather'].update(climate=climate, condition='heavySnow', temperature=initial)
            samples = iter((selection, .5, .5))
            result = weather.generate_climate_weather(value, climate, total, lambda: next(samples), config=CONFIG)
            self.assertEqual(result['condition'], expected)
            self.assertLessEqual(abs(result['temperature'] - initial), CONFIG['temperature']['maxHourlyStep'] + .051)
            with self.assertRaises(StopIteration): next(samples)



if __name__ == '__main__':
    unittest.main()
