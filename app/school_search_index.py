"""Optional SQLite trigram accelerator; original LIKE remains authoritative."""
import sqlite3

def migrate(db):
    db.execute('CREATE INDEX IF NOT EXISTS schools_region_name ON schools_directory(region,short_name,city)')
    existing=db.execute("SELECT 1 FROM sqlite_master WHERE name='schools_search_fts'").fetchone()
    if existing:return
    try:
        db.execute("CREATE VIRTUAL TABLE schools_search_fts USING fts5(search_blob,content='schools_directory',content_rowid='rowid',tokenize='trigram')")
    except sqlite3.OperationalError as exc:
        if 'no such module' in str(exc) or 'no such tokenizer' in str(exc):return
        raise
    db.execute("CREATE TRIGGER schools_fts_insert AFTER INSERT ON schools_directory BEGIN INSERT INTO schools_search_fts(rowid,search_blob) VALUES(new.rowid,new.search_blob); END")
    db.execute("CREATE TRIGGER schools_fts_delete AFTER DELETE ON schools_directory BEGIN INSERT INTO schools_search_fts(schools_search_fts,rowid,search_blob) VALUES('delete',old.rowid,old.search_blob); END")
    db.execute("CREATE TRIGGER schools_fts_update AFTER UPDATE OF search_blob ON schools_directory BEGIN INSERT INTO schools_search_fts(schools_search_fts,rowid,search_blob) VALUES('delete',old.rowid,old.search_blob); INSERT INTO schools_search_fts(rowid,search_blob) VALUES(new.rowid,new.search_blob); END")
    db.execute("INSERT INTO schools_search_fts(schools_search_fts) VALUES('rebuild')")
