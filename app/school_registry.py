"""Versioned, source-attributed public directory. A listed URL is NOT an integration.
National providers are deliberately not copied into every region's host registry.
"""
from __future__ import annotations
import json
import logging
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)
_CATALOG_PATH = Path(__file__).parent / 'data' / 'school_portals.json'


@lru_cache(maxsize=1)
def catalog():
    """Load the verified public portal catalogue.

    A missing *optional public seed* must not prevent platform identity/session
    initialization: PlatformStore runs directory migrations on first request.
    In that degraded case expose an explicitly unavailable empty catalogue (never
    synthetic portals/schools). Invalid or unsupported catalogue content still
    fails loudly instead of being silently accepted.
    """
    try:
        raw = _CATALOG_PATH.read_text(encoding='utf-8')
    except FileNotFoundError:
        logger.error(
            'school_registry_catalog_unavailable file=app/data/school_portals.json; '
            'identity remains available, school directory is degraded'
        )
        return {
            'schema_version': 1,
            'catalog_version': 'unavailable',
            'regions_reviewed': [],
            'notice': 'Публичный каталог школьных порталов не включён в сборку. '
                      'Список школ и внешних сервисов неполон; восстановите app/data/school_portals.json из исходной поставки.',
            'portals': [],
            'national': [],
            '_available': False,
        }
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get('schema_version') != 1:
        raise ValueError('Unsupported school registry schema')
    if not isinstance(data.get('portals'), list) or not isinstance(data.get('national'), list):
        raise ValueError('Invalid school registry catalogue shape')
    data['_available'] = True
    return data


def catalog_available() -> bool:
    return bool(catalog().get('_available', True))

def native_candidates():
    return [p for p in catalog()['portals'] if p['integration']=='native_candidate']

def public_services(region):
    from app.school_regions import canonical_region
    region=canonical_region(region)
    return [p.copy() for p in catalog()['portals'] if canonical_region(p['region'])==region and p['integration']!='native_candidate']+[p.copy() for p in catalog()['national']]
