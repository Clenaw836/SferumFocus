"""Versioned public institution seed, never account or authentication data."""
import hashlib,json,re
from pathlib import Path

# v3.2: опорные школы регионов из регионального реестра (источник ``regional_registry_seed`` в public_schools.json).
# Только публичные метаданные учреждения: адрес портала и scid, без учётных данных и данных учеников.
REGIONAL_ANCHORS={'34':('https://sgo.volganet.ru',(2410,1461,1459,1455))}
# До v3.3.1 в сиде были выдуманные scid (34xxxx) только с полем scid: СГО отвечал 409 «неверный логин или пароль»
# на любой верный пароль. Настоящие ID — из публичного /webapi/schools/search. Старые строки убираем, если на
# них никто не ссылается (ссылки student_school_binding не трогаем — данные пользователей не удаляются).
LEGACY_FAKE_SCHOOL_UIDS=tuple(f'sgo-volgograd:{n}' for n in (340121,340005,340001,340003,340009,340081))
# Та же школа под настоящим scid: привязки учеников переносим (для Гимназии № 3 и Лицея № 9 ID не подтверждён).
LEGACY_SCHOOL_REMAP={'sgo-volgograd:340121':'sgo-volgograd:2410','sgo-volgograd:340005':'sgo-volgograd:1461',
                     'sgo-volgograd:340001':'sgo-volgograd:1459','sgo-volgograd:340081':'sgo-volgograd:1455'}

def check_regional_source(source):
    """Источник регионального реестра должен совпадать с объявленным портом региона и списком опорных scid."""
    if source.get('source')!='regional_registry_seed':return
    code=str(source.get('region_code') or '')
    if code not in REGIONAL_ANCHORS:raise ValueError('Unknown regional registry seed')
    base,scids=REGIONAL_ANCHORS[code]
    if source['base_url']!=base or {r['scid'] for r in source['schools']}!=set(scids):raise ValueError('Regional registry seed mismatch')

def migrate(db):
    from app.sgo_directory import PARAMS,normalize,valid_location_id
    path=Path(__file__).parent/'data'/'public_schools.json'
    if not path.exists():return
    raw=path.read_bytes();digest=hashlib.sha256(raw).hexdigest()
    db.execute('CREATE TABLE IF NOT EXISTS school_seed_imports(digest TEXT PRIMARY KEY)')
    if db.execute('SELECT 1 FROM school_seed_imports WHERE digest=?',(digest,)).fetchone():return
    doc=json.loads(raw)
    if doc['schema_version']!=1:raise ValueError('Unknown public school seed schema')
    for source in doc['sources']:
        check_regional_source(source)
        host=db.execute('SELECT * FROM sgo_hosts_registry WHERE base_url=?',(source['base_url'],)).fetchone()
        if not host:continue # seed can never register arbitrary hosts or authentication methods
        for row in source['schools']:
            params={k:row[k] for k in PARAMS if k in row}
            if type(params.get('scid')) is not int or params['scid']<=0 or any(not valid_location_id(k,v) for k,v in params.items()):raise ValueError('Invalid public school IDs')
            name=row['name'].strip();short=str(row.get('shortName') or name);city=str(row.get('city') or '')
            if not name or len(name)>500 or len(short)>500 or len(city)>300:raise ValueError('Invalid public institution metadata')
            from app.school_names import is_masked_school_name
            if is_masked_school_name(name):continue
            if 'демо' in name.casefold() or re.fullmatch(r'\d+',name):continue
            meta=json.loads(host['metadata']);methods=['sgo_credentials'] if meta.get('direct_login',True) else []
            methods += [m for m in ('gosuslugi_esia','moya_shkola') if meta.get('oauth',{}).get(m)]
            values=(f"{host['host_id']}:{params['scid']}",host['host_id'],host['base_url'],name,short,city,host['region_name'],normalize(' '.join([name,short,city,host['region_name'],host['base_url']])),*(params.get(k,0) for k in PARAMS),json.dumps(methods),source['checked_at'],json.dumps(params))
            db.execute('INSERT OR IGNORE INTO schools_directory(school_uid,host_id,base_url,name,short_name,city,region,search_blob,cid,sid,pid,cn,sft,scid,supported_auth_methods,updated_at,login_params) VALUES('+','.join('?' for _ in values)+')',values)
    for legacy,real in LEGACY_SCHOOL_REMAP.items():
        if db.execute('SELECT 1 FROM schools_directory WHERE school_uid=?',(real,)).fetchone():
            db.execute('UPDATE student_school_binding SET school_uid=? WHERE school_uid=?',(real,legacy))
    marks=','.join('?' for _ in LEGACY_FAKE_SCHOOL_UIDS)
    db.execute(f'DELETE FROM schools_directory WHERE school_uid IN ({marks}) AND school_uid NOT IN '
               '(SELECT school_uid FROM student_school_binding)',LEGACY_FAKE_SCHOOL_UIDS)
    db.execute('INSERT INTO school_seed_imports VALUES(?)',(digest,))
