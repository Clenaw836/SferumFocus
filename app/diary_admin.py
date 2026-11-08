"""Operator-only import of an already authorized, expiring provider grant.

Not a login flow; stdin avoids secrets in argv/history. Never use stolen cookies.
Requires an approved normalized gateway profile; no arbitrary-host network access.
"""
import argparse
import json
import sys
import time
from app import config
from app.platform_auth import store
from app.diary_vault import EncryptedDiaryVault
from app.diary_providers import approved_profile

def main():
    parser=argparse.ArgumentParser(description='Bind an authorized provider grant from private stdin JSON')
    parser.add_argument('--uid',required=True);parser.add_argument('--portal',required=True)
    args=parser.parse_args();repo=store();profile=approved_profile(args.portal)
    with repo.tx() as db:
        if not db.execute('SELECT 1 FROM accounts WHERE uid=?',(args.uid,)).fetchone():raise SystemExit('Unknown uid')
    try:
        raw=sys.stdin.read(65537)
        if len(raw)>65536:raise ValueError()
        data=json.loads(raw)
        if set(data)-{'access_token','cookies','student_id','expires_at'}:raise ValueError()
        expiry=float(data.pop('expires_at'))
        if not time.time()<expiry<=time.time()+30*86400:raise ValueError()
        if not isinstance(data['access_token'],str) or not 1<=len(data['access_token'])<=4096:raise ValueError()
        if not isinstance(data.get('cookies',{}),dict):raise ValueError()
        EncryptedDiaryVault(repo).bind(args.uid,'netschool',portal=profile['origin'],session=data,expires=expiry)
    except (ValueError,KeyError,TypeError):raise SystemExit('Invalid grant/configuration; no secret values printed')
    print('Bound authorized connection; initial poll creates a silent baseline.')
if __name__=='__main__':main()
