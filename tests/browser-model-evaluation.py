import json
import os
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
PARTIAL = '<html><body><svg width="1024" height="768" viewBox="0 0 1024 768"><rect width="1024" height="768" fill="#edf5f8"/><text x="72" y="100" font-size="30" fill="#24505a">Pelican in motion</text><g stroke="#24505a" stroke-width="8" fill="none"><circle cx="320" cy="540" r="100"/><circle cx="700" cy="540" r="100"/><path d="M320 540 440 340 550 540H320m120-200 260 200-80-260h-70"/></g>'
TAIL = '<g fill="white" stroke="#24505a" stroke-width="6"><ellipse cx="470" cy="285" rx="90" ry="55"/><path d="M500 260q20-160 100-130q50 35-10 90l-40 90"/></g><path d="m600 165 150 35-160 25" fill="#eab865" stroke="#9f722d" stroke-width="4"/><circle cx="595" cy="154" r="7" fill="#142126"/><path d="m465 330 35 90 60 50" stroke="#eab865" stroke-width="14" fill="none"><animateTransform attributeName="transform" type="rotate" values="-8 465 330;8 465 330;-8 465 330" dur="1s" repeatCount="indefinite"/></path></svg></body></html>'
HTML = PARTIAL + TAIL


def main():
    release = threading.Event()
    upstream_requests = []

    class Upstream(BaseHTTPRequestHandler):
        def handle(self):
            try:
                super().handle()
            except (ConnectionResetError, ConnectionAbortedError):
                pass

        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            upstream_requests.append((self.path, self.headers.get('Authorization'), body))
            chat = 'messages' in body
            prompt = body['messages'][0]['content'] if chat else body['input'][0]['content'][0]['text']
            pelican = 'SVG' in prompt
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()

            def send(event):
                self.wfile.write(('data: ' + json.dumps(event, ensure_ascii=False) + '\n\n').encode())
                self.wfile.flush()

            try:
                text = PARTIAL if pelican else '推理过程\n答案：21'
                send({'choices': [{'index': 0, 'delta': {'content': text}}]} if chat else {'type': 'response.output_text.delta', 'delta': text})
                if pelican:
                    release.wait(20)
                    send({'choices': [{'index': 0, 'delta': {'content': TAIL}}]} if chat else {'type': 'response.output_text.delta', 'delta': TAIL})
                if chat:
                    send({'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}], 'usage': {'completion_tokens': 88}})
                else:
                    send({'type': 'response.completed', 'response': {'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': HTML if pelican else text}]}], 'usage': {'output_tokens': 88}}})
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='model-evaluation-test-') as runtime:
        env = {**os.environ, 'SKIP_DOTENV': '1', 'NODE_ENV': 'development', 'CONTAINER': 'false',
               'HOST': '127.0.0.1', 'PORT': str(port), 'RUNTIME_DIR': runtime, 'TASK_CONCURRENCY': '2', 'OPENAI_PROXY_URL': ''}
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
                raise RuntimeError('startup timed out')
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                page = browser.new_page(viewport={'width': 1440, 'height': 1100})
                errors, requests = [], []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.route('**/api/session-health', lambda route: route.fulfill(json={'results': [{'status': 200}, {'status': 401}, {'status': 200}]}))

                def evaluate(route):
                    body = route.request.post_data_json
                    requests.append(body)
                    if body['account']['email'] == 'third@example.com' and body['question'] == 'candy':
                        events = [{'type': 'error', 'error': '模拟账号失败'}]
                    else:
                        events = [{'type': 'complete', 'status': 'passed' if body['question'] == 'candy' else 'manual_review',
                                   'output': '答案：21' if body['question'] == 'candy' else HTML, 'durationMs': 100, 'firstTokenMs': 40}]
                    route.fulfill(content_type='text/event-stream', body=''.join('data: ' + json.dumps(item) + '\n\n' for item in events))

                page.route('**/api/model-evaluation', evaluate)
                page.goto(url)
                page.wait_for_load_state('networkidle')
                panel = page.locator('#model-evaluation')
                start = panel.locator('[data-evaluation-start]')
                expect(panel).to_be_hidden()
                page.locator('#model-evaluation-tab').click()
                expect(panel).to_be_visible()
                expect(page.locator('#converter-workspace')).to_be_hidden()
                expect(page.locator('.top-nav [data-format="sub2api"]')).to_have_attribute('aria-pressed', 'false')
                expect(start).to_be_disabled()
                expect(page.locator('#evaluation-model')).to_have_value('gpt-6-astra')
                page.locator('#evaluation-import').click()
                accounts = [{'accessToken': 'fixture-token', 'user': {'email': email}} for email in ['first@example.com', 'failed@example.com', 'third@example.com']]
                page.locator('#session-input').fill(json.dumps(accounts))
                expect(page.locator('#health-status')).to_contain_text('测活完成')
                page.locator('#model-evaluation-tab').click()
                expect(page.locator('#evaluation-account-count')).to_have_text('2 个可测试账号 / 3 个导入账号')
                start.click()
                expect(page.locator('#evaluation-status')).to_contain_text('测试完成')
                assert len(requests) == 4
                assert all(body['model'] == 'gpt-6-astra' and body['account']['email'] != 'failed@example.com' for body in requests)
                expect(page.locator('#evaluation-status')).to_contain_text('失败 1')
                expect(page.locator('#evaluation-progress-count')).to_have_text('4 / 4')
                expect(page.frame_locator('#evaluation-preview-frame').locator('svg text')).to_have_text('Pelican in motion')
                page.locator('#evaluation-enlarge').click()
                expect(page.locator('#evaluation-preview-dialog')).to_be_visible()
                expect(page.locator('#evaluation-large-frame')).to_have_attribute('sandbox', '')
                expect(page.frame_locator('#evaluation-large-frame').locator('animateTransform')).to_have_count(1)
                page.keyboard.press('Escape')
                expect(page.locator('#evaluation-preview-dialog')).not_to_be_visible()

                # Exercise the actual server route and transport against a local streaming API.
                page.unroute('**/api/model-evaluation')
                page.locator('input[name="evaluation-source"][value="api"]').check()
                page.locator('#evaluation-api-url').fill(f'http://127.0.0.1:{upstream.server_port}/v1')
                page.locator('#evaluation-api-key').fill('fixture-api-secret')
                page.locator('#evaluation-model').fill('custom-model')
                start.click()
                expect(page.locator('#evaluation-case-status')).to_have_text('生成中')
                expect(page.frame_locator('#evaluation-preview-frame').locator('svg text')).to_have_text('Pelican in motion')
                assert not release.is_set()
                expect(page.locator('#evaluation-progress-count')).to_have_text('1 / 2')
                assert page.locator('#evaluation-chars').inner_text() != '0 字符'
                output = ROOT / 'output' / 'model-evaluation'
                output.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(output / 'streaming-desktop.png'), full_page=True)
                page.locator('.top-nav [data-format="sub2api"]').click()
                page.locator('#model-evaluation-tab').click()
                expect(page.locator('#evaluation-case-status')).to_have_text('生成中')
                release.set()
                expect(page.locator('#evaluation-status')).to_contain_text('测试完成', timeout=10000)
                expect(page.frame_locator('#evaluation-preview-frame').locator('animateTransform')).to_have_count(1)
                expect(page.locator('#evaluation-tokens')).to_have_text('88')
                assert all(item[1] == 'Bearer fixture-api-secret' and item[2]['model'] == 'custom-model' for item in upstream_requests)
                page.screenshot(path=str(output / 'completed-desktop.png'), full_page=True)
                assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')

                page.locator('#evaluation-protocol').select_option('chat')
                release.clear()
                start.click()
                expect(page.locator('#evaluation-case-status')).to_have_text('生成中')
                expect(page.frame_locator('#evaluation-preview-frame').locator('svg text')).to_have_text('Pelican in motion')
                panel.locator('[data-evaluation-stop]').click()
                expect(page.locator('#evaluation-status')).to_contain_text('已停止')
                expect(page.locator('#evaluation-output-note')).to_contain_text('部分内容')
                expect(page.locator('#evaluation-preview-frame')).to_be_visible()
                expect(start).to_be_enabled()
                assert upstream_requests[-1][0] == '/v1/chat/completions'
                release.set()
                page.set_viewport_size({'width': 390, 'height': 844})
                expect(page.frame_locator('#evaluation-preview-frame').locator('svg text')).to_have_text('Pelican in motion')
                page.wait_for_function("document.querySelector('#evaluation-preview-frame').getBoundingClientRect().width > 300")
                page.locator('#evaluation-preview-frame').scroll_into_view_if_needed()
                page.screenshot(path=str(output / 'mobile.png'), full_page=True)
                assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                page.reload()
                page.wait_for_load_state('networkidle')
                expect(page.locator('#evaluation-api-key')).to_have_value('')
                page.locator('input[name="evaluation-source"][value="accounts"]').check()
                expect(start).to_be_disabled()
                assert not errors, errors
                browser.close()
                print('PASS: health-only accounts, independent tab, API credentials, real incremental Responses/Chat streams, animation preview, modal, cancellation, responsive layout, key not persisted')
        finally:
            release.set()
            child.terminate()
            child.wait(timeout=15)
            upstream.shutdown()


if __name__ == '__main__':
    main()
