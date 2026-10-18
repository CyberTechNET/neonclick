/* ==========================================================================
 * .release-check.cjs — чёрный ящик по БОЕВОМУ артефакту на БОЕВОМ хостинге.
 *
 * Место в ряду. Три соседних браузерных набора (.vk-mock-check, .stress-check,
 * .visual-check) работают через отладочный хук window.NEON: им нужно тапать без
 * мыши, читать состояние, двигать часы и подменять Math.random. В публикуемой
 * игре хука нет по построению — его вырезает tools/build-release.cjs. Значит,
 * проверить и сам факт вырезания, и всё, что живёт за пределами локального
 * стенда, можно только НЕ пользуясь им. Этот набор устроен именно так: ни одной
 * ссылки на NEON, настоящие события мыши, настоящий LocalStorage, настоящая сеть.
 *
 * Что он закрывает такого, чего не закрывает ни один локальный прогон:
 *   1) реальный HTTPS-хост вместо 127.0.0.1: TLS, редиректы Pages, кеш Fastly и
 *      — главное — относительные пути на ПОДКАТАЛОГЕ вида /neonclick/, где
 *      «/game.js» уже не существует;
 *   2) загрузку SDK VK Bridge без предподставленного мока: единственный способ
 *      убедиться, что вендоренный vk-bridge.<версия>.js доехал, завёл
 *      window.vkBridge и что цепочка НЕ свалилась в CDN-фолбэк;
 *   3) состав хостинга: пять файлов артефакта и ничего больше — ни package.json,
 *      ни наборов проверок, ни .git;
 *   4) что ?debug=1 на боевом URL не даёт ни хука, ни отключения античита, а
 *      ручная правка LocalStorage не доживает до баланса.
 *
 * Запуск:
 *   $env:NEON_BASE = 'https://cybertechnet.github.io/neonclick'; node .release-check.cjs
 * По умолчанию — локальный стенд собранного артефакта, чтобы прогон отлаживался
 * без сети:  python -m http.server 5173 --directory _site
 * ========================================================================== */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const EXE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));

const ORIGIN = (process.env.NEON_BASE || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const URL0 = ORIGIN + '/index.html';
const LOCAL = /^(https?:)?\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/i.test(ORIGIN);
const SAVE_KEY = 'neonclick.save.v1';
const VENDOR = JSON.parse(fs.readFileSync(path.join(__dirname, 'tools', 'vendor.json'), 'utf8'));
const ALLOWED = ['index.html', 'style.css', 'game.js', 'vk-integration.js', VENDOR.file];

/** Что на боевом хостинге обязано ОТСУТСТВОВАТЬ (любой ответ, кроме 200).
 *  assets/moderation/* — материалы заявки в кабинет VK (иконка, скриншоты):
 *  они живут в дереве репозитория и наружу смотреть не должны, сборщик берёт
 *  только allowlist из пяти файлов. Проверяется здесь, по сети, а не по тексту
 *  сборщика: «не уехало» — утверждение про хостинг, а не про регэксп. */
const FOREIGN = ['package.json', 'package-lock.json', 'README.md', '.gitignore',
  '.vscode/settings.json', 'tools/vendor.json', 'tools/build-release.cjs',
  'tools/make-moderation-assets.cjs', 'assets/moderation/icon-512.png',
  'assets/moderation/screen-neon.png',
  '.smoke-test.cjs', '.vk-mock-check.cjs', '.stress-check.cjs', '.visual-check.cjs',
  'base_smoke.txt', 'base_vk.txt', 'node_modules/jsdom/package.json', '_site/index.html', '.git/config'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  ' + a.join(' '));
let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; log('\u2705 ' + name); }
  else { failed++; log('\u274c ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra) : '')); }
};
const digits = (s) => Number(String(s == null ? '' : s).replace(/\D/g, '')) || 0;
const fileOf = (u) => { try { return decodeURIComponent(new URL(u).pathname).split('/').pop(); } catch (_) { return ''; } };
const hostOf = (u) => { try { return new URL(u).host; } catch (_) { return ''; } };
const OURS = hostOf(ORIGIN);

/** Один чистый сеанс: свежая вкладка, собранные запросы, ошибки и варнинги. */
async function session(browser, query) {
  const page = await browser.newPage();
  const reqs = [], resps = [], errs = [], warns = [];
  page.on('request', (r) => reqs.push(r.url()));
  page.on('response', (r) => resps.push({ url: r.url(), status: r.status(), ct: (r.headers()['content-type'] || '') }));
  page.on('pageerror', (e) => errs.push(String((e && e.message) || e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text());
    else if (m.type() === 'warning') warns.push(m.text());
  });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(URL0 + (query || ''), { waitUntil: 'domcontentloaded', timeout: 60000 });
  return { page: page, reqs: reqs, resps: resps, errs: errs, warns: warns };
}

const balance = (page) => page.$eval('#balance', (e) => e.textContent).then(digits);
const waitBoot = (page) => page.waitForFunction(
  () => window.VK && document.getElementById('balance') && document.getElementById('coin'), { timeout: 25000 });

/** Настоящий тап по монете: центр #coin, мышиные события — ровно путь игрока. */
async function tap(page, n) {
  const c = await page.$eval('#coin', (e) => {
    const b = e.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  });
  for (let i = 0; i < (n || 1); i++) { await page.mouse.click(c.x, c.y); await sleep(70); }
}

(async () => {
  if (!EXE) { log('\u274c Chromium/Edge не найден — прогон не выполнен'); process.exit(2); }
  const browser = await puppeteer.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  try {
    /* ==================================================================== */
    log('\n[0] Адрес прогона');
    ok(LOCAL || ORIGIN.startsWith('https://'),
      'размещение годится для VK: HTTPS (или локальный стенд _site для отладки)', ORIGIN);
    if (!process.env.NEON_BASE) {
      log('\u26a0 NEON_BASE не задан — прогон идёт по локальному стенду ' + ORIGIN +
        ', а не по публикации. Для боевой проверки: $env:NEON_BASE = \'<https://…>\'');
    }

    /* ==================================================================== */
    log('\n[1] Загрузка боевого URL и состав сети');
    const s = await session(browser, '');
    await waitBoot(s.page);
    await sleep(1200);

    const main = s.resps.filter((r) => fileOf(r.url) === 'index.html').pop();
    ok(!!main && main.status === 200, 'index.html отдаётся 200', main);
    ok(hostOf(s.page.url()) === OURS, 'согнали с нашего хоста, никуда не перенаправило', s.page.url());

    const sameOrigin = s.reqs.filter((u) => hostOf(u) === OURS);
    const extra = [...new Set(sameOrigin.map(fileOf))].filter((f) => ALLOWED.indexOf(f) < 0);
    ok(extra.length === 0, 'с нашего хоста запрошены только файлы артефакта', extra);
    const non200 = s.resps.filter((r) => hostOf(r.url) === OURS && r.status !== 200);
    ok(non200.length === 0, 'каждый запрос к артефакту — 200 (ни 404, ни 5xx)', non200);
    const cdn = s.reqs.filter((u) => /unpkg\.com|jsdelivr\.net/.test(u));
    ok(cdn.length === 0, 'SDK взят с собственного домена: к CDN никто не ходил', cdn);

    for (const f of ['style.css', 'game.js', 'vk-integration.js']) {
      const hit = s.reqs.find((u) => fileOf(u) === f);
      ok(!!hit && /[?&]v=[0-9a-f]{8}(?:&|$)/.test(hit), f + ' запрошен с cache-bust ?v=<8 hex>', hit);
    }

    /* ==================================================================== */
    log('\n[2] SDK VK Bridge без предподставленного мока');
    const sdk = await s.page.evaluate(() => ({
      bridge: !!window.vkBridge,
      connect: !!window.vkConnect,
      send: typeof (window.vkBridge || {}).send,
      embedded: typeof (window.vkBridge || {}).isEmbedded,
      neon: typeof window.NEON
    }));
    ok(sdk.bridge && sdk.connect,
      'window.vkBridge и window.vkConnect завёл НАСТОЯЩИЙ vk-bridge (оба имени ставит только он)', sdk);
    ok(sdk.send === 'function' && sdk.embedded !== 'undefined', 'мост пригоден к вызовам', sdk);
    const sdkResp = s.resps.filter((r) => fileOf(r.url) === VENDOR.file).pop();
    ok(!!sdkResp && sdkResp.status === 200 && /javascript/.test(sdkResp.ct),
      VENDOR.file + ' приехал как JS, а не как text/html (Pages не отдаёт 404-страничку)', sdkResp);
    const loadWarn = s.warns.filter((t) => /не удалось загрузить vk-bridge/.test(t));
    ok(loadWarn.length === 0, 'варнинг фолбэка не срабатывал: локальный SDK был достаточно хорош', loadWarn);

    const ident = await s.page.evaluate(() => ({
      demo: window.VK.isDemo(), vk: window.VK.isVK(), link: window.VK.shareLink()
    }));
    ok(ident.demo === false, 'DEMO_MODE в опубликованной сборке выключен (награда вне VK не выдаётся)', ident);
    ok(ident.vk === false, 'вне клиента VK приложение себя за VK не выдаёт', ident);
    ok(ident.link === null, 'вне VK ссылка на приложение не выдумывается', ident);

    /* ==================================================================== */
    log('\n[3] Отладочный хук на боевом URL (главное утверждение прогона)');
    ok(sdk.neon === 'undefined', 'window.NEON отсутствует без всяких параметров', sdk.neon);

    const d = await session(browser, '?debug=1');
    await waitBoot(d.page);
    await sleep(900);
    ok(await d.page.evaluate(() => typeof window.NEON) === 'undefined',
      '?debug=1 на боевом URL НЕ создаёт window.NEON — хук вырезан из байтов, а не спрятан за условием');
    const g0 = await balance(d.page);
    await tap(d.page, 2);
    const g1 = await balance(d.page);
    ok(g1 > g0, 'при этом ?debug=1 ничего не ломает: игра играбельна, тап приносит монеты', [g0, g1]);
    ok(d.errs.length === 0, 'с ?debug=1 ошибок страницы нет', d.errs);
    await d.page.close();

    /* ==================================================================== */
    log('\n[4] Игра без хука: монеты за тап и автосейв');
    const b0 = await balance(s.page);
    await tap(s.page, 3);
    const b1 = await balance(s.page);
    ok(b1 > b0, 'три настоящих тапа принесли монеты', [b0, b1]);
    await sleep(1400);                        // такт автосейва: CFG.saveEveryMs = 1000
    const raw = await s.page.evaluate((k) => localStorage.getItem(k), SAVE_KEY);
    ok(!!raw, 'прогресс записан в LocalStorage без явного вызова');
    const sav = raw ? JSON.parse(raw) : {};
    ok(typeof sav.coins === 'number' && typeof sav.sig === 'string' && sav.sig.length > 0,
      'сейв подписан (sig на месте) — ручную правку видно', { coins: sav.coins, sig: sav.sig });

    /* ==================================================================== */
    log('\n[5] Ручная правка LocalStorage на боевом хостинге');
    const forged = JSON.parse(raw || '{}');
    forged.coins = 999999; forged.total = 999999;
    await s.page.evaluate((k, v) => localStorage.setItem(k, v), SAVE_KEY, JSON.stringify(forged));
    await s.page.reload({ waitUntil: 'domcontentloaded' });
    await waitBoot(s.page);
    await sleep(1500);
    const after = await balance(s.page);
    // Порог 10000, а не «ноль»: потолок правдоподобия по построению даёт любому
    // аккаунту запас A.slack + 1000 (game.js), поэтому 999999 обязаны превратиться
    // в тысячи, а не в нули. Точную механику (susp, послойные клампы) закрывает
    // .stress-check.cjs [st=tamper] — там есть доступ к состоянию через хук.
    ok(after < 10000, 'нарисованные 999999 не доживают до HUD (подпись + потолок правдоподобия)',
      { HUD: after, просили: 999999 });

    /* ==================================================================== */
    log('\n[6] Состав хостинга: ровно артефакт и ничего больше');
    const status = async (p) => {
      try { const r = await fetch(ORIGIN + '/' + p, { cache: 'no-store', redirect: 'follow' }); return r.status; }
      catch (e) { return 'ERR: ' + e.message; }
    };
    for (const f of ALLOWED) {
      const st = await status(f);
      ok(st === 200, f + ' — 200', st);
    }
    const leaks = [];
    for (const p of FOREIGN) {
      const st = await status(p);
      if (st === 200) leaks.push(p + ' -> 200');
    }
    ok(leaks.length === 0, 'чужих файлов на хостинге нет (наборы проверок, package.json, .git — недоступны)', leaks);

    /* ==================================================================== */
    log('\n[7] Вёрстка и чистота консоли на реальном хостинге');
    const geo = await s.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    ok(geo.sw <= geo.iw + 1, 'горизонтального скролла на 390px нет', geo);
    ok(s.errs.length === 0, 'ошибок страницы нет', s.errs);
    if (s.warns.length) log('варнинги консоли (справка): ' + JSON.stringify(s.warns.slice(0, 5)));

    /* ==================================================================== */
    log('\n[8] Целостность выкладки: ?v= совпадает с sha256 отданных байтов');
    // Смысл не в красоте имён ресурсов, а в атомарности: index.html и файлы
    // едут с разных краёв Fastly и в разное время. Если отданный index.html
    // новее, чем game.js на крае (или наоборот), ?v разойдётся с фактическим
    // содержимым — и игрок получит смесь двух версий. Здесь это ловится.
    const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const getBuf = async (u) => {
      const r = await fetch(u, { cache: 'no-store' });
      return r.status === 200 ? { status: r.status, buf: Buffer.from(await r.arrayBuffer()) } : { status: r.status };
    };
    const htmlRes = await getBuf(ORIGIN + '/index.html');
    ok(htmlRes.status === 200, 'index.html перечитывается для сверки хэшей', htmlRes.status);
    const html = htmlRes.buf ? htmlRes.buf.toString('utf8') : '';
    const seen = [];
    for (const m of html.matchAll(/(?:src|href)="([^"?]+)\?v=([0-9a-f]{8})"/g)) {
      const name = m[1].split('/').pop();
      const v = m[2];
      const res = await getBuf(ORIGIN + '/' + name + '?v=' + v);
      const actual = res.buf ? sha256(res.buf).slice(0, 8) : 'нет 200';
      seen.push(name + '=' + actual);
      ok(res.status === 200 && actual === v,
        name + ': ?v=' + v + ' совпал со sha256 фактически отданных байтов', { v: v, actual: actual, status: res.status });
    }
    ok(seen.length === 3, 'перечислены все три versionированных ресурса', seen);
  } finally {
    await browser.close();
  }

  console.log('\n  адрес:   ' + ORIGIN);
  console.log('  браузер: ' + EXE);
  console.log('========== БОЕВОЙ АРТЕФАКТ: ' + passed + ' ok / ' + failed + ' fail ==========');
  console.log('');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
