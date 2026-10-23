/* ==========================================================================
 * .smoke-test.cjs — смоук-тест NEON CLICK (не входит в релиз игры).
 * Поднимает DOM-окно в jsdom, исполняет vk-integration.js + game.js и проверяет
 * ключевые механики: клики, комбо, магазин, пассив, сейвы, офлайн, монетизацию.
 * Запуск:  npm i jsdom  &&  node .smoke-test.cjs
 * ======================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = __dirname;
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const VK_SRC = fs.readFileSync(path.join(ROOT, 'vk-integration.js'), 'utf8');
const GAME_SRC = fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8');
const SAVE_KEY = 'neonclick.save.v1';

/* ★ ДЕМО-СБОРКА — принадлежность тестов, а не релиза.
   vk-integration.js хранит флаг выключенным: включённый там «true» означает
   публичную игру, выдающую награды без единого показанного ролика. Локальным
   прогонам ветка наград нужна, поэтому демо включается подменой исходника и
   умирает вместе с прогоном. Якорь — ровно одно объявление флага: если в
   репозитории снова «true», подмена не находит цели и бросает, а не молча
   тестирует не ту сборку. */
function withDemo(src) {
  const RE = /\bconst\s+DEMO_MODE\s*=\s*false\s*;/g;
  const n = (src.match(RE) || []).length;
  if (n !== 1) {
    throw new Error('ожидал ровно одно «DEMO_MODE = false» в vk-integration.js, нашёл ' + n +
      ' — либо флаг снова включён в репозитории, либо формат объявления сменился');
  }
  return src.replace(RE, 'const DEMO_MODE = true;');
}
let DEMO_ERR = null;
let VK_SRC_DEMO = VK_SRC;
try { VK_SRC_DEMO = withDemo(VK_SRC); } catch (e) { DEMO_ERR = e.message; }
const THIN = '\u2009';

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('   \u2705 ' + name); }
  else { fail++; console.log('   \u274c ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const grp = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, THIN);

/** Собирает «окно» с игрой: тот же HTML, те же скрипты, что и в браузере. */
async function makeGame(opts) {
  const o = opts || {};
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => console.log('   [jsdomError] ' + e.message));
  const dom = new JSDOM(HTML, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: o.url || 'https://app.neonclick.local/?debug=1',
    virtualConsole: vc
  });
  const w = dom.window;
  if (o.vkBridge) w.vkBridge = o.vkBridge;   // подсадка мока VK Bridge до инициализации
  if (o.seed) w.localStorage.setItem(SAVE_KEY, JSON.stringify(o.seed));
  await sleep(20);                           // документ -> complete
  w.eval(o.demo ? VK_SRC_DEMO : VK_SRC);
  w.eval(GAME_SRC);
  await sleep(o.settle == null ? 120 : o.settle);
  return { dom: dom, w: w, d: w.document };
}

/* Копия FNV-1a и соли из game.js: нужна, чтобы собирать СОВЕРШЕННО ВАЛИДНЫЕ
   пакеты/сейвы СТАРОЙ схемы v1 и проверять миграцию на настоящих данных,
   а не на «как бы валидных» заглушках. */
const SIGN_SALT_STR = 'neonclick.v1.a7f3';
function fnv1aHex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

const freshSeed = (over) => Object.assign({
  v: 1, coins: 0, total: 0, clicks: 0, upClick: 0, upAuto: 0,
  boostUntil: 0, watched: 0, sound: true, lastSeen: Date.now()
}, over || {});
/* Независимая реализация подписи v4: порядок полей продублирован здесь НАМЕРЕННО.
   Если game.js вставит новое поле в СЕРЕДИНУ signatureOf или переставит старые,
   хелпер продолжит считать по-своему, честный сейв получит расхождение и susp —
   то есть нарушение аддитивности станет видимым, а не молчаливым. Ровно этот
   класс ошибок недопустим: обновление не имеет права обвинить игрока в чита. */
function signV4(d) {
  d.sig = fnv1aHex(SIGN_SALT_STR + '|' + [
    d.v, d.coins, d.total, d.clicks, d.upClick, d.upAuto, d.boostUntil, d.watched,
    d.susp, d.t0, d.lastSeen,
    d.shares, d.shareDay, d.shareN,
    d.riskDay, d.riskN, d.riskWins, d.riskLoss, d.riskBurned, d.rpStake, d.rpWon, d.rpIdx,
    d.gid, d.gState, d.rdWeek, d.rdEarned, d.rdHonor, d.rdBest, d.rdTries, d.rdLife,
    d.rdRedeemed, d.rdRedN
  ].join(','));
  return d;
}

/** Индекс календарной недели UTC — повторён из game.js намеренно (см. signV4). */
const WEEK = () => Math.floor(Date.now() / 604800000);

/* Сейв нынешней (v4) схемы со всеми полями. rdWeek по умолчанию — ТЕКУЩАЯ неделя:
   иначе boot() закроет её до первых же проверок и обнулит журнал, который тест
   собирался читать. */
const seedV4 = (over) => signV4(Object.assign({
  v: 4, coins: 0, total: 0, clicks: 0, upClick: 0, upAuto: 0,
  boostUntil: 0, watched: 0, sound: true, susp: 0,
  t0: Date.now() - 86400000, lastSeen: Date.now(),
  shares: 0, shareDay: 0, shareN: 0,
  riskDay: 0, riskN: 0, riskWins: 0, riskLoss: 0, riskBurned: 0,
  rpStake: 0, rpWon: 0, rpIdx: 0,
  gid: 0, gState: 0, rdWeek: WEEK(), rdEarned: 0, rdHonor: 0,
  rdBest: 0, rdTries: 0, rdLife: 0, rdRedeemed: 0, rdRedN: 0
}, over || {}));


/* Мок клиента VK: управляемые ответы VKWebAppCheckNativeAds / ShowNativeAds. */
function mockBridge(cfg) {
  const c = Object.assign({ fill: true, type: 'success', errorCode: 0 }, cfg || {});
  const calls = [];
  const subs = [];
  return {
    calls: calls,
    subs: subs,
    /* embedded:false подставляет клиент, который НЕ поднял признак WebView
       (обычный браузер с открытой ссылкой vk.com/app… либо VK мостом, где
       isEmbedded() не сработал). Тогда остаётся разбор launch-параметров. */
    isEmbedded: () => c.embedded !== false,
    supports: () => true,
    supportsAsync: async () => true,
    /* Подписка настоящая: показ рекламы клиент вправе вести лестницей сообщений
       (loading → opened → closed), и именно по подписке эти сообщения приезжают.
       Пустой заглушкой проверить «досмотренный ролик → награда» было бы нельзя. */
    subscribe: (f) => { subs.push(f); },
    unsubscribe: (f) => { const i = subs.indexOf(f); if (i >= 0) subs.splice(i, 1); },
    send: async (name, params) => {
      /* ★ КОНТРАКТ РЕКЛАМЫ (vk-bridge 3.x): ShowNativeAdsRequest/CheckNativeAdsRequest
         несут поле ad_format. Запрос с чужим именем параметра настоящий клиент VK
         считает недействительным и рекламу не отдаёт — мок воспроизводит это,
         иначе баг «зовём поле format» прошёл бы мимо всех 75 проверок. */
      const isAd = /NativeAds$/.test(name);
      const adOk = !isAd || (params && params.ad_format === 'reward');
      calls.push(name + (params && params.ad_format ? ':' + params.ad_format : (isAd && !adOk ? ':BAD_PARAM(' + JSON.stringify(params || null) + ')' : (params && params.link ? ':' + params.link : ''))));
      if (name === 'VKWebAppCheckNativeAds') return { result: !!(adOk && c.fill) };
      if (name === 'VKWebAppShowNativeAds') {
        if (!adOk) { const e = new Error('invalid ad_format'); e.error_data = { error_code: 3, error_reason: 'mock' }; throw e; }
        if (!c.fill) return { type: 'failed' };
        if (c.errorCode) { const e = new Error('ads error'); e.error_data = { error_code: c.errorCode }; throw e; }
        /* ladder — тот самый многоступенчатый ответ: промис send закрывается
           ПЕРВЫМ сообщением (так делает вендорный vk-bridge 3.0.2), остальные
           приезжают подписчикам. Мок воспроизводит обе половины, иначе лестница
           в тестах не существовала бы вовсе. */
        if (c.ladder) {
          setTimeout(() => {
            subs.slice().forEach((f) => c.ladder.slice(1).forEach((t) => {
              f({ detail: { type: 'VKWebAppShowNativeAds', data: { type: t } } });
            }));
          }, 20);
          return { type: c.ladder[0] };
        }
        return { type: c.type };
      }
      /* ★ КОНТРАКТ ШЕРИНГА: ответ LinkShareResult[] (пустой массив = отказ).
         Возвращаем ровно форму из vk-bridge 3.x, а не true: иначе проверка
         «награда за репост только за фактический шеринг» тестировалась бы на вымысле. */
      if (name === 'VKWebAppShare') {
        if (!params || typeof params.link !== 'string' || !/^https?:\/\//.test(params.link)) {
          const e = new Error('invalid link'); e.error_data = { error_code: 3 }; throw e;
        }
        return c.share === 'decline' ? [] : [{ type: 'post', post_id: '1' }];
      }
      return { type: name };
    }
  };
}
/* Мок «обычного браузера»: SDK VK Bridge загрузился, но мы НЕ внутри клиента VK. */
function mockOutsideBridge() {
  return {
    calls: [],
    isEmbedded: () => false,
    supports: () => false,
    supportsAsync: async () => false,
    subscribe: () => {},
    send: async (name) => { this.calls.push(name); return { type: name }; }
  };
}

(async () => {
  console.log('\n============ NEON CLICK :: smoke test ============\n');

  /* -------- СЦЕНАРИЙ 0. Инвариант публикуемой сборки -------- */
  console.log('[0] Сборка: DEMO_MODE в репозитории выключен');
  /* Дыра №1 мини-приложения-кликера: наградные кнопки работают без рекламы.
     Проверяем не «поверим на слово», а по тексту файла, который уйдёт к игроку. */
  ok(!/const\s+DEMO_MODE\s*=\s*true\s*;/.test(VK_SRC),
    'в vk-integration.js нет включённого флага демо-режима');
  ok(/const\s+DEMO_MODE\s*=\s*false\s*;/.test(VK_SRC),
    'в vk-integration.js флаг объявлен выключенным — собирать можно');
  ok(DEMO_ERR === null, 'демо-сборка для тестов корректно подставляется из боевой', DEMO_ERR);
  ok(VK_SRC_DEMO !== VK_SRC && /const\s+DEMO_MODE\s*=\s*true\s*;/.test(VK_SRC_DEMO),
    'демо-сборка отличается от репозиторной и существует только в прогоне');

  /* -------- СЦЕНАРИЙ 0b. Статический контракт DOM ↔ JS ↔ CSS --------
     Дыра, которую не видит ни один прогон с jsdom: узел переименован в разметке,
     a $('old') возвращает null — и рендерер с guard'ом молча ничего не рисует.
     То же для класса: toggle('is-member') без правила в style.css — это «работает,
     но не видно». Проверяем по исходникам, которые уйдут к игроку. */
  {
    const htmlIds = (HTML.match(/id="([A-Za-z0-9_]+)"/g) || []).map((s) => s.slice(4, -1));
    const dupIds = htmlIds.filter((x, i) => htmlIds.indexOf(x) !== i);
    ok(dupIds.length === 0, 'в index.html нет повторяющихся id (дубль ломает $() тихо)', dupIds);

    const refs = [...new Set((GAME_SRC.match(/\$\('([A-Za-z0-9_]+)'\)/g) || [])
      .map((s) => s.slice(3, -2)))];
    const missing = refs.filter((x) => htmlIds.indexOf(x) < 0);
    ok(missing.length === 0, 'каждый $(\'id\') из game.js существует в index.html', missing);
    ok(refs.length >= 80, 'каркас ссылок на DOM не схлопнулся (проверка не стала пустой)', refs.length);

    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    // Классы, которыми game.js управляет на новых карточках, и классы самой
    // разметки вкладки. Правило обязано быть: toggle без CSS — невидимый баг.
    const touched = new Set();
    (GAME_SRC.match(/classList\.(?:add|remove|toggle)\('([a-z0-9_-]+)'/g) || [])
      .forEach((s) => touched.add(/'([a-z0-9_-]+)'$/.exec(s)[1]));
    const guildBlock = /<div class="tabbody" id="tabGuild"[\s\S]*?<\/div>\s*<\/section>/.exec(HTML);
    ok(!!guildBlock, 'вкладка «Гильдия» найдена в разметке (иначе проверка ниже пуста)');
    if (guildBlock) {
      (guildBlock[0].match(/class="([^"]+)"/g) || [])
        .forEach((s) => s.slice(7, -1).split(/\s+/).forEach((c) => { if (c) touched.add(c); }));
    }
    const noCss = [...touched].filter((c) => css.indexOf('.' + c) < 0);
    ok(noCss.length === 0, 'у каждого используемого класса есть правило в style.css', noCss);
  }


  /* -------- СЦЕНАРИЙ 1. Обычный запуск (браузер, демо-режим) -------- */

  console.log('[1] Boot, кликер, комбо');
  const g = await makeGame({ vkBridge: mockOutsideBridge(), demo: true });
  const { w, d } = g;
  const S = () => w.NEON.state();

  ok(typeof w.VK === 'object' && typeof w.VK.showRewardedAd === 'function', 'window.VK API собран');
  ok(w.VK.isDemo() === true && w.VK.isVK() === false, 'вне VK включён демо-режим');
  ok(!!w.NEON, 'game.js инициализировался');
  ok(S().coins === 0 && S().upClick === 0 && S().upAuto === 0, 'новый игрок стартует с нуля');
  ok(d.getElementById('balance').textContent === '0', 'HUD показывает 0', d.getElementById('balance').textContent);

  for (let i = 0; i < 6; i++) w.NEON.tap(120, 120);
  ok(S().coins >= 6 && S().clicks === 6, '6 тапов = 6+ монет, клики учтены', [S().coins, S().clicks]);
  ok(d.getElementById('combo').hidden === false, 'комбо-индикатор появился');
  ok(d.getElementById('comboX').textContent === '\u00d71.06', 'множитель комбо \u00d71.06', d.getElementById('comboX').textContent);
  ok(d.querySelectorAll('#floats .float').length >= 6, 'всплывающие «+N» отрисованы', d.querySelectorAll('#floats .float').length);
  await sleep(1400);
  ok(S().coins >= 6, 'монеты не потерялись после паузы');
  ok(d.getElementById('combo').hidden === true, 'комбо свернулось после паузы');

  /* -------- Магазин -------- */
  console.log('\n[2] Магазин апгрейдов');
  d.getElementById('buyAuto').dispatchEvent(new w.MouseEvent('click'));
  ok(S().upAuto === 0, 'покупка без монет отклонена');
  ok(d.getElementById('cardAuto').classList.contains('is-deny'), 'карточка отреагировала отказом');
  ok(/Не хватает/.test(d.getElementById('toasts').textContent), 'показан текст нехватки', d.getElementById('toasts').textContent);

  w.NEON.add(1000);
  const before = S().coins;
  d.getElementById('buyAuto').dispatchEvent(new w.MouseEvent('click'));
  ok(S().upAuto === 1, '«Авто-майнинг» куплен');
  ok(before - S().coins === 250, 'списано ровно 250', before - S().coins);
  ok(d.getElementById('autoCost').textContent === grp(295), 'цена следующего уровня 295', d.getElementById('autoCost').textContent);
  ok(d.getElementById('autoLevel').textContent === 'Ур. 1', 'уровень подписан', d.getElementById('autoLevel').textContent);
  ok(d.getElementById('perSecond').textContent === '+5', 'пассив +5/сек', d.getElementById('perSecond').textContent);

  const c2 = S().coins;
  d.getElementById('buyClick').dispatchEvent(new w.MouseEvent('click'));
  ok(S().upClick === 1 && c2 - S().coins === 50, '«Сила клика» куплена за 50', [S().upClick, c2 - S().coins]);
  ok(d.getElementById('perClick').textContent === '+2', 'сила тапа +2', d.getElementById('perClick').textContent);
  ok(d.getElementById('statUpgrades').textContent === '2', 'статистика апгрейдов', d.getElementById('statUpgrades').textContent);

  /* -------- Пассив -------- */
  console.log('\n[3] Пассивный доход');
  const p0 = S().coins;
  await sleep(1200);
  const gained = S().coins - p0;
  ok(gained > 3 && gained < 9, 'авто-майнинг капает ~5 монет/сек', gained);
  /* -------- Монетизация (демо-перехват) -------- */
  console.log('\n[4] Монетизация: rewarded ads (демо)');
  await sleep(1300);   // ждём резолва VK.ready + обновления подсказки
  ok(/Демо-режим/.test(d.getElementById('adNote').textContent), 'подсказка объясняет демо-режим', d.getElementById('adNote').textContent);
  ok(d.getElementById('bonusDot').classList.contains('is-on'), 'на табе «Бонусы» горит точка наград');

  const cb = S().coins;
  d.getElementById('btnCoins').dispatchEvent(new w.MouseEvent('click'));
  ok(d.getElementById('coinsCta').textContent === 'Ждём\u2026', 'CTA в состоянии загрузки', d.getElementById('coinsCta').textContent);
  await sleep(1700);
  ok(S().coins - cb >= 1000, 'награда +1000 монет выдана', [cb, S().coins]);
  ok(S().watched === 1, 'счётчик просмотров вырос', S().watched);
  ok(d.getElementById('coinsCta').textContent === 'Реклама', 'CTA вернулся в обычное состояние');
  ok(/Начислено 1\s000 монет/.test(d.getElementById('toasts').textContent), 'тост о награде показан', d.getElementById('toasts').textContent);

  d.getElementById('btnCoins').dispatchEvent(new w.MouseEvent('click'));
  await sleep(150);
  ok(S().watched === 1, 'кулдаун защищает от двойного показа');

  d.getElementById('btnDouble').dispatchEvent(new w.MouseEvent('click'));
  await sleep(1700);
  ok(S().boostUntil > Date.now() + 4 * 60000, 'буст ×2 активен ~5 минут', S().boostUntil - Date.now());
  ok(d.getElementById('perSecond').textContent === '+10', 'пассив удвоился до 10/сек', d.getElementById('perSecond').textContent);
  ok(d.getElementById('boost').hidden === false, 'плашка буста видна');
  ok(/^\d:\d\d$/.test(d.getElementById('boostTime').textContent), 'таймер буста в формате M:SS', d.getElementById('boostTime').textContent);

  /* -------- LocalStorage -------- */
  console.log('\n[5] Сохранение прогресса');
  await sleep(1200);   // один такт автосейва (CFG.saveEveryMs = 1000)
  const rawSaved = w.localStorage.getItem(SAVE_KEY);
  ok(!!rawSaved, 'сейв появился в LocalStorage без явного вызова');
  const saved = JSON.parse(rawSaved || '{}');
  ok(saved.v === 5 && saved.upAuto === 1 && saved.upClick === 1, 'схема сейва v5 и уровни записаны', saved);
  ok(['vipUntil', 'vipDay'].every((k) => typeof saved[k] === 'number' && saved[k] >= 0),
    'поля VIP лежат в сейве (иначе подпись v5 их не покрывает, а срок не переживёт рестарт)', saved);
  ok(['shares', 'shareDay', 'shareN'].every((k) => typeof saved[k] === 'number' && saved[k] >= 0),
    'поля репоста действительно лежат в сейве (иначе подпись v2 их не покрывает)', saved);
  ok(['riskDay', 'riskN', 'riskWins', 'riskLoss', 'riskBurned', 'rpStake', 'rpWon', 'rpIdx']
    .every((k) => typeof saved[k] === 'number' && saved[k] >= 0),
    'поля риск-раунда лежат в сейве (иначе подпись v3 их не покрывает, а write-ahead не переживёт рестарт)', saved);
  ok(['gid', 'gState', 'rdWeek', 'rdEarned', 'rdHonor', 'rdBest', 'rdTries', 'rdLife', 'rdRedeemed', 'rdRedN']
    .every((k) => typeof saved[k] === 'number' && saved[k] >= 0),
    'поля гильдии и рейда лежат в сейве (иначе подпись v4 их не покрывает, а честь недели не переживёт рестарт)', saved);
  ok(Math.abs(saved.coins - S().coins) < 12, 'баланс в сейве совпадает с игрой', [saved.coins, S().coins]);
  ok(typeof saved.lastSeen === 'number' && saved.lastSeen <= Date.now(), 'записано время выхода', saved.lastSeen);
  ok(saved.boostUntil > 0, 'срок буста тоже сохраняется', saved.boostUntil);

  /* -------- Офлайн-доход и ранги -------- */
  console.log('\n[6] Офлайн-доход, звания, форматирование');
  const g2 = await makeGame({
    vkBridge: mockOutsideBridge(),
    seed: freshSeed({ coins: 100, total: 5000, upAuto: 2, lastSeen: Date.now() - 3600 * 1000 })
  });
  const S2 = () => g2.w.NEON.state();
  await sleep(700);
  const offGain = S2().coins - 100;
  ok(offGain > 17000 && offGain < 19000, 'офлайн за 1 час ≈ 18000 монет (50% эффективности)', offGain);
  ok(/авто-майнинг принёс/.test(g2.d.getElementById('toasts').textContent), 'тост об офлайн-доходе', g2.d.getElementById('toasts').textContent);
  ok(S2().coins >= 1e4, 'баланс перешагнул 10К', S2().coins);
  ok(g2.d.getElementById('balance').textContent === grp(Math.floor(S2().coins)), 'баланс разбит тонким пробелом', g2.d.getElementById('balance').textContent);
  ok(g2.d.getElementById('rankName').textContent === 'Мастер', 'звание повысилось до «Мастер»', g2.d.getElementById('rankName').textContent);
  ok(/до «Профи»/.test(g2.d.getElementById('rankHint').textContent), 'подсказка о следующем звании', g2.d.getElementById('rankHint').textContent);
  g2.dom.window.close();
  /* -------- Интерфейс -------- */
  console.log('\n[7] Интерфейс: табы, звук, сброс');
  const tabBonus = d.querySelector('.tab[data-tab="bonus"]');
  const tabShop = d.querySelector('.tab[data-tab="shop"]');
  tabBonus.dispatchEvent(new w.MouseEvent('click'));
  ok(d.getElementById('tabBonus').hidden === false && d.getElementById('tabShop').hidden === true, 'таб «Бонусы» открыт');
  ok(tabBonus.classList.contains('is-active') && !tabShop.classList.contains('is-active'), 'активный таб подсвечен');
  tabShop.dispatchEvent(new w.MouseEvent('click'));
  ok(d.getElementById('tabShop').hidden === false && d.getElementById('tabBonus').hidden === true, 'таб «Магазин» вернулся');

  /* Третий таб. Старая схема была бинарной («bonus или всё считается магазином»),
     поэтому здесь проверяется именно взаимная исключительность: видимой должна
     быть РОВНО ОДНА панель, иначе «Гильдия» молча показала бы магазин. */
  const tabGuild = d.querySelector('.tab[data-tab="guild"]');
  ok(!!tabGuild, 'таб «Гильдия» есть в разметке');
  const visiblePanels = () => ['tabShop', 'tabBonus', 'tabGuild']
    .filter((id) => d.getElementById(id).hidden === false);
  tabGuild.dispatchEvent(new w.MouseEvent('click'));
  ok(visiblePanels().join() === 'tabGuild', 'открыта ровно одна панель — «Гильдия»', visiblePanels());
  ok(tabGuild.classList.contains('is-active') && !tabShop.classList.contains('is-active')
    && !tabBonus.classList.contains('is-active'), 'подсвечен ровно один таб', [
    tabShop.classList.contains('is-active'), tabBonus.classList.contains('is-active'),
    tabGuild.classList.contains('is-active')]);
  tabBonus.dispatchEvent(new w.MouseEvent('click'));
  ok(visiblePanels().join() === 'tabBonus', '«Бонусы» закрыли «Гильдию»', visiblePanels());
  tabGuild.dispatchEvent(new w.MouseEvent('click'));
  ok(visiblePanels().join() === 'tabGuild', 'возврат в «Гильдию»', visiblePanels());
  // Неизвестное имя таба не должно оставить панель-призрак: фолбэк — магазин.
  w.NEON.switchTab('nope');
  ok(visiblePanels().join() === 'tabShop', 'неизвестное имя табa → фолбэк «Магазин», а не две панели', visiblePanels());
  w.NEON.switchTab('shop');

  d.getElementById('btnSound').dispatchEvent(new w.MouseEvent('click'));
  ok(S().sound === false && d.getElementById('btnSound').classList.contains('is-off'), 'звук выключен');
  ok(d.getElementById('btnSound').getAttribute('aria-pressed') === 'false', 'aria-pressed обновлён');
  d.getElementById('btnSound').dispatchEvent(new w.MouseEvent('click'));
  ok(S().sound === true, 'звук снова включён');

  d.getElementById('btnReset').dispatchEvent(new w.MouseEvent('click'));
  ok(d.getElementById('modal').hidden === false, 'открыто подтверждение сброса');
  d.getElementById('modalCancel').dispatchEvent(new w.MouseEvent('click'));
  ok(d.getElementById('modal').hidden === true && S().coins > 0, 'отмена ничего не удалила');
  d.getElementById('btnReset').dispatchEvent(new w.MouseEvent('click'));
  d.getElementById('modalOk').dispatchEvent(new w.MouseEvent('click'));
  ok(S().coins === 0 && S().upAuto === 0 && S().total === 0, 'прогресс сброшен', [S().coins, S().upAuto, S().total]);
  ok(d.getElementById('modal').hidden === true, 'модалка закрыта');
  ok(d.getElementById('balance').textContent === '0', 'HUD обнулился');
  g.dom.window.close();

  /* -------- СЦЕНАРИЙ 2. Настоящий клиент VK (мок VKBridge) -------- */
  console.log('\n[8] Монетизация внутри VK: успех и отказы');
  const VK_URL = 'https://app.neonclick.local/?vk_app_id=6089842&debug=1';

  // 8.1 — успешный просмотр
  const m1 = mockBridge({ fill: true, type: 'success' });
  const a = await makeGame({ url: VK_URL, vkBridge: m1, seed: freshSeed() });
  const A = () => a.w.NEON.state();
  await a.w.VK.ready;
  ok(a.w.VK.isVK() === true && a.w.VK.isDemo() === false, 'окружение распознано как VK (не демо)');
  ok(m1.calls.indexOf('VKWebAppInit') >= 0, 'обязательный VKWebAppInit отправлен', m1.calls);
  ok(a.d.getElementById('bonusDot').classList.contains('is-on'), 'точка наград горит при наличии заполнения');
  ok(/Награда выдаётся/.test(a.d.getElementById('adNote').textContent), 'подсказка про награду', a.d.getElementById('adNote').textContent);

  a.d.getElementById('btnCoins').dispatchEvent(new a.w.MouseEvent('click'));
  await sleep(400);
  ok(A().coins === 1000, 'VK: +1000 монет за досмотренный ролик', A().coins);
  ok(m1.calls.indexOf('VKWebAppCheckNativeAds:reward') >= 0, 'сначала запрошен VKWebAppCheckNativeAds');
  ok(m1.calls.indexOf('VKWebAppShowNativeAds:reward') >= 0, 'затем вызван VKWebAppShowNativeAds(format=reward)');
  /* --- шеринг: контракт VKWebAppShare --- */
  ok(a.w.VK.shareLink() === 'https://vk.com/app6089842',
    'ссылка для репоста — канонический vk.com/app…, а не адрес хостинга', a.w.VK.shareLink());
  ok((await a.w.VK.share()) === true, 'VK.share: репост подтверждён (непустой LinkShareResult[])');
  ok(m1.calls.indexOf('VKWebAppShare:https://vk.com/app6089842') >= 0,
    'в мост ушла каноническая ссылка VK', m1.calls.filter((c) => /^VKWebAppShare/.test(c)));
  a.dom.window.close();

  // 8.1б — игрок закрыл диалог шаринга, не поделившись: ответ моста — пустой массив
  const m1b = mockBridge({ fill: true, type: 'success', share: 'decline' });
  const a1b = await makeGame({ url: VK_URL, vkBridge: m1b, seed: freshSeed() });
  await a1b.w.VK.ready;
  ok((await a1b.w.VK.share()) === false,
    'VK.share: отказ игрока распознан как false (пустой массив — truthy, ловушка)');
  a1b.d.getElementById('coin').dispatchEvent(new a1b.w.MouseEvent('click'));
  await sleep(50);
  ok(!/Спасибо за репост/.test(a1b.d.getElementById('toasts').textContent),
    'за отказ сообщение «Спасибо за репост» не показывается', a1b.d.getElementById('toasts').textContent);
  a1b.dom.window.close();

  // 8.1в — награда за репост: платим только за фактический шеринг и не больше perDay
  const m1c = mockBridge({ fill: true, type: 'success' });
  const c1 = await makeGame({ url: VK_URL, vkBridge: m1c, seed: freshSeed() });
  const C = () => c1.w.NEON.state();
  await c1.w.VK.ready;
  ok(c1.d.getElementById('btnShare') && /из 3/.test(c1.d.getElementById('shareNote').textContent),
    'карточка репоста показывает остаток суточного лимита', c1.d.getElementById('shareNote').textContent);
  const paid = [];
  for (let i = 0; i < 4; i++) {
    c1.w.NEON.clearCooldown();                       // суточный лимит проверяем без реального кулдауна
    const before = C().coins;
    c1.d.getElementById('btnShare').dispatchEvent(new c1.w.MouseEvent('click'));
    await sleep(120);
    paid.push(Math.round(C().coins - before));
  }
  ok(paid[0] === 500 && paid[1] === 500 && paid[2] === 500, 'три репоста в сутки оплачены по 500 монет', paid);
  ok(paid[3] === 0, 'четвёртый репост тех же суток НЕ оплачен: кран монет закручен', paid);
  ok(C().shares === 3 && C().shareN === 3, 'счётчики репостов выросли ровно на 3', [C().shares, C().shareN]);
  ok(/исчерпан/.test(c1.d.getElementById('toasts').textContent), 'игрок уведомлён об исчерпанном суточном лимите',
    c1.d.getElementById('toasts').textContent);
  ok(c1.d.getElementById('btnShare').classList.contains('is-spent'), 'карточка погасла: наград сегодня больше нет');
  ok(C().v === 5, 'схема состояния — v5 (поля VIP)');
  ok(c1.w.NEON.pack().split('#')[0].split('|').length === 35, 'облачный пакет v5 — 35 полей', c1.w.NEON.pack());

  /* --- Миграция схемы: пакет v1 (12 полей) обязан читаться. Иначе у всех уже
         играющих прогресс в VK обнулился бы в момент обновления. --- */
  const seen = c1.w.NEON.pack();
  const t0v1 = Date.now() - 86400000, nowV1 = Date.now();
  const v1Body = '1|800|900|50|3|2|0|4|1|0|' + t0v1 + '|' + nowV1;
  const v1Pack = v1Body + '#' + fnv1aHex(SIGN_SALT_STR + '#' + v1Body);
  const unp = c1.w.NEON.unpack(v1Pack);
  ok(!!(unp && unp.v === 1 && unp.shares === 0 && Math.floor(unp.coins) === 800 && unp.upAuto === 2),
    'облачный пакет v1 распакован без потерь (shares=0 — репостов ещё не было)', unp);
  ok(c1.w.NEON.unpack(v1Body + '#deadbeef') === null, 'пакет v1 с неверной подписью отклонён');
  ok(c1.w.NEON.unpack('6|1|2|3#' + fnv1aHex(SIGN_SALT_STR + '#6|1|2|3')) === null,
    'пакет чужой (будущей) версии схемы отклонён: подпись верна, не устраивает именно версия');
  ok(c1.w.NEON.unpack('3|1|2|3#' + fnv1aHex(SIGN_SALT_STR + '#3|1|2|3')) === null,
    'пакет известной версии с неверной длиной отклонён: v3 — это 23 поля, а не 4');
  ok(c1.w.NEON.unpack(seen) !== null, 'собственный пакет v5 проходит свою же проверку', seen);

  /* --- Сквозной round-trip собственной сборки -----------------------------
     Строкой выше этот блок начинался как «unpack(seen) !== null». Такой проверки
     не хватает ровно на один класс ошибок: она ловит ОТКАЗ пакета, но молчит про
     нули на его месте. Так и дожил до публикации баг схемы v4 — хвост гильдии
     прочитали условием isV4, а выражения выше остались «isV2 || isV3» и «isV3»,
     и собственный v4-пакет перестал узнавать поля репоста и риск-раунда:
     unpack возвращал осмысленный объект с нулями. Нули — это не «сейв не читается»,
     это «прогресс тихо сел»: shares входит в plausibleCap() как shareMax, поэтому
     вместе с репостами срезался и потолок законного прогресса честного игрока.
     Отсюда форма проверки: сравниваем ПОЛЯ, а не факт возврата не-null. --- */
  {
    const RT = {
      coins: 5000, total: 9000, clicks: 1234, upClick: 7, upAuto: 11,
      boostUntil: Date.now() + 300000, watched: 5, susp: 2,
      t0: Date.now() - 86400000, lastSeen: Date.now() - 1000,
      shares: 3, shareDay: 20748, shareN: 2,
      riskDay: 20748, riskN: 1, riskWins: 4, riskLoss: 2, riskBurned: 200,
      rpStake: 0, rpWon: 0, rpIdx: 1,
      gid: 242457640, gState: 1, rdWeek: 0, rdEarned: 4000, rdHonor: 30,
      rdBest: 12, rdTries: 5, rdLife: 60, rdRedeemed: 20748, rdRedN: 1,
      vipUntil: Date.now() + 7 * 86400000, vipDay: 20748
    };
    const S0 = c1.w.NEON.state();
    const snap = Object.assign({}, S0);
    RT.rdWeek = c1.w.NEON.raid().now;      // журнал ведётся ТЕКУЩЕЙ неделей: чужой rdWeek sanitize не режет, но и правды в нём нет
    Object.assign(S0, RT);
    const back = c1.w.NEON.unpack(c1.w.NEON.pack());
    const lost = Object.keys(RT).filter((k) => !back || back[k] !== RT[k])
      .map((k) => k + ': ' + RT[k] + ' \u2192 ' + (back ? back[k] : 'null'));
    ok(back !== null && lost.length === 0,
      'round-trip v5: каждое записанное поле возвращается без потерь, а не только «пакет не отброшен»', lost);
    Object.assign(S0, snap);               // состояние c1 дальше по файлу живое — возвращаем как было
  }

  /* --- v2 (15 полей) тоже обязан читаться: именно такие пакеты лежат в VK у
         всех, кто играл до выхода риск-раунда. Поля раунда берутся нулями —
         выдумывать «незакрытый раунд» из отсутствующих данных нельзя.
         NB: shareDay — ИНДЕКС СУТОК UTC (~20743), а не миллисекунды: за
         миллисекундами sanitize() обрезал бы его clamp'ом и поднял susp, то
         есть тест падал бы по причине, несвязанной с миграцией. --- */
  // Версию схемы в теле — ПЕРВЫМ ПОЛЕМ — надо сменить, а не просто доклеить
  // хвост к v1-пакету: иначе получится «версия 1 с 15 полями», которая
  // отклоняется как чужая схема (что правильно).
  const v2Body = '2' + v1Body.slice(1) + '|3|20743|2';
  const v2Pack = v2Body + '#' + fnv1aHex(SIGN_SALT_STR + '#' + v2Body);
  const unp2 = c1.w.NEON.unpack(v2Pack);
  ok(!!(unp2 && unp2.v === 2 && unp2.shares === 3 && unp2.shareN === 2 && Math.floor(unp2.coins) === 800),
    'облачный пакет v2 распакован без потерь (репосты доехали)', unp2);
  ok(!!(unp2 && unp2.rpStake === 0 && unp2.riskWins === 0 && unp2.riskBurned === 0),
    'у пакета v2 нет незакрытого раунда: rpStake=0, а не выдуманное значение', unp2 && [unp2.rpStake, unp2.riskWins, unp2.riskBurned]);

  /* --- v3 (23 поля) — то, что лежит в облаке у ВСЕХ сегодня. Хвост гильдии и
         рейда обязан инициализироваться нулями: выводить из отсутствующих данных
         «участника VK» или «пройденную неделю» нельзя (инвариант 3 раздела 13d). --- */
  // v3 = 15 полей v2 + 8 полей риск-раунда = 23. Хвост гильдии и рейда (ещё 10)
  // появится только в v4 = 33, поэтому здесь ровно восемь нулей.
  const v3Body = '3' + v2Body.slice(1) + '|0|0|0|0|0|0|0|0';
  const v3Pack = v3Body + '#' + fnv1aHex(SIGN_SALT_STR + '#' + v3Body);
  const unp3 = c1.w.NEON.unpack(v3Pack);
  ok(!!(unp3 && unp3.v === 3 && unp3.shares === 3 && Math.floor(unp3.coins) === 800
    && v3Body.split('|').length === 23),
    'облачный пакет v3 (23 поля) распакован без потерь', unp3 && [unp3.v, unp3.shares, Math.floor(unp3.coins)]);
  ok(!!(unp3 && unp3.gid === 0 && unp3.gState === 0 && unp3.rdWeek === 0 && unp3.rdHonor === 0
    && unp3.rdEarned === 0 && unp3.rdLife === 0 && unp3.rdRedeemed === 0),
    'у пакета v3 нет ни гильдии, ни чести: поля рейда нулевые, а не выдуманные',
    unp3 && [unp3.gid, unp3.gState, unp3.rdWeek, unp3.rdHonor, unp3.rdLife]);
  /* --- v4 (33 поля) — ПРЯМОЙ регресс на баг, уехавший в публикацию.
         Когда появилась v4, хвост гильдии прочитали условием isV4, а два
         выражения выше остались «isV2 || isV3» и «isV3»: собственный v4-пакет
         перестал узнавать поля репоста и риск-раунда и распаковывал их нулями.
         Проверялось это только «unpack(seen) !== null» — ловит отказ, но молчит
         про нули. Поэтому здесь пакет v4 с НЕНУЛЕВЫМИ полями всех предыдущих
         версий: потеря любого из них краснит проверку ниже. --- */
  const v4Body = '4' + v2Body.slice(1) + '|' + [
    20748, 1, 4, 2, 200, 0, 0, 1,          // риск-раунд (8): nonzero — иначе потеря не видна
    242457640, 1, c1.w.NEON.raid().now, 500, 30, 12, 5, 60, 20748, 1   // гильдия и рейд (10)
  ].join('|');
  const v4Pack = v4Body + '#' + fnv1aHex(SIGN_SALT_STR + '#' + v4Body);
  const unp4 = c1.w.NEON.unpack(v4Pack);
  ok(!!(unp4 && unp4.v === 4 && v4Body.split('|').length === 33),
    'облачный пакет v4 (33 поля) распакован', unp4 && [unp4.v, v4Body.split('|').length]);
  ok(!!(unp4 && unp4.shares === 3 && unp4.shareDay === 20743 && unp4.shareN === 2),
    'КРИТИЧНО: v4-пакет не потерял репосты — именно здесь баг v4 обнулял shares/shareDay/shareN',
    unp4 && [unp4.shares, unp4.shareDay, unp4.shareN]);
  ok(!!(unp4 && unp4.riskWins === 4 && unp4.riskLoss === 2 && unp4.riskBurned === 200 && unp4.rpIdx === 1),
    'КРИТИЧНО: v4-пакет не потерял риск-раунд — именно здесь баг v4 обнулял шесть его полей',
    unp4 && [unp4.riskWins, unp4.riskLoss, unp4.riskBurned, unp4.rpIdx]);
  ok(!!(unp4 && unp4.gid === 242457640 && unp4.gState === 1 && unp4.rdHonor === 30 && unp4.rdLife === 60
    && unp4.rdBest === 12 && unp4.rdTries === 5 && unp4.rdRedN === 1),
    'и поля самой v4 — гильдия с рейдом — доехали целиком',
    unp4 && [unp4.gid, unp4.gState, unp4.rdHonor, unp4.rdLife, unp4.rdBest, unp4.rdTries, unp4.rdRedN]);
  ok(!!(unp4 && unp4.vipUntil === 0 && unp4.vipDay === 0),
    'у пакета v4 нет VIP: поля нулевые, а не выдуманный срок',
    unp4 && [unp4.vipUntil, unp4.vipDay]);
  c1.dom.window.close();

  /* --- Подпись сейва зависит от ВЕРСИИ ДАННЫХ, а не от версии кода: иначе
         каждый честный игрок с накопленным прогрессом получил бы susp при
         первом же запуске обновления. --- */
  const v1Save = {
    v: 1, coins: 800, total: 900, clicks: 50, upClick: 3, upAuto: 2, boostUntil: 0,
    watched: 4, sound: true, t0: t0v1, susp: 0, lastSeen: nowV1
  };
  v1Save.sig = fnv1aHex(SIGN_SALT_STR + '|' + [
    v1Save.v, v1Save.coins, v1Save.total, v1Save.clicks, v1Save.upClick, v1Save.upAuto,
    v1Save.boostUntil, v1Save.watched, v1Save.susp, v1Save.t0, v1Save.lastSeen
  ].join(','));
  const m1d = mockBridge({ fill: true, type: 'success' });
  const c1d = await makeGame({ url: VK_URL, vkBridge: m1d, seed: v1Save });
  ok(c1d.w.NEON.state().susp === 0, 'сейв v1 с подписью v1 НЕ помечен повреждённым', c1d.w.NEON.state().susp);
  ok(Math.floor(c1d.w.NEON.state().coins) === 800 && c1d.w.NEON.state().v === 5,
    'прогресс v1 переехал в v5 без потерь', [Math.floor(c1d.w.NEON.state().coins), c1d.w.NEON.state().v]);
  ok(c1d.w.NEON.state().riskBurned === 0 && c1d.w.NEON.state().rpStake === 0,
    'у мигрировавшего v1 нет ни сгоревших монет, ни незакрытого раунда', c1d.w.NEON.risk());
  ok(c1d.w.NEON.state().gid === 0 && c1d.w.NEON.state().gState === 0 && c1d.w.NEON.state().rdHonor === 0,
    'у мигрировавшего v1 нет ни гильдии, ни чести: рейдовые поля нулевые',
    [c1d.w.NEON.state().gid, c1d.w.NEON.state().gState, c1d.w.NEON.state().rdHonor]);
  c1d.dom.window.close();

  /* --- То же для v2: подпись v2 покрывает ровно 14 полей, поэтому v3-хвост в
         ней отсутствует. Если бы v3-поля добавлялись в середину списка
         signatureOf, каждый честный игрок получил бы susp при первом запуске
         обновления — и молча, без единой ошибки в консоли. --- */
  const v2Save = Object.assign({}, v1Save, { v: 2, shares: 3, shareDay: 20743, shareN: 2 });
  delete v2Save.sig;
  v2Save.sig = fnv1aHex(SIGN_SALT_STR + '|' + [
    v2Save.v, v2Save.coins, v2Save.total, v2Save.clicks, v2Save.upClick, v2Save.upAuto,
    v2Save.boostUntil, v2Save.watched, v2Save.susp, v2Save.t0, v2Save.lastSeen,
    v2Save.shares, v2Save.shareDay, v2Save.shareN
  ].join(','));
  const m2d = mockBridge({ fill: true, type: 'success' });
  const c2d = await makeGame({ url: VK_URL, vkBridge: m2d, seed: v2Save });
  ok(c2d.w.NEON.state().susp === 0, 'сейв v2 с подписью v2 НЕ помечен повреждённым', c2d.w.NEON.state().susp);
  ok(Math.floor(c2d.w.NEON.state().coins) === 800 && c2d.w.NEON.state().shares === 3 && c2d.w.NEON.state().v === 5,
    'прогресс v2 переехал в v5 без потерь (репосты целы)',
    [Math.floor(c2d.w.NEON.state().coins), c2d.w.NEON.state().shares, c2d.w.NEON.state().v]);
  ok(c2d.w.NEON.unpack(c2d.w.NEON.pack()) !== null,
    'пакет, собранный v5-кодом с мигрировавшим v2, читается самим же v5', c2d.w.NEON.pack());
  c2d.dom.window.close();

  /* --- v3 (22 поля подписи) — САМЫЙ ВАЖНЫЙ кейс аддитивности: именно эти сейвы
         лежат у всех прямо сейчас. Хвост v4 добавлен в КОНЕЦ signatureOf, поэтому
         susp обязан остаться 0. Если бы поля вставили в середину, каждый честный
         игрок получил бы молчаливое клеймо чита при первом запуске обновления. --- */
  const v3Save = Object.assign({}, v2Save, {
    v: 3, riskDay: 0, riskN: 0, riskWins: 4, riskLoss: 2, riskBurned: 200,
    rpStake: 0, rpWon: 0, rpIdx: 0
  });
  delete v3Save.sig;
  v3Save.sig = fnv1aHex(SIGN_SALT_STR + '|' + [
    v3Save.v, v3Save.coins, v3Save.total, v3Save.clicks, v3Save.upClick, v3Save.upAuto,
    v3Save.boostUntil, v3Save.watched, v3Save.susp, v3Save.t0, v3Save.lastSeen,
    v3Save.shares, v3Save.shareDay, v3Save.shareN,
    v3Save.riskDay, v3Save.riskN, v3Save.riskWins, v3Save.riskLoss, v3Save.riskBurned,
    v3Save.rpStake, v3Save.rpWon, v3Save.rpIdx
  ].join(','));
  const m3d = mockBridge({ fill: true, type: 'success' });
  const c3d = await makeGame({ url: VK_URL, vkBridge: m3d, seed: v3Save });
  const V3 = () => c3d.w.NEON.state();
  ok(V3().susp === 0, 'сейв v3 с подписью v3 НЕ помечен повреждённым (хвост v4 добавлен в конец)', V3().susp);
  ok(V3().v === 5 && Math.floor(V3().coins) === 800 && V3().riskWins === 4 && Math.floor(V3().riskBurned) === 200,
    'прогресс v3 переехал в v5 без потерь (сток риск-раунда цел)',
    [V3().v, Math.floor(V3().coins), V3().riskWins, Math.floor(V3().riskBurned)]);
  ok(V3().gid === 0 && V3().gState === 0 && V3().rdHonor === 0 && V3().rdBest === 0 && V3().rdLife === 0,
    'рейдовые поля мигрировавшего v3 начались с нуля, а не с нарисованной чести',
    [V3().gid, V3().gState, V3().rdHonor, V3().rdBest, V3().rdLife]);
  ok(V3().rdEarned === 0,
    'журнал недели у мигрировавшего v3 пуст: прошлый заработок не стал честью задним числом',
    V3().rdEarned);
  ok(V3().vipUntil === 0 && V3().vipDay === 0,
    'у мигрировавшего v3 нет VIP: поля нулевые, а не выдуманный срок',
    [V3().vipUntil, V3().vipDay]);
  ok(c3d.w.NEON.pack().split('#')[0].split('|').length === 35,
    'пакет v5 после миграции из v3 — 35 полей', c3d.w.NEON.pack());
  c3d.dom.window.close();

  // 8.2 — нет заполнения: награда НЕ выдаётся
  const m2 = mockBridge({ fill: false });
  const b = await makeGame({ url: VK_URL, vkBridge: m2, seed: freshSeed() });
  await b.w.VK.ready;
  b.d.getElementById('btnCoins').dispatchEvent(new b.w.MouseEvent('click'));
  await sleep(400);
  ok(b.w.NEON.state().coins === 0, 'без заполнения монеты не начислены');
  ok(m2.calls.indexOf('VKWebAppShowNativeAds:reward') < 0, 'ролик не запрашивается без заполнения');
  ok(/ещё не готова/.test(b.d.getElementById('toasts').textContent), 'показан «красивый» отказ VK', b.d.getElementById('toasts').textContent);
  ok(/недоступна/.test(b.d.getElementById('adNote').textContent), 'подсказка о недоступности рекламы', b.d.getElementById('adNote').textContent);
  b.dom.window.close();

  // 8.3 — ролик ЗАКРЫТ (type:'closed'): показ состоялся, награда обязана доехать.
  //       Прежняя сборка принимала 'closed' за досрочный выход и не выдавала
  //       награду за досмотренный ролик — ровно та жалоба, с которой игрок
  //       пришёл 23.10.2026 («посмотрел рекламу, ×2 не включился»). Флага
  //       «досмотрел до конца» в ответе VK нет, а отказ по 'closed' крал награду
  //       у честного игрока целиком.
  const m3 = mockBridge({ fill: true, type: 'closed' });
  const c = await makeGame({ url: VK_URL, vkBridge: m3, seed: freshSeed() });
  c.d.getElementById('btnCoins').dispatchEvent(new c.w.MouseEvent('click'));
  await sleep(500);
  ok(c.w.NEON.state().coins === 1000, "закрытый ролик (type:'closed') оплачен наградой",
    c.w.NEON.state().coins);
  c.dom.window.close();

  // 8.3a — явный досрочный выход (type:'skipped'): вот здесь отказа быть и положено.
  const m3a = mockBridge({ fill: true, type: 'skipped' });
  const ca = await makeGame({ url: VK_URL, vkBridge: m3a, seed: freshSeed() });
  ca.d.getElementById('btnCoins').dispatchEvent(new ca.w.MouseEvent('click'));
  await sleep(500);
  ok(ca.w.NEON.state().coins === 0, "за type:'skipped' награды нет");
  ok(/закрыт досрочно/.test(ca.d.getElementById('toasts').textContent),
    'текст о досрочно закрытом ролике', ca.d.getElementById('toasts').textContent);
  ca.dom.window.close();

  // 8.3b — ЛЕСТНИЦА СООБЩЕНИЙ loading → opened → closed. Промис send закрывается
  //        ПЕРВЫМ сообщением (вендорный vk-bridge 3.0.2 так и делает), поэтому
  //        заявка, доверяющая одному ответу, объявляла «loading» отсутствием
  //        роликов и крала награду за досмотренный ролик целиком.
  const m3b = mockBridge({ fill: true, ladder: ['loading', 'opened', 'closed'] });
  const cb2 = await makeGame({ url: VK_URL, vkBridge: m3b, seed: freshSeed({ upAuto: 1 }) });
  cb2.d.getElementById('btnDouble').dispatchEvent(new cb2.w.MouseEvent('click'));
  await sleep(600);
  ok(cb2.w.NEON.state().boostUntil > Date.now() + 4 * 60000,
    'лестница сообщений не обнулила награду: ×2 включён после досмотренного ролика',
    cb2.w.NEON.state().boostUntil - Date.now());
  ok(Math.floor(cb2.w.NEON.state().coins) < 100,
    'и ничего лишнего: буст — это время, а не разовое начисление монет',
    Math.floor(cb2.w.NEON.state().coins));
  cb2.dom.window.close();

  // 8.3c — отказ кулдаун НЕ заводит: игрок, не получивший ни ролика, ни награды,
  //        вправе попробовать сразу. Штраф 12 с за чужую ошибку — это ложь.
  const m3c = mockBridge({ fill: true, type: 'skipped' });
  const cc2 = await makeGame({ url: VK_URL, vkBridge: m3c, seed: freshSeed() });
  cc2.d.getElementById('btnCoins').dispatchEvent(new cc2.w.MouseEvent('click'));
  await sleep(500);
  cc2.d.getElementById('btnCoins').dispatchEvent(new cc2.w.MouseEvent('click'));
  await sleep(500);
  const shows = m3c.calls.filter((x) => x === 'VKWebAppShowNativeAds:reward').length;
  ok(shows === 2, 'неудачный показ не поставил кулдаун: show ушёл дважды', shows);
  ok(cc2.w.NEON.state().watched === 0, 'неудачные показы не числятся просмотренными',
    cc2.w.NEON.state().watched);
  cc2.dom.window.close();

  // 8.4 — ошибка рекламного SDK (code 3 = дневной лимит)
  const m4 = mockBridge({ fill: true, errorCode: 3 });
  const e = await makeGame({ url: VK_URL, vkBridge: m4, seed: freshSeed() });
  e.d.getElementById('btnCoins').dispatchEvent(new e.w.MouseEvent('click'));
  await sleep(400);
  ok(e.w.NEON.state().coins === 0, 'при ошибке SDK награды нет');
  ok(/Дневной лимит показов/.test(e.d.getElementById('toasts').textContent), 'расшифрован код ошибки 3', e.d.getElementById('toasts').textContent);
  e.dom.window.close();

  // 8.5 — буст ×2 в реальном VK + сохранение при уходе в фон
  const m5 = mockBridge({ fill: true, type: 'success' });
  const f = await makeGame({ url: VK_URL, vkBridge: m5, seed: freshSeed({ upAuto: 1 }) });
  f.d.getElementById('btnDouble').dispatchEvent(new f.w.MouseEvent('click'));
  await sleep(400);
  ok(f.w.NEON.state().boostUntil > Date.now() + 4 * 60000, 'VK: буст ×2 активирован за ролик');
  ok(f.d.getElementById('perSecond').textContent === '+10', 'VK: пассив удвоен', f.d.getElementById('perSecond').textContent);

  // 8.5b — ПОТОЛОК БУСТА. Серия просмотров не может уйти дальше
  //        CFG.anticheat.maxBoostAheadMs (90 мин). Раньше край проверялся
  //        только в sanitize() при загрузке сейва, поэтому во время игры
  //        boostUntil наращивался бесконечно и «схлопывался» лишь после
  //        перезапуска. Кулдаун 12 с в тесте снят через NEON.clearCooldown().
  {
    const CAP = f.w.NEON.cfg.anticheat.maxBoostAheadMs;
    const STEP = f.w.NEON.cfg.boost.ms;
    let peak = 0;
    for (let i = 0; i < 24; i++) {
      f.w.NEON.clearCooldown();
      f.d.getElementById('btnDouble').dispatchEvent(new f.w.MouseEvent('click'));
      await sleep(120);
      peak = Math.max(peak, f.w.NEON.state().boostUntil - Date.now());
    }
    const mins = (x) => (x / 60000).toFixed(1) + ' мин';
    ok(peak <= CAP + 1000, 'VK: 24 ролика подряд не вывели буст за потолок 90 мин', mins(peak));
    ok(peak >= CAP - STEP, 'VK: потолок достигается, а не режет буст на первой же награде', mins(peak));
    ok(f.w.NEON.state().watched >= 20, 'VK: просмотры засчитаны — насыщение не «съедает» награды молча', f.w.NEON.state().watched);
  }

  f.w.dispatchEvent(new f.w.Event('vk:viewhide'));
  const savedF = JSON.parse(f.w.localStorage.getItem(SAVE_KEY) || '{}');
  ok(savedF.boostUntil === f.w.NEON.state().boostUntil, 'прогресс записан при уходе в фон VK');
  f.dom.window.close();

  /* -------- [9] ТЕМЫ: ребрендинг одной строкой -------- */
  console.log('\n[9] Темы: мгновенный ребрендинг');
  {
    const g = await makeGame();
    const T = g.w.NEON;
    const ids = T.themes();

    ok(T.themeIssues().length === 0, 'реестр тем без опечаток и пропусков', T.themeIssues());
    ok(ids.length >= 3 && ids[0] === 'neon', 'в реестре >= 3 тем, дефолт первая', ids);

    // 9.1 THEMES.neon обязан совпадать с :root в style.css. Рассинхрон —
    //     классика: поменяли объект, забыли CSS (или наоборот), и до
    //     применения темы игрок видит прошлую палитру.
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    const rootVar = (n) => {
      const m = new RegExp('--' + n + ':\\s*(#[0-9a-fA-F]{3,8})').exec(css);
      return m ? m[1].toLowerCase() : null;
    };
    const neon = T.themeOf('neon');
    [['cyan', 'accent'], ['magenta', 'accent2'], ['bg-top', 'bgTop'], ['bg', 'bg']].forEach((p) => {
      ok(rootVar(p[0]) === String(neon[p[1]]).toLowerCase(),
        ':root --' + p[0] + ' == THEMES.neon.' + p[1], [rootVar(p[0]), neon[p[1]]]);
    });

    // 9.2 Тема применена СИНХРОННО, до boot(): атрибут на <html>, <title>,
    //     валюта под балансом — всё на месте сразу.
    ok(g.d.documentElement.getAttribute('data-theme') === 'neon', 'data-theme выставлен на <html>', g.d.documentElement.getAttribute('data-theme'));
    ok(g.d.title === neon.copy.logo, '<title> = имя продукта из темы', g.d.title);
    ok(g.d.getElementById('balCap').textContent === neon.cur, 'подпись баланса — валюта темы', g.d.getElementById('balCap').textContent);
    ok(g.d.getElementById('coinFace').textContent === neon.glyph, 'монета несёт глиф темы', g.d.getElementById('coinFace').textContent);

    // 9.2b Свежая загрузка на НЕ-дефолтной теме. Её тексты заведомо отличаются
    //      от вшитых в index.html, поэтому проверка доказывает, что bindCopy
    //      реально отработал СИНХРОННО, а не что разметка случайно совпала с
    //      дефолтом (именно так smoke молчал, когда applyTheme падал в TDZ).
    const satFresh = await makeGame({ url: 'https://app.neonclick.local/?debug=1&theme=sat' });
    const satT = T.themeOf('sat');
    ok(satFresh.d.getElementById('logoTxt').textContent === satT.copy.logo,
      'свежий ?theme=sat: шапка на теме, а не на встроенном в HTML тексте', satFresh.d.getElementById('logoTxt').textContent);
    ok(satFresh.d.title === satT.copy.logo, 'свежий ?theme=sat: <title> выставлен движком', satFresh.d.title);
    ok((satFresh.d.querySelector('meta[name="description"]').getAttribute('content') || '').indexOf(satT.copy.logo) >= 0,
      'свежий ?theme=sat: описание тоже следует за брендом (в каталоге не пахнет прошлым продуктом)',
      satFresh.d.querySelector('meta[name="description"]').getAttribute('content'));
    ok(satFresh.d.getElementById('balCap').textContent === satT.cur,
      'свежий ?theme=sat: валюта под балансом из темы', satFresh.d.getElementById('balCap').textContent);
    ok(satFresh.d.querySelector('[data-t="adCoins"]').textContent === satT.copy.adCoins.replace('{adReward}', grp(T.cfg.freeCoinsReward)).replace('{cur}', satT.cur),
      'свежий ?theme=sat: карточка рекламы собрана из токенов', satFresh.d.querySelector('[data-t="adCoins"]').textContent);
    satFresh.dom.window.close();

    // 9.3 Проходим ВСЕМИ темами и требуем, чтобы ни один узел не остался на
    //     чужом бренде. adShareSub/adNote исключены из строгого сравнения:
    //     их перезаписывают рендереры (остаток лимита, статус VK) — для них
    //     проверяем присутствие валюты.
    const DYNAMIC = ['adShareSub', 'adNote'];
    ids.forEach((id) => {
      const th = T.themeOf(id);
      ok(T.setTheme(id) === true, 'тема "' + id + '" применена без отказа');
      const miss = [];
      g.d.querySelectorAll('[data-t]').forEach((n) => {
        const key = n.getAttribute('data-t');
        if (DYNAMIC.indexOf(key) >= 0) return;
        const want = String(th.copy[key] || '')
          .replace(/\{cur\}/g, th.cur)
          .replace(/\{adReward\}/g, grp(T.cfg.freeCoinsReward))
          .replace(/\{shareReward\}/g, grp(T.cfg.share.reward));
        if (n.textContent !== want) miss.push(key + ' → «' + n.textContent + '»');
      });
      ok(miss.length === 0, 'тема "' + id + '": все статические тексты привязаны', miss);
      ok(g.d.getElementById('balCap').textContent === th.cur, 'тема "' + id + '": валюта в подписи баланса', g.d.getElementById('balCap').textContent);
      ok(g.d.getElementById('coinFace').textContent === th.glyph, 'тема "' + id + '": глиф монеты', g.d.getElementById('coinFace').textContent);
      const icons = [].slice.call(g.d.querySelectorAll('[data-curicon]'));
      ok(icons.length >= 3 && icons.every((n) => n.textContent === th.curIcon),
        'тема "' + id + '": иконка валюты единая во всём UI', icons.map((n) => n.textContent));
      ok(g.d.getElementById('shareNote').textContent.indexOf(th.cur) >= 0,
        'тема "' + id + '": подпись репоста говорит на валюте темы', g.d.getElementById('shareNote').textContent);
      ok(g.d.title === th.copy.logo, 'тема "' + id + '": <title> переименован', g.d.title);
    });
    T.setTheme('neon');

    // 9.4 ★ ЛОВУШКА №1: идентичность прогресса НЕ зависит от темы. Иначе
    //     «перекрасить игру» = «сбросить прогресс всей базе».
    ok(T.cfg.saveKey === SAVE_KEY && T.cfg.cloud.key === 'neonclick1',
      'ключи хранилища — константы, а не производные от бренда', [T.cfg.saveKey, T.cfg.cloud.key]);
    // ЛОВУШКА №5: ни одна тема не имеет права тащить внешнюю зависимость.
    // Дальний URL картинки = 404/блокировка/офлайн, превращающий главную
    // кнопку в битую иконку. Разрешён только локальный относительный путь.
    const remote = ids.filter((x) => /^(https?:)?\/\//i.test(String(T.themeOf(x).image || '')));
    ok(remote.length === 0, 'ни одна тема не ссылается на дальний ассет', remote);
    // Прогресс прошлого бренда обязан читаться в мемо-сборке. Рекламный флоу
    // берём детерминированным моком (как в секции 8), иначе тест ловил бы
    // тайминги демо-ролика, а не формулировку награды.
    const mMem = mockBridge({ fill: true, type: 'success' });
    const memeG = await makeGame({ url: VK_URL + '&theme=meme', vkBridge: mMem, seed: freshSeed({ coins: 4242, total: 4242 }) });
    ok(memeG.d.documentElement.getAttribute('data-theme') === 'meme', '?theme= переключает бренд без правки кода');
    ok(Math.floor(memeG.w.NEON.state().coins) === 4242,
      'прогресс с прошлого бренда прочитан: ребрендинг НЕ сбрасывает базу', Math.floor(memeG.w.NEON.state().coins));
    await sleep(400);
    memeG.d.getElementById('btnCoins').dispatchEvent(new memeG.w.MouseEvent('click'));
    await sleep(500);
    ok(memeG.w.NEON.state().watched === 1, 'мемо-сборка получает награду как все', memeG.w.NEON.state().watched);
    ok(memeG.d.getElementById('toasts').textContent.indexOf('мемокоинов') >= 0,
      'награда озвучена валютой темы', memeG.d.getElementById('toasts').textContent);
    memeG.dom.window.close();

    // 9.5 Мусор в ?theme= — отказ, а не пустой экран.
    const bad = await makeGame({ url: 'https://app.neonclick.local/?debug=1&theme=no_such_theme' });
    ok(bad.d.documentElement.getAttribute('data-theme') === 'neon', 'несуществующая ?theme= отброшена на дефолт', bad.d.documentElement.getAttribute('data-theme'));
    ok(bad.w.NEON && typeof bad.w.NEON.tap === 'function', 'игра всё равно запускается');
    bad.dom.window.close();

    // 9.5b ТЕМА СКВОЗЬ ОБЁРТКУ VK: location_search и hash.
    /* Вне VK страница открывается напрямую, и ?theme= виден — ровно это и
       покрывали предыдущие проверки. В клиенте VK query приложения приезжает
       параметром location_search, а не россыпью. Резолвер, читающий только
       location.search, отдал бы мем-аудитории базовую витрину МОЛЧА: ошибки
       нет, бренд не тот, в метриках — «плохая конверсия ссылки». */
    const enc = (s) => encodeURIComponent(s);
    const viaLS = await makeGame({ url: 'https://app.neonclick.local/?debug=1&viewer_id=1&location_search=' + enc('?theme=sat') });
    ok(viaLS.d.documentElement.getAttribute('data-theme') === 'sat',
      '9.5b тема из location_search (именно так её привозит VK)', viaLS.d.documentElement.getAttribute('data-theme'));
    ok(viaLS.d.getElementById('logoTxt').textContent === T.themeOf('sat').copy.logo,
      '9.5b location_search: шапка на теме, а не на дефолте', viaLS.d.getElementById('logoTxt').textContent);
    viaLS.dom.window.close();

    const viaHash = await makeGame({ url: 'https://app.neonclick.local/?debug=1#theme=sat' });
    ok(viaHash.d.documentElement.getAttribute('data-theme') === 'sat',
      '9.5b тема из хэша (QR и часть размещений кладут параметры туда)', viaHash.d.documentElement.getAttribute('data-theme'));
    viaHash.dom.window.close();

    const viaSlash = await makeGame({ url: 'https://app.neonclick.local/?debug=1#/?theme=meme' });
    ok(viaSlash.d.documentElement.getAttribute('data-theme') === 'meme',
      '9.5b хэш вида «#/?theme=» тоже распознаётся', viaSlash.d.documentElement.getAttribute('data-theme'));
    viaSlash.dom.window.close();

    /* Приоритет: собственный query обязан переживать завёрнутый, иначе любая
       ссылка с обоими параметрами стала бы рулеткой. */
    const prec = await makeGame({ url: 'https://app.neonclick.local/?debug=1&theme=meme&location_search=' + enc('?theme=sat') });
    ok(prec.d.documentElement.getAttribute('data-theme') === 'meme',
      '9.5b приоритет у собственного ?theme=, location_search его не перекрывает', prec.d.documentElement.getAttribute('data-theme'));
    prec.dom.window.close();

    /* Мусор в URL не должен дойти до витрины. Поясов ДВА, и это проверено
       мутациями раздельно: сними регэксп ниже — прогон останется зелёным,
       потому что неизвестный id клампит уже T.themeOf(); сними themeOf —
       упадёт всё. Так что эта проверка фиксирует ИСХОД (тема = дефолт), а не
       героизм конкретного пояса. Регэксп оставлен как страховка на случай,
       когда themeOf станет снисходительнее, — не как то, что здесь доказывается. */
    const junkLS = await makeGame({ url: 'https://app.neonclick.local/?debug=1&location_search=' + enc('?theme=<script>') });
    ok(junkLS.d.documentElement.getAttribute('data-theme') === 'neon',
      '9.5b мусор в location_search не доходит до витрины (исход, клампится дважды)', junkLS.d.documentElement.getAttribute('data-theme'));
    ok(junkLS.w.NEON && typeof junkLS.w.NEON.tap === 'function', '9.5b игра с мусорным location_search всё равно запускается');
    junkLS.dom.window.close();

    // 9.6 Ранги переименовываются темой: та же ступень, другое имя продукта.
    const rankNeon = await makeGame({ seed: freshSeed({ total: 1e6 }) });
    const rankMeme = await makeGame({ url: 'https://app.neonclick.local/?debug=1&theme=meme', seed: freshSeed({ total: 1e6 }) });
    ok(rankNeon.d.getElementById('rankName').textContent === 'Неон', 'неон: ступень 1e6 = «Неон»', rankNeon.d.getElementById('rankName').textContent);
    ok(rankMeme.d.getElementById('rankName').textContent === 'Популярный', 'мемо: та же ступень переименована', rankMeme.d.getElementById('rankName').textContent);
    rankNeon.dom.window.close();
    rankMeme.dom.window.close();
  }

  /* ======================================================================
   * [10] СОЛО «ВА-БАНК» (раздел 13c в game.js)
   *
   * Механика существует ровно для одного дела — ВЫВОДИТЬ валюту из игры.
   * Любой кран, завязанный на ставку, отменяет её смысл, поэтому здесь
   * проверяется не «кнопка нажалась», а целость трёх инвариантов:
   *   1. S.total не растёт ни в одном исходе (иначе это генератор монет);
   *   2. write-ahead переживает убийство приложения (иначе сток = реролл
   *      по F5, а выигрыш = то, что можно украсть рестартом);
   *   3. легальный сток не режется и не помечается античитом.
   * ==================================================================== */
  console.log('\n[10] Соло «Ва-банк»: ставка, write-ahead, сток валюты');
  {
    /* upAuto=0 НАМЕРЕННО: пассивный доход тек бы во время sleep(1200) и
       «успел» бы изменить coins/total между снимками, превратив точные
       проверки в плавающие. Без авто-майнинга состояние неподвижно. */
    const rich = (over) => freshSeed(Object.assign({
      coins: 100000, total: 100000, clicks: 5000, upClick: 20, upAuto: 0,
      t0: Date.now() - 7 * 86400000, sound: true
    }, over || {}));
    const open = async (over, rnd, bridge) => {
      const g = await makeGame({ seed: rich(over), vkBridge: bridge });
      g.w.Math.random = rnd == null ? () => 0.9 : rnd;   // ≥0.5 → поражение
      return g;
    };
    const savedOf = (g) => JSON.parse(g.w.localStorage.getItem(SAVE_KEY) || '{}');

    // 10.1 — Поражение сжигает ставку и НЕ трогает S.total.
    const m10 = mockBridge({ fill: true, type: 'success' });
    const lg = await open(null, () => 0.9, m10);
    const L = lg.w.NEON;
    const freshNote = lg.d.getElementById('riskNote').textContent;   // до первого поражения
    L.setRiskPick(2);                                     // ва-банк
    const l0 = { coins: Math.floor(L.state().coins), total: Math.floor(L.state().total) };
    const stakeL = L.risk().stake;
    ok(stakeL === l0.coins, '10.1 ва-банк = весь баланс', [stakeL, l0.coins]);
    L.playRisk();
    const wa = savedOf(lg);                               // анимация ещё идёт
    ok(wa.rpStake === stakeL && Math.floor(wa.coins) === 0,
      '10.1 write-ahead: ставка списана и раунд записан ДО раскрытия', [wa.rpStake, Math.floor(wa.coins)]);
    ok(Math.floor(wa.total) === l0.total,
      '10.1 write-ahead не тронул S.total', [Math.floor(wa.total), l0.total]);
    await sleep(1200);
    const ls = L.state();
    ok(Math.floor(ls.coins) === 0 && ls.riskLoss === 1 && Math.floor(ls.riskBurned) === stakeL,
      '10.1 поражение: монеты сгорели, учёт стока вырос', [Math.floor(ls.coins), ls.riskLoss, ls.riskBurned]);
    ok(Math.floor(ls.total) === l0.total,
      '10.1 после поражения S.total прежний — валюта ВЫШЛА из игры, а не переехала', Math.floor(ls.total));
    ok(ls.rpStake === 0, '10.1 раунд закрыт: незакрытых ставок не висит');
    /* Сток должен быть ВИДЕН: без этой строки «сгоревшие» монеты остаются
       абстракцией в сейве. fmt() — функция игры, в харнессе её нет, поэтому
       сверяем факт присутствия суммы по маркеру и названию валюты темы. */
    const noteTxt = lg.d.getElementById('riskNote').textContent;
    ok(/сгорело всего/.test(noteTxt) && noteTxt.indexOf(lg.w.NEON.theme().cur) > -1,
      '10.1 сток виден игроку: карточка показывает «сгорело всего» с валютой темы', noteTxt);
    ok(!/сгорело всего/.test(freshNote),
      '10.1 до первого поражения строка стока не появляется (иначе это декорация)', freshNote);
    ok(!String(m10.calls).includes('VKWebAppShowNativeAds'),
      '10.1 риск-раунд не показывает рекламу (это не точка монетизации)', m10.calls);
    lg.dom.window.close();

    // 10.2 — Победа возвращает РОВНО ставку и даёт буст, но не монеты.
    const wg = await open(null, () => 0.1);
    const W = wg.w.NEON;
    W.setRiskPick(2);
    const w0 = { coins: Math.floor(W.state().coins), total: Math.floor(W.state().total), boost: W.state().boostUntil };
    W.playRisk();
    await sleep(1200);
    const ws = W.state();
    ok(Math.floor(ws.coins) === w0.coins,
      '10.2 победа возвращает ровно ставку — ни монетой больше (больше = кран)', [Math.floor(ws.coins), w0.coins]);
    ok(Math.floor(ws.total) === w0.total,
      '10.2 КРИТИЧНО: победа НЕ увеличивает S.total (earn()/grant() тут запрещены)', [Math.floor(ws.total), w0.total]);
    ok(ws.riskWins === 1 && ws.riskLoss === 0 && Math.floor(ws.riskBurned) === 0,
      '10.2 учёт: победа записана, сгоревшего нет', [ws.riskWins, ws.riskLoss, ws.riskBurned]);
    /* Меряем ОСТАТОК буста, а не разность boostUntil:0 — при неактивном бусте
       игра ставит край от «сейчас», и разность с нулём дала бы абсолютный
       timestamp. Допуск 2 с — на время между снимком и закрытием раунда. */
    const bLeft = ws.boostUntil - Date.now();
    ok(bLeft > W.cfg.risk.boostMs[2] - 2000 && bLeft <= W.cfg.risk.boostMs[2],
      '10.2 приз — ВРЕМЯ буста по индексу ставки (ва-банк = 15 мин ×2)', [bLeft, W.cfg.risk.boostMs[2]]);
    ok(W.cfg.boost.mult === 2,
      '10.2 КРИТИЧНО: CFG.boost.mult остался 2. Поднять его нельзя: plausibleCap() считает пассивный потолок из расчёта постоянно включённого ×2, и больший множитель молча срезал бы баланс честного победителя',
      W.cfg.boost.mult);
    ok(W.cfg.risk.boostMs[2] <= W.cfg.anticheat.maxBoostAheadMs,
      '10.2 приз по времени не выходит за край maxBoostAheadMs', [W.cfg.risk.boostMs[2], W.cfg.anticheat.maxBoostAheadMs]);
    ok(W.cfg.risk.stakes.length === W.cfg.risk.boostMs.length,
      '10.2 конфиг цельный: каждой доле соответствует награда (иначе boostMs[i] → undefined → NaN-буст и мёртвый приз молча)',
      [W.cfg.risk.stakes.length, W.cfg.risk.boostMs.length]);
    ok(W.cfg.risk.stakes[W.cfg.risk.stakes.length - 1] === 1,
      '10.2 последняя доля — ровно 100%: «Ва-банк» обязан означать весь баланс, а не 90%',
      W.cfg.risk.stakes[W.cfg.risk.stakes.length - 1]);
    wg.dom.window.close();

    // 10.3 — ГЛАВНАЯ ПРОВЕРКА. Приложение убито посреди анимации раскрытия.
    //         Без write-ahead отсюда получалось либо «переиграл проигрыш»
    //         (сток превращался в нуль), либо «проиграл выигрыш» (игрок терял
    //         ставку, которую уже выиграл).
    const killLoss = async (rnd, pick, tag) => {
      const g = await open(null, rnd);
      const N = g.w.NEON;
      N.setRiskPick(pick);
      const c0 = Math.floor(N.state().coins), t0 = Math.floor(N.state().total);
      N.playRisk();
      const mid = savedOf(g);
      g.dom.window.close();                                // ← смерть посреди 900 мс
      ok(mid.rpStake > 0 && Math.floor(mid.coins) === c0 - mid.rpStake,
        '10.3 (' + tag + ') на момент смерти раунд уже решён и записан', [mid.rpStake, Math.floor(mid.coins), c0]);
      const rv = await makeGame({ seed: mid });
      const R = rv.w.NEON;
      const coins = Math.floor(R.state().coins);
      const res = { wins: R.state().riskWins, loss: R.state().riskLoss, burned: Math.floor(R.state().riskBurned), rp: R.state().rpStake };
      ok(res.rp === 0, '10.3 (' + tag + ') при старте незакрытый раунд доигран');
      ok(R.state().susp === 0, '10.3 (' + tag + ') прерванный раунд не помечен читом', R.state().susp);
      ok(Math.floor(R.state().total) === t0, '10.3 (' + tag + ') рестарт не тронул S.total', [Math.floor(R.state().total), t0]);
      rv.dom.window.close();
      return { c0, mid, coins, res };
    };
    {
      const r = await killLoss(() => 0.9, 1, 'поражение');
      ok(r.coins === r.c0 - r.mid.rpStake && r.res.loss === 1 && r.res.wins === 0,
        '10.3 поражение НЕ переиграно рестартом (иначе сток = 0, а механика бессмысленна)',
        [r.coins, r.c0, r.mid.rpStake, r.res.loss, r.res.wins]);
      ok(r.mid.rpStake === Math.floor(r.c0 * 0.5), '10.3 ставка 50% = половина баланса', [r.mid.rpStake, r.c0]);
    }
    {
      const r = await killLoss(() => 0.1, 0, 'победа');
      ok(r.coins === r.c0 && r.res.wins === 1 && r.res.loss === 0,
        '10.3 выигранная ставка НЕ украдена рестартом: возврат на месте', [r.coins, r.c0, r.res.wins, r.res.loss]);
      ok(r.res.burned === 0, '10.3 при возврате «сгорело» не растёт', r.res.burned);
    }

    // 10.4 — Суточный лимит.
    const lim = await open(null, () => 0.9);
    const P = lim.w.NEON;
    P.setRiskPick(0);                                      // 25%, чтобы баланс пережил все раунды
    const perDay = P.cfg.risk.perDay;
    for (let i = 0; i < perDay; i++) { P.playRisk(); await sleep(1100); }
    ok(P.risk().quota === 0, '10.4 лимит выбран досуха', P.risk());
    ok(P.risk().block === 'limit', '10.4 причина отказа — limit', P.risk().block);
    ok(lim.d.getElementById('btnRisk').disabled, '10.4 кнопка «Поставить» задизейблена');
    ok(lim.d.getElementById('riskCard').classList.contains('is-blocked'), '10.4 карточка погасла, а не дразнится');
    const cb = Math.floor(P.state().coins);
    P.playRisk(); await sleep(1100);
    ok(Math.floor(P.state().coins) === cb, '10.4 сверх лимита ставка не списывается (иначе — монеты в никуда)', [Math.floor(P.state().coins), cb]);
    lim.dom.window.close();

    // 10.5 — Минимальная ставка: на мелком балансе раунд не открывается.
    const poor = await open({ coins: 100, total: 100 });
    const Q = poor.w.NEON;
    ok(Q.risk().block === 'small', '10.5 на мелком балансе раунд запрещён', Q.risk());
    ok(Math.floor(Q.state().coins) === 100 && Q.risk().pending === 0,
      '10.5 отказ ничего не списывает и не оставляет незакрытый раунд', [Q.state().coins, Q.risk().pending]);
    poor.dom.window.close();

    // 10.5b — РЕЕНТЕРАБЕЛЬНОСТЬ. Изменённый клиент бьёт прямо по NEON.playRisk(),
    //         минуя disabled на кнопке: два раунда одновременно дали бы двойное
    //         списание и двойной возврат.
    const re = await open(null, () => 0.1);
    const RE = re.w.NEON;
    RE.setRiskPick(2);
    const rc0 = Math.floor(RE.state().coins), rt0 = Math.floor(RE.state().total);
    RE.playRisk(); RE.playRisk(); RE.playRisk();          // трижды синхронно
    const rMid = savedOf(re);
    ok(rMid.rpStake === rc0 && Math.floor(rMid.coins) === 0,
      '10.5b тройной вызов завёл РОВНО ОДИН раунд: ставка списана один раз', [rMid.rpStake, rc0, Math.floor(rMid.coins)]);
    await sleep(1300);
    const rst = RE.state();
    ok(Math.floor(rst.coins) === rc0 && Math.floor(rst.total) === rt0,
      '10.5b после раскрытия баланс и S.total вернулись к исходным (ничего не создано и не удвоено)',
      [Math.floor(rst.coins), rc0, Math.floor(rst.total), rt0]);
    ok(rst.riskWins === 1 && rst.riskN === 1,
      '10.5b засчитан ровно один раунд и один расход суточного лимита', [rst.riskWins, rst.riskN]);
    re.dom.window.close();

    // 10.6 — Незакрытая ставка = БУДУЩИЙ ВОЗВРАТ. Завышенная в сейве, она
    //         стала бы краном монет. Два барьера: clamp rpStake ≤ total в
    //         sanitize() и возврат не больше (total − coins) в closeRiskRound().
    const greedy = await open({ coins: 1000, total: 5000, rpStake: 1e12, rpWon: 1, rpIdx: 2 });
    const G = greedy.w.NEON;
    ok(Math.floor(G.state().coins) <= Math.floor(G.state().total),
      '10.6 завышенная rpStake не создала монет: инвариант coins ≤ total держится',
      [Math.floor(G.state().coins), Math.floor(G.state().total)]);
    ok(Math.floor(G.state().coins) === 5000 && G.state().rpStake === 0,
      '10.6 возврат ограничен заработанным и раунд закрыт', [Math.floor(G.state().coins), G.state().rpStake]);
    ok(G.state().susp >= 1, '10.6 фальшивая ставка замечена как нарушение', G.state().susp);
    ok(Math.floor(G.state().riskBurned) <= Math.floor(G.state().total),
      '10.6 «сгорело» не может превысить «всего заработано»', [Math.floor(G.state().riskBurned), Math.floor(G.state().total)]);
    greedy.dom.window.close();

    // 10.7 — Край буста. Серия побед ва-банком не имеет права увести
    //         boostUntil за maxBoostAheadMs (та же ловушка, что закрыта в 8.5b
    //         для рекламных просмотров).
    const ceil = await open({ coins: 1e9, total: 1e9 }, () => 0.1);
    const C2 = ceil.w.NEON;
    C2.setRiskPick(2);
    let peak = 0;
    for (let i = 0; i < 6; i++) {
      const st = C2.state(); st.riskDay = 0; st.riskN = 0;   // суточный лимит отодвигаем: проверяем край
      C2.playRisk(); await sleep(1000);
      peak = Math.max(peak, C2.state().boostUntil - Date.now());
      ok(Math.floor(C2.state().coins) === 1e9, '10.7 серия побед не создаёт монет: баланс стоит на 1e9', Math.floor(C2.state().coins));
    }
    ok(peak <= C2.cfg.anticheat.maxBoostAheadMs + 2000,
      '10.7 серия побед ва-банком не выводит буст за 90-минутный край', peak);
    ok(peak >= C2.cfg.risk.boostMs[2], '10.7 край достигается, а не режется на первой же победе', peak);
    ceil.dom.window.close();

    // 10.8 — СОВМЕСТИМОСТЬ С АНТИЧИТОМ. Легальный сток обязан пережить
    //         перезагрузку в БОЕВОМ окне (без ?debug=1, потолок правдоподобия
    //         включён) без подрезки и без susp. Это и есть смысл запрета на
    //         рост S.total: выплата, не подкреплённая активностью, иначе
    //         исчезла бы молча (замер: +100 млн недельному аккаунту → 7,3 млн).
    const cg = await open(null, () => 0.9);
    const CG = cg.w.NEON;
    CG.setRiskPick(1);                                       // 50%
    CG.playRisk(); await sleep(1200);
    const legSaved = savedOf(cg);
    cg.dom.window.close();
    const combat = await makeGame({ url: 'https://app.neonclick.local/', seed: legSaved });
    await sleep(1400);                                       // автосейв перезапишет сейв приведёнными значениями
    const after = JSON.parse(combat.w.localStorage.getItem(SAVE_KEY) || '{}');
    ok((after.susp || 0) === 0,
      '10.8 легальный проигрыш не похож на чит: susp не вырос', after.susp);
    ok(Math.floor(after.coins) === Math.floor(legSaved.coins),
      '10.8 баланс после легального стока НЕ срезан потолком правдоподобия',
      [Math.floor(after.coins), Math.floor(legSaved.coins)]);
    ok(Math.floor(after.total) === Math.floor(legSaved.total),
      '10.8 S.total после боевой загрузки прежний', [Math.floor(after.total), Math.floor(legSaved.total)]);
    combat.dom.window.close();

    // 10.9 — UI: карточка, чипы доли, счётчик лимита, название валюты по теме.
    const ui = await open(null, () => 0.9);
    const U = ui.w.NEON;
    const cur = U.theme().cur;
    ok(!!ui.d.getElementById('riskCard') && !!ui.d.getElementById('btnRisk') && !!ui.d.getElementById('riskChips'),
      '10.9 карточка, кнопка и чипы есть в разметке');
    U.setRiskPick(0);
    ok(ui.d.getElementById('riskAmount').textContent === grp(Math.floor(100000 * 0.25)) + ' ' + cur,
      '10.9 сумма ставки пересчиталась за чипом 25%', ui.d.getElementById('riskAmount').textContent);
    ok(ui.d.getElementById('riskQuota').textContent === U.cfg.risk.perDay + '/' + U.cfg.risk.perDay,
      '10.9 счётчик суточного лимита', ui.d.getElementById('riskQuota').textContent);
    const chips = Array.from(ui.d.querySelectorAll('#riskChips .chip'));
    ok(chips.length === 3 && chips.length === U.cfg.risk.stakes.length && chips.every((c) => c.getAttribute('aria-pressed') !== null),
      '10.9 чипов в разметке ровно столько, сколько долей в конфиге, и каждый с aria-pressed',
      [chips.length, U.cfg.risk.stakes.length, chips.map((c) => c.getAttribute('aria-pressed'))]);
    ok(chips[0].getAttribute('aria-pressed') === 'true' && chips[2].getAttribute('aria-pressed') === 'false',
      '10.9 выбранная доля отмечена: скринридер читает ставку, а не «три одинаковые кнопки»',
      chips.map((c) => c.getAttribute('aria-pressed')));
    ui.dom.window.close();

    /* Название валюты берётся из TM().cur, а не из THEME_COPY_KEYS: механика —
       не витрина, реестр токенов темы расширять нельзя (иначе каждая тема
       обязана будет знать про риск-раунд, а themeIssues() упадёт на недостающем
       ключе). Проверка держит именно это: в теме ставка названа её валютой. */
    const satUi = await makeGame({ url: 'https://app.neonclick.local/?debug=1&theme=sat', seed: rich() });
    satUi.w.NEON.setRiskPick(2);
    const satCur = satUi.w.NEON.theme().cur;
    ok(satUi.d.getElementById('riskAmount').textContent.endsWith(satCur),
      '10.9 в теме ?theme=sat ставка названа её валютой, а не «монетами»',
      [satUi.d.getElementById('riskAmount').textContent, satCur]);
    satUi.dom.window.close();

    // 10.9b — Сток валюты НЕ зависит от заполнения рекламы. Кит с 100 млн
    //         играет, даже когда VK не отдаёт ни одного ролика: иначе механика
    //         исчезала бы ровно в тот момент, когда монет у игрока больше всего
    //         (а no-fill в прайм-тайм — штатная ситуация, а не авария).
    //         NB: при no-fill рекламная кнопка ОСТАЁТСЯ нажатой и отвечает
    //         вежливым отказом (см. 8.2) — поэтому контраст меряем не по
    //         disabled, а по «награда не выплачена vs ставка сыграна».
    const nf = mockBridge({ fill: false });
    const ng = await open(null, () => 0.9, nf);
    const NG = ng.w.NEON;
    ok(/недоступна/.test(ng.d.getElementById('adNote').textContent),
      '10.9b заполнение действительно мертво: подсказка говорит «нет заполнения»',
      ng.d.getElementById('adNote').textContent);
    ng.d.getElementById('btnCoins').dispatchEvent(new ng.w.MouseEvent('click'));
    await sleep(400);
    const nc0 = Math.floor(NG.state().coins);
    ok(Math.floor(NG.state().coins) === nc0 && NG.state().watched === 0,
      '10.9b реклама при этом не платит (иначе проверка ниже была бы пустой)', [Math.floor(NG.state().coins), nc0, NG.state().watched]);
    ok(!ng.d.getElementById('btnRisk').disabled,
      '10.9b при той же мёртвой рекламе ставка доступна', ng.d.getElementById('btnRisk').disabled);
    NG.setRiskPick(1);
    NG.playRisk(); await sleep(1300);
    ok(NG.state().riskWins + NG.state().riskLoss === 1,
      '10.9b раунд реально сыгран без единого показанного ролика', [NG.state().riskWins, NG.state().riskLoss]);
    ok(Math.floor(NG.state().coins) <= nc0 && Math.floor(NG.state().total) === nc0,
      '10.9b ставка ничего не создала: coins ≤ прежнего, total не двинулся',
      [Math.floor(NG.state().coins), nc0, Math.floor(NG.state().total)]);
    ng.dom.window.close();
  }

  /* ======================================================================
   * [11] ГИЛЬДИИ И НЕДЕЛЬНЫЙ РЕЙД (раздел 13d в game.js)
   *
   * Проверяются три инварианта, а не «кнопка нажалась»:
   *   1. Честь — НЕ кран монет: она выводится из уже подтверждённого заработка
   *      и покупает только ВРЕМЯ буста (coins и S.total при обмене не двигаются);
   *   2. v4 аддитивна и идемпотентна: неделя закрывается один раз, sanitize
   *      режет накрутку, merge не складывает тратимую честь;
   *   3. Вне VK фича деградирует мягко: gState=0, надбавки нет, рейд идёт.
   * upAuto=0 ВЕЗДЕ намеренно: пассивный доход тек бы между снимками состояния и
   * превратил точные проверки в плавающие (тот же приём, что в [10]).
   * ==================================================================== */
  console.log('\n[11] Гильдии и недельный рейд: честь, неделя, надбавка, фолбэк');
  {
    // 11.1 — Рейд живёт ВНЕ VK: провайдера нет, статус «не проверено», потерь нет.
    const g11 = await makeGame({ seed: seedV4({ coins: 5000, total: 5000, clicks: 10, upClick: 1 }) });
    const N = g11.w.NEON, S = () => N.state();
    ok(N.guild().available === false, '11.1 вне VK провайдер гильдий недоступен: моста нет', N.guild());
    ok(S().gState === 0 && S().gid === 0,
      '11.1 вне VK статус остаётся «не проверено», а гильдия не выдумывается', [S().gState, S().gid]);
    ok(S().rdWeek === WEEK(), '11.1 журнал инициализирован ТЕКУЩЕЙ неделей, а не нулём', [S().rdWeek, WEEK()]);
    ok(S().rdEarned === 0 && S().rdHonor === 0,
      '11.1 с миграцией на пустом месте не появилось ни журнала, ни чести', [S().rdEarned, S().rdEarned]);

    // 11.2 — Честь растёт ИЗ ЗАРАБОТКА, а не из времени: пока нет дохода, нет и чести.
    ok(N.raid().pending === 0, '11.2 на пустом журнале чести к обмену нет', N.raid());
    N.add(1000); N.add(1000);
    ok(S().rdEarned === 2000, '11.2 журнал недели пошёл от earn(), а не от отдельного крана', S().rdEarned);
    ok(N.raid().pending === 2,
      '11.2 два шага по honorPer (' + N.cfg.raid.honorPer + ') = 2 чести на закрытии', N.raid().pending);
    ok(Math.floor(S().coins) === 7000 && Math.floor(S().total) === 7000,
      '11.2 учёт монет не раздвоился: честь не добавила ни одной монеты', [Math.floor(S().coins), Math.floor(S().total)]);

    // 11.3 — Закрытие недели: ровно один расчёт, идемпотентность, обнуление журнала.
    const b = { honor: S().rdHonor, life: S().rdLife, best: S().rdBest, tries: S().rdTries };
    const r1 = N.advanceWeek(1);
    ok(!!(r1 && r1.gained === 2 && r1.honor === 2),
      '11.3 неделя закрылась без гильдии: журнал 2 шага → 2 чести (надбавки нет)', r1);
    ok(S().rdHonor === b.honor + 2 && S().rdLife === b.life + 2,
      '11.3 честь зачислена в остаток и в пожизненный итог', [S().rdHonor, S().rdLife]);
    ok(S().rdBest === 2 && S().rdTries === b.tries + 1,
      '11.3 лучшая неделя и счётчик закрытых недель обновлены один раз', [S().rdBest, S().rdTries]);
    ok(S().rdEarned === 0 && S().rdWeek === WEEK(),
      '11.3 журнал обнулился, а указатель недели переехал на текущую', [S().rdEarned, S().rdWeek]);
    const r2 = N.settleRaid();
    ok(r2 === null, '11.3 повторный расчёт той же недели ничего не возвращает (идемпотентность)');
    ok(S().rdHonor === b.honor + 2 && S().rdTries === b.tries + 1 && S().rdLife === b.life + 2,
      '11.3 повторный расчёт ничего не начислил повторно', [S().rdHonor, S().rdTries, S().rdLife]);
    // Тик обязан обслуживать переход сам, без участия UI.
    S().rdWeek = WEEK() - 1; S().rdEarned = 1000;
    await sleep(260);
    ok(S().rdWeek === WEEK() && S().rdEarned === 0,
      '11.3 игровой тик сам закрыл истёкшую неделю — UI к этому не причастен', [S().rdWeek, S().rdEarned]);
    ok(S().rdHonor === b.honor + 3, '11.3 тиковый расчёт начислил ещё одну честь', S().rdHonor);
    ok(/Неделя рейда закрыта|новая неделя/i.test(g11.d.getElementById('toasts').textContent),
      '11.3 переход недели замечен игроком: есть уведомление',
      g11.d.getElementById('toasts').textContent.slice(0, 120));

    // 11.4 — Надбавка ×guildMult только при ПОДТВЕРЖДЁННОМ членстве (gState === 1).
    //      gState мутируется напрямую: за его значение отвечает ТОЛЬКО ответ VK,
    //      а мока моста в этом сценарии нет (он — в .vk-mock-check.cjs).
    const per = N.cfg.raid.honorPer, mult = N.cfg.raid.guildMult;
    S().gState = 1; S().rdEarned = 0;
    N.add(per * 4);
    const rg4 = N.advanceWeek(1);
    ok(!!(rg4 && rg4.gained === 4 && rg4.honor === Math.floor(4 * mult)),
      '11.4 подтверждённый участник: журнал 4 шага → floor(4 × ' + mult + ') = 5 чести', rg4);
    ok(rg4.honor > rg4.gained,
      '11.4 надбавка реальна: без гильдии те же 4 шага дали бы ровно 4', [rg4.honor, rg4.gained]);
    S().gState = 2; S().rdEarned = 0;                 // проверенный НЕ участник
    N.add(per * 4);
    const ro2 = N.advanceWeek(1);
    ok(!!(ro2 && ro2.gained === 4 && ro2.honor === 4),
      '11.4 проверенный не-участник надбавки не получает', ro2);
    S().gState = 0; S().rdEarned = 0;                 // не проверено (вне VK)
    N.add(per * 4);
    const ro0 = N.advanceWeek(1);
    ok(!!(ro0 && ro0.gained === 4 && ro0.honor === 4),
      '11.4 «не проверено» трактуется в пользу игрока: без надбавки, но и без штрафа', ro0);
    // Медали округляются ДО умножения: дробный остаток шага не должен рождать честь.
    S().gState = 1; S().rdEarned = 0;
    N.add(per * 4 - 1);
    const rfrac = N.advanceWeek(1);
    ok(!!(rfrac && rfrac.gained === 3 && rfrac.honor === Math.floor(3 * mult)),
      '11.4 неполный шаг чести не даёт: floor(floor(заработок/шаг) × множитель)',
      rfrac && [rfrac.gained, rfrac.honor]);
    g11.dom.window.close();
  }

  /* --- 11.5 … 11.6: обмен чести и клампы sanitize --- */
  console.log('\n[11b] Рейд: обмен чести, sanitize');
  {
    const rd = await makeGame({
      seed: seedV4({ coins: 9000, total: 9000, upClick: 1, rdHonor: 500, rdLife: 500 })
    });
    const M = rd.w.NEON, R = () => M.state();
    // Стоимость и лимит берутся ИЗ КОНФИГА, а литералы ниже только сверяют, что
    // конфиг не разъехался с ожиданиями теста: иначе падение было бы про 50 vs 5,
    // а не про механику.
    const cost = M.cfg.raid.boostCost, perDay = M.cfg.raid.perDay;
    ok(cost === 5 && perDay === 2,
      '11.5 стоимость обмена и суточный лимит не разъехались с тестом', [cost, perDay]);

    // 11.5a — обмен покупает ВРЕМЯ буста и НЕ создаёт монет.
    R().boostUntil = 0;
    M.clearCooldown();
    const c0 = Math.floor(R().coins), t0 = Math.floor(R().total), h0 = Math.floor(R().rdHonor);
    const first = M.redeemHonor();
    ok(first === true, '11.5a первый обмен за честь прошёл', first);
    ok(Math.floor(R().rdHonor) === h0 - cost, '11.5a честь списана ровно по стоимости', [h0, Math.floor(R().rdHonor)]);
    ok(R().boostUntil >= Date.now() + M.cfg.raid.boostMs - 3000,
      '11.5a приз — ВРЕМЯ буста ×2 на boostMs', [R().boostUntil - Date.now(), M.cfg.raid.boostMs]);
    ok(Math.floor(R().coins) === c0 && Math.floor(R().total) === t0,
      '11.5a КРИТИЧНО: монеты не созданы — ни coins, ни S.total не двинулись',
      [Math.floor(R().coins), c0, Math.floor(R().total), t0]);
    ok(R().rdRedN === 1 && R().rdRedeemed === Math.floor(Date.now() / 86400000),
      '11.5a учтён один обмен сегодняшних суток', [R().rdRedN, R().rdRedeemed]);

    // 11.5b — суточный лимит: perDay обменов проходят, следующий заблокирован.
    ok(M.redeemHonor() === true, '11.5b второй обмен тех же суток прошёл');
    const c1 = Math.floor(R().coins), t1 = Math.floor(R().total);
    ok(M.redeemHonor() === false, '11.5b третий обмен тех же суток отклонён', M.raid().left);
    ok(M.raid().block === 'limit' && M.raid().left === 0,
      '11.5b лимит виден и в состоянии, и в подсказке', M.raid());
    ok(Math.floor(R().coins) === c1 && Math.floor(R().total) === t1,
      '11.5b отклонённый обмен не списал ни чести, ни монет', [Math.floor(R().coins), c1]);
    ok(rd.d.getElementById('btnRaidRedeem').disabled === true,
      '11.5b кнопка обмена выключена, когда лимит исчерпан');
    ok(/исчерпан/.test(rd.d.getElementById('raidNote').textContent),
      '11.5b подсказка говорит правду: «исчерпан»', rd.d.getElementById('raidNote').textContent);
    ok(rd.d.getElementById('raidQuota').textContent === '0/' + perDay,
      '11.5b счётчик лимита обнулён', rd.d.getElementById('raidQuota').textContent);

    // 11.5c — Чести не хватает: обмен запрещён, списания нет.
    R().rdRedeemed = 0; R().rdRedN = 0;              // «наступили новые сутки»
    R().rdHonor = cost - 1;
    ok(M.redeemHonor() === false && M.raid().block === 'poor',
      '11.5c без достаточной чести обмен закрыт', M.raid());
    ok(Math.floor(R().rdHonor) === cost - 1, '11.5c на недостатке чести ничего не списано', Math.floor(R().rdHonor));

    // 11.5d — Край: буст не может уехать за maxBoostAheadMs (тот же, что у рекламы).
    R().rdHonor = 100000; R().rdLife = 100000;
    R().boostUntil = Date.now() + M.cfg.anticheat.maxBoostAheadMs;
    const capBefore = R().boostUntil, honorBefore = Math.floor(R().rdHonor);
    ok(M.redeemHonor() === false && M.raid().block === 'cap',
      '11.5d обмен упирается в край maxBoostAheadMs, а не продлевает буст в бесконечность',
      M.raid().block);
    ok(R().boostUntil === capBefore, '11.5d отказ не тронул срок буста', R().boostUntil);
    ok(Math.floor(R().rdHonor) === honorBefore,
      '11.5d КРИТИЧНО: за бессмысленный обмен честь НЕ списана — край режет покупку, а не награду',
      [Math.floor(R().rdHonor), honorBefore]);
    ok(/пределе/.test(rd.d.getElementById('raidNote').textContent)
      || /пределе/.test(rd.d.getElementById('raidRedeemCta').textContent),
      '11.5d причина отказа названа игроку', rd.d.getElementById('raidNote').textContent);
    rd.dom.window.close();

    // 11.6 — sanitize: рейдовые поля нельзя раздуть из нарисованного сейва.
    const cd = await makeGame({
      seed: seedV4({
        coins: 1000, total: 1000, upClick: 1,
        rdEarned: 999999, rdHonor: 100000, rdLife: 5, rdBest: 77,
        rdRedN: 99, rdRedeemed: 0, gState: 9, gid: -5, rdTries: -3
      })
    });
    const K = cd.w.NEON.state(), KC = cd.w.NEON.cfg;
    ok(K.rdEarned <= K.total, '11.6 журнал недели не может превысить подтверждённый заработок',
      [K.rdEarned, K.total]);
    ok(K.rdHonor <= K.rdLife, '11.6 тратимая честь ограничена пожизненно накопленной', [K.rdHonor, K.rdLife]);
    ok(K.rdBest <= K.rdLife, '11.6 лучшая неделя не может превысить пожизненный итог', [K.rdBest, K.rdLife]);
    ok(K.rdRedN <= KC.raid.perDay, '11.6 суточный лимит обменов не раздувается из сейва', K.rdRedN);
    ok(K.gState >= 0 && K.gState <= 2, '11.6 статус членства — только 0|1|2', K.gState);
    ok(K.gid === 0, '11.6 отрицательный id сообщества отброшен в 0', K.gid);
    ok(K.rdTries >= 0, '11.6 отрицательный счётчик недель не попал в UI', K.rdTries);
    ok(K.susp > 0, '11.6 накрутка рейдовых полей замечена как нарушение', K.susp);
    cd.dom.window.close();
  }

  /* --- 11.7 … 11.8: слияние пакетов двух устройств и интерфейс вкладки --- */
  console.log('\n[11c] Рейд: слияние облака, интерфейс вкладки');
  {
    const devA = await makeGame({
      seed: seedV4({
        coins: 4000, total: 4000, upClick: 1, gid: 111, gState: 1,
        rdHonor: 10, rdLife: 40, rdBest: 20, rdTries: 3, rdEarned: 500,
        lastSeen: Date.now()
      })
    });
    const devB = await makeGame({
      seed: seedV4({
        coins: 3000, total: 9000, upClick: 1, gid: 222, gState: 2,
        rdHonor: 7, rdLife: 30, rdBest: 25, rdTries: 5, rdEarned: 900,
        lastSeen: Date.now() - 3600000
      })
    });
    const A = () => devA.w.NEON.state();
    const packB = devB.w.NEON.pack();
    ok(!!packB && devA.w.NEON.unpack(packB) !== null,
      '11.7 пакет второго устройства читается первым',
      packB && packB.split('#')[0].split('|').length);

    devA.w.NEON.merge(packB, false);                  // побеждает локальный A
    ok(A().gid === 111 && A().gState === 1,
      '11.7 принадлежность едет за ПОБЕДИТЕЛЕМ, а не за максимумом: выход из гильдии не отменяется чужим сейвом',
      [A().gid, A().gState]);
    ok(Math.floor(A().rdHonor) === 10,
      '11.7 КРИТИЧНО: честь НЕ просуммировалась (10+7=17 купило бы лишнего буста)', Math.floor(A().rdHonor));
    ok(A().rdLife === 40 && A().rdBest === 25 && A().rdTries === 5,
      '11.7 пожизненные итоги монотонны: max(40,30), max(20,25), max(3,5)',
      [A().rdLife, A().rdBest, A().rdTries]);
    ok(A().rdHonor <= A().rdLife, '11.7 после слияния честь по-прежнему ограничена пожизненной',
      [A().rdHonor, A().rdLife]);
    ok(A().rdEarned === 900, '11.7 журнал одной недели берётся большим, а не сложением', A().rdEarned);
    ok(A().v === 5, '11.7 версия схемы после слияния — текущая, а не победителя', A().v);

    devA.w.NEON.merge(packB, true);                   // побеждает приехавший B
    ok(A().gid === 222 && A().gState === 2,
      '11.7 если побеждает облако, гильдия переезжает вместе с ним', [A().gid, A().gState]);
    ok(A().rdLife === 40 && A().rdTries === 5, '11.7 монотонные счётчики не откатились', [A().rdLife, A().rdTries]);
    ok(Math.floor(A().rdHonor) === 10,
      '11.7 и при победе облака честь остаётся max, а не суммой', Math.floor(A().rdHonor));

    // Журнал НЕ той же недели: свежее окно выигрывает даже у победившего пакета —
    // иначе вчерашний rdEarned второго устройства обнулил бы сегодняшний журнал A.
    devB.w.NEON.state().rdWeek = WEEK() - 1;
    devB.w.NEON.state().rdEarned = 1234;
    const staleB = devB.w.NEON.pack();
    const weekBefore = A().rdWeek, earnedBefore = A().rdEarned;
    devA.w.NEON.merge(staleB, true);
    ok(A().rdWeek === weekBefore && A().rdEarned === earnedBefore,
      '11.7 журнал устаревшей недели не затирает текущую',
      [weekBefore, earnedBefore, A().rdWeek, A().rdEarned]);
    devA.dom.window.close();
    devB.dom.window.close();

    // 11.8 — UI: карточки есть, а вне VK кнопки членства выключены, рейд же живой.
    const ud = await makeGame({ seed: seedV4({ coins: 3000, total: 3000, upClick: 1 }) });
    const U = ud.w.NEON, D = ud.d;
    U.switchTab('guild');
    ok(!!D.getElementById('guildCard') && !!D.getElementById('raidCard'),
      '11.8 карточки гильдии и рейда есть в разметке');
    ok(D.getElementById('btnGuildJoin').disabled === true && D.getElementById('btnGuildLeave').disabled === true,
      '11.8 вне VK вступаться и выходить некуда: обе кнопки выключены');
    ok(D.getElementById('guildState').textContent === 'Вне гильдии',
      '11.8 статус говорит правду, а не «ошибка»', D.getElementById('guildState').textContent);
    ok(D.getElementById('guildPicker').hidden === true,
      '11.8 пустой roster не показывают: источник истины — запуск из сообщества',
      D.getElementById('guildPicker').hidden);
    ok(D.getElementById('raidQuota').textContent.match(/^\d+\/\d+$/) !== null,
      '11.8 лимит обменов показан как «осталось/всего»', D.getElementById('raidQuota').textContent);
    ok(D.getElementById('raidEarned').textContent.endsWith(U.theme().cur),
      '11.8 заработок недели назван валютой активной темы, а не «монетами»',
      [D.getElementById('raidEarned').textContent, U.theme().cur]);
    ok(D.getElementById('raidTier').textContent.trim().length > 0
      && D.getElementById('raidTierHint').textContent.trim().length > 0,
      '11.8 звание и подсказка до следующего звания видны',
      [D.getElementById('raidTier').textContent, D.getElementById('raidTierHint').textContent]);
    ok(D.getElementById('btnRaidRedeem').disabled === true,
      '11.8 на нулевой чести кнопка обмена выключена: дразниться наградой нельзя');
    /* Та же причина — у выключенной кнопки VIP, но уже без купленного срока:
       игрок, который никогда не нажимал, обязан прочитать «нужно 40, сейчас 0»,
       а не «кнопка не работает». */
    ok(D.getElementById('vipNote').textContent.indexOf(
      'Для новой покупки нужно ' + U.vip().cost + ' чести, сейчас 0.') >= 0,
      '11.8 VIP без чести объясняет, почему кнопка выключена',
      D.getElementById('vipNote').textContent);
    ok(U.raid().week === WEEK(), '11.8 рейд обслужен и вне VK: неделя текущая', U.raid());
    ok(D.getElementById('raidWeek').textContent.trim().length > 0
      && D.getElementById('raidWeek').textContent !== '—',
      '11.8 обратный отчёт до закрытия недели идёт', D.getElementById('raidWeek').textContent);
    ud.dom.window.close();

    // 11.9 — VIP за внутриигровую честь (раздел 13e).
    {
      const vd = await makeGame({ seed: seedV4({ coins: 3000, total: 3000, upClick: 1, rdHonor: 100, rdLife: 100 }) });
      const V = vd.w.NEON, D9 = vd.d;
      V.switchTab('guild');

      ok(!!D9.getElementById('vipCard') && !!D9.getElementById('btnVip'),
        '11.9 карточка VIP есть в разметке');
      ok(V.vip().active === false && V.vip().until === 0,
        '11.9 без покупки VIP нет: until=0, а не выдуманный срок', V.vip());
      ok(D9.getElementById('btnVip').disabled === false,
        '11.9 при чести выше цены кнопка активна', V.vip());
      /* Строка следующей выдачи спрятана, пока статуса нет: обещать «×2 будет
         завтра» тому, у кого завтра ничего не наступит, — декорация. */
      ok(D9.getElementById('vipNext').hidden === true,
        '11.9 без VIP строка суточной выдачи не обещает', D9.getElementById('vipNext').textContent);

      const coins9 = Math.floor(V.state().coins);
      ok(V.buyVip() === true, '11.9 срок куплен');
      ok(V.state().rdHonor === 100 - V.vip().cost,
        '11.9 честь списана ровно на цену срока', [100, V.state().rdHonor]);
      ok(Math.floor(V.state().coins) === coins9,
        '11.9 КРИТИЧНО (инвариант 1 раздела 13d): покупка не тронула монеты ни прибылью, ни списанием',
        [coins9, Math.floor(V.state().coins)]);
      ok(V.vip().active === true && V.vip().left > (V.vip().days - 1) * 86400000,
        '11.9 срок активен и равен CFG.vip.days суток', V.vip());
      ok(V.vip().boost >= Date.now() + V.vip().dailyMs - 10000,
        '11.9 первый день выдан сразу: буст продлён не меньше чем на CFG.vip.dailyMs', V.vip());

      /* ── СРОК СЛЕДУЮЩЕЙ ВЫДАЧИ. Ровно этого карточка не знала с первого дня:
            выдача идемпотентна по суткам UTC, поэтому второй клик в тех же сутках
            списывал честь и молчал — игрок читал это как «уже нажимал сегодня»
            или как сломанную кнопку. Теперь карточка обязана назвать, когда ×2
            придёт снова. ── */
      const v9 = V.vip();
      const nextDayUtc = (Math.floor(Date.now() / 86400000) + 1) * 86400000;
      ok(v9.nextPending === false,
        '11.9 сразу после покупки выдача считается по рубежу суток, а не «задержанной»', v9);
      ok(v9.nextAt === nextDayUtc,
        '11.9 момент следующей выдачи — начало следующих суток UTC', [v9.nextAt, nextDayUtc]);
      ok(D9.getElementById('vipNext').hidden === false,
        '11.9 при активном VIP строка выдачи видна');
      ok(/мин добычи ×2/.test(D9.getElementById('vipNext').textContent)
        && /через/.test(D9.getElementById('vipNext').textContent),
        '11.9 строка выдачи называет и награду, и срок', D9.getElementById('vipNext').textContent);

      /* Повторная покупка ТЕХ ЖЕ суток: честь уходит, срок растёт, а выдача
         приходит только на рубеже суток. Именно эта ветка выглядела как «уже
         нажимал сегодня / ничего не произошло». Тост обязан назвать настоящую
         причину, а не предел буста. */
      V.state().rdHonor = V.vip().cost;
      ok(V.buyVip() === true, '11.9 второй срок тех же суток куплен: лимита на покупку нет');
      ok(V.vip().left > (2 * V.vip().days - 1) * 86400000,
        '11.9 срок сложился, а не обнулился: 7 + 7 суток', V.vip().left);
      ok(/сутки этих календарных суток уже отданы/.test(D9.getElementById('toasts').textContent),
        '11.9 отсрочка повторной покупки названа её настоящей причиной',
        D9.getElementById('toasts').textContent);
      ok(D9.getElementById('guildCard').classList.contains('is-vip'),
        '11.9 значок статуса сел на карточку гильдии', D9.getElementById('guildCard').className);
      ok(D9.getElementById('guildState').textContent !== 'Участник ✓',
        '11.9 VIP не притворяется членством в гильдии: статус — отдельная строка',
        D9.getElementById('guildState').textContent);

      /* Суточная выдача идемпотентна по vipDay, а не по случаю: тик идёт 5 раз
         в секунду, и без этого игра отдала бы 30 минут буста каждые 200 мс. */
      ok(V.backVipDay(0) === false,
        '11.9 те же сутки второй раз не выдают', V.vip());
      const b1 = V.vip().boost;
      ok(V.backVipDay(1) === true, '11.9 наступление новых суток выдаёт дневной буст');
      const b2 = V.vip().boost;
      ok(b2 - b1 === V.vip().dailyMs,
        '11.9 выдача равна РОВНО CFG.vip.dailyMs: половинчатой выдачи не бывает',
        [b1, b2, b2 - b1, V.vip().dailyMs]);

      /* Доезжаем до края maxBoostAheadMs и проверяем, что сутки НЕ списываются.
         Обратный выбор — списать и обрезать — был бы тихим отъёмом награды. */
      V.backVipDay(1);
      const atCap = V.vip();
      ok(atCap.boost <= Date.now() + 90 * 60000 + 2000,
        '11.9 буст не уехал за край maxBoostAheadMs', atCap.boost);
      ok(V.backVipDay(1) === false,
        '11.9 на краю края выдача не состоялась', V.vip());
      V.state().boostUntil = 0;                          // освобождаем край
      ok(V.backVipDay(1) === true,
        '11.9 освобождение края догоняет отложенную выдачу тех же суток: награда не сгорела',
        V.vip());

      /* Задержанная выдача обязана быть названа СВОЕЙ причиной: «буст на пределе»
         — не то же самое, что «выдачи нет». Игрок, топчущий буст, должен видеть
         минуту, когда освободится место, а не гадать. */
      V.state().vipDay = Math.floor(Date.now() / 86400000) - 1;   // сутки ещё не выданы
      V.state().boostUntil = Date.now() + 90 * 60000;             // и буст на пределе
      await sleep(250);
      const vp9 = V.vip();
      ok(vp9.nextPending === true,
        '11.9 невыданные сутки при полном бусте помечены задержанными', vp9);
      ok(Math.abs(vp9.nextAt - (Date.now() + vp9.dailyMs)) < 3000,
        '11.9 срок задержки — момент, когда до края доедет ровно dailyMs',
        [vp9.nextAt, Date.now() + vp9.dailyMs]);
      ok(/задержаны/.test(D9.getElementById('vipNext').textContent),
        '11.9 строка выдачи называет причину задержки', D9.getElementById('vipNext').textContent);
      /* Покупка в таком состоянии тоже проходит (лимит на покупку — не здесь),
         и её тост обязан сказать про край буста, а не про отданные сутки. */
      V.state().rdHonor = V.vip().cost;
      ok(V.buyVip() === true, '11.9 покупка при полном бусте проходит: срок не режется');
      ok(/буст уперся в предел/.test(D9.getElementById('toasts').textContent),
        '11.9 отсрочка из-за края буста названа её настоящей причиной',
        D9.getElementById('toasts').textContent);
      V.state().boostUntil = 0;                                    // край свободен

      /* Отказ при нехватке чести не имеет права тронуть уже купленный срок. */
      V.state().rdHonor = V.vip().cost - 1;
      const untilBefore = V.vip().until;
      ok(V.buyVip() === false, '11.9 не хватает чести — покупки нет');
      ok(V.vip().until === untilBefore,
        '11.9 отказ не тронул уже купленный срок', [untilBefore, V.vip().until]);
      ok(D9.getElementById('btnVip').disabled === true,
        '11.9 при нехватке чести кнопка выключена');
      /* И кнопка обязана объяснить себя текстом: молча севшая кнопка читается
         как «игра сломалась», а не как «не хватает чести». */
      ok(D9.getElementById('vipNote').textContent.indexOf(
        'Для новой покупки нужно ' + V.vip().cost + ' чести, сейчас ' + (V.vip().cost - 1) + '.') >= 0,
        '11.9 неактивная кнопка называет причину: сколько надо и сколько есть',
        D9.getElementById('vipNote').textContent);

      /* Античит: нарисованный срок режется потолком по rdLife, а не принимается. */
      const forged = Date.now() + 3650 * 86400000;        // десять лет
      V.state().rdLife = 100;
      V.state().vipUntil = forged;
      const un9 = V.unpack(V.pack());
      const ceil9 = Date.now() + (Math.floor(100 / V.vip().cost) + 1) * V.vip().days * 86400000;
      ok(!!un9 && un9.vipUntil <= ceil9 + 2000,
        '11.9 нарисованный срок срезан потолком по rdLife, а не принят',
        [forged, un9 && un9.vipUntil, ceil9]);
      vd.dom.window.close();

      /* Слияние двух устройств: срок — максимумом, как boostUntil. Сумма плодила бы
         VIP из ничего, а «у победителя» теряла бы купленный на другом устройстве. */
      const mA = await makeGame({ seed: seedV4({ coins: 3000, total: 3000, rdLife: 100, vipUntil: Date.now() + 3 * 86400000, vipDay: 20740 }) });
      const mB = await makeGame({ seed: seedV4({ coins: 3000, total: 3000, rdLife: 100, vipUntil: Date.now() + 9 * 86400000, vipDay: 20745 }) });
      const MA = () => mA.w.NEON.state();
      mA.w.NEON.merge(mB.w.NEON.pack(), false);            // побеждает локальный A
      ok(MA().vipUntil >= Date.now() + 9 * 86400000 - 60000,
        '11.9 срок при слиянии берётся максимумом, а не у победителя', MA().vipUntil);
      ok(MA().vipUntil < Date.now() + 12.5 * 86400000,
        '11.9 и не суммой: 3 суток + 9 суток не стали 12', MA().vipUntil);
      mA.dom.window.close();
      mB.dom.window.close();
    }
  }

  /* -------- СЦЕНАРИЙ 12. БОЕВЫЕ LAUNCH-ПАРАМЕТРЫ VK --------
     Все прежние прогоны лепят «мы в VK» через isEmbedded() → true. Настоящий
     запуск опознаётся ДРУГИМ кодом — разбором URL (looksLikeVKLaunch / appLink),
     и он ни разу не проверялся с подлинными именами и значениями параметров:
     прежняя версия ждала platform=vk_mobile|vk_pc, которых VK не передаёт
     никогда, а сообщество читала из group_id вместо vk_group_id. Ниже —
     перехваченный query десктопного клиента (vk_ref=left_nav), запуск из папки
     сообщества, обёртка location_search, хэш и негативные контроли. */
  console.log('[12] Боевые launch-параметры VK: desktop_web, сообщество, location_search');
  {
    const APP = '6909581', GRP = '166562603';
    const U_APP = 'https://vk.com/app' + APP;
    const U_GRP = U_APP + '_-' + GRP;
    const PERSONAL = 'vk_app_id=' + APP + '&vk_user_id=343080782&vk_platform=desktop_web'
      + '&vk_language=ru&vk_ref=left_nav&vk_ts=1792341397'
      + '&vk_are_notifications_enabled=0&vk_is_app_user=1&vk_is_favorite=1';
    const COMMUNITY = PERSONAL + '&vk_group_id=' + GRP + '&vk_viewer_group_role=member';

    /* Отладочный хук window.NEON живёт только при ?debug=1 (см. .stress-check.cjs
       [st=prod]: в боевом запуске его нет, и нарисовать себе монеты из консоли
       нельзя). Поэтому debug=1 добавляет сюда именно тест, а не игра. */
    const launch = async (query, embedded) => {
      const g = await makeGame({
        url: 'https://app.neonclick.local/index.html?debug=1&' + query,
        vkBridge: mockBridge({ embedded: embedded !== false }),
        demo: true, settle: 250
      });
      await g.w.VK.ready;
      return g;
    };
    const has = (g, s) => g.w.vkBridge.calls.indexOf(s) >= 0;

    // 12.1 — обычный боевой запуск: клиент VK подтверждает себя сам.
    const p1 = await launch(PERSONAL, true);
    ok(p1.w.VK.isVK() === true && p1.w.VK.isDemo() === false,
      '12.1 боевой desktop_web-запуск опознан, демо-ветка наград закрыта');
    ok(p1.w.VK.shareLink() === U_APP,
      '12.1 личному приложению собрана ссылка vk.com/app{vk_app_id}', p1.w.VK.shareLink());
    ok(p1.w.VK.guildLaunch() === null && p1.w.NEON.guild().gid === 0,
      '12.1 без vk_group_id гильдия не выдумывается', p1.w.NEON.guild());
    ok(has(p1, 'VKWebAppInit') && p1.w.vkBridge.calls[0] === 'VKWebAppInit',
      '12.1 первым ушёл обязательный VKWebAppInit', p1.w.vkBridge.calls.slice(0, 3));
    p1.dom.window.close();

    // 12.2 — тот же URL, но isEmbedded() молчит: вся надежда на параметры.
    const p2 = await launch(PERSONAL, false);
    ok(p2.w.VK.isVK() === true && p2.w.VK.isDemo() === false,
      '12.2 launch-параметры опознали VK без isEmbedded()');
    ok(p2.w.VK.shareLink() === U_APP, '12.2 ссылка не зависит от способа распознавания', p2.w.VK.shareLink());
    const r2 = await p2.w.VK.showRewardedAd('smoke12');
    ok(r2.ok === true && r2.code === 'success',
      '12.2 награда идёт через рекламный мост VK, а не по демо-ветке (code ≠ demo)', r2);
    ok(has(p2, 'VKWebAppCheckNativeAds:reward') && has(p2, 'VKWebAppShowNativeAds:reward'),
      '12.2 check и show отправлены с ad_format=reward', p2.w.vkBridge.calls);
    p2.dom.window.close();

    // 12.3 — запуск из папки сообщества: vk_group_id приезжает ПОЛОЖИТЕЛЬНЫМ,
    //        а в ссылке сообщество обязано быть с минусом (docs: app…_-<id>).
    const c3 = await launch(COMMUNITY, true);
    ok(c3.w.VK.shareLink() === U_GRP,
      '12.3 vk_group_id прочитан и записан со знаком минус', c3.w.VK.shareLink());
    const gl = c3.w.VK.guildLaunch();
    ok(!!gl && gl.groupId === Number(GRP) && gl.role === 'member',
      '12.3 гильдия и роль взяты из vk_group_id / vk_viewer_group_role', gl);
    ok(c3.w.NEON.guild().gid === Number(GRP), '12.3 id сообщества дошёл до вкладки', c3.w.NEON.guild());
    ok(await c3.w.VK.share() === true && has(c3, 'VKWebAppShare:' + U_GRP),
      '12.3 другу уехала ссылка сообщества, а не личного приложения',
      c3.w.vkBridge.calls.filter((x) => /Share/.test(x)));
    c3.dom.window.close();

    // 12.4 — наши стенды (?app_id=…&group_id=-1) не должны сломаться.
    const l4 = await launch('app_id=6089842&group_id=-1', true);
    ok(l4.w.VK.shareLink() === 'https://vk.com/app6089842_-1',
      '12.4 старые имена параметров и уже отрицательный id не удвоили минус', l4.w.VK.shareLink());
    l4.dom.window.close();

    // 12.5 — VK заворачивает query приложения в location_search; хэш — путь QR.
    const w5 = await launch('location_search=' + encodeURIComponent(PERSONAL), false);
    ok(w5.w.VK.isVK() === true && w5.w.VK.shareLink() === U_APP,
      '12.5 параметры в location_search прочитаны', w5.w.VK.shareLink());
    w5.dom.window.close();
    const h5 = await launch('#/?' + COMMUNITY, false);
    ok(h5.w.VK.isVK() === true && h5.w.VK.shareLink() === U_GRP,
      '12.5 параметры из хэша (прямые ссылки, QR) прочитаны', h5.w.VK.shareLink());
    h5.dom.window.close();

    // 12.6 — негативные контроли: прикидываться VK запрещено.
    const neg = [
      ['', 'обычный сайт без параметров VK'],
      ['vk_platform=web_external&vk_user_id=343080782', '*_external = запуск ВНЕ VK'],
      ['platform=mobile&user_id=5', 'чужие короткие имена — не признак VK'],
      ['vk_user_id=343080782', 'одного user_id без vk_ts мало']
    ];
    for (const [q, why] of neg) {
      const n6 = await launch(q, false);
      ok(n6.w.VK.isVK() === false && n6.w.VK.isDemo() === true && n6.w.VK.shareLink() === null,
        '12.6 не приняли за VK: ' + why, n6.w.VK.shareLink());
      n6.dom.window.close();
    }

    // 12.7 — документированная платформа без app_id: VK да, шарить нечего.
    const p7 = await launch('vk_platform=mobile_android', false);
    ok(p7.w.VK.isVK() === true && p7.w.VK.shareLink() === null,
      '12.7 vk_platform=mobile_android — VK без выдумки, но и ссылки нет',
      [p7.w.VK.isVK(), p7.w.VK.shareLink()]);
    p7.dom.window.close();
  }






  console.log('\n========== ИТОГ: ' + pass + ' ok / ' + fail + ' fail ==========\n');
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('\nКРАШ ТЕСТА:\n', err); process.exit(1); });

