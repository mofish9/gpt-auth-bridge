// Shared by browser configuration, server exports and remote reconciliation.
export const SCHEDULING_FIELDS = Object.freeze([
  { key: 'schedulingPolicyMode', suffix: 'scheduling-policy-mode', type: 'select', default: 'preserve' },
  { key: 'openaiOverloadCooldownEnabled', suffix: 'overload-enabled', type: 'checkbox', default: false },
  { key: 'openaiOverloadCooldownMinutes', suffix: 'overload-minutes', type: 'number', default: 10 },
  { key: 'tempUnschedulableEnabled', suffix: 'temp-enabled', type: 'checkbox', default: false },
  { key: 'tempUnschedulableOverloadEnabled', suffix: 'temp-overload-enabled', type: 'checkbox', default: true },
  { key: 'tempUnschedulableOverloadMinutes', suffix: 'temp-overload-minutes', type: 'number', default: 10 },
  { key: 'tempUnschedulableOverloadScope', suffix: 'temp-overload-scope', type: 'select', default: 'model' },
  { key: 'tempUnschedulableRateLimitEnabled', suffix: 'temp-rate-limit-enabled', type: 'checkbox', default: true },
  { key: 'tempUnschedulableRateLimitMinutes', suffix: 'temp-rate-limit-minutes', type: 'number', default: 10 },
  { key: 'tempUnschedulableRateLimitScope', suffix: 'temp-rate-limit-scope', type: 'select', default: 'model' },
]);

const boolean = value => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
const CREDENTIAL_GROUPS = [
  ['openai_overload_cooldown_enabled', 'openai_overload_cooldown_minutes'],
  ['temp_unschedulable_enabled', 'temp_unschedulable_rules'],
];

export function pickSchedulingCredentials(credentials = {}) {
  return Object.fromEntries(CREDENTIAL_GROUPS.flat().filter(key => Object.hasOwn(credentials, key)).map(key => [key, credentials[key]]));
}

function minutes(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(maximum === 120 ? `${name}必须是 1–120 的整数` : `${name}必须是正整数`);
  }
}

export function normalizeSchedulingSettings(settings = {}, previous = {}) {
  const result = Object.fromEntries(SCHEDULING_FIELDS.map(field => {
    const raw = settings[field.key] ?? field.default;
    return [field.key, field.type === 'checkbox' ? boolean(raw) : field.type === 'number' ? Number(raw) : raw];
  }));
  if (!['preserve', 'override'].includes(result.schedulingPolicyMode)) throw new Error('调度保护配置请选择保留原配置或覆盖为以下设置');
  // Hidden or unchecked controls must not prevent disabling a policy. Keep the
  // last valid duration, while still rejecting invalid values in active rules.
  for (const [key, name, active, maximum] of [
    ['openaiOverloadCooldownMinutes', 'OpenAI 容量过载冷却时间', result.openaiOverloadCooldownEnabled, 120],
    ['tempUnschedulableOverloadMinutes', '529 过载冷却时间', result.tempUnschedulableEnabled && result.tempUnschedulableOverloadEnabled, Number.MAX_SAFE_INTEGER],
    ['tempUnschedulableRateLimitMinutes', '429 限流冷却时间', result.tempUnschedulableEnabled && result.tempUnschedulableRateLimitEnabled, Number.MAX_SAFE_INTEGER],
  ]) {
    try { minutes(result[key], name, maximum); }
    catch (error) {
      if (active) throw error;
      const fallback = Number(previous[key]);
      result[key] = Number.isSafeInteger(fallback) && fallback >= 1 && fallback <= maximum ? fallback : 10;
    }
  }
  for (const key of ['tempUnschedulableOverloadScope', 'tempUnschedulableRateLimitScope']) {
    if (!['model', 'account'].includes(result[key])) throw new Error('临时不可调度作用范围必须为模型级或账号级');
  }
  if (result.tempUnschedulableEnabled && !result.tempUnschedulableOverloadEnabled && !result.tempUnschedulableRateLimitEnabled) {
    throw new Error('临时不可调度开启时，请至少选择一条 529 过载或 429 限流规则');
  }
  return result;
}

export function schedulingCredentials(settings = {}) {
  const value = normalizeSchedulingSettings(settings);
  const rules = [];
  if (value.tempUnschedulableEnabled) {
    if (value.tempUnschedulableOverloadEnabled) rules.push({
      error_code: 529, keywords: ['overloaded', 'too many'],
      duration_minutes: value.tempUnschedulableOverloadMinutes, scope: value.tempUnschedulableOverloadScope,
    });
    if (value.tempUnschedulableRateLimitEnabled) rules.push({
      error_code: 429, keywords: ['rate limit', 'too many requests'],
      duration_minutes: value.tempUnschedulableRateLimitMinutes, scope: value.tempUnschedulableRateLimitScope,
    });
  }
  return {
    openai_overload_cooldown_enabled: value.openaiOverloadCooldownEnabled,
    openai_overload_cooldown_minutes: value.openaiOverloadCooldownMinutes,
    temp_unschedulable_enabled: value.tempUnschedulableEnabled,
    temp_unschedulable_rules: rules,
  };
}

export function applySchedulingCredentials(credentials = {}, settings = {}) {
  const value = normalizeSchedulingSettings(settings);
  const policy = schedulingCredentials(value);
  if (value.schedulingPolicyMode === 'preserve') {
    // Preserve each policy as a whole; filling individual missing fields from
    // local settings could change an imported policy's effective behavior.
    for (const keys of CREDENTIAL_GROUPS) {
      if (keys.some(key => Object.hasOwn(credentials, key))) {
        for (const key of keys) delete policy[key];
      }
    }
  }
  return { ...credentials, ...policy };
}

export function validateSchedulingCredentials(credentials = {}) {
  for (const key of ['openai_overload_cooldown_enabled', 'temp_unschedulable_enabled']) {
    if (Object.hasOwn(credentials, key) && typeof credentials[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
  }
  if (Object.hasOwn(credentials, 'openai_overload_cooldown_minutes')) {
    minutes(credentials.openai_overload_cooldown_minutes, 'OpenAI 容量过载冷却时间', 120);
  }
  const rules = credentials.temp_unschedulable_rules;
  if (rules !== undefined && !Array.isArray(rules)) throw new Error('临时不可调度规则必须是数组');
  if (credentials.temp_unschedulable_enabled && !rules?.length) throw new Error('临时不可调度开启时至少需要一条规则');
  for (const rule of rules || []) {
    if (!rule || !Number.isInteger(rule.error_code) || rule.error_code < 100 || rule.error_code > 599) throw new Error('临时不可调度规则的状态码无效');
    minutes(rule.duration_minutes, '临时不可调度冷却时间');
    if (!Array.isArray(rule.keywords) || !rule.keywords.length || rule.keywords.some(keyword => typeof keyword !== 'string' || !keyword.trim())) {
      throw new Error('临时不可调度规则至少需要一个非空关键词');
    }
    if (rule.scope !== undefined && !['model', 'account'].includes(rule.scope)) throw new Error('临时不可调度规则的作用范围无效');
  }
}

export function schedulingCredentialsMatch(expected = {}, actual = {}) {
  actual = actual && typeof actual === 'object' ? actual : {};
  const hasPolicy = ['openai_overload_cooldown_enabled', 'openai_overload_cooldown_minutes', 'temp_unschedulable_enabled', 'temp_unschedulable_rules']
    .some(key => Object.hasOwn(expected, key));
  if (hasPolicy) {
    try { validateSchedulingCredentials(actual); } catch { return false; }
  }
  for (const key of ['openai_overload_cooldown_enabled', 'openai_overload_cooldown_minutes', 'temp_unschedulable_enabled']) {
    if (Object.hasOwn(expected, key) && actual[key] !== expected[key]) return false;
  }
  if (!Object.hasOwn(expected, 'temp_unschedulable_rules')) return true;
  if (!Array.isArray(actual.temp_unschedulable_rules)) return false;
  const canonical = rules => rules.map(rule => [rule.error_code, rule.duration_minutes,
    rule.scope || (rule.error_code === 401 ? 'account' : 'model'), rule.keywords]);
  return JSON.stringify(canonical(expected.temp_unschedulable_rules)) === JSON.stringify(canonical(actual.temp_unschedulable_rules));
}
