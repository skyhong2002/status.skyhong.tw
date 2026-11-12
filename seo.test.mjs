import test from 'node:test';
import assert from 'node:assert/strict';
import { localizeIndex, preferredLanguage, renderRobots, renderSitemap, robotsTag } from './seo.mjs';

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

test('Accept-Language picks English only when it outranks Chinese', () => {
  assert.equal(preferredLanguage(undefined), 'zh-Hant-TW');
  assert.equal(preferredLanguage(''), 'zh-Hant-TW');
  assert.equal(preferredLanguage('en-US,en;q=0.9'), 'en');
  assert.equal(preferredLanguage('zh-TW,zh;q=0.9,en-US;q=0.8'), 'zh-Hant-TW');
  assert.equal(preferredLanguage('en-US;q=0.5,zh-TW;q=0.9'), 'zh-Hant-TW');
  assert.equal(preferredLanguage('fr-FR,en;q=0.7'), 'en');
  assert.equal(preferredLanguage('ja-JP,fr;q=0.8'), 'zh-Hant-TW');
  assert.equal(preferredLanguage('en;q=0,zh;q=0.1'), 'zh-Hant-TW');
});

test('localizeIndex rewrites only the root lang attribute', () => {
  const html = '<!doctype html>\n<html lang="zh-Hant-TW">\n<body></body></html>';
  assert.equal(localizeIndex(html, 'zh-Hant-TW'), html);
  assert.match(localizeIndex(html, 'en'), /<html lang="en">/);
});
