// Only the public dashboard is meant for search. Every other response — the JSON API it renders
// from, metrics, health, the feed and badge, token-authenticated endpoints, 404s — is served with
// `X-Robots-Tag: noindex` rather than blocked in robots.txt, so crawlers can still fetch
// /api/status to render the page and can see the noindex on anything that gets linked.
const INDEXABLE_PATHS = new Set(['/']);

export function robotsTag(pathname) {
  return INDEXABLE_PATHS.has(pathname) ? null : 'noindex';
}

export function renderRobots(origin) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;
}

export function renderSitemap(origin) {
  const urls = [...INDEXABLE_PATHS].map((path) => `  <url><loc>${origin}${path}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

// The dashboard is written in Traditional Chinese; English is kept for visitors whose
// Accept-Language prefers it over Chinese. The page's own toggle (stored in the browser)
// overrides this. Crawlers without the header get the Chinese default.
export const DEFAULT_LANG = 'zh-Hant-TW';

export function preferredLanguage(header) {
  const ranked = String(header || '').split(',').map((part, index) => {
    const [tag, ...params] = part.trim().toLowerCase().split(';');
    const q = Number((params.find((param) => param.trim().startsWith('q=')) || 'q=1').trim().slice(2));
    return { tag, q: Number.isFinite(q) ? q : 0, index };
  }).filter((entry) => entry.tag && entry.q > 0).sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of ranked) {
    if (tag === 'zh' || tag.startsWith('zh-')) return DEFAULT_LANG;
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return DEFAULT_LANG;
}

// Serve the index with the chosen <html lang>; the page script translates from there.
export function localizeIndex(html, lang) {
  return lang === DEFAULT_LANG ? html : html.replace(`<html lang="${DEFAULT_LANG}"`, `<html lang="${lang}"`);
}
