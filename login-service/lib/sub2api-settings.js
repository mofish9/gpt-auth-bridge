export const SUB2API_DEFAULT_MODELS = Object.freeze([
  'gpt-5.5',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-6-astra',
]);

export const SUB2API_FINGERPRINT_MODES = Object.freeze(['off', 'device', 'session', 'full']);
export const SUB2API_IMAGE_BRIDGE_STRATEGIES = Object.freeze(['inherit', 'enabled', 'disabled', 'strip']);
export const SUB2API_WS_MODES = Object.freeze(['off', 'ctx_pool', 'passthrough', 'http_bridge']);

function clampNumber(value, fallback, minimum, maximum, { integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const bounded = Math.max(minimum, Math.min(maximum, parsed));
  return integer ? Math.round(bounded) : bounded;
}

function uniqueStrings(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  return [...new Set(source.map(item => String(item || '').trim()).filter(Boolean))];
}

export function normalizeSub2ApiGroupIds(value) {
  return uniqueStrings(value).filter(item => /^\d+$/.test(item)).map(Number);
}

export function readSub2ApiSettingsDefaults(env = process.env) {
  const legacyGroup = String(env.SUB2API_GROUP_ID || env.SUB2API_GROUP_NAME || '').trim();
  return normalizeSub2ApiSettings({
    baseUrl: env.SUB2API_BASE_URL,
    adminApiKey: env.SUB2API_ADMIN_API_KEY,
    groupIds: /^\d+$/.test(legacyGroup) ? [legacyGroup] : [],
    legacyGroupName: /^\d+$/.test(legacyGroup) ? '' : legacyGroup,
    accountConcurrency: env.SUB2API_CONCURRENCY,
    priority: env.SUB2API_PRIORITY,
    loadFactor: env.SUB2API_LOAD_FACTOR,
    fingerprintMode: env.SUB2API_FINGERPRINT_MODE,
    models: env.SUB2API_MODELS,
    expiresAt: env.SUB2API_EXPIRES_AT,
    autoPauseOnExpired: env.SUB2API_AUTO_PAUSE_ON_EXPIRED,
    imageBridgeStrategy: env.SUB2API_IMAGE_BRIDGE_STRATEGY,
    wsMode: env.SUB2API_WS_MODE,
  });
}

export function normalizeSub2ApiSettings(value = {}, defaults = {}) {
  const merged = { ...defaults, ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}) };
  const requestedModels = uniqueStrings(merged.models);
  const legacyGroupName = String(merged.legacyGroupName || merged.legacy_group_name || merged.groupName || '').trim();
  const explicitGroupIds = normalizeSub2ApiGroupIds(merged.groupIds ?? merged.group_ids);
  const legacyGroupIds = normalizeSub2ApiGroupIds(legacyGroupName);
  const groupIds = explicitGroupIds.length ? explicitGroupIds : legacyGroupIds;
  return {
    baseUrl: String(merged.baseUrl || merged.base_url || '').trim().replace(/\/+$/, ''),
    adminApiKey: String(merged.adminApiKey || merged.admin_api_key || '').trim(),
    groupIds,
    legacyGroupName: groupIds.length ? '' : legacyGroupName,
    accountConcurrency: clampNumber(merged.accountConcurrency ?? merged.concurrency, 50, 1, 100, { integer: true }),
    priority: clampNumber(merged.priority, 1, 1, 100, { integer: true }),
    loadFactor: clampNumber(merged.loadFactor ?? merged.load_factor, 1000, 1, 10000, { integer: true }),
    rateMultiplier: clampNumber(merged.rateMultiplier ?? merged.rate_multiplier, 1, 0, 100000),
    fingerprintMode: SUB2API_FINGERPRINT_MODES.includes(String(merged.fingerprintMode || merged.fingerprint_mode || '').trim())
      ? String(merged.fingerprintMode || merged.fingerprint_mode).trim()
      : 'session',
    models: requestedModels.length ? requestedModels : [...SUB2API_DEFAULT_MODELS],
    expiresAt: normalizeExpiresAt(merged.expiresAt ?? merged.expires_at),
    autoPauseOnExpired: normalizeBoolean(merged.autoPauseOnExpired ?? merged.auto_pause_on_expired, true),
    imageBridgeStrategy: SUB2API_IMAGE_BRIDGE_STRATEGIES.includes(String(merged.imageBridgeStrategy || merged.image_bridge_strategy || '').trim())
      ? String(merged.imageBridgeStrategy || merged.image_bridge_strategy).trim()
      : 'inherit',
    wsMode: SUB2API_WS_MODES.includes(String(merged.wsMode || merged.ws_mode || '').trim())
      ? String(merged.wsMode || merged.ws_mode).trim()
      : 'off',
  };
}

function normalizeBoolean(value, fallback) {
  if (value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
  if (value === false || value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
  return fallback;
}

function normalizeExpiresAt(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.trunc(numeric > 10_000_000_000 ? numeric / 1000 : numeric);
}

export function publicSub2ApiSettings(value = {}) {
  const settings = normalizeSub2ApiSettings(value);
  const key = settings.adminApiKey;
  return {
    ...settings,
    adminApiKey: undefined,
    keyConfigured: Boolean(key),
    keyMasked: key ? `${key.slice(0, 3)}***${key.length > 7 ? key.slice(-4) : ''}` : '',
  };
}

export function sub2ApiAccountDefaults(value = {}) {
  const settings = normalizeSub2ApiSettings(value);
  return {
    concurrency: settings.accountConcurrency,
    priority: settings.priority,
    loadFactor: settings.loadFactor,
    rateMultiplier: settings.rateMultiplier,
    fingerprintMode: settings.fingerprintMode,
    models: settings.models,
    expiresAt: settings.expiresAt,
    autoPauseOnExpired: settings.autoPauseOnExpired,
    imageBridgeStrategy: settings.imageBridgeStrategy,
    wsMode: settings.wsMode,
  };
}
