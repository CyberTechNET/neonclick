#!/usr/bin/env node
/* ==========================================================================
 * tools/make-moderation-assets.cjs — иконка и скриншоты для заявки в кабинет VK.
 *
 * Почему скрипт, а не нарисованные руками файлы. Кабинет требует иконку до
 * того, как вообще появится что показывать модератору, а материал обязан быть
 * тем же, что видит игрок: диск монеты из настоящего style.css, те же три
 * темы, тот же выложенный артефакт. Картинка, нарисованная в стороне,
 * расходится с продуктом — а расхождение и есть то, что ловит модерация.
 * Отсюда же и постусловия на каждый файл: молча сгенерировать пустышку дороже,
 * чем не сгенерировать ничего.
 *
 * В боевой артефакт ассеты НЕ едут: tools/build-release.cjs собирает _site по
 * allowlist из пяти файлов. Утверждение проверяется по сети — пути из
 * assets/moderation/ стоят в списке FOREIGN в .release-check.cjs [6].
 *
 * Два решения, принятые здесь осознанно:
 *   1) Глиф ⚡ в иконке заменён векторной молнией. В игре это emoji, то есть
 *      рисунок зависит от шрифта системы; на машине без emoji-шрифта из иконки
 *      получился бы прямоугольник tofu, и у нас бы его не приняли. Вектор
 *      детерминирован, как и вся сборка.
 *   2) Анимации монеты выключены (breathe/spin). Иконка, снятая в разные
 *      миллисекунды, обязана быть бита в бит — иначе «один и тот же исходник
 *      даёт разные файлы» возвращается в проект через заднюю дверь.
 *
 * Скриншоты вкладок «Гильдия» здесь НЕТ: вне реального запуска из папки
 * сообщества она показывает служебное состояние, и такая картинка на модерации
 * выглядит как сломанный экран. Их надо снимать уже по п.3 кабинета (см.
 * README «Кабинет VK»), когда vk_group_id приезжает по-настоящему.
 *
 * Запуск (локально, требует puppeteer-core — в CI этот скрипт не гоняют):
 *   node tools/make-moderation-assets.cjs
 *   $env:NEON_BASE = 'http://127.0.0.1:5173'; node tools/make-moderation-assets.cjs
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'assets', 'moderation'));
const LIVE = (process.env.NEON_BASE || 'https://cybertechnet.github.io/neonclick').replace(/\/+$/, '');
const CSS = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const THEMES = ['neon', 'meme', 'sat'];
const VP = { w: 390, h: 844, dsf: 2 };          // iPhone 13/14 — самый частый экран в VK
/* Доля стороны холста, которую занимает диск монеты (вдвое больше inset кольца). */
const COIN = 0.66;
/* Негативный контроль. Проверки геометрии имеют смысл, только если они краснеют
   на битой иконке: NEON_ICON_DISTORT=flat|shift node tools/make-moderation-assets.cjs
   рендерит заведомо расплющенный / сдвинутый диск, и геометрия обязана упасть.
   В штатном прогоне переменная не задана. */
const DISTORT = (() => {
  const v = String(process.env.NEON_ICON_DISTORT || '').toLowerCase();
  return v === 'flat' || v === 'shift' ? v : '';
})();

const EXE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
if (!EXE) {
  console.error('make-moderation-assets: нет Edge/Chrome — ассеты генерируются в реальном Chromium');
  process.exit(1);
}

let passed = 0, failed = 0;
const log = (...a) => console.log('  ' + a.join(' '));
const ok = (cond, name, extra) => {
  if (cond) { passed++; log('\u2705 ' + name); }
  else { failed++; log('\u274c ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Заголовок IHDR руками: декодера PNG в дереве нет, и вводить его ради проверки радиуса нельзя. */
function pngHead(buf) {
  if (buf.length < 26) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.slice(12, 16).toString('latin1') !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), depth: buf[24], color: buf[25] };
}

/** Пиксельная статистика — через тот же Chromium: img.decode() + canvas, без зависимостей. */
async function pixels(page, file) {
  const src = 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
  return page.evaluate(async (s) => {
    const img = new Image();
    img.src = s;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    let luma = 0, opaque = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      seen.add(((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3));
      luma += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      if (d[i + 3] === 255) opaque++;
      n++;
    }
    const at = (x, y) => { const i = (y * c.width + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
    // Хэш из 8×8 средних: две темы не имеют права совпасть (см. game.js про ?theme=
    // и location_search — молча отдать базовую витрину вместо мем-аудитории легко).
    const sm = document.createElement('canvas');
    sm.width = 8; sm.height = 8;
    const sg = sm.getContext('2d');
    sg.drawImage(img, 0, 0, 8, 8);
    const sd = sg.getImageData(0, 0, 8, 8).data;
    let mean = 0;
    for (let i = 0; i < sd.length; i += 4) mean += 0.2126 * sd[i] + 0.7152 * sd[i + 1] + 0.0722 * sd[i + 2];
    mean /= 64;
    let bits = '';
    for (let i = 0; i < sd.length; i += 4) {
      bits += (0.2126 * sd[i] + 0.7152 * sd[i + 1] + 0.0722 * sd[i + 2]) > mean ? '1' : '0';
    }
    return {
      w: c.width, h: c.height, distinct: seen.size, meanLuma: Math.round(luma / n),
      opaqueRatio: opaque / n, center: at(c.width >> 1, c.height >> 1),
      corner: at(2, 2), ahash: BigInt('0b' + bits).toString(16).padStart(16, '0')
    };
  }, src);
}

/** Форма иконки числами. Визуальный осмотр здесь недоступен (модель без image
 *  input), поэтому круглость диска, наличие молнии и неоновых дуг выводятся из
 *  байтов: «проверил глазами» не может быть основанием релиза в этой среде. */
async function iconShape(page, file) {
  const src = 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
  return page.evaluate(async (s) => {
    const img = new Image();
    img.src = s;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const at = (x, y) => { const i = (y * c.width + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
    const isGold = (p) => p[0] > 150 && p[1] > 70 && p[2] < 150 && p[2] < p[1];
    const isCyan = (p) => p[2] > 170 && p[1] > 160 && p[0] < 130;
    const isMag = (p) => p[0] > 170 && p[2] > 160 && p[1] < 140;
    const isBoltDark = (p) => p[0] > 60 && p[0] < 150 && p[1] > 25 && p[1] < 110 && p[2] < 70;
    const isBoltLight = (p) => p[0] > 225 && p[1] > 195 && p[2] > 130 && p[2] < 215;

    // Габариты светлого пятна (диск + кольцо). Молния режет среднюю строку на
    // два сегмента, поэтому диаметр — по bounding box ярких пикселей, а не по
    // непрерывному прогону одного цвета: первый прогон дал 0.24 на здоровой
    // иконке и был бы ложно-зелёным на битой.
    let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
    let cyan = 0, mag = 0, bd = 0, bl = 0, ng = 0, gn = 0, gsx = 0, gsy = 0;
    const x0 = Math.round(c.width * 0.2), x1 = Math.round(c.width * 0.8);
    for (let yy = 0; yy < c.height; yy++) {
      for (let xx = 0; xx < c.width; xx++) {
        const p = at(xx, yy);
        if (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2] > 90) {
          if (xx < minX) minX = xx;
          if (xx > maxX) maxX = xx;
          if (yy < minY) minY = yy;
          if (yy > maxY) maxY = yy;
        }
        if (isCyan(p)) cyan++;
        if (isMag(p)) mag++;
        if (isGold(p)) { gn++; gsx += xx; gsy += yy; }
        if (xx >= x0 && xx < x1 && yy >= x0 && yy < x1) {
          if (isBoltDark(p)) bd++;
          if (isBoltLight(p)) bl++;
          if (!isGold(p)) ng++;
        }
      }
    }
    const corners = [at(2, 2), at(c.width - 3, 2), at(2, c.height - 3), at(c.width - 3, c.height - 3)];
    const cornerLuma = Math.round(corners.reduce((a, p) => a + 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2], 0) / 4);
    return {
      size: c.width,
      // Доли стороны и смещение центра пятна относительно центра холста.
      lit: maxX < 0 ? null : {
        w: (maxX - minX + 1) / c.width, h: (maxY - minY + 1) / c.height,
        cx: (minX + maxX) / 2 / c.width - 0.5, cy: (minY + maxY) / 2 / c.height - 0.5
      },
      cyan, mag, boltDark: bd, boltLight: bl, cornerLuma,
      nonGoldRatio: ng / ((x1 - x0) * (x1 - x0)),
      // Диаметр золота по его площади (2√(N/π)) и положение его центра тяжести.
      // Площади, а не габариту: коническое кольцо выступает только по бокам,
      // поэтому bounding box пятно растягивает даже на идеальной иконке.
      goldDiam: gn ? 2 * Math.sqrt(gn / Math.PI) / c.width : 0,
      goldCx: gn ? gsx / gn / c.width : 0,
      goldCy: gn ? gsy / gn / c.height : 0
    };
  }, src);
}

/** Разметка монеты повторяет index.html (#coin), но это div: кнопке незачем
 *  ловить тапы на статичной картинке, а aria-label без обработчика — ложь. */
const iconHtml = (size) => `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>icon</title>
<style>${CSS}</style>
<style>
  html, body { width: ${size}px; height: ${size}px; margin: 0; overflow: hidden; }
  body { display: grid; place-items: center; }
  .coin { width: ${Math.round(size * COIN)}px; height: ${Math.round(size * COIN * (DISTORT === 'flat' ? 0.7 : 1))}px;${DISTORT === 'shift' ? ` transform: translateX(${Math.round(size * 0.09)}px);` : ''} }
  .coin, .coin * { animation: none !important; transition: none !important; }
  .bolt { width: 54%; height: 54%; pointer-events: none;
    filter: drop-shadow(0 3px 6px rgba(90, 45, 0, .6)); }
</style></head>
<body>
  <div class="coin">
    <span class="coin__halo"></span>
    <span class="coin__ring"></span>
    <span class="coin__body">
      <svg class="bolt" viewBox="0 0 100 100" aria-hidden="true">
        <path d="M58 6 22 54h22l-8 40 40-52H52z" fill="#6b3a05"/>
        <path d="M55 13 28 51h19l-6 32 31-41H57z" fill="#ffe9a8" opacity=".5"/>
      </svg>
      <span class="coin__gloss"></span>
    </span>
  </div>
</body></html>`;

/** Постусловия иконки: квадрат, непрозрачный фон, золото в центре, живой рисунок. */
function checkIcon(name, head, px, sh, size) {
  ok(head && head.w === size && head.h === size, name + ': квадрат ' + size + '\u00d7' + size,
    head && { w: head.w, h: head.h });
  ok(head && head.depth === 8, name + ': глубина 8 бит', head && head.depth);
  ok(px.opaqueRatio === 1, name + ': без альфы — на светлом фоне магазина не побелеет',
    px.opaqueRatio);
  ok(px.distinct > 400, name + ': не плашка — оттенков больше 400', px.distinct);
  ok(px.center[0] > 180 && px.center[1] > 90 && px.center[2] < 120,
    name + ': в центре золото, а не пустота', px.center);
  ok(px.meanLuma > 8 && px.meanLuma < 140, name + ': тёмный фон сохранён (средняя яркость)',
    px.meanLuma);
  // Диск: диаметр золота по площади. Задан COIN_RATIO стороны, но золотом
  // считается не весь диск — тёмный ободок (#7a4407) и блик за его пределами,
  // поэтому штатное значение ниже COIN_RATIO. Полоса подобрана по замеру.
  log(name + ': \u0437\u0430\u043c\u0435\u0440\u044b \u2014 goldDiam ' + sh.goldDiam.toFixed(3)
    + ', cx ' + sh.goldCx.toFixed(3) + ', cy ' + sh.goldCy.toFixed(3)
    + ', lit ' + (sh.lit ? sh.lit.w.toFixed(3) + '\u00d7' + sh.lit.h.toFixed(3) : '\u2014')
    + ', cyan ' + sh.cyan + ', mag ' + sh.mag + ', bolt ' + sh.boltDark);
  ok(sh.goldDiam > COIN - 0.24 && sh.goldDiam < COIN - 0.02,
    name + ': \u0434\u0438\u0430\u043c\u0435\u0442\u0440 \u0437\u043e\u043b\u043e\u0442\u0430 \u0432 \u043f\u043e\u043b\u043e\u0441\u0435 \u043e\u0442 COIN', +sh.goldDiam.toFixed(3));
  ok(Math.abs(sh.goldCx - 0.5) < 0.045 && Math.abs(sh.goldCy - 0.5) < 0.06,
    name + ': \u0437\u043e\u043b\u043e\u0442\u043e \u0440\u0430\u0441\u043f\u0440\u0435\u0434\u0435\u043b\u0435\u043d\u043e \u0432\u043e\u043a\u0440\u0443\u0433 \u0446\u0435\u043d\u0442\u0440\u0430 (\u0441\u043c\u0435\u0449\u0435\u043d\u0438\u0435 \u0434\u043e\u043f\u0443\u0441\u043a\u0430\u0435\u0442 \u0431\u043b\u0438\u043a 32%/24%)',
    { cx: +sh.goldCx.toFixed(3), cy: +sh.goldCy.toFixed(3) });
  ok(sh.lit && Math.abs(sh.lit.h - COIN) < 0.035,
    name + ': высота светлого пятна = диск (дуги кольца вверх не выступают)',
    sh.lit && +sh.lit.h.toFixed(3));
  ok(sh.lit && sh.lit.w / sh.lit.h >= 1 && sh.lit.w / sh.lit.h <= 1.3,
    name + ': шире диска пятно только из-за боковых дуг (conic 20%/72%)',
    sh.lit && +(sh.lit.w / sh.lit.h).toFixed(3));
  ok(sh.cornerLuma < 30, name + ': углы тёмные — это фон, а не обрезанный кадр', sh.cornerLuma);
  // Молния и глянец: центр не должен быть ровным золотым пятном.
  ok(sh.nonGoldRatio > 0.05, name + ': в центре есть рисунок (молния/глянец), не ровлое пятно',
    sh.nonGoldRatio.toFixed(3));
  ok(sh.boltDark > size * size * 0.002, name + ': тёмная молния проступает', sh.boltDark);
  // Дуги кольца: маска задана толщиной 3px и не масштабируется с размером,
  // поэтому на 192px пурпурная волна растворяется в антиалиасинге (замерено:
  // 0 пикселей). Требовать её на мелком иконном размере — значит иметь
  // заведомо падающую проверку, так что дуги проверяются на каноническом 512.
  if (size >= 512) {
    ok(sh.cyan > 50, name + ': голубая дуга кольца на месте', sh.cyan);
    ok(sh.mag > 50, name + ': пурпурная дуга кольца на месте', sh.mag);
  }
}

/** Постусловия скриншота: размер кратен вьюпорту, контент есть, ошибок нет. */
function checkShot(name, head, px, errs) {
  ok(head && head.w === VP.w * VP.dsf && head.h === VP.h * VP.dsf,
    name + ': ' + VP.w * VP.dsf + '\u00d7' + VP.h * VP.dsf + ' (390\u00d7844 @2x)',
    head && { w: head.w, h: head.h });
  ok(errs.length === 0, name + ': ошибок страницы нет', errs.slice(0, 2));
  ok(px.opaqueRatio === 1, name + ': кадр заполнен целиком', px.opaqueRatio);
  ok(px.distinct > 1500, name + ': на кадре есть что смотреть (оттенков > 1500)', px.distinct);
  ok(px.corner[3] === 255, name + ': углы не прозрачные', px.corner);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: EXE, headless: true,
    args: ['--no-sandbox', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none']
  });
  const meter = await browser.newPage();       // только img.decode() + canvas
  await meter.goto('about:blank');
  const hashes = {};
  const themeTokens = {};
  const report = [];

  try {
    console.log('\n[1] \u0418\u043a\u043e\u043d\u043a\u0430 \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u044f');
    for (const size of [512, 192]) {
      const file = path.join(OUT, 'icon-' + size + '.png');
      const pg = await browser.newPage();
      await pg.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
      await pg.setContent(iconHtml(size), { waitUntil: 'load' });
      await sleep(250);
      await pg.screenshot({ path: file, type: 'png', omitBackground: false });
      await pg.close();
      const px = await pixels(meter, file);
      checkIcon('icon-' + size, pngHead(fs.readFileSync(file)), px, await iconShape(meter, file), size);
      report.push(['icon-' + size + '.png', fs.statSync(file).size]);
    }

    console.log('\n[2] \u0412\u0438\u0442\u0440\u0438\u043d\u0430: \u0442\u0440\u0438 \u0442\u0435\u043c\u044b \u0431\u043e\u0435\u0432\u043e\u0433\u043e \u0430\u0440\u0442\u0435\u0444\u0430\u043a\u0442\u0430');
    for (const theme of THEMES) {
      const name = 'screen-' + theme;
      const file = path.join(OUT, name + '.png');
      const errs = [];
      const pg = await browser.newPage();
      pg.on('pageerror', (e) => errs.push(String((e && e.message) || e)));
      await pg.setViewport({ width: VP.w, height: VP.h, deviceScaleFactor: VP.dsf, isMobile: true, hasTouch: true });
      await pg.goto(LIVE + '/?theme=' + theme, { waitUntil: 'networkidle2' });
      await pg.waitForFunction(() => {
        const b = document.getElementById('balance');
        return b && /\d/.test(b.textContent || '');
      }, { timeout: 15000 });
      await sleep(900);                        // гало «дышит» — кадр должен быть снят в одной фазе
      const applied = await pg.evaluate(() => document.documentElement.getAttribute('data-theme'));
      ok(applied === theme, name + ': тема применилась (data-theme)', applied);
      themeTokens[theme] = await pg.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        return { cyan: cs.getPropertyValue('--cyan').trim(), magenta: cs.getPropertyValue('--magenta').trim(), bgTop: cs.getPropertyValue('--bg-top').trim() };
      });
      await pg.screenshot({ path: file, type: 'png' });
      await pg.close();
      const px = await pixels(meter, file);
      checkShot(name, pngHead(fs.readFileSync(file)), px, errs);
      hashes[theme] = px.ahash;
      report.push([name + '.png', fs.statSync(file).size]);
    }

    // Три темы, давшие один кадр, означают, что ?theme= не доехал: см. комментарий
    // к THEME_FROM_URL в game.js — молча отдать базовую витрину вместо мем-темы легко.
    ok(new Set(Object.values(hashes)).size === THEMES.length,
      '\u0442\u0440\u0438 \u0442\u0435\u043c\u044b \u0434\u0430\u043b\u0438 \u0442\u0440\u0438 \u0440\u0430\u0437\u043d\u044b\u0445 \u043a\u0430\u0434\u0440\u0430', hashes);
    // Хэш кадра ловит «получился другой рисунок», токен ловит «тема вообще применилась».
    ok(new Set(THEMES.map((t) => themeTokens[t] && themeTokens[t].cyan)).size === THEMES.length,
      '\u0442\u0435\u043c\u044b \u0440\u0430\u0437\u043b\u0438\u0447\u0430\u044e\u0442\u0441\u044f \u0430\u043a\u0446\u0435\u043d\u0442\u043e\u043c --cyan', themeTokens);

    console.log('\n[3] \u0412\u043a\u043b\u0430\u0434\u043a\u0430 \u00ab\u0411\u043e\u043d\u0443\u0441\u044b\u00bb \u0438 \u043f\u043e\u0434\u0441\u043a\u0430\u0437\u043a\u0430 \u043f\u0440\u043e\u043a\u0440\u0443\u0442\u043a\u0438');
    {
      const name = 'screen-bonus';
      const file = path.join(OUT, name + '.png');
      const errs = [];
      const pg = await browser.newPage();
      pg.on('pageerror', (e) => errs.push(String((e && e.message) || e)));
      await pg.setViewport({ width: VP.w, height: VP.h, deviceScaleFactor: VP.dsf, isMobile: true, hasTouch: true });
      await pg.goto(LIVE + '/', { waitUntil: 'networkidle2' });
      await pg.waitForFunction(() => !!document.getElementById('riskCard'), { timeout: 15000 });
      await pg.click('.tab[data-tab="bonus"]');
      await sleep(700);
      const geo = await pg.evaluate(() => {
        const rc = document.getElementById('riskCard'), p = document.getElementById('panel');
        const r = rc.getBoundingClientRect();
        return { h: Math.round(r.height), content: rc.scrollHeight, more: p.classList.contains('is-more') };
      });
      ok(Math.abs(geo.h - geo.content) <= 2,
        name + ': \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0430 \u043d\u0435 \u0441\u043f\u043b\u044e\u0449\u0435\u043d\u0430 (\u0440\u0430\u043c\u043a\u0430 = \u0441\u043e\u0434\u0435\u0440\u0436\u0438\u043c\u043e\u0435)', geo);
      ok(geo.more === true, name + ': \u043f\u043e\u0434\u0441\u043a\u0430\u0437\u043a\u0430 \u00ab\u0435\u0449\u0451 \u0432\u043d\u0438\u0437\u0443\u00bb \u0433\u043e\u0440\u0438\u0442', geo);
      await pg.screenshot({ path: file, type: 'png' });
      await pg.close();
      const px = await pixels(meter, file);
      checkShot(name, pngHead(fs.readFileSync(file)), px, errs);
      report.push([name + '.png', fs.statSync(file).size]);
    }
  } finally {
    await browser.close();
  }

  console.log('\n\u041a\u0430\u0442\u0430\u043b\u043e\u0433: ' + OUT);
  for (const [f, s] of report) log('  ' + f.padEnd(22) + String(s).padStart(8) + ' \u0431\u0430\u0439\u0442');
  console.log('\n========== \u0410\u0421\u0421\u0415\u0422\u042b \u041c\u041e\u0414\u0415\u0420\u0410\u0426\u0418\u0418: ' + passed + ' ok / ' + failed + ' fail ==========');
  process.exit(failed ? 1 : 0);
})();
