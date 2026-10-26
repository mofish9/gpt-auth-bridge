// Keep CSS/SMIL animation and local SVG references, with no active/network content.
export function evaluationPreviewDocument(source, { paused = false } = {}) {
  const html = source.trim().replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/, '');
  // A template keeps image/network elements inert until their attributes are removed.
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('script,iframe,object,embed,form,input,button,meta,link,base,a,audio,video,source').forEach(node => node.remove());
  for (const element of template.content.querySelectorAll('*')) {
    for (const { name, value } of [...element.attributes]) {
      if (/^on/i.test(name) || ['src', 'srcset', 'action', 'formaction'].includes(name)
        || (['href', 'xlink:href'].includes(name) && !value.trim().startsWith('#'))) element.removeAttribute(name);
    }
  }
  const doc = new DOMParser().parseFromString(template.innerHTML, 'text/html');
  for (const svg of doc.querySelectorAll('svg')) {
    const width = Number(svg.getAttribute('width')), height = Number(svg.getAttribute('height'));
    if (!svg.hasAttribute('viewBox') && width > 0 && height > 0) svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  }
  const style = doc.createElement('style');
  style.textContent = 'html,body{margin:0!important;padding:0!important;width:100%!important;height:100%!important;min-width:0!important;min-height:0!important;overflow:hidden!important}body{display:grid!important;place-items:center!important}body>*{max-width:100%!important;max-height:100%!important;box-sizing:border-box!important}svg{max-width:100%!important;max-height:100vh!important}body>svg{width:100%!important;height:100%!important}';
  doc.body.append(style);
  // Only this fixed, nonce-authorized controller may run. Model scripts were removed.
  // The frame remains an opaque origin (no allow-same-origin).
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const bridge = doc.createElement('script');
  bridge.setAttribute('nonce', nonce);
  bridge.textContent = `(() => {
    const style = document.createElement('style'); document.head.append(style);
    function pause(value) {
      style.textContent = value ? '*,*::before,*::after{animation-play-state:paused!important}' : '';
      for (const animation of document.getAnimations()) value ? animation.pause() : animation.play();
      for (const svg of document.querySelectorAll('svg')) value ? svg.pauseAnimations() : svg.unpauseAnimations();
    }
    window.addEventListener('message', event => {
      if (event.source === parent && event.data?.type === 'evaluation-animation' && typeof event.data.paused === 'boolean') pause(event.data.paused);
    });
    pause(${Boolean(paused)});
  })();`;
  doc.body.append(bridge);
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`;
  return doc.documentElement.outerHTML.replace(/<head[^>]*>/i, `<head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">`);
}
