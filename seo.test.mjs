import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRobots, renderSitemap, robotsTag } from './seo.mjs';

const origin = 'https://status.skyhong.tw';

test('only the dashboard is indexable', () => {
  assert.equal(robotsTag('/'), null);
  for (const path of ['/api/status', '/api/history', '/api/incidents', '/api/heartbeat/vps', '/api/agents/vps', '/metrics', '/healthz', '/readyz', '/livez', '/feed.xml', '/badge.svg', '/app.js', '/robots.txt', '/sitemap.xml', '/missing']) {
    assert.equal(robotsTag(path), 'noindex', path);
  }
});

test('robots.txt allows crawling and points at the sitemap', () => {
  assert.equal(renderRobots(origin), 'User-agent: *\nAllow: /\n\nSitemap: https://status.skyhong.tw/sitemap.xml\n');
});

test('sitemap lists only the dashboard', () => {
  const sitemap = renderSitemap(origin);
  assert.match(sitemap, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]), ['https://status.skyhong.tw/']);
});
