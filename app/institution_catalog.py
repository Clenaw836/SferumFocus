"""Source-attributed institutions. Login bindings require separate administrator attestation."""
from pathlib import Path
import hashlib,json,re,unicodedata
from uuid import UUID,uuid5,NAMESPACE_URL
from app.school_text import latin,ensure_fts,find
SCHEMA='''CREATE TABLE IF NOT EXISTS public_institutions(institution_uid TEXT PRIMARY KEY,name TEXT NOT NULL,short_name TEXT NOT NULL,city TEXT NOT NULL,region TEXT NOT NULL,address TEXT NOT NULL,inn TEXT,source TEXT NOT NULL,source_id TEXT NOT NULL,source_url TEXT NOT NULL,license TEXT NOT NULL,checked_at TEXT NOT NULL,search_latin TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS institutions_region_name ON public_institutions(region,short_name,city);
CREATE INDEX IF NOT EXISTS institutions_inn ON public_institutions(inn) WHERE inn IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS institutions_source_id ON public_institutions(source,source_id);
CREATE TABLE IF NOT EXISTS institution_imports(digest TEXT PRIMARY KEY);'''

def valid_inn(value):
    v=str(value or '')
    if not v:return None
    if not v.isascii() or not v.isdigit() or len(v) not in (10,12):raise ValueError('Invalid INN')
    def digit(ws):return sum(int(c)*w for c,w in zip(v,ws))%11%10
    if len(v)==10 and digit([2,4,10,3,5,9,4,6,8])!=int(v[9]):raise ValueError('Invalid INN checksum')
    if len(v)==12 and (digit([7,2,4,10,3,5,9,4,6,8])!=int(v[10]) or digit([3,7,2,4,10,3,5,9,4,6,8])!=int(v[11])):raise ValueError('Invalid INN checksum')
    return v

# Identity is a legal entity + site, never a school number or guessed diary ID.
LEGAL_COLUMNS={'ogrn':'TEXT','kpp':'TEXT','fias_address_guid':'TEXT','school_uuid':'TEXT','region_code':'TEXT','municipality':'TEXT'}
def legal_identity(row,inn,address):
    out={}
    for field,length in [('ogrn',13),('kpp',9),('region_code',2)]:
        value=row.get(field) or None
        if value is not None:
            if not isinstance(value,str) or not re.fullmatch(r'[0-9]{'+str(length)+'}',value):raise ValueError('Invalid '+field)
        out[field]=value
    if out['ogrn'] and int(out['ogrn'][:12])%11%10!=int(out['ogrn'][-1]):raise ValueError('Invalid OGRN checksum')
    fias=row.get('fias_address_guid') or None
    if fias:
        try:fias=str(UUID(fias))
        except (ValueError,TypeError,AttributeError):raise ValueError('Invalid FIAS GUID') from None
    municipality=row.get('municipality','') or ''
    if not isinstance(municipality,str) or len(municipality)>300:raise ValueError('Invalid municipality')
    out['fias_address_guid']=fias;out['municipality']=municipality.strip()
    site=fias or ' '.join(unicodedata.normalize('NFKC',' '.join([row.get('region',''),municipality,row.get('city',''),address])).casefold().replace('ё','е').split())
    # Missing identity remains unresolved, not a fabricated UUID/connection.
    out['school_uuid']=str(uuid5(NAMESPACE_URL,json.dumps(['sferumfocus:school:v1',out['ogrn'],inn,out['kpp'] or '',site],ensure_ascii=False))) if out['ogrn'] and inn and (fias or address.strip()) else None
    return out

def validated(row):
    from app.school_regions import canonical_region,REGIONS
    from urllib.parse import urlsplit
    if not isinstance(row,dict):raise ValueError('Invalid institution')
    out={}
    for k,maximum in [('name',500),('city',300),('region',150),('address',1000),('source',80),('source_id',200),('source_url',1000),('license',300),('checked_at',50)]:
        v=row.get(k,'')
        if not isinstance(v,str) or len(v)>maximum:raise ValueError('Invalid institution field '+k)
        out[k]=v.strip()
    if not all(out[k] for k in ('name','source','source_id','source_url','license','checked_at')):raise ValueError('Missing institution provenance')
    out['region']=canonical_region(out['region'])
    if out['region'] not in REGIONS:raise ValueError('Unknown institution region')
    u=urlsplit(out['source_url'])
    if u.scheme!='https' or not u.hostname or u.username or u.password or u.query or u.fragment:raise ValueError('Unsafe provenance URL')
    from app.school_names import is_masked_school_name
    if is_masked_school_name(out['name']):raise ValueError('Masked institution name')
    out['short_name']=str(row.get('short_name') or out['name'])[:500]
    out['inn']=valid_inn(row.get('inn'))
    out.update(legal_identity({**row,**out},out['inn'],out['address']))
    out['institution_uid']=out['source']+':'+hashlib.sha256(out['source_id'].encode()).hexdigest()[:24]
    out['search_latin']=latin(' '.join(str(out[k] or '') for k in ('name','short_name','city','region','address','inn')))
    # All incoming portal/scid/login/auth fields are deliberately discarded.
    return out

def migrate(db,path=None):
    for s in SCHEMA.split(';'):
        if s.strip():db.execute(s)
    from app.institution_diary_links import SCHEMA as LINKS_SCHEMA
    db.execute(LINKS_SCHEMA)
    columns={r[1] for r in db.execute('PRAGMA table_info(public_institutions)')}
    for name,kind in LEGAL_COLUMNS.items():
        if name not in columns:db.execute('ALTER TABLE public_institutions ADD COLUMN '+name+' '+kind)
    db.execute('CREATE INDEX IF NOT EXISTS institutions_canonical_site ON public_institutions(school_uuid) WHERE school_uuid IS NOT NULL')
    path=Path(path) if path else Path(__file__).parent/'data'/'institutions.json'
    if path.exists():
        if path.stat().st_size>150*1024*1024:raise ValueError('Institution seed too large')
        raw=path.read_bytes();digest=hashlib.sha256(raw).hexdigest()
        if not db.execute('SELECT 1 FROM institution_imports WHERE digest=?',(digest,)).fetchone():
            doc=json.loads(raw)
            if doc.get('schema_version')!=1 or not isinstance(doc.get('institutions'),list) or len(doc['institutions'])>500000:raise ValueError('Unknown institution schema')
            for row in doc['institutions']:upsert(db,validated(row))
            db.execute('INSERT INTO institution_imports VALUES(?)',(digest,))
    ensure_fts(db,'public_institutions','institutions_latin_fts')

def upsert(db,row):
    keys=list(row);mutable=[k for k in keys if k!='institution_uid']
    db.execute('INSERT INTO public_institutions('+','.join(keys)+') VALUES('+','.join('?' for _ in keys)+') ON CONFLICT(institution_uid) DO UPDATE SET '+','.join(k+'=excluded.'+k for k in mutable),list(row.values()))

def search(db,query,region=None,limit=41,offset=0,*,region_code=None,municipality=None,city=None):
    from app.school_regions import canonical_region
    clauses=[];args=[]
    if region:clauses.append('s.region=?');args.append(canonical_region(region))
    for key,value in [('region_code',region_code),('municipality',municipality),('city',city)]:
        if value:clauses.append('s.'+key+'=?');args.append(value)
    rows=find(db,'public_institutions','institutions_latin_fts',query,clauses,args,limit,offset,order='s.short_name,s.city,s.institution_uid',group_by='COALESCE(s.school_uuid,s.institution_uid)')
    from app.school_registry import native_candidates
    for r in rows:
        from app.institution_diary_links import bindings_for
        r.pop('search_latin',None)
        r['diary_bindings']=bindings_for(db,r.get('school_uuid'))
        r['connection_status']='portal_resolved' if r['diary_bindings'] else 'portal_not_resolved'
        r['portal_candidates']=[p['base_url'] for p in native_candidates() if canonical_region(p['region'])==r['region']]
    return rows
