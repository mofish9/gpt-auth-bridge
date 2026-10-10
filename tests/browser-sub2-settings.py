"""Sub2API settings regression with synthetic OAuth and local remote fixtures."""
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright
from browser_push_smoke import exercise_push

ROOT = Path(__file__).resolve().parents[1]


def token(account_id, plan):
    payload = {'client_id': 'app_EMoamEEZ73f0CkXaXp7hrann', 'exp': 2100000000,
               'https://api.openai.com/auth': {'chatgpt_account_id': account_id, 'chatgpt_plan_type': plan}}
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')
    return 'e30.' + encoded + '.fixture'


def main():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='browser-sub2-settings-') as runtime:
        env = {**os.environ, 'SKIP_DOTENV': '1', 'NODE_ENV': 'development', 'CONTAINER': 'false',
               'HOST': '127.0.0.1', 'PORT': str(port), 'RUNTIME_DIR': runtime, 'TASK_CONCURRENCY': '10',
               'OPENAI_PROXY_URL': '', 'SUB2API_BASE_URL': '', 'SUB2API_ADMIN_API_KEY': ''}
        child = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            for _ in range(300):
                if child.poll() is not None:
                    raise RuntimeError(child.stderr.read().decode())
                try:
                    with urlopen(url + '/api/ready', timeout=0.5) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError('service startup timed out')
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                context = browser.new_context(accept_downloads=True)
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                login_plans = {'personal': 'plus', 'business': 'business'}

                def oauth(route):
                    snapshot = route.request.post_data_json['browserState']
                    account = snapshot['accounts'][0]
                    workspaces = [{'workspaceId': name, 'accountId': name,
                                   'refreshToken': f'fixture-{name}-rt', 'accessToken': token(name, plan)}
                                  for name, plan in login_plans.items() if name != 'personal']
                    account.update({'openai_rt': 'fixture-personal-rt',
                                    'openai_access_token': token('personal', login_plans['personal']),
                                    'openai_account_id': 'personal', 'business_workspace_credentials': workspaces})
                    result = {'id': account['id'], 'email': account['email'], 'ok': True,
                              'personalOk': True, 'businessSuccess': len(workspaces)}
                    events = [('account_start', {'id': account['id']}), ('browser_state', snapshot),
                              ('account_done', result), ('summary', {'ok': True, 'success': 1, 'failed': 0, 'results': [result]})]
                    route.fulfill(status=200, content_type='text/event-stream',
                                  body=''.join(f'event: {name}\ndata: {json.dumps(data)}\n\n' for name, data in events))

                page.route('**/api/v2/accounts/protocol-login-pipeline', oauth)
                page.goto(url)
                page.locator('.top-nav [data-format="protocol-login"]').click()
                page.get_by_role('radio', name='自定义代理池', exact=True).check()
                page.locator('#login-proxy-pool').fill('custom.example:3000:fixture:password')
                page.get_by_role('radio', name='直连', exact=True).check()
                page.locator('#login-accounts').fill('fixture@example.com----FixturePassword!----JBSWY3DPEHPK3PXP')
                page.locator('#start-protocol-login').click()
                expect(page.locator('#export-login-personal')).to_be_enabled()
                exercise_push(page, login_plans)
                assert not errors, errors
                context.close()
                browser.close()
            assert list(Path(runtime).iterdir()) == []
            print('Sub2API settings: bidirectional edits, save/reload, legacy conflicts, JSON and push parameters, clear/reset: PASS')
        finally:
            child.terminate()
            child.wait(timeout=10)


if __name__ == '__main__':
    main()
