"""Scheduling controls, encrypted persistence and exact push payloads with mocked APIs."""
import json
import runpy
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
fixtures = runpy.run_path(str(ROOT / 'tests/browser-durability.py'))
fixture_page, SESSION = fixtures['fixture_page'], fixtures['SESSION']


def check_imported_policy(browser):
    context, page, errors, _ = fixture_page(browser)
    original_policy = {
        'openai_overload_cooldown_enabled': True, 'openai_overload_cooldown_minutes': 23,
        'temp_unschedulable_enabled': True, 'temp_unschedulable_rules': [
            {'error_code': 503, 'keywords': ['custom capacity'], 'duration_minutes': 7,
             'scope': 'account', 'description': 'keep this custom rule'},
        ],
    }
    account = {'name': 'fixture@example.com', 'platform': 'openai', 'type': 'oauth', 'credentials': {
        'email': 'fixture@example.com', 'account_id': 'fixture-id', 'access_token': 'fixture-access',
        **original_policy,
    }}
    try:
        page.locator('.top-nav [data-format="sub2api-tools"]').click()
        page.locator('#session-input').fill(json.dumps({'type': 'sub2api-data', 'version': 1, 'proxies': [], 'accounts': [account]}))
        expect(page.locator('#output')).not_to_be_empty()
        output = lambda: json.loads(page.locator('#output').input_value())['accounts'][0]['credentials']
        assert all(output()[key] == value for key, value in original_policy.items())
        expect(page.locator('#sub2api-scheduling-policy-mode')).to_have_value('preserve')
        page.locator('#sub2api-overload-enabled').check()
        page.locator('#sub2api-overload-minutes').fill('17')
        assert output()['openai_overload_cooldown_minutes'] == 23, 'Local settings must not change an imported policy in preserve mode'
        page.locator('#sub2api-scheduling-policy-mode').select_option('override')
        assert output()['openai_overload_cooldown_minutes'] == 17
        assert output()['temp_unschedulable_enabled'] is False
        assert output()['temp_unschedulable_rules'] == []
        page.evaluate('''async () => {
            for (let attempt = 0; attempt < 100; attempt++) {
                if ((await browserWorkspace.read())?.state?.browserSettings?.sub2apiSettings?.schedulingPolicyMode === 'override') return;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error('Scheduling policy mode was not persisted');
        }''')
        page.reload()
        expect(page.locator('#sub2api-scheduling-policy-mode')).to_have_value('override')
        assert output()['openai_overload_cooldown_minutes'] == 17
        page.locator('#sub2api-scheduling-policy-mode').select_option('preserve')
        assert all(output()[key] == value for key, value in original_policy.items())
        page.locator('#operation-split').click()
        expect(page.locator('#output')).to_be_empty()
        expect(page.locator('#download-output')).to_be_disabled()
        page.locator('#mail-input').fill('fixture@example.com')
        expect(page.locator('#output')).not_to_be_empty()
        assert all(output()[key] == value for key, value in original_policy.items())
        page.locator('.top-nav [data-format="sub2api"]').click()
        assert all(output()[key] == value for key, value in original_policy.items())
        assert not errors, errors
    finally:
        context.close()


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        check_imported_policy(browser)
        context, page, errors, _ = fixture_page(browser)
        writes = []
        page.route('**/api/push/sub2api/groups', lambda route: route.fulfill(json={
            'groups': [{'id': 7, 'name': 'Fixture group', 'platform': 'openai'}]}))
        page.route('**/api/push/sub2api/proxies', lambda route: route.fulfill(json={'proxies': []}))

        def push(route):
            body = route.request.post_data_json
            writes.append(body)
            success = len(writes) > 1
            route.fulfill(json={
                'ok': success, 'schemaVersion': body['schemaVersion'], 'operationId': body['operationId'],
                'requestId': 'fixture', 'imported': int(success), 'failed': int(not success), 'unknown': 0,
                'results': [{'index': 0, 'itemId': body['itemIds'][0], 'status': 'success' if success else 'failed',
                             'retryable': not success, 'code': 'SUCCESS' if success else 'REMOTE_UNAVAILABLE'}]})

        page.route('**/api/push/sub2api', push)
        try:
            page.locator('.top-nav [data-format="sub2api"]').click()
            page.locator('#session-input').fill(json.dumps({**SESSION, 'plan_type': 'plus'}))
            page.locator('#open-sub2-push-config').click()
            dialog = page.locator('#sub2-push-dialog')
            expect(dialog).to_be_visible()
            page.locator('.push-account-options summary').click()
            overload = page.locator('#login-sub2-overload-enabled')
            temp = page.locator('#login-sub2-temp-enabled')
            expect(overload).not_to_be_checked()
            expect(temp).not_to_be_checked()
            expect(dialog.locator('[data-scheduling-section="overload"]')).to_be_hidden()
            expect(dialog.locator('[data-scheduling-section="temp"]')).to_be_hidden()
            page.locator('#login-sub2-base-url').fill('https://sub2.fixture.invalid')
            page.locator('#login-sub2-admin-key').fill('fixture-admin-key')
            page.locator('#load-login-sub2-groups').click()
            page.locator('[data-sub2-group-id="7"]').check()
            overload.check()
            temp.check()
            for field in ['overload-minutes', 'temp-overload-minutes', 'temp-rate-limit-minutes']:
                expect(page.locator('#login-sub2-' + field)).to_have_value('10')
            expect(page.locator('#login-sub2-temp-overload-enabled')).to_be_checked()
            expect(page.locator('#login-sub2-temp-rate-limit-enabled')).to_be_checked()
            for value in ['0', '121', '1.5']:
                page.locator('#login-sub2-overload-minutes').fill(value)
                page.locator('#save-login-sub2-config').click()
                expect(page.locator('#login-sub2-status')).to_contain_text('1–120')
            overload.uncheck()
            page.locator('#save-login-sub2-config').click()
            expect(page.locator('#login-sub2-status')).to_contain_text('已加密保存')
            expect(page.locator('#login-sub2-overload-minutes')).to_have_value('10')
            expect(page.locator('#sub2api-overload-enabled')).not_to_be_checked()
            overload.check()
            page.locator('#login-sub2-overload-minutes').fill('17')
            page.locator('#login-sub2-temp-overload-minutes').fill('0')
            page.locator('#save-login-sub2-config').click()
            expect(page.locator('#login-sub2-status')).to_contain_text('正整数')
            page.locator('#login-sub2-temp-overload-enabled').uncheck()
            page.locator('#save-login-sub2-config').click()
            expect(page.locator('#login-sub2-status')).to_contain_text('已加密保存')
            expect(page.locator('#login-sub2-temp-overload-minutes')).to_have_value('10')
            expect(page.locator('#login-sub2-temp-overload-minutes')).to_be_disabled()
            page.locator('#login-sub2-temp-overload-enabled').check()
            page.locator('#login-sub2-temp-overload-minutes').fill('3')
            page.locator('#login-sub2-temp-overload-scope').select_option('account')
            page.locator('#login-sub2-temp-rate-limit-minutes').fill('5')
            page.locator('#login-sub2-temp-overload-enabled').uncheck()
            expect(page.locator('#login-sub2-temp-overload-minutes')).to_be_disabled()
            page.locator('#login-sub2-temp-rate-limit-enabled').uncheck()
            page.locator('#save-login-sub2-config').click()
            expect(page.locator('#login-sub2-status')).to_contain_text('至少选择')
            page.locator('#login-sub2-temp-rate-limit-enabled').check()
            page.locator('#save-login-sub2-config').click()
            expect(page.locator('#login-sub2-status')).to_contain_text('已加密保存')
            exported = lambda: json.loads(page.locator('#output').input_value())['accounts'][0]['credentials']
            assert [rule['error_code'] for rule in exported()['temp_unschedulable_rules']] == [429]
            page.locator('#login-sub2-temp-overload-enabled').check()
            page.locator('#login-sub2-temp-overload-minutes').fill('')
            page.locator('#login-sub2-temp-rate-limit-minutes').fill('0')
            temp.uncheck()
            expect(dialog.locator('[data-scheduling-section="temp"]')).to_be_hidden()
            assert exported()['temp_unschedulable_rules'] == []
            page.locator('#save-login-sub2-config').click()
            expect(page.locator('#login-sub2-status')).to_contain_text('已加密保存')
            expect(page.locator('#login-sub2-temp-overload-minutes')).to_have_value('3')
            expect(page.locator('#login-sub2-temp-rate-limit-minutes')).to_have_value('5')
            temp.check()
            expect(page.locator('#login-sub2-temp-overload-minutes')).to_have_value('3')
            expect(page.locator('#login-sub2-temp-overload-scope')).to_have_value('account')
            page.locator('#save-login-sub2-config').click()
            expect(page.locator('#login-sub2-status')).to_contain_text('已加密保存')
            expected = {
                'openai_overload_cooldown_enabled': True, 'openai_overload_cooldown_minutes': 17,
                'temp_unschedulable_enabled': True, 'temp_unschedulable_rules': [
                    {'error_code': 529, 'keywords': ['overloaded', 'too many'], 'duration_minutes': 3, 'scope': 'account'},
                    {'error_code': 429, 'keywords': ['rate limit', 'too many requests'], 'duration_minutes': 5, 'scope': 'model'},
                ]}
            assert all(exported()[key] == value for key, value in expected.items())
            assert exported()['refresh_token'] == 'fixture-refresh'
            page.get_by_role('button', name='关闭 Sub2API 配置', exact=True).click()
            page.reload()
            expect(page.locator('#session-input')).not_to_be_empty()
            assert all(exported()[key] == value for key, value in expected.items())
            expect(page.locator('#sub2api-overload-enabled')).to_be_checked()
            expect(page.locator('#sub2api-overload-minutes')).to_have_value('17')
            page.locator('#open-sub2-push-config').click()
            if not page.locator('.push-account-options').evaluate('(el) => el.open'):
                page.locator('.push-account-options summary').click()
            expect(overload).to_be_checked()
            expect(temp).to_be_checked()
            expect(page.locator('#login-sub2-temp-rate-limit-minutes')).to_have_value('5')

            for width in [1440, 390, 320]:
                page.set_viewport_size({'width': width, 'height': 900 if width == 1440 else 740})
                temp.scroll_into_view_if_needed()
                for selector in ['#sub2-push-dialog', '#sub2-push-dialog .push-config-body', '#sub2-push-dialog .push-scheduling-panel', '#sub2-push-dialog .push-config-footer']:
                    node = page.locator(selector)
                    assert node.evaluate('(el) => el.scrollWidth <= el.clientWidth + 1'), (width, selector)
                    box = node.bounding_box()
                    assert box and box['x'] >= 0 and box['x'] + box['width'] <= width, (width, selector, box)
                expect(page.locator('#save-login-sub2-config')).to_be_in_viewport()
                gap = temp.evaluate('''el => {
                    const text = [...el.parentElement.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
                    const range = document.createRange(); range.selectNodeContents(text);
                    return range.getBoundingClientRect().left - el.getBoundingClientRect().right;
                }''')
                assert 0 <= gap <= 12, (width, gap)
                if width != 320:
                    page.screenshot(path=str(ROOT / 'runtime' / f'sub2api-scheduling-{width}.png'))
            page.set_viewport_size({'width': 1440, 'height': 900})
            page.get_by_role('button', name='关闭 Sub2API 配置', exact=True).click()
            page.locator('input[name="push-target"][value="sub2api"]').check()

            # An invalid draft must not silently send the last valid configuration.
            page.locator('#sub2api-overload-minutes').fill('121')
            page.locator('#push-converted').click()
            expect(page.locator('#push-status')).to_contain_text('1–120')
            assert not writes
            page.locator('#sub2api-overload-minutes').fill('17')
            page.locator('#push-converted').click()
            expect(page.locator('#retry-push')).to_be_enabled()
            assert len(writes) == 1
            assert all(writes[0]['accounts'][0]['credentials'][key] == value for key, value in expected.items())
            page.locator('#sub2api-overload-minutes').fill('25')
            page.locator('#retry-push').click()
            expect(page.locator('#push-status')).to_contain_text('成功 1，失败 0')
            assert len(writes) == 2
            assert writes[0]['operationId'] == writes[1]['operationId']
            assert writes[0]['accounts'] == writes[1]['accounts'], 'Retry must preserve the initial account policy snapshot'
            assert writes[1]['settings']['openaiOverloadCooldownMinutes'] == 25
            assert not errors, errors
        finally:
            context.close()
            browser.close()
    print('Sub2API scheduling: imported policy preservation/override, disabled invalid durations, encrypted reload, export, payload, retry snapshot and responsive layout: PASS')


if __name__ == '__main__':
    main()
