#!/usr/bin/env node
/* ==========================================================================
 * tools/build-release.cjs — сборка БОЕВОГО артефакта для GitHub Pages.
 *
 * На выходе: каталог _site/ ровно из пяти файлов — index.html, style.css,
 * game.js, vk-integration.js и вендоренного vk-bridge.<версия>.js. Это единственное,
 * что должны видеть игрок и модерация VK. Всё остальное дерево (наборы проверок,
 * base_*.txt, package.json, tools/) в артефакт не едет: на Pages сайт публичен
 * даже из приватного репозитория, поэтому «положить только нужное» обязана быть
 * операция, а не надежда на внимательность при копировании.
 *
 * ДВЕ ЗАМЕНЫ, ОБЕ ПРОВЕРЯЕМЫЕ ПОСЛЕ ФАКТА:
 *
 * 1) Отладочный хук. В репозитории ?debug=1 создаёт window.NEON с NEON.add(),
 *    и ЭТИМ ЖЕ ФЛАГОМ выключается потолок правдоподобия в античите
 *    (game.js: `if (!legacyT0 && !DEBUG)`). Вырезать хук из исходника нельзя —
 *    четыре набора проверок на нём висят и станут слепыми. Зато его обязан не
 *    содержать публикуемый файл: регион между маркерами RELEASE-STRIP убирается
 *    целиком, а определение DEBUG заменяется константой false. Постусловия
 *    проверяются по готовому тексту, а не по факту срабатывания регэкспа.
 *
 * 2) Cache-bust. Локальным ресурсам в index.html добавляется ?v=<8>, где <8> —
 *    первые 8 шестнадцатеричных sha256 от КОНЕЧНЫХ байтов файла. Без этого
 *    WebView VK и кеш Pages держат старую игру после хотфикса, а «починили, но
 *    у людей не изменилось» — худший исход. Хэш по содержанию, а не по SHA
 *    коммита: сборка одного и того же исходника бита в биту одинакова, и
 *    кеш браузера не сбрасывается впустую.
 *
 * Зависимостей нет намеренно (только node:fs/crypto/child_process): серверная
 * сборка не должна ставить то, что нужно лишь локальным прогонам.
 * ==========================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '_site');
const VENDOR = JSON.parse(fs.readFileSync(path.join(__dirname, 'vendor.json'), 'utf8'));
const HTML_ASSETS = ['style.css', 'game.js', 'vk-integration.js'];

const problems = [];
const fail = (m) => problems.push(m);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Разбивает текст, запоминая его перевод строки, чтобы не переписывать весь файл. */
function splitLines(text) {
  return { eol: text.includes('\r\n') ? '\r\n' : '\n', lines: text.split(/\r?\n/) };
}

/**
 * Вырезает регион между маркерами RELEASE-STRIP <name>_BEGIN/_END включительно,
 * заменив его на replacement ('' — удалить, 'строка' — вставить одной строкой).
 * Падает при малейшем несоответствии маркеров: тишина при опечатке стоила бы
 * дороже, чем шумная остановка сборки.
 */
function stripRegion(text, name, replacement) {
  const { eol, lines } = splitLines(text);
  const tag = 'RELEASE-STRIP ' + name;
  const hits = lines.filter((l) => l.includes(tag));
  if (hits.length !== 2) throw new Error('регион ' + name + ': ожидалось 2 маркера, найдено ' + hits.length);
  const b = lines.findIndex((l) => l.includes(tag + '_BEGIN'));
  const e = lines.findIndex((l) => l.includes(tag + '_END'));
  if (b < 0 || e <= b) throw new Error('регион ' + name + ': маркеры не в порядке (BEGIN=' + b + ', END=' + e + ')');
  return lines.slice(0, b).concat(replacement ? [replacement] : [], lines.slice(e + 1)).join(eol);
}

/* ---------- 0. Исходники ---------- */
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = {
  'index.html': read('index.html'),
  'style.css': read('style.css'),
  'game.js': read('game.js'),
  'vk-integration.js': read('vk-integration.js')
};

/* ---------- 1. Вендоренный SDK: байты обязаны совпасть с tools/vendor.json ---------- */
const sdkBuf = fs.readFileSync(path.join(ROOT, VENDOR.file));
if (sdkBuf.length !== VENDOR.bytes) {
  fail(VENDOR.file + ': ' + sdkBuf.length + ' байт, а в tools/vendor.json ' + VENDOR.bytes);
}
if (sha256(sdkBuf) !== VENDOR.sha256) {
  fail(VENDOR.file + ': sha256 ' + sha256(sdkBuf).slice(0, 16) + '… не совпал с зафиксированным ' + VENDOR.sha256.slice(0, 16) + '…');
}
const sdkText = sdkBuf.toString('utf8');
if (!/window\.vkBridge\s*=/.test(sdkText)) fail(VENDOR.file + ': нет присваивания window.vkBridge — это не UMD-сборка vk-bridge');
if (!sdkText.includes('"' + VENDOR.version + '"')) fail(VENDOR.file + ': внутри не встретилась версия "' + VENDOR.version + '"');
// Рядом нет .map: оставленная ссылка — это 404 в девтулзах, которые откроет модерация VK.
const sdkOut = sdkText.replace(/\s*\/\/#\s*sourceMappingURL=[^\r\n]*/g, '');
if (/sourceMappingURL/.test(sdkOut)) fail(VENDOR.file + ': sourceMappingURL не вырезалась');

/* ---------- 2. game.js: отладочный хук и флаг DEBUG ---------- */
const gameOut = stripRegion(stripRegion(SRC['game.js'], 'DEBUG', '  const DEBUG = false;'), 'HOOK', '');
const shrunk = SRC['game.js'].length - gameOut.length;
if (!/^\s*const DEBUG = false;$/m.test(gameOut)) fail('game.js: определение DEBUG не заменено константой false');
if ((gameOut.match(/const DEBUG = false;/g) || []).length !== 1) fail('game.js: замена DEBUG применилась не один раз');
if (/window\.NEON/.test(gameOut)) fail('game.js: в артефакте остался window.NEON — хук не вырезан');
if (/has\('debug'\)/.test(gameOut)) fail('game.js: чтение ?debug=1 осталось в боевом файле');
if (/RELEASE-STRIP/.test(gameOut)) fail('game.js: маркеры RELEASE-STRIP доехали до артефакта');
if (shrunk < 2000) fail('game.js: после вырезания файл стал короче лишь на ' + shrunk + ' симв. — явно не тот регион');

/* ---------- 3. vk-integration.js: состав боевой сборки и имя локального SDK ---------- */
const vkOut = SRC['vk-integration.js'];
if ((vkOut.match(/const DEMO_MODE = false;/g) || []).length !== 1) fail('vk-integration.js: ожидаемо ровно одно `const DEMO_MODE = false;`');
if (/const DEMO_MODE = true;/.test(vkOut)) fail('vk-integration.js: DEMO_MODE=true — публиковать нельзя (награда за рекламу выдавалась бы вне VK)');
const sdkRef = /const SDK_LOCAL = '([^']+)';/.exec(vkOut);
if (!sdkRef) fail('vk-integration.js: не найден SDK_LOCAL — цепочка загрузки SDK без локального файла не собирается');
else if (sdkRef[1] !== VENDOR.file) fail('vk-integration.js: SDK_LOCAL = ' + sdkRef[1] + ', а провендорен ' + VENDOR.file);

/* ---------- 4. index.html: ?v= по содержанию КОНЕЧНЫХ файлов ---------- */
const ART = {
  'index.html': null,
  'style.css': SRC['style.css'],
  'game.js': gameOut,
  'vk-integration.js': vkOut,
  [VENDOR.file]: sdkOut
};
const ver = {};
for (const name of HTML_ASSETS) ver[name] = sha256(Buffer.from(ART[name], 'utf8')).slice(0, 8);

let htmlOut = SRC['index.html'];
for (const name of HTML_ASSETS) {
  let hits = 0;
  htmlOut = htmlOut.replace(new RegExp('(src|href)="(' + esc(name) + ')"', 'g'), (m, attr, f) => {
    hits++;
    return attr + '="' + f + '?v=' + ver[name] + '"';
  });
  if (hits !== 1) fail('index.html: ссылка на ' + name + ' встречена ' + hits + ' раз(а), ожидался ровно один');
}
ART['index.html'] = htmlOut;

/* ---------- 5. Запись и проверки по уже готовым файлам ---------- */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const [name, text] of Object.entries(ART)) fs.writeFileSync(path.join(OUT, name), text, 'utf8');

const EXPECTED = Object.keys(ART).sort();
for (const f of EXPECTED) {
  if (!f.endsWith('.js')) continue;
  try {
    execFileSync(process.execPath, ['--check', path.join(OUT, f)], { stdio: 'pipe' });
  } catch (e) {
    fail(f + ': node --check не прошёл — ' + String((e.stderr && e.stderr.toString()) || e.message).trim().slice(0, 300));
  }
}
const produced = fs.readdirSync(OUT).sort();
if (JSON.stringify(produced) !== JSON.stringify(EXPECTED)) {
  fail('состав _site не равен allowlist: ' + produced.join(', '));
}
for (const m of htmlOut.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const u = m[1];
  if (/^(?:https?:)?\/\//i.test(u) || /^(data:|#|mailto:)/i.test(u)) continue;
  const file = u.split('?')[0];
  if (EXPECTED.indexOf(file) < 0) { fail('index.html ссылается на ' + u + ' — такого файла в артефакте нет'); continue; }
  if (!u.includes('?v=' + ver[file])) fail('index.html: ' + u + ' без ожидаемого ?v=' + ver[file]);
}
// Следов внутренней кухни в публикуемых байтах быть не должно: читающий их
// человек не обязан знать, что когда-то здесь был отладочный хук и какие наборы
// его проверяли. Ссылки на сами наборы проверок в комментариях оставлены: они
// описывают, ГДЕ закреплён инвариант, и ничего не открывают.
const joined = EXPECTED.map((f) => ART[f]).join('\n');
for (const needle of ['RELEASE-STRIP', 'window.NEON', 'NEON.', '?debug=1', 'sourceMappingURL', "has('debug')"]) {
  if (joined.includes(needle)) fail('артефакт содержит след «' + needle + '»');
}

// Ориентир на глаз: вся игра до сих пор весила ~260 КБ. Резкий рост означает,
// что в allowlist прилетело что-то чужое, — лучше остановить сборку здесь.
const totalBytes = EXPECTED.reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
if (totalBytes > 1500000) fail('артефакт весит ' + totalBytes + ' байт — это неожиданно много, проверить состав');

if (problems.length) {
  console.error('\nСБОРКА ОСТАНОВЛЕНА (' + problems.length + '):');
  for (const p of problems) console.error('  ! ' + p);
  process.exit(1);
}

let total = 0;
console.log('\nБоевой артефакт: ' + OUT);
for (const f of EXPECTED) {
  const size = fs.statSync(path.join(OUT, f)).size;
  total += size;
  console.log('  ' + f.padEnd(24) + String(size).padStart(7) + '  ' + (ver[f] ? '?v=' + ver[f] : 'версия в имени файла'));
}
console.log('  ' + 'итого'.padEnd(24) + String(total).padStart(7));
console.log('  отладка: хук вырезан, DEBUG === false → ?debug=1 не даёт ни NEON, ни отключения потолка правдоподобия');
console.log('  SDK: ' + VENDOR.file + ' (' + VENDOR.package + ' ' + VENDOR.version + ', ' + VENDOR.license + '), sha256 ' + VENDOR.sha256.slice(0, 16) + '…, CDN — резервная цепочка');
console.log('  состав: ' + EXPECTED.length + ' файлов, ничего из набора проверок рядом нет');
