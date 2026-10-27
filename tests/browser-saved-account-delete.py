"""Browser regression for deleting one saved protocol account locally."""
import json
from playwright.sync_api import expect, sync_playwright


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        deleted = {
            'id': 'delete-me', 'email': 'delete@example.com', 'password': 'deleted-password',
            'two_factor_secret': 'JBSWY3DPEHPK3PXP', 'session_access_token': 'fixture-session',
            'openai_rt': 'fixture-personal-rt', 'updatedAt': 1780000000000,
        }
        kept = {
            'id': 'keep-me', 'email': 'keep@example.com', 'password': 'keep-password',
            'two_factor_secret': 'JBSWY3DPEHPK3PXP', 'openai_rt': 'fixture-keep-rt',
        }
        deleted_push = {'name': deleted['email'], 'platform': 'openai', 'type': 'oauth',
                        'credentials': {'email': deleted['email'], 'chatgpt_account_id': 'delete-workspace',
                                        'access_token': 'fixture-access', 'refresh_token': 'fixture-refresh'}}
        kept_push = {'name': kept['email'], 'platform': 'openai', 'type': 'oauth',
                     'credentials': {'email': kept['email'], 'chatgpt_account_id': 'keep-workspace',
                                     'access_token': 'fixture-access', 'refresh_token': 'fixture-refresh'}}
        try:
            page.goto('http://127.0.0.1:4173/')
            page.evaluate('''async ({deleted, kept, deletedPush, keptPush}) => {
                await browserWorkspace.save({state: {
                    format: 'protocol-login', browserAccounts: [deleted, kept],
                    loginLastIds: ['delete-me', 'keep-me'], loginSessionIds: ['delete-me'],
                    loginPersonalIds: ['delete-me', 'keep-me'], loginBusinessIds: ['delete-me'],
                    monitorRetries: {'delete-me': {attempts: 1, after: 1780000060000}},
                    monitorStopped: {'delete-me': 'account_unavailable'},
                    monitorRevivalHistory: {'delete-me': [{at: 1780000000000, push: 'success'}]},
                    pushOperations: [{operationId: 'fixture-op', target: 'sub2api', baseUrl: 'https://fixture',
                        groupIds: [7], proxyId: '', upsert: true, startedAt: 1, updatedAt: 2,
                        items: [
                            {itemId: 'deleted', account: deletedPush, name: deleted.email, status: 'failed', retryable: true},
                            {itemId: 'kept', account: keptPush, name: kept.email, status: 'failed', retryable: true},
                        ]}], activePushOperationId: 'fixture-op',
                }, fields: [{id: 'login-accounts', value: [
                    'delete@example.com----deleted-password----JBSWY3DPEHPK3PXP',
                    'keep@example.com----keep-password----JBSWY3DPEHPK3PXP',
                ].join('\\n')} ]});
            }''', {'deleted': deleted, 'kept': kept, 'deletedPush': deleted_push, 'keptPush': kept_push})
            page.reload()
            expect(page.locator('[data-saved-delete-account="delete-me"]')).to_be_visible()
            page.once('dialog', lambda dialog: dialog.dismiss())
            page.locator('[data-saved-delete-account="delete-me"]').click()
            assert page.evaluate('async () => (await browserWorkspace.read()).state.browserAccounts.length') == 2
            page.once('dialog', lambda dialog: dialog.accept())
            page.locator('[data-saved-delete-account="delete-me"]').click()
            expect(page.locator('#saved-accounts-status')).to_contain_text('已删除 delete@example.com')
            expect(page.locator('[data-saved-delete-account="delete-me"]')).to_have_count(0)
            expect(page.locator('[data-saved-delete-account="keep-me"]')).to_have_count(1)
            saved = page.evaluate('async () => await browserWorkspace.read()')
            state = saved['state']
            assert [row['id'] for row in state['browserAccounts']] == ['keep-me']
            assert state['loginSessionIds'] == []
            assert state['loginPersonalIds'] == ['keep-me']
            assert state['loginBusinessIds'] == []
            assert state['monitorRetries'] == {}
            assert state['monitorStopped'] == {}
            assert state['monitorRevivalHistory'] == {}
            assert [item['itemId'] for item in state['pushOperations'][0]['items']] == ['kept']
            assert 'delete@example.com' not in state.get('conversionInput', {}).get('text', '')
            assert 'delete@example.com' not in page.locator('#login-accounts').input_value()
            assert 'deleted-password' not in json.dumps(saved)
            assert not errors, errors
        finally:
            context.close()
            browser.close()
    print('Browser saved-account delete: confirmation, local state cleanup, push-history cleanup: PASS')


if __name__ == '__main__':
    main()
