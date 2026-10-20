#!/usr/bin/env node
/* ==========================================================================
 * tools/check-moderation-kit.cjs — ворота перед отправкой заявки в кабинет VK.
 *
 * Почему не README и не проверка в браузере. Материалы модерации — это текст,
 * а текст устаревает молча: код меняется, документы остаются красивыми.
 * Политика конфиденциальности, написанная один раз и никогда больше не
 * перечитанная, хуже отсутствующей: она уверяет VK в том, чего приложение уже не
 * делает. Поэтому каждое содержательное утверждение документов выведено из
 * game.js и vk-integration.js и сверяется здесь по факту прогона.
 *
 * Это НЕ пятый набор проверок. Четыре набора гоняют игру, .release-check.cjs
 * гоняет публикацию — все они про поведение. Этот скрипт про комплект бумаг:
 * ничего не запускает, не требует браузера, стенда и зависимостей (только
 * node:fs/path/crypto) и отвечает на другой вопрос: «можно ли отправлять».
 * Отсюда код возврата: 1 и при расхождении, и при незакрытых маркерах {{...}} —
 * состояние «ждёт человека» в отправку не выпускает.
 *
 * Негативный контроль. Сверки имели бы смысл только если они краснеют на битых
 * данных, поэтому NEON_KIT_DISTORT=keys|methods|domain|reset|foreign|geom|limit
 * портит копию в памяти (файлы не трогаются) — и прогон обязан упасть. Штатный
 * запуск переменную не задаёт.
 *
 * Запуск:
 *   node tools/check-moderation-kit.cjs
 *   $env:NEON_KIT_DISTORT='keys'; node tools/check-moderation-kit.cjs   # краснеет?
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const KIT = path.join(ROOT, 'assets', 'moderation');

const DISTORTIONS = ['keys', 'methods', 'domain', 'reset', 'foreign', 'geom', 'limit'];
const DISTORT = String(process.env.NEON_KIT_DISTORT || '').toLowerCase();
if (DISTORT && !DISTORTIONS.includes(DISTORT)) {
  console.error('NEON_KIT_DISTORT должен быть одним из: ' + DISTORTIONS.join(', '));
  process.exit(2);
}

let passed = 0, failed = 0;
const pending = [];
const log = (...a) => console.log('  ' + a.join(' '));
const ok = (cond, name, extra) => {
  if (cond) { passed++; log('\u2705 ' + name); }
  else { failed++; log('\u274c ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra) : '')); }
};

/** Заголовок IHDR руками: декодера PNG в дереве нет (тот же приём в генераторе). */
function pngHead(buf) {
  if (buf.length < 26) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.slice(12, 16).toString('latin1') !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), depth: buf[24], color: buf[25] };
}

const readText = (p) => fs.readFileSync(p, 'utf8');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);

/* --------------------------------------------------------------------------
 * Факты из кода. Скрипт не пересказывает документы — он читает игру и сверяет.
 * Не сработавшая регулярка здесь падает, а не даёт undefined в сравнении: молча
 * сверить «ничего» с документом значило бы выдать зелёный прогон по битым данным.
 * ------------------------------------------------------------------------ */
const GAME_SRC = readText(path.join(ROOT, 'game.js'));
const BRIDGE_SRC = readText(path.join(ROOT, 'vk-integration.js'));

function grab(src, re, what) {
  const m = re.exec(src);
  if (!m) throw new Error('check-moderation-kit: не прочитано из кода: ' + what);
  return m;
}

const CODE = {
  saveKey: grab(GAME_SRC, /saveKey:\s*'([^']+)'/, 'CFG.saveKey')[1],
  cloudKey: grab(GAME_SRC, /key:\s*'([^']+)'/, 'CFG.cloud.key')[1],
  valueMax: Number(grab(GAME_SRC, /valueMax:\s*(\d+)/, 'CFG.cloud.valueMax')[1]),
  everyMs: Number(grab(GAME_SRC, /everyMs:\s*(\d+)/, 'CFG.cloud.everyMs')[1]),
  maxCalls: Number(grab(GAME_SRC, /maxCallsPerHour:\s*(\d+)/, 'CFG.cloud.maxCallsPerHour')[1]),
  sharePerDay: Number(grab(GAME_SRC, /share:\s*\{[^}]*?perDay:\s*(\d+)/, 'CFG.share.perDay')[1]),
  riskPerDay: Number(grab(GAME_SRC, /risk:\s*\{[^}]*?perDay:\s*(\d+)/, 'CFG.risk.perDay')[1]),
  minStake: Number(grab(GAME_SRC, /minStake:\s*(\d+)/, 'CFG.risk.minStake')[1]),
  stakes: grab(GAME_SRC, /stakes:\s*\[([^\]]+)\]/, 'CFG.risk.stakes')[1]
    .split(',').map((x) => Math.round(Number(x.trim()) * 100)),
  // boostMs записан арифметикой («5 * 60000»), поэтому считаем произведение членов,
  // а не Number(вся строка): Number('5 * 60000') дал бы NaN и молча утащил бы NaN в
  // сравнение с документом — зелёный прогон по невычисленным данным.
  boostMin: grab(GAME_SRC, /boostMs:\s*\[([^\]]+)\]/, 'CFG.risk.boostMs')[1]
    .split(',').map((term) => term.split('*').reduce((a, b) => a * Number(b.trim()), 1) / 60000),
  demo: grab(BRIDGE_SRC, /const DEMO_MODE = (true|false);/, 'DEMO_MODE')[1] === 'true',
  sign: /fnv1a\(/.test(GAME_SRC),
  themes: ['neon', 'meme', 'sat'].filter((t) => new RegExp('^\\s{4}' + t + ':\\s\\{', 'm').test(GAME_SRC)),
  cloudOnReset: /wipe\(\);[\s\S]{0,400}?cloudPush\(true\)/.test(GAME_SRC)
};

// Методы, к которым мост РЕАЛЬНО обращается — отдельно от просто упомянутых:
// VKWebAppCallAPIMethod и VKWebAppGetCommunityToken встречаются в vk-integration.js
// как обоснованный отказ, и принимать их за вызываемые нельзя.
CODE.invoked = [...new Set(
  (BRIDGE_SRC.match(/(?:send|safeCall|groupSwitch)\(\s*'(VKWebApp[A-Za-z]+)'/g) || [])
    .map((s) => s.match(/'(VKWebApp[A-Za-z]+)'/)[1])
)].sort();

// Чего мост не вызывает никогда — и что политика обязана назвать своими именами.
CODE.neverCalled = [
  'VKWebAppGetEmail', 'VKWebAppGetUserInfo', 'VKWebAppGeolocationRequests',
  'VKWebAppCallAPIMethod', 'VKWebAppGetCommunityToken', 'VKWebAppShowOrderBox'
];

// Домены, до которых реально дотягивается из боевого артефакта. Если _site есть,
// берём его — это те самые байты, что смотрят наружу; иначе исходники.
const ARTIFACT_DIR = path.join(ROOT, '_site');
const ARTIFACT_FILES = fs.existsSync(ARTIFACT_DIR)
  ? fs.readdirSync(ARTIFACT_DIR).filter((f) => /\.(js|html)$/.test(f)).map((f) => path.join(ARTIFACT_DIR, f))
  : [path.join(ROOT, 'game.js'), path.join(ROOT, 'vk-integration.js'), path.join(ROOT, 'index.html')];

const NAMESPACES = ['www.w3.org'];   // XML-пространство имён в svg — не сетевой запрос
const ALLOWED = ['unpkg.com', 'cdn.jsdelivr.net', 'vk.com', 'cybertechnet.github.io'];
const TRACKERS = ['mc.yandex.ru', 'google-analytics.com', 'googletagmanager.com',
  'doubleclick.net', 'connect.facebook.net', 'hotjar.com', 'sentry.io'];

CODE.hosts = [...new Set(
  ARTIFACT_FILES.flatMap((f) => readText(f).match(/https?:\/\/[a-z0-9.-]+/gi) || [])
    .map((u) => u.replace(/^https?:\/\//i, '').toLowerCase())
)].sort();

// Документы комплекта.
const POLICY_PATH = path.join(KIT, 'privacy-policy.md');
const DOSSIER_PATH = path.join(KIT, 'application.md');
const POLICY = fs.existsSync(POLICY_PATH) ? readText(POLICY_PATH) : '';
const DOSSIER = fs.existsSync(DOSSIER_PATH) ? readText(DOSSIER_PATH) : '';

/* --------------------------------------------------------------------------
 * Негативный контроль. Портим копии в памяти, файлы остаются целыми. Каждая
 * порча обязана покраснить хотя бы одну проверку — иначе проверка декоративная.
 * ------------------------------------------------------------------------ */
const code = { ...CODE };
let policy = POLICY, dossier = DOSSIER;
let geomOverride = null;
let releaseTxt = readText(path.join(ROOT, '.release-check.cjs'));
let builderTxt = readText(path.join(ROOT, 'tools', 'build-release.cjs'));

if (DISTORT === 'keys') policy = policy.split(CODE.saveKey).join('neonclick.save.v9');
if (DISTORT === 'methods') policy = policy.split('VKWebAppGetGroupInfo').join('VKWebAppGetCommunityStats');
// Чужой хост в контроле берёт не зарезервированное имя: 'mc.yandex.ru' — метрика VK,
// ровно то, чего в артефакте быть не может, и фильтр RFC 6761 её не простит.
if (DISTORT === 'domain') code.hosts = [...code.hosts, 'mc.yandex.ru'].sort();
if (DISTORT === 'reset') code.cloudOnReset = false;
if (DISTORT === 'limit') code.sharePerDay = 4;
if (DISTORT === 'geom') geomOverride = { w: 512, h: 511 };
if (DISTORT === 'foreign') releaseTxt = releaseTxt.replace(/'assets\/moderation\/privacy-policy\.md',?\s*/, '');
if (DISTORT) log('!\tнегативный контроль включён: NEON_KIT_DISTORT=' + DISTORT);

// Переносы в прозе рвут фразы пополам («700\nобращений в час»), поэтому все сверки
// текста идут по свёрнутой копии. Оригинал при этом не трогаем: правим мы документы,
// а не они подстраиваются под регулярки.
const flat = (s) => s.replace(/\s+/g, ' ').trim();
policy = flat(policy);
dossier = flat(dossier);

const SHOTS = { w: 390 * 2, h: 844 * 2 };   // 390×844 @2x — тот же viewport, что у генератора
const PNGS = [
  { name: 'icon-512.png', w: 512, h: 512 },
  { name: 'icon-192.png', w: 192, h: 192 },
  { name: 'screen-neon.png', w: SHOTS.w, h: SHOTS.h },
  { name: 'screen-meme.png', w: SHOTS.w, h: SHOTS.h },
  { name: 'screen-sat.png', w: SHOTS.w, h: SHOTS.h },
  { name: 'screen-bonus.png', w: SHOTS.w, h: SHOTS.h }
];

console.log('\n[1] Комплект на месте и цел');
{
  const digests = new Map();
  for (const spec of PNGS) {
    const file = path.join(KIT, spec.name);
    if (!fs.existsSync(file)) { ok(false, spec.name + ': файл на месте'); continue; }
    const buf = fs.readFileSync(file);
    const head = geomOverride || pngHead(buf);
    ok(!!head, spec.name + ': это PNG с IHDR');
    ok(buf.length > 20000, spec.name + ': не пустышка (' + buf.length + ' байт)', buf.length);
    ok(head && head.w === spec.w && head.h === spec.h, spec.name + ': геометрия ' + spec.w + '\u00d7' + spec.h,
      head && { w: head.w, h: head.h });
    ok(head && head.depth === 8, spec.name + ': глубина 8 бит', head && head.depth);
    ok(head && (head.color === 2 || head.color === 6), spec.name + ': цвет RGB или RGBA', head && head.color);
    const d = sha(buf);
    if (digests.has(d)) ok(false, spec.name + ': не дубликат ' + digests.get(d), d);
    else digests.set(d, spec.name);
  }
  ok(digests.size === PNGS.length, 'шесть файлов дали шесть разных содержимых (тихая копипаста ловится)', digests.size);
  ok(policy.length > 4000, 'политика конфиденциальности написана (' + policy.length + ' символов)', policy.length);
  ok(dossier.length > 4000, 'досье написано (' + dossier.length + ' символов)', dossier.length);
}

console.log('\n[2] Политика: обязательные разделы');
{
  const SECTIONS = [
    '## 1. Кто мы и что работает',
    '## 2. Чего мы НЕ собираем',
    '## 3. Что мы читаем при запуске',
    '## 4. Где хранится прогресс',
    '## 5. Реклама и репосты',
    '## 6. Гильдия',
    '## 7. Кто ещё видит эти данные',
    '## 8. Что может сделать игрок',
    '## 9. Версия и изменения'
  ];
  for (const s of SECTIONS) ok(policy.includes(s), 'раздел есть: ' + s);
  // VK спрашивает три вещи помимо воли разработчика: кто мы, как удалить, когда обновлялось.
  ok(/{{EMAIL}}|@/.test(policy), 'политика оставляет канал связи');
  ok(policy.includes('Сбросить прогресс'), 'политика объясняет, как удалить прогресс');
  ok(policy.includes('{{ДАТА}}') || /Дата последнего изменения:\s*\S/.test(policy), 'политика датирована');
}

console.log('\n[3] Политика против кода: хранилище');
{
  ok(policy.includes('`' + code.saveKey + '`'), 'назван настоящий ключ LocalStorage (' + code.saveKey + ')');
  ok(policy.includes('`' + code.cloudKey + '`'), 'назван настоящий ключ облака (' + code.cloudKey + ')');
  // Устаревший ключ в документе — частый случай: код мигрировал, текст остался.
  const stale = [...new Set(policy.match(/neonclick[a-z0-9._-]*/gi) || [])]
    .filter((t) => t !== code.saveKey && t !== code.cloudKey && t !== 'neonclick');
  ok(stale.length === 0, 'в политике нет ключей, которых не существует в игре', stale);
  ok(policy.includes(String(code.valueMax)), 'назван настоящий лимит значения облака (' + code.valueMax + ')');
  ok(policy.includes(Math.round(code.everyMs / 1000) + ' секунд'), 'названа настоящая частота фоновой записи');
  ok(policy.includes(code.maxCalls + ' обращений в час'), 'назван настоящий потолок обращений');
  ok(code.sign && policy.includes('FNV-1a'), 'контрольная сумма описана так, как считается в игре');
  const lsAll = (GAME_SRC.match(/localStorage\.\w+\(/g) || []).length;
  const lsKeyed = (GAME_SRC.match(/localStorage\.\w+\(\s*CFG\.saveKey\b/g) || []).length;
  ok(lsAll > 0 && lsAll === lsKeyed, 'игра ходит в LocalStorage только через один ключ (' + lsAll + ' обращений)',
    { all: lsAll, keyed: lsKeyed });
  ok(!/document\.cookie/.test(GAME_SRC + BRIDGE_SRC), 'cookies от своего имени не выставляются');
}

console.log('\n[4] Политика против кода: мост VK');
{
  // Каждое «не запрашиваем» в политике — это проверенный отказ, а не надежда.
  for (const m of code.neverCalled) {
    ok(!code.invoked.includes(m), m + ': мост к нему не обращается');
    ok(policy.includes(m), m + ': назван в политике прямым текстом');
  }
  // Данные, которые уходят наружу, обязаны быть названы все.
  const DISCLOSED = ['VKWebAppStorageGet', 'VKWebAppStorageSet', 'VKWebAppCheckNativeAds',
    'VKWebAppShowNativeAds', 'VKWebAppShare', 'VKWebAppGetGroupInfo', 'VKWebAppJoinGroup', 'VKWebAppLeaveGroup'];
  for (const m of DISCLOSED) {
    ok(code.invoked.includes(m), m + ': действительно вызывается');
    ok(policy.includes(m), m + ': раскрыт в политике');
  }
  // Выдуманного метода в документе быть не может: список методов — тоже утверждение.
  // Словарь — это не только мост: отказанные методы политика называет прямо, и их
  // отсутствие в vk-integration.js не делает их выдумкой.
  const VOCAB = new Set([...code.invoked, ...code.neverCalled,
    ...(BRIDGE_SRC.match(/VKWebApp[A-Za-z]+/g) || [])]);
  const invented = [...new Set(policy.match(/VKWebApp[A-Za-z]+/g) || [])]
    .filter((m) => !VOCAB.has(m));
  ok(invented.length === 0, 'в политике нет методов, которых нет в мосте', invented);
  ok(!code.demo, 'демо-режим выключен: заглушек вместо рекламы в боевой сборке нет');
  ok(policy.includes('DEMO_MODE'), 'политика объясняет, чем боевой режим отличается от демо');
  ok(!/new XMLHttpRequest|fetch\(\s*['"]http/.test(GAME_SRC + BRIDGE_SRC),
    'прямых сетевых вызовов от своего имени ни в игре, ни в мосте');
}

console.log('\n[5] Политика против кода: сеть, реклама, сброс');
{
  // Зарезервированные RFC 6761 домены — не сетевая поверхность: 'https://site.example/...'
  // в комментарии к шарингу никуда не ходит. Требовать его от политики значило бы
  // заставлять документ описывать чужие пояснения в исходниках.
  const RESERVED = /(\.example|\.invalid|\.test|\.localhost$|^example\.(com|org|net)$)/i;
  const realHosts = code.hosts.filter((h) => !RESERVED.test(h) && !NAMESPACES.includes(h));
  const foreign = realHosts.filter((h) => !ALLOWED.includes(h));
  ok(foreign.length === 0, 'артефакт знает только разрешённые домены', foreign);
  const tracked = TRACKERS.filter((h) => ARTIFACT_FILES.some((f) => readText(f).includes(h)));
  ok(tracked.length === 0, 'метрик и трекеров в артефакте нет', tracked);
  // Каждый найденный домен должен быть назван в политике: молчаливое исключение — ложь.
  const undisclosed = realHosts.filter((h) => !policy.includes(h));
  ok(undisclosed.length === 0, 'каждый домен из артефакта назван в политике', undisclosed);
  ok(/reward/.test(BRIDGE_SRC), 'реклама в мосте — вознаграждаемая (ролик за награду), как и заявлено');
  ok(policy.includes('показывает VK') || policy.includes('показывает сам VK'),
    'политика говорит, что ролики показывает VK, а не игра');
  ok(code.cloudOnReset, 'сброс прогресса действительно перезаписывает облако');
  ok(policy.includes('перезаписывает облако'), 'политика обещает именно это поведение сброса');
  const WORDS = { 1: 'одном', 2: 'двумя', 3: 'тремя', 4: 'четырьмя', 5: 'пятью' };
  const want = WORDS[code.sharePerDay];
  ok(!!want && policy.includes(want + ' в сутки'),
    'суточный лимит репостов в политике совпадает с кодом (' + code.sharePerDay + ')',
    policy.match(/\S+ в сутки/));
}
console.log('\n[6] Досье против кода: признаки категории');
{
  const HEADS = ['## 1. Поля кабинета', '## 2. Категория', '## 3. Возрастной ценз',
    '## 4. Описание для витрины', '## 5. Комплект материалов', '## 6. Открытые решения',
    '## 7. Чек-лист отправки', '## 8. Как обновлять'];
  for (const h of HEADS) ok(dossier.includes(h), 'раздел есть: ' + h);
  ok(dossier.includes(String(code.minStake)), 'минимальная ставка названа настоящей (' + code.minStake + ')');
  ok(dossier.includes(code.stakes.join('/') + '%'), 'варианты ставки названы настоящими (' + code.stakes.join('/') + '%)');
  ok(dossier.includes('(' + code.boostMin.join('/') + ' минут)'), 'призы раунда названы настоящими (' + code.boostMin.join('/') + ' минут)');
  ok(dossier.includes(code.riskPerDay + ' раунда в сутки'), 'суточный лимит раундов настоящий (' + code.riskPerDay + ')');
  ok(dossier.includes('матожидание') && /riskBurned/.test(GAME_SRC),
    'отрицательное матожидание заявлено и опирается на код (ставка сгорает в S.total)');
  ok(dossier.includes('вывода ценности нет'), 'сказано, что выводить нечего');
  ok(dossier.includes('«12+»') && dossier.includes('«18+»') && dossier.includes('{{ВОЗРАСТНОЙ ЦЕНЗ}}'),
    'ценз обоснован вилкой и оставлен человеку, а не выдуман');
  /* Гильдейский состав. Прежнее правило ветвилось от пустого roster: стоило
     заполнить список, как требование живого скриншота молча отменилось — ровно
     в тот момент, когда вкладка начинает показывать реальное сообщество. Теперь
     проверка безусловная и дополнительно сверяет каждый id с досье: id, уехавший
     в код и не названный в бумагах, — это гильдия, которую модератор не найдёт. */
  const rosterSrc = (GAME_SRC.match(/guild:\s*\{[\s\S]*?\n\s*\}/) || [''])[0];
  const rosterIds = [...rosterSrc.matchAll(/\{\s*id:\s*(\d+)\s*,\s*name:\s*'[^']*'\s*\}/g)]
    .map((m) => m[1]);
  ok(rosterIds.length > 0, 'гильдейский состав заполнен настоящими id сообществ');
  const unlisted = rosterIds.filter((id) => !dossier.includes(id));
  ok(unlisted.length === 0, 'каждый id из CFG.guild.roster назван в досье (§1)', unlisted);
  ok(dossier.includes('Скриншот вкладки «Гильдия»'),
    'досье требует живой скриншот гильдии, а не подделку');
}

console.log('\n[7] Комплект не ездит наружу');
{
  ok(releaseTxt.includes("'assets/moderation/privacy-policy.md'"), '.release-check.cjs держит политику в чужих путях');
  ok(releaseTxt.includes("'assets/moderation/application.md'"), '.release-check.cjs держит досье в чужих путях');
  ok(!/moderation/.test(builderTxt), 'сборщик артефакта про папку модерации не знает (в _site её быть не может)');
  if (fs.existsSync(ARTIFACT_DIR)) {
    ok(!fs.existsSync(path.join(ARTIFACT_DIR, 'assets', 'moderation', 'privacy-policy.md')), 'в _site политики нет');
  }
}

console.log('\n[8] Ждёт ручного заполнения');
{
  const KNOWN = ['РАЗРАБОТЧИК', 'EMAIL', 'ДАТА', 'ВЕРСИЯ', 'URL_ПОЛИТИКИ', 'КАТЕГОРИЯ', 'ВОЗРАСТНОЙ ЦЕНЗ'];
  const seen = new Set();
  for (const [name, text] of [['privacy-policy.md', policy], ['application.md', dossier]]) {
    for (const m of text.match(/\{\{[^}]+\}\}/g) || []) {
      const label = m.slice(2, -2).trim();
      // «{{...}}» в прозе — описание соглашения, а не маркер: без этого различия
      // документ, объясняющий собственные заглушки, краснеет сам себя. Пробел в
      // имени разрешён: «ВОЗРАСТНОЙ ЦЕНЗ» — два слова, и это один маркер.
      if (!/^[A-ZА-Я_][A-ZА-Я0-9_ ]*$/.test(label)) continue;
      seen.add(label);
      pending.push(name + ' \u2192 ' + m);
      // Опечатка в имени маркера переживёт любой срок: её надо ловить списком.
      if (!KNOWN.includes(label)) ok(false, 'неизвестный маркер ' + m, m);
    }
  }
  ok(seen.size === KNOWN.length, 'ожидается ' + KNOWN.length + ' маркеров, найдено ' + seen.size, [...seen]);
  for (const p of pending) log('\u23f3 ' + p);
}

const head = DISTORT ? '===== КОМПЛЕКТ, НЕГАТИВНЫЙ КОНТРОЛЬ ' + DISTORT + ' =====' : '===== КОМПЛЕКТ МОДЕРАЦИИ =====';
console.log('\n' + head + ' ' + passed + ' ok / ' + failed + ' fail / ' + pending.length + ' ждёт');
if (failed) console.log('Есть падения: либо документ разошёлся с кодом, либо сломан сам комплект. Конкретика — в ❌ выше.');
if (!failed && pending.length) console.log('Машина сходится. Отправке мешают только ' + pending.length + ' ручных решений из раздела 6 досье.');
process.exit(failed || pending.length ? 1 : 0);





