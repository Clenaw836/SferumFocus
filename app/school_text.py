"""Bounded transliterated school search. Numeric school IDs are never authentication IDs."""
import re,unicodedata
from difflib import SequenceMatcher
_CYR=dict(zip('абвгдеёжзийклмнопрстуфхцчшщъыьэюя',
 ['a','b','v','g','d','e','e','zh','z','i','y','k','l','m','n','o','p','r','s','t','u','f','kh','ts','ch','sh','shch','','y','','e','yu','ya']))
def latin(value):
    s=unicodedata.normalize('NFKC',str(value).replace('№',' ')).casefold()
    s=''.join(_CYR.get(c,c) for c in s)
    s=re.sub(r'\b(?:sosh|sou|school|shkola|obshcheobrazovatelnaya)\b','shkola',s)
    return ' '.join(re.findall(r'[a-z0-9]+',s))
def terms(query):return list(dict.fromkeys(latin(query).split()))[:8]
def like(token):return '%'+token.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%'
def number_matches(token,text):
    return any(t==token for t in re.findall(r'\d+',text))
def score(tokens,text):
    words=text.split();scores=[]
    for token in tokens:
        if token.isdigit():
            if not number_matches(token,text):return 0
            scores.append(1);continue
        if token in text:scores.append(1);continue
        # Typos are bounded and never applied to school numbers.
        best=max((SequenceMatcher(None,token,w).ratio() for w in words if abs(len(w)-len(token))<=2),default=0)
        if len(token)<5 or best<0.78:return 0
        scores.append(best)
    return sum(scores)/len(scores) if scores else 1

def migrate(db):
    if 'search_latin' not in {r[1] for r in db.execute('PRAGMA table_info(schools_directory)')}:
        db.execute("ALTER TABLE schools_directory ADD COLUMN search_latin TEXT NOT NULL DEFAULT ''")
    for row in db.execute("SELECT school_uid,search_blob FROM schools_directory WHERE search_latin=''").fetchall():
        db.execute('UPDATE schools_directory SET search_latin=? WHERE school_uid=?',(latin(row[1]),row[0]))
    ensure_fts(db,'schools_directory','schools_latin_fts')

def ensure_fts(db,table,index):
    import sqlite3
    if db.execute('SELECT 1 FROM sqlite_master WHERE name=?',(index,)).fetchone():return
    try:db.execute(f"CREATE VIRTUAL TABLE {index} USING fts5(search_latin,content='{table}',content_rowid='rowid',tokenize='trigram')")
    except sqlite3.OperationalError as e:
        if 'no such module' in str(e) or 'no such tokenizer' in str(e):return
        raise
    db.execute(f'CREATE TRIGGER {index}_ai AFTER INSERT ON {table} BEGIN INSERT INTO {index}(rowid,search_latin) VALUES(new.rowid,new.search_latin); END')
    db.execute(f"CREATE TRIGGER {index}_ad AFTER DELETE ON {table} BEGIN INSERT INTO {index}({index},rowid,search_latin) VALUES('delete',old.rowid,old.search_latin); END")
    db.execute(f"CREATE TRIGGER {index}_au AFTER UPDATE OF search_latin ON {table} BEGIN INSERT INTO {index}({index},rowid,search_latin) VALUES('delete',old.rowid,old.search_latin); INSERT INTO {index}(rowid,search_latin) VALUES(new.rowid,new.search_latin); END")
    db.execute(f"INSERT INTO {index}({index}) VALUES('rebuild')")

def find(db,table,index,query,clauses,args,limit,offset,select='s.*',join='',order='s.short_name,s.city,s.school_uid',group_by=None):
    """Exact substring/translit via trigram; bounded typo fallback only if no exact hits.

    Table/select/filter fragments are internal constants, never request values.
    """
    ts=terms(query)
    if any(c in query for c in '%_=;') or query.strip() and not ts:return []
    where=list(clauses);values=list(args);fts=''
    for t in ts:where.append("s.search_latin LIKE ? ESCAPE '\\'");values.append(like(t))
    indexed=[t for t in ts if len(t)>=3]
    if indexed and db.execute('SELECT 1 FROM sqlite_master WHERE name=?',(index,)).fetchone():
        fts=f' JOIN {index} ON {index}.rowid=s.rowid';where.append(f'{index} MATCH ?');values.append(' AND '.join('"'+t+'"' for t in indexed))
    base=f'SELECT {select} FROM {table} s '+join
    grouping=(' GROUP BY '+group_by) if group_by else ''
    # Number boundary is checked before pagination, so 121 cannot become 1210.
    numeric=[t for t in ts if t.isdigit()]
    db.create_function('school_numbers_match',1,lambda text:int(all(number_matches(t,text or '') for t in numeric)))
    if numeric:where.append("school_numbers_match(s.name || ' ' || s.short_name)=1")
    rows=[dict(r) for r in db.execute(base+fts+' WHERE '+(' AND '.join(where) or '1')+grouping+' ORDER BY '+order+' LIMIT ? OFFSET ?',[*values,limit,offset])]
    if rows or not ts:return rows
    # Exact hits on earlier pages must not be replaced by fuzzy results on the last page.
    if offset:return []
    c=list(clauses);a=list(args)
    for t in numeric:c.append("s.search_latin LIKE ?");a.append(like(t))
    if numeric:c.append("school_numbers_match(s.name || ' ' || s.short_name)=1")
    long=[t for t in ts if len(t)>=5]
    if not long:return []
    # Require a matching anchor per textual token; candidate scan is capped at 600.
    for t in long:
        c.append('(s.search_latin LIKE ? OR s.search_latin LIKE ?)');a.extend([like(t[:3]),like(t[-3:])])
    candidates=[dict(r) for r in db.execute(base+' WHERE '+(' AND '.join(c) or '1')+' ORDER BY '+order+' LIMIT 600',a)]
    ranked=[(score(ts,r.get('search_latin','')),r) for r in candidates]
    ranked=[(s,r) for s,r in ranked if s]
    ranked.sort(key=lambda x:(-x[0],x[1].get('short_name',''),x[1].get('school_uid',x[1].get('institution_uid',''))))
    if group_by:
        seen=set();unique=[]
        for item in ranked:
            r=item[1];key=r.get('school_uuid') or r.get('institution_uid')
            if key not in seen:seen.add(key);unique.append(item)
        ranked=unique
    return [{**r,'search_match':'fuzzy'} for _,r in ranked[:limit]]
