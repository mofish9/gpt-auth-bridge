import json
import os
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def main():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='model-evaluation-test-') as runtime:
        env = {**os.environ, 'SKIP_DOTENV': '1', 'NODE_ENV': 'development', 'CONTAINER': 'false',
               'HOST': '127.0.0.1', 'PORT': str(port), 'RUNTIME_DIR': runtime, 'TASK_CONCURRENCY': '2'}
        child = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
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
                raise RuntimeError('startup timed out')
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                page = browser.new_page()
                errors, requests = [], []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.route('**/api/session-health', lambda route: route.fulfill(json={'results': [{'status': 200}, {'status': 200}]}))

                def evaluate(route):
                    body = route.request.post_data_json
                    requests.append(body)
                    if body['account']['email'] == 'second@example.com' and body['question'] == 'candy':
                        route.fulfill(status=502, json={'ok': False, 'error': '模拟账号失败'})
                    else:
                        html = '<html><svg><text x="20" y="30">Pelican</text></svg></html>'
                        route.fulfill(json={'ok': True, 'model': body['model'], 'question': body['question'],
                                            'status': 'passed' if body['question'] == 'candy' else 'manual_review',
                                            'output': '答案：21' if body['question'] == 'candy' else html,
                                            'html': html, 'durationMs': 100})

                page.route('**/api/model-evaluation', evaluate)
                page.goto(url)
                page.wait_for_load_state('networkidle')
                panel = page.locator('#model-evaluation')
                start = panel.locator('[data-evaluation-start]')
                expect(start).to_be_disabled()
                expect(page.locator('#evaluation-model')).to_have_value('gpt-6-astra')
                accounts = [{'accessToken': 'fixture-token', 'user': {'email': email}} for email in ['first@example.com', 'second@example.com']]
                page.locator('#session-input').fill(json.dumps(accounts))
                expect(start).to_be_enabled()
                start.click()
                expect(panel.locator('[role=status]')).to_contain_text('测试完成：4/4')
                assert len(requests) == 4
                assert all(body['model'] == 'gpt-6-astra' for body in requests)
                expect(panel.locator('[role=status]')).to_contain_text('失败 1')
                panel.locator('details').nth(1).locator('summary').click()
                panel.get_by_role('button', name='预览鹈鹕动画').first.click()
                expect(panel.locator('iframe')).to_have_attribute('sandbox', '')
                assert "default-src 'none'" in panel.locator('iframe').get_attribute('srcdoc')
                expect(page.frame_locator('#model-evaluation iframe').locator('svg text')).to_have_text('Pelican')
                page.locator('#evaluation-model').fill('custom-model')
                start.click()
                expect(panel.locator('[role=status]')).to_contain_text('测试完成：4/4')
                assert all(body['model'] == 'custom-model' for body in requests[4:])
                # Keep the request pending so stopping exercises cancellation and queued cases.
                page.unroute('**/api/model-evaluation')
                pending = []
                page.route('**/api/model-evaluation', lambda route: pending.append(route))
                start.click()
                expect(panel.locator('[data-evaluation-stop]')).to_be_enabled()
                panel.locator('[data-evaluation-stop]').click()
                expect(panel.locator('[role=status]')).to_contain_text('已停止')
                expect(start).to_be_enabled()
                expect(panel.locator('summary').filter(has_text='已停止')).to_have_count(4)
                for route in pending:
                    route.abort()
                page.locator('#clear-input').click()
                expect(start).to_be_disabled()
                expect(panel.locator('details')).to_have_count(0)
                page.locator('.top-nav [data-format="sub2api-tools"]').click()
                expect(panel).to_be_hidden()
                assert not errors, errors
                browser.close()
                print('PASS: default/custom model, batch isolation, rendered sandbox preview, cancellation, clear and tab visibility')
        finally:
            child.terminate()
            child.wait(timeout=15)


if __name__ == '__main__':
    main()
