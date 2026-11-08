"""Never guess hidden school names from school number, INN or host substrings.
Only a previously obtained unmasked name for the exact registry host + scid may
replace a newly masked label. Unknown labels are not selectable fake schools.
"""
import re,unicodedata
class UnresolvedSchoolName(ValueError):pass

def is_masked_school_name(name):
    text=' '.join(re.findall(r'\w+',unicodedata.normalize('NFKC',str(name or '')).casefold().replace('ё','е')))
    return not text or any(p in text for p in ('скрытое оу','скрытая оо','скрытая организация','обезличенное оу','hidden school'))

def checked_names(repo,host_id,scid,name,short):
    if not is_masked_school_name(name):return name, name if is_masked_school_name(short) else short
    with repo.tx() as db:old=db.execute('SELECT name,short_name FROM schools_directory WHERE host_id=? AND scid=?',(host_id,scid)).fetchone()
    if old and not is_masked_school_name(old['name']):return old['name'],old['name'] if is_masked_school_name(old['short_name']) else old['short_name']
    raise UnresolvedSchoolName('Портал скрыл название; подтверждённое соответствие школы отсутствует')
