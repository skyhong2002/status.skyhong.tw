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
