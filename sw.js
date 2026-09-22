/* DSH service worker 鈥?鍙紦瀛樺簲鐢ㄥ澹筹紝缁濅笉缂撳瓨 API 鍝嶅簲鎴栫敤鎴锋暟鎹€? *
 * 涓や釜蹇呴』娉ㄦ剰鐨勭偣锛? * 1. 璺ㄥ煙璇锋眰锛坅pi.deepseek.com锛変竴寰嬬洿杩烇紝涓嶆嫤鎴€佷笉缂撳瓨銆? * 2. 闈欐€佽祫婧愮敤 stale-while-revalidate锛氬厛杩斿洖缂撳瓨淇濊瘉绉掑紑锛屽悓鏃跺悗鍙版媺鏂扮増鏈€? *    鍚﹀垯涓€鏃︽敼浜?app.js 鑰?sw.js 鍐呭娌″彉锛屾祻瑙堝櫒灏变笉浼氶噸瑁?SW锛? *    鐢ㄦ埛浼氳 cache-first 姘镐箙閿佸湪鏃х増鏈笂銆? * 鏀逛换浣曞簲鐢ㄦ枃浠舵椂锛岃鍚屾椂鎶婁笅闈㈢殑 CACHE 鐗堟湰鍙?+1銆? */
const CACHE = 'dsh-shell-v9';
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

  // 璺ㄥ煙锛圓PI銆丆DN 绛夛級浜ょ粰娴忚鍣ㄩ粯璁よ涓猴紝缁濅笉缂撳瓨
  if (url.origin !== self.location.origin) return;

  // 鍚屾簮瀵艰埅锛氱綉缁滀紭鍏堬紝绂荤嚎鍥炶惤缂撳瓨澶栧３
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

  // 鍚屾簮闈欐€佽祫婧愶細绔嬪嵆缁欑紦瀛橈紝鍚屾椂鍚庡彴鏇存柊
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
