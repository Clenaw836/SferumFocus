from __future__ import annotations

import csv
from datetime import date, timedelta
from html import escape
from io import BytesIO, StringIO
import json
import re
from xml.sax.saxutils import escape as xml_escape
from zipfile import ZipFile, ZIP_DEFLATED

STATUSES = {'all', 'draft', 'synced_sgo', 'review'}
HEADERS = ['Ученик', 'Класс', 'Предмет', 'Оценки', 'Средний балл', 'Количество', 'Черновики', 'Нужна сверка']
DETAIL_HEADERS = ['Ученик', 'Класс', 'Предмет', 'Дата', 'Оценка', 'Тип работы', 'Комментарий', 'Статус']


def owned_rows(repo, uid):
    with repo.tx() as db:
        rows = db.execute('SELECT id,student_id,student_name,class_name,subject,grade,assignment_type,comment,lesson_date,sync_status,sync_reason FROM teacher_grades_journal WHERE teacher_uid=? ORDER BY id LIMIT 10001', (uid,)).fetchall()
    if len(rows) > 10000:
        raise ValueError('В журнале больше 10 000 записей. Для такого объёма требуется серверная выборка по периоду.')
    return [dict(row) for row in rows]


def demo_rows(today=None):
    today = today or date.today()
    first = today.replace(day=1)
    people = [('s1', 'Котова Алина'), ('s2', 'Лебедев Глеб'), ('s3', 'Миронова Ника')]
    rows = []
    for person, (sid, name) in enumerate(people):
        for subject, shift in [('Алгебра', 0), ('Геометрия', 1)]:
            for number in range(4):
                day = min(today, first + timedelta(days=number * 2))
                rows.append(dict(id=len(rows)+1, student_id=sid, student_name=name, class_name='8А', subject=subject,
                    grade=(3, 4, 5, 4)[(number+person+shift) % 4], assignment_type=('Ответ на уроке', 'Домашнее задание', 'Самостоятельная работа', 'Контрольная')[number],
                    comment='', lesson_date=day.isoformat(), sync_status='draft', sync_reason='local_only'))
    return rows


def needs_review(row):
    return row.get('sync_reason') in {'pending', 'delivery_unknown'}


def status_label(row):
    if needs_review(row):
        return 'Нужна сверка с СГО'
    return 'Подтверждено СГО' if row['sync_status'] == 'synced_sgo' else 'Локальный черновик'


def context(rows, demo=False):
    people = {}
    for row in rows:
        people[(row['class_name'], row['student_id'])] = dict(student_id=row['student_id'], student_name=row['student_name'], class_name=row['class_name'])
    return dict(demo=demo, today=date.today().isoformat(), classes=sorted({r['class_name'] for r in rows}),
        subjects=sorted({r['subject'] for r in rows}), students=sorted(people.values(), key=lambda r: (r['class_name'], r['student_name'].casefold(), r['student_id'])))


def build_report(rows, *, class_name='', subject='', student_id='', date_from=None, date_to=None, status='all', search='', demo=False):
    if status not in STATUSES:
        raise ValueError('Неизвестный статус')
    start = date.fromisoformat(date_from) if date_from else None
    end = date.fromisoformat(date_to) if date_to else None
    if start and end and start > end:
        raise ValueError('Начало периода позже окончания')
    selected = []
    for row in rows:
        if type(row['grade']) is not int or row['grade'] not in (2, 3, 4, 5):
            raise ValueError('В журнале найдена некорректная оценка')
        day = date.fromisoformat(row['lesson_date'])
        if class_name and row['class_name'] != class_name: continue
        if subject and row['subject'] != subject: continue
        if student_id and row['student_id'] != student_id: continue
        if start and day < start or end and day > end: continue
        if search.strip().casefold() not in row['student_name'].casefold(): continue
        if status == 'review' and not needs_review(row): continue
        if status in {'draft', 'synced_sgo'} and row['sync_status'] != status: continue
        selected.append({k: row[k] for k in ('id', 'student_id', 'student_name', 'class_name', 'subject', 'grade', 'assignment_type', 'comment', 'lesson_date', 'sync_status', 'sync_reason')})
    selected.sort(key=lambda r: (r['student_name'].casefold(), r['class_name'], r['student_id'], r['subject'], r['lesson_date'], r['id']))
    groups = {}
    for row in selected:
        key = (row['class_name'], row['student_id'], row['subject'])
        item = groups.setdefault(key, dict(student_id=row['student_id'], student_name=row['student_name'], class_name=row['class_name'], subject=row['subject'], marks=[], count=0, drafts=0, review=0))
        item['marks'].append(row['grade']); item['count'] += 1
        item['drafts'] += row['sync_status'] == 'draft'
        item['review'] += needs_review(row)
    summary = []
    for item in groups.values():
        item['average'] = round(sum(item['marks']) / item['count'], 2)
        summary.append(item)
    return dict(demo=demo, filters=dict(class_name=class_name, subject=subject, student_id=student_id, date_from=date_from, date_to=date_to, status=status, search=search),
        students=len({(r['class_name'], r['student_id']) for r in selected}), count=len(selected),
        drafts=sum(r['sync_status']=='draft' for r in selected), review=sum(needs_review(r) for r in selected), summary=summary, records=selected,
        notice='Справочный табель по записям приложения. Средний балл не является итоговой оценкой. Пустые записи не означают двойку.')


def table(report, layout):
    if layout == 'summary':
        return HEADERS, [[r['student_name'], r['class_name'], r['subject'], ' '.join(map(str, r['marks'])), r['average'], r['count'], r['drafts'], r['review']] for r in report['summary']]
    if layout == 'details':
        return DETAIL_HEADERS, [[r['student_name'], r['class_name'], r['subject'], r['lesson_date'], r['grade'], r['assignment_type'], r['comment'], status_label(r)] for r in report['records']]
    raise ValueError('Неизвестный вид табеля')


def safe_text(value):
    if isinstance(value, (int, float)):
        return value
    text = str(value)
    return "'" + text if text.lstrip(' \t\r\n\ufeff').startswith(('=', '+', '-', '@')) else text


def _xlsx(headers, rows):
    output = BytesIO()
    def cell(column, row, value, style=0):
        letters = ''
        while column:
            column, rem = divmod(column-1, 26); letters = chr(65+rem)+letters
        ref = f'{letters}{row}'
        if type(value) in (int, float):return f'<c r="{ref}" s="{style}" t="n"><v>{value}</v></c>'
        clean = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', str(value))
        return f'<c r="{ref}" s="{style}" t="inlineStr"><is><t xml:space="preserve">{xml_escape(clean)}</t></is></c>'
    content = ''.join('<row r="'+str(i)+'">'+''.join(cell(j, i, value, 1 if i==1 else 0) for j,value in enumerate(row,1))+'</row>' for i,row in enumerate([headers]+rows,1))
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    with ZipFile(output,'w',ZIP_DEFLATED) as archive:
        files = {
            '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
            '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
            'xl/workbook.xml':f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Табель" sheetId="1" r:id="rId1"/></sheets></workbook>',
            'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
            'xl/styles.xml':f'<styleSheet xmlns="{ns}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF17485D"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0" fillId="0" borderId="0" xfId="0"><alignment vertical="top" wrapText="1"/></xf><xf fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
            'xl/worksheets/sheet1.xml':f'<worksheet xmlns="{ns}"><dimension ref="A1:H{len(rows)+1}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="28" customWidth="1"/><col min="2" max="2" width="12" customWidth="1"/><col min="3" max="8" width="23" customWidth="1"/></cols><sheetData>{content}</sheetData><autoFilter ref="A1:H{len(rows)+1}"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup orientation="landscape" paperSize="9"/></worksheet>'
        }
        for name, value in files.items(): archive.writestr(name, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+value)
    return output.getvalue()


def export_report(report, format='xlsx', layout='summary'):
    headers, rows = table(report, layout)
    filename = 'tabel-demo' if report['demo'] else 'tabel'
    if format in {'csv', 'tsv'}:
        stream=StringIO(newline='');writer=csv.writer(stream,delimiter=';' if format=='csv' else '\t')
        writer.writerow(headers)
        writer.writerows([[safe_text(v) for v in row] for row in rows])
        return (filename+'.'+format, 'text/csv;charset=utf-8' if format=='csv' else 'text/tab-separated-values;charset=utf-8', ('\ufeff'+stream.getvalue()).encode())
    if format == 'xlsx':return filename+'.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',_xlsx(headers,rows)
    if format == 'json':
        selected = {key: report[key] for key in ('demo', 'filters', 'students', 'count', 'notice')}
        selected['layout'] = layout
        selected['summary' if layout == 'summary' else 'records'] = report['summary' if layout == 'summary' else 'records']
        return filename+'.json','application/json;charset=utf-8',json.dumps(selected,ensure_ascii=False,indent=2).encode()
    if format == 'html':
        cells = lambda tag, values: ''.join(f'<{tag}>'+escape(str(v))+f'</{tag}>' for v in values)
        period = ' — '.join(x or 'без ограничения' for x in (report['filters']['date_from'],report['filters']['date_to']))
        html='<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Табель оценок</title><style>body{font:14px/1.5 system-ui,sans-serif;color:#202e36;max-width:1200px;margin:40px auto;padding:0 24px}h1{font-size:28px;margin-bottom:4px}p{color:#52636d}table{border-collapse:collapse;width:100%;margin-top:24px}th,td{text-align:left;padding:10px;border-bottom:1px solid #d7e0e5;vertical-align:top;overflow-wrap:anywhere}th{background:#edf4f6}thead{display:table-header-group}tr{break-inside:avoid}@page{size:A4 landscape;margin:12mm}@media print{body{margin:0;padding:0;font-size:10pt}h1{font-size:20pt}}</style><h1>Табель оценок'+(' · DEMO' if report['demo'] else '')+'</h1><p>'+escape(period)+'</p><p>'+escape(report['notice'])+'</p><table><thead><tr>'+cells('th',headers)+'</tr></thead><tbody>'+''.join('<tr>'+cells('td',row)+'</tr>' for row in rows)+'</tbody></table></html>'
        return filename+'.html','text/html;charset=utf-8',html.encode()
    raise ValueError('Формат не поддерживается')
