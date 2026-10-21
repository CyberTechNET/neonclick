#!/usr/bin/env node
/* ==========================================================================
 * tools/build-release.cjs — сборка БОЕВОГО артефакта для GitHub Pages.
 *
 * На выходе: каталог _site/ ровно из шести файлов — index.html, style.css,
 * game.js, vk-integration.js, вендоренный vk-bridge.<версия>.js и privacy.html
 * (публичная копия политики конфиденциальности для кабинета VK). Это единственное,
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

/**
 * EOL-нормализация. Рабочее дерево на Windows живёт с CRLF, чекаут в Actions —
 * с LF, и без этого шага один и тот же коммит давал бы два разных артефакта с
 * разными ?v. Нормализуем в LF здесь, в сборке: детерминизм должен быть свойством
 * конвейера, а не состоянием конкретного диска.
 */
const norm = (t) => t.replace(/\r\n/g, '\n');

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

/* ---------- 3b. privacy.html: шестой файл артефакта — публичная политика ---------- */
/**
 * Источник — файл политики в дереве модерации: тот же, который
 * check-moderation-kit сверяет с game.js и vk-integration.js. Отдельной «страницы
 * для людей» в репозитории нет намеренно: у двух копий одного юридического текста
 * судьба расходиться молча, а политика устаревает первой из всех бумаг.
 *
 * Рендерер покрывает ровно то подмножество Markdown, которое есть в исходнике:
 * заголовки, таблицы, списки с продолжениями строк, инлайн-код, жирный текст,
 * ссылки и абзацы. Выбрасывается одно — HTML-комментарии: там внутренняя кухня
 * репозитория, месту которой не в публичном документе. Всё остальное обязано
 * доехать дословно, и это не надежда на аккуратность: видимый текст страницы
 * сравнивается ниже с текстом исходника целиком, поэтому потерянный абзац,
 * съехавшая ячейка или проглоченный маркер останавливают сборку.
 */
const POLICY_MD = path.join('assets', 'moderation', 'privacy-policy.md');
const isTableDelim = (l) => /^\s*\|[\s|:\-]+\s*$/.test(l) && l.includes('--');
const htmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const htmlUnescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const markersOf = (s) => (s.match(/\{\{[^}]+\}\}/g) || []).sort();
const collapseWs = (s) => s.replace(/\s+/g, ' ').trim();

function inlineMd(s) {
  return htmlEscape(s)
    .replace(/`([^`]+)`/g, (m, c) => '<code>' + c + '</code>')
    .replace(/\*\*([^*]+)\*\*/g, (m, c) => '<strong>' + c + '</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, href) => '<a href="' + href + '">' + txt + '</a>');
}

/** Markdown → тело документа. Возвращает также заголовок H1 и число разделов H2. */
function mdToBody(md) {
  const lines = norm(md.replace(/<!--[\s\S]*?-->/g, '')).split('\n');
  const out = [];
  let h1 = null;
  let i = 0;
  const list = (re, wrap) => {
    const items = [];
    while (i < lines.length && lines[i].trim()) {
      const mm = re.exec(lines[i]);
      if (mm) items.push(mm[mm.length - 1]);
      else if (/^\s{2,}\S/.test(lines[i])) items[items.length - 1] += ' ' + lines[i].trim();
      else break;
      i++;
    }
    out.push('<' + wrap + '>' + items.map((t) => '<li>' + inlineMd(t) + '</li>').join('') + '</' + wrap + '>');
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      const lvl = m[1].length;
      if (lvl === 1 && h1 === null) h1 = m[2].trim();
      out.push('<h' + lvl + '>' + inlineMd(m[2].trim()) + '</h' + lvl + '>');
      i++;
    } else if (line.trimStart().startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        if (!isTableDelim(lines[i])) {
          rows.push(lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
        }
        i++;
      }
      const head = rows.shift() || [];
      out.push('<table><thead><tr>' + head.map((c) => '<th>' + inlineMd(c) + '</th>').join('') +
        '</tr></thead>' + (rows.length
          ? '<tbody>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>').join('') + '</tbody>'
          : '') + '</table>');
    } else if (/^([*\-])\s+/.test(line)) {
      list(/^([*\-])\s+(.*)$/, 'ul');
    } else if (/^\d+\.\s+/.test(line)) {
      list(/^(\d+)\.\s+(.*)$/, 'ol');
    } else {
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !/^(?:#{1,6}\s|[*\-]\s|\d+\.\s|\s*\|)/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      out.push('<p>' + inlineMd(collapseWs(buf.join(' '))) + '</p>');
    }
  }
  return { body: out.join('\n'), h1: h1, h2: out.filter((b) => b.startsWith('<h2>')).length };
}

/** Тот же исходник, но как простой текст: вторая, независимая проекция для сверки.
 *  Префикс снимается ровно один и в порядке очередности: у строки «## 1. Кто мы»
 *  заголовок, а не список, и «1. » — часть его текста; снимать её вторым проходом
 *  означало бы сверять страницу с текстом, которого в исходнике не было. */
function mdToPlain(md) {
  return norm(md.replace(/<!--[\s\S]*?-->/g, '')).split('\n')
    .filter((l) => !isTableDelim(l))
    .map((l) => l.replace(/^(?:#{1,6}|[*\-]|\d+\.)\s+/, '').replace(/^\s*\|/, '').replace(/\|\s*$/, ''))
    .join('\n')
    .replace(/\|/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)\s]*\)/g, '$1');
}

/** Шапка (title, style) в сравнение не входит: её содержимое — разметка документа,
 *  а не текст политики. Инлайновые теги исчезают бесследно (как исчезают их
 *  маркеры в исходнике), а блочные оставляют пробел — иначе границы абзацев
 *  склеили бы слова в одно и сверка краснела бы на собственной разметке. */
function htmlToPlain(html) {
  return htmlUnescape(html.replace(/<head>[\s\S]*?<\/head>/g, '')
    .replace(/<\/?(?:code|strong|em|a)(?:\s[^>]*)?>/g, '').replace(/<[^>]+>/g, ' '));
}

/** Оформление страницы. Держим его внутри документа: шестой файл артефакта не
 *  имеет права тянуть за собой седьмой (css), а модератор VK открывает ссылку
 *  любым браузером, поэтому никаких зависимостей и никаких скриптов. */
const PRIVACY_CSS = [
  ':root{color-scheme:light dark;--fg:#15171c;--muted:#5a6270;--bg:#fff;--card:#f4f6fa;--line:#d9dee8;--accent:#3b5bdb}',
  '@media (prefers-color-scheme:dark){:root{--fg:#e8eaf0;--muted:#9aa3b2;--bg:#101217;--card:#171a21;--line:#2a2f3a;--accent:#8ea2ff}}',
  '*{box-sizing:border-box}',
  'html{background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-text-size-adjust:100%}',
  'body{margin:0;padding:24px 16px 64px}',
  'main{max-width:46rem;margin:0 auto}',
  'h1{font-size:1.6rem;line-height:1.25;margin:0 0 1.2em}',
  'h2{font-size:1.15rem;margin:2em 0 .6em;padding-top:.6em;border-top:1px solid var(--line)}',
  'p,li{overflow-wrap:anywhere}',
  'ul,ol{padding-left:1.4em}',
  'code{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:.08em .3em;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}',
  'table{width:100%;border-collapse:collapse;margin:1em 0;font-size:.94em;display:block;overflow-x:auto}',
  'th,td{border:1px solid var(--line);padding:.5em .6em;text-align:left;vertical-align:top}',
  'th{background:var(--card);font-weight:600}',
  'a{color:var(--accent)}'
].join('\n');

const policySrc = fs.existsSync(path.join(ROOT, POLICY_MD)) ? read(POLICY_MD) : null;
if (!policySrc) fail(POLICY_MD + ': исходник политики не найден — шестой файл артефакта не из чего собирать');

/** Текст политики без комментариев репозитория: именно он выходит в свет. */
const policyBody = policySrc ? policySrc.replace(/<!--[\s\S]*?-->/g, '') : '';
let privacyOut = '';
if (policySrc) {
  const rendered = mdToBody(policySrc);
  privacyOut = '<!DOCTYPE html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + htmlEscape(rendered.h1 || '') + '</title>\n<style>\n' + PRIVACY_CSS +
    '\n</style>\n</head>\n<body>\n<main>\n' + rendered.body + '\n</main>\n</body>\n</html>\n';

  /* Постусловия — по готовому тексту страницы, а не по факту срабатывания
   * регэкспов рендерера. Рендерер, который тихо съел абзац, хуже отсутствия
   * рендерера: страницу читает модератор, а не мы. */
  const want = collapseWs(mdToPlain(policySrc));
  const got = collapseWs(htmlToPlain(privacyOut));
  if (want !== got) {
    let k = 0;
    while (k < want.length && k < got.length && want[k] === got[k]) k++;
    fail('privacy.html: видимый текст разошёлся с исходником на символе ' + k +
      '\n        исходник: …' + want.slice(Math.max(0, k - 70), k + 70) +
      '\n        страница: …' + got.slice(Math.max(0, k - 70), k + 70));
  }
  const h2Src = (norm(policyBody).match(/^## /gm) || []).length;
  if (h2Src !== rendered.h2) fail('privacy.html: разделов H2 в исходнике ' + h2Src + ', а на странице ' + rendered.h2);
  if (!rendered.h1) fail('privacy.html: у исходника нет заголовка H1 — нечем заполнить <title>');
  if (privacyOut.includes('<!--')) fail('privacy.html: в публичной странице остался HTML-комментарий');
  // Маркер в исходнике = маркер на публичной странице. Рендерер не вправе ни
  // проглотить незакрытое (его заметят только на модерации), ни придумать.
  if (JSON.stringify(markersOf(policyBody)) !== JSON.stringify(markersOf(privacyOut))) {
    fail('privacy.html: маркеры {{...}} изменились при рендере: ' + markersOf(policyBody).join(', ') +
      ' → ' + markersOf(privacyOut).join(', '));
  }
  // Подмножество Markdown у рендерера ограниченное. Если в видимом тексте остались
  // его маркеры, конструкция в исходнике не понята, и модератор прочитает «**» и
  // ` вместо смысла. Потерянного слова тут нет — есть непереведённая разметка.
  const visible = collapseWs(htmlToPlain(privacyOut));
  for (const junk of ['`', '**', '__', '<!--']) {
    if (visible.includes(junk)) fail('privacy.html: в видимом тексте остались маркеры Markdown: «' + junk + '»');
  }
  for (const needle of ['RELEASE-STRIP', 'window.NEON', 'sourceMappingURL', 'check-moderation-kit',
    'make-moderation-assets', 'build-release', '.release-check', 'tools/', 'node_modules',
    'assets/moderation', 'DISTORT', 'stand-guard']) {
    if (privacyOut.includes(needle)) fail('privacy.html: наружу едет «' + needle + '»');
  }
  for (const must of ['<!DOCTYPE html>', '<html lang="ru">', '<meta charset="utf-8">']) {
    if (!privacyOut.includes(must)) fail('privacy.html: нет ' + must);
  }
  const pBytes = Buffer.byteLength(privacyOut, 'utf8');
  if (pBytes < 6000) fail('privacy.html: весит ' + pBytes + ' байт — меньше всего документа, рендер что-то потерял');
  if (pBytes > 80000) fail('privacy.html: весит ' + pBytes + ' байт — неожиданно много, проверить состав');
}

/* ---------- 4. index.html: ?v= по содержанию КОНЕЧНЫХ файлов ---------- */
const ART = {
  'index.html': null,
  'style.css': norm(SRC['style.css']),
  'game.js': norm(gameOut),
  'vk-integration.js': norm(vkOut),
  'privacy.html': norm(privacyOut),
  [VENDOR.file]: norm(sdkOut)
};
const ver = {};
for (const name of HTML_ASSETS) ver[name] = sha256(Buffer.from(ART[name], 'utf8')).slice(0, 8);

let htmlOut = norm(SRC['index.html']);
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
// Область — игровые файлы: политика проверяется своим списком утечек выше, потому
// что она обязана называть вещи своими именами («в публичной сборке флаг DEBUG
// заменяется false»), и запрет на слово DEBUG в её отношении значил бы, что
// документ не может описать то, что мы вырезаем.
const GAME_ONLY = ['index.html', 'style.css', 'game.js', 'vk-integration.js', VENDOR.file];
const joined = GAME_ONLY.map((f) => ART[f]).join('\n');
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
  const tag = ver[f] ? '?v=' + ver[f]
    : (f === VENDOR.file ? 'версия в имени файла'
      : (f === 'index.html' ? 'сам раздаёт ?v трём ресурсам' : 'без ?v: документ не грузится игрой'));
  console.log('  ' + f.padEnd(24) + String(size).padStart(7) + '  ' + tag);
}
console.log('  ' + 'итого'.padEnd(24) + String(total).padStart(7));
console.log('  отладка: хук вырезан, DEBUG === false → ?debug=1 не даёт ни NEON, ни отключения потолка правдоподобия');
console.log('  SDK: ' + VENDOR.file + ' (' + VENDOR.package + ' ' + VENDOR.version + ', ' + VENDOR.license + '), sha256 ' + VENDOR.sha256.slice(0, 16) + '…, CDN — резервная цепочка');
console.log('  политика: privacy.html отрендерена из ' + POLICY_MD + ' — комментарии вырезаны, видимый текст сверен с исходником');
console.log('  состав: ' + EXPECTED.length + ' файлов, ничего из набора проверок рядом нет');
