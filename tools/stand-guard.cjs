/* ==========================================================================
 * tools/stand-guard.cjs — префлайт: стенд отдаёт ИСХОДНИКИ или боевой артефакт?
 *
 * Зачем. Три набора (.vk-mock-check, .visual-check, .stress-check) читают
 * адрес стенда из NEON_BASE и ждут там корень репозитория: им нужен game.js с
 * отладочными хуками, потому что они тыкают в живую игру через window.NEON.
 * Четвёртый набор (.release-check) читает ТОТ ЖЕ самый NEON_BASE, но ждёт в
 * нём противоположное — собранный _site. Плюс `npm run serve:release` поднимает
 * _site на порту 5173 — по умолчанию тому же, где исходники ищут первые три.
 *
 * Отсюда ловушка: один раз экспортировал NEON_BASE для релизной проверки — и
 * три набора дальше тонут не внятной ошибкой, а молчаливым
 * «TimeoutError: Waiting failed: 15000ms exceeded», потому что window.NEON в
 * боевом артефакте нет по построению (сборщик вырезает HOOK-регионы). Так
 * поломка стенда выглядит как регрессия в коде игры.
 *
 * Страж дешёвый (один HTTP-заголовок до запуска браузера) и переводит эту
 * ловушку из «15 секунд тишины и стектрейс» в одну строку с причиной и лечением.
 * ========================================================================== */
'use strict';

/** Признак отладочных хуков в game.js. В релизе их нет никогда. */
const DEV_MARKER = /\bwindow\.NEON\b/;

/**
 * Проверяет, что на origin лежит сборка для разработки, и иначе бросает
 * понятную ошибку. Вызывать ДО puppeteer.launch.
 * @param {string} origin  базовый адрес стенда без завершающего слэша
 * @param {string} [who]   имя набора — для текста ошибки
 * @returns {Promise<{url:string, bytes:number}>}
 */
async function requireDevStand(origin, who) {
  const base = String(origin || '').replace(/\/+$/, '');
  const url = base + '/game.js';
  const harness = who || 'набор проверок';

  let src;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error('HTTP ' + res.status + ' на ' + url);
    }
    src = await res.text();
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new Error(
      harness + ': стенд ' + base + ' недоступен (' + (err && err.message) + ').\n' +
      '  Поднимите стенд в КОРНЕ репозитория:\n' +
      '    python -m http.server 5173\n' +
      '  и запустите без NEON_BASE либо с NEON_BASE=http://127.0.0.1:5173'
    );
  }

  if (!DEV_MARKER.test(src)) {
    throw new Error(
      harness + ': на ' + base + ' лежит БОЕВОЙ артефакт, а не исходники — ' +
      'в game.js нет отладочных хуков window.NEON, и быть не может.\n' +
      '  Этот набор тыкает в живую игру через window.NEON, поэтому ему нужен ' +
      'СТЕНД ИЗ КОРНЯ РЕПОЗИТОРИЯ, а не _site.\n' +
      '  Признак: ' + url + ' весит ' + src.length + ' байт.\n' +
      '  Лечение:\n' +
      '    python -m http.server 5173            # в корне репо, не --directory _site\n' +
      '    $env:NEON_BASE = $null                # снять наследованный адрес\n' +
      '  Напоминание: NEON_BASE у .release-check значит «где выкладка», а у ' +
      'этого набора — «где исходники». Это разные стенды.'
    );
  }
  return { url: url, bytes: src.length };
}

/**
 * Обратная сторона той же ловушки: проверяет, что на origin лежит БОЕВОЙ
 * артефакт (отладочных хуков нет). .release-check утверждениями про «этого не
 * должно быть» покрывает ровно то, чего в релизе нет; если подать ему стенд с
 * исходниками, половина проверок станет проверять самое себя, а вторая —
 * краснеть внятно не будет. Вызывать ДО puppeteer.launch.
 * @param {string} origin  базовый адрес стенда без завершающего слэша
 * @param {string} [who]   имя набора — для текста ошибки
 * @returns {Promise<{url:string, bytes:number}>}
 */
async function requireReleaseStand(origin, who) {
  const base = String(origin || '').replace(/\/+$/, '');
  const url = base + '/game.js';
  const harness = who || 'набор проверок';

  let src;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' на ' + url);
    src = await res.text();
  } catch (err) {
    throw new Error(
      harness + ': стенд ' + base + ' недоступен (' + (err && err.message) + ').\n' +
      '  Поднимите СТЕНД БОЕВОГО АРТЕФАКТА и померьте его:\n' +
      '    npm run build:release && npm run serve:release   # _site по умолчанию на 5174\n' +
      '    $env:NEON_BASE = \'http://127.0.0.1:5174\'        # или URL боевой публикации'
    );
  }

  if (DEV_MARKER.test(src)) {
    throw new Error(
      harness + ': на ' + base + ' лежат ИСХОДНИКИ, а не боевой артефакт — ' +
      'в game.js есть отладочные хуки window.NEON.\n' +
      '  Этот набор проверяет, чего в публикации БЫТЬ НЕ ДОЛЖНО, поэтому мерить ' +
      'нужно собранный _site, а не корень репозитория: на исходниках он ' +
      'проверял бы сам себя и молчал там, где обязан краснеть.\n' +
      '  Признак: ' + url + ' весит ' + src.length + ' байт и содержит хук.\n' +
      '  Лечение:\n' +
      '    npm run build:release && npm run serve:release   # _site по умолчанию на 5174\n' +
      '    $env:NEON_BASE = \'http://127.0.0.1:5174\'        # или URL боевой публикации\n' +
      '  Напоминание: NEON_BASE у этого набора значит «где выкладка», а у ' +
      '.vk-mock/.visual/.stress — «где исходники». Это разные стенды.'
    );
  }
  return { url: url, bytes: src.length };
}

module.exports = { requireDevStand, requireReleaseStand, DEV_MARKER };
