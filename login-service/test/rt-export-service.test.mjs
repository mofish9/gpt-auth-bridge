import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStoredBusinessRtExportRecord, buildStoredRtExportRecord } from '../src/services/rt-export-service.js';

function jwt(payload) {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

const claims = {
  client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
  exp: Math.floor(Date.now() / 1000) + 3600,
  'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1', chatgpt_plan_type: 'plus' },
};

test('protocol input is exported as the Sub2API notes field', () => {
  const record = buildStoredRtExportRecord({
    email: 'person@example.com',
    raw: 'person@example.com----password----JBSWY3DPEHPK3PXP',
    openai_rt: 'rt',
    openai_access_token: jwt(claims),
    openai_id_token: 'id',
  });
  assert.equal(record.notes, 'person@example.com----password----JBSWY3DPEHPK3PXP');
});

test('business workspace exports retain the same source notes', () => {
  const record = buildStoredBusinessRtExportRecord({
    email: 'business@example.com',
    raw: 'business@example.com----password----JBSWY3DPEHPK3PXP',
    business_workspace_id: 'workspace-1',
    business_openai_rt: 'rt',
    business_openai_access_token: jwt({ ...claims, 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-1', chatgpt_plan_type: 'business' } }),
    business_openai_id_token: 'id',
  });
  assert.equal(record.notes, 'business@example.com----password----JBSWY3DPEHPK3PXP');
});
