"""Small smoke check against the actual running demo API; never sends real grades."""
import json
import sys
from uuid import uuid4
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8000"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(path, method="GET", body=None, token=None, expected=200):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Demo-Session"] = token
    request = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    try:
        with OPENER.open(request, timeout=20) as response:
            status, data = response.status, response.read()
    except urllib.error.HTTPError as exc:
        status, data = exc.code, exc.read()
    if status != expected:
        raise RuntimeError(f"{method} {path}: expected {expected}, got {status}; check container logs locally")
    return json.loads(data)


def main():
    token = None
    try:
        if call("/health").get("status") != "ok":
            raise RuntimeError("Unexpected health response")
        call("/ready")
        created = call("/api/v1/demo/session", "POST", {"persona": "teacher"})
        token = created["token"]
        if created["sandbox"] is not True or created["persona"]["id"] != "teacher":
            raise RuntimeError("Expected synthetic teacher session")
        who = call("/api/v1/webapp/whoami", token=token)
        if who.get("auth") != "demo" or who.get("role") != "teacher":
            raise RuntimeError("Expected sandbox teacher identity")
        context = call("/api/v1/teacher/reports/context", token=token)
        if context.get("demo") is not True:
            raise RuntimeError("Expected synthetic report context")
        report = call("/api/v1/teacher/reports", token=token)
        if report.get("count", 0) < 1:
            raise RuntimeError("Expected demonstration grades")
        for fmt in ("xlsx", "csv", "tsv", "json", "html"):
            exported = call("/api/v1/teacher/reports?export=" + fmt, token=token)
            if not exported.get("content_base64"):
                raise RuntimeError("Empty report export: " + fmt)
        call('/api/v1/teacher/tools',token=token)
        ids=[]
        payloads={
            'rubrics':{'criteria':[{'title':'Решение','points':10}],'thresholds':[50,70,90]},
            'feedback':{'body':'Проверьте знак во второй строке.'},
            'plans':{'goal':'Решить уравнение','duration':45,'blocks':[{'title':'Практика','minutes':30}]},
        }
        for kind,data in payloads.items():
            item_id=str(uuid4());ids.append((kind,item_id))
            saved=call('/api/v1/teacher/tools/'+kind,'POST',{'id':item_id,'title':'Проверка','data':data,'expected_revision':0},token)
            if saved['revision']!=1:raise RuntimeError('Unexpected tool revision')
            saved=call('/api/v1/teacher/tools/'+kind,'POST',{'id':item_id,'title':'Проверка 2','data':data,'expected_revision':1},token)
            if saved['revision']!=2:raise RuntimeError('Tool update did not advance revision')
        assessment=call('/api/v1/teacher/tools/assess','POST',{'rubric':payloads['rubrics'],'scores':[9]},token)
        if assessment['suggested_mark']!=5:raise RuntimeError('Unexpected rubric recommendation')
        listed=call('/api/v1/teacher/tools',token=token)
        if not all(any(item['id']==item_id and item['kind']==kind for item in listed['items']) for kind,item_id in ids):raise RuntimeError('Tool templates not persisted')
        for kind,item_id in ids:
            call('/api/v1/teacher/tools/'+kind+'/'+item_id+'?revision=2','DELETE',token=token)
        switched = call("/api/v1/demo/persona", "POST", {"persona": "s1"}, token)
        token = switched["token"]
        who = call("/api/v1/webapp/whoami", token=token)
        if who.get("role") != "student":
            raise RuntimeError("Expected sandbox student identity")
        call("/api/v1/teacher/reports/context", token=token, expected=403)
        call('/api/v1/teacher/tools',token=token,expected=403)
        call('/api/v1/teacher/tools/feedback','POST',{'id':str(uuid4()),'title':'Недоступно','data':{'body':'Комментарий'},'expected_revision':0},token,expected=403)
        # A synthetic session must never be granted a real diary account.
        call("/api/v1/diary/status", token=token, expected=403)
        switched = call("/api/v1/demo/persona", "POST", {"persona": "teacher"}, token)
        token = switched["token"]
        if call("/api/v1/webapp/whoami", token=token).get("role") != "teacher":
            raise RuntimeError("Could not return to teacher")
        if call("/api/v1/demo/session", "DELETE", token=token).get("ended") is not True:
            raise RuntimeError("Could not end sandbox")
        call("/api/v1/demo/session", token=token, expected=401)
        token = None
        print("PASS: health/readiness, teacher tools CRUD, rubric assessment, teacher/student/teacher, student tools refusal, real diary refusal, sandbox invalidation")
    finally:
        if token:
            call("/api/v1/demo/session", "DELETE", token=token)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        sys.exit(1)
