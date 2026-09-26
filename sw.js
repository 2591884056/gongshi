/*
 * 离线缓存：装到手机桌面以后，没网也能打开、能用。
 *
 * 发布时 scripts/build.js 会把 VERSION 换成文件内容的哈希。版本一变，手机下次联网打开时
 * 会在后台下载新版本、删掉旧缓存，再下次打开就是新版本，不用手动清缓存。
 */
const VERSION = '82f9d1b0a6';
const CACHE = 'gongshi-' + VERSION;
// 要缓存的文件；scripts/build.js 也按这份清单拷贝发布文件，只维护这一处
const ASSETS = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/app.css",
  "js/parser.js",
  "js/report.js",
  "js/exporter.js",
  "js/sample.js",
  "js/app.js",
  "vendor/exceljs.min.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png"
];

self.addEventListener('install', (event) => {
  // cache: 'reload' 绕过浏览器的 HTTP 缓存，保证存进来的是这一版的文件
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('gongshi-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 先用缓存，没有再走网络；文件名后面的 ?v= 不影响命中
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) => hit || fetch(req).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))
    )
  );
});
