/* ==========================================================================
 * .visual-check.cjs — визуальная проверка NEON CLICK в настоящем Chromium
 * (Edge/Chrome) через puppeteer-core. Скриншоты кладёт в папку --shots.
 * Запуск: node .visual-check.cjs <dirСоСкриншотами>
 * ======================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const { requireDevStand } = require('./tools/stand-guard.cjs');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];
const OUT = process.argv[2] || path.join(require('os').tmpdir(), 'neon-shots');
/* Адрес стенда: по умолчанию 5173, переопределяется через NEON_BASE
   (например, Live Server в VS Code поднимает сайт на 5500). */
const ORIGIN = (process.env.NEON_BASE || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const URL = ORIGIN + '/index.html?debug=1';
fs.mkdirSync(OUT, { recursive: true });

const exe = BROWSERS.find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  ' + a.join(' '));
let passed = 0, failed = 0;
const ok2 = (cond, name, extra) => {
  if (cond) { passed++; log('\u2705 ' + name); }
  else { failed++; log('\u274c ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra) : '')); }
};

/* ★ ДЕМО-СБОРКА — только на время прогона. Репозиторий обязан хранить флаг
   выключенным (иначе публичная игра раздаёт награды без рекламы), а разделы
   5–6 проверяют ветку наград живыми тапами. Разрешается противоречие
   перехватом запроса vk-integration.js ниже. Якорь — ровно одно объявление
   флага: возврат «true» в исходник уронит прогон, а не спрячется за ним. */
function withDemo(src) {
  const RE = /\bconst\s+DEMO_MODE\s*=\s*false\s*;/g;
  const n = (src.match(RE) || []).length;
  if (n !== 1) {
    throw new Error('ожидал ровно одно «DEMO_MODE = false» в vk-integration.js, нашёл ' + n +
      ' — либо флаг снова включён в репозитории, либо формат объявления сменился');
  }
  return src.replace(RE, 'const DEMO_MODE = true;');
}

(async () => {
  /* Префлайт стенда: разделы тыкают в живую игру через window.NEON, поэтому
     здесь нужны исходники, а не собранный _site (см. tools/stand-guard.cjs). */
  await requireDevStand(ORIGIN, '.visual-check.cjs').catch((e) => { console.error('\n\u274c ' + e.message + '\n'); process.exit(1); });
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb', '--hide-scrollbars']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/Failed to load resource/.test(t)) problems.push('console.error: ' + t);
  });
  page.on('response', (r) => { if (r.status() >= 400) problems.push('HTTP ' + r.status() + ' ' + r.url()); });
  page.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url() + ' (' + (r.failure() || {}).errorText + ')'));

  const shot = async (name) => { await page.screenshot({ path: path.join(OUT, name + '.png') }); log('📸 ' + name + '.png'); };

  log('браузер:', exe);

  /* Демо-сборка в перехват: к игроку уходит боевой файл репозитория, а
     разделы 5–6 получают работающую ветку наград. Если флаг в репозитории
     окажется включённым, прогон не падает, а краснеет подсчётной проверкой —
     иначе диагностика теряется ещё до первой картинки. */
  const VK_REPO_SRC = fs.readFileSync(path.join(__dirname, 'vk-integration.js'), 'utf8');
  let DEMO_ERR = null, DEMO_SRC = VK_REPO_SRC;
  try { DEMO_SRC = withDemo(VK_REPO_SRC); } catch (e) { DEMO_ERR = e.message; }
  let demoServed = 0;
  await page.setRequestInterception(true);
  await page.setCacheEnabled(false);
  page.on('request', (r) => {
    if (/vk-integration\.js(\?|$)/.test(r.url())) {
      demoServed++;
      r.respond({ status: 200, contentType: 'application/javascript; charset=utf-8', body: 'window.__DEMO_BUILD__=' + (DEMO_ERR ? 'false' : 'true') + ';\n' + DEMO_SRC });
      return;
    }
    r.continue();
  });

  await page.goto(URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !!window.NEON && !!window.VK, { timeout: 15000 });
  await sleep(900);
  ok2(DEMO_ERR === null, 'репозиторий хранит выключенный DEMO_MODE (демо-сборка собрана подменой)', DEMO_ERR);
  ok2(demoServed > 0 && await page.evaluate(() => window.__DEMO_BUILD__ === true && window.VK.isDemo() === true),
    'ветка наград проверяется демо-сборкой, собранной перехватом (репозиторий не тронут)', demoServed);

  /* --- 1. Пустой старт --- */
  await shot('01-idle');

  /* --- 1b. Хит-тест: что реально стоит поверх монеты и видно ли скрытое --- */
  const probe = await page.evaluate(() => {
    const c = document.getElementById('coin').getBoundingClientRect();
    const topEl = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2);
    const disp = (id) => getComputedStyle(document.getElementById(id)).display;
    return {
      topOfCoin: topEl ? (topEl.id || topEl.className || topEl.tagName) : 'null',
      coinReachable: !!topEl && !!topEl.closest('#coin'),
      modal: disp('modal'), combo: disp('combo'), boost: disp('boost'), bonus: disp('tabBonus'), shop: disp('tabShop')
    };
  });
  log('probe:', JSON.stringify(probe));
  ok2(probe.coinReachable, 'поверх монеты ничего нет — тап доходит до цели', probe);
  ok2(probe.modal === 'none' && probe.combo === 'none' && probe.boost === 'none' && probe.bonus === 'none', 'hidden-элементы реально не отрисованы', probe);
  ok2(probe.shop !== 'none', 'таб «Магазин» открыт по умолчанию', probe);

  /* --- 1c. Баланс растёт от живых тапов мышью --- */
  const c0 = await page.evaluate(() => window.NEON.state().coins);

  /* --- 2. Серия тапов: комбо, искры, «+N» --- */
  const coin = await page.$('#coin');
  const box = await coin.boundingBox();
  for (let i = 0; i < 14; i++) {
    await page.mouse.click(box.x + box.width / 2 + (Math.random() * 40 - 20), box.y + box.height / 2 + (Math.random() * 40 - 20));
    await sleep(45);
  }
  await sleep(60);
  await shot('02-combo-sparks');
  const hud = await page.evaluate(() => ({
    balance: document.getElementById('balance').textContent,
    combo: document.getElementById('comboX').textContent,
    comboVisible: !document.getElementById('combo').hidden,
    floats: document.querySelectorAll('#floats .float').length,
    canvasPainted: (() => {
      const c = document.getElementById('fx');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
      return false;
    })()
  }));
  log('HUD:', JSON.stringify(hud));
  const c1 = await page.evaluate(() => window.NEON.state().coins);
  ok2(c1 - c0 >= 14, '14 живых тапов принесли ≥14 монет (клик работает в браузере)', [c0, c1]);
  ok2(hud.comboVisible, 'комбо-индикатор показался при серии тапов', hud);

  /* --- 3. Покупки и магазин --- */
  await page.evaluate(() => window.NEON.add(6000));
  await sleep(200);
  await page.click('#buyAuto'); await sleep(120);
  await page.click('#buyAuto'); await sleep(120);
  await page.click('#buyClick'); await sleep(120);
  await page.click('#buyClick'); await sleep(200);
  await shot('03-shop-bought');

  /* --- 4. Таб «Бонусы» --- */
  await page.click('.tab[data-tab="bonus"]');
  await sleep(400);
  await shot('04-bonus-tab');
  const note = await page.$eval('#adNote', (n) => n.textContent);
  log('adNote:', note);

  /* --- 5. Награда за рекламу (демо-перехват) --- */
  const psBefore = await page.$eval('#perSecond', (e) => parseInt(e.textContent.replace(/\D/g, ''), 10) || 0);
  const coins0 = await page.evaluate(() => window.NEON.state().coins);
  await page.click('#btnCoins');
  await sleep(400);
  await shot('05-ad-busy');
  const busyLabel = await page.$eval('#coinsCta', (e) => e.textContent);
  const busyDisabled = await page.$eval('#btnCoins', (e) => e.disabled);
  log('во время показа:', JSON.stringify({ busyLabel, busyDisabled }));
  await sleep(1400);
  const coins1 = await page.evaluate(() => window.NEON.state().coins);
  const reward = coins1 - coins0;
  log('награда за ролик: +' + Math.round(reward) + ' монет (из них ~' + psBefore * 2 + ' — пассив за 2 сек)');
  await shot('06-ad-reward');
  ok2(reward >= 1000 && reward < 1000 + psBefore * 4 + 20, 'выдано 1000 монет + честный пассив за время ожидания', [reward, psBefore]);
  ok2(busyLabel.indexOf('дём') !== -1 && busyDisabled, 'на время показа кнопка занята и задизейблена', { busyLabel, busyDisabled });

  /* --- 6. Буст ×2 --- */
  await page.click('#btnDouble');
  await sleep(1800);
  await sleep(400);
  await shot('07-boost-active');
  const boost = await page.evaluate(() => ({
    perSecond: parseInt(document.getElementById('perSecond').textContent.replace(/\D/g, ''), 10) || 0,
    time: document.getElementById('boostTime').textContent,
    shown: !document.getElementById('boost').hidden,
    boostDisplay: getComputedStyle(document.getElementById('boost')).display,
    bar: getComputedStyle(document.getElementById('boostBar')).transform
  }));
  log('буст:', JSON.stringify(boost), 'было в секунду: +' + psBefore);
  ok2(psBefore > 0 && boost.perSecond === psBefore * 2, 'буст ×2 ровно удваивает пассивный доход', [psBefore, boost.perSecond]);
  ok2(boost.shown && boost.boostDisplay === 'flex' && /^4:5\d|^5:00$/.test(boost.time.trim()), 'плашка буста видна и таймер тикает от 5:00', boost);
  /* --- 7. Модалка подтверждения --- */
  await page.click('#btnReset');
  await sleep(450);
  await shot('08-reset-modal');
  await page.click('#modalCancel');
  await sleep(300);

  /* --- 8. Геометрия и отсутствие горизонтального скролла --- */
  const layout = await page.evaluate(() => {
    const r = (sel) => { const e = document.querySelector(sel); const b = e.getBoundingClientRect(); return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), w: Math.round(b.width) }; };
    const st = r('#stage'), wa = r('.wallet'), pa = r('.panel'), co = r('#coin');
    return {
      docW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      overflowY: document.documentElement.scrollHeight > window.innerHeight + 1,
      stage: st, wallet: wa, panel: pa, coin: co,
      overlapWalletStage: st.t < wa.b - 1,
      overlapPanelStage: pa.t < st.b - 1,
      coinCentered: Math.abs((co.l + co.w / 2) - (st.l + st.w / 2)) <= 2,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      accent: getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim(),
      safeBottom: getComputedStyle(document.querySelector('.panel')).paddingBottom,
      fontFamily: getComputedStyle(document.body).fontFamily
    };
  });
  log('layout:', JSON.stringify(layout));
  ok2(layout.docW <= layout.innerW, 'нет горизонтального скролла (' + layout.docW + '<=' + layout.innerW + ')');
  ok2(!layout.overlapWalletStage && !layout.overlapPanelStage, 'кошелёк / сцена / панель не наезжают друг на друга');
  ok2(layout.coinCentered, 'монета отцентрована в сцене');
  ok2(layout.stage.b - layout.stage.t > 220, 'сцена достаточно высокая: ' + (layout.stage.b - layout.stage.t) + 'px');
  ok2(hud.floats > 0 && hud.canvasPainted, 'эффекты работают: всплывашки + canvas-частицы', hud);

  /* --- 9. Персистентность: перезагрузка страницы --- */
  const before = await page.evaluate(() => { window.NEON.save(); const s = window.NEON.state(); return { coins: Math.floor(s.coins), upClick: s.upClick, upAuto: s.upAuto, total: Math.floor(s.total) }; });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !!window.NEON, { timeout: 15000 });
  await sleep(700);
  const after = await page.evaluate(() => { const s = window.NEON.state(); return { coins: Math.floor(s.coins), upClick: s.upClick, upAuto: s.upAuto, total: Math.floor(s.total) }; });
  log('до перезагрузки:', JSON.stringify(before));
  log('после перезагрузки:', JSON.stringify(after));
  ok2(after.upClick === before.upClick && after.upAuto === before.upAuto, 'апгрейды восстановились из LocalStorage');
  const drift = after.coins - before.coins;
  ok2(drift >= -2 && drift <= (boost.perSecond + 1) * 10, 'баланс восстановился + честный офлайн-докрут за время перезагрузки', [before.coins, after.coins, drift]);
  await shot('09-after-reload');

  /* --- 9b. Модалка и полный сброс прогресса (живьём, с хит-тестом) --- */
  await page.click('#btnReset');
  await sleep(300);
  const modalOpen = await page.evaluate(() => {
    const m = document.getElementById('modal');
    const b = document.querySelector('.modal__box').getBoundingClientRect();
    const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    const c = document.getElementById('coin').getBoundingClientRect();
    const overCoin = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2);
    return {
      display: getComputedStyle(m).display,
      topInBox: !!(top && top.closest('.modal__box')),
      blocksCoin: !!(overCoin && !overCoin.closest('#coin')),
      title: document.getElementById('modalTitle').textContent
    };
  });
  await shot('11-modal-open');
  log('модалка:', JSON.stringify(modalOpen));
  ok2(modalOpen.display !== 'none' && modalOpen.topInBox, 'модалка открывается и принимает тап на себя', modalOpen);
  ok2(modalOpen.blocksCoin, 'открытая модалка перекрыла монету (ожидаемое модальное поведение)', modalOpen);
  await page.click('#modalOk');
  await sleep(400);
  const zeroed = await page.evaluate(() => {
    const s = window.NEON.state();
    return { coins: Math.floor(s.coins), upClick: s.upClick, upAuto: s.upAuto, total: Math.floor(s.total), modal: getComputedStyle(document.getElementById('modal')).display };
  });
  log('после «Сбросить»:', JSON.stringify(zeroed));
  ok2(zeroed.coins === 0 && zeroed.upClick === 0 && zeroed.upAuto === 0 && zeroed.total === 0 && zeroed.modal === 'none', '«Сбросить» обнулил прогресс и закрыл модалку', zeroed);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => !!window.NEON, { timeout: 15000 });
  await sleep(600);
  const stillZero = await page.evaluate(() => Math.floor(window.NEON.state().coins));
  ok2(stillZero === 0, 'после сброса и перезагрузки баланс остаётся нулём — сейв действительно очищен', stillZero);

  /* --- 10. Ряд вьюпортов: от iPhone SE до планшета и повёрнутого телефона --- */
  const VIEWPORTS = [
    { w: 320, h: 568, tag: 'iPhone SE 1' },
    { w: 375, h: 667, tag: 'iPhone SE 2 / 8' },
    { w: 390, h: 844, tag: 'iPhone 14' },
    { w: 412, h: 915, tag: 'Galaxy A/S' },
    { w: 844, h: 390, tag: 'iPhone ландшафт' },
    { w: 740, h: 360, tag: 'Android ландшафт' },
    { w: 768, h: 1024, tag: 'планшет' }
  ];

  /* Монета — единственная кнопка, в которую играют непрерывно, и она обязана
     оставаться диском, а не становиться препятствием для соседних элементов.
     Ни её золотой круг, ни жёсткая дуга кольца (inset −7% от диаметра) не имеют
     права накрыть подсказку «Жми по монете. Держи серию — лови крит.» сверху или
     таббар с «Бонусами» снизу. Баг жил здесь: размер монеты считался от ширины
     экрана, поэтому на низком вьюпорте (шапка VK в WebView, полная лента наград,
     плашка буста в кошельке) диск расползался ровно туда.
     Меряется на двух табах — «Магазин» (самая низкая панель) и «Бонусы» (самая
     высокая): сцена между ними различается на сотню пикселей, и именно на
     «Бонусах» запаса раньше не хватало. */
  const RING_BLEED = 0.07;                 // .coin__ring: inset −7% + 2px рамки
  async function clearance(vp, where) {
    const c = await page.evaluate((bleed) => {
      const box = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
      const live = (s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; };
      const cross = (a, b) => !!a && !!b && a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right;
      const coin = box('#coin'), hint = box('.hint'), tabs = box('.tabs'), stage = box('#stage');
      const p = Math.round(coin.width * bleed) + 2;
      const aura = { top: coin.top - p, bottom: coin.bottom + p, left: coin.left - p, right: coin.right + p };
      const mid = document.elementFromPoint(Math.round(coin.left + coin.width / 2), Math.round(coin.top + coin.height / 2));
      const tb = box('.tab[data-tab="bonus"]');
      const onTab = document.elementFromPoint(Math.round(tb.left + tb.width / 2), Math.round(tb.top + tb.height / 2));
      const onHint = live('.hint') ? document.elementFromPoint(Math.round(hint.left + hint.width / 2), Math.round(hint.top + hint.height / 2)) : null;
      return {
        coin: Math.round(coin.width) + '×' + Math.round(coin.height),
        disk: Math.abs(coin.width - coin.height) <= 1 && Math.round(coin.width) >= 64,
        inStage: coin.top >= stage.top - 1 && coin.bottom <= stage.bottom + 1 &&
          coin.left >= stage.left - 1 && coin.right <= stage.right + 1,
        reachable: !!mid && !!mid.closest('#coin'),
        tabHit: !!onTab && !!onTab.closest('.tabs'),
        hintHit: !live('.hint') || (!!onHint && !!onHint.closest('.hint')),
        overHint: live('.hint') && cross(aura, hint),
        overTabs: cross(aura, tabs)
      };
    }, RING_BLEED);
    const t = vp.w + '×' + vp.h + ' [' + where + ']:';
    log('  зазор монеты:', JSON.stringify(c));
    ok2(c.disk, t + ' монета — диск (круг ≥64px), а не эллипс и не огрызок', c.coin);
    ok2(c.inStage && c.reachable && c.tabHit && c.hintHit,
      t + ' тап доходит и до монеты, и до таба «Бонусы», и до подсказки', c);
    ok2(!c.overHint && !c.overTabs,
      t + ' монета с кольцом не наезжает ни на подсказку, ни на таббар', c);
    return c;
  }

  for (const vp of VIEWPORTS) {
    await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 2, isMobile: vp.w < 600, hasTouch: vp.w < 600 });
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForFunction(() => !!window.NEON, { timeout: 15000 });
    await sleep(450);
    const m = await page.evaluate(() => {
      const inVp = (e) => { const b = e.getBoundingClientRect(); return { b, fits: b.top >= -1 && b.bottom <= window.innerHeight + 1 && b.left >= -1 && b.right <= window.innerWidth + 1 }; };
      const coin = inVp(document.getElementById('coin'));
      const panel = inVp(document.querySelector('.panel'));
      const tabs = inVp(document.querySelector('.tabs'));
      const topEl = document.elementFromPoint(coin.b.x + coin.b.width / 2, coin.b.y + coin.b.height / 2);
      return {
        docW: document.documentElement.scrollWidth, innerW: window.innerWidth,
        docH: document.documentElement.scrollHeight, innerH: window.innerHeight,
        coinFits: coin.fits, panelFits: panel.fits, tabsFits: tabs.fits,
        coinH: Math.round(coin.b.height),
        reachable: !!topEl && !!topEl.closest('#coin'),
        shopScrolls: (() => { const t = document.getElementById('tabShop'); return t.scrollHeight > t.clientHeight + 1; })()
      };
    });
    const before = await page.evaluate(() => window.NEON.state().coins);
    /* Тап — в центр самого диска, а не в середину экрана: в повёрнутом телефоне
       сцена занимает левую колонку, и x=innerWidth/2 попал бы на панель
       магазина, а не на монету (проверка «клик приносит монеты» краснела бы
       там, где всё на самом деле хорошо). */
    const cc = await page.$eval('#coin', (e) => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
    await page.mouse.click(Math.round(cc.x), Math.round(cc.y));
    await sleep(200);
    const after = await page.evaluate(() => window.NEON.state().coins);
    log(vp.w + '×' + vp.h + ' (' + vp.tag + '):', JSON.stringify(m), 'клик: +' + (after - before).toFixed(2));
    ok2(m.docW <= m.innerW, vp.w + '×' + vp.h + ': нет горизонтального скролла', m);
    ok2(m.docH <= m.innerH + 1, vp.w + '×' + vp.h + ': приложение не скроллится по вертикали', [m.docH, m.innerH]);
    ok2(m.coinFits && m.reachable, vp.w + '×' + vp.h + ': монета целиком в экране и доступна тапу', m);
    ok2(m.panelFits && m.tabsFits, vp.w + '×' + vp.h + ': панель и таббар помещаются', m);
    ok2(after > before, vp.w + '×' + vp.h + ': живой тап по монете приносит монеты', [before, after]);
    await clearance(vp, 'магазин');
    await shot('10-vp-' + vp.w + 'x' + vp.h);

    /* Та же сетка вьюпортов на новой вкладке «Гильдия»: здесь три таба вместо
       двух, а карточки содержат четыре счётчика в ряд — именно на 320px такие
       ряды схлопываются в ноль или распирают страницу. */
    await page.click('.tab[data-tab="guild"]');
    await sleep(250);
    const gu = await page.evaluate(() => {
      const box = (id) => {
        const e = document.getElementById(id);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return {
          w: Math.round(b.width), h: Math.round(b.height),
          tx: (e.textContent || '').trim().length,
          invisible: cs.visibility === 'hidden' || Number(cs.opacity) === 0
        };
      };
      const tabs = [].slice.call(document.querySelectorAll('.tab')).map((e) => {
        const b = e.getBoundingClientRect();
        return { t: (e.textContent || '').trim(), w: Math.round(b.width), h: Math.round(b.height) };
      });
      const body = document.getElementById('tabGuild');
      return {
        docW: document.documentElement.scrollWidth, innerW: window.innerWidth,
        open: !body.hidden, tabs: tabs,
        // Высота карточки против высоты её же содержимого. Рассхождение — это
        // flex-сжатие прямого ребёнка .tabbody: карточка уминается до окна
        // панели, а scrollHeight контейнера при этом равен clientHeight, то
        // есть скролл не появляется вообще и недостающее молча режет
        // overflow:hidden самой карточки.
        cards: [].slice.call(body.children).filter((e) => e.getBoundingClientRect().height > 0)
          .map((e) => ({ id: e.id, squash: e.scrollHeight - Math.round(e.getBoundingClientRect().height) })),
        guild: box('guildCard'), raid: box('raidCard'),
        join: box('btnGuildJoin'), leave: box('btnGuildLeave'), redeem: box('btnRaidRedeem'),
        stats: ['raidHonor', 'raidLife', 'raidBest', 'raidTries', 'raidEarned', 'raidWeek'].map(box),
        scrolls: body.scrollHeight > body.clientHeight + 1
      };
    });
    ok2(gu.open && gu.docW <= gu.innerW, vp.w + '×' + vp.h + ': вкладка «Гильдия» открыта и не распирает страницу', [gu.open, gu.docW, gu.innerW]);
    ok2(gu.tabs.length === 3 && gu.tabs.every((t) => t.t.length > 0 && t.w > 30 && t.h >= 28),
      vp.w + '×' + vp.h + ': три таба читаемы и не схлопнулись', gu.tabs);
    ok2(gu.guild && gu.guild.w > 40 && gu.raid && gu.raid.w > 40,
      vp.w + '×' + vp.h + ': обе карточки имеют реальную ширину', [gu.guild, gu.raid]);
    ok2(gu.join.h >= 30 && gu.leave.h >= 30 && gu.redeem.h >= 30,
      vp.w + '×' + vp.h + ': тап-таргеты гильдии и обмена не мельче 30px',
      [gu.join.h, gu.leave.h, gu.redeem.h]);
    ok2(gu.stats.every((s) => s && s.w > 0 && s.tx > 0 && !s.invisible),
      vp.w + '×' + vp.h + ': все рейдовые счётчики видимы и не пусты', gu.stats);
    ok2(gu.cards.length === 2 && gu.cards.every((c) => c.squash <= 1),
      vp.w + '×' + vp.h + ': карточки «Гильдии» не сплющены — высота равна содержимому', gu.cards);
    await shot('10-guild-' + vp.w + 'x' + vp.h);

    /* --- 10b. Вкладка «Бонусы»: самая высокая карточка игры и подсказка скролла.
       Здесь «Ва-банк» (163px) соседствует с тремя рекламными рядами, и весь этот
       стек не влезает в панель, обрезанную max-height: 42vh. Значит важны два
       независимых факта: карточки не умяты изнутри (иначе игрок не видит чипы
       доли, сумму ставки и кнопку «Поставить») и всё, что уехало за край, реально
       достижимо прокруткой. Пока ниже есть непросмотренное, на панели горит
       подложка с шевроном (.is-more); на дне она обязана погаснуть. */
    await page.click('.tab[data-tab="bonus"]');
    await sleep(250);
    const bo = await page.evaluate(async () => {
      const body = document.getElementById('tabBonus');
      const panel = document.getElementById('panel');
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      // Подложка гаснет переходом .22s: читаем только устоявшуюся прозрачность,
      // иначе проверка ловит середину анимации.
      const settle = () => new Promise((r) => setTimeout(r, 320));
      const lit = () => ({
        cls: panel.classList.contains('is-more'),
        fade: Number(getComputedStyle(panel, '::after').opacity)
      });
      const cards = [].slice.call(body.children).filter((e) => e.getBoundingClientRect().height > 0)
        .map((e) => ({ id: e.id, squash: e.scrollHeight - Math.round(e.getBoundingClientRect().height) }));
      const overflow = body.scrollHeight - body.clientHeight;
      body.scrollTop = 0;
      await settle(); await frame();
      const top = lit();
      body.scrollTop = body.scrollHeight;
      await settle(); await frame();
      const end = lit();
      const box = body.getBoundingClientRect();
      const lastBox = body.lastElementChild.getBoundingClientRect();
      // elementFromPoint никогда не возвращает псевдоэлемент: если подложка
      // лишится pointer-events:none, хостом окажется сама .panel — проверка
      // поймает это как «тап не доходит до контента таба».
      const hit = document.elementFromPoint(Math.round(box.x + box.width / 2), Math.round(box.bottom - 6));
      body.scrollTop = 0;
      await settle();
      return {
        cards, overflow, top, end,
        lastShown: lastBox.top >= box.top - 1 && lastBox.bottom <= box.bottom + 1,
        tapReaches: !!(hit && hit.closest && hit.closest('#tabBonus')),
        docW: document.documentElement.scrollWidth, innerW: window.innerWidth
      };
    });
    ok2(bo.docW <= bo.innerW, vp.w + '×' + vp.h + ': таб «Бонусы» не распирает страницу', [bo.docW, bo.innerW]);
    ok2(bo.cards.length === 5 && bo.cards.every((c) => c.squash <= 1),
      vp.w + '×' + vp.h + ': карточки «Бонусов» не сплющены — «Ва-банк» целен целиком', bo.cards);
    if (bo.overflow > 0) {
      ok2(bo.top.cls === true && bo.top.fade > .5, vp.w + '×' + vp.h +
        ': за нижним краем ещё есть что смотреть — подсказка горит', bo.top);
      ok2(bo.end.cls === false && bo.end.fade < .05, vp.w + '×' + vp.h +
        ': прокрутили до дна — подсказка погасла', bo.end);
      ok2(bo.lastShown, vp.w + '×' + vp.h + ': прокруткой открывается последняя карточка таба', bo.overflow);
    }
    ok2(bo.tapReaches, vp.w + '×' + vp.h + ': подложка-подсказка не перехватывает тап', null);
    await clearance(vp, 'бонусы');
    await shot('10-bonus-' + vp.w + 'x' + vp.h);
    await page.click('.tab[data-tab="shop"]');
  }

  /* --- 11. ТЕМЫ: каждая собирается, реально красится и влезает в экран ---
     Здесь ловятся те баги ребрендинга, которых не видит jsdom: несуществующая
     CSS-переменная, картинка с 404 (problems ловит HTTP>=400), распирание
     вёрстки длинным названием валюты, невидимый глиф монеты. */
  const THEME_IDS = await page.evaluate(() => window.NEON.themes());
  log('темы:', THEME_IDS.join(', '));
  for (const tid of THEME_IDS) {
    const th = await page.evaluate((x) => {
      const t = window.NEON.themeOf(x);
      return { cur: t.cur, glyph: t.glyph, accent: t.accent, bg: t.bg, logo: t.copy.logo, hasImage: !!t.image };
    }, tid);
    await page.goto(URL + '&theme=' + tid, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => !!window.NEON && !!window.VK, { timeout: 15000 });
    await sleep(700);
    const v = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const coin = document.getElementById('coin').getBoundingClientRect();
      const face = document.getElementById('coinFace');
      const row = document.querySelector('.wallet__row');
      const topEl = document.elementFromPoint(coin.x + coin.width / 2, coin.y + coin.height / 2);
      return {
        attr: document.documentElement.getAttribute('data-theme'),
        title: document.title,
        logo: document.getElementById('logoTxt').textContent,
        cyan: cs.getPropertyValue('--cyan').trim(),
        bg: cs.getPropertyValue('--bg').trim(),
        meta: (document.querySelector('meta[name="theme-color"]') || {}).content,
        cap: document.getElementById('balCap').textContent,
        face: face.textContent,
        faceW: Math.round(face.getBoundingClientRect().width),
        imgs: document.querySelectorAll('.coin__img').length,
        unbound: [].slice.call(document.querySelectorAll('[data-t]')).filter((n) => !n.textContent.trim()).length,
        coinFits: coin.right <= window.innerWidth + 1 && coin.bottom <= window.innerHeight + 1,
        reachable: !!topEl && !!topEl.closest('#coin'),
        overflowX: document.documentElement.scrollWidth <= window.innerWidth + 1,
        rowRight: Math.round(row.getBoundingClientRect().right),
        innerW: window.innerWidth
      };
    });
    log('theme ' + tid + ':', JSON.stringify(v));
    ok2(v.attr === tid, 'тема "' + tid + '": применена до пейнта (data-theme на <html>)', v.attr);
    ok2(v.title === th.logo && v.logo === th.logo, 'тема "' + tid + '": имя продукта в <title> и в шапке', [v.title, v.logo]);
    ok2(v.cyan.toLowerCase() === th.accent.toLowerCase(), 'тема "' + tid + '": акцент дошёл до CSS-переменной', [v.cyan, th.accent]);
    ok2(v.cap === th.cur, 'тема "' + tid + '": валюта под балансом', v.cap);
    ok2(v.face === th.glyph && v.faceW > 0, 'тема "' + tid + '": глиф монеты отрисован (не пустой узел)', [v.face, v.faceW]);
    ok2(th.hasImage || v.imgs === 0, 'тема "' + tid + '": без своей картинки — никакого <img> в монете', v.imgs);
    ok2(v.unbound === 0, 'тема "' + tid + '": ни одного пустого текстового узла', v.unbound);
    ok2(v.overflowX, 'тема "' + tid + '": длинная валюта не распускает страницу по горизонтали', [v.cap, v.innerW]);
    ok2(v.rowRight <= v.innerW, 'тема "' + tid + '": строка кошелька помещается', [v.rowRight, v.innerW]);
    ok2(v.coinFits && v.reachable, 'тема "' + tid + '": монета цела и доступна тапу', v);
    await shot('11-theme-' + tid);

    /* Вкладка «Гильдия» в каждой теме. data-t у этих карточек намеренно нет,
       поэтому здесь единственная защита от «тема сломала рейд» — измерить:
       длинная название валюты темы не распускает строку заработка, а текст
       счётчиков остаётся видимым (не прозрачным и не вырезанным). */
    await page.click('.tab[data-tab="guild"]');
    await sleep(250);
    const tg = await page.evaluate(() => {
      const vis = (id) => {
        const e = document.getElementById(id);
        if (!e) return null;
        const cs = getComputedStyle(e), b = e.getBoundingClientRect();
        const alpha = Number((cs.color.match(/rgba?\([^)]*?,\s*([0-9.]+)\s*\)/) || [0, 1])[1]);
        return {
          w: Math.round(b.width), tx: (e.textContent || '').trim(),
          color: cs.color, alpha: alpha, ink: cs.color !== 'transparent' && alpha > 0.05
        };
      };
      return {
        cur: window.NEON.theme().cur,
        docW: document.documentElement.scrollWidth, innerW: window.innerWidth,
        earned: vis('raidEarned'), note: vis('raidNote'), tier: vis('raidTier'),
        hint: vis('guildHint'), name: vis('guildName'),
        empty: ['guildName', 'guildTag', 'guildState', 'guildRole', 'guildMult', 'raidWeek',
          'raidPending', 'raidPer', 'raidHonor', 'raidLife', 'raidBest', 'raidTries',
          'raidTierHint', 'raidQuota', 'raidRedeemCta'].filter((id) => {
          const e = document.getElementById(id);
          return !e || !(e.textContent || '').trim();
        }).length
      };
    });
    ok2(tg.docW <= tg.innerW, 'тема "' + tid + '": вкладка «Гильдия» не расползлась по горизонтали', [tg.docW, tg.innerW]);
    ok2(tg.empty === 0, 'тема "' + tid + '": в рейде и гильдии нет пустых текстовых узлов', tg.empty);
    ok2(tg.earned && tg.earned.ink && tg.earned.tx.indexOf(tg.cur) > -1,
      'тема "' + tid + '": заработок недели назван валютой темы и остался читаем',
      tg.earned && [tg.earned.tx, tg.cur]);
    ok2(tg.note.ink && tg.tier.ink && tg.hint.ink && tg.name.ink,
      'тема "' + tid + '": текст карточек не стал невидимым на фоне темы',
      [tg.note.color, tg.tier.color, tg.hint.color, tg.name.color]);
    await shot('11-guild-theme-' + tid);
    await page.click('.tab[data-tab="shop"]');
  }
  await page.goto(URL, { waitUntil: 'networkidle2' });   // возврат к дефолтному бренду
  await page.waitForFunction(() => !!window.NEON, { timeout: 15000 });

  /* --- 11b. ПЕРЕКЛЮЧАТЕЛЬ ТЕМ (живёт только под ?debug=1) ---------------------
     Руками бренд раньше менялся лишь через адресную строку. У виджета есть три
     обязанности, которых у ?theme= нет, и каждая — про молчаливую поломку:
     (а) соответствовать реестру THEMES — иначе добавленная четвёртая тема
         выйдет без кнопки, и переключатель станет врущим;
     (б) запоминать выбор URL'ем, а НЕ хранилищем и НЕ сейвом: второй ключ
         LocalStorage — новая поверхность персональных данных (её обязан бы
         назвать privacy-policy.md, а check-moderation-kit держит инвариант
         «к хранилищу — только через CFG.saveKey»), а поле в сейве — правка
         схемы v4, которую задело бы слияние с «облаком»;
     (в) не мешать игре: не наезжать на монету и не распускать страницу. */
  {
    const snap = () => page.evaluate(() => {
      const b = [].slice.call(document.querySelectorAll('.sw-theme__b'));
      const cs = getComputedStyle(document.documentElement);
      const coin = document.getElementById('coin').getBoundingClientRect();
      const top = document.elementFromPoint(coin.x + coin.width / 2, coin.y + coin.height / 2);
      const bx = (document.querySelector('.sw-theme') || { getBoundingClientRect: () => ({ right: 0, bottom: 0 }) }).getBoundingClientRect();
      const on = document.querySelector('.sw-theme__b.is-on');
      return {
        reg: window.NEON.themes(),
        ids: b.map((x) => x.getAttribute('data-sw-theme')),
        glyphOk: b.every((x) => x.textContent === window.NEON.themeOf(x.getAttribute('data-sw-theme')).glyph),
        on: on ? on.getAttribute('data-sw-theme') : null,
        html: document.documentElement.getAttribute('data-theme'),
        title: document.title,
        logo: document.getElementById('logoTxt').textContent,
        cap: document.getElementById('balCap').textContent,
        cyan: cs.getPropertyValue('--cyan').trim(),
        search: location.search,
        keys: Object.keys(localStorage).sort(),
        widgets: document.querySelectorAll('.sw-theme').length,
        overflowX: document.documentElement.scrollWidth <= window.innerWidth + 1,
        fits: bx.right <= window.innerWidth + 1 && bx.bottom <= window.innerHeight + 1,
        reachable: !!top && !!top.closest('#coin')
      };
    });

    const s0 = await snap();
    ok2(s0.ids.join() === s0.reg.join() && s0.glyphOk,
      'переключатель = весь реестр THEMES, кнопка без глифа темы не выезжает', [s0.ids, s0.reg]);
    ok2(s0.on === 'neon' && s0.html === 'neon', 'подсветка на старте совпадает с применённой темой', [s0.on, s0.html]);

    const target = s0.reg[s0.reg.length - 1];               // последняя тема реестра, не литерал
    await page.click('.sw-theme__b[data-sw-theme="' + target + '"]');
    await sleep(300);
    const s1 = await snap();
    /* Бренд живёт в copy (см. THEMES в game.js), а themeOf возвращает СЫРУЮ
       запись реестра — не уплощённый взгляд theme(). Проецируем явно:
       t.copy.logo, а не t.logo. Иначе проверка сравнивает с undefined и
       краснеет ровно тогда, когда виджет отработал правильно. */
    const th = await page.evaluate((x) => {
      const t = window.NEON.themeOf(x);
      return { cur: t.cur, glyph: t.glyph, accent: t.accent, logo: t.copy.logo };
    }, target);
    ok2(s1.html === target && s1.on === target, 'тап по кнопке применил тему и передвинул подсветку', [s1.html, s1.on]);
    ok2(s1.title === th.logo && s1.logo === th.logo && s1.cap === th.cur,
      'тап по кнопке перекрасил имя продукта и валюту, а не только палитру', [s1.title, s1.logo, s1.cap]);
    ok2(s1.cyan.toLowerCase() === th.accent.toLowerCase(), 'тап по кнопке довел акцент до CSS-переменной', s1.cyan);
    ok2(s1.keys.join() === s0.keys.join(),
      'выбор темы НЕ завёл ни одного нового ключа хранилища (поверхность ПД не выросла)', [s0.keys, s1.keys]);
    ok2(s1.search.indexOf('theme=' + target) > -1, 'выбор записан в URL — перезагрузка обязана его вернуть', s1.search);
    ok2(s1.search.indexOf('debug') > -1, 'запись темы в URL не съела debug=1 (иначе виджет умрёт на перезагрузке)', s1.search);
    ok2(s1.widgets === 1 && s1.overflowX && s1.fits, 'виджет единственный, без горизонтального скролла и в границах экрана', s1);
    ok2(s1.reachable, 'виджет не перекрыл монету: тап по центру по-прежнему доходит до #coin', s1.reachable);
    await shot('11b-theme-switched-' + target);

    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForFunction(() => !!window.NEON, { timeout: 15000 });
    const s2 = await snap();
    ok2(s2.html === target && s2.on === target && s2.widgets === 1,
      'перезагрузка вернула выбранную тему тем же синхронным путём (?theme=), без вспышки прошлого бренда', [s2.html, s2.on]);

    await page.click('.sw-theme__b[data-sw-theme="' + s0.reg[0] + '"]');
    await sleep(250);
    const s3 = await snap();
    ok2(s3.html === s0.reg[0] && s3.on === s0.reg[0], 'переключатель возвращается на базовый бренд (витрина не залипает)', [s3.html, s3.on]);
    await page.goto(URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => !!window.NEON, { timeout: 15000 });
  }

  /* --- 12. БОЕВОЙ ПУТЬ: запуск БЕЗ ?debug=1 --------------------------------
     Все секции выше едут на URL с ?debug=1, потому что без него нет хука
     window.NEON, которым проверяется игра. Побочный эффект: РЕАЛЬНЫЙ адрес
     игрока оставался непокрытым ни одним набором — а релиз идёт по нему.
     Проверяем его отдельно: инкогнито-сессия, настоящая мышь, без отладочных
     входов. Вторым числом фиксируем, что NEON в бою НЕ создаётся — иначе любой
     игрок рисовал бы монеты из консоли (см. раздел 17, хук только под debug). */
  {
    const LIVE = ORIGIN + '/index.html';
    const lctx = await browser.createBrowserContext();
    const lp = await lctx.newPage();
    lp.on('pageerror', (e) => problems.push('battle pageerror: ' + e.message));
    lp.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('battle console.error: ' + m.text()); });
    lp.on('response', (r) => { if (r.status() >= 400) problems.push('battle HTTP ' + r.status() + ' ' + r.url()); });
    lp.on('requestfailed', (r) => problems.push('battle requestfailed: ' + r.url()));
    await lp.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

    for (const q of ['', '&theme=' + THEME_IDS[THEME_IDS.length - 1]]) {
      await lp.goto(LIVE + '?app_id=6089842' + q, { waitUntil: 'load' });
      await sleep(1200);
      const c = await lp.$eval('#coin', (b) => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
      for (let i = 0; i < 10; i++) { await lp.mouse.click(c.x, c.y); await sleep(60); }
      await sleep(1400);                                  // пережить такт автосейва (1000 мс)
      const lv = await lp.evaluate(() => ({
        hook: typeof window.NEON,
        sw: document.querySelectorAll('.sw-theme, .sw-theme__b').length,
        bal: parseInt((document.getElementById('balance').textContent || '0').replace(/\D/g, ''), 10),
        cap: document.getElementById('balCap').textContent,
        saved: !!localStorage.getItem('neonclick.save.v1'),
        keys: Object.keys(localStorage).length,
        fits: document.documentElement.scrollWidth <= window.innerWidth + 1
      }));
      log('battle "' + (q || 'дефолт') + '":', JSON.stringify(lv));
      ok2(lv.hook === 'undefined', 'бой' + (q ? ' ' + q.replace('&', ' ') : '') + ': отладочный хук NEON не создан (монету из консоли не нарисовать)', lv.hook);
      /* Переключатель тем объявлен в том же регионе HOOK, что и хук, поэтому
         «хука нет» ещё не значит «виджета нет»: его отсутствие проверяем
         отдельным фактом, а не следствием. Иначе в витрине модерации осталась бы
         кнопка, меняющая имя продукта на другой бренд. */
      ok2(lv.sw === 0, 'бой' + (q ? ' ' + q.replace('&', ' ') : '') + ': переключателя тем в боевом артефакте нет', lv.sw);
      ok2(lv.bal > 0, 'бой' + (q ? ' ' + q.replace('&', ' ') : '') + ': настоящая мышь накликивает монеты', lv.bal);
      ok2(lv.saved && lv.keys === 1, 'бой: сейв лёг в единственный ключ LocalStorage', [lv.saved, lv.keys]);
      ok2(lv.fits, 'бой' + (q ? ' ' + q.replace('&', ' ') : '') + ': страница не расползлась по горизонтали', lv.fits);
    }
    await lp.screenshot({ path: path.join(OUT, '12-battle-nondebug.png') });
    await lctx.close();
  }

  console.log('\n  проблем: ' + problems.length);
  problems.forEach((p) => console.log('   ⚠️  ' + p));
  console.log('\n  скриншоты: ' + OUT + '\n');
  console.log('========== ВИЗУАЛЬНАЯ ПРОВЕРКА: ' + passed + ' ok / ' + failed + ' fail ==========');
  await browser.close();
  process.exit(failed || problems.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

