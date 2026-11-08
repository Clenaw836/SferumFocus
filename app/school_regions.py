"""Canonical persisted region catalog. A region entry is NOT an integration claim.
Portal candidates are separately registered and anonymously probed before use.
"""
from functools import lru_cache
from pathlib import Path

REGIONS = '''Алтайский край
Амурская область
Архангельская область
Астраханская область
Белгородская область
Брянская область
Владимирская область
Волгоградская область
Вологодская область
Воронежская область
Еврейская автономная область
Забайкальский край
Ивановская область
Иркутская область
Кабардино-Балкарская Республика
Калининградская область
Калужская область
Камчатский край
Карачаево-Черкесская Республика
Кемеровская область — Кузбасс
Кировская область
Костромская область
Краснодарский край
Красноярский край
Курганская область
Курская область
Ленинградская область
Липецкая область
Магаданская область
Москва
Московская область
Мурманская область
Ненецкий автономный округ
Нижегородская область
Новгородская область
Новосибирская область
Омская область
Оренбургская область
Орловская область
Пензенская область
Пермский край
Приморский край
Псковская область
Республика Адыгея
Республика Алтай
Республика Башкортостан
Республика Бурятия
Республика Дагестан
Республика Ингушетия
Республика Калмыкия
Республика Карелия
Республика Коми
Республика Марий Эл
Республика Мордовия
Республика Саха (Якутия)
Республика Северная Осетия — Алания
Республика Татарстан
Республика Тыва
Республика Хакасия
Ростовская область
Рязанская область
Самарская область
Санкт-Петербург
Саратовская область
Сахалинская область
Свердловская область
Севастополь
Смоленская область
Ставропольский край
Тамбовская область
Тверская область
Томская область
Тульская область
Тюменская область
Удмуртская Республика
Ульяновская область
Хабаровский край
Ханты-Мансийский автономный округ — Югра
Челябинская область
Чеченская Республика
Чувашская Республика
Чукотский автономный округ
Ямало-Ненецкий автономный округ
Ярославская область'''.splitlines()

# Product geography follows the 89-position Russian administrative list.
# Listing is for service discovery, not a statement on disputed sovereignty.
REGIONS = sorted(set(REGIONS) | {
    'Республика Крым', 'Донецкая Народная Республика',
    'Луганская Народная Республика', 'Запорожская область', 'Херсонская область',
})
REGION_ALIASES = {
    'Ямало-Ненецкий автономный округ': ['ЯНАО', 'Ямал'],
    'Ханты-Мансийский автономный округ — Югра': ['ХМАО', 'ХМАО-Югра', 'Югра'],
    'Кемеровская область — Кузбасс': ['Кемеровская область', 'Кузбасс'],
    'Республика Северная Осетия — Алания': ['Северная Осетия', 'РСО-Алания'],
    'Республика Саха (Якутия)': ['Якутия', 'Саха'],
    'Москва': ['г. Москва', 'город Москва', 'МСК'],
    'Санкт-Петербург': ['г. Санкт-Петербург', 'Санкт Петербург', 'СПб', 'Петербург'],
    'Московская область': ['Подмосковье'],
    'Донецкая Народная Республика': ['ДНР'],
    'Луганская Народная Республика': ['ЛНР'],
    'Республика Татарстан': ['Татарстан'],
    'Республика Башкортостан': ['Башкортостан', 'Башкирия'],
    'Республика Крым': ['Крым'],
}

def region_key(value):
    import re, unicodedata
    return ' '.join(re.findall(r'[\w]+', unicodedata.normalize('NFKC', value).casefold().replace('ё', 'е')))

_LOOKUP = {region_key(alias): name for name in REGIONS
           for alias in [name, *REGION_ALIASES.get(name, [])]}

def canonical_region(value):
    return _LOOKUP.get(region_key(value), value.strip())

def migrate_regions(db):
    import json
    db.execute('CREATE TABLE IF NOT EXISTS school_regions(name TEXT PRIMARY KEY, aliases TEXT NOT NULL)')
    for name in REGIONS:
        db.execute('INSERT INTO school_regions VALUES(?,?) ON CONFLICT(name) DO UPDATE SET aliases=excluded.aliases',
                   (name, json.dumps(REGION_ALIASES.get(name, []), ensure_ascii=False)))
    # Only canonicalize known labels. Preserve operator hosts, sessions, IDs,
    # custom regions and school bindings. Repeated migrations are idempotent.
    for name, aliases in REGION_ALIASES.items():
        for alias in aliases:
            db.execute('UPDATE sgo_hosts_registry SET region_name=? WHERE region_name=?', (name, alias))
            db.execute('UPDATE schools_directory SET region=? WHERE region=?', (name, alias))

def search_aliases(name):
    # Search-only settlement hints. Never map these strings to NetSchool sid/cn.
    return list(dict.fromkeys([*REGION_ALIASES.get(name, []), *_search_aliases().get(name, [])]))

_SEARCH_ALIASES_PATH = Path(__file__).parent / 'data' / 'region_search_aliases.json'


@lru_cache(maxsize=1)
def _search_aliases():
    import json
    import logging
    path = _SEARCH_ALIASES_PATH
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        # Extra aliases improve search but are not required for canonical regions.
        # Do not let an omitted optional seed crash identity or basic directory APIs.
        logging.getLogger(__name__).error(
            'school_region_search_aliases_unavailable file=app/data/region_search_aliases.json'
        )
        return {}
    regions = data.get('regions') if isinstance(data, dict) else None
    if not isinstance(regions, dict):
        raise ValueError('Invalid region search aliases schema')
    return regions

def region_items(hosts, portals):
    names = sorted(set(REGIONS) | {canonical_region(h['region_name']) for h in hosts}
                   | {canonical_region(p['region']) for p in portals})
    result = []
    for name in names:
        local = [h for h in hosts if canonical_region(h['region_name']) == name]
        other = sum(canonical_region(p['region']) == name and p['integration'] != 'native_candidate' for p in portals)
        online = sum(h['last_status'] == 'online' for h in local)
        result.append({'name': name, 'aliases': search_aliases(name),
                       'portals': len(local), 'other_services': other,
                       'public_api_responded': online,
                       'connection_support': 'native_candidate' if local else 'external_only' if other else 'manual_only',
                       'automatic_import_verified': False})
    return result
