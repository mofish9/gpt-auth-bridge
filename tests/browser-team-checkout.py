import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_fixture#details'


def main():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='team-checkout-test-') as runtime:
        env = {**os.environ, 'SKIP_DOTENV': '1', 'NODE_ENV': 'development', 'CONTAINER': 'false',
               'HOST': '127.0.0.1', 'PORT': str(port), 'RUNTIME_DIR': runtime,
               'TASK_CONCURRENCY': '1', 'OPENAI_PROXY_URL': ''}
        child = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            for attempt in range(300):
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
                context = browser.new_context(permissions=['clipboard-read', 'clipboard-write'])
                page = context.new_page()
                errors = []
                requests = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(url)
                page.wait_for_load_state('networkidle')
                expect(page.locator('#browser-storage-status')).to_contain_text('此浏览器')
                nav = page.locator('.top-nav [data-format]')
                assert nav.evaluate_all('(nodes) => nodes.map(node => node.dataset.format)') == ['sub2api', 'sub2api-tools', 'protocol-login', 'team-checkout']
                page.locator('.top-nav [data-format="team-checkout"]').click()
                expect(page.locator('#team-checkout-workbench')).to_be_visible()
                expect(page.locator('#converter-workspace')).to_be_hidden()
                expect(page.locator('#login-workbench')).to_be_hidden()
                expect(page.locator('#format-toolbar')).to_be_hidden()
                expect(page.locator('.top-nav [data-format="sub2api"]')).to_have_attribute('aria-pressed', 'false')
                expect(page.locator('#team-config-proxy')).to_have_text('内置代理')
                expect(page.locator('#team-proxy-url')).to_be_hidden()
                expect(page.locator('input[name="proxyMode"][value="builtin"]')).to_be_checked()
                expect(page.locator('.session-monitor')).to_be_hidden()

                def checkout(route):
                    requests.append(route.request.post_data_json)
                    route.fulfill(json={'ok': True, 'url': CHECKOUT_URL, 'workspaceName': 'Fixture Team',
                                        'seatQuantity': 3, 'priceInterval': 'year', 'country': 'EG',
                                        'currency': 'EGP', 'checkoutSessionId': 'cs_test_fixture'})

                page.route('**/api/v2/team/checkout', checkout)
                page.locator('#team-auto-open').uncheck()
                page.locator('#team-access-token').fill('fixture-token')
                page.locator('#generate-team-checkout').click()
                expect(page.locator('#team-checkout-output')).to_be_visible()
                assert requests[-1]['proxyMode'] == 'builtin'
                assert 'proxyUrl' not in requests[-1]
                requests.clear()
                page.locator('input[name="proxyMode"][value="custom"]').check()
                expect(page.locator('#team-proxy-url')).to_be_visible()
                expect(page.locator('#team-config-proxy')).to_have_text('自定义代理')
                session_json = json.dumps({'accessToken': 'fixture-secret-token'})
                page.locator('#team-proxy-url').fill('proxy.example:8080:fixture-user:fixture-password')
                page.locator('#team-access-token').fill(session_json)
                page.locator('#team-workspace-name').fill('Fixture Team')
                page.locator('#team-seat-quantity').fill('3')
                page.locator('#team-price-interval').select_option('year')
                page.locator('#team-coupon').fill('COUPON & TEST')
                page.locator('#team-advanced-settings summary').click()
                page.locator('#team-existing-workspace').fill('workspace-fixture')
                page.locator('#team-advanced-settings summary').click()
                expect(page.locator('#team-config-seats')).to_have_text('3')
                expect(page.locator('#team-config-interval')).to_have_text('年付订阅')
                expect(page.locator('#team-config-workspace')).to_have_text('已有空间')
                for attempt in range(100):
                    saved = page.evaluate('() => window.browserWorkspace.read()')
                    if saved and any(field['id'] == 'team-workspace-name' and field['value'] == 'Fixture Team' for field in saved['fields']):
                        break
                    page.wait_for_timeout(50)
                else:
                    raise AssertionError('Team settings were not persisted')
                assert 'fixture-secret-token' not in json.dumps(saved)
                assert 'fixture-password' not in json.dumps(saved)
                assert not any(field['id'] == 'team-access-token' for field in saved['fields'])
                assert not any(field['id'] == 'team-proxy-url' for field in saved['fields'])
                page.locator('#generate-team-checkout').click()
                expect(page.locator('#team-checkout-output')).to_be_visible()
                expect(page.locator('#team-checkout-url')).to_have_value(CHECKOUT_URL)
                expect(page.locator('#team-access-token')).to_have_value('')
                expect(page.locator('#open-team-checkout')).to_have_attribute('href', CHECKOUT_URL)
                assert requests == [{'accessToken': session_json, 'workspaceName': 'Fixture Team',
                                     'seatQuantity': 3, 'priceInterval': 'year', 'coupon': 'COUPON & TEST',
                                     'existingWorkspaceId': 'workspace-fixture', 'country': 'EG', 'currency': 'EGP',
                                     'proxyMode': 'custom', 'proxyUrl': 'proxy.example:8080:fixture-user:fixture-password'}]
                page.locator('#copy-team-checkout').click()
                expect(page.locator('#team-checkout-status')).to_contain_text('已复制')
                assert page.evaluate('() => navigator.clipboard.readText()') == CHECKOUT_URL

                for width in [1440, 768, 390, 320]:
                    page.set_viewport_size({'width': width, 'height': 1000})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
                    expect(page.locator('#generate-team-checkout')).to_be_visible()
                    if os.environ.get('TEAM_UI_SCREENSHOTS'):
                        destination = Path(os.environ['TEAM_UI_SCREENSHOTS'])
                        destination.mkdir(parents=True, exist_ok=True)
                        page.evaluate('window.scrollTo(0, 0)')
                        page.screenshot(path=str(destination / f'team-checkout-{width}.png'), full_page=True)

                page.set_viewport_size({'width': 1440, 'height': 1000})
                page.locator('[data-team-country="US"]').click()
                expect(page.locator('#team-country')).to_have_value('US')
                expect(page.locator('#team-currency')).to_have_value('USD')
                expect(page.locator('#team-config-country')).to_have_text('美国（US）')
                expect(page.locator('#team-config-currency')).to_have_text('USD')
                page.locator('#team-country').select_option('EG')
                expect(page.locator('#team-currency')).to_have_value('EGP')
                page.locator('input[name="proxyMode"][value="direct"]').check()
                expect(page.locator('#team-proxy-url')).to_be_hidden()
                expect(page.locator('#team-config-proxy')).to_have_text('服务器直连')
                page.locator('#team-access-token').fill('fixture-secret-token')
                page.locator('#generate-team-checkout').click()
                expect(page.locator('#team-checkout-output')).to_be_visible()
                assert requests[-1]['proxyMode'] == 'direct'
                assert 'proxyUrl' not in requests[-1]
                page.locator('#team-access-token').fill('fixture-secret-token')
                expect(page.locator('#team-checkout-output')).to_be_hidden()
                page.unroute('**/api/v2/team/checkout')
                page.route('**/api/v2/team/checkout', lambda route: route.fulfill(status=401, json={'ok': False, 'error': 'Access Token 已失效，请重新登录获取'}))
                page.locator('#generate-team-checkout').click()
                expect(page.locator('#team-checkout-status')).to_contain_text('Access Token 已失效')
                expect(page.locator('#team-checkout-output')).to_be_hidden()
                expect(page.locator('#generate-team-checkout')).to_be_enabled()

                page.unroute('**/api/v2/team/checkout')
                page.route('**/api/v2/team/checkout', checkout)
                page.route('https://checkout.stripe.com/**', lambda route: route.fulfill(body='Checkout fixture'))
                page.locator('#team-auto-open').check()
                with page.expect_popup() as popup_info:
                    page.locator('#generate-team-checkout').click()
                popup = popup_info.value
                popup.wait_for_url(CHECKOUT_URL)
                assert popup.evaluate('window.opener === null')
                popup.close()
                expect(page.locator('#team-checkout-output')).to_be_visible()
                page.evaluate('window.fixtureOpen = window.open; window.open = () => null')
                page.locator('#team-access-token').fill('fixture-secret-token')
                page.locator('#generate-team-checkout').click()
                expect(page.locator('#team-checkout-status')).to_contain_text('自动打开被浏览器阻止')
                expect(page.locator('#team-checkout-output')).to_be_visible()
                page.evaluate('window.open = window.fixtureOpen')
                page.unroute('**/api/v2/team/checkout')
                held = []
                page.route('**/api/v2/team/checkout', lambda route: held.append(route))
                page.locator('#team-auto-open').uncheck()
                page.locator('#team-access-token').fill('fixture-secret-token')
                with page.expect_request('**/api/v2/team/checkout'):
                    page.locator('#generate-team-checkout').click()
                expect(page.locator('#generate-team-checkout')).to_be_disabled()
                page.locator('#team-checkout-form').dispatch_event('submit')
                assert len(held) == 1
                page.once('dialog', lambda dialog: dialog.accept())
                page.locator('#clear-login-data').click()
                expect(page.locator('#generate-team-checkout')).to_be_enabled()
                for route in held:
                    route.abort()
                expect(page.locator('#team-checkout-output')).to_be_hidden()
                expect(page.locator('#team-checkout-url')).to_have_value('')
                expect(page.locator('#team-access-token')).to_have_value('')
                expect(page.locator('#team-proxy-url')).to_have_value('')
                page.locator('.top-nav [data-format="sub2api"]').click()
                expect(page.locator('#team-checkout-workbench')).to_be_hidden()
                expect(page.locator('#converter-workspace')).to_be_visible()
                assert not errors, errors
                browser.close()
            print('Team checkout browser checks passed: navigation, payload, token privacy, copy, errors, popup, clear and responsive layout')
        finally:
            child.terminate()
            child.wait(timeout=15)


if __name__ == '__main__':
    main()
