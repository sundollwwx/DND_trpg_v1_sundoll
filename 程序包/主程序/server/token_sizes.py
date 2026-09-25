"""Creature rank is independent of its grid footprint; legacy one-cell tokens are medium."""
CATEGORIES = ('tiny', 'small', 'medium', 'large', 'huge', 'gargantuan')
FOOTPRINTS = (.5, 1, 1, 2, 3, 4)


def size_category(token):
    value = token.get('sizeCategory')
    if value in CATEGORIES:
        return value
    size = token.get('size')
    return {0.5: 'tiny', 2: 'large', 3: 'huge', 4: 'gargantuan'}.get(size, 'medium') if type(size) in (float, int) else 'medium'


def size_rank(token):
    return CATEGORIES.index(size_category(token))


def size_fields(token):
    rank = size_rank(token)
    return {'sizeCategory': CATEGORIES[rank], 'size': FOOTPRINTS[rank]}


def can_ride(rider, mount):
    return bool(rider and mount and rider is not mount and size_rank(mount) > size_rank(rider))


def mount_anchor(token, map_obj):
    seen = set()
    while token.get('mountId') and token.get('id') not in seen:
        seen.add(token.get('id'))
        mount = next((t for t in map_obj.get('tokens', []) if t.get('id') == token['mountId']), None)
        if not can_ride(token, mount): break
        token = mount
    return token


def sync_riders(map_obj):
    for token in map_obj.get('tokens', []):
        anchor = mount_anchor(token, map_obj)
        if anchor is not token:
            token['x'], token['y'] = anchor.get('x'), anchor.get('y')


def snapped_point(map_obj, token, point):
    import math
    grid = float(map_obj.get('gridSize') or 50)
    size = size_fields(token)['size']
    step = grid / 2 if size == .5 else grid
    result = {}
    for axis, extent_key, offset_key in [('x', 'mapW', 'gridOffsetX'), ('y', 'mapH', 'gridOffsetY')]:
        extent = float(map_obj.get(extent_key) or 0)
        offset = float(map_obj.get(offset_key) or 0)
        margin = min(size * grid / 2, extent / 2)
        phase = offset + (grid / 4 if size == .5 else grid / 2 if size % 2 else 0)
        low = phase + math.ceil((margin - phase) / step) * step
        high = phase + math.floor((extent - margin - phase) / step) * step
        value = phase + math.floor((point[axis] - phase) / step + .5) * step
        result[axis] = extent / 2 if low > high else max(low, min(high, value))
    return result
