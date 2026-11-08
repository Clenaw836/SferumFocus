"""Explicit, source-attributed administrator mappings. Public imports cannot authorize them."""
from datetime import datetime,timezone
from urllib.parse import urlsplit
from uuid import UUID

SCHEMA='''CREATE TABLE IF NOT EXISTS institution_diary_links(
 school_uuid TEXT NOT NULL,school_uid TEXT NOT NULL REFERENCES schools_directory(school_uid) ON DELETE CASCADE,
 source_url TEXT NOT NULL,verified_at TEXT NOT NULL,PRIMARY KEY(school_uuid,school_uid));'''

def replace_bindings(repo,links):
    if not isinstance(links,list) or len(links)>50000:raise ValueError('Invalid institution bindings')
    checked=[];seen=set()
    with repo.tx() as db:
        for row in links:
            if not isinstance(row,dict) or set(row)!={'school_uuid','school_uid','source_url','verified_at'}:raise ValueError('Invalid institution binding fields')
            try:
                school_uuid=str(UUID(row['school_uuid']));uid=row['school_uid']
                source=row['source_url'];url=urlsplit(source)
                verified=datetime.fromisoformat(row['verified_at'].replace('Z','+00:00'))
                if (not isinstance(uid,str) or len(uid)>200 or url.scheme!='https' or not url.hostname or url.username or url.password or url.query or url.fragment or len(source)>1000 or verified.tzinfo is None or verified.timestamp()>datetime.now(timezone.utc).timestamp()+5):raise ValueError()
            except (ValueError,TypeError,AttributeError):raise ValueError('Invalid institution binding provenance') from None
            institution=db.execute('SELECT region FROM public_institutions WHERE school_uuid=? LIMIT 1',(school_uuid,)).fetchone()
            school=db.execute('SELECT s.region FROM schools_directory s JOIN sgo_hosts_registry h ON h.host_id=s.host_id WHERE s.school_uid=? AND h.is_active=1',(uid,)).fetchone()
            if not institution or not school or institution[0]!=school[0]:raise ValueError('Binding requires an existing institution and active diary school in the same region')
            if (school_uuid,uid) in seen:raise ValueError('Duplicate institution binding')
            seen.add((school_uuid,uid));checked.append((school_uuid,uid,source,verified.isoformat()))
        # All entries validated before replacing. Failure rolls back, preserving old links.
        db.execute('DELETE FROM institution_diary_links')
        db.executemany('INSERT INTO institution_diary_links VALUES(?,?,?,?)',checked)

def bindings_for(db,school_uuid):
    if not school_uuid or not db.execute('SELECT 1 FROM institution_diary_links WHERE school_uuid=? LIMIT 1',(school_uuid,)).fetchone():return []
    import json
    rows=db.execute('''SELECT s.*,h.last_status AS host_status,l.source_url AS mapping_source,l.verified_at AS mapping_verified
        FROM institution_diary_links l JOIN schools_directory s ON s.school_uid=l.school_uid
        JOIN sgo_hosts_registry h ON h.host_id=s.host_id
        WHERE l.school_uuid=? AND h.is_active=1 ORDER BY s.school_uid''',(school_uuid,))
    public=('school_uid','scid','host_id','name','short_name','city','region','base_url','host_status')
    result=[]
    for row in rows:
        school={k:row[k] for k in public};school['supported_auth_methods']=json.loads(row['supported_auth_methods'])
        result.append({'school':school,'source_url':row['mapping_source'],'verified_at':row['mapping_verified']})
    return result
