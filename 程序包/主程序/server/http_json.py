"""Parse interoperable HTTP JSON without accepting non-finite numbers."""
import json
import math


def loads(raw):
    def reject(_value):
        raise ValueError('JSON 数字必须有限')

    def finite(value):
        number = float(value)
        if not math.isfinite(number):
            reject(value)
        return number

    return json.loads(raw, parse_constant=reject, parse_float=finite)
