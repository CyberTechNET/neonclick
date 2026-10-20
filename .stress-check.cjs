/* ==========================================================================
 * .stress-check.cjs — продуктовое укрепление NEON CLICK в настоящем Chromium.
 *
 * Проверяет то, что не видно в «зелёных» наборах: поведение под нагрузкой,
 * враждебные правки состояния и облачную синхронизацию прогресса.
 *
 *   st=prod       боевой запуск: отладочного хука window.NEON нет,
 *                 попытка нарисовать монеты из консоли невозможна
 *   st=spam       автокликер: 1500 тапов в один кадр — сколько реально начислено
 *   st=tamper     правка LocalStorage («нарисованные» монеты и coins > total)
 *   st=longrun    долгая сессия на виртуальных часах: 3 игровых часа,
 *                 4000 тапов, 60 сворачиваний; метрики утечек из CDP
 *   st=cloud      облако VK: восстановление с другого устройства, защита от
 *                 откатa, троттлинг записей, битая подпись, размер значения
 *   st=cloudfail  облако VK не отвечает: игра не ломается, награды живут
 *
 * Запуск: node .stress-check.cjs   (нужен поднятый http://127.0.0.1:5173;
 *         другой адрес стенда — через $env:NEON_BASE)
 * ======================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { requireDevStand } = require('./tools/stand-guard.cjs');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];
/* Адрес стенда: см. .vk-mock-check.cjs — переопределяется через NEON_BASE. */
const ORIGIN = (process.env.NEON_BASE || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const BASE = ORIGIN + '/index.html';
const SAVE_KEY = 'neonclick.save.v1';
const CLOUD_KEY = 'neonclick1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  ' + a.join(' '));
let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; log('\u2705 ' + name); }
  else { failed++; log('\u274c ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra) : '')); }
};
const flat = (s) => String(s || '').replace(/[\s\u00a0\u2009\u202f\u200a\u2028\u2029]/g, '');

/**
 * Мок клиента VK: реклама + облачное хранилище (VKWebAppStorage*).
 * Контракт ответа StorageGet берём как в vk-bridge 3.x: { keys: [{key, value}] }.
 * cfg: { storage, storageSetFails, storageGetFails, seedStore, virtualClock, adMs }
 */
const bridgeMock = (cfg) => {
  try { window.localStorage.clear(); } catch (e) {}
  const calls = [];
  const badAd = [];                      // рекламные вызовы с неверными параметрами
  const subs = [];
  const store = window.__store = Object.assign({}, cfg.seedStore || {});
  const sup = function (m) { return cfg.storage || !/^VKWebAppStorage/.test(String(m || '')); };
  const err = function (code) {
    const e = new Error('VKWebAppStorageSetFailed');
    e.error_data = { error_code: code, error_reason: 'mock' };
    return e;
  };
  window.vkBridge = {
    isEmbedded: function () { return true; },
    supports: sup,
    supportsAsync: function (m) { return Promise.resolve(sup(m)); },
    subscribe: function (cb) { subs.push(cb); },
    unsubscribe: function (cb) { const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1); },
    send: function (method, params) {
      calls.push({ method: method, params: params || null, at: Date.now() });
      if (method === 'VKWebAppInit') return Promise.resolve({ type: 'VKWebAppInit' });
      /* ★ КОНТРАКТ РЕКЛАМЫ (vk-bridge 3.x): формат передаётся полем ad_format.
         С чужим именем параметра клиент рекламу не отдаёт — мок ведет себя
         так же, а не отвечает зелёным независимо от вызова. */
      if (method === 'VKWebAppCheckNativeAds' || method === 'VKWebAppShowNativeAds') {
        const adOk = !!(params && params.ad_format === 'reward');
        if (!adOk) badAd.push({ method: method, params: params || null });
        if (method === 'VKWebAppCheckNativeAds') return Promise.resolve({ result: adOk });
        if (!adOk) return Promise.reject(err(3));
        return new Promise(function (r) { setTimeout(function () { r({ type: 'success' }); }, cfg.adMs || 250); });
      }
      if (method === 'VKWebAppStorageGet') {
        if (cfg.storageGetFails) return Promise.reject(err(103));
        const list = (params.keys || []).map(function (k) {
          return { key: k, value: store[k] == null ? '' : String(store[k]) };
        });
        return Promise.resolve({ keys: list });
      }
      if (method === 'VKWebAppStorageSet') {
        if (cfg.storageSetFails) return Promise.reject(err(103));
        store[params.key] = String(params.value);
        calls.push({ method: '__cloudWritten', params: { key: params.key, value: String(params.value) }, at: Date.now() });
        return Promise.resolve({ result: true });
      }
      /* Гильдия = сообщество VK. Мок отвечает по контракту vk-bridge 3.x, а не
         {result:true}: is_member обязан лежать ЧИСЛОМ 0|1, иначе проверка
         «надбавка только участникам» стала бы пустой. */
      if (method === 'VKWebAppGetGroupInfo') {
        return Promise.resolve({
          id: params && params.group_id ? params.group_id : 0,
          name: 'Гильдия «Неон»', screen_name: 'neonguild',
          is_member: cfg.member === false ? 0 : 1,
          photo_200: 'https://sun9-12.userapi.com/impg/a1/b2/guild_200.jpg'
        });
      }
      if (method === 'VKWebAppJoinGroup' || method === 'VKWebAppLeaveGroup') {
        return Promise.resolve({ result: true });
      }
      return Promise.resolve({ result: true });
    }
  };
  window.__vk = { calls: calls, store: store, subs: subs, badAd: badAd };
  window.__emit = function (type, data) { subs.slice().forEach(function (cb) { cb({ detail: { type: type, data: data || {} } }); }); };

  // Виртуальные часы: реальное время + сдвигаемое смещение. Позволяет прогнать
  // часы игровой жизни за секунды, не трогая requestAnimationFrame и таймеры.
  if (cfg.virtualClock) {
    window.__offset = 0;
    const real = Date.now.bind(Date);
    Date.now = function () { return real() + window.__offset; };
  }
};

/** Баланс из HUD (форматирован тонкими пробелами — нормализуем внутри страницы). */
const hudBalance = (page) => page.$eval('#balance', (e) => Number(String(e.textContent).replace(/[\s\u00a0\u2009\u202f\u200a\u2028\u2029]/g, '')) || 0);
const stateOf = (page) => page.evaluate(() => Object.assign({}, window.NEON.state()));
const cloudCalls = (page, name) => page.evaluate((n) => window.__vk.calls.filter((c) => c.method === n).length, name);
const saveRaw = (page) => page.evaluate((k) => localStorage.getItem(k) || '', SAVE_KEY);

(async () => {
  const exe = BROWSERS.find((p) => fs.existsSync(p));
  if (!exe) { console.log('Браузер не найден — набор пропущен'); process.exit(0); }
  /* Префлайт стенда: облачные сценарии проверяются через window.NEON, поэтому
     здесь нужны исходники, а не собранный _site (см. tools/stand-guard.cjs). */
  await requireDevStand(ORIGIN, '.stress-check.cjs').catch((e) => { console.error('\n\u274c ' + e.message + '\n'); process.exit(1); });
  log('браузер:', exe);
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--js-flags=--expose-gc']
  });

  /** Открыть приложение с моком; opts.debug === false → боевой запуск без ?debug=1. */
  async function open(scen, cfg, opts) {
    const o = opts || {};
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const errs = [];
    page.on('pageerror', (e) => errs.push('pageerror: ' + String(e && e.message)));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text());
    });
    await page.evaluateOnNewDocument(bridgeMock, Object.assign({ storage: true }, cfg || {}));
    if (o.beforeApp) await page.evaluateOnNewDocument(o.beforeApp, o.beforeArg);
    const debug = o.debug !== false;
    await page.goto(BASE + '?st=' + scen + (debug ? '&debug=1' : '') + (o.query || ''), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((wantDebug) => !!window.VK && !!document.getElementById('tabShop') && (!wantDebug || !!window.NEON),
      { timeout: 15000 }, debug);
    await page.evaluate(() => window.VK.ready);
    await sleep(350);
    return { page, errs };
  }

  /* ---------------------------------------------------------------------
   * [1] Боевой запуск: отладочный хук недоступен, игра живая
   * ------------------------------------------------------------------- */
  log('\n[1] st=prod — без ?debug=1 нарисовать монеты из консоли нельзя');
  {
    const s = await open('prod', { storage: false }, { debug: false });
    const t = await s.page.evaluate(() => ({
      neon: typeof window.NEON, vk: typeof window.VK, hud: !!document.getElementById('balance')
    }));
    ok(t.neon === 'undefined', 'window.NEON не существует в боевом запуске', t);
    ok(t.vk === 'object' && t.hud, 'при этом игра полностью рабочая (VK + HUD на месте)', t);
    const dotProd = await s.page.$eval('#cloudDot', (e) => ({ hidden: e.hidden, cls: e.className }));
    ok(dotProd.hidden === true, 'без доступного облака VK индикатор синхронизации не показывается (шума нет)', dotProd);

    const attempt = await s.page.evaluate(() => {
      try { window.eval('window.NEON.add(1000000)'); return { threw: false }; }
      catch (e) { return { threw: true, name: e.name }; }
    });
    ok(attempt.threw === true, 'попытка NEON.add(1000000) из консоли терпит неудачу', attempt);

    const b0 = await hudBalance(s.page);
    const box = await (await s.page.$('#coin')).boundingBox();
    await s.page.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
    await sleep(300);
    const b1 = await hudBalance(s.page);
    ok(b1 > b0, 'обычный тап по монете монеты приносит', [b0, b1]);
    ok(s.errs.length === 0, 'ошибок страницы нет', s.errs);
    await s.page.close();
  }

  /* ---------------------------------------------------------------------
   * [2] Автокликер: 1500 тапов в один кадр
   * ------------------------------------------------------------------- */
  log('\n[2] st=spam — 1500 тапов подряд в одном кадре (автокликер)');
  {
    const s = await open('spam', { storage: false });
    const res = await s.page.evaluate(() => {
      const coin = document.getElementById('coin');
      const before = window.NEON.state().coins;
      const t0 = performance.now();
      for (let i = 0; i < 1500; i++) {
        coin.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, clientX: 120, clientY: 240,
          pointerType: 'touch', isPrimary: true, button: 0
        }));
      }
      const st = window.NEON.state();
      return {
        ms: Math.round(performance.now() - t0),
        gained: Math.floor(st.coins - before),
        clicks: st.clicks,
        susp: st.susp,
        floats: document.getElementById('floats').childElementCount,
        maxFloats: window.NEON.cfg.maxFloats
      };
    });
    log('спам:', JSON.stringify(res));
    ok(res.clicks <= 30, 'засчитано не больше ~25 кликов в секунду, а не 1500', res.clicks);
    ok(res.susp >= 1400, 'все перехваченные тапы учтены в счётчике нарушений', res.susp);
    ok(res.gained <= res.clicks * 8, 'монеты выросли только на узаконенные клики (не 1500 × сила)', [res.gained, res.clicks]);
    ok(res.floats <= res.maxFloats, 'слой всплывающих «+N» не разросся под нагрузкой', [res.floats, res.maxFloats]);
    ok(res.ms < 8000, 'интерфейс пережил спам без зависания (' + res.ms + ' мс на 1500 тапов)', res.ms);

    await sleep(1200);
    const c1 = (await stateOf(s.page)).clicks;
    await s.page.evaluate(() => document.getElementById('coin').dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: 120, clientY: 240, pointerType: 'touch', isPrimary: true
    })));
    const c2 = (await stateOf(s.page)).clicks;
    ok(c2 === c1 + 1, 'после остывания окна обычные тапы снова засчитываются — ложных блокировок нет', [c1, c2]);

    const alive = await s.page.evaluate(() => ({
      shop: !document.getElementById('tabShop').hidden,
      adBtns: [document.getElementById('btnCoins'), document.getElementById('btnDouble')].every((b) => !b.disabled)
    }));
    ok(alive.shop && alive.adBtns, 'кнопки магазина и наград остались рабочими после спама', alive);
    ok(s.errs.length === 0, 'ошибок страницы нет', s.errs);
    await s.page.close();
  }

  /* ---------------------------------------------------------------------
   * [3] Правка LocalStorage вручную (враждебный игрок без отладочного хука)
   * ------------------------------------------------------------------- */
  log('\n[3] st=tamper — сейв переписан руками в LocalStorage');
  const forge = (mode) => {
    const now = Date.now();
    const d = {
      v: 1, coins: 1e12, total: 1e12, clicks: 3, upClick: 1, upAuto: 1,
      boostUntil: 0, watched: 0, sound: true, t0: now - 1000, susp: 0,
      sig: 'deadbeef', lastSeen: now
    };
    if (mode === 'gt') { d.coins = 999999; d.total = 10; }
    localStorage.setItem('neonclick.save.v1', JSON.stringify(d));
  };
  {
    let s = await open('tamper', { storage: false }, { debug: false, beforeApp: forge, beforeArg: 'cap' });
    const bal = await hudBalance(s.page);
    log('боевой запуск с надутым сейвом → HUD:', bal);
    ok(bal > 0 && bal < 5000, '«нарисованные» 1e12 монет обрезаны потолком правдоподобия', bal);
    await sleep(1300);                        // автосейв перезапишет сейв уже чистыми значениями
    const saved = JSON.parse(await saveRaw(s.page) || '{}');
    ok((saved.susp || 0) >= 1, 'факт правки попал в счётчик нарушений susp', saved.susp);
    ok(saved.coins <= saved.total, 'инвариант coins <= total восстановлен', [saved.coins, saved.total]);
    ok(saved.total < 5000, 'в LocalStorage легли обрезанные значения', saved.total);
    ok(!!saved.sig && saved.sig !== 'deadbeef', 'сейв переписан уже валидной подписью', saved.sig);
    ok(s.errs.length === 0, 'ошибок страницы нет', s.errs);
    await s.page.close();

    s = await open('tamper2', { storage: false }, { debug: false, beforeApp: forge, beforeArg: 'gt' });
    const bal2 = await hudBalance(s.page);
    // 999999 → не больше total(10); плюс небольшой долив пассивного дохода за
    // время между загрузкой и снятием показаний (upAuto=1 → 5 монет/сек).
    ok(bal2 <= 20, 'сейв с coins > total сведён к инварианту: баланс не больше заработанного', bal2);
    await s.page.close();

    // Тот же надутый сейв в отладке: потолок намеренно не работает — на нём
    // стоят все наборы, которые рисуют монеты через NEON.add().
    s = await open('tamper3', { storage: false }, { beforeApp: forge, beforeArg: 'cap' });
    const dbgState = await s.page.evaluate(() => Math.floor(window.NEON.state().coins));
    ok(dbgState >= 1e12, 'в режиме ?debug=1 потолок правдоподобия не применяется (осознанно)', dbgState);
    await s.page.close();
  }

  /* ---------------------------------------------------------------------
   * [3б] Потолок правдоподобия ОБЯЗАН учитывать награды за репост
   * ------------------------------------------------------------------- */
  log('\n[3б] st=sharecap — легальные монеты за репост не срезаются античитом');
  {
    /**
     * Сейв игрока, который за первую минуту жизни аккаунта сделал 3 репоста
     * (1500 монет). Без shareMax в потолке правдоподобия его баланс был бы
     * срезан примерно до 1150 — то есть античит молча отнял бы у самого
     * активного игрока честно заработанное.
     */
    const shareSeed = (mode) => {
      const now = Date.now();
      const day = Math.floor(now / 86400000);
      const withShares = mode === 'with';
      localStorage.setItem('neonclick.save.v1', JSON.stringify({
        v: 2, coins: 1600, total: 1600, clicks: 10, upClick: 1, upAuto: 0, boostUntil: 0,
        watched: 0, sound: true, t0: now - 60000, susp: 0, sig: '', lastSeen: now,
        shares: withShares ? 3 : 0, shareDay: day, shareN: withShares ? 3 : 0
      }));
    };
    let s = await open('sharecap', { storage: false }, { debug: false, beforeApp: shareSeed, beforeArg: 'with' });
    const balWith = await hudBalance(s.page);
    ok(balWith >= 1600, 'монеты за 3 легальных репоста пережили санитайзер (shares учтён в потолке)', balWith);
    await s.page.close();

    /* Контроль: тот же сейв БЕЗ учтённых репостов обязан быть срезан — иначе
       проверка выше зелёная лишь потому, что потолок вообще не работает. */
    s = await open('sharecap2', { storage: false }, { debug: false, beforeApp: shareSeed, beforeArg: 'without' });
    const balWithout = await hudBalance(s.page);
    ok(balWithout > 0 && balWithout < 1600, 'контроль: без shares тот же баланс потолок срезает', balWithout);
    await s.page.close();
  }

  /* ---------------------------------------------------------------------
   * [4] Долгая сессия: виртуальные часы, 4000 тапов, 60 уходов в фон
   * ------------------------------------------------------------------- */
  log('\n[4] st=longrun — 3 игровых часа, 4000 тапов, 60 сворачиваний');

  /**
   * Сейв «как будто игроку неделя»: авто-майнинг есть, последний визит час назад.
   * Заодно шпионим за тостом офлайн-дохода — за 60 сворачиваний он обязан
   * появиться ровно один раз (иначе игрок накручивает фон бесконечно).
   */
  const longrunSeed = () => {
    window.__offlineSeen = 0;
    // Считаем РЕАЛЬНЫЕ аллокации: пул всплывающих «+N» обязан удержать их
    // порядка CFG.maxFloats, а не по span'у на каждый тап.
    window.__created = 0;
    const origCreate = document.createElement.bind(document);
    document.createElement = function (tag) {
      if (String(tag).toLowerCase() === 'span') window.__created++;
      return origCreate(tag);
    };
    setInterval(function () {
      const list = document.querySelectorAll('#toasts .toast');
      for (let i = 0; i < list.length; i++) {
        if (/Пока тебя не было/.test(list[i].textContent) && !list[i].__counted) {
          list[i].__counted = 1; window.__offlineSeen++;
        }
      }
    }, 40);
    const now = Date.now();
    localStorage.setItem('neonclick.save.v1', JSON.stringify({
      v: 1, coins: 500, total: 500, clicks: 100, upClick: 2, upAuto: 3, boostUntil: 0,
      watched: 0, sound: false, t0: now - 7 * 86400000, susp: 0, sig: '', lastSeen: now - 3600000
    }));
  };
  {
    const s = await open('longrun', { storage: false, virtualClock: true }, { beforeApp: longrunSeed });
    const client = await s.page.target().createCDPSession();
    await client.send('Performance.enable');
    const metric = async (name) => {
      const r = await client.send('Performance.getMetrics');
      const found = r.metrics.filter((m) => m.name === name)[0];
      return found ? found.value : 0;
    };
    const snap = async () => {
      await s.page.evaluate(() => { if (window.gc) { window.gc(); window.gc(); } });
      await sleep(120);
      return {
        live: await s.page.evaluate(() => document.querySelectorAll('*').length),
        floats: await s.page.$eval('#floats', (e) => e.childElementCount),
        anims: await s.page.evaluate(() => (document.getAnimations ? document.getAnimations().length : 0)),
        created: await s.page.evaluate(() => window.__created),
        listeners: await metric('JSEventListeners'),
        heapMb: Math.round(await metric('JSHeapUsedSize') / 1048576)
      };
    };
    const base = await snap();
    await sleep(800);   // тост офлайн-дохода показывается с задержкой 500 мс
    const offlineAtBoot = await s.page.evaluate(() => window.__offlineSeen);
    ok(offlineAtBoot === 1, 'офлайн-доход за час отсутствия начислен при старте', offlineAtBoot);

    for (let cycle = 0; cycle < 60; cycle++) {
      await s.page.evaluate(() => { window.__offset += 3 * 60 * 1000; });          // +3 минуты игрового времени
      await s.page.evaluate(() => window.__emit('VKWebAppViewHide', {}));          // уход в фон VK → flush
      await sleep(12);
      await s.page.evaluate(() => {
        window.__emit('VKWebAppViewShow', {});
        const coin = document.getElementById('coin');
        for (let k = 0; k < 50; k++) {
          coin.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, clientX: 120, clientY: 240, pointerType: 'touch', isPrimary: true
          }));
        }
        const buy = document.getElementById('buyAuto');
        if (!buy.disabled) buy.click();                                            // экономика работает всю сессию
      });
    }
    await s.page.evaluate(() => {
      const coin = document.getElementById('coin');
      for (let k = 0; k < 1000; k++) {
        coin.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, clientX: 120, clientY: 240, pointerType: 'touch', isPrimary: true
        }));
      }
    });
    await sleep(700);

    const st = await stateOf(s.page);
    const virtualHours = await s.page.evaluate(() => window.__offset / 3600000);
    const offlineSeen = await s.page.evaluate(() => window.__offlineSeen);
    const after = await snap();
    const raw = await saveRaw(s.page);
    const packed = await s.page.evaluate(() => window.NEON.pack());
    log('игровых часов:', virtualHours, '| засчитано тапов:', st.clicks, '| нарушений:', st.susp);
    log('уровни:', JSON.stringify({ upAuto: st.upAuto, upClick: st.upClick }), '| баланс:', Math.floor(st.coins));
    log('метрики:', JSON.stringify(base), '→', JSON.stringify(after));

    ok(virtualHours === 3, 'прогнано ровно 3 игровых часа', virtualHours);
    ok(Number.isFinite(st.coins) && Number.isFinite(st.total), 'баланс не стал NaN/Infinity за долгую сессию', [st.coins, st.total]);
    ok(st.coins <= st.total, 'инвариант coins <= total держался всю сессию', [st.coins, st.total]);
    ok(st.upAuto > 3, 'покупки апгрейдов прошли за долгую сессию (экономика живая)', st.upAuto);
    ok(offlineSeen === 1, 'офлайн-доход начислен ровно один раз за 60 сворачиваний', offlineSeen);
    // Прошли 3 ИГРОВЫХ часа, но засчитываться может только ~25 кликов в
    // РЕАЛЬНУЮ секунду: сдвиг системного времени больше не обнуляет окно.
    ok(st.clicks <= 200, 'сдвиг системного времени не обходит лимитер кликов (засчитано ' + st.clicks + ' из 4000)', st.clicks);
    ok(raw.length < 4096, 'сейв в LocalStorage в пределах лимита значения VK: ' + raw.length + ' символов', raw.length);
    ok(packed.length < 4096, 'облачный пакет влезает в лимит VK (4096): ' + packed.length + ' символов', packed.length);
    /* ВАЖНО: метрику CDP «Nodes» здесь НЕ используем — при подключённом инспекторе
       она кумулятивная (счётчик созданных узлов, как LayoutCount): 4000 тапов дают
       ~7900 и с пулом, и без него, то есть сигнала нет. Живой DOM считаем в странице. */
    ok(after.listeners - base.listeners <= 8, 'слушатели событий не накапливаются', [base.listeners, after.listeners]);
    ok(after.live - base.live <= 40, 'живой DOM не растёт за долгую сессию', [base.live, after.live]);
    ok(after.floats <= 22, 'слой всплывающих «+N» ограничен сверху', after.floats);
    ok(after.anims <= 60, 'CSS-анимации не накапливаются на снятых узлах', [base.anims, after.anims]);
    ok(after.created - base.created <= 100, 'узлы «+N» переиспользуются из пула, а не по span\'у на каждый тап', [base.created, after.created]);
    ok(after.heapMb - base.heapMb <= 40, 'куча не разрослась', [base.heapMb, after.heapMb]);
    ok(s.errs.length === 0, 'ошибок страницы нет', s.errs);
    await s.page.close();
  }

  /* ---------------------------------------------------------------------
   * [5] Облако VK: восстановление, защита от отката, троттлинг, подмена
   * ------------------------------------------------------------------- */
  log('\n[5] st=cloud — VKWebAppStorage: прогресс переезжает за игроком');
  const toastAll = (pg) => pg.$eval('#toasts', (e) => e.textContent);
  const toastHas = async (pg, needle) => flat(await toastAll(pg)).indexOf(flat(needle)) > -1;

  // 5.1 — устройство A играет и отправляет прогресс в облако
  let devA;
  {
    const a = await open('cloud-a', {});
    devA = await a.page.evaluate(() => {
      window.NEON.add(2500);
      const coin = document.getElementById('coin');
      for (let i = 0; i < 8; i++) {
        coin.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 120, clientY: 240, pointerType: 'touch', isPrimary: true }));
      }
      window.NEON.save();
      const st = window.NEON.state();
      return { pack: window.NEON.pack(), coins: Math.floor(st.coins), total: Math.floor(st.total), clicks: st.clicks, watched: st.watched };
    });
    await sleep(1400);   // такт автосохранения толкает облако (первая запись не троттлится)
    const writtenA = await a.page.evaluate((k) => window.__store[k] || '', CLOUD_KEY);
    log('пакет устройства A (' + devA.pack.length + ' символов):', devA.pack);
    ok(devA.pack.length < 4096, 'облачный пакет влезает в лимит VK: ' + devA.pack.length + ' символов', devA.pack.length);
    ok(devA.pack.length <= 200, 'пакет компактный, а не раздутый до лимита', devA.pack.length);
    ok(writtenA.length > 0, 'устройство A отправило прогресс в облако VK', writtenA.length);
    ok((await cloudCalls(a.page, 'VKWebAppStorageGet')) === 1, 'чтение облака при старте было ровно одним');
    await a.page.close();
  }

  // 5.2 — новый телефон подтягивает прогресс из облака
  {
    const b = await open('cloud-b', { seedStore: { neonclick1: devA.pack } });
    const stB = await stateOf(b.page);
    const dotB = await b.page.$eval('#cloudDot', (e) => ({ hidden: e.hidden, cls: e.className, title: e.title }));
    log('после восстановления:', JSON.stringify({ coins: Math.floor(stB.coins), total: Math.floor(stB.total), clicks: stB.clicks }));
    ok(Math.floor(stB.coins) === devA.coins, 'новый телефон подтянул баланс из облака VK', [Math.floor(stB.coins), devA.coins]);
    ok(stB.total === devA.total && stB.clicks === devA.clicks, 'остальные счётчики переехали вместе с прогрессом', [stB.total, devA.total]);
    ok(await toastHas(b.page, 'восстановленизоблакаVK'), 'игрок увидел, что прогресс восстановлен из облака', await toastAll(b.page));
    ok(dotB.hidden === false && /cloud-dot--sync/.test(dotB.cls), 'индикатор облака в шапке показывает синхронизацию', dotB);
    ok(b.errs.length === 0, 'ошибок страницы нет', b.errs);
    await b.page.close();
  }

  // 5.3 — устаревшее облако не должно откатить свежий локальный прогресс
  {
    const p = await open('cloud-old', { storage: false });
    const oldPack = await p.page.evaluate(() => {
      const st = window.NEON.state();
      st.coins = 10; st.total = 20; st.clicks = 1; st.watched = 0;
      st.upAuto = 0; st.upClick = 0;
      st.lastSeen = Date.now() - 3600000; st.t0 = st.lastSeen - 1000;
      return window.NEON.pack();          // валидная подпись, но прогресс «час назад»
    });
    await p.page.close();

    const seedLocal = () => {
      const now = Date.now();
      localStorage.setItem('neonclick.save.v1', JSON.stringify({
        v: 1, coins: 8000, total: 9000, clicks: 500, upClick: 4, upAuto: 6, boostUntil: 0,
        watched: 9, sound: false, t0: now - 7 * 86400000, susp: 0, sig: '', lastSeen: now
      }));
    };
    const c = await open('cloud-c', { seedStore: { neonclick1: oldPack } }, { beforeApp: seedLocal });
    const stC = await stateOf(c.page);
    ok(stC.total >= 9000 && stC.total < 9300 && stC.clicks === 500 && stC.watched === 9,
      'устаревшее облако не откатило монотонные счётчики (заработано/клики/просмотры)', [stC.total, stC.clicks, stC.watched]);
    ok(Math.floor(stC.coins) >= 8000, 'баланс остался локальный: облако старше', Math.floor(stC.coins));
    await sleep(1400);
    const writtenC = await c.page.evaluate((k) => window.__store[k] || '', CLOUD_KEY);
    ok(writtenC !== oldPack, 'свежий локальный прогресс отправлен поверх устаревшего облака', writtenC.slice(0, 28));
    await c.page.close();
  }

  // 5.4 — троттлинг: частые сейвы не сжигают лимит VK (1000 вызовов в час)
  {
    const d = await open('cloud-d', { seedStore: { neonclick1: devA.pack } });
    await sleep(1400);
    const before = await cloudCalls(d.page, 'VKWebAppStorageSet');
    await d.page.evaluate(() => {
      for (let i = 0; i < 25; i++) { window.NEON.add(10); window.NEON.save(); }
    });
    await sleep(1300);
    const afterSets = await cloudCalls(d.page, 'VKWebAppStorageSet');
    const budget = await d.page.evaluate(() => window.NEON.cloud());
    ok(afterSets - before <= 1, '25 быстрых сейвов → не больше одной записи в облако', [before, afterSets]);
    ok(budget.calls <= 700, 'собственный бюджет обращений к хранилищу соблюдён', budget);
    ok(d.errs.length === 0, 'ошибок страницы нет', d.errs);
    await d.page.close();
  }

  // 5.5 — подмена облачного значения: цифры изменены, подпись осталась старой
  {
    // Версию схемы берём ИЗ САМОГО пакета, а не зашиваем литералом: иначе это
    // проверка упадёт на следующем bump-е схемы (она уже падала на ^1|).
    const ver = String(devA.pack).split('|')[0];
    const broken = devA.pack.replace(new RegExp('^' + ver + '\\|'), ver + '|999999999|');
    ok(/^\d+\|999999999\|/.test(broken), 'подложка действительно отличается от оригинального пакета', broken.slice(0, 24));
    const e = await open('cloud-e', { seedStore: { neonclick1: broken } });
    const stE = await stateOf(e.page);
    const dotE = await e.page.$eval('#cloudDot', (n) => n.className);
    ok(Math.floor(stE.coins) === 0, 'подменённое облачное значение не принято: подпись не сошлась', Math.floor(stE.coins));
    ok(await toastHas(e.page, 'Облачныйсейвповреждён'), 'игрок честно предупреждён о повреждённом облачном сейве', await toastAll(e.page));
    ok(/cloud-dot--err/.test(dotE), 'индикатор облака перешёл в состояние ошибки', dotE);
    ok(e.errs.length === 0, 'ошибок страницы нет', e.errs);
    await e.page.close();
  }

  /* ---------------------------------------------------------------------
   * [6] Облако VK не отвечает: игра не ломается, награды живут
   * ------------------------------------------------------------------- */
  log('\n[6] st=cloudfail — VKWebAppStorage не отвечает (error_code 103)');
  {
    const f = await open('cloudfail', { storageSetFails: true, storageGetFails: true });
    const cf = await f.page.evaluate(() => ({
      inVK: window.VK.isVK(),
      cloud: window.NEON.cloud(),
      dot: document.getElementById('cloudDot').className,
      gets: window.__vk.calls.filter((c) => c.method === 'VKWebAppStorageGet').length
    }));
    log('состояние облака:', JSON.stringify(cf));
    ok(cf.inVK === true, 'приложение по-прежнему считает себя внутри VK', cf.inVK);
    ok(cf.gets === 1, 'упавшее чтение не превратилось в цикл ретраев', cf.gets);
    ok(/cloud-dot--(err|wait)/.test(cf.dot), 'точка облака в шапке показала проблему с синхронизацией', cf.dot);

    await f.page.click('.tab[data-tab="bonus"]');   // кнопки наград живут на табу «Бонусы»
    await sleep(200);
    await f.page.click('#btnCoins');
    await sleep(1000);
    const coinsAfter = Math.floor((await stateOf(f.page)).coins);
    ok(coinsAfter === 1000, 'награда за просмотр выдана, хотя облако не отвечает', coinsAfter);
    ok(await f.page.evaluate(() => window.__vk.badAd.length) === 0, 'реклама запрошена по контракту (ad_format, а не format)', await f.page.evaluate(() => window.__vk.badAd));

    await sleep(1300);
    const raw = JSON.parse(await saveRaw(f.page) || '{}');
    ok(Math.floor(raw.coins || 0) === 1000, 'прогресс сохранён локально, несмотря на недоступное облако', raw.coins);
    ok(f.errs.length === 0, 'ошибок страницы и необработанных отказов нет', f.errs);
    await f.page.close();
  }

  /* ---------------------------------------------------------------------
   * [7] ГИЛЬДИИ И НЕДЕЛЬНЫЙ РЕЙД на виртуальных часах
   *
   * Смысл набора — события масштаба недель, которых невозможно дождаться в
   * живом прогоне: окно `__offset` перескакивает через воскресенье, а тик сам
   * закрывает рейд. Дальше — повторный расчёт 300 раз подряд и переезд чести
   * между двумя устройствами через настоящее VKWebAppStorage.
   * ------------------------------------------------------------------- */
  log('\n[7] st=guild — недельный рейд: перекаты, идемпотентность, переезд чести');
  {
    const GQ = '&vk_group_id=176312891&vk_viewer_group_role=member';
    const WEEK_MS = 7 * 86400000;
    // Бут «устройства»: и часы, и локальный сейв ОДНИМ beforeApp — open() умеет
    // регистрировать только один скрипт до приложения. Ключ передаётся аргументом:
    // функция сериализуется в страницу, где констат Node-сcope недоступны.
    const bootDevice = (arg) => {
      window.__offset = arg.offset;
      if (arg.local) { try { localStorage.setItem(arg.k, arg.local); } catch (e) {} }
    };

    // 7.1 — Четыре календарные недели за секунды, участник подтверждён VK.
    const a = await open('guild', { virtualClock: true }, { query: GQ });
    await a.page.waitForFunction(() => window.NEON.guild().probed && !window.NEON.guild().busy, { timeout: 9000 });
    const gi = await a.page.evaluate(() => window.NEON.guild());
    ok(gi.gid === 176312891 && gi.state === 1,
      '7.1 сообщество из launch-параметров стало гильдией, участие подтвердил VK', gi);
    const per = await a.page.evaluate(() => window.NEON.cfg.raid.honorPer);
    const mult = await a.page.evaluate(() => window.NEON.cfg.raid.guildMult);
    const hist = [];
    for (let w = 0; w < 4; w++) {
      await a.page.evaluate((n) => { window.NEON.add(n); }, per * (w + 2));
      const earned = await a.page.evaluate(() => window.NEON.raid().earned);
      await a.page.evaluate((off) => { window.__offset += off; }, WEEK_MS);
      await sleep(420);                                   // тик обязан сам закрыть неделю
      const st = await stateOf(a.page);
      hist.push({
        earned: earned, honor: Math.floor(st.rdHonor), life: Math.floor(st.rdLife),
        best: Math.floor(st.rdBest), tries: st.rdTries, week: st.rdWeek,
        journal: Math.floor(st.rdEarned), susp: st.susp
      });
    }
    ok(hist[3].tries === 4, '7.1 четыре переката недели → ровно четыре закрытых недели', hist.map((h) => h.tries));
    ok(hist.every((h) => h.journal === 0),
      '7.1 журнал недели обнуляется при каждом перекате, а не копится между ними', hist.map((h) => h.journal));
    ok(hist.every((h, i) => i === 0 || h.week > hist[i - 1].week),
      '7.1 указатель недели монотонен', hist.map((h) => h.week));
    const want = hist.map((h) => Math.floor(Math.floor(h.earned / per) * mult));
    let acc = 0, peak = 0, okDelta = true;
    hist.forEach((h, i) => {
      acc += want[i];
      peak = Math.max(peak, want[i]);
      if (h.honor !== acc || h.life !== acc || h.best !== peak) okDelta = false;
    });
    ok(okDelta,
      '7.1 надбавка ×' + mult + ' применена ровно к закрытым неделям: остаток = пожизненный = сумма, лучшее = максимум',
      [hist.map((h) => [h.earned, h.honor, h.life, h.best]), want]);
    ok(hist.every((h) => h.susp === 0),
      '7.1 честный перекат недель не поднял клеймо чита', hist.map((h) => h.susp));
    ok(await a.page.$eval('#raidTries', (e) => e.textContent.replace(/\s/g, '')) === '4',
      '7.1 счётчик недель на вкладке показывает 4', await a.page.$eval('#raidTries', (e) => e.textContent));

    // 7.2 — Идемпотентность: 300 расчётов подряд не дают ни одного повторного.
    const rep = await a.page.evaluate(() => {
      const b0 = window.NEON.state();
      const before = { honor: Math.floor(b0.rdHonor), life: Math.floor(b0.rdLife), tries: b0.rdTries };
      let nonNull = 0;
      for (let i = 0; i < 300; i++) { if (window.NEON.settleRaid()) nonNull++; }
      const s = window.NEON.state();
      return { nonNull: nonNull, before: before, after: { honor: Math.floor(s.rdHonor), life: Math.floor(s.rdLife), tries: s.rdTries } };
    });
    ok(rep.nonNull === 0 && rep.before.honor === rep.after.honor
      && rep.before.life === rep.after.life && rep.before.tries === rep.after.tries,
      '7.2 300 повторных расчётов той же недели: ни одной выплаты, ни одного счётчика', rep);
    const packA = await a.page.evaluate(() => { window.NEON.save(); return window.NEON.pack(); });
    const rawA = await saveRaw(a.page);
    ok(a.errs.length === 0, '7.1–7.2 ошибок страницы нет', a.errs);
    await a.page.close();

    // 7.3 — Честь переезжает за игроком через настоящее VKWebAppStorage.
    //
    //   ШКАЛА ВИРТУАЛЬНЫХ ЧАСОВ (иначе сам харнесс породил бы клеймо чита):
    //   A заканчивает на real+4 недели. B стартует С ТОГО ЖЕ МГНОВЕНИЯ, что и
    //   конец A, иначе его lastSeen выглядел бы «сейвом из будущего» (sanitize
    //   режет его и поднимает susp — причина, к гильдии не имеющая). B уходит на
    //   +1 час и перекатывает неделю, заканчивая на real+5 недель+1 час. C и D
    //   стартуют ровно на real+5 недель+1 час: тогда (а) ни один из двух пакетов
    //   не выглядит будущим, (б) ни одна из недель не перекатывается лишний раз,
    //   (в) победитель слияния получается РАЗНЫМ в 7.4 и 7.5 — иначе второй
    //   прогон проверял бы ту же ветку кода и был бы декоративным.
    const BASE_B = 4 * WEEK_MS;             // где закончил A
    const NOW_CD = 5 * WEEK_MS + 3600000;   // где закончил B
    const b = await open('guild-b', { virtualClock: true, seedStore: { [CLOUD_KEY]: packA } },
      { query: GQ, beforeApp: bootDevice, beforeArg: { offset: BASE_B } });
    const stB0 = await stateOf(b.page);
    ok(Math.floor(stB0.rdHonor) === hist[3].honor && stB0.gid === 176312891 && stB0.gState === 1,
      '7.3 новое устройство подтянуло честь, гильдию и статус участника из облака VK',
      [Math.floor(stB0.rdHonor), hist[3].honor, stB0.gid, stB0.gState]);
    ok(stB0.susp === 0, '7.3 переезд прогресса из облака не выглядел как нарушение', stB0.susp);
    await b.page.evaluate((n, base) => { window.__offset = base + 3600000; window.NEON.add(n * 3); },
      per, BASE_B);
    await b.page.evaluate((off) => { window.__offset += off; }, WEEK_MS);
    await sleep(420);
    await b.page.evaluate(() => { window.NEON.save(); });
    await sleep(1400);
    const stB = await stateOf(b.page);
    const packB = await b.page.evaluate(() => window.NEON.pack());
    const rawB = await saveRaw(b.page);
    ok(Math.floor(stB.rdHonor) > hist[3].honor,
      '7.3 на втором устройстве накоплена своя, бо́льшая честь', [Math.floor(stB.rdHonor), hist[3].honor]);
    // Сравнение «байт в байт» здесь хрупко: за время sleep автосейв успевает
    // сдвинуть lastSeen, и пакет отличается одной служебной меткой времени.
    // Значимо другое — что в облако уехали ИМЕННО новые честь, недели и гильдия,
    // поэтому разбираем записанный пакет и сверяем поля.
    const wpB = await b.page.evaluate((k) => {
      const raw = window.__store[k] || '';
      const st = window.NEON.unpack(raw);
      return { len: raw.length, ok: !!st, honor: st ? Math.floor(st.rdHonor) : -1, tries: st ? st.rdTries : -1, gid: st ? st.gid : -1 };
    }, CLOUD_KEY);
    ok(wpB.ok && wpB.honor === Math.floor(stB.rdHonor) && wpB.tries === stB.rdTries && wpB.gid === 176312891,
      '7.3 обновлённая честь, счётчик недель и гильдия уехали в облако VK',
      [wpB, Math.floor(stB.rdHonor), stB.rdTries]);
    ok(wpB.len > 0 && wpB.len < 4096, '7.3 пакет с полями v4 влезает в лимит VK', wpB.len);
    ok(b.errs.length === 0, '7.3 ошибок страницы нет', b.errs);
    await b.page.close();

    // 7.4 — Встреча устройств, вариант 1: облако СТАРШЕ локального прогресса.
    const c = await open('guild-c', { virtualClock: true, seedStore: { [CLOUD_KEY]: packA } },
      { beforeApp: bootDevice, beforeArg: { offset: NOW_CD, k: SAVE_KEY, local: rawB } });
    const stC = await stateOf(c.page);
    ok(Math.floor(stC.rdHonor) === Math.floor(stB.rdHonor)
      && Math.floor(stC.rdHonor) !== Math.floor(stB.rdHonor) + hist[3].honor,
      '7.4 КРИТИЧНО: честь = max, а не сумма двух устройств',
      [Math.floor(stC.rdHonor), Math.floor(stB.rdHonor), hist[3].honor]);
    ok(stC.gid === 176312891 && stC.rdTries === stB.rdTries && Math.floor(stC.rdLife) === Math.floor(stB.rdLife),
      '7.4 гильдия, счётчик недель и пожизненная честь целы при победе локального',
      [stC.gid, stC.rdTries, Math.floor(stC.rdLife)]);
    ok(c.errs.length === 0, '7.4 ошибок страницы нет', c.errs);
    await c.page.close();

    // 7.5 — Встреча устройств, вариант 2: облако СВЕЖЕЕ локального прогресса.
    const d = await open('guild-d', { virtualClock: true, seedStore: { [CLOUD_KEY]: packB } },
      { beforeApp: bootDevice, beforeArg: { offset: NOW_CD, k: SAVE_KEY, local: rawA } });
    const stD = await stateOf(d.page);
    ok(Math.floor(stD.rdHonor) === Math.floor(stB.rdHonor),
      '7.5 и при победе облака честь остаётся max, а не суммой',
      [Math.floor(stD.rdHonor), Math.floor(stB.rdHonor)]);
    ok(stD.rdTries === stB.rdTries && Math.floor(stD.rdBest) === Math.floor(stB.rdBest)
      && Math.floor(stD.rdLife) === Math.floor(stB.rdLife),
      '7.5 недели, лучший результат и пожизненная честь не откатились',
      [stD.rdTries, stD.rdBest, Math.floor(stD.rdLife)]);
    ok(stD.susp === 0, '7.5 встреча устройств не подняла клеймо чита', stD.susp);
    ok(d.errs.length === 0, '7.5 ошибок страницы нет', d.errs);
    await d.page.close();
  }


  console.log('\n========== СТРЕСС-ПРОВЕРКА: ' + passed + ' ok / ' + failed + ' fail ==========');
  process.exit(failed ? 1 : 0);
})();





