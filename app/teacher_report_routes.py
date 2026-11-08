import base64
from datetime import date
from fastapi import APIRouter, HTTPException, Query, Request, Response
from app import demo_sandbox
from app import teacher_reports as reports
from app.teacher_journal import teacher_owner

router = APIRouter(tags=['teacher-reports'])


def report_source(request, response):
    response.headers['Cache-Control'] = 'no-store'
    sandbox = demo_sandbox.state_of(request)
    if sandbox:
        if sandbox['role'] != 'teacher':
            raise HTTPException(403, 'Табель доступен учителю')
        return reports.demo_rows(), True
    uid, repo = teacher_owner(request, response)
    try:
        return reports.owned_rows(repo, uid), False
    except ValueError as exc:
        raise HTTPException(413, str(exc)) from None


@router.get('/api/v1/teacher/reports/context')
def report_context(request: Request, response: Response):
    rows, demo = report_source(request, response)
    return reports.context(rows, demo)


@router.get('/api/v1/teacher/reports')
def report_view(request: Request, response: Response,
        class_name: str = Query(default='', max_length=20), subject: str = Query(default='', max_length=80),
        student_id: str = Query(default='', max_length=120), date_from: date | None = None, date_to: date | None = None,
        status: str = Query(default='all', pattern='^(all|draft|synced_sgo|review)$'), search: str = Query(default='', max_length=120),
        export: str = Query(default='', pattern='^(|csv|tsv|xlsx|json|html)$'), layout: str = Query(default='summary', pattern='^(summary|details)$')):
    rows, demo = report_source(request, response)
    try:
        report = reports.build_report(rows, class_name=class_name, subject=subject, student_id=student_id,
            date_from=date_from.isoformat() if date_from else None, date_to=date_to.isoformat() if date_to else None,
            status=status, search=search, demo=demo)
        if not export:
            return report
        name, media_type, content = reports.export_report(report, export, layout)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return dict(filename=name, media_type=media_type, content_base64=base64.b64encode(content).decode())
