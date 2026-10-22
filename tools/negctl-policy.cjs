#!/usr/bin/env node
/* ==========================================================================
 * tools/negctl-policy.cjs — живость постусловий рендера privacy.html.
 *
 * Сборщик артефакта научился восьмому: он рендерит публичную privacy.html из
 * исходника политики, и у этого рендера около десяти постусловий. Постусловия,
 * которые никто не пробовал сломать, равны их отсутствию — ровно та причина, по
 * которой в репозитории уже живут tools/negctl-copy.cjs и NEON_KIT_DISTORT.
 *
 * Что делает: берёт исходник политики, портит его шестью правдоподобными
 * способами — по одному, — и требует, чтобы конвейер остановился именно с
 * ожидаемым сообщением. Пять мутаций ловит сборщик, шестая («раздел понижен в
 * заголовке третьего уровня») сборку проходит и должна быть поймана check:kit:
 * сломать страницу так, чтобы первая линия обороны её пропустила, — это ровно
 * тот случай, который проверяется второй линией.
 *
 * Исходник портится на диске и восстанавливается из снимка в finally. Снимок
 * сравнивается байт в байт, а в конце пересобирается чистый артефакт: тишина при
 * неудачном восстановлении стоила бы испорченной заявки в кабинет VK, поэтому
 * несовоспадение — код возврата 3 и крик.
 *
 * Запуск:
 *   node tools/negctl-policy.cjs
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MD = path.join(ROOT, 'assets', 'moderation', 'privacy-policy.md');
const BUILDER = path.join(ROOT, 'tools', 'build-release.cjs');
const KIT = path.join(ROOT, 'tools', 'check-moderation-kit.cjs');

const snapshot = fs.readFileSync(MD);
const text = snapshot.toString('utf8');

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log('  \u2705 ' + name); }
  else { failed++; console.log('  \u274c ' + name + (extra !== undefined ? '  \u2192 ' + JSON.stringify(extra) : '')); }
};

const run = (script) => {
  const r = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

const MUTATIONS = [
  {
    name: 'маркер разорван переносом строки',
    layer: 'build', expect: /маркеры \{\{\.\.\.\}\} изменились при рендере/,
    // Мишень — форма, а не содержимое: поле «Контакт для обращений» живёт и до, и
    // после закрытия маркера, а буквального «{{EMAIL}}» в готовом комплекте больше
    // нет. Мутация подставляет разорванный маркер на место настоящего значения.
    apply: () => text.replace(/Контакт для обращений: \S+/, 'Контакт для обращений: {{EMA\nИЛ}}')
  },
  {
    name: 'труба внутри инлайн-кода в ячейке таблицы',
    layer: 'build', expect: /видимый текст разошёлся с исходником/,
    apply: () => text.replace('`vk_platform`, `impl`, `is_app`', '`vk_platform|impl`, `is_app`')
  },
  {
    name: 'путь репозитория в тексте политики',
    layer: 'build', expect: /наружу едет/,
    apply: () => text.replace('## 2. Чего мы НЕ собираем', 'См. также tools/build-release.cjs.\n\n## 2. Чего мы НЕ собираем')
  },
  {
    name: 'удалён заголовок H1',
    layer: 'build', expect: /нет заголовка H1/,
    apply: () => text.replace(/^# .*\r?\n/, '')
  },
  {
    name: 'незакрытый инлайн-код',
    layer: 'build', expect: /маркеры Markdown/,
    apply: () => text.replace('Cookies от своего имени', 'Cookies `от своего имени')
  },
  {
    name: 'раздел 6 понижен до заголовка третьего уровня',
    layer: 'kit', expect: /раздел есть: ## 6\. Гильдия|несёт все девять разделов/,
    apply: () => text.replace('## 6. Гильдия', '### 6. Гильдия')
  }
];

try {
  for (const m of MUTATIONS) {
    const mutated = m.apply();
    if (mutated === text) {
      ok(false, m.name + ': мутация не применилась — исходник изменился не так, как ждал прогон');
      continue;
    }
    fs.writeFileSync(MD, mutated, 'utf8');
    const b = run(BUILDER);
    if (m.layer === 'build') {
      const caught = b.code !== 0 && m.expect.test(b.out);
      ok(caught, m.name + ' → сборка остановилась', caught ? undefined : { code: b.code, хвост: b.out.slice(-260) });
    } else {
      // Сборка обязана пропустить: постусловия рендера здесь честны — текст цел,
      // разметка понятна. Ловит второй эшелон.
      const k = b.code === 0 ? run(KIT) : null;
      const caught = b.code === 0 && k && k.code !== 0 && m.expect.test(k.out);
      ok(caught, m.name + ' → сборка пустила, check:kit поймал',
        caught ? undefined : { build: b.code, kit: k ? k.code : 'не запускался', хвост: ((k || b).out || '').slice(-260) });
    }
  }
} finally {
  fs.writeFileSync(MD, snapshot);
  if (!fs.readFileSync(MD).equals(snapshot)) {
    console.error('\n\u274c Исходник политики не восстановлен байт в байт — проверьте файл вручную (git diff).');
    process.exit(3);
  }
  const clean = run(BUILDER);
  if (clean.code !== 0) {
    console.error('\n\u274c Чистая пересборка после контроля упала — дерево осталось в испорченном состоянии:\n' + clean.out.slice(-600));
    process.exit(3);
  }
  console.log('\n  исходник восстановлен байт в байт, артефакт пересобран начисто');
}

console.log('\n===== ОТРИЦАТЕЛЬНЫЙ КОНТРОЛЬ РЕНДЕРА ПОЛИТИКИ: ' + passed + ' ok / ' + failed + ' fail =====');
if (failed) console.log('Хоть одна мутация прошла незамеченной: постусловие декоративно, публичная страница может уехать битой.');
process.exit(failed ? 1 : 0);
