"""Naming rules shared by filesystem catalogs."""
import re

def safe_campaign_name(value):
    return re.sub(r'[\\/:*?"<>|]', '_', str(value or '')).strip()


