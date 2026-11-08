"""Persistent regional directory. Seeds are host candidates, never invented schools."""
from __future__ import annotations
import hashlib,json,re,time,unicodedata
from datetime import datetime,timezone
from app.diary_providers import portal_origin,UnsupportedPortal

SEEDS=[('chelyabinsk','https://sgo.edu-74.ru','Челябинская область'),('samara','https://asurso.ru','Самарская область'),('primorye','https://sgo.prim-edu.ru','Приморский край'),('krasnodar','https://sgo.rso23.ru','Краснодарский край'),('yanao','https://sgo.yanao.ru','ЯНАО'),('tomsk','https://sgo.tomedu.ru','Томская область'),('tver','https://sgo.tvobr.ru','Тверская область'),('uln','https://sgo.cit73.ru','Ульяновская область'),('sakhalin','https://sgo.sakhalin.gov.ru','Сахалинская область'),('volgograd','https://sgo.volganet.ru','Волгоградская область')]
SCHEMA='''
CREATE TABLE IF NOT EXISTS sgo_hosts_registry(host_id TEXT PRIMARY KEY,base_url TEXT UNIQUE NOT NULL,region_name TEXT NOT NULL,api_prefix TEXT NOT NULL DEFAULT '/webapi',esia_auth_url TEXT,myschool_auth_url TEXT,is_active INTEGER NOT NULL DEFAULT 1,last_probed_at TEXT,last_status TEXT NOT NULL DEFAULT 'not_verified',metadata TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS schools_directory(school_uid TEXT PRIMARY KEY,host_id TEXT NOT NULL REFERENCES sgo_hosts_registry(host_id),base_url TEXT NOT NULL,name TEXT NOT NULL,short_name TEXT NOT NULL,city TEXT NOT NULL,region TEXT NOT NULL,search_blob TEXT NOT NULL,cid INTEGER NOT NULL,sid INTEGER NOT NULL,pid INTEGER NOT NULL,cn INTEGER NOT NULL,sft INTEGER NOT NULL,scid INTEGER NOT NULL,supported_auth_methods TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS schools_host ON schools_directory(host_id);
CREATE INDEX IF NOT EXISTS schools_search ON schools_directory(search_blob);
CREATE TABLE IF NOT EXISTS sgo_city_names(host_id TEXT NOT NULL,city_id INTEGER NOT NULL,name TEXT NOT NULL,PRIMARY KEY(host_id,city_id));
CREATE TABLE IF NOT EXISTS student_school_binding(student_uid TEXT PRIMARY KEY REFERENCES accounts(uid),tg_user_id INTEGER,school_uid TEXT NOT NULL REFERENCES schools_directory(school_uid),resolved_base_url TEXT NOT NULL,preferred_auth_method TEXT NOT NULL DEFAULT 'sgo_credentials',sgo_student_id INTEGER,student_display_name TEXT,class_name TEXT,bound_at TEXT NOT NULL,last_login_at TEXT);
CREATE INDEX IF NOT EXISTS student_binding_tg ON student_school_binding(tg_user_id);
CREATE TABLE IF NOT EXISTS sgo_auth_flows(digest TEXT PRIMARY KEY,student_uid TEXT NOT NULL,school_uid TEXT NOT NULL,method TEXT NOT NULL,expires REAL NOT NULL,payload TEXT NOT NULL);
'''
PARAMS=('cid','sid','pid','cn','sft','scid')
def valid_location_id(key,value):
    # NetSchool uses NEGATIVE pid for urban districts (observed on real
    # Cheboksary, Tver, Cherkessk forms). They are not missing/invalid IDs.
    return type(value) is int and -(2**31)<value<2**31 and (value>=0 or key=='pid')
def utc():return datetime.now(timezone.utc).isoformat()

# v2.3.2 (D2) · Доверенный узел — только из поставляемого каталога (catalog_id с тем же адресом) или из
# конфигурации оператора (SGO_DIRECTORY_JSON → metadata.source='operator_config'). Узел, когда-то
# добавленный по адресу из запроса пользователя, остаётся в БД (данные не удаляются), но не виден в
# поиске/регионах и не получает ни одного запроса и ни одного пароля.
OPERATOR_SOURCE='operator_config'
def _catalog_urls():
    from app.school_registry import native_candidates
    return {p['id']:p['base_url'] for p in native_candidates()}
def is_trusted(host):
    md=host.get('metadata') if isinstance(host,dict) else None
    if isinstance(md,str):
        try:md=json.loads(md or '{}')
        except ValueError:return False
    if not isinstance(md,dict):return False
    if md.get('source')==OPERATOR_SOURCE:return True
    cid=md.get('catalog_id')
    return isinstance(cid,str) and _catalog_urls().get(cid)==host.get('base_url')
def trusted_host_ids(db):
    rows=db.execute('SELECT host_id,base_url,metadata FROM sgo_hosts_registry WHERE is_active=1').fetchall()
    return [r[0] for r in rows if is_trusted({'base_url':r[1],'metadata':r[2]})]
def normalize(value):
    value=unicodedata.normalize('NFKC',value.replace('№',' ')).lower().replace('ё','е')
    value=re.sub(r'\b(?:сош|общеобразовательная)\b','школа',value)
    return ' '.join(re.findall(r'[\w]+',value,flags=re.UNICODE))

def migrate(db):
    from app.diary_handoff import SCHEMA as HANDOFF_SCHEMA
    from app.sgo_oauth import SCHEMA as OAUTH_SCHEMA
    for statement in (SCHEMA+HANDOFF_SCHEMA+OAUTH_SCHEMA).split(';'):
        if statement.strip():db.execute(statement)
    # Additive migration supports earlier directory-only previews too.
    for name,typ in [('last_status',"TEXT NOT NULL DEFAULT 'not_verified'"),('metadata',"TEXT NOT NULL DEFAULT '{}'"),('esia_auth_url','TEXT'),('myschool_auth_url','TEXT'),('last_probed_at','TEXT')]:
        if name not in {r[1] for r in db.execute('PRAGMA table_info(sgo_hosts_registry)')}:
            db.execute(f'ALTER TABLE sgo_hosts_registry ADD COLUMN {name} {typ}')
    if 'login_params' not in {r[1] for r in db.execute('PRAGMA table_info(schools_directory)')}:
        db.execute("ALTER TABLE schools_directory ADD COLUMN login_params TEXT")
    from app.school_registry import native_candidates
    candidates=native_candidates();by_url={p['base_url']:p for p in candidates}
    def seed_metadata(p):
        return {'catalog_id':p['id'],'sources':p['sources'],'source_status':p['source_status'],
                'auth_policy':p['auth_policy'],'direct_login':p['auth_policy']!='esia_only'} if p else {}
    for key,url,region in SEEDS:
        db.execute('INSERT OR IGNORE INTO sgo_hosts_registry(host_id,base_url,region_name,metadata) VALUES(?,?,?,?)',('sgo-'+key,url,region,json.dumps(seed_metadata(by_url.get(url)),ensure_ascii=False)))
    for p in candidates:
        metadata={'catalog_id':p['id'],'sources':p['sources'],'source_status':p['source_status'],
                  'auth_policy':p['auth_policy'],'direct_login':p['auth_policy']!='esia_only'}
        # Never reactivate disabled hosts or overwrite an administrator's OAuth,
        # encoding, API-prefix or direct-login policy on repeated migrations.
        db.execute('INSERT OR IGNORE INTO sgo_hosts_registry(host_id,base_url,region_name,metadata) VALUES(?,?,?,?)',
                   (p['id'],p['base_url'],p['region'],json.dumps(metadata,ensure_ascii=False)))

    from app.school_regions import migrate_regions
    migrate_regions(db)
    from app.school_seed import migrate as migrate_seed
    migrate_seed(db)
    from app.school_search_index import migrate as migrate_search
    migrate_search(db)
    from app.school_text import migrate as migrate_text
    migrate_text(db)
    from app.institution_catalog import migrate as migrate_institutions
    migrate_institutions(db)
    from app.autonomous_school import ensure as migrate_autonomous   # v2.4 · автономный режим школы
    migrate_autonomous(db)

class Directory:
    def __init__(self,repo):self.repo=repo
    def host(self,key):
        with self.repo.tx() as db:r=db.execute('SELECT * FROM sgo_hosts_registry WHERE (host_id=? OR base_url=?) AND is_active=1',(key,key)).fetchone()
        if not r:raise UnsupportedPortal('Узел не зарегистрирован')
        d=dict(r);d['metadata']=json.loads(d['metadata']);return d
    def hosts(self,trusted_only=True):
        with self.repo.tx() as db:
            rows=[dict(r) for r in db.execute('SELECT host_id,base_url,region_name,last_status,last_probed_at,metadata FROM sgo_hosts_registry WHERE is_active=1 ORDER BY region_name')]
        out=[]
        for r in rows:
            md=r.pop('metadata')
            if not trusted_only or is_trusted({'base_url':r['base_url'],'metadata':md}):out.append(r)
        return out
    def trusted(self,host):return is_trusted(host)
    def trusted_host(self,key):
        """Активный ДОВЕРЕННЫЙ узел или UnsupportedPortal: перед любым сетевым запросом к узлу."""
        h=self.host(key)
        if not is_trusted(h):raise UnsupportedPortal('Сервер этой школы не входит в проверенный каталог')
        return h
    def register(self,url,region='Пользовательский узел',metadata=None):
        from app.school_regions import canonical_region
        region=canonical_region(region)
        origin=portal_origin(url);key='custom-'+hashlib.sha256(origin.encode()).hexdigest()[:16]
        with self.repo.tx() as db:
            old=db.execute('SELECT host_id FROM sgo_hosts_registry WHERE base_url=?',(origin,)).fetchone()
            if old:
                if metadata is not None:db.execute('UPDATE sgo_hosts_registry SET metadata=?,region_name=? WHERE host_id=?',(json.dumps(metadata),region,old[0]))
                return self._host_from_db(db,old[0])
            db.execute('INSERT INTO sgo_hosts_registry(host_id,base_url,region_name,metadata) VALUES(?,?,?,?)',(key,origin,region,json.dumps(metadata or {})))
            return self._host_from_db(db,key)
    def _host_from_db(self,db,key):
        d=dict(db.execute('SELECT * FROM sgo_hosts_registry WHERE host_id=?',(key,)).fetchone());d['metadata']=json.loads(d['metadata']);return d
    def set_prefix(self,key,prefix):
        """v2.2: префикс API, найденный автоопределением (app/sgo_client.API_PREFIXES), — на узел, не на процесс."""
        from app.sgo_client import API_PREFIXES
        if prefix not in API_PREFIXES:raise ValueError('Invalid API prefix')
        with self.repo.tx() as db:db.execute('UPDATE sgo_hosts_registry SET api_prefix=? WHERE host_id=?',(prefix,key))
    def mark(self,key,status):
        with self.repo.tx() as db:db.execute('UPDATE sgo_hosts_registry SET last_status=?,last_probed_at=? WHERE host_id=?',(status,utc(),key))
    def remember_cities(self,host_id,doc):
        rows=doc.get('cities',[])
        if not isinstance(rows,list):return
        with self.repo.tx() as db:
            for row in rows[:5000]:
                if isinstance(row,dict) and valid_location_id('cn',row.get('id')) and isinstance(row.get('name'),str):
                    db.execute('INSERT INTO sgo_city_names VALUES(?,?,?) ON CONFLICT(host_id,city_id) DO UPDATE SET name=excluded.name',
                               (host_id,row['id'],row['name'][:300]))
    def city_name(self,host_id,city_id):
        with self.repo.tx() as db:row=db.execute('SELECT name FROM sgo_city_names WHERE host_id=? AND city_id=?',(host_id,city_id)).fetchone()
        return row[0] if row else ''
    def school(self,key):
        with self.repo.tx() as db:r=db.execute('SELECT * FROM schools_directory WHERE school_uid=?',(key,)).fetchone()
        if not r:raise UnsupportedPortal('Школа не найдена; сначала выполни поиск')
        d=dict(r);d['supported_auth_methods']=json.loads(d['supported_auth_methods']);d['login_params']=json.loads(d['login_params']) if d.get('login_params') else {k:d[k] for k in PARAMS};h=self.host(d['host_id']);d['host_status']=h['last_status'];return d
    def save(self,host,school):
        # Modern NetSchool search resolves scid directly. Legacy hierarchy IDs
        # are optional and MUST NOT be fabricated or sent as zero on the wire.
        params={k:school[k] for k in PARAMS if school.get(k) is not None}
        if 'scid' not in params or any(not valid_location_id(k,v) for k,v in params.items()) or params['scid']==0:raise ValueError('Invalid resolved school parameters')
        ids={k:params.get(k,0) for k in PARAMS} # legacy NOT NULL SQLite columns; login_params is authoritative
        name=str(school.get('name') or school.get('shortName') or '').strip();short=str(school.get('shortName') or name)
        if not name or len(name)>500:raise ValueError('Invalid school name')
        from app.school_names import checked_names
        name,short=checked_names(self.repo,host['host_id'],ids['scid'],name,short)
        city=str(school.get('city') or school.get('address') or '')[:300];uid=f"{host['host_id']}:{ids['scid']}"
        methods=['sgo_credentials'] if host['metadata'].get('direct_login',True) else []
        methods += [m for m in ('gosuslugi_esia','moya_shkola') if host['metadata'].get('oauth',{}).get(m)]
        values=(uid,host['host_id'],host['base_url'],name,short,city,host['region_name'],normalize(' '.join([name,short,city,host['region_name'],host['base_url']])),*(ids[k] for k in PARAMS),json.dumps(methods),utc())
        with self.repo.tx() as db:
            db.execute('INSERT INTO schools_directory(school_uid,host_id,base_url,name,short_name,city,region,search_blob,cid,sid,pid,cn,sft,scid,supported_auth_methods,updated_at) VALUES('+','.join('?' for _ in values)+') ON CONFLICT(school_uid) DO UPDATE SET name=excluded.name,short_name=excluded.short_name,city=excluded.city,search_blob=excluded.search_blob,cid=excluded.cid,sid=excluded.sid,pid=excluded.pid,cn=excluded.cn,sft=excluded.sft,supported_auth_methods=excluded.supported_auth_methods,updated_at=excluded.updated_at',values)
            from app.school_text import latin
            db.execute('UPDATE schools_directory SET login_params=?,search_latin=? WHERE school_uid=?',(json.dumps(params),latin(' '.join([name,short,city,host['region_name'],host['base_url']])),uid))
        return uid
    def search(self,query,region=None,host_id=None,city=None,limit=40,offset=0,trusted_only=True):
        if type(limit) is not int or not 1<=limit<=101 or type(offset) is not int or not 0<=offset<=1000000:raise ValueError("Invalid search page")
        from app.school_text import find
        clauses=['h.is_active=1'];args=[]
        if trusted_only:
            with self.repo.tx() as db:ids=trusted_host_ids(db)
            clauses.append('s.host_id IN ('+(','.join('?' for _ in ids) or 'NULL')+')');args.extend(ids)
        if region:
            from app.school_regions import canonical_region
            clauses.append('s.region=?');args.append(canonical_region(region))
        if host_id:clauses.append('s.host_id=?');args.append(host_id)
        if city:clauses.append('s.city=?');args.append(city)
        with self.repo.tx() as db:
            rows=find(db,'schools_directory','schools_latin_fts',query,clauses,args,limit,offset,
                      select='s.*,h.last_status AS host_status',
                      join='JOIN sgo_hosts_registry h ON s.host_id=h.host_id')
        from app.school_names import is_masked_school_name
        rows=[r for r in rows if not is_masked_school_name(r['name'])]
        for row in rows:row['supported_auth_methods']=json.loads(row['supported_auth_methods'])
        return rows
    def binding(self,uid):
        with self.repo.tx() as db:r=db.execute('SELECT * FROM student_school_binding WHERE student_uid=?',(uid,)).fetchone()
        return {**dict(r),**self.school(r['school_uid'])} if r else None
    def select(self,uid,key,telegram_id=None):
        school=self.school(key)
        with self.repo.tx() as db:
            old=db.execute('SELECT school_uid FROM student_school_binding WHERE student_uid=?',(uid,)).fetchone()
            connected=db.execute('SELECT 1 FROM connections WHERE uid=?',(uid,)).fetchone()
            if connected and (not old or old[0]!=key):raise ValueError('Сначала отключи текущий дневник')
            if old and old[0]==key:return {**dict(db.execute('SELECT * FROM student_school_binding WHERE student_uid=?',(uid,)).fetchone()),**school}
            db.execute('DELETE FROM sgo_auth_flows WHERE student_uid=?',(uid,))
            db.execute('INSERT INTO student_school_binding(student_uid,tg_user_id,school_uid,resolved_base_url,bound_at) VALUES(?,?,?,?,?) ON CONFLICT(student_uid) DO UPDATE SET school_uid=excluded.school_uid,resolved_base_url=excluded.resolved_base_url,tg_user_id=excluded.tg_user_id,sgo_student_id=NULL,student_display_name=NULL,class_name=NULL,last_login_at=NULL', (uid,telegram_id,key,school['base_url'],utc()))
            db.execute('UPDATE accounts SET used=1 WHERE uid=?',(uid,))
        return self.binding(uid)
