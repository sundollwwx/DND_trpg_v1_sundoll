"""Numeric input normalization shared by domain services."""
import math
def finite_number(value):
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def finite_int(value, minimum=None, maximum=None, fallback=None):
    number = finite_number(value)
    if number is None:
        return fallback
    value = int(number)
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


