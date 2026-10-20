/* ==========================================================================
 * .vk-mock-check.cjs — проигрываем сценарии VK Bridge в настоящем Chromium.
 *   Моок ставится ДО исполнения скриптов (evaluateOnNewDocument), сцена
 *   выбирается query-параметром ?vk=..., так что vk-integration.js думает,
 *   будто открыт внутри клиента VK, и идёт по боевому пути:
 *   VKWebAppInit → VKWebAppCheckNativeAds → VKWebAppShowNativeAds.
 *   Хранилище очищается на document-start — каждый сценарий стартует с нуля.
 *   Сцены: success | legacy ({result:true}) | nofill | closed | failed |
 *          limit (error_code 3) | weird (непонятный ответ) | race (тап до
 *          окончания инициализации) | nodemo (вне VK, боевая сборка).
 *   VKWebAppStorage* в моке специально «выключены»: облачные вызовы не
 *   примешиваются к порядку рекламных. Облачную синхронизацию проверяет
 *   четвёртый набор — .stress-check.cjs (сцены cloud / cloudfail).
 * Запуск: node .vk-mock-check.cjs   (нужен поднятый http://127.0.0.1:5173;
 *         другой адрес стенда — через $env:NEON_BASE)
 * ======================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { requireDevStand } = require('./tools/stand-guard.cjs');

const EXE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
/* Адрес локального стенда. По умолчанию 5173 (python -m http.server 5173).
   Если поднимаете другим способом (например, Live Server в VS Code на 5500) —
   задайте NEON_BASE, чтобы не переписывать код наборов:
       $env:NEON_BASE = 'http://127.0.0.1:5500'; node .vk-mock-check.cjs   */
const ORIGIN = (process.env.NEON_BASE || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const BASE = ORIGIN + '/index.html';
const SAVE_KEY = 'neonclick.save.v1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  ' + a.join(' '));
let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; log('\u2705 ' + name); }
  else { failed++; log('\u274c ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra) : '')); }
};
/* нормализация чисел/строк: тонкие и неразрывные пробелы в расчёт не берём */
const flat = (s) => String(s || '').replace(/[\s\u00a0\u2009\u202f\u200a\u2028\u2029]/g, '');

/* ★ ДЕМО-СБОРКА — только на время прогона (см. [6b]). Репозиторий обязан
   хранить флаг выключенным. Якорь — ровно одно объявление флага: возврат
   «true» в исходник уронит прогон, а не спрячется за зелёными проверками. */
function withDemo(src) {
  const RE = /\bconst\s+DEMO_MODE\s*=\s*false\s*;/g;
  const n = (src.match(RE) || []).length;
  if (n !== 1) {
    throw new Error('ожидал ровно одно «DEMO_MODE = false» в vk-integration.js, нашёл ' + n +
      ' — либо флаг снова включён в репозитории, либо формат объявления сменился');
  }
  return src.replace(RE, 'const DEMO_MODE = true;');
}

/** мок VK Bridge, внедряемый в окно до скриптов приложения */
const MOCK = () => {
  const scen = new URLSearchParams(location.search).get('vk') || 'success';
  /* чистый старт: зачищаем хранилище ДО скриптов приложения, чтобы не тянуть
     офлайн-доход и просмотры из предыдущих сценариев */
  try { window.localStorage.clear(); } catch (e) {}
  const AD_MS = 400;                     // сколько «крутится» ролик в моке
  const GUILD_MS = 120;                  // сколько «думает» VK о сообществе
  const calls = [];
  const subs = [];
  const res = (o) => Promise.resolve(o);
  const later = (o, ms) => new Promise(function (r) { setTimeout(function () { r(o); }, ms); });
  const rej = (code) => {
    const e = new Error('VKWebAppShowNativeAdsFailed');
    e.error_data = { error_code: code, error_reason: 'mock' };
    return e;
  };
  /* отклоняем промис ЛЕНИВО: иначе «сиротливый» reject висит без обработчика
     все AD_MS миллисекунд показа и Chromium ложно ругается на unhandled rejection */
  const laterErr = (code, ms) => new Promise(function (rv, rj) { setTimeout(function () { rj(rej(code)); }, ms); });
  window.__vk = { calls: calls, scen: scen, badParams: [], joined: undefined };
  /* Облачное хранилище (VKWebAppStorage*) «включаем» только в облачных сценариях:
     в остальных оно должно отрапортовать «не поддерживается», чтобы вызовы
     синхронизации не примешивались к порядку рекламных вызовов. */
  const cloudOn = scen === 'cloud' || scen === 'cloudfail';
  const store = window.__store = {};
  if (window.__seedCloud) store[new URLSearchParams(location.search).get('k') || 'neonclick1'] = window.__seedCloud;
  const sup = function (m) { return cloudOn || !/^VKWebAppStorage/.test(String(m || '')); };
  /* isEmbedded() — авторитетный признак «мы внутри клиента VK», и в настоящем
     клиенте он всегда true. ?emb=0 выключает его НАМЕРЕННО: тогда остаётся
     единственный путь опознать VK — разбор launch-параметров по URL. Именно
     на этой ветке раньше лежал боевой desktop_web-запуск, и именно она нигде
     не проверялась с настоящими параметрами VK. */
  const embedded = new URLSearchParams(location.search).get('emb') !== '0';
  window.vkBridge = {
    isEmbedded: function () { return embedded; },
    supports: sup,
    supportsAsync: function (m) { return Promise.resolve(sup(m)); },
    subscribe: function (cb) { subs.push(cb); return function () { var i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1); }; },
    unsubscribe: function () {},
    send: function (method, params) {
      calls.push({ method: method, params: params || null, at: Date.now() });
      if (method === 'VKWebAppInit') {
        /* сценарий «гонка»: клиент VK отвечает с задержкой 500 мс */
        if (scen === 'race') {
          return new Promise(function (r) {
            setTimeout(function () { window.__initResolvedAt = Date.now(); r({ type: 'VKWebAppInit' }); }, 500);
          });
        }
        return res({ type: 'VKWebAppInit' });
      }
      /* ★ КОНТРАКТ РЕКЛАМЫ. Клиент VK понимает только ad_format
         (vk-bridge 3.x: ShowNativeAdsRequest = { ad_format: 'reward'|'interstitial' }).
         Запрос с чужим именем параметра настоящий клиент считает запросом без
         формата: check отвечает «нет заполнения», show отклоняется с error_code 3.
         Мок воспроизводит ровно это поведение, а не подставляет неверный вызов
         зелёным ответом — иначе баг «зовём поле format» прошёл бы мимо всех
         проверок и обнаружился только после подключения монетизации. */
      const isAdCall = method === 'VKWebAppCheckNativeAds' || method === 'VKWebAppShowNativeAds';
      const adOk = !!(params && params.ad_format === 'reward');
      if (isAdCall) {
        if (!adOk) window.__vk.badParams.push({ method: method, params: params || null });
        if (method === 'VKWebAppCheckNativeAds') return res(adOk && scen !== 'nofill' ? { result: true } : { result: false });
        if (!adOk) return laterErr(3, AD_MS);
        window.__adStartedAt = Date.now();
        if (scen === 'closed') return later({ type: 'closed' }, AD_MS);
        if (scen === 'failed') return later({ type: 'failed' }, AD_MS);
        if (scen === 'limit') return laterErr(3, AD_MS);
        if (scen === 'weird') return later({ type: 'undefined-type' }, AD_MS);
        if (scen === 'legacy') return later({ result: true }, AD_MS);
        return later({ type: 'success' }, AD_MS);
      }
      /* ★ КОНТРАКТ ШЕРИНГА (vk-bridge 3.x, data.d.ts:989/1215):
           запрос  VKWebAppShare: { link?: string }  — поля options/title НЕ СУЩЕСТВУЕТ,
           ответ   LinkShareResult[]                 — пустой массив = игрок закрыл
                                                      диалог и НЕ поделился.
         Мок валит в badParams любой запрос с чужими полями или без валидной ссылки:
         иначе «красивый заголовок в options» прошёл бы зелёным и умер только в бою. */
      if (method === 'VKWebAppShare') {
        const p = params || {};
        const linkOk = typeof p.link === 'string' && /^https?:\/\/\S+$/.test(p.link);
        const extra = Object.keys(p).filter((k) => k !== 'link');
        if (!linkOk || extra.length) window.__vk.badParams.push({ method: method, params: p });
        if (scen === 'sharedecline') return res([]);
        return res([{ type: 'post', post_id: '123456' }]);
      }
      /* ★ КОНТРАКТ ГИЛЬДИЙ (vk-bridge 3.x):
           VKWebAppGetGroupInfo { group_id: number } -> { id, name, screen_name,
                                                          is_member: 0|1, photo_200 }
           VKWebAppJoinGroup    { group_id: number } -> { result: true }
           VKWebAppLeaveGroup   { group_id: number } -> { result: true }
         Мок валит в badParams любой запрос без положительного group_id: иначе
         «забыли передать id сообщества» прошёл бы зелёным и обнаружился бы только
         в бою. Членство здесь СОСТОЯТЕЛЬНОЕ (__vk.joined): иначе переход
         «не участник → вступил → участник» было бы нечем проверить, а именно он
         и есть весь смысл кнопки «Вступить». */
      if (/^VKWebApp(GetGroupInfo|JoinGroup|LeaveGroup)$/.test(method)) {
        const gid = params && params.group_id;
        if (!(typeof gid === 'number' && gid > 0)) {
          window.__vk.badParams.push({ method: method, params: params || null });
        }
        if (scen === 'guildtimeout') return new Promise(function () {});   // вечная тишина → таймаут
        if (scen === 'guildrefuse') return laterErr(3, GUILD_MS);
        if (scen === 'guildmalformed') return later({ name: 42, is_member: 'yes', photo_200: 'javascript:alert(1)' }, GUILD_MS);
        if (scen === 'guildempty') return res({});
        if (method === 'VKWebAppGetGroupInfo') {
          return later({
            id: gid, name: 'Гильдия «Неон»', screen_name: 'neonguild',
            is_member: (window.__vk.joined === undefined ? scen !== 'guildoutsider' : window.__vk.joined) ? 1 : 0,
            photo_200: 'https://sun9-12.userapi.com/impg/a1b2/c/guild_200.jpg'
          }, GUILD_MS);
        }
        window.__vk.joined = method === 'VKWebAppJoinGroup';
        return later({ result: true }, GUILD_MS);
      }
      return res({ result: true });
    }
  };
  window.__emit = function (type, data) { subs.slice().forEach(function (cb) { cb({ detail: { type: type, data: data || {} } }); }); };

  /* Игрок успел тапнуть «Получить +1000» раньше, чем достроилась инициализация VK */
  if (scen === 'race') {
    var t = setInterval(function () {
      if (!window.NEON) return;
      var b = document.getElementById('btnCoins');
      if (!b) return;
      clearInterval(t);
      window.__clickedAt = Date.now();
      b.click();
      window.__raced = true;
    }, 2);
  }
};

const toastAll = (page) => page.$eval('#toasts', (e) => e.textContent);
const toastLast = (page) => page.$$eval('#toasts .toast', (els) => (els.length ? els[els.length - 1].textContent : ''));
/** в стеке тостов может лежать несколько сообщений — ищем по всему стеку.
 *  Нормализуем ОБЕ стороны: flat() вырезает и обычные пробелы, поэтому
 *  шаблон «Спасибо за репост» без нормализации никогда бы не совпал. */
async function toastHas(page, needle) { return flat(await toastAll(page)).indexOf(flat(needle)) > -1; }
const coins = (page) => page.evaluate(() => window.NEON.state().coins);
const methods = (page) => page.evaluate(() => window.__vk.calls.map((c) => c.method));

async function scenario(browser, scen, extraQ) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e && e.message)));
  await page.evaluateOnNewDocument(MOCK);
  await page.goto(BASE + '?vk=' + scen + '&debug=1' + (extraQ || ''), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.VK && window.NEON && document.getElementById('tabShop'), { timeout: 15000 });
  const inVK = await page.evaluate(() => window.VK.ready);
  await sleep(250);
  return { page: page, inVK: inVK, errs: errs };
}

(async () => {
  /* Префлайт стенда. Набору нужны ИСХОДНИКИ с отладочными хуками window.NEON,
     а не боевой артефакт. Без этого шага стенд, отдающий _site, выглядит как
     регрессия игры: молчаливый 15-секундный таймаут на waitForFunction. */
  await requireDevStand(ORIGIN, '.vk-mock-check.cjs').catch((e) => { console.error('\n\u274c ' + e.message + '\n'); process.exit(1); });
  const browser = await puppeteer.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  log('браузер:', EXE);
  /* ================= 1. УСПЕШНЫЙ ПОСМОТР → НАГРАДА ================= */
  log('\n[1] ?vk=success — ролик досмотрен');
  let s = await scenario(browser, 'success');
  ok(s.inVK === true, 'распознан внутри VK (isEmbedded → VKWebAppInit)');
  ok(await s.page.evaluate(() => window.VK.isDemo()) === false, 'демо-режим выключен внутри VK');
  await s.page.click('.tab[data-tab="bonus"]');
  await sleep(200);
  const note0 = await s.page.$eval('#adNote', (e) => e.textContent);
  ok(flat(note0).indexOf('\u043d\u0435\u0442\u0437\u0430\u043f\u043e\u043b\u043d\u0435\u043d\u0438\u044f') === -1 && flat(note0).indexOf('\u043f\u043e\u0441\u043b\u0435\u043f\u0440\u043e\u0441\u043c\u043e\u0442\u0440\u0430') > -1, 'подсказка обещает награду после просмотра', note0);
  const c0 = await coins(s.page);
  await s.page.click('#btnCoins');
  await sleep(150);
  const busyState = await s.page.$$eval('.ad', (els) => els.map((e) => e.disabled));
  ok(busyState.every(Boolean), 'на время показа заблокированы ВСЕ кнопки бонусов, включая репост (adBusy)', busyState);
  ok(flat(await s.page.$eval('#coinsCta', (e) => e.textContent)) === '\u0416\u0434\u0451\u043c\u2026', 'CTA показывает состояние загрузки «Ждём…»', await s.page.$eval('#coinsCta', (e) => e.textContent));
  await sleep(1400);
  const c1 = await coins(s.page);
  const m1 = await methods(s.page);
  ok(m1[0] === 'VKWebAppInit', 'первым ушёл обязательный VKWebAppInit', m1.slice(0, 3));
  ok(m1.indexOf('VKWebAppCheckNativeAds') > -1 && m1.indexOf('VKWebAppCheckNativeAds') < m1.indexOf('VKWebAppShowNativeAds'), 'сначала check заполнения, затем show', m1);
  ok(m1.filter((x) => x === 'VKWebAppShowNativeAds').length === 1, 'ролик запрошен ровно один раз');
  /* Контракт параметров: ловим то, что не видно по ответам — неверное имя поля
     (format вместо ad_format) клиент VK проигнорировал бы, и монетизация
     умерла бы молча уже в бою. */
  const adReqs = await s.page.evaluate(() => window.__vk.calls.filter((c) => /NativeAds$/.test(c.method)).map((c) => c.params && c.params.ad_format));
  ok(adReqs.length >= 2 && adReqs.every((x) => x === 'reward'), 'оба рекламных вызова несут ad_format=reward (контракт vk-bridge 3.x)', adReqs);
  ok(await s.page.evaluate(() => window.__vk.badParams.length) === 0, 'нет вызовов моста с параметрами вне контракта (реклама / шеринг)', await s.page.evaluate(() => window.__vk.badParams));
  ok(Math.round(c1 - c0) === 1000, 'начислено ровно 1000 монет', [c0, c1]);
  ok(await toastHas(s.page, '\u041d\u0430\u0447\u0438\u0441\u043b\u0435\u043d\u043e1000\u043c\u043e\u043d\u0435\u0442'), 'тост «Начислено 1000 монет за просмотр»', await toastAll(s.page));
  ok(await s.page.$eval('#coinsCta', (e) => e.textContent) === 'Реклама', 'CTA вернулся в боковое состояние');
  ok(await s.page.$eval('#btnCoins', (e) => !e.disabled), 'кнопка снова активна');

  /* кулдаун: второй клик не должен тратить рекламу */
  await s.page.click('#btnCoins');
  await sleep(250);
  const m2 = await methods(s.page);
  ok(m2.filter((x) => x === 'VKWebAppShowNativeAds').length === 1, 'клик в кулдауне не вызывает новую рекламу', m2);
  ok(await toastHas(s.page, '\u0440\u043e\u043b\u0438\u043a\u0431\u0443\u0434\u0435\u0442\u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d'), 'тост о кулдауне («Новый ролик будет доступен через N сек»)', await toastAll(s.page));

  /* уход в фон VK → сохранение */
  await s.page.evaluate(() => window.NEON.add(777));
  const live = await coins(s.page);
  await s.page.evaluate(() => window.__emit('VKWebAppViewHide', {}));
  await sleep(300);
  const saved = await s.page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}'), SAVE_KEY);
  ok(saved.coins >= live - 1, 'vk:viewhide → прогресс записан в LocalStorage', [live, saved.coins]);
  ok(s.errs.length === 0, 'нет необработанных ошибок страницы', s.errs);
  await s.page.close();

  /* ================= 2. СТАРЫЙ ФОРМАТ ОТВЕТА {result:true} ================= */
  log('\n[2] ?vk=legacy — старые клиенты VK (result: true)');
  s = await scenario(browser, 'legacy');
  await s.page.click('.tab[data-tab="bonus"]');
  const l0 = await coins(s.page);
  await s.page.click('#btnCoins');
  await sleep(1400);
  ok(Math.round((await coins(s.page)) - l0) === 1000, 'ответ { result: true } распознан как успех и вознаграждён');
  await s.page.close();

  /* ================= 3. ОТКАЗЫ VK ================= */
  const fails = [
    { scen: 'nofill', want: '\u0420\u0435\u043a\u043b\u0430\u043c\u0430\u0435\u0449\u0451\u043d\u0435\u0433\u043e\u0442\u043e\u0432\u0430', note: '\u043d\u0435\u0442\u0437\u0430\u043f\u043e\u043b\u043d\u0435\u043d\u0438\u044f', show: false, label: 'нет заполнения (check → result:false)' },
    { scen: 'closed', want: '\u0420\u043e\u043b\u0438\u043a\u043d\u0435\u0434\u043e\u0441\u043c\u043e\u0442\u0440\u0435\u043d', show: true, label: 'закрыл досрочно (type: closed)' },
    { scen: 'failed', want: '\u0420\u043e\u043b\u0438\u043a\u043d\u0435\u0434\u043e\u0441\u043c\u043e\u0442\u0440\u0435\u043d', show: true, label: 'сорвался (type: failed)' },
    { scen: 'limit', want: '\u0414\u043d\u0435\u0432\u043d\u043e\u0439\u043b\u0438\u043c\u0438\u0442', show: true, label: 'ошибка SDK error_code=3 (лимит)' },
    { scen: 'weird', want: '\u0421\u0435\u0439\u0447\u0430\u0441\u043d\u0435\u0442\u0441\u0432\u043e\u0431\u043e\u0434\u043d\u044b\u0445\u0440\u043e\u043b\u0438\u043a\u043e\u0432', show: true, label: 'непонятный ответ SDK → резервный текст' }
  ];
  for (const f of fails) {
    log('\n[3] ?vk=' + f.scen + ' — ' + f.label);
    s = await scenario(browser, f.scen);
    await s.page.click('.tab[data-tab="bonus"]');
    await sleep(250);
    const note = await s.page.$eval('#adNote', (e) => e.textContent);
    const before = await coins(s.page);
    await s.page.click('#btnCoins');
    await sleep(1500);
    const after = await coins(s.page);
    const mm = await methods(s.page);
    ok(Math.round(after - before) === 0, '  награда НЕ начислена при отказе', [before, after]);
    ok(mm.filter((x) => x === 'VKWebAppShowNativeAds').length === (f.show ? 1 : 0), '  VKWebAppShowNativeAds вызван соответственно сценарию', mm);
    ok(await toastHas(s.page, f.want), '  «красивый» текст отказа: ' + f.want.slice(0, 24) + '…', await toastAll(s.page));
    if (f.note) ok(flat(note).indexOf(f.note) > -1, '  подсказка обновлена на «нет заполнения»', note);
    ok(await s.page.$eval('#btnCoins', (e) => !e.disabled), '  кнопка разблокирована после отказа');
    ok(s.errs.length === 0, '  ошибок страницы нет', s.errs);
    await s.page.close();
  }

  /* ================= 4. БУСТ ×2 ЗА РОЛИК ================= */
  log('\n[4] ?vk=success — точка «Удвоить пассивный доход»');
  s = await scenario(browser, 'success');
  /* без авто-майнинга удваивать нечего: реклама тратиться не должна */
  await s.page.click('.tab[data-tab="bonus"]');
  await sleep(150);
  await s.page.click('#btnDouble');
  await sleep(400);
  ok((await methods(s.page)).filter((x) => x === 'VKWebAppShowNativeAds').length === 0, 'реклама не тратится, пока авто-майнинг не куплен');
  ok(await toastHas(s.page, '\u0410\u0432\u0442\u043e-\u043c\u0430\u0439\u043d\u0438\u043d\u0433'), 'подсказка «сначала купи Авто-майнинг»', await toastAll(s.page));
  ok(await s.page.$eval('#tabShop', (e) => !e.hidden), 'автоматически открыт таб «Магазин»');

  await s.page.evaluate(() => window.NEON.add(1000));
  await sleep(150);
  await s.page.click('#buyAuto');
  await sleep(250);
  const ps0 = await s.page.$eval('#perSecond', (e) => parseInt(e.textContent.replace(/\D/g, ''), 10) || 0);
  await s.page.click('.tab[data-tab="bonus"]');
  await s.page.click('#btnDouble');
  await sleep(1500);
  const ps1 = await s.page.$eval('#perSecond', (e) => parseInt(e.textContent.replace(/\D/g, ''), 10) || 0);
  const bst = await s.page.evaluate(() => ({
    display: getComputedStyle(document.getElementById('boost')).display,
    time: document.getElementById('boostTime').textContent,
    watched: window.NEON.state().watched
  }));
  ok(ps0 > 0 && ps1 === ps0 * 2, 'пассивный доход удвоен', [ps0, ps1]);
  ok(bst.display !== 'none' && /^\d:\d\d$/.test(bst.time.trim()), 'плашка буста видна, таймер в формате M:SS', bst);
  ok(bst.watched === 1, 'ролик засчитан в статистике (watched)', bst.watched);
  ok((await methods(s.page)).filter((x) => x === 'VKWebAppShowNativeAds').length === 1, 'для буста сыгран ровно один ролик', await methods(s.page));
  ok(await toastHas(s.page, '\u0443\u0434\u0432\u043e\u0435\u043d'), 'тост об удвоении', await toastAll(s.page));
  ok(s.errs.length === 0, 'ошибок страницы нет', s.errs);
  await s.page.close();

  /* ================= 5. ГОНКА НА СТАРТЕ (главная дырка монетизации) ================= */
  log('\n[5] ?vk=race — тап по награде ДО завершения VKWebAppInit');
  s = await scenario(browser, 'race');
  await sleep(2500);
  const race = await s.page.evaluate(() => ({
    raced: !!window.__raced,
    clickedAt: window.__clickedAt || 0,
    initResolvedAt: window.__initResolvedAt || 0,
    inVK: window.VK.isVK(),
    demo: window.VK.isDemo(),
    coins: Math.round(window.NEON.state().coins)
  }));
  const rm = await methods(s.page);
  log('race:', JSON.stringify(race), rm.join(' → '));
  ok(race.raced && race.clickedAt && race.clickedAt <= race.initResolvedAt, 'тап реально пришёлся до окончания инициализации VK', race);
  ok(rm.indexOf('VKWebAppShowNativeAds') > -1, 'награда пошла по боевому пути (реклама), а не по демо-ветке', rm);
  ok(rm.indexOf('VKWebAppShowNativeAds') > rm.indexOf('VKWebAppInit'), 'ролик запрошен только после подтверждённого VKWebAppInit', rm);
  ok(race.coins === 1000, 'монеты начислены ровно один раз и только за досмотренный ролик', race.coins);
  ok(race.demo === false, 'после гонки приложение считает себя внутри VK', race);
  ok(s.errs.length === 0, 'ошибок страницы нет', s.errs);
  await s.page.close();

  /* ================= 6. ВНЕ VK: БОЕВОЙ РЕЖИМ (DEMO_MODE=false) ================= */
  log('\n[6] ?vk=nodemo — проверка, что вне VK награда не выдаётся без DEMO_MODE');
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const perrs = [];
    page.on('pageerror', (e) => perrs.push(String(e && e.message)));
    /* «мост», который сообщает, что приложение открыто НЕ в клиенте VK */
    await page.evaluateOnNewDocument(() => {
      try { window.localStorage.clear(); } catch (e) {}
      window.vkBridge = {
        isEmbedded: function () { return false; },
        supports: function () { return true; },
        send: function () { return Promise.resolve({ result: true }); }
      };
    });
    /* Подменять нечего: репозиторный файл уже боевой. Проверяем именно это —
       к игроку должен уйти тот же текст, что лежит в репозитории. */
    const orig = fs.readFileSync(path.join(__dirname, 'vk-integration.js'), 'utf8');
    const src = orig;
    ok(!/const\s+DEMO_MODE\s*=\s*true\s*;/.test(orig) && /const\s+DEMO_MODE\s*=\s*false\s*;/.test(orig),
      'репозиторий хранит выключенный DEMO_MODE — эту сборку можно публиковать',
      (orig.match(/const\s+DEMO_MODE\s*=\s*\w+\s*;/) || ['<объявление флага не найдено>'])[0]);
    log('флаг в репозитории: ' + ((orig.match(/const\s+DEMO_MODE\s*=\s*\w+\s*;/) || ['?'])[0]));
    await page.setRequestInterception(true);
    await page.setCacheEnabled(false);
    let swapped = 0;
    page.on('request', (r) => {
      if (/vk-integration\.js(\?|$)/.test(r.url())) {
        swapped++;
        r.respond({ status: 200, contentType: 'application/javascript; charset=utf-8', body: 'window.__PROD_BUILD__=true;\n' + src });
        return;
      }
      r.continue();
    });
    await page.goto(BASE + '?vk=nodemo&debug=1', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.VK && window.NEON, { timeout: 15000 });
    await sleep(600);
    ok(swapped > 0 && await page.evaluate(() => window.__PROD_BUILD__ === true), 'игроку уходит репозиторный (боевой) файл, а не кеш браузера', swapped);
    /* Точку проверяем ДО открытия таба: сам переход на «Бонусы» гасит её
       (game.js: if (!isShop) bonusDot.remove('is-on')) — иначе проверка
       прошла бы по чужой причине и назвала бы её «нет заполнения». */
    ok(await page.$eval('#bonusDot', (e) => !e.classList.contains('is-on')),
      'точка наград не горит ещё до открытия таба: заполнение отсутствует');
    await page.click('.tab[data-tab="bonus"]');
    await sleep(200);
    const b0 = await coins(page);
    await page.click('#btnCoins');
    await sleep(1200);
    const b1 = await coins(page);
    const note = await page.$eval('#adNote', (e) => e.textContent);
    log('nodemo:', JSON.stringify({ b0, b1, demo: await page.evaluate(() => window.VK.isDemo()), note }));
    ok(await page.evaluate(() => window.VK.isDemo()) === false, 'DEMO_MODE=false → демо-ветка отключена');
    ok(Math.round(b1 - b0) === 0, 'вне VK и без демо-режима награда НЕ выдаётся', [b0, b1]);
    ok(await toastHas(page, '\u0442\u043e\u043b\u044c\u043a\u043e\u0432\u043d\u0443\u0442\u0440\u0438VK'), 'честное сообщение «Реклама доступна только внутри VK»', await toastAll(page));
    ok(await page.$eval('#bonusDot', (e) => !e.classList.contains('is-on')), 'точка наград не зажглась снова после неудачной попытки', note);
    ok(await page.$$eval('.ad', (els) => els.every((e) => !e.disabled)), 'кнопки не остались задизейблены', note);
    ok(perrs.length === 0, 'ошибок страницы нет', perrs);
    await page.close();
  }

  /* ====== 6b. ТОТ ЖЕ КОД С ВКЛЮЧЁННЫМ ФЛАГОМ: дифференциальный контроль ======
     Без него «награда не выдалась» в [6] ничего не доказывает: кнопка могла
     молчать и из-за сломанного обработчика, и из-за кеша. Меняем ОДНИМ флагом —
     и выдача обязана появиться. Тогда [6] закрывает дыру именно сборкой. */
  log('\n[6b] ?vk=nodemo + демо-подмена — тот же код, включённый флаг');
  {
    let demoSrc = null, demoErr = null;
    try { demoSrc = withDemo(fs.readFileSync(path.join(__dirname, 'vk-integration.js'), 'utf8')); }
    catch (e) { demoErr = e.message; }
    ok(demoErr === null, 'демо-сборка для [6b] собрана подменой одного флага', demoErr);
    /* Если флаг в репозитории уже включён, подмены нет: подаём репозиторный
       файл, но метку __DEMO_BUILD__ ставим честной — дальше проверки на
       «демо подаётся» и «награда выдалась» покрасятся подсчётно, а прогон
       дойдёт до конца. */
    if (!demoSrc) demoSrc = fs.readFileSync(path.join(__dirname, 'vk-integration.js'), 'utf8');
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const derrs = [];
    page.on('pageerror', (e) => derrs.push(String(e && e.message)));
    await page.evaluateOnNewDocument(() => {
      try { window.localStorage.clear(); } catch (e) {}
      window.vkBridge = {
        isEmbedded: function () { return false; },
        supports: function () { return true; },
        send: function () { return Promise.resolve({ result: true }); }
      };
    });
    let served = 0;
    await page.setRequestInterception(true);
    await page.setCacheEnabled(false);
    page.on('request', (r) => {
      if (/vk-integration\.js(\?|$)/.test(r.url())) {
        served++;
        r.respond({ status: 200, contentType: 'application/javascript; charset=utf-8', body: 'window.__DEMO_BUILD__=' + (demoErr ? 'false' : 'true') + ';\n' + demoSrc });
        return;
      }
      r.continue();
    });
    await page.goto(BASE + '?vk=nodemo&debug=1', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.VK && window.NEON, { timeout: 15000 });
    await sleep(600);
    ok(served > 0 && await page.evaluate(() => window.__DEMO_BUILD__ === true && window.VK.isDemo() === true),
      'демо-сборка подана, отличается от репозиторной одним флагом', served);
    /* Зеркало [6]: точка проверяется до открытия таба, иначе её сняло бы
       самим переходом, а не состоянием наград. */
    ok(await page.$eval('#bonusDot', (e) => e.classList.contains('is-on')),
      'в демо-сборке точка наград горит (в [6] на том же месте — не горит)');
    await page.click('.tab[data-tab="bonus"]');
    await sleep(200);
    const d0 = await coins(page);
    await page.click('#btnCoins');
    await sleep(1700);
    const d1 = await coins(page);
    log('demo-подмена:', JSON.stringify({ d0: d0, d1: d1, delta: Math.round(d1 - d0) }));
    ok(Math.round(d1 - d0) === 1000, 'с включённым флагом награда выдаётся → в [6] её закрыл именно флаг', Math.round(d1 - d0));
    ok(derrs.length === 0, 'ошибок страницы нет', derrs);
    await page.close();
  }

  /* ================= 7. ВИРУСНАЯ ПЕТЛЯ: контракт VKWebAppShare ================= */
  log('\n[7] долгий тап по монете → шеринг канонической ссылки VK');
  {
    /* Долгий тап: pointerdown держим 1000 мс (порог жеста в game.js — 900 мс). */
    const press = (pg) => pg.evaluate(() => new Promise((res) => {
      const c = document.getElementById('coin');
      c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      setTimeout(() => {
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
        setTimeout(res, 800);
      }, 1000);
    }));
    const shareCall = (pg) => pg.evaluate(() => {
      const cs = window.__vk.calls.filter((x) => x.method === 'VKWebAppShare');
      const last = cs.length ? cs[cs.length - 1] : null;
      return { n: cs.length, link: last && last.params ? last.params.link : null,
        keys: last && last.params ? Object.keys(last.params).sort().join(',') : '' };
    });
    const openShare = async (scen, extra) => {
      const pg = await browser.newPage();
      await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const errs = [];
      pg.on('pageerror', (e) => errs.push(String(e && e.message)));
      await pg.evaluateOnNewDocument(MOCK);
      await pg.goto(BASE + '?vk=' + scen + '&debug=1&app_id=6089842&group_id=-1' + (extra || ''), { waitUntil: 'domcontentloaded' });
      await pg.waitForFunction(() => window.VK && window.NEON, { timeout: 15000 });
      await sleep(300);
      return { pg, errs };
    };

    const sh = await openShare('success');
    ok(await sh.pg.evaluate(() => window.VK.shareLink()) === 'https://vk.com/app6089842_-1',
      'каноническая ссылка собрана из launch-параметров (приложение сообщества)',
      await sh.pg.evaluate(() => window.VK.shareLink()));
    const c0 = await coins(sh.pg);
    await press(sh.pg);
    const sc = await shareCall(sh.pg);
    log('share:', JSON.stringify(sc));
    ok(sc.n === 1, 'долгий тап отправил ровно один VKWebAppShare', sc);
    ok(sc.link === 'https://vk.com/app6089842_-1',
      'другу уходит ссылка vk.com/app…_…, а не адрес хостинга (вне VK игра бессмысленна)', sc);
    ok(sc.keys === 'link', 'запрос содержит только link (поля options/title в контракте нет)', sc);
    ok(await toastHas(sh.pg, 'Репост засчитан'), 'за фактический репост — подтверждение', await toastAll(sh.pg));
    const c1 = await coins(sh.pg);
    // Долгий тап — это ещё и КЛИК по монете (часть +N за тап приходит вместе с
    // наградой), поэтому здесь проверяем только «награда пришла», без точности.
    ok(c1 - c0 >= 500, 'репост по долгому тапу оплачен (≥500 монет, сверх тапа)', [c0, c1]);
    ok(await sh.pg.evaluate(() => window.NEON.state().shares) === 1
      && await sh.pg.evaluate(() => window.NEON.state().shareN) === 1, 'счётчики репостов выросли на 1');
    ok(await sh.pg.evaluate(() => window.NEON.state().v) === 4, 'состояние — схема v4');

    /* Переходим на таб «Бонусы»: кнопка лежит в скрытой панели, и клик по ней
       без переключения табов просто не прошёл бы (узел не виден). */
    await sh.pg.click('.tab[data-tab="bonus"]');
    await sleep(200);

    /* Точная оплата с чистого клика (без дохода за тап по монете). */
    await sh.pg.evaluate(() => window.NEON.clearCooldown());
    const c15 = await coins(sh.pg);
    await sh.pg.click('#btnShare');
    await sleep(500);
    const c16 = await coins(sh.pg);
    ok(Math.round(c16 - c15) === 500, 'клик «Репост» оплачен ровно на CFG.share.reward = 500', [c15, c16]);
    ok(await sh.pg.evaluate(() => window.NEON.state().shares) === 2, 'второй репост суток засчитан',
      await sh.pg.evaluate(() => window.NEON.state().shares));

    /* Кулдаун: второй репост подряд не должен давать вторую награду — иначе это
       генератор монет, а не виральная механика. */
    const c2 = await coins(sh.pg);
    await sh.pg.click('#btnShare');
    await sleep(500);
    ok(Math.round((await coins(sh.pg)) - c2) === 0, 'второй репост в кулдауне НЕ оплачен', [c2, await coins(sh.pg)]);
    ok(await toastHas(sh.pg, 'уже засчитан'), 'игрок понял, почему награды нет', await toastAll(sh.pg));

    /* Суточный лимит: исчерпанный остаток гасит карточку и не платит. */
    await sh.pg.evaluate(() => {
      const st = window.NEON.state();
      st.shareDay = Math.floor(Date.now() / 86400000);
      st.shareN = 3; st.shares = 3;
      window.NEON.clearCooldown();
      window.NEON.render();
    });
    const c3 = await coins(sh.pg);
    await sh.pg.click('#btnShare');
    await sleep(500);
    ok(Math.round((await coins(sh.pg)) - c3) === 0, 'репост сверх суточного лимита НЕ оплачен');
    ok(await sh.pg.$eval('#btnShare', (e) => e.classList.contains('is-spent')), 'карточка гаснет при исчерпанном лимите');
    ok(await toastHas(sh.pg, 'Лимит репостов'), 'игрок уведомлён о суточном лимите', await toastAll(sh.pg));
    ok(await sh.pg.evaluate(() => window.__vk.badParams.length) === 0, 'нарушений контракта моста нет',
      await sh.pg.evaluate(() => window.__vk.badParams));
    ok(sh.errs.length === 0, 'ошибок страницы нет', sh.errs);
    await sh.pg.close();

    /* Игрок закрыл диалог, не поделившись: мост отвечает пустым массивом. */
    const dc = await openShare('sharedecline');
    await press(dc.pg);
    ok((await shareCall(dc.pg)).n === 1, 'диалог шаринга всё равно открыт (отказ — нормальная ветка)');
    ok(await dc.pg.evaluate(() => window.VK.share()) === false,
      'пустой LinkShareResult[] → false (пустой массив truthy: старая проверка обманывалась)');
    ok(!(await toastHas(dc.pg, 'Репост засчитан')), 'за отказ подтверждение не показывается', await toastAll(dc.pg));
    ok(await dc.pg.evaluate(() => window.NEON.state().shares) === 0,
      'за отказ счётчик репостов не вырос (иначе — бесконечный кран монет)',
      await dc.pg.evaluate(() => window.NEON.state().shares));
    ok(dc.errs.length === 0, 'ошибок страницы нет', dc.errs);
    await dc.pg.close();

    /* ============ 7b. ТЕМА НЕ ВЛАСТНА ТРОГАТЬ КОНТРАКТ VK ============
       Соблазн «красивого шеринга» возвращается ровно при ребрендинге: в теме
       завёлся вирусный текст — и его захотелось передать в VKWebAppShare.
       Мок валит в badParams любой запрос с чужими полями, так что здесь
       проверяем главное: payload по-прежнему ТОЛЬКО { link }, а валюта темы
       звучит в подписи награды, но не в звонке моста. */
    const tm = await openShare('success', '&theme=meme');
    ok(await tm.pg.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'meme',
      'мемо-сборка запустилась на своей теме');
    const tc0 = await coins(tm.pg);
    await press(tm.pg);
    const tsc = await shareCall(tm.pg);
    log('share(theme=meme):', JSON.stringify(tsc));
    ok(tsc.n === 1 && tsc.keys === 'link',
      'тема НЕ добавила полей в VKWebAppShare: payload остался { link }', tsc);
    ok(await tm.pg.evaluate(() => window.__vk.badParams.length) === 0,
      'запрос шаринга из мемо-сборки признан валидным', await tm.pg.evaluate(() => window.__vk.badParams));
    ok(await coins(tm.pg) - tc0 >= 500, 'награда за репост в мемо-сборке начислена', [tc0, await coins(tm.pg)]);
    ok(await toastHas(tm.pg, 'мемокоинов'), 'подпись награды говорит на валюте темы', await toastAll(tm.pg));
    ok(await tm.pg.evaluate(() => window.NEON.state().shares) === 1, 'счётчик репостов вырос и в теме');
    await tm.pg.close();

    /* ============ 7c. ТЕМА СКВОЗЬ ОБЁРТКУ VK: location_search ============
       Смоук [9.5b] доказывает разбор на jsdom. Здесь — то же самое в настоящем
       Chromium и на настоящем пути загрузки: VK привозит query приложения
       параметром location_search, а не россыпью, и витрина обязана смениться ДО
       первого пейнта (иначе игрок увидит вспышку чужого бренда). Плюс главное
       по инварианту №1: завёрнутая тема не имеет права расширить VKWebAppShare.
       Блок живёт внутри секции 7 нарочно: press/shareCall/openShare — её
       локальные помощники. */
    log('\n[7c] ?location_search=%3Ftheme%3Dmeme — тема сквозь обёртку VK');
    const ls = await openShare('success', '&location_search=' + encodeURIComponent('?theme=meme'));
    const gotTheme = await ls.pg.evaluate(() => document.documentElement.getAttribute('data-theme'));
    const logo = await ls.pg.evaluate(() => document.getElementById('logoTxt').textContent);
    const wantLogo = await ls.pg.evaluate(() => window.NEON.themeOf('meme').copy.logo);
    log('location_search:', JSON.stringify({ gotTheme, logo, wantLogo }));
    ok(gotTheme === 'meme', 'тема из location_search применена в настоящем браузере', gotTheme);
    ok(logo === wantLogo, 'шапка на мемо-бренде с первой отрисовки, а не «успела переключиться»', [logo, wantLogo]);
    const lc0 = await coins(ls.pg);
    await press(ls.pg);
    const lsc = await shareCall(ls.pg);
    log('share(location_search):', JSON.stringify(lsc));
    ok(lsc.n === 1 && lsc.keys === 'link',
      'завёрнутая тема НЕ расширила VKWebAppShare: payload остался { link }', lsc);
    ok(await coins(ls.pg) - lc0 >= 500, 'награда за репост выплачена и в завёрнутой теме', [lc0, await coins(ls.pg)]);
    ok(ls.errs.length === 0, 'ошибок страницы нет', ls.errs);
    await ls.pg.close();
  }

  /* ============ 8. СОЛО «ВА-БАНК» В НАСТОЯЩЕМ БРАУЗЕРЕ ============
     Смоук [10] доказывает целость экономики на jsdom. Здесь — то, чего jsdom
     не видит: реальная раскладка карточки на мобильном вьюпорте, настоящий
     клик мышью по кнопке (а не вызов NEON.playRisk()) и главное — что ставка
     НИ РАЗУ не обратилась к VK-мосту. Прикрути кто к ней рекламу или payload,
     этот блок упадёт, а смоук — нет: на jsdom мост не проверяется. */
  log('\n[8] Соло «Ва-банк»: раскладка, настоящий клик, тишина в мосту VK');
  {
    const r = await scenario(browser, 'success');
    await r.page.click('.tab[data-tab="bonus"]');
    await sleep(200);
    await r.page.evaluate(() => window.NEON.add(100000));
    await sleep(150);

    const vis = await r.page.$eval('#riskCard', (e) => {
      const b = e.getBoundingClientRect(), cs = getComputedStyle(e);
      return { w: Math.round(b.width), h: Math.round(b.height), disp: cs.display, op: cs.opacity };
    });
    ok(vis.disp !== 'none' && vis.w > 0 && vis.h > 0,
      'карточка «Ва-банк» отрисована в реальном Chromium', vis);
    const scrollW = await r.page.evaluate(() => document.documentElement.scrollWidth);
    ok(scrollW <= 390 + 1, 'карточка не распирает страницу на 390px (мобильный вьюпорт)', scrollW);
    const chips = await r.page.$$eval('#riskChips .chip', (els) => els.map((e) => ({
      t: e.textContent, w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height)
    })));
    ok(chips.length === 3 && chips.every((c) => c.w > 10 && c.h > 10),
      'три чипа доли видимы и не схлопнулись (тап-таргеты живые)', chips);

    /* Карточка не должна быть сплющена изнутри. .tabbody — column-flex с
       ограниченной высотой панели: при flex-shrink по умолчанию карточка
       уминалась до размера окна (78px при содержимом 161px на 390×844),
       scrollHeight контейнера становился равен clientHeight, скролл не
       появлялся, а чипы доли, сумма ставки, кнопка «Поставить» и предупреждение
       молча резались overflow:hidden. Признак здоровой вёрстки — высота рамки
       равна содержимому, и все узлы внутри этой рамки. */
    const fit = await r.page.$eval('#riskCard', (e) => {
      const b = e.getBoundingClientRect();
      const inside = (id) => {
        const n = document.getElementById(id).getBoundingClientRect();
        return n.top >= b.top - 1 && n.bottom <= b.bottom + 1;
      };
      return {
        box: Math.round(b.height), content: e.scrollHeight,
        chips: inside('riskChips'), cta: inside('btnRisk'), note: inside('riskNote'),
        inWindow: (() => {
          const t = document.getElementById('tabBonus').getBoundingClientRect();
          return b.top >= t.top - 1 && b.bottom <= t.bottom + 1;
        })()
      };
    });
    ok(fit.content <= fit.box + 1,
      'карточка «Ва-банк» не сплющена: высота рамки равна её содержимому', fit);
    ok(fit.chips && fit.cta && fit.note,
      'чипы доли, «Поставить» и предупреждение лежат в рамке карточки, а не срезаны за ней', fit);
    ok(fit.inWindow,
      'вся карточка «Ва-банк» видна в окне таба без прокрутки (ставка — первый экран монетизации)', fit);

    const mBefore = (await methods(r.page)).length;
    const t0 = await r.page.evaluate(() => Math.floor(window.NEON.state().total));
    await r.page.click('#btnRisk');                            // ← настоящая мышь, не NEON.playRisk()
    await sleep(120);
    const midPending = await r.page.evaluate(() => window.NEON.risk().pending);
    ok(midPending > 0, 'write-ahead пережил настоящий клик: ставка записана ДО раскрытия', midPending);
    const busyDisabled = await r.page.$eval('#btnRisk', (e) => e.disabled);
    ok(busyDisabled, 'пока раунд идёт, кнопка задизейблена (двойной клик не заведёт два раунда)');
    await sleep(1300);

    const st = await r.page.evaluate(() => Object.assign({}, window.NEON.state()));
    ok(Math.floor(st.total) === t0, 'настоящий раунд не тронул S.total — валюта не создана', [Math.floor(st.total), t0]);
    ok((st.riskWins || 0) + (st.riskLoss || 0) === 1,
      'раунд засчитан ровно один раз (исход настоящийм Math.random, не подсадкой)', [st.riskWins, st.riskLoss]);
    ok(st.rpStake === 0, 'раунд закрыт, незакрытых ставок не висит', st.rpStake);
    const newCalls = (await methods(r.page)).slice(mBefore);
    ok(newCalls.filter((x) => /Ads|Share/.test(x)).length === 0,
      'ставка НЕ обратилась к рекламному/шаринговому мосту VK', newCalls);
    ok(r.errs.length === 0, 'ошибок страницы нет', r.errs);
    await r.page.close();
  }

  /* ================= 9. ГИЛЬДИИ = СООБЩЕСТВА VK ================= */
  log('\n[9] Гильдии: запуск из сообщества, вступление, отказ и таймаут моста VK');
  {
    const GID = '&vk_group_id=176312891&vk_viewer_group_role=admin';
    const gOf = (pg) => pg.evaluate(() => window.NEON.guild());
    const waitProbe = (pg) => pg.waitForFunction(
      () => window.NEON.guild().probed && !window.NEON.guild().busy, { timeout: 12000 });

    // 9.1 — Участник: имя, фото, роль и надбавка приехали из VK.
    const gm = await scenario(browser, 'guildmember', GID);
    await waitProbe(gm.page);
    const gi = await gOf(gm.page);
    ok(gi.gid === 176312891, 'launch-параметр vk_group_id сделал сообщество гильдией', gi);
    ok(gi.state === 1, 'VK подтвердил is_member=1 → gState=1', gi);
    ok(gi.role === 'admin', 'роль из vk_viewer_group_role прочитана (и только как справка, не привилегия)', gi);
    ok(gi.name === 'Гильдия «Неон»', 'имя сообщества приехало из VKWebAppGetGroupInfo, а не из сейва', gi);
    ok((await methods(gm.page)).indexOf('VKWebAppGetGroupInfo') > -1, 'запрос карточки сообщества ушёл',
      (await methods(gm.page)).filter((x) => /Group/.test(x)));
    await gm.page.click('.tab[data-tab="guild"]');
    await sleep(300);
    ok(flat(await gm.page.$eval('#guildName', (e) => e.textContent)) === flat('Гильдия «Неон»'),
      'имя гильдии отрисовано на вкладке', await gm.page.$eval('#guildName', (e) => e.textContent));
    ok(await gm.page.$eval('#guildState', (e) => e.textContent) === 'Участник ✓',
      'статус подписан как участие', await gm.page.$eval('#guildState', (e) => e.textContent));
    ok(await gm.page.$eval('#guildCard', (e) => e.classList.contains('is-member')),
      'подтверждённое участие визуально отмечено на карточке');
    const photo = await gm.page.$eval('#guildPhoto', (e) => ({
      hidden: e.hidden, src: e.getAttribute('src') || ''
    }));
    ok(!photo.hidden && /https:\/\/sun9-12\.userapi\.com\//.test(photo.src),
      'фото из CDN VK показано: валидатор не путает «безопасно» с «не существует»', photo);
    ok(await gm.page.$eval('#btnGuildJoin', (e) => e.disabled) === true
      && await gm.page.$eval('#btnGuildLeave', (e) => e.disabled) === false,
      'участнику доступны «Выйти», но не «Вступить»');
    ok(await gm.page.$eval('#guildRole', (e) => /админ/.test(e.textContent)),
      'роль показана игроку текстом', await gm.page.$eval('#guildRole', (e) => e.textContent));

    // 9.2 — Обмен чести настоящим кликом: монеты не двигаются, буст продлевается.
    await gm.page.evaluate(() => { const S = window.NEON.state(); S.rdHonor = 60; S.rdLife = 60; S.boostUntil = 0; });
    await sleep(250);
    const hc0 = await gm.page.evaluate(() => Math.floor(window.NEON.state().coins));
    const ht0 = await gm.page.evaluate(() => Math.floor(window.NEON.state().total));
    await gm.page.click('#btnRaidRedeem');
    await sleep(400);
    const rs = await gm.page.evaluate(() => window.NEON.raid());
    ok(rs.honor === 55, 'честь списана ровно по стоимости (60 − 5)', rs.honor);
    ok(await gm.page.evaluate(() => window.NEON.state().boostUntil) > Date.now() + 14 * 60000,
      'куплено ВРЕМЯ буста ×2 на 15 минут', await gm.page.evaluate(() => window.NEON.state().boostUntil) - Date.now());
    ok(Math.floor(await gm.page.evaluate(() => Math.floor(window.NEON.state().coins))) === hc0
      && Math.floor(await gm.page.evaluate(() => Math.floor(window.NEON.state().total))) === ht0,
      'КРИТИЧНО: обмен чести не создал и не сжёг ни одной монеты', [hc0, ht0]);
    ok(flat(await gm.page.$eval('#raidHonor', (e) => e.textContent)) === '55',
      'баланс чести на вкладке обновился без перезагрузки', await gm.page.$eval('#raidHonor', (e) => e.textContent));
    ok(flat(await gm.page.$eval('#raidQuota', (e) => e.textContent)) === '1/2',
      'суточный лимит обменов отобразился как «осталось/всего»',
      await gm.page.$eval('#raidQuota', (e) => e.textContent));
    ok(await gm.page.$eval('#btnRaidRedeem', (e) => !e.disabled), 'второй обмен ещё доступен');
    await gm.page.click('#btnRaidRedeem');
    await sleep(400);
    ok(await gm.page.evaluate(() => window.NEON.raid().left) === 0
      && await gm.page.$eval('#btnRaidRedeem', (e) => e.disabled) === true,
      'лимит суток закрыт настоящим кликом: кнопка погасла', await gm.page.evaluate(() => window.NEON.raid()));
    ok(flat(await gm.page.$eval('#raidNote', (e) => e.textContent)).indexOf(flat('исчерпан')) > -1,
      'причина погасшей кнопки названа', await gm.page.$eval('#raidNote', (e) => e.textContent));
    const gCallsBefore = (await methods(gm.page)).filter((x) => /Ads|Share/.test(x)).length;
    await gm.page.click('#btnRaidRedeem');
    await sleep(250);
    ok((await methods(gm.page)).filter((x) => /Ads|Share/.test(x)).length === gCallsBefore,
      'обмен чести НЕ ходит в рекламный или шаринговый мост: это не точка монетизации');
    ok(gm.errs.length === 0, 'ошибок страницы нет', gm.errs);
    ok(await gm.page.evaluate(() => window.__vk.badParams.length) === 0,
      'запросы о сообществе соответствуют контракту vk-bridge', await gm.page.evaluate(() => window.__vk.badParams));
    await gm.page.close();

    // 9.3 — Вступление и выход настоящим кликом. Статус меняется ТОЛЬКО после
    //        подтверждения VK: до ответа моста «участник» рисовать нельзя.
    const jo = await scenario(browser, 'guildoutsider', GID);
    await waitProbe(jo.page);
    ok((await gOf(jo.page)).state === 2, 'VK ответил is_member=0 → gState=2 «не участник»', await gOf(jo.page));
    await jo.page.click('.tab[data-tab="guild"]');
    await sleep(250);
    ok(await jo.page.$eval('#guildState', (e) => e.textContent) === 'Не участник',
      'вкладке говорят правду, а не «ошибка»', await jo.page.$eval('#guildState', (e) => e.textContent));
    ok(await jo.page.$eval('#btnGuildJoin', (e) => !e.disabled), 'не-участнику доступна кнопка «Вступить»');
    await jo.page.evaluate(() => { const S = window.NEON.state(); S.rdHonor = 40; S.rdLife = 40; S.rdBest = 7; S.rdTries = 3; });
    await jo.page.click('#btnGuildJoin');
    await jo.page.waitForFunction(() => window.NEON.guild().state === 1 && !window.NEON.guild().busy, { timeout: 8000 });
    ok((await methods(jo.page)).filter((x) => x === 'VKWebAppJoinGroup').length === 1,
      'вступление стоило ровно одного вызова VKWebAppJoinGroup', (await methods(jo.page)).filter((x) => /Group/.test(x)));
    ok(await toastHas(jo.page, 'Ты в гильдии'), 'успешное вступление подтверждено игроку', await toastAll(jo.page));
    ok((await gOf(jo.page)).state === 1, 'статус переехал в «участник» только после подтверждения VK');
    const jb = await gOf(jo.page);
    ok(jb.probed === true && jb.busy === false, 'занятость снята после ответа моста', jb);
    // Выход не должен отнять уже заработанное (инвариант 3).
    await jo.page.click('#btnGuildLeave');
    await jo.page.waitForFunction(() => window.NEON.guild().state === 2 && !window.NEON.guild().busy, { timeout: 8000 });
    const after = await jo.page.evaluate(() => Object.assign({}, window.NEON.state()));
    ok(after.gState === 2, 'выход подтверждён VK и отражён в статусе', after.gState);
    ok(Math.floor(after.rdHonor) === 40 && Math.floor(after.rdLife) === 40
      && Math.floor(after.rdBest) === 7 && after.rdTries === 3,
      'КРИТИЧНО: выход НЕ отнял ни чести, ни звания, ни счётчика недель — наказывать за решение, которое платформа разрешает менять, нельзя',
      [Math.floor(after.rdHonor), Math.floor(after.rdLife), Math.floor(after.rdBest), after.rdTries]);
    ok(await toastHas(jo.page, 'Накопленная честь и звание остались'),
      'выход объясняет, что уже заработанное сохранено', await toastAll(jo.page));
    ok(jo.errs.length === 0, 'ошибок страницы при вступлении/выходе нет', jo.errs);
    await jo.page.close();

    // 9.4 — Отказ моста: VK отклонил запрос о сообществе.
    const jr = await scenario(browser, 'guildrefuse', GID);
    await waitProbe(jr.page);
    ok((await gOf(jr.page)).state === 0, 'отказ VKWebAppGetGroupInfo → «не проверено», а не «не участник»',
      await gOf(jr.page));
    await jr.page.click('.tab[data-tab="guild"]');
    await sleep(250);
    await jr.page.click('#btnGuildJoin');
    await sleep(600);
    ok(await toastHas(jr.page, 'отклонил'), 'отказ вступления назван игроком', await toastAll(jr.page));
    ok((await gOf(jr.page)).state === 0, 'отклонённое вступление не изменило статус', await gOf(jr.page));
    ok(await jr.page.$eval('#btnGuildJoin', (e) => !e.disabled),
      'после отказа кнопка снова активна: игрок может попробовать ещё раз');
    ok(jr.errs.length === 0, 'отказ моста не уронил страницу', jr.errs);
    await jr.page.close();

    // 9.5 — Таймаут: VK молчит дольше T_GUILD (6 с). Игра обязана дождаться и
    //        жить дальше, а не зависнуть с «Проверяем…» навсегда.
    const jt = await scenario(browser, 'guildtimeout', GID);
    await jt.page.click('.tab[data-tab="guild"]');
    await jt.page.waitForFunction(() => window.NEON.guild().busy, { timeout: 4000 });
    ok(await jt.page.$eval('#guildState', (e) => e.textContent) === 'Проверяем…',
      'пока VK думает, статус помечен процессом, а не выдуманным результатом',
      await jt.page.$eval('#guildState', (e) => e.textContent));
    const tw0 = Date.now();
    await waitProbe(jt.page);
    const waited = Date.now() - tw0;
    ok(waited >= 5500, 'запрос действительно дождался таймаута моста, а не отвалился сразу', waited);
    ok((await gOf(jt.page)).state === 0, 'таймаут → «не проверено» (без штрафа и без выдуманного участия)',
      await gOf(jt.page));
    ok(await jt.page.evaluate(() => window.NEON.raid().week) > 0,
      'рейд обслужен даже при мёртвом запросе о сообществе', await jt.page.evaluate(() => window.NEON.raid()));
    ok(jt.errs.length === 0, 'таймаут не уронил страницу', jt.errs);
    await jt.page.close();

    // 9.6 — Мусор в ответе: ни имени, ни screen_name. «Гильдию #0» рисовать нельзя.
    for (const bad of ['guildmalformed', 'guildempty']) {
      const jx = await scenario(browser, bad, GID);
      await waitProbe(jx.page);
      const gx = await gOf(jx.page);
      ok(gx.state === 0 && gx.name === '',
        '[' + bad + '] ответ без валидных полей не стал данными: имя пустое, статус «не проверено»', gx);
      await jx.page.click('.tab[data-tab="guild"]');
      await sleep(250);
      const ph = await jx.page.$eval('#guildPhoto', (e) => ({ hidden: e.hidden, src: e.getAttribute('src') || '' }));
      ok(ph.hidden === true && ph.src.indexOf('javascript') === -1,
        '[' + bad + '] фото не показано и в img.src не попало ничего чужого', ph);
      ok(jx.errs.length === 0, '[' + bad + '] мусорный ответ не уронил страницу', jx.errs);
      await jx.page.close();
    }

    // 9.7 — Запуск НЕ из сообщества: гильдии нет, но вкладка жива и рейд идёт.
    //        Одна запись в roster — выбирать не из чего (пикер скрыт), поэтому
    //        единственный источник истины — vk_group_id из launch-параметров.
    const jn = await scenario(browser, 'guildmember');
    await waitProbe(jn.page);
    const gn = await gOf(jn.page);
    ok(gn.gid === 0 && gn.state === 0,
      'без vk_group_id гильдия не выдумывается: gid=0, статус «не проверено»', gn);
    await jn.page.click('.tab[data-tab="guild"]');
    await sleep(300);
    ok(await jn.page.$eval('#guildState', (e) => e.textContent) === 'Вне гильдии',
      'вкладка честно говорит «Вне гильдии»', await jn.page.$eval('#guildState', (e) => e.textContent));
    ok(await jn.page.$eval('#btnGuildJoin', (e) => e.disabled) === true
      && await jn.page.$eval('#btnGuildLeave', (e) => e.disabled) === true,
      'без гильдии обе кнопки членства выключены: нажимать не во что');
    ok(await jn.page.$eval('#guildPicker', (e) => e.hidden) === true,
      'пустой roster не показывается');
    ok(flat(await jn.page.$eval('#guildHint', (e) => e.textContent)).indexOf(flat('папки сообщества')) > -1,
      'подсказка объясняет, как попасть в гильдию', await jn.page.$eval('#guildHint', (e) => e.textContent));
    ok((await methods(jn.page)).filter((x) => /GetGroupInfo/.test(x)).length === 0,
      'без id сообщества в мост не ходим: запрос о «гильдии #0» бессмысленен',
      (await methods(jn.page)).filter((x) => /Group/.test(x)));
    ok(await jn.page.evaluate(() => window.NEON.raid().week) > 0,
      'рейд живёт и вне гильдии: неделя обслужена, потери нет', await jn.page.evaluate(() => window.NEON.raid()));
    ok(jn.errs.length === 0, 'вкладка не упала вне сообщества', jn.errs);
    await jn.page.close();
  }
  /* ============ 10. БОЕВОЙ ЗАПУСК VK: НАСТОЯЩИЕ LAUNCH-ПАРАМЕТРЫ ============
     Сцены [1]…[9] говорят «мы в VK», поднимая isEmbedded() → true. Реальный запуск
     десктопного клиента приезжает другим набором: vk_app_id=6909581&vk_user_id=…
     &vk_platform=desktop_web&vk_ref=left_nav&vk_ts=… — и игра должна опознать себя
     в VK по нему, даже когда признак вложенности молчит (emb=0: мост отвечает, но
       VKWebAppIsEmbedded → false, как на странице, открытой в обычной вкладке).
     Смоук [12] разбирает эти строки на jsdom; здесь — настоящая загрузка страницы,
     настоящий мост и настоящие награды: ровно те параметры, что присылает VK. */
  log('\n[10] Боевые launch-параметры VK: desktop_web, сообщество, location_search');
  {
    const APP = '6909581';
    const GRP = '166562603';
    const U_APP = 'https://vk.com/app' + APP;
    const U_GRP = U_APP + '_-' + GRP;
    const REAL = 'vk_app_id=' + APP + '&vk_user_id=343080782&vk_platform=desktop_web'
      + '&vk_language=ru&vk_ref=left_nav&vk_ts=1792341397&vk_are_notifications_enabled=0'
      + '&vk_is_app_user=1&vk_is_favorite=1&sign=k';
    /** Открыть страницу с боевой строкой запуска и дождаться полной загрузки игры. */
    const openReal = async (query, scen) => {
      const pg = await browser.newPage();
      await pg.setViewport({ width: 1280, height: 800 });   // desktop_web, а не телефон
      const errs = [];
      pg.on('pageerror', (e) => errs.push(String(e && e.message)));
      await pg.evaluateOnNewDocument(MOCK);
      await pg.goto(BASE + '?vk=' + (scen || 'success') + '&debug=1&' + query, { waitUntil: 'domcontentloaded' });
      await pg.waitForFunction(() => window.VK && window.NEON && document.getElementById('tabShop'), { timeout: 15000 });
      const inVK = await pg.evaluate(() => window.VK.ready);
      await sleep(250);
      return { pg, errs, inVK };
    };
    const links = (pg) => pg.evaluate(() => window.__vk.calls
      .filter((c) => c.method === 'VKWebAppShare').map((c) => c.params && c.params.link));

    // 10.1 — обычный запуск из левого меню десктопа.
    const r1 = await openReal(REAL);
    ok(r1.inVK === true, '10.1 боевой desktop_web-запуск распознан внутри VK', r1.inVK);
    ok(await r1.pg.evaluate(() => window.VK.isDemo()) === false, '10.1 демо-режим внутри VK выключен');
    const l1 = await r1.pg.evaluate(() => window.VK.shareLink());
    ok(l1 === U_APP, '10.1 ссылка для репоста собрана по vk_app_id', l1);
    const g1 = await r1.pg.evaluate(() => window.NEON.guild());
    ok(g1.gid === 0, '10.1 без vk_group_id гильдия не выдумывается', g1);
    ok((await methods(r1.pg))[0] === 'VKWebAppInit', '10.1 первым ушёл обязательный VKWebAppInit',
      (await methods(r1.pg)).slice(0, 3));

    // 10.2 — монетизация на таком запуске идёт через мост VK, а не через демо-ветку.
    await r1.pg.click('.tab[data-tab="bonus"]');
    await sleep(200);
    const q0 = await coins(r1.pg);
    await r1.pg.click('#btnCoins');
    await sleep(1800);
    const q1 = await coins(r1.pg);
    ok(Math.round(q1 - q0) === 1000, '10.2 награда на боевом запуске выплачена', [q0, q1]);
    const ads1 = await r1.pg.evaluate(() => window.__vk.calls
      .filter((c) => /NativeAds$/.test(c.method))
      .map((c) => c.method + ':' + (c.params && c.params.ad_format)));
    ok(ads1.indexOf('VKWebAppCheckNativeAds:reward') > -1 && ads1.indexOf('VKWebAppShowNativeAds:reward') > -1,
      '10.2 check и show отправлены с ad_format=reward', ads1);
    const bp1 = await r1.pg.evaluate(() => window.__vk.badParams);
    ok(bp1.length === 0, '10.2 мост не получил параметров не по контракту', bp1);
    ok(r1.errs.length === 0, '10.1–10.2 ошибок страницы нет', r1.errs);
    await r1.pg.close();




    // 10.3 — запуск из папки сообщества. vk_group_id приезжает ПОЛОЖИТЕЛЬНЫМ, а
    //        каноническая ссылка сообщества — с отрицательным суффиксом: скопируй
    //        её как есть, и репост уедет в личное приложение вместо гильдии.
    const r3 = await openReal(REAL + '&vk_group_id=' + GRP + '&vk_viewer_group_role=member');
    const l3 = await r3.pg.evaluate(() => window.VK.shareLink());
    ok(l3 === U_GRP, '10.3 ссылка сообщества собрана с отрицательным суффиксом', l3);
    const g3 = await r3.pg.evaluate(() => window.NEON.guild());
    ok(g3.gid === Number(GRP) && g3.role === 'member', '10.3 сообщество и роль взяты из launch-параметров', g3);
    await r3.pg.click('.tab[data-tab="bonus"]');
    await sleep(200);
    await r3.pg.click('#btnShare');
    await sleep(700);
    const sl3 = await links(r3.pg);
    ok(sl3.indexOf(U_GRP) > -1, '10.3 другу уехала ссылка сообщества, а не личного приложения', sl3);
    await r3.pg.click('.tab[data-tab="guild"]');
    await sleep(1500);
    const gn3 = await r3.pg.$eval('#guildName', (e) => e.textContent);
    ok(flat(gn3) === flat('Гильдия «Неон»'), '10.3 карточка гильдии доехала на боевом запуске', gn3);
    const bp3 = await r3.pg.evaluate(() => window.__vk.badParams);
    ok(bp3.length === 0, '10.3 контрактов шеринга и гильдии не нарушили', bp3);
    ok(r3.errs.length === 0, '10.3 ошибок страницы нет', r3.errs);
    await r3.pg.close();

    // 10.4 — тот же запуск, но признака вложенности нет (emb=0): остаётся разбор
    //        строки запуска. Не опознай мы его — награда просто не была бы выплачена,
    //        так что этот клик и есть проверка ветки looksLikeVKLaunch().
    const r4 = await openReal(REAL + '&emb=0');
    ok(r4.inVK === true && await r4.pg.evaluate(() => window.VK.isDemo()) === false,
      '10.4 VK распознан по одним launch-параметрам', r4.inVK);
    await r4.pg.click('.tab[data-tab="bonus"]');
    await sleep(200);
    const d0 = await coins(r4.pg);
    await r4.pg.click('#btnCoins');
    await sleep(1800);
    const d1 = await coins(r4.pg);
    ok(Math.round(d1 - d0) === 1000, '10.4 на разборе параметров награда тоже выплачена', [d0, d1]);
    const l4 = await r4.pg.evaluate(() => window.VK.shareLink());
    ok(l4 === U_APP, '10.4 ссылка не зависит от способа распознавания VK', l4);
    ok(r4.errs.length === 0, '10.4 ошибок страницы нет', r4.errs);
    await r4.pg.close();

    // 10.5 — куда складывает параметры сам клиент: location_search и хэш ссылки.
    const r5 = await openReal('emb=0&location_search=' + encodeURIComponent('?' + REAL));
    const l5 = await r5.pg.evaluate(() => window.VK.shareLink());
    ok(r5.inVK === true && l5 === U_APP, '10.5 параметры в location_search прочитаны', [r5.inVK, l5]);
    await r5.pg.close();
    const r6 = await openReal('emb=0#/?' + REAL);
    const l6 = await r6.pg.evaluate(() => window.VK.shareLink());
    ok(r6.inVK === true && l6 === U_APP, '10.5 параметры из хэша (прямая ссылка, QR) прочитаны', [r6.inVK, l6]);
    await r6.pg.close();

    // 10.6 — контрольные: не принять за VK чужое и не звать рекламу вне VK.
    const neg = [
      ['vk_platform=web_external&vk_user_id=343080782&emb=0', '*_external = запуск ВНЕ VK'],
      ['platform=mobile&user_id=5&emb=0', 'чужие короткие имена — не признак VK']
    ];
    for (const [q, why] of neg) {
      const n = await openReal(q);
      const s6 = await n.pg.evaluate(() => ({ vk: window.VK.isVK(), demo: window.VK.isDemo(), link: window.VK.shareLink() }));
      ok(n.inVK === false && s6.vk === false && s6.link === null,
        '10.6 не приняли за VK: ' + why, s6);
      const adN = (await methods(n.pg)).filter((x) => /NativeAds$/.test(x)).length;
      ok(adN === 0, '10.6 вне VK рекламу не зовём (' + why + ')', adN);
      await n.pg.close();
    }
  }


  console.log('\n  браузер: ' + EXE);
  console.log('========== VK-СЦЕНАРИИ: ' + passed + ' ok / ' + failed + ' fail ==========');
  await browser.close();
  console.log('');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
