/* DSH service worker — 只缓存应用外壳，绝不缓存 API 响应或用户数据。
 *
 * 两个必须注意的点：
 * 1. 跨域请求（api.deepseek.com）一律直连，不拦截、不缓存。
 * 2. 静态资源用 stale-while-revalidate：先返回缓存保证秒开，同时后台拉新版本。
 *    否则一旦改了 app.js 而 sw.js 内容没变，浏览器就不会重装 SW，
 *    用户会被 cache-first 永久锁在旧版本上。
 * 改任何应用文件时，请同时把下面的 CACHE 版本号 +1。
 */
const CACHE = 'dsh-shell-v4';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 跨域（API、CDN 等）交给浏览器默认行为，绝不缓存
  if (url.origin !== self.location.origin) return;

  // 同源导航：网络优先，离线回落缓存外壳
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (_) {
        const cache = await caches.open(CACHE);
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // 同源静态资源：立即给缓存，同时后台更新
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });

    const revalidate = fetch(req).then(res => {
      if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);

    if (cached) {
      event.waitUntil(revalidate);
      return cached;
    }
    const fresh = await revalidate;
    return fresh || Response.error();
  })());
});
