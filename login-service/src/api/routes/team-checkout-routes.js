import { generateTeamCheckout } from '../../services/team-checkout.js';
import { safeCheckoutDiagnostics } from '../../services/team-checkout-diagnostics.js';

export function registerTeamCheckoutRoutes(app, { generateCheckout = generateTeamCheckout, logger = console } = {}) {
  app.post('/api/v2/team/checkout', async (req, res) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once('close', cancel);
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await generateCheckout(req.body, { signal: controller.signal });
      if (!res.destroyed) res.json({ ok: true, ...result });
    } catch (error) {
      if (res.destroyed) return;
      const known = ['INVALID_TEAM_CHECKOUT', 'INVALID_CHECKOUT_URL', 'CHECKOUT_CANCELLED', 'CHECKOUT_TIMEOUT', 'CHECKOUT_NETWORK_ERROR', 'CHECKOUT_REJECTED'].includes(error.code);
      const diagnostics = safeCheckoutDiagnostics(error.diagnostics);
      if (diagnostics) logger?.warn?.(JSON.stringify({ event: 'team_checkout_failed', code: known ? error.code : 'TEAM_CHECKOUT_FAILED', status: known ? error.status : 500, diagnostics }));
      res.status(known ? error.status : 500).json({ ok: false, code: known ? error.code : 'TEAM_CHECKOUT_FAILED', error: known ? error.message : '生成链接失败，请稍后重试', ...(diagnostics ? { diagnostics } : {}) });
    } finally {
      res.off('close', cancel);
    }
  });
}
