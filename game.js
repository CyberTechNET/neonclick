/* ==========================================================================
 * game.js — вся логика кликера NEON CLICK.
 * Чистый JS, без зависимостей и сборки. Про VK знает только через window.VK
 * (см. vk-integration.js) и полностью работоспособен без него.
 * ========================================================================== */

(function () {
  'use strict';

  /* ======================================================================
   * 1. КОНФИГУРАЦИЯ И ИГРОВОЙ БАЛАНС
   * ==================================================================== */
  const CFG = {
    saveKey: 'neonclick.save.v1',
    saveEveryMs: 1000,   // ★ автосохранение в LocalStorage раз в секунду (по ТЗ)
    tickMs: 200,         // частота начисления пассивного дохода

    // Апгрейд 1 — «Сила клика»
    click: { base: 1, perLevel: 1, costBase: 50, costGrowth: 1.15 },
    // Апгрейд 2 — «Авто-майнинг»
    auto: { perLevel: 5, costBase: 250, costGrowth: 1.18 },

    // Криты и комбо — для «залипательности»
    crit: { chance: 0.1, mult: 5 },
    combo: { windowMs: 900, maxStack: 50, perStackBonus: 0.01, showFrom: 5 },

    // Буст x2 за рекламу
    boost: { ms: 5 * 60 * 1000, mult: 2 },

    // Награда за просмотр рекламы: фиксированная валюта
    freeCoinsReward: 1000,
    adCooldownMs: 12 * 1000,  // защита от спама кнопки

    // ★ ВИРУСАЛЬНАЯ ПЕТЛЯ: награда за ФАКТИЧЕСКИЙ репост (VKWebAppShare).
    //   Кран обязан быть закручен: без лимита это не механика виральности,
    //   а бесплатный генератор монет (и сигнал читерам).
    //   perDay — на календарные сутки (UTC), cooldownMs — пауза между
    //   засчитанными репостами.
    share: { reward: 500, perDay: 3, cooldownMs: 60 * 1000 },

    // ★ СОЛО «ВА-БАНК» (риск-раунд). Это НЕ точка монетизации: реклама не
    //   показывается и монеты НЕ создаются.
    //   Смысл — вывод валюты из игры: проигранная ставка сгорает навсегда,
    //   выигрыш возвращает ровно ту же ставку. S.total не растёт ни в одном из
    //   исходов, поэтому раунд не трогает ни ранг, ни «всего заработано», ни
    //   потолок правдоподобия. Ожидание по монетам строго отрицательное
    //   (−0,5 × ставка) — это сток, а не генератор.
    //   Именно поэтому механика совместима с plausibleCap(): выплата,
    //   НЕ подкреплённая активностью, иначе молча срезалась бы при следующей
    //   загрузке (замер: +100 млн недельному аккаунту → уцелело 7,3 млн).
    //   Приз — ВРЕМЯ буста, а не множитель. Поднимать CFG.boost.mult нельзя:
    //   plausibleCap() считает пассивный потолок из расчёта постоянно
    //   включённого ×2, поэтому больший множитель вывел бы честного игрока за
    //   потолок и отнял бы у него монеты без единой ошибки в консоли.
    risk: {
      perDay: 3,                    // раундов на календарные сутки (UTC) — как у репостов
      stakes: [0.25, 0.5, 1],       // доля баланса, последний — ва-банк
      minStake: 1000,               // ниже — неинтересно (= одна награда за рекламу)
      boostMs: [5 * 60000, 10 * 60000, 15 * 60000]   // мин. буста ×2 за победу, по индексу ставки
    },

    // ★ ГИЛЬДИИ = СООБЩЕСТВА VK (раздел 13d). Своя идентичность не изобретается:
    //   гильдия — это обычное сообщество VK, список участников которого ведёт VK.
    //   Значит авторитетный реестр членов уже существует и проверяем из клиента
    //   (is_member), а вступление — один вызов моста.
    //   roster — статичный список сообществ-гильдий, переживает ребрендинг так же,
    //   как темы: id сообщества не зависит от бренда игры. Заполняется ТОЛЬКО
    //   настоящими id: выдуманная запись отправила бы игрока в чужое сообщество.
    //   Одна запись — выбирать не из чего, пикер скрыт (renderGuild: length > 1),
    //   и гильдия определяется запуском из папки сообщества (vk_group_id). Список
    //   из двух и более записей оживляет пикер сам собой, без правок логики.
    guild: {
      roster: [
        { id: 242457640, name: 'NeonClick' }   // сообщество-обложка: vk.com/club242457640
      ]
    },

    // ★ «БАТЛЫ» = ДЕТЕРМИНИРОВАННЫЙ НЕДЕЛЬНЫЙ РЕЙД (раздел 13d). Это НЕ точка
    //   монетизации: монеты здесь НЕ создаются и реклама не показывается.
    //   Честь выводится из дельты УЖЕ подтверждённого заработка (S.rdEarned
    //   растёт внутри earn(), то есть ПОСЛЕ потолка maxSingleEarn), поэтому
    //   новый кран валюты не появляется, а plausibleCap() НЕ требует
    //   расширения — в отличие от репостов, которые в потолок пришлось добавить
    //   (см. комментарий к plausibleCap). Накрутка, срезанная при загрузке,
    //   режет и честь: два античита не расходятся.
    //   Награда — ВРЕМЯ буста ×2, тот же край maxBoostAheadMs, что у рекламы.
    //   Общий счёт гильдии здесь невозможен в принципе: vk-bridge v3 не даёт ни
    //   серверless, ни общего хранилища (проверено положительно по всем 307
    //   методам), а запись через GetCommunityToken подделывается любым
    //   участником. Детерминизм условий по номеру ISO-недели — честная замена:
    //   всем гильдиям достаются одинаковые правила, спорить не о чем.
    raid: {
      honorPer: 1000,               // 1000 подтверждённого заработка недели = 1 честь
      guildMult: 1.25,              // надбавка состоявшемуся в гильдии — ТОЛЬКО престиж, не монеты
      boostCost: 5,                 // честь, списываемая за один обмен
      boostMs: 15 * 60000,          // буст ×2 за один обмен
      perDay: 2,                    // потолок обменов на календарные сутки (UTC)
      // Звания рейда по пожизненной чести. Пары [порог, название] — тот же
      // формат, что у RANKS, и тот же смысл: пороги строго возрастают.
      tiers: [
        [50, 'Новобранец'], [250, 'Боец'], [1000, 'Ветеран'],
        [5000, 'Штурмовик'], [25000, 'Гроза рейда']
      ]
    },

    // Офлайн-доход
    offline: { minMs: 30 * 1000, capMs: 2 * 60 * 60 * 1000, efficiency: 0.5 },

    maxFloats: 22,       // потолок всплывающих "+N" (производительность)
    maxParticles: 160,

    // ★ АНТИЧИТ — границы правдоподобия (см. раздел 15). Пороги заведомо выше
    //   возможностей честного игрока, поэтому ложных срабатываний нет.
    anticheat: {
      maxClicksPerSec: 25,                 // больше — только автокликер
      windowMs: 1000,                      // размер скользящего окна кликов
      maxSingleEarn: 1e9,                  // потолок разового начисления
      maxLevel: 500,                       // потолок уровня апгрейда
      maxBoostAheadMs: 90 * 60 * 1000,     // буст не может быть выдан дальше, чем на 90 мин вперёд
      clockSkewMs: 5 * 60 * 1000,          // «сейв из будущего» — не доверяем
      legacyT0Ms: 30 * 24 * 60 * 60 * 1000, // запас для сейвов до появления t0: потолок не считаем
      slack: 1.05                          // запас к потолку правдоподобия
    },

    // ★ ОБЛАКО (VKWebAppStorage). Официальный лимит VK — 1000 вызовов в час
    //   на пользователя, поэтому держим собственный бюджет с запасом.
    cloud: {
      key: 'neonclick1',                   // VK разрешает [a-zA-Z_\-0-9], длина <= 100
      everyMs: 45000,                      // фоновая запись не чаще раза в 45 сек (~80 вызовов/час)
      minGapMs: 5000,                      // принудительная запись — не чаще раза в 5 сек
      retryMs: 20000,                      // пауза после неудачной записи
      maxCallsPerHour: 700,                // наш потолок обращений к хранилищу
      valueMax: 4096,                      // VK сохраняет только первые 4096 символов значения
      pullFallbackMs: 4000                 // если VK не ответил — играем по локальному сейву
    }
  };

  /* Ранги игрока — прогресс по суммарному заработку. */
  const RANKS = [
    [0, 'Новичок'], [500, 'Кликер'], [5e3, 'Мастер'], [5e4, 'Профи'],
    [25e4, 'Азартный'], [1e6, 'Неон'], [1e7, 'Киборг'], [1e8, 'Майнер'],
    [1e9, 'Легенда'], [1e10, 'Бог клика']
  ];

  /* ======================================================================
   * 1b. ТЕМЫ — полный ребрендинг ОДНОЙ строкой (THEME_ID ниже)
   *
   * Обещание «перезапустить игру под новый хайп за 60 секунд» разбивается не
   * о красоту, а о шесть конкретных ловушек. Каждая закрыта кодом и проверкой:
   *
   *  1. ИДЕНТИЧНОСТЬ ПРОГРЕССА НЕ ЗАВИСИТ ОТ ТЕМЫ. CFG.saveKey и
   *     CFG.cloud.key — константы. Выведите их из имени темы — и
   *     «перекрасить игру» станет «сбросить прогресс всей базе»: старый сейв
   *     просто не найдёт нового ключа. Инвариант проверяет .smoke-test.cjs.
   *  2. ТЕМА ПРИМЕНЯЕТСЯ СИНХРОННО, до первого пейнта (скрипт подключён в
   *     конце body, <html> уже существует). Иначе на долю секунды виден
   *     СТАРЫЙ бренд — ровно то, ради чего и делают ребрендинг.
   *  3. НЕИЗВЕСТНОЕ ПОЛЕ ТЕМЫ — ошибка сборки, а не тишина. Опечатка в
   *     имени токена («mainClickerImage» вместо «image») молча
   *     игнорируется CSS и JS, и в прод уходит ПРОШЛЫЙ бренд, выглядящий
   *     свежим. Ловит проверка консистентности тем в .smoke-test.cjs [9].
   *  4. ЦВЕТА — ТОКЕНЫ, а не кусок CSS. Строка вида
   *     "radial-gradient(circle, #1a1a2e 0%, ...)" непроверяема: одна опечатка
   *     — и фон исчезает целиком. Здесь — HEX, валидируемый регуляркой.
   *  5. КАРТИНКА МОНЕТЫ — необязательный ЛОКАЛЬНЫЙ ассет с гарантированным
   *     откатом на глиф. Дальний URL (placehold.co и т. п.) стал бы первой
   *     внешней зависимостью проекта: 404, блокировка или офлайн превращают
   *     главную кнопку в битую иконку. .visual-check.cjs считает любой
   *     HTTP >= 400 и requestfailed падением — то есть такой конфиг упал бы
   *     ещё до релиза.
   *  6. ТЕКСТА РЕПОСТА В PAYLOAD VK НЕТ. Контракт VKWebAppShare — только
   *     { link } (см. share() в vk-integration.js). Вирусный текст живёт в
   *     UI, а не в звонке моста: переданное «shareTitle» стало бы мёртвым
   *     полем — тот же баг, что уже нашли в этой механике однажды.
   *
   * Валюта указана в одном падеже (родительный множественный): все строки
   * с ней стоят после числа — «+1000 монет», «5 монет/сек», «Не хватает 50
   * монет». Появится «Ваш баланс: 1 монета» — понадобится склонение.
   * ==================================================================== */
  /* ★ Порядок объявления ВАЖЕН: fmt()/groupInt() вызываются синхронно при
     применении темы (ниже в этом разделе), то есть ДО инициализации раздела 4
     «Форматирование чисел и времени». const в TDZ не читается — и bindCopy
     падал бы с ReferenceError на каждой загрузке страницы. Держим здесь. */
  const THIN = '\u2009';

  const THEMES = {
    /* Дефолт. Его значения обязаны совпадать с :root в style.css: рассинхрон
       (поменяли объект, забыли CSS — или наоборот) ловит проверка в smoke. */
    neon: {
      cur: 'монет', curIcon: '🪙',
      accent: '#00e5ff', accent2: '#ff2bd6',
      bgTop: '#12122a', bg: '#06060d',
      glyph: '⚡', image: '',
      ranks: null,
      copy: {
        logo: 'NEON CLICK',
        hint: 'Жми по монете. Держи серию — лови крит.',
        tapNudge: 'Жми по монете!',
        adDouble: 'Удвоить пассивный доход',
        adDoubleSub: '×2 к авто-майнингу на 5 минут',
        adCoins: 'Получить +{adReward} {cur}',
        adCoinsSub: 'Разовая награда за просмотр',
        adShare: 'Поделись игрой с другом',
        adShareSub: '+{shareReward} {cur} за репост',
        adNote: 'Награда выдаётся после просмотра видеоролика. Реклама — сервис VK.'
      }
    },

    /* Образец ребрендинга: движок, сейвы, облако и контракты VK — те же,
       продукт — другой. Именно это и значит «одна строка». */
    meme: {
      cur: 'мемокоинов', curIcon: '🐸',
      accent: '#00ffcc', accent2: '#ffd93d',
      bgTop: '#1a1a2e', bg: '#0f0c1b',
      glyph: '🐸', image: '',
      ranks: ['Дурак', 'Кликер', 'Мемолог', 'Амити', 'В тренде',
        'Популярный', 'Чел', 'Кит', 'Легенда', 'Бог мема'],
      copy: {
        logo: 'МЕМ-КЛИКЕР 2026',
        hint: 'Жми на лягушку. Держи серию — лови крит.',
        tapNudge: 'Жми на лягушку!',
        adDouble: 'Удвоить пассив мемов',
        adDoubleSub: '×2 к авто-майнингу на 5 минут',
        adCoins: 'Закинь +{adReward} {cur}',
        adCoinsSub: 'Разовая награда за просмотр',
        adShare: 'Скинь другу — пусть позавидует',
        adShareSub: '+{shareReward} {cur} за репост',
        adNote: 'Награда выдаётся после просмотра видеоролика. Реклама — сервис VK.'
      }
    },

    /* Второй образец: та же механика под другой инфоповод. Показано, что меняются
       только палитра, глиф, валюта и ранги — ни одной строчки в движке. */
    sat: {
      cur: 'сатоши', curIcon: '🪙',
      accent: '#f7931a', accent2: '#ffd166',
      bgTop: '#1b1b26', bg: '#0b0b10',
      glyph: '₿', image: '',
      ranks: ['Гость', 'Холдер', 'Копатель', 'Трейдер', 'Кит',
        'Акула', 'Майнер', 'Инвестор', 'Легенда', 'Бог рынка'],
      copy: {
        logo: 'САТОШИ КЛИКЕР',
        hint: 'Копи сатоши. Держи серию — лови крит.',
        tapNudge: 'Копи сатоши!',
        adDouble: 'Удвоить майнинг-пул',
        adDoubleSub: '×2 к авто-майнингу на 5 минут',
        adCoins: 'Начислить +{adReward} {cur}',
        adCoinsSub: 'Разовая награда за просмотр',
        adShare: 'Позови друга в пул',
        adShareSub: '+{shareReward} {cur} за репост',
        adNote: 'Награда выдаётся после просмотра видеоролика. Реклама — сервис VK.'
      }
    }
  };

  /* ★ ЕДИНСТВЕННАЯ СТРОКА, которую правят при ребрендинге.
     Предпросмотр без пересборки: ?theme=meme. Сквозь обёртку VK тема едет так же
     — см. THEME_FROM_URL ниже (location.search → location_search → hash). */
  const THEME_ID = 'neon';

  /* Схема темы: всё вне этого списка — опечатка в имени токена (ловушка 3).
     Поле ОБЯЗАНО быть у каждой темы: «не задано» тоже ошибка, иначе новая
     тема выйдет с половину интерфейса на прошлом бренде. */
  const THEME_FIELDS = ['cur', 'curIcon', 'accent', 'accent2', 'bgTop', 'bg', 'glyph', 'image', 'ranks', 'copy'];
  const THEME_COPY_KEYS = ['logo', 'hint', 'tapNudge', 'adDouble', 'adDoubleSub', 'adCoins', 'adCoinsSub', 'adShare', 'adShareSub', 'adNote'];

  let activeTheme = THEME_ID;

  /** Текущая тема. Всегда осмысленный объект: applyTheme уже отфильтровал мусор. */
  const TM = () => THEMES[activeTheme] || THEMES.neon;

  /** Подстановка токенов в тексты. Числа НЕ дублируются в разметке (см. {adReward}). */
  function tpl(s) {
    return String(s)
      .replace(/\{cur\}/g, TM().cur)
      .replace(/\{adReward\}/g, fmt(CFG.freeCoinsReward))
      .replace(/\{shareReward\}/g, fmt(CFG.share.reward));
  }

  /**
   * Диагностика сборки тем: неизвестные поля и ключи, пропуски полей,
   * пустые тексты, не-HEX цвета, рассинхрон длины списка рангов.
   * Пустой массив = темы консистентны. Вызывается из .smoke-test.cjs.
   */
  function themeIssues() {
    const bad = [];
    Object.keys(THEMES).forEach((id) => {
      const t = THEMES[id];
      Object.keys(t).forEach((k) => {
        if (THEME_FIELDS.indexOf(k) < 0) bad.push(id + ': неизвестное поле "' + k + '" (опечатка → токен молча не применится)');
      });
      THEME_FIELDS.forEach((k) => { if (!(k in t)) bad.push(id + ': отсутствует поле "' + k + '"'); });
      Object.keys(t.copy || {}).forEach((k) => {
        if (THEME_COPY_KEYS.indexOf(k) < 0) bad.push(id + ': неизвестный ключ copy."' + k + '"');
      });
      THEME_COPY_KEYS.forEach((k) => {
        const v = t.copy && t.copy[k];
        if (typeof v !== 'string' || !v.trim()) bad.push(id + '.copy.' + k + ': пустой или не строка');
      });
      ['accent', 'accent2', 'bgTop', 'bg'].forEach((k) => {
        if (!/^#[0-9a-fA-F]{3,8}$/.test(String(t[k]))) bad.push(id + '.' + k + ': не HEX-цвет → ' + t[k]);
      });
      if (t.ranks && t.ranks.length !== RANKS.length) {
        bad.push(id + '.ranks: ' + t.ranks.length + ' имён против ' + RANKS.length + ' ступеней RANKS');
      }
    });
    if (!THEMES[THEME_ID]) bad.push('THEME_ID="' + THEME_ID + '" — такой темы нет в реестре');
    return bad;
  }

  /** Палитра темы -> CSS-переменные. <html> существует всегда (скрипт в конце body). */
  function paintTokens() {
    const t = TM(), r = document.documentElement;
    r.setAttribute('data-theme', activeTheme);
    r.style.setProperty('--cyan', t.accent);
    r.style.setProperty('--magenta', t.accent2);
    r.style.setProperty('--bg-top', t.bgTop);
    r.style.setProperty('--bg', t.bg);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t.bg);   // системная панель VK/мобилы
  }

  /**
   * Картинка монеты: показываем ТОЛЬКО успешно загрузившуюся.
   * Пока грузится, при 404, блокировке или офлайне остаётся глиф — главная
   * кнопка физически не может стать битой иконкой.
   */
  function mountCoinArt() {
    const t = TM();
    const body = document.getElementById('coinBody'), face = document.getElementById('coinFace');
    if (!body || !face) return;
    const stale = body.querySelector('.coin__img');
    if (stale) stale.remove();
    face.hidden = false;
    if (!t.image) return;                            // тема на глифе — штатный путь
    const img = new Image();
    img.className = 'coin__img';
    img.alt = '';
    img.draggable = false;
    img.onload = () => { if (TM() === t) { face.hidden = true; body.insertBefore(img, face); } };
    img.onerror = () => { if (img.parentNode) img.remove(); face.hidden = false; };
    img.src = t.image;
  }

  /** Тексты, валюта, глиф, <title>. Требует распарсенного body. */
  function bindCopy() {
    const t = TM();
    document.querySelectorAll('[data-t]').forEach((n) => {
      const v = t.copy[n.getAttribute('data-t')];
      if (typeof v === 'string' && v.trim()) n.textContent = tpl(v);
      /* нет ключа — молча оставляем встроенный в разметку текст: кривая тема
         не должна оголять интерфейс. Полноту проверяет themeIssues(). */
    });
    document.querySelectorAll('[data-curicon]').forEach((n) => { n.textContent = t.curIcon; });
    const cap = document.getElementById('balCap');
    if (cap) cap.textContent = t.cur;
    const logo = document.getElementById('logoTxt');
    if (logo) logo.textContent = t.copy.logo;
    document.title = t.copy.logo;
    /* Описание тоже следует за брендом: иначе после ребрендинга каталог VK
       читал бы «NEON CLICK — неоновый кликер» над мемом. Шаблон собран из
       уже существующих токенов — новых полей конфига не заводим. */
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', 'Мини-игра VK: ' + t.copy.logo + '. ' + t.copy.hint);
    const face = document.getElementById('coinFace');
    if (face) face.textContent = t.glyph;
    mountCoinArt();
  }

  /** Переключение темы целиком. Неизвестное имя = предупреждение + откат на
   *  выбранное, но ОТРИСОВКА ПРОИСХОДИТ ВСЕГДА: тема не имеет права оставить
   *  страницу без палитры и текстов (проверка 9.5 в .smoke-test.cjs). */
  function applyTheme(id) {
    let known = true;
    if (!id) id = THEME_ID;
    if (THEMES[id]) {
      activeTheme = id;
    } else {
      known = false;
      console.warn('[theme] неизвестная тема "' + id + '" — остаётся ' + activeTheme);
    }
    try {
      paintTokens();
      bindCopy();
      return known;
    } catch (e) {
      // Тема — оформление. Она НЕ имеет права уронить игру: остаёмся на том,
      // что уже нарисовано, и громко пишем в консоль.
      console.error('[theme] применение не удалось', e);
      return false;
    }
  }

  /* Мгновенный предпросмотр и проброс ребрендинга по ?theme= — без пересборки
     и без правки THEME_ID.

     ЛОВУШКА, закрытая здесь: в клиенте VK страница живёт в iframe, чей URL
     собирает сам VK из адреса размещения (наши launch-параметры). Поэтому
     «https://vk.com/app…?theme=meme» из паблика НЕ обязано доехать до
     location.search iframe'а: VK переносит query приложения в параметр
     location_search. Читать только location.search — значит тихо отдать всей
     мем-аудитории базовую витрину. Тихо потому, что ошибки не будет: просто
     другой бренд, а в метриках это выглядит как «ссылка конвертит хуже».
     Отсюда порядок источников:
       1) location.search  — прямой адрес хостинга и локальный стенд;
       2) location_search  — как VK заворачивает query приложения в iframe;
       3) location.hash    — QR и размещения, кладущие параметры в хэш.
     Тема — только витрина: баланс, ключи сейвов и payload моста от неё не
     зависят (инвариант №1: .smoke-test.cjs [9], .vk-mock-check.cjs [7b]/[7c]). */
  const THEME_FROM_URL = (function () {
    function pick(raw) {
      if (!raw) return null;
      try {
        // '#/?theme=meme' → '?theme=meme'; ведущий '?' URLSearchParams снимает сам
        const v = new URLSearchParams(String(raw).replace(/^[#\/]+/, '')).get('theme');
        return v && /^[a-z0-9_-]{1,32}$/i.test(v) ? v : null;
      } catch (_) { return null; }
    }
    try {
      const own = pick(location.search);
      const wrapped = pick(new URLSearchParams(location.search).get('location_search'));
      const hashed = pick(location.hash);
      return own || wrapped || hashed;
    } catch (_) { return null; }   // location недоступен — остаёмся на THEME_ID
  })();

  // ★ СИНХРОННО, до boot() и до первого пейнта (ловушка 2).
  applyTheme(THEME_FROM_URL || THEME_ID);

  /* ======================================================================
   * 2. DOM
   * ==================================================================== */
  const $ = (id) => document.getElementById(id);
  const el = {
    balance: $('balance'), perClick: $('perClick'), perSecond: $('perSecond'),
    boost: $('boost'), boostTime: $('boostTime'), boostBar: $('boostBar'),
    rankName: $('rankName'), rankHint: $('rankHint'), rankBar: $('rankBar'),
    stage: $('stage'), canvas: $('fx'), floats: $('floats'), coin: $('coin'),
    combo: $('combo'), comboX: $('comboX'),
    tabShop: $('tabShop'), tabBonus: $('tabBonus'), tabGuild: $('tabGuild'),
    bonusDot: $('bonusDot'), panel: $('panel'),
    cardClick: $('cardClick'), clickEffect: $('clickEffect'), clickLevel: $('clickLevel'),
    buyClick: $('buyClick'), clickCost: $('clickCost'),
    cardAuto: $('cardAuto'), autoEffect: $('autoEffect'), autoLevel: $('autoLevel'),
    buyAuto: $('buyAuto'), autoCost: $('autoCost'),
    statTotal: $('statTotal'), statClicks: $('statClicks'), statUpgrades: $('statUpgrades'),
    btnDouble: $('btnDouble'), doubleCta: $('doubleCta'),
    btnCoins: $('btnCoins'), coinsCta: $('coinsCta'), adNote: $('adNote'),
    btnShare: $('btnShare'), shareCta: $('shareCta'), shareNote: $('shareNote'),
    // --- Соло «Ва-банк» (раздел 13c) ---
    riskCard: $('riskCard'), riskChips: $('riskChips'), riskAmount: $('riskAmount'),
    riskQuota: $('riskQuota'), riskNote: $('riskNote'), btnRisk: $('btnRisk'), riskCta: $('riskCta'),
    // --- Гильдия и недельный рейд (раздел 13d) ---
    guildCard: $('guildCard'), guildName: $('guildName'), guildTag: $('guildTag'),
    guildPhoto: $('guildPhoto'), guildRole: $('guildRole'), guildState: $('guildState'),
    guildMult: $('guildMult'), guildHint: $('guildHint'), guildPicker: $('guildPicker'),
    btnGuildJoin: $('btnGuildJoin'), btnGuildLeave: $('btnGuildLeave'),
    raidCard: $('raidCard'), raidEarned: $('raidEarned'), raidPending: $('raidPending'),
    raidBar: $('raidBar'), raidPer: $('raidPer'), raidWeek: $('raidWeek'),
    raidHonor: $('raidHonor'), raidLife: $('raidLife'), raidBest: $('raidBest'),
    raidTries: $('raidTries'), raidTier: $('raidTier'), raidTierHint: $('raidTierHint'),
    raidTierBar: $('raidTierBar'), raidQuota: $('raidQuota'),
    btnRaidRedeem: $('btnRaidRedeem'), raidRedeemCta: $('raidRedeemCta'), raidNote: $('raidNote'),
    modal: $('modal'), modalTitle: $('modalTitle'), modalText: $('modalText'),
    modalOk: $('modalOk'), modalCancel: $('modalCancel'),
    btnSound: $('btnSound'), btnReset: $('btnReset'), toasts: $('toasts'),
    cloudDot: $('cloudDot')
  };

  /* ======================================================================
   * 2b. РЕЖИМ ОТЛАДКИ
   * ==================================================================== */

  // >>> RELEASE-STRIP DEBUG_BEGIN
  /**
   * ?debug=1 — режим отладки. Только в нём в окне появляется хук window.NEON
   * (см. конец файла) и только он позволяет «нарисовать» монеты из консоли.
   * Весь этот регион сборка боевого артефакта вырезает целиком
   * (tools/build-release.cjs), поэтому в опубликованном файле от отладки остаётся
   * одна строка `const DEBUG = false;` — и ни имени параметра, ни упоминания хука.
   */
  const DEBUG = (function () {
    try { return new URLSearchParams(location.search).has('debug'); } catch (_) { return false; }
  })();
  // <<< RELEASE-STRIP DEBUG_END

  /* ======================================================================
   * 3. СОСТОЯНИЕ ИГРЫ
   * ==================================================================== */
  /**
   * Версия СХЕМЫ ДАННЫХ. Одно место, которым живут и defaultState(), и
   * mergeCloud(): номер схемы, записанный в сейв/пакет, всегда должен быть
   * номером ТЕКУЩЕГО записывателя, а не приехавшим из старого облачного пакета.
   */
  const SCHEMA_V = 4;

  function defaultState() {
    return {
      // v:4 — схема добавила поля гильдии и недельного рейда (см. раздел 13d).
      // Сейвы и облачные пакеты v1, v2 и v3 читаются по-прежнему:
      // см. load(), unpackCloud().
      v: SCHEMA_V,
      coins: 0,          // текущий баланс (внутри дробный — из-за пассивного дохода)
      total: 0,          // всего заработано (для рангов)
      clicks: 0,
      upClick: 0,        // уровень апгрейда «Сила клика»
      upAuto: 0,         // уровень апгрейда «Авто-майнинг»
      boostUntil: 0,     // timestamp окончания буста x2
      watched: 0,        // сколько раз посмотрел рекламу
      shares: 0,         // всего засчитанных репостов (монотонный, входит в потолок правдоподобия)
      shareDay: 0,       // индекс суток UTC последнего засчитанного репоста
      shareN: 0,         // сколько репостов засчитано в эти сутки (лимитер CFG.share.perDay)
      // --- СОЛО «ВА-БАНК» (раздел 13c). Первые пять — статистика и лимитер,
      //     последние три — write-ahead незакрытого раунда. ---
      riskDay: 0,        // индекс суток UTC последнего раунда
      riskN: 0,          // сколько раундов сыграно в эти сутки (лимитер CFG.risk.perDay)
      riskWins: 0,       // монотонный: побед
      riskLoss: 0,       // монотонный: поражений
      riskBurned: 0,     // монотонный: СГОРЕЛО монет всего — метрика стока, инвариант <= total
      rpStake: 0,        // write-ahead: ставка незакрытого раунда (0 = раунда нет)
      rpWon: 0,          // write-ahead: исход уже сыгранного, но не показанного раунда (0|1)
      rpIdx: 0,          // write-ahead: индекс доли ставки — чтобы после рестарта выдать правильный приз
      // --- ГИЛЬДИЯ И НЕДЕЛЬНЫЙ РЕЙД (раздел 13d). Первые два — идентичность,
      //     rdWeek/rdEarned — журнал ТЕКУЩЕЙ недели (не монотонный), следующие
      //     четыре — пожизненные итоги, последние два — лимитер обмена чести. ---
      gid: 0,            // id сообщества-гильдии; 0 = игрок вне гильдии
      gState: 0,         // 0 не проверено | 1 участник | 2 не участник (авторитет — VK, не сейв)
      rdWeek: 0,         // индекс календарной недели UTC журнала (0 = ещё не заведён)
      rdEarned: 0,       // подтверждённый заработок ЭТОЙ недели — единственный источник чести
      rdHonor: 0,        // текущий остаток чести (тратится на время буста)
      rdBest: 0,         // монотонный: лучшая недельная выплата чести
      rdTries: 0,        // монотонный: сколько недель закрыто
      rdLife: 0,         // монотонный: всего чести заработано за всё время (по нему — звание)
      rdRedeemed: 0,     // индекс суток UTC последнего обмена чести
      rdRedN: 0,         // сколько обменов в эти сутки (лимитер CFG.raid.perDay)
      sound: true,
      t0: Date.now(),    // момент первого запуска — база для потолка правдоподобия
      susp: 0,           // число исправленных аномалий (тихий флаг античита)
      sig: '',           // подпись сейва (раздел 15)
      lastSeen: Date.now()
    };
  }
  let S = defaultState();

  let dirty = true;          // есть несохранённые изменения
  let comboStack = 0;        // текущая серия кликов
  let lastClickAt = 0;
  let adBusy = false;        // идёт показ рекламы
  const adLastShown = { boost: 0, coins: 0, share: 0 };

  /* ======================================================================
   * 4. ФОРМАТИРОВАНИЕ ЧИСЕЛ И ВРЕМЕНИ
   * ==================================================================== */
  /* THIN объявлен в разделе 1b: форматёр вызывается синхронно при применении
     темы, раньше этой строки. Не переносите его обратно — будет TDZ на каждой
     загрузке страницы (ловит проверка «ошибок страницы нет» в .stress-check). */

  function groupInt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
  }

  /** 999 -> "999", 12500 -> "12 500", 125400 -> "125,4 тыс", 3,2 млн и т.д. */
  function fmt(value) {
    const n = Math.floor(value);
    if (n < 1e5) return groupInt(n);
    const units = [[1e12, ' трлн'], [1e9, ' млрд'], [1e6, ' млн'], [1e3, ' тыс']];
    for (let i = 0; i < units.length; i++) {
      const d = units[i][0];
      if (n >= d) {
        const x = n / d;
        let s = x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace('.', ',');
        if (/,0$/.test(s)) s = s.slice(0, -2);
        return s + units[i][1];
      }
    }
    return groupInt(n);
  }

  /** Миллисекунды -> "MM:SS". */
  function fmtClock(ms) {
    const t = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(t / 60), s = t % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  /** Человекочитаемое время: "12 сек", "4 мин", "1 ч 12 мин". */
  function fmtDur(ms) {
    const sec = Math.round(ms / 1000);
    if (sec < 60) return sec + ' сек';
    const min = Math.round(sec / 60);
    if (min < 60) return min + ' мин';
    const h = Math.floor(min / 60);
    return h + ' ч ' + (min % 60) + ' мин';
  }
  /* ======================================================================
   * 5. СОХРАНЕНИЕ ПРОГРЕССА (LocalStorage)
   * ==================================================================== */

  /** Пишем в LocalStorage только когда данные реально изменились. */
  function save(force) {
    if (!dirty && !force) return;
    S.lastSeen = Date.now();
    S.sig = signatureOf(S);                 // ← ловит ручную правку сейва
    try {
      localStorage.setItem(CFG.saveKey, JSON.stringify(S));
      dirty = false;
      if (cloud.on) cloud.pending = true;   // есть что отправить в облако VK
    } catch (err) {
      console.warn('[save] не удалось сохранить:', err);
    }
  }

  /** Читает и валидирует сейв. Возвращает true, если данные нашлись. */
  function load() {
    let raw = null;
    try { raw = localStorage.getItem(CFG.saveKey); } catch (_) { return false; }
    if (!raw) return false;
    try {
      const d = JSON.parse(raw);
      if (!d || typeof d !== 'object') return false;
      const num = (v, def) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : def);
      S = defaultState();
      S.coins = num(d.coins, 0);
      S.total = num(d.total, 0);
      S.clicks = Math.floor(num(d.clicks, 0));
      S.upClick = Math.floor(num(d.upClick, 0));
      S.upAuto = Math.floor(num(d.upAuto, 0));
      S.boostUntil = num(d.boostUntil, 0);
      S.watched = Math.floor(num(d.watched, 0));
      // Сейвы v1 полей репоста не содержат: num() подставит 0, миграция мягкая.
      S.shares = Math.floor(num(d.shares, 0));
      S.shareDay = Math.floor(num(d.shareDay, 0));
      S.shareN = Math.floor(num(d.shareN, 0));
      // Сейвы v2 и старше полей риск-раунда не содержат: num() подставит 0,
      // миграция мягкая. Поле v (версия схемы) отсюда НЕ читается — оно нужно
      // только signatureOf()/unpackCloud(), чтобы понять, какие поля подписывать.
      S.riskDay = Math.floor(num(d.riskDay, 0));
      S.riskN = Math.floor(num(d.riskN, 0));
      S.riskWins = Math.floor(num(d.riskWins, 0));
      S.riskLoss = Math.floor(num(d.riskLoss, 0));
      S.riskBurned = num(d.riskBurned, 0);
      S.rpStake = num(d.rpStake, 0);
      S.rpWon = Math.floor(num(d.rpWon, 0));
      S.rpIdx = Math.floor(num(d.rpIdx, 0));
      // Сейвы v3 и старше полей гильдии/рейда не содержат: num() подставит 0,
      // миграция мягкая — ровно тот же приём, что у риск-раунда в v3.
      S.gid = Math.floor(num(d.gid, 0));
      S.gState = Math.floor(num(d.gState, 0));
      S.rdWeek = Math.floor(num(d.rdWeek, 0));
      S.rdEarned = num(d.rdEarned, 0);
      S.rdHonor = num(d.rdHonor, 0);
      S.rdBest = num(d.rdBest, 0);
      S.rdTries = Math.floor(num(d.rdTries, 0));
      S.rdLife = num(d.rdLife, 0);
      S.rdRedeemed = Math.floor(num(d.rdRedeemed, 0));
      S.rdRedN = Math.floor(num(d.rdRedN, 0));
      S.sound = d.sound !== false;
      S.lastSeen = num(d.lastSeen, Date.now());
      S.t0 = num(d.t0, 0);
      S.susp = Math.floor(num(d.susp, 0));
      S.sig = typeof d.sig === 'string' ? d.sig : '';

      // Подпись сверяем по «сырым» значениям до приведения: именно они были
      // подписаны в save(). Сейвы старых версий подписи не имеют — не наказываем.
      if (S.sig !== '' && S.sig !== signatureOf(d)) S.susp++;

      S.susp += sanitize(S);            // ★ античит: границы правдоподобия (t0 правит тоже он)
      return true;
    } catch (_) {
      return false;
    }
  }

  function wipe() {
    try { localStorage.removeItem(CFG.saveKey); } catch (_) {}
    S = defaultState();
    comboStack = 0;
    dirty = true;
  }

  /* ======================================================================
   * 6. ЭКОНОМИКА
   * ==================================================================== */

  const isBoostActive = () => S.boostUntil > Date.now();

  /** Сила клика: базовое значение + уровень апгрейда «Сила клика». */
  function clickPower() {
    return CFG.click.base + S.upClick * CFG.click.perLevel;
  }

  /** Множитель серии кликов (комбо): до +50% к силе клика. */
  function comboMult() {
    return 1 + Math.min(comboStack, CFG.combo.maxStack) * CFG.combo.perStackBonus;
  }

  /** Пассивный доход в секунду с учётом буста x2 за рекламу. */
  function passiveRate() {
    const base = S.upAuto * CFG.auto.perLevel;
    return base * (isBoostActive() ? CFG.boost.mult : 1);
  }

  /** Цена следующего уровня апгрейда: экспоненциальный рост. */
  function costOf(kind) {
    const isClick = kind === 'click';
    const c = isClick ? CFG.click : CFG.auto;
    const level = isClick ? S.upClick : S.upAuto;
    return Math.ceil(c.costBase * Math.pow(c.costGrowth, level));
  }

  /** Начисление монет. Единственная точка, через которую приходит валюта. */
  function earn(amount) {
    const a = Number(amount);
    if (!isFinite(a) || a <= 0) return;
    const add = Math.min(a, CFG.anticheat.maxSingleEarn);   // потолок разового начисления
    S.coins += add;
    S.total += add;
    // ★ РЕЙД (раздел 13d): журнал недели растёт ИЗ ЭТОГО ЖЕ крана, а не рядом с
    //   ним. Берётся уже урезанное add, поэтому начисление, отброшенное потолком
    //   maxSingleEarn, чести не даёт — и правдоподобная накрутка, срезанная
    //   plausibleCap() при загрузке, режет и честь. Новый источник валюты при
    //   этом НЕ появляется: честь монетой не является (инвариант 1 раздела 13d).
    S.rdEarned += add;
    dirty = true;
  }

  /** Начисление «ручной» награды (например, за просмотр рекламы). */
  function grant(amount, reason) {
    earn(amount);
    if (window.VK && VK.haptic) VK.haptic('success');
    console.info('[reward] +' + fmt(amount) + ' (' + reason + ')');
  }

  /* ======================================================================
   * 7. ЗВУК (WebAudio, без внешних файлов)
   * ==================================================================== */
  let actx = null;

  function audio() {
    if (!S.sound) return null;
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      return actx;
    } catch (_) { return null; }
  }

  /** Короткий неоновый «блип»: частота растёт вместе с комбо. */
  function blip(freq, dur, type, vol) {
    const ctx = audio();
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type || 'triangle';
    o.frequency.setValueAtTime(freq, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.6), ctx.currentTime + dur);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(vol || 0.08, ctx.currentTime + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + dur + 0.02);
  }

  const sfx = {
    click: (stack) => blip(420 + Math.min(stack, 30) * 14, 0.07, 'triangle', 0.05),
    crit: () => { blip(880, 0.1, 'square', 0.07); setTimeout(() => blip(1320, 0.12, 'square', 0.05), 60); },
    buy: () => { blip(520, 0.08, 'sine', 0.07); setTimeout(() => blip(780, 0.12, 'sine', 0.06), 70); },
    reward: () => [0, 90, 180, 300].forEach((d, i) => setTimeout(() => blip(520 + i * 160, 0.14, 'triangle', 0.07), d)),
    deny: () => blip(180, 0.14, 'sawtooth', 0.05)
  };
  /* ======================================================================
   * 8. ВИЗУАЛЬНЫЕ ЭФФЕКТЫ
   * ==================================================================== */

  /* --- Всплывающий текст «+N» из точки клика (координаты внутри сцены) ---
   * Узлы ПЕРЕИСПОЛЬЗУЮТСЯ: под быстрым спамом создание тысячи span'ов
   * приводило к утечке — снятый с слоя узел всё ещё держал слушатель
   * animationend, а на отсоединённом элементе анимация не срабатывает, поэтому
   * узел никогда не освобождался. Теперь слушатель ОДИН на весь слой (делегирование),
   * а число узлов жёстко ограничено пулом. */
  const floatPool = [];

  function recycleFloat(node) {
    if (!node || node.__pooled) return;
    if (node.parentNode) node.parentNode.removeChild(node);
    node.__pooled = true;
    if (floatPool.length < CFG.maxFloats) floatPool.push(node);
  }

  function floatText(x, y, text, mod) {
    const layer = el.floats;
    while (layer.childElementCount >= CFG.maxFloats) recycleFloat(layer.firstElementChild);
    const node = floatPool.pop() || document.createElement('span');
    node.__pooled = false;
    node.className = 'float' + (mod ? ' float--' + mod : '');
    node.textContent = text;
    node.style.left = x + 'px';
    node.style.top = y + 'px';
    layer.appendChild(node);
  }

  /* --- Частицы на Canvas --- */
  const fx = { ctx: null, w: 0, h: 0, dpr: 1, parts: [], raf: 0, last: 0 };

  function resizeFx() {
    const r = el.stage.getBoundingClientRect();
    fx.dpr = Math.min(window.devicePixelRatio || 1, 2);
    fx.w = Math.max(1, Math.round(r.width));
    fx.h = Math.max(1, Math.round(r.height));
    el.canvas.width = Math.round(fx.w * fx.dpr);
    el.canvas.height = Math.round(fx.h * fx.dpr);
    try {
      fx.ctx = el.canvas.getContext('2d');
      if (fx.ctx) fx.ctx.setTransform(fx.dpr, 0, 0, fx.dpr, 0, 0);
    } catch (_) {
      fx.ctx = null;   // если canvas недоступен — игра работает без частиц
    }
  }

  /** Взрыв искр в точке клика. */
  function burst(x, y, count, palette, power) {
    if (!fx.ctx) return;
    const n = Math.min(count, Math.max(0, CFG.maxParticles - fx.parts.length));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.6 + Math.random() * 1.6) * (power || 1);
      fx.parts.push({
        x: x, y: y,
        vx: Math.cos(a) * sp * 60,
        vy: Math.sin(a) * sp * 60 - 40,
        life: 0,
        ttl: 0.45 + Math.random() * 0.45,
        r: 1.5 + Math.random() * 2.6,
        c: palette[(Math.random() * palette.length) | 0]
      });
    }
    startFx();
  }

  const PAL_GOLD = ['#ffd66b', '#ffc94d', '#fff3c4', '#ff9f1c'];
  const PAL_CRIT = ['#ff2bd6', '#ff8ae8', '#00e5ff', '#ffffff'];

  /** rAF-цикл живёт только пока есть частицы — экономит батарею телефона. */
  function startFx() {
    if (fx.raf) return;
    fx.last = performance.now();
    fx.raf = requestAnimationFrame(stepFx);
  }

  function stepFx(now) {
    const dt = Math.min(0.05, (now - fx.last) / 1000);
    fx.last = now;
    const ctx = fx.ctx;
    ctx.clearRect(0, 0, fx.w, fx.h);
    ctx.globalCompositeOperation = 'lighter';

    for (let i = fx.parts.length - 1; i >= 0; i--) {
      const p = fx.parts[i];
      p.life += dt;
      if (p.life >= p.ttl) { fx.parts.splice(i, 1); continue; }
      p.vy += 260 * dt;               // гравитация
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = 1 - p.life / p.ttl;   // затухание
      ctx.globalAlpha = k;
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * k + 0.4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (fx.parts.length) fx.raf = requestAnimationFrame(stepFx);
    else { fx.raf = 0; ctx.clearRect(0, 0, fx.w, fx.h); }
  }

  /* ---------- Тосты (всплывающие уведомления) ---------- */
  function toast(text, kind, ms) {
    const node = document.createElement('div');
    node.className = 'toast' + (kind ? ' toast--' + kind : '');
    node.textContent = text;
    el.toasts.appendChild(node);
    while (el.toasts.childElementCount > 3) el.toasts.removeChild(el.toasts.firstChild);
    setTimeout(() => {
      node.classList.add('is-out');
      node.addEventListener('animationend', () => node.remove(), { once: true });
    }, ms || 3200);
    return node;
  }
  /* ======================================================================
   * 9. РЕНДЕР ИНТЕРФЕЙСА
   * ==================================================================== */

  /** Обновляет текст узла только при реальном изменении — меньше перерисовок. */
  const textCache = new WeakMap();
  function setText(node, value) {
    if (!node) return;
    const v = String(value);
    if (textCache.get(node) !== v) {
      textCache.set(node, v);
      node.textContent = v;
    }
  }

  /** Имя ранга с учётом переименования в теме (ranks: null → базовый список). */
  function rankNameAt(i) {
    const ov = TM().ranks;
    return (ov && ov[i]) || RANKS[i][1];
  }

  /** Текущий ранг игрока и прогресс до следующего. */
  function rankInfo() {
    let idx = 0;
    for (let i = 0; i < RANKS.length; i++) if (S.total >= RANKS[i][0]) idx = i;
    const cur = RANKS[idx];
    const next = RANKS[idx + 1] || null;
    if (!next) return { name: rankNameAt(idx), hint: 'максимальный ранг', progress: 1 };
    const span = next[0] - cur[0];
    const done = S.total - cur[0];
    return {
      name: rankNameAt(idx),
      hint: 'до «' + rankNameAt(idx + 1) + '»: ' + fmt(Math.max(0, next[0] - S.total)),
      progress: span > 0 ? Math.max(0, Math.min(1, done / span)) : 0
    };
  }

  let prevRankName = '';

  /** Полное обновление HUD. Вызывается тиком (5 раз/сек) и по событиям. */
  function render() {
    const coins = Math.floor(S.coins);

    setText(el.balance, fmt(coins));
    setText(el.perClick, '+' + fmt(Math.floor(clickPower() * comboMult())));
    setText(el.perSecond, '+' + fmt(passiveRate()));

    /* --- Магазин --- */
    const cClick = costOf('click');
    const cAuto = costOf('auto');
    setText(el.clickCost, fmt(cClick));
    setText(el.autoCost, fmt(cAuto));
    setText(el.clickLevel, 'Ур. ' + S.upClick);
    setText(el.autoLevel, 'Ур. ' + S.upAuto);
    setText(el.clickEffect, '+' + CFG.click.perLevel);
    setText(el.autoEffect, '+' + CFG.auto.perLevel);
    el.buyClick.disabled = coins < cClick;
    el.buyAuto.disabled = coins < cAuto;
    el.cardClick.classList.toggle('is-affordable', coins >= cClick);
    el.cardAuto.classList.toggle('is-affordable', coins >= cAuto);

    /* --- Статистика --- */
    setText(el.statTotal, fmt(S.total));
    setText(el.statClicks, fmt(S.clicks));
    setText(el.statUpgrades, fmt(S.upClick + S.upAuto));

    /* --- Буст x2 за рекламу --- */
    const boostOn = isBoostActive();
    el.boost.hidden = !boostOn;
    if (boostOn) {
      const left = S.boostUntil - Date.now();
      setText(el.boostTime, fmtClock(left));
      el.boostBar.style.transform = 'scaleX(' + Math.max(0, Math.min(1, left / CFG.boost.ms)).toFixed(3) + ')';
    }

    /* --- Ранг --- */
    const r = rankInfo();
    setText(el.rankName, r.name);
    setText(el.rankHint, r.hint);
    el.rankBar.style.width = (r.progress * 100).toFixed(1) + '%';
    if (prevRankName && r.name !== prevRankName) {
      toast('🏆 Новый ранг: ' + r.name + '!', 'good', 3600);
      sfx.reward();
      celebrate();
    }
    prevRankName = r.name;

    /* --- Комбо --- */
    const showCombo = comboStack >= CFG.combo.showFrom;
    el.combo.hidden = !showCombo;
    if (showCombo) setText(el.comboX, '×' + comboMult().toFixed(2));

    // Остаток суточного лимита репостов. Дёшево пересчитываем на каждом рендере
    // (сам DOM трогаем только при смене числа), чтобы карточка обновилась сама
    // на переходе суток — даже если игрок не выходит из приложения.
    renderShareCta();
    renderRiskCta();
    renderRaid();
  }

  /** Салют по всему экрану сцены — для важных моментов. */
  function celebrate() {
    if (!stageRect) measureStage();
    burst(stageRect.width / 2, stageRect.height / 2, 60, PAL_CRIT, 2.2);
  }
  /* ======================================================================
   * 10. КЛИКИ ПО МОНЕТЕ
   * ==================================================================== */

  let stageRect = null;
  function measureStage() { stageRect = el.stage.getBoundingClientRect(); }

  /** Центр сцены — туда летят «наградные» надписи. */
  function stageCenter() {
    if (!stageRect) measureStage();
    return { x: stageRect.width / 2, y: stageRect.height / 2 };
  }

  /**
   * Главное действие игры: тап по монете.
   * +Click Power монет, крит x5, множитель комбо, искры, звук, «+N».
   */
  function handleClick(clientX, clientY) {
    const now = Date.now();

    // Серия кликов: если жмём чаще windowMs — комбо растёт, иначе сбрасывается.
    comboStack = (now - lastClickAt <= CFG.combo.windowMs) ? comboStack + 1 : 1;
    lastClickAt = now;

    const crit = Math.random() < CFG.crit.chance;
    const amount = Math.max(1, Math.floor(clickPower() * comboMult() * (crit ? CFG.crit.mult : 1)));

    // ★ АНТИЧИТ: засчитываем не больше CFG.anticheat.maxClicksPerSec в секунду.
    //   Визуальный отклик остаётся на всех тапах (иначе игрок решит, что игра
    //   сломалась), но монеты и статистика растут только на узаконенных кликах.
    const paid = clickPaid();
    if (paid) {
      earn(amount);
      S.clicks++;
    } else {
      S.susp++;
      dirty = true;
    }

    if (!stageRect) measureStage();
    const x = clientX - stageRect.left;
    const y = clientY - stageRect.top;

    floatText(x, y, (crit ? 'КРИТ +' : '+') + fmt(amount), crit ? 'crit' : null);
    burst(x, y, crit ? 26 : 12, crit ? PAL_CRIT : PAL_GOLD, crit ? 1.7 : 1);

    // Перезапуск CSS-анимации ударной волны
    el.coin.classList.remove('is-hit');
    void el.coin.offsetWidth;
    el.coin.classList.add('is-hit');

    if (paid) {
      if (crit) {
        el.coin.classList.add('is-crit');
        setTimeout(() => el.coin.classList.remove('is-crit'), 260);
        sfx.crit();
        if (window.VK) VK.haptic('success');
      } else {
        sfx.click(comboStack);
      }
    }

    render();
  }

  /** Биндинг монеты: pointerdown (мгновенный отклик) + фолбэк на touch/mouse. */
  function bindCoin() {
    const press = () => el.coin.classList.add('is-press');
    const release = () => el.coin.classList.remove('is-press');

    if ('onpointerdown' in window) {
      el.coin.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        press();
        handleClick(e.clientX, e.clientY);
      }, { passive: false });
    } else {
      // Старые WebView без Pointer Events
      el.coin.addEventListener('touchstart', (e) => {
        e.preventDefault();
        press();
        const t = e.changedTouches[0];
        handleClick(t.clientX, t.clientY);
      }, { passive: false });
      el.coin.addEventListener('mousedown', (e) => {
        e.preventDefault();
        press();
        handleClick(e.clientX, e.clientY);
      });
    }

    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    el.coin.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* ======================================================================
   * 11. МАГАЗИН АПГРЕЙДОВ
   * ==================================================================== */

  /**
   * Покупка уровня апгрейда.
   * @param {'click'|'auto'} kind — «Сила клика» или «Авто-майнинг».
   */
  function buy(kind) {
    const cost = costOf(kind);
    const card = kind === 'click' ? el.cardClick : el.cardAuto;

    if (Math.floor(S.coins) < cost) {
      sfx.deny();
      card.classList.remove('is-deny');
      void card.offsetWidth;
      card.classList.add('is-deny');
      toast('Не хватает ' + fmt(cost - Math.floor(S.coins)) + ' ' + TM().cur, 'warn', 2000);
      return;
    }

    S.coins -= cost;
    if (kind === 'click') S.upClick++; else S.upAuto++;
    dirty = true;

    sfx.buy();
    if (window.VK) VK.haptic('selection');

    card.classList.remove('is-bought');
    void card.offsetWidth;
    card.classList.add('is-bought');

    const c = stageCenter();
    if (kind === 'click') {
      floatText(c.x, c.y - 40, '👆 Сила клика +' + CFG.click.perLevel, null);
    } else {
      floatText(c.x, c.y - 40, TM().curIcon + ' +' + CFG.auto.perLevel + ' ' + TM().cur + '/сек', 'gold');
      burst(c.x, c.y, 22, PAL_GOLD, 1.4);
    }

    render();
    save(true);            // покупку пишем сразу, не дожидаясь следующего тика
    cloudPush(true);       // и сразу же тянем её в облако VK (с троттлингом)
  }

  /* ======================================================================
   * 12. ИГРОВОЙ ТИК, ОФЛАЙН-ДОХОД
   * ==================================================================== */

  let lastTickAt = Date.now();

  /** Начисление пассивного дохода по реальному времени (устойчиво к троттлингу). */
  function tick() {
    const now = Date.now();
    const dt = Math.max(0, (now - lastTickAt) / 1000);
    lastTickAt = now;

    const rate = passiveRate();
    if (rate > 0 && dt > 0) earn(rate * dt);

    // Комбо «протухло», если игрок успокоился
    if (comboStack && now - lastClickAt > CFG.combo.windowMs) comboStack = 0;

    // Переход календарной недели закрывает журнал рейда. Идемпотентно: внутри
    // только при реальном расхождении rdWeek, поэтому на 5 тиках в секунду это
    // дешёвая проверка, а не начисление.
    tickRaid();

    render();
  }

  /** Офлайн-награда: считаем, сколько авто-майнинг принёс, пока игра была закрыта. */
  function applyOfflineEarnings() {
    const elapsed = Date.now() - (S.lastSeen || Date.now());
    if (elapsed < CFG.offline.minMs) return;

    const baseRate = S.upAuto * CFG.auto.perLevel;   // буст в фоне не работает
    if (baseRate <= 0) return;

    const counted = Math.min(elapsed, CFG.offline.capMs);
    const gain = Math.floor(baseRate * (counted / 1000) * CFG.offline.efficiency);
    if (gain <= 0) return;

    earn(gain);
    setTimeout(() => {
      const c = stageCenter();
      floatText(c.x, c.y, '+' + fmt(gain), 'gold');
      burst(c.x, c.y, 30, PAL_GOLD, 1.6);
      toast('💤 Пока тебя не было ' + fmtDur(elapsed) + ', авто-майнинг принёс ' + fmt(gain) + ' ' + TM().cur, 'good', 5200);
      render();
    }, 500);
  }
  /* ======================================================================
   * 13. МОНЕТИЗАЦИЯ ЧЕРЕЗ VK BRIDGE (Reward Video)
   *
   * Весь «сырой» протокол VK живёт в vk-integration.js. Здесь только две
   * точки монетизации:
   *   • el.btnDouble → VK.showRewardedAd('double_income') → ×2 на 5 минут
   *   • el.btnCoins  → VK.showRewardedAd('free_coins')    → +1000 монет
   * ==================================================================== */

  const VKAPI = () => window.VK || null;

  /** Переводит кнопку бонуса в состояние «загрузка/просмотр». */
  function setAdBusy(btn, cta, busy, label) {
    btn.disabled = !!busy;
    cta.classList.toggle('is-busy', !!busy);
    btn.classList.toggle('is-loading', !!busy);
    cta.textContent = label;
  }

  const cooldownLeft = (kind, ms) =>
    Math.max(0, (adLastShown[kind] || 0) + (ms || CFG.adCooldownMs) - Date.now());

  /**
   * Общий сценарий: заблокировать кнопки → показать рекламу VK → вернуть итог.
   * @param {string} scene — идентификатор точки монетизации для логов VK
   * @returns {Promise<{ok:boolean, code:string, message?:string}|null>}
   */
  async function claimReward(scene) {
    const vk = VKAPI();
    if (!vk) {
      sfx.deny();
      toast('Модуль VK Bridge недоступен. Попробуй перезапустить приложение.', 'bad');
      return null;
    }
    if (adBusy) return null;

    adBusy = true;
    setAdBusy(el.btnDouble, el.doubleCta, true, 'Ждём…');
    setAdBusy(el.btnCoins, el.coinsCta, true, 'Ждём…');
    // Кнопку репоста тоже глушим: нативные диалоги VK (видео и шаринг) не
    // должны накладываться друг на друга — второй поверх первого выглядит как
    // зависшее приложение.
    if (el.btnShare) el.btnShare.disabled = true;
    // Кнопка риск-раунда тоже: нативный видео-диалог поверх «бросаем банк»
    // выглядел бы как зависшее приложение.
    if (el.btnRisk) el.btnRisk.disabled = true;

    let res = null;
    try {
      // ★ ЗАПРОС РЕКЛАМЫ: внутри vk-integration.js вызывается
      //   VKWebAppCheckNativeAds + VKWebAppShowNativeAds({ ad_format: 'reward' })
      res = await vk.showRewardedAd(scene);
    } catch (err) {
      console.warn('[ads] сбой показа', err);
      res = { ok: false, code: 'exception', message: 'Не удалось показать рекламу. Попробуй ещё раз.' };
    } finally {
      adBusy = false;
      setAdBusy(el.btnDouble, el.doubleCta, false, 'Реклама');
      setAdBusy(el.btnCoins, el.coinsCta, false, 'Реклама');
      if (el.btnShare) el.btnShare.disabled = false;
      if (el.btnRisk) el.btnRisk.disabled = false;
    }
    return res;
  }

  /** Общая реакция на неуспешный показ — «красивое» уведомление. */
  function onAdFail(res) {
    sfx.deny();
    if (window.VK) VK.haptic('warning');
    toast('📺 ' + ((res && res.message) || 'Реклама сейчас недоступна. Попробуй чуть позже.'), 'warn', 4200);
    refreshAdAvailability();
  }

  /**
   * ТОЧКА МОНЕТИЗАЦИИ №1 — «Удвоить пассивный доход за рекламу».
   * Успешный просмотр → ×2 к авто-майнингу на 5 минут (бусты суммируются).
   */
  async function onDoubleIncome() {
    if (adBusy) return;

    // Не даём «сжечь» рекламу впустую.
    if (S.upAuto === 0) {
      sfx.deny();
      toast('Сначала купи «Авто-майнинг» — удваивать пока нечего 😉', 'warn', 3600);
      switchTab('shop');
      return;
    }
    const cd = cooldownLeft('boost');
    if (cd > 0) {
      toast('Кнопка остынет через ' + Math.ceil(cd / 1000) + ' сек', 'warn', 1800);
      return;
    }

    const res = await claimReward('double_income');
    if (!res) return;
    adLastShown.boost = Date.now();

    if (!res.ok) return onAdFail(res);

    // ★ НАГРАДА ВЫДАННА ★
    const extend = isBoostActive();
    // ★ ПОТОЛОК БУСТА ★ Тот же край, что и в sanitize() при загрузке сейва
    // (CFG.anticheat.maxBoostAheadMs). Без него серия просмотров уводила
    // boostUntil за границу, а «схлопывалась» обратно только при следующем
    // открытии приложения — то есть декларируемая константа нигде не
    // соблюдалась на единственном пути начисления буста.
    const bnow = Date.now();
    S.boostUntil = Math.min(
      Math.max(bnow, S.boostUntil) + CFG.boost.ms,
      bnow + CFG.anticheat.maxBoostAheadMs
    );
    S.watched++;
    dirty = true;

    sfx.reward();
    if (window.VK) VK.haptic('success');
    const c = stageCenter();
    floatText(c.x, c.y, '×2 НА 5 МИНУТ', 'crit');
    burst(c.x, c.y, 44, PAL_CRIT, 2.1);
    toast(extend
      ? ' Буст пассивного дохода продлён до ' + fmtClock(S.boostUntil - Date.now())
      : '🔥 Пассивный доход удвоен на 5 минут!', 'good', 4600);

    render();
    save(true);
    cloudPush(true);       // покупка награды — сразу в облако
  }

  /**
   * ТОЧКА МОНЕТИЗАЦИИ №2 — «Получить +1000 монет».
   * Успешный просмотр → разовое начисление фиксированной валюты.
   */
  async function onFreeCoins() {
    if (adBusy) return;

    const cd = cooldownLeft('coins');
    if (cd > 0) {
      toast('Новый ролик будет доступен через ' + Math.ceil(cd / 1000) + ' сек', 'warn', 1800);
      return;
    }

    const res = await claimReward('free_coins');
    if (!res) return;
    adLastShown.coins = Date.now();

    if (!res.ok) return onAdFail(res);

    // ★ НАГРАДА ВЫДАННА ★
    grant(CFG.freeCoinsReward, 'reward_video');
    S.watched++;
    sfx.reward();
    const c = stageCenter();
    floatText(c.x, c.y, '+' + fmt(CFG.freeCoinsReward), 'gold');
    burst(c.x, c.y, 40, PAL_GOLD, 2);
    toast(TM().curIcon + ' Начислено ' + fmt(CFG.freeCoinsReward) + ' ' + TM().cur + ' за просмотр!', 'good', 3800);

    render();
    save(true);
    cloudPush(true);       // награда — сразу в облако
  }

  /* ======================================================================
   * 13b. ВИРУСАЛЬНАЯ ПЕТЛЯ: награда за ФАКТИЧЕСКИЙ репост (VKWebAppShare)
   *
   * От рекламы это отличается принципиально: мост не даёт статуса «досмотрел».
   * Единственный честный сигнал — непустой LinkShareResult[] (игрок выбрал
   * цель публикации). Отсюда три обязательных замка:
   *   1) награда только после true от VK.share() — отказ (пустой массив) не
   *      должен превращаться в «спасибо + монеты»;
   *   2) суточный лимит CFG.share.perDay + кулдаун: иначе это не виральность,
   *      а бесконечный генератор монет;
   *   3) shares монотонный и учтён в plausibleCap — без этого легальные
   *      награды за репост срезал бы собственный античит.
   * ==================================================================== */

  /** Индекс календарных суток UTC: по ним сбрасывается суточный лимит. */
  const dayIndex = (t) => Math.floor((t || Date.now()) / 86400000);

  /** Сколько наградных репостов осталось на сегодня. */
  function shareLeft(now) {
    const day = dayIndex(now);
    if ((S.shareDay || 0) !== day) return CFG.share.perDay;   // новый день — с нуля
    return Math.max(0, CFG.share.perDay - (S.shareN || 0));
  }

  /** Подписи карточки шаринга. Дёшево: обновляем только при смене остатка. */
  let shareShown = -1;
  function renderShareCta() {
    if (!el.btnShare) return;
    const left = shareLeft();
    if (left === shareShown) return;
    shareShown = left;
    if (el.shareNote) {
      el.shareNote.textContent = left > 0
        ? '+' + fmt(CFG.share.reward) + ' ' + TM().cur + ' · осталось ' + left + ' из ' + CFG.share.perDay + ' сегодня'
        : 'Лимит на сегодня исчерпан (' + CFG.share.perDay + '/' + CFG.share.perDay + ')';
    }
    if (el.shareCta) el.shareCta.textContent = left > 0 ? 'Репост' : 'Позже';
    el.btnShare.classList.toggle('is-spent', left === 0);
  }

  /**
   * ТОЧКА ВИРАЛЬНОСТИ — «Поделись игрой».
   * Диалог VK открывается ВСЕГДА (награда — не условие шаринга и не приманка
   * для принуждения), но монеты начисляются только за фактический репост.
   */
  async function onShare() {
    if (adBusy) return;       // идёт показ ролика: не наслаивать нативные диалоги
    const vk = VKAPI();
    if (!vk || !vk.share) {
      sfx.deny();
      toast('Модуль VK Bridge недоступен. Попробуй перезапустить приложение.', 'bad');
      return;
    }
    if (!(vk.isVK && vk.isVK())) {
      sfx.deny();
      toast('Поделиться можно только внутри VK', 'warn', 3000);
      return;
    }
    const cd = cooldownLeft('share', CFG.share.cooldownMs);
    if (cd > 0) {
      toast('Репост уже засчитан. Ещё можно через ' + Math.ceil(cd / 1000) + ' сек', 'warn', 2600);
      return;
    }
    if (shareLeft() <= 0) {
      sfx.deny();
      toast('Лимит репостов на сегодня исчерпан — завтра обновится 🙌', 'warn', 3800);
      return;
    }

    let shared = false;
    try { shared = !!(await vk.share()); } catch (_) { shared = false; }
    if (!shared) {            // игрок закрыл диалог: тихо, без награды и без упрёка
      renderShareCta();
      return;
    }
    adLastShown.share = Date.now();

    // ★ НАГРАДА ЗА РЕПОСТ ВЫДАННА ★
    const day = dayIndex();
    if ((S.shareDay || 0) !== day) { S.shareDay = day; S.shareN = 0; }
    S.shareN++;
    S.shares++;
    grant(CFG.share.reward, 'share');
    sfx.reward();
    const c = stageCenter();
    floatText(c.x, c.y, '+' + fmt(CFG.share.reward), 'gold');
    burst(c.x, c.y, 30, PAL_GOLD, 1.8);
    toast('📣 Репост засчитан! +' + fmt(CFG.share.reward) + ' ' + TM().cur + ', ещё ' + shareLeft() + ' сегодня', 'good', 4200);

    render();
    renderShareCta();
    save(true);
    cloudPush(true);          // награда — сразу в облако
  }

  /** Обновляет подсказку и «живую точку» на табе Бонусы по состоянию VK. */
  async function refreshAdAvailability() {
    const vk = VKAPI();
    if (!vk) {
      el.adNote.textContent = 'VK Bridge не загружен — бонусы временно недоступны.';
      el.btnDouble.disabled = true;
      el.btnCoins.disabled = true;
      return;
    }
    let available = false;
    try { available = !!(await vk.hasRewardedAds()); } catch (_) { available = false; }

    const inVK = !!(vk.isVK && vk.isVK());
    const demo = !!(vk.isDemo && vk.isDemo());

    el.bonusDot.classList.toggle('is-on', available || demo);
    if (inVK) {
      el.adNote.textContent = available
        ? 'Награда выдаётся после просмотра видеоролика. Реклама — сервис VK.'
        : 'Реклама сейчас недоступна (нет заполнения). Загляни через несколько минут.';
    } else if (demo) {
      el.adNote.textContent = 'Демо-режим: приложение открыто вне клиента VK — награды выдаются без рекламы.';
    }
  }
  /* ======================================================================
   * 13c. СОЛО «ВА-БАНК» — риск-раунд против банка игры
   *
   * Три инварианта держат всю механику; нарушение любого — это либо кран
   * монет, либо украденный у игрока выигрыш.
   *
   *  1. НИКАКОГО КРАНА. Проигрыш списывает ставку, выигрыш возвращает ровно
   *     её же. S.total НЕ растёт ни в одном исходе — поэтому не растут ни
   *     ранг, ни «всего заработано», ни потолок правдоподобия. Ожидание по
   *     монетам строго отрицательное (−0,5 × ставка): это сток валюты.
   *     earn()/grant() тут ЗАПРЕЩЕНЫ — они двигают S.total.
   *     Зачем так жёстко: выплата, не подкреплённая активностью, иначе
   *     молча срезалась бы plausibleCap() при следующей загрузке. Замер на
   *     живой сборке: +100 млн недельному аккаунту → уцелело 7,3 млн, а
   *     победитель получил флаг нарушения susp.
   *
   *  2. WRITE-AHEAD. Ставка списывается, исход бросается и всё это уходит на
   *     диск ДО анимации и ДО показа результата. Поэтому F5 на середине
   *     раскрытия не даёт ни реролла проигрыша, ни кражи выигрыша:
   *     resumeRiskRound() доигрывает уже решённый раунд.
   *
   *  3. ПРИЗ — ВРЕМЯ, А НЕ МНОЖИТЕЛЬ. Победитель получает свою ставку назад и
   *     продление буста ×2 на CFG.risk.boostMs. Множитель CFG.boost.mult
   *     трогать нельзя: plausibleCap() считает пассивный потолок из расчёта
   *     постоянно включённого ×2, и больший множитель вывел бы честного
   *     игрока за потолок. Край maxBoostAheadMs — тот же, что у рекламы.
   * ==================================================================== */

  const RISK = CFG.risk;
  /* Последний допустимый индекс ставки. Считается по ОБЕИМ массивам, потому
     что stakes задаёт доли, а boostMs — награду: добавить четвёртую долю и
     забыть четвёртый приз значило бы получить boostMs[3] === undefined →
     boostUntil = NaN, и буст умер бы молча, без единой ошибки в консоли.
     Целостность конфига дополнительно заперта проверкой в .smoke-test.cjs [10]. */
  const RISK_MAX = Math.max(0, Math.min(RISK.stakes.length, RISK.boostMs.length) - 1);
  let riskPick = RISK_MAX;                               // по умолчанию ва-банк — это лицо механики
  let riskBusy = false;                    // идёт анимация раскрытия раунда
  const utcDay = () => Math.floor(Date.now() / 86400000);   // сутки UTC, как у репостов

  /** Сколько раундов осталось в эти сутки. */
  function riskLeft() {
    return S.riskDay === utcDay() ? Math.max(0, RISK.perDay - S.riskN) : RISK.perDay;
  }

  /** Размер ставки для доли с индексом i: от полного баланса, округление вниз. */
  function riskStakeOf(i) {
    const idx = Math.max(0, Math.min(RISK_MAX, i | 0));
    return Math.max(0, Math.floor(Math.floor(S.coins) * RISK.stakes[idx]));
  }

  /** Причина не играть или null. Единая — чтобы текст и кнопка не расходились. */
  function riskBlock(i) {
    if (S.rpStake > 0) return 'pending';
    if (riskBusy || adBusy) return 'busy';
    if (riskLeft() <= 0) return 'limit';
    if (riskStakeOf(i) < RISK.minStake) return 'small';
    return null;
  }

  /**
   * Закрыть незакрытый раунд. ИДЕМПОТЕНТНА: rpStake обнуляется ПЕРВЫМ делом,
   * до любых начислений, поэтому повторный вызов (boot + облачное слияние)
   * ничего не удваивает. Возвращает {won, stake, idx} или null.
   */
  function closeRiskRound() {
    if (!(S.rpStake > 0)) return null;
    const stake = Math.floor(S.rpStake);
    const won = S.rpWon === 1;
    const idx = Math.max(0, Math.min(RISK_MAX, S.rpIdx | 0));
    S.rpStake = 0; S.rpWon = 0; S.rpIdx = 0;

    if (won) {
      // Возврат СВОЕЙ ставки. Второй барьер целостности: coins не может
      // стать больше total — иначе завышенная в сейве rpStake стала бы
      // краном, а sanitize() такие случаи ловит только при загрузке.
      const refund = Math.min(stake, Math.max(0, Math.floor(S.total) - Math.floor(S.coins)));
      S.coins += refund;
      S.riskWins++;
      const bnow = Date.now();
      S.boostUntil = Math.min(
        Math.max(bnow, S.boostUntil) + RISK.boostMs[idx],
        bnow + CFG.anticheat.maxBoostAheadMs
      );
    } else {
      S.coins = Math.max(0, S.coins);   // ставка списана на write-ahead, здесь только страховка
      S.riskLoss++;
      S.riskBurned += stake;            // монеты покинули игру навсегда — это и есть цель механики
    }
    dirty = true;
    return { won: won, stake: stake, idx: idx };
  }

  /**
   * Доиграть раунд, прерванный смертью приложения. Вызывается на boot и после
   * слияния с облаком; второй вызов ничего не делает (идемпотентность выше).
   */
  function resumeRiskRound() {
    const r = closeRiskRound();
    if (!r) return null;
    save(true);
    render();
    toast(r.won
      ? '⏳ Прошлый раунд доигран: ставка ' + fmt(r.stake) + ' ' + TM().cur + ' вернулась, буст ×2 включён'
      : '⏳ Прошлый раунд доигран: ставка ' + fmt(r.stake) + ' ' + TM().cur + ' сгорела',
      r.won ? 'good' : 'bad', 5200);
    return r;
  }

  /**
   * Игрок нажал «Поставить». Порядок НЕ случаен: сначала списание, бросок и
   * запись на диск, и только потом анимация. См. инвариант 2 выше.
   */
  function playRisk() {
    const i = riskPick;
    const block = riskBlock(i);
    if (block === 'pending' || block === 'busy') { sfx.deny(); return; }
    if (block === 'limit') {
      sfx.deny();
      toast('Все ' + RISK.perDay + ' раунда на сегодня истрачены — обнулится завтра', 'warn', 3600);
      renderRiskCta();
      return;
    }
    if (block === 'small') {
      sfx.deny();
      toast('Ставка слишком мала: нужно хотя бы ' + fmt(RISK.minStake) + ' ' + TM().cur, 'warn', 3600);
      return;
    }

    const stake = riskStakeOf(i);
    const day = utcDay();

    // —— WRITE-AHEAD (точка невозврата) ——
    S.coins -= stake;                              // S.total не трогаем: монеты вышли из игры
    if (S.riskDay !== day) { S.riskDay = day; S.riskN = 0; }
    S.riskN++;
    S.rpStake = stake;
    S.rpWon = Math.random() < 0.5 ? 1 : 0;         // исход решён ЗДЕСЬ, а не после анимации
    S.rpIdx = i;
    riskBusy = true;
    dirty = true;
    save(true);                                    // ← раунд уже лежит на диске
    cloudPush(true);
    render();                                      // баланс показан уже новый

    if (el.riskCard) el.riskCard.classList.add('is-rolling');
    if (el.riskCta) setText(el.riskCta, 'Бросаем банк…');

    setTimeout(() => {
      const r = closeRiskRound();
      riskBusy = false;
      if (el.riskCard) el.riskCard.classList.remove('is-rolling');
      if (!r) { render(); return; }                // раунд уже доиграл boot/облако — не дублируем
      save(true);
      cloudPush(true);

      const c = stageCenter();
      const mins = Math.round(RISK.boostMs[r.idx] / 60000);
      if (r.won) {
        sfx.reward();
        if (window.VK) VK.haptic('success');
        floatText(c.x, c.y, 'БАНК ТВОЙ', 'crit');
        burst(c.x, c.y, 44, PAL_CRIT, 2.1);
        celebrate();
        toast('🔥 Ставка ' + fmt(r.stake) + ' ' + TM().cur + ' вернулась, добыча ×2 на ' + mins + ' мин', 'good', 5000);
      } else {
        sfx.deny();
        if (window.VK) VK.haptic('warning');
        floatText(c.x, c.y, '\u2212' + fmt(r.stake), 'crit');
        toast('💀 ' + fmt(r.stake) + ' ' + TM().cur + ' сгорело. Эти монеты больше никому — так задумано.', 'bad', 5200);
      }
      render();
    }, 900);
  }

  /** Выбор доли ставки (чипы 25% / 50% / Ва-банк). */
  function setRiskPick(i) {
    riskPick = Math.max(0, Math.min(RISK_MAX, i | 0));
    document.querySelectorAll('#riskChips .chip').forEach((b) => {
      const on = Number(b.dataset.idx) === riskPick;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    renderRiskCta();
  }

  /**
   * CTA риск-раунда. Вызывается из render(), то есть 5 раз в секунду, поэтому
   * DOM трогаем только при реальной смене (setText кэширует, toggle идемпотентен).
   * Текст собирается в JS, а не через data-t: механика не входит в контракт
   * темы (THEME_COPY_KEYS), а название валюты берётся из TM().cur — так карточка
   * говорит на языке активной темы, не расширяя реестр токенов.
   */
  function renderRiskCta() {
    const stake = riskStakeOf(riskPick);
    const block = riskBlock(riskPick);
    setText(el.riskAmount, fmt(stake) + ' ' + TM().cur);
    setText(el.riskQuota, riskLeft() + '/' + RISK.perDay);
    if (el.btnRisk) el.btnRisk.disabled = !!block;
    const note = (block === 'pending' || block === 'busy') ? 'Раунд уже идёт…'
      : block === 'limit' ? 'Суточный лимит исчерпан — обнулится завтра'
        : block === 'small' ? 'Нужно хотя бы ' + fmt(RISK.minStake) + ' ' + TM().cur + ' на балансе'
          : 'Проигрыш сгорает навсегда. Победа возвращает ставку и даёт ×2 на '
            + Math.round(RISK.boostMs[riskPick] / 60000) + ' мин';
    /* «Сгорело всего» — единственное место, где игрок видит смысл механики:
       монеты, выведенные из игры навсегда. Без этой строки сток остаётся
       абстракцией в сейве, а ставка не ощущается как ставка. */
    const burned = Math.floor(S.riskBurned) > 0
      ? '  ·  сгорело всего: ' + fmt(S.riskBurned) + ' ' + TM().cur
      : '';
    setText(el.riskNote, note + burned);
    if (el.riskCard) el.riskCard.classList.toggle('is-blocked', !!block && block !== 'pending' && block !== 'busy');
  }

  /* ======================================================================
   * 13d. ГИЛЬДИИ (сообщества VK) И «БАТТЛЫ» (детерминированный недельный рейд)
   *
   * ПОЧЕМУ ГИЛЬДИЯ = СООБЩЕСТВО VK, а не своя сущность.
   *   Список участников сообщества ведёт НЕ наш код, а VK. Значит авторитетный
   *   реестр членов УЖЕ существует и проверяем из клиента (поле is_member), а
   *   вступление стоит один вызов моста. Свой реестр гильдий здесь означал бы
   *   дублировать то, что платформа отдаёт бесплатно.
   *
   * ПОЧЕМУ РЕЙД, А НЕ «ГИЛЬДИЯ ПРОТИВ ГИЛЬДИИ».
   *   Агрегать вклад нескольких игроков без своего сервера НЕГДЕ: vk-bridge v3
   *   не даёт ни серверless-функций, ни общего хранилища (проверено по всем 307
   *   методам), а VKWebAppStorage* — переменные ТОЛЬКО на пользователя. Запись в
   *   общую поверхность через VKWebAppGetCommunityToken + VKWebAppCallAPIMethod
   *   технически возможна, но community-токен попадает в браузер КАЖДОМУ
   *   участнику: любой выписал бы любой счёт гильдии. Это прямой конфликт с
   *   античит-моделью проекта, поэтому не сделано даже за косметические награды.
   *   Честная замена, доступная СЕЙЧАС: условия сезона выводятся
   *   детерминированно из номера календарной недели UTC, поэтому всем гильдиям
   *   достаются одинаковые правила — конкурировать можно без общего счёта.
   *
   * ТРИ ИНВАРИАНТА, нарушение любого превращает фичу в дыру:
   *  1. НЕТ НОВОГО КРАНА ВАЛЮТЫ. Честь выводится из дельты УЖЕ подтверждённого
   *     заработка: S.rdEarned растёт внутри earn(), то есть ПОСЛЕ потолка
   *     maxSingleEarn. Поэтому plausibleCap() расширять НЕ требуется — в
   *     отличие от репостов, которые в потолок добавить пришлось (раздел 15).
   *     Накрутка, срезанная при загрузке, режет и честь: два античита не
   *     расходятся.
   *  2. НАГРАДА — ВРЕМЯ, А НЕ ВАЛЮТА. Обмен чести продлевает буст ×2 на
   *     CFG.raid.boostMs с тем же краем maxBoostAheadMs, что у рекламы и
   *     риск-раунда. CFG.boost.mult не трогаем по той же причине, что и в 13c:
   *     потолок правдоподобия считает пассивку из расчёта постоянно ×2.
   *  3. РОЛЬ ИГРОКА В ГИЛЬДИИ В СЕЙВЕ НЕ ХРАНЯТСЯ. Их сообщает VK при запуске
   *     (vk_group_id, vk_viewer_group_role). Любая копия в LocalStorage
   *     устаревала бы и поддавалась правке, а «админ гильдии» из нарисованного
   *     поля — привилегия, которую клиенту доверять нельзя.
   * ==================================================================== */

  const RAID = CFG.raid;
  const GUILD = CFG.guild;

  /** Индекс календарной недели UTC: по нему закрывается журнал рейда. */
  const weekIndex = (t) => Math.floor((t || Date.now()) / 604800000);

  /** Честь за 1 монетный шаг: honorPer обязан быть >= 1 (заперто тестом). */
  const honorStep = () => Math.max(1, Math.floor(RAID.honorPer) || 1);

  /* Карточка гильдии кэшируется В ПАМЯТИ и в сейв НЕ пишется намеренно: имя и
     фото сообщества меняются, а пакет облака ограничен 4096 символами. */
  const guild = { info: null, role: 'none', busy: false, probed: false, photo: '' };

  /* Подписи ролей из vk_viewer_group_role. Роль — СПРАВКА ДЛЯ ИГРОКА, а не
     привилегия: ни одна ветка логики на неё не смотрит (инвариант 3). */
  const ROLE_LABEL = {
    admin: 'Ты админ этой гильдии',
    editor: 'Ты редактор этой гильдии',
    moder: 'Ты модератор этой гильдии',
    member: 'Ты участник этой гильдии',
    none: 'Роль в гильдии не определена',
    '': 'Роль в гильдии не определена'
  };

  /**
   * ШОВ общего состояния. Всё обращение к «общему» — только через него: приход
   * авторитетного бэкенда меняет ЭТОТ объект, а не схему, не рейд и не UI.
   * Реализация phase-1 — VK-сообщество; season() детерминирован локально.
   */
  const GuildProvider = {
    /** false — общее состояние недоступно (вне VK / мост не поддержал метод). */
    available() {
      const vk = VKAPI();
      return !!(vk && vk.isVK && vk.isVK() && vk.guildInfo);
    },
    resolve(groupId) {
      const vk = VKAPI();
      if (!this.available() || !vk.guildInfo) return Promise.resolve(null);
      return Promise.resolve(vk.guildInfo(groupId)).catch(() => null);
    },
    join(groupId) {
      const vk = VKAPI();
      if (!this.available() || !vk.joinGroup) return Promise.resolve(false);
      return Promise.resolve(vk.joinGroup(groupId)).catch(() => false);
    },
    leave(groupId) {
      const vk = VKAPI();
      if (!this.available() || !vk.leaveGroup) return Promise.resolve(false);
      return Promise.resolve(vk.leaveGroup(groupId)).catch(() => false);
    },
    /** Условия сезона: одинаковы для всех гильдий, потому что детерминированы. */
    season(week) {
      return { week: Math.max(0, Math.floor(week || 0)), mult: RAID.guildMult, honorPer: honorStep() };
    }
  };

  /**
   * Закрыть истёкшие недели и выдать честь. ИДЕМПОТЕНТНА: rdWeek переворачивается
   * ПЕРВЫМ делом, до начислений, поэтому повторный вызов (boot + тик + облачное
   * слияние) вторую выплату не удваивает — тот же приём, что у closeRiskRound().
   * @returns {{week:number, gained:number, honor:number}|null}
   */
  function rollRaid(now) {
    const w = weekIndex(now);
    // 0 = журнал ещё не заведён (сейвы v1..v3 и чистый старт). Заводим ТЕКУЩЕЙ
    // неделей БЕЗ выплаты: выдуманная «закрытая неделя» с нулевым заработком
    // добавила бы игроку rdTries из воздуха.
    if (!(S.rdWeek > 0)) { S.rdWeek = w; S.rdEarned = 0; dirty = true; return null; }
    // Часы игрока отстали: назад по неделе не откатываемся (rdWeek монотонен).
    if (w <= S.rdWeek) return null;

    const closed = S.rdWeek;
    const gained = Math.floor((S.rdEarned || 0) / honorStep());
    // Надбавка гильдии — ТОЛЬКО престиж (инвариант 1): монеты она не создаёт.
    const honor = Math.floor(gained * (S.gState === 1 ? RAID.guildMult : 1));

    S.rdWeek = w;                 // ← ДО начислений: повторный вызов уже не пройдёт
    S.rdEarned = 0;
    if (honor > 0) {
      S.rdHonor += honor;
      S.rdLife += honor;
      if (honor > (S.rdBest || 0)) S.rdBest = honor;
    }
    S.rdTries++;
    dirty = true;
    return { week: closed, gained: gained, honor: honor };
  }

  /**
   * Единственная точка закрытия недели: произвели расчёт, сохранили, сообщили.
   *
   * Почему одна, а не две (тик и рендер): rollRaid() возвращает итог РОВНО один
   * раз за переход. Если бы им пользовался ещё и renderRaid(), прямой вызов
   * render() из покупки или обмена «съедал» бы результат молча — неделя
   * закрылась бы корректно, но игрок никогда не увидел бы уведомление о чести.
   * Поэтому рендер недели НЕ рассчитывает: он только читает S.
   */
  function settleRaid(now) {
    const r = rollRaid(now);
    if (!r) return null;
    save(true);
    cloudPush(true);
    if (r.honor > 0) {
      toast('⚔ Неделя рейда закрыта: +' + fmt(r.honor) + ' чести'
        + (S.gState === 1 ? ' (гильдия ×' + RAID.guildMult + ')' : ''), 'good', 5200);
      sfx.reward();
    } else {
      toast('⚔ Началась новая неделя рейда. Прошлая чести не принесла', 'warn', 4200);
    }
    return r;
  }

  /** Обслуживание рейда тиком. */
  function tickRaid() { settleRaid(); }

  /** Сколько обменов чести осталось в эти сутки UTC. */
  function raidRedeemLeft(now) {
    const day = dayIndex(now);
    if ((S.rdRedeemed || 0) !== day) return RAID.perDay;
    return Math.max(0, RAID.perDay - (S.rdRedN || 0));
  }

  /** Причина не обменивать честь или null. Единая — чтобы текст и кнопка не расходились. */
  function raidRedeemBlock(now) {
    if (guild.busy) return 'busy';
    if (raidRedeemLeft(now) <= 0) return 'limit';
    if (Math.floor(S.rdHonor || 0) < RAID.boostCost) return 'poor';
    // Край maxBoostAheadMs — тот же, что у рекламы и риск-раунда. Но там он
    // ОБРЕЗАЕТ выдачу (Math.min в момент награждения), а здесь ЗАПРЕЩАЕТ обмен
    // заранее. Причина: честь — ресурс редкий, она копится неделю. Списывать её
    // за урезанный буст было бы тем самым тихим отъёмом награды, от которого
    // защищаются в 13c. Игрок видит причину ДО нажатия, а не после списания.
    const bnow = Date.now();
    if (Math.max(bnow, S.boostUntil || 0) + RAID.boostMs > bnow + CFG.anticheat.maxBoostAheadMs) return 'cap';
    return null;
  }

  /**
   * Обмен чести на ВРЕМЯ буста ×2. Монет не касается вообще (инвариант 2): здесь
   * нет ни earn(), ни grant(), ни списания баланса — только сток престижа.
   * @returns {boolean} true — обмен состоялся.
   */
  function redeemHonor() {
    settleRaid();                                 // сначала закрываем истёкшую неделю
    const block = raidRedeemBlock();
    if (block === 'busy') { sfx.deny(); return false; }
    if (block === 'limit') {
      sfx.deny();
      toast('Обмены чести на сегодня исчерпаны (' + RAID.perDay + '/' + RAID.perDay + ') — обнулится завтра', 'warn', 3800);
      renderRaid();
      return false;
    }
    if (block === 'poor') {
      sfx.deny();
      toast('Нужно ' + RAID.boostCost + ' чести, сейчас ' + fmt(Math.floor(S.rdHonor || 0)), 'warn', 3600);
      return false;
    }
    if (block === 'cap') {
      // Честь НЕ списывается: край буста режет покупку, а не награду.
      sfx.deny();
      toast('Буст уже почти на пределе ' + Math.round(CFG.anticheat.maxBoostAheadMs / 60000)
        + ' мин: честь не списана, обменяйся позже', 'warn', 4200);
      renderRaid();
      return false;
    }
    const day = dayIndex();
    if ((S.rdRedeemed || 0) !== day) { S.rdRedeemed = day; S.rdRedN = 0; }
    S.rdRedN++;
    S.rdHonor -= RAID.boostCost;                  // сток престижа, не валюты
    const now = Date.now();
    S.boostUntil = Math.min(
      Math.max(now, S.boostUntil) + RAID.boostMs,
      now + CFG.anticheat.maxBoostAheadMs
    );
    dirty = true;
    save(true);
    cloudPush(true);
    render();
    sfx.reward();
    if (window.VK) VK.haptic('success');
    const c = stageCenter();
    const mins = Math.round(RAID.boostMs / 60000);
    floatText(c.x, c.y, '+' + mins + ' мин', 'crit');
    burst(c.x, c.y, 34, PAL_CRIT, 1.9);
    toast('⚔ Честь обменена: добыча ×2 ещё на ' + mins + ' мин', 'good', 4600);
    return true;
  }

  /** Звание рейда по пожизненной чести (не по остатку: тратить честь полезно). */
  function raidTier() {
    const life = Math.floor(S.rdLife || 0);
    const T = RAID.tiers;
    let idx = -1;
    for (let i = 0; i < T.length; i++) if (life >= T[i][0]) idx = i;
    if (idx < 0) {
      const nx = T[0];
      return {
        name: 'Без звания',
        hint: nx ? 'до «' + nx[1] + '»: ' + fmt(Math.max(0, nx[0] - life)) + ' чести' : 'максимальное звание',
        progress: nx && nx[0] > 0 ? Math.max(0, Math.min(1, life / nx[0])) : 1
      };
    }
    const cur = T[idx], next = T[idx + 1] || null;
    if (!next) return { name: cur[1], hint: 'максимальное звание', progress: 1 };
    const span = next[0] - cur[0];
    return {
      name: cur[1],
      hint: 'до «' + next[1] + '»: ' + fmt(Math.max(0, next[0] - life)) + ' чести',
      progress: span > 0 ? Math.max(0, Math.min(1, (life - cur[0]) / span)) : 0
    };
  }

  /** Текущая гильдия игрока. 0 — вне гильдии (источник истины — только S.gid). */
  function currentGid() { return Math.floor(S.gid || 0); }

  /**
   * Фото сообщества приходит от VK и может быть любой строкой. В img.src
   * допускаем только https-картинки собственных CDN VK: иначе провал валидации
   * моста превратился бы в вектор «data:»/«javascript:» в атрибуте, которого в
   * остальном UI нет.
   *
   * Хосты взяты из реальных ответов VKWebAppGetGroupInfo: аватарки сообществ
   * раздаются с *.userapi.com (sun9-12.userapi.com и т. п.), а не только с vk.com.
   * Список, ограниченный одним «vk.com», молча скрывал бы фото у каждой гильдии —
   * проверка на «безопасно» не должна превращаться в проверку на «существует».
   */
  const GUILD_PHOTO_HOST = /^(?:[a-z0-9-]+\.)*(?:userapi\.com|vk\.com)$/i;
  function safeImgUrl(u) {
    const s = String(u || '');
    if (s.length > 2048) return '';
    let host = '';
    try { host = new URL(s).host; } catch (_) { return ''; }
    if (!GUILD_PHOTO_HOST.test(host)) return '';
    return /^https:\/\/\S+$/.test(s) ? s : '';
  }

  /**
   * Жив ли мост VK в момент отрисовки. Две причины «гильдии нет» обязаны
   * звучать по-разному. Вне VK игроку терять нечего — он просто не в VK. А
   * внутри VK отсутствие vk_group_id означает другое: приложение открыто как
   * личное, привязки к сообществу нет. Сваливать это под одну подпись
   * «нет подключения к VK» было настоящей ошибкой: приложение, отлично
   * подключённое к VK, убеждало админа в обратном, и поиск уезжал не туда.
   */
  function inVKNow() {
    const vk = VKAPI();
    return !!(vk && vk.isVK && vk.isVK());
  }

  /**
   * Карточка гильдии. Вне контракта темы (data-t здесь нет): имя сообщества
   * приходит из VK и меняется без нашего участия, а статус — производная величина.
   */
  function renderGuild() {
    if (!el.guildName) return;
    const id = currentGid();
    const info = guild.info;
    const name = info && info.name ? info.name : (id > 0 ? 'Гильдия #' + id : 'Гильдии недоступны');
    setText(el.guildName, name);
    const tag = info && info.screenName ? '@' + info.screenName
      : (id > 0 ? '' : (inVKNow() ? 'запуск не из сообщества' : 'нет подключения к VK'));
    setText(el.guildTag, tag);

    // Роль сообщает ТОЛЬКО VK при запуске (инвариант 3): в сейве её нет.
    setText(el.guildRole, ROLE_LABEL[guild.role] || ROLE_LABEL.none);

    const st = S.gState | 0;
    const label = guild.busy ? 'Проверяем…'
      : id <= 0 ? 'Вне гильдии'
        : st === GSTATE.MEMBER ? 'Участник ✓'
          : st === GSTATE.OUTSIDER ? 'Не участник'
            : 'Не проверено';
    setText(el.guildState, label);
    if (el.guildCard) {
      el.guildCard.classList.toggle('is-member', st === GSTATE.MEMBER && id > 0);
      el.guildCard.classList.toggle('is-unknown', (st === GSTATE.UNKNOWN || id <= 0) && !guild.busy);
    }

    // Надбавка видна всегда, даже вне VK: игрок должен понимать, ЧТО он теряет.
    setText(el.guildMult, '×' + RAID.guildMult);

    const photo = safeImgUrl(guild.photo);
    if (el.guildPhoto) {
      if (photo && el.guildPhoto.getAttribute('src') !== photo) el.guildPhoto.setAttribute('src', photo);
      el.guildPhoto.hidden = !photo;
    }

    const canAct = id > 0 && !guild.busy;
    if (el.btnGuildJoin) el.btnGuildJoin.disabled = !canAct || st === GSTATE.MEMBER;
    if (el.btnGuildLeave) el.btnGuildLeave.disabled = !canAct || st !== GSTATE.MEMBER;
    if (el.guildPicker) {
      el.guildPicker.disabled = guild.busy;
      // Одна гильдия — выбирать не из чего: выбор прячем, остаётся запуск из
      // папки сообщества. Источник истины тот же, VK (vk_group_id).
      el.guildPicker.hidden = !(GUILD.roster && GUILD.roster.length > 1);
    }
    if (el.guildHint) {
      setText(el.guildHint, id > 0
        ? (st === GSTATE.MEMBER
          ? 'Честь недели растёт быстрее: надбавка ×' + RAID.guildMult + ' к итогу рейда.'
          : st === GSTATE.OUTSIDER
            ? 'Вступи, чтобы недельный итог рейда засчитывался с надбавкой ×' + RAID.guildMult + '.'
            : 'Статус не подтверждён VK — рейд идёт без надбавки, потери нет.')
        : inVKNow()
          /* Мы в VK, но vk_group_id не приехал: приложение открыто как личное.
             Причина всегда одна — нет привязки к сообществу (README п.3), и
             подсказка должна вести именно туда, а не в «подключи VK». */
          ? 'VK на месте, но приложение открыто как личное: сообщество не передало свой id. Добавь приложение в сообщество и открой игру из его папки сообщества — оно и станет твоей гильдией.'
          : 'Открой игру из папки сообщества VK — оно и станет твоей гильдией.');
    }
  }

  /**
   * Панель рейда. Вызывается из render(), то есть 5 раз в секунду, поэтому DOM
   * трогаем только при реальной смене (setText кэширует, toggle идемпотентен).
   */
  function renderRaid() {
    if (!el.raidHonor) return;
    const per = honorStep();
    const earned = Math.floor(S.rdEarned || 0);
    const pending = Math.floor(earned / per);
    const frac = per > 0 ? (earned % per) / per : 0;

    setText(el.raidEarned, fmt(earned) + ' ' + TM().cur);
    setText(el.raidPending, '+' + fmt(pending));
    if (el.raidBar) el.raidBar.style.transform = 'scaleX(' + frac.toFixed(3) + ')';
    setText(el.raidPer, 'за ' + fmt(per) + ' ' + TM().cur);

    const left = (S.rdWeek + 1) * 604800000 - Date.now();
    setText(el.raidWeek, left > 0 ? fmtDur(left) : 'идёт закрытие');

    setText(el.raidHonor, fmt(Math.floor(S.rdHonor || 0)));
    setText(el.raidLife, fmt(Math.floor(S.rdLife || 0)));
    setText(el.raidBest, fmt(Math.floor(S.rdBest || 0)));
    setText(el.raidTries, fmt(Math.floor(S.rdTries || 0)));

    const t = raidTier();
    setText(el.raidTier, t.name);
    setText(el.raidTierHint, t.hint);
    if (el.raidTierBar) el.raidTierBar.style.width = (t.progress * 100).toFixed(1) + '%';

    const leftN = raidRedeemLeft();
    setText(el.raidQuota, leftN + '/' + RAID.perDay);
    const block = raidRedeemBlock();
    if (el.btnRaidRedeem) el.btnRaidRedeem.disabled = !!block;
    setText(el.raidRedeemCta, block === 'limit' ? 'Лимит'
      : block === 'cap' ? 'Буст на пределе'
        : block === 'busy' ? 'Гильдия…'
          : block === 'poor' ? RAID.boostCost + ' чести'
            : 'Буст ×2 · ' + Math.round(RAID.boostMs / 60000) + ' мин');
    setText(el.raidNote, block === 'limit'
      ? 'Обмены чести на сегодня исчерпаны — обнулится завтра'
      : block === 'cap'
        ? 'Буст уже почти на 90-минутном пределе: обмен стал бы бессмысленным, честь не списана'
        : block === 'poor'
          ? 'Нужно ' + RAID.boostCost + ' чести: копится из итога недели рейда'
          : 'Честь покупает время добычи ×2 и никогда не выдаёт монет');
    if (el.raidCard) el.raidCard.classList.toggle('is-blocked', !!block);
  }

  /* --- Членство: 0 «не проверено», 1 «участник», 2 «не участник» ---------- */
  const GSTATE = { UNKNOWN: 0, MEMBER: 1, OUTSIDER: 2 };

  function setGuildState(next) {
    const v = Math.max(0, Math.min(2, next | 0));
    if (S.gState === v) return false;
    S.gState = v;
    dirty = true;
    return true;
  }

  /**
   * Один запрос карточки сообщества и статуса участника.
   * Вне VK, при отказе моста или таймауте оставляем gState = 0 («не проверено»)
   * и БЕЗ всякого штрафа: рейд работает у всех, просто без гильдейской надбавки.
   * Провал VKWebAppGetGroupInfo не имеет права уронить игру — ровно то же
   * требование, что и к остальным необязательным вызовам моста.
   */
  async function probeGuild(gid) {
    const id = Math.floor(Number(gid) || 0);
    if (id <= 0) {
      guild.probed = true; guild.info = null; guild.photo = '';
      setGuildState(GSTATE.UNKNOWN);
      renderGuild();
      return null;
    }
    if (!GuildProvider.available()) {
      guild.probed = true; guild.info = null; guild.photo = '';
      setGuildState(GSTATE.UNKNOWN);
      renderGuild();
      return null;
    }
    guild.busy = true;
    renderGuild();
    const info = await GuildProvider.resolve(id);
    guild.busy = false;
    guild.probed = true;
    if (!info) { setGuildState(GSTATE.UNKNOWN); renderGuild(); return null; }
    guild.info = info;
    guild.photo = typeof info.photo === 'string' ? info.photo : '';
    setGuildState(info.isMember ? GSTATE.MEMBER : GSTATE.OUTSIDER);
    renderGuild();
    save(true);
    // Отправляем наружу сразу: состав гильдии виден другим устройствам, и тянуть
    // 45 секунд штатного троттлинга здесь незачем. Безопасно: cloudPush не пишет
    // в облако до первого чтения (см. gate на cloud.pulled).
    cloudPush(true);
    return info;
  }

  /** Смена гильдии (выбор игрока из roster). Сбрасывает статус до новой проверки. */
  function selectGuild(gid) {
    const id = Math.floor(Number(gid) || 0);
    if (id <= 0 || guild.busy) { sfx.deny(); return false; }
    if (currentGid() === id) return true;
    S.gid = id;
    guild.info = null; guild.photo = '';
    setGuildState(GSTATE.UNKNOWN);
    dirty = true;
    save(true);
    cloudPush(true);
    renderGuild();
    probeGuild(id);
    return true;
  }

  /** Вступление в сообщество. Награда за это НЕ начисляется — членство не факт до probeGuild(). */
  async function joinGuild() {
    const id = currentGid();
    if (id <= 0 || guild.busy) { sfx.deny(); return false; }
    guild.busy = true;
    renderGuild();
    const done = await GuildProvider.join(id);
    guild.busy = false;
    if (!done) {
      sfx.deny();
      toast('VK отклонил вступление — попробуй ещё раз', 'warn', 3200);
      renderGuild();
      return false;
    }
    sfx.buy();
    const info = await probeGuild(id);
    if (S.gState === GSTATE.MEMBER) {
      toast('⚔ Ты в гильдии' + (info && info.name ? ' «' + info.name + '»' : '')
        + ': надбавка ×' + RAID.guildMult + ' к чести недели', 'good', 4600);
      if (window.VK) VK.haptic('success');
    } else {
      toast('Заявка принята, статус ещё не подтвердился', 'warn', 3200);
    }
    return true;
  }

  /**
   * Выход из сообщества. Инвариант 3: выход НЕ трогает накопленную честь и звание —
   * они уже заработаны. Отнимать их задним числом значит наказывать игрока за
   * решение, которое платформа разрешает свободно менять.
   */
  async function leaveGuild() {
    const id = currentGid();
    if (id <= 0 || guild.busy) { sfx.deny(); return false; }
    guild.busy = true;
    renderGuild();
    const done = await GuildProvider.leave(id);
    guild.busy = false;
    if (!done) {
      sfx.deny();
      toast('VK отклонил выход — попробуй ещё раз', 'warn', 3200);
      renderGuild();
      return false;
    }
    sfx.buy();
    await probeGuild(id);
    toast('Ты вышел из гильдии. Накопленная честь и звание остались', 'good', 4200);
    return true;
  }

  /**
   * Список гильдий из CFG.guild.roster. Записи только настоящие: выдуманный id
   * отправил бы игрока в чужое сообщество, а вступление в него отозвать уже нельзя.
   * Одна гильдия — пикер не нужен, вкладка живёт запуском из папки VK (vk_group_id);
   * с двумя и более игрок выбирает сам.
   * Опции строятся через createElement/textContent, а не innerHTML-строкой: имя
   * сообщества приходит из данных VK, а экранирования HTML в проекте нет —
   * DOM-API такой поверхности просто не создаёт.
   */
  function buildGuildPicker() {
    const sel = el.guildPicker;
    if (!sel) return;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    const list = Array.isArray(GUILD.roster) ? GUILD.roster : [];
    let n = 0;
    list.forEach((g) => {
      const id = Math.floor(Number(g && g.id) || 0);
      if (id <= 0) return;                              // мусор в конфиге не должен попадать в UI
      const opt = document.createElement('option');
      opt.value = String(id);
      opt.textContent = String((g && g.name) || ('Гильдия #' + id));
      sel.appendChild(opt);
      n++;
    });
    if (!n) {
      const opt = document.createElement('option');
      opt.value = '0';
      opt.textContent = '— нет списка —';
      sel.appendChild(opt);
    }
    sel.value = String(currentGid() || 0);
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
  }

  /**
   * Определение гильдии при запуске. Источник истины — VK, и вот порядок:
   *   • запуск из папки сообщества → vk_group_id ЗАДАЁТ гильдию, перебивая сейв:
   *     игрок явно пришёл из этого сообщества, и старая запись LocalStorage не
   *     имеет права это решение отменять;
   *   • запуск вне сообщества → остаётся S.gid (выбор игрока из roster) или 0.
   * Вызывается ПОСЛЕ vk.ready: до него launch-параметры мостом не прочитаны.
   */
  function initGuild(inVK) {
    guild.role = 'none';
    const vk = VKAPI();
    if (inVK && vk && vk.guildLaunch) {
      let l = null;
      try { l = vk.guildLaunch(); } catch (_) { l = null; }
      if (l && l.groupId > 0) {
        guild.role = l.role || 'none';
        if (currentGid() !== l.groupId) {
          S.gid = l.groupId;
          guild.info = null; guild.photo = '';
          setGuildState(GSTATE.UNKNOWN);
          dirty = true;
          save(true);
        }
      }
    }
    buildGuildPicker();
    renderGuild();
    probeGuild(currentGid());
  }

  /* ======================================================================
   * 14. UI: ТАБЫ, ЗВУК, СБРОС ПРОГРЕССА
   * ==================================================================== */

  /**
   * Переключение табов нижней панели: 'shop' | 'bonus' | 'guild'.
   *
   * Раньше таб был бинарным: «bonus или всё остальное считается shop». С третьим
   * табом такая схема молча показала бы магазин при нажатии на «Гильдию», а
   * подсветка — наоборот, гильдию. Поэтому список табов теперь явный, и тело
   * вкладки ищется по тому же ключу.
   */
  const TAB_BODIES = { shop: 'tabShop', bonus: 'tabBonus', guild: 'tabGuild' };
  let activeTab = 'shop';

  function switchTab(name) {
    const id = TAB_BODIES[name] ? name : 'shop';
    activeTab = id;
    Object.keys(TAB_BODIES).forEach((k) => {
      const node = el[TAB_BODIES[k]];
      if (node) node.hidden = k !== id;
    });
    document.querySelectorAll('.tab').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.tab === id);
    });
    if (id !== 'bonus') el.bonusDot.classList.remove('is-on');
    // Гильдия живёт асинхронными ответами VK: при входе перерисуем сразу, не
    // дожидаясь ближайшего тика, иначе игрок увидит состояние прошлого визита.
    if (id === 'guild') { renderGuild(); renderRaid(); }
    // Скрытый таб метрик не имеет: подсказку «ниже ещё есть» пересчитываем уже
    // после того, как новый таб стал видимым.
    scheduleMoreHint();
  }

  /**
   * Подсказка «ниже ещё есть».
   *
   * Панель обрезана max-height: 42vh, а контента в «Бонусах» и «Гильдии» больше
   * неё — значит что-то гарантированно уехало за нижний край. Полоса скролла в
   * 3px на тач-экране не видна, поэтому пока внизу осталось непросмотренное,
   * на панели горит градиентный обрыв с шевроном (.panel.is-more в style.css).
   *
   * Порог 8px, а не 0: субпиксельные высоты и скругления иначе заставляли бы
   * подсказку мигать на последних пикселях прокрутки.
   */
  function syncMoreHint() {
    const node = el[TAB_BODIES[activeTab]];
    if (!node || !el.panel) return;
    el.panel.classList.toggle('is-more', node.scrollHeight - node.scrollTop - node.clientHeight > 8);
  }

  let moreHintRaf = 0;

  /** Скролл, ресайз и перерисовка карточек сводятся в один кадр: метрики
   *  осмысленны только после layout, а событий за жест бывает несколько. */
  function scheduleMoreHint() {
    if (moreHintRaf) return;
    moreHintRaf = requestAnimationFrame(() => { moreHintRaf = 0; syncMoreHint(); });
  }

  /** Звук вкл/выкл (сохраняется в сейве). */
  function toggleSound() {
    S.sound = !S.sound;
    dirty = true;
    el.btnSound.classList.toggle('is-on', S.sound);
    el.btnSound.classList.toggle('is-off', !S.sound);
    el.btnSound.setAttribute('aria-pressed', String(S.sound));
    if (S.sound) sfx.buy();
    toast(S.sound ? '🔊 Звук включён' : '🔇 Звук выключен', null, 1600);
  }

  /* --- Простая модалька подтверждения (нативный confirm в WebView ненадёжен) --- */
  let modalAction = null;

  function openModal(title, text, okLabel, onOk) {
    el.modalTitle.textContent = title;
    el.modalText.textContent = text;
    el.modalOk.textContent = okLabel;
    modalAction = onOk;
    el.modal.hidden = false;
  }

  function closeModal() {
    el.modal.hidden = true;
    modalAction = null;
  }

  function confirmReset() {
    openModal('Сбросить прогресс?', 'Монеты, уровни апгрейдов и ранг будут удалены навсегда.', 'Сбросить', () => {
      wipe();
      prevRankName = '';
      render();
      save(true);
      // Сброс обязан уйти в облако, иначе при следующем запуске старый
      // прогресс вернётся из VKWebAppStorage и «сброс» потеряет смысл.
      cloudPush(true);
      toast('Прогресс сброшен. Начнём заново 🚀', 'warn');
    });
  }

  /** Единая точка навешивания обработчиков на интерфейс. */
  function bindUI() {
    // Всплывающие «+N»: ОДИН делегированный слушатель на весь слой вместо
    // одноразового на каждый узел (см. floatText / recycleFloat).
    el.floats.addEventListener('animationend', (e) => {
      const node = e.target;
      if (node && node !== el.floats && node.classList && node.classList.contains('float')) recycleFloat(node);
    });

    el.buyClick.addEventListener('click', () => buy('click'));
    el.buyAuto.addEventListener('click', () => buy('auto'));
    el.btnDouble.addEventListener('click', onDoubleIncome);
    el.btnCoins.addEventListener('click', onFreeCoins);
    el.btnShare.addEventListener('click', onShare);
    // --- Соло «Ва-банк»: кнопка и три чипа доли. Делегирование не нужно:
    //     узлы статичны, и прямой обработчик читается ближе. ---
    el.btnRisk.addEventListener('click', playRisk);
    document.querySelectorAll('#riskChips .chip').forEach((b) => {
      b.addEventListener('click', () => { setRiskPick(Number(b.dataset.idx) | 0); sfx.buy(); });
    });
    // --- Гильдия и недельный рейд (раздел 13d). Навеску на узлы, которых может
    //     не быть в урезанном DOM: renderGuild()/renderRaid() тоже с guard'ами.
    //     Молча отсутствующая вкладка безопаснее, чем падение всего bindUI(). ---
    if (el.btnGuildJoin) el.btnGuildJoin.addEventListener('click', () => { joinGuild(); });
    if (el.btnGuildLeave) el.btnGuildLeave.addEventListener('click', () => { leaveGuild(); });
    if (el.guildPicker) {
      el.guildPicker.addEventListener('change', (e) => {
        selectGuild(Number(e && e.target && e.target.value) | 0);
      });
    }
    if (el.btnRaidRedeem) el.btnRaidRedeem.addEventListener('click', () => { redeemHonor(); });

    el.btnSound.addEventListener('click', toggleSound);
    el.btnReset.addEventListener('click', confirmReset);
    document.querySelectorAll('.tab').forEach((b) => {
      b.addEventListener('click', () => switchTab(b.dataset.tab));
    });
    // --- Подсказка «ниже ещё есть» (.panel.is-more). Источников три: сам
    //     скролл таба, рост/падение окна и любая смена высоты карточек —
    //     перерисовка заметок, приход буста, ответы VK по гильдии. Последнее
    //     закрывает ResizeObserver, которого нет в старых WebView и в jsdom:
    //     без него остаются scroll и resize, покрывающие жест игрока.
    Object.keys(TAB_BODIES).forEach((k) => {
      const node = el[TAB_BODIES[k]];
      if (node) node.addEventListener('scroll', scheduleMoreHint, { passive: true });
    });
    window.addEventListener('resize', scheduleMoreHint, { passive: true });
    if (typeof ResizeObserver === 'function') {
      const moreRo = new ResizeObserver(scheduleMoreHint);
      Object.keys(TAB_BODIES).forEach((k) => {
        const node = el[TAB_BODIES[k]];
        if (node) moreRo.observe(node);
      });
    }
    scheduleMoreHint();
    el.modalCancel.addEventListener('click', closeModal);
    el.modal.addEventListener('click', (e) => { if (e.target === el.modal) closeModal(); });
    el.modalOk.addEventListener('click', () => {
      const action = modalAction;
      closeModal();
      if (action) action();
    });

    // Долгий тап по монете — шарим игру (вирусная петля, опционально).
    let pressTimer = 0;
    const startHold = () => {
      pressTimer = setTimeout(() => {
        // Тот же путь, что и кнопка «Репост»: награда, лимит и кулдаун
        // считаются в одном месте, а не в двух копиях.
        if (window.VK) onShare();
      }, 900);
    };
    const cancelHold = () => clearTimeout(pressTimer);
    el.coin.addEventListener('pointerdown', startHold);
    window.addEventListener('pointerup', cancelHold);
    window.addEventListener('pointercancel', cancelHold);
    window.addEventListener('scroll', cancelHold, { passive: true });
  }

  /* ======================================================================
   * 15. АНТИЧИТ — подпись сейва и границы правдоподобия
   *
   * Защита рассчитана на честного игрока-наблюдателя: правка LocalStorage и
   * облачного значения «в лоб» ловится подписью, а величина «нарисованных»
   * монет упирается в потолок правдоподобия. Потолок считается ЗАВЫШЕННО
   * (все клики — криты с максимальной серией, пассивка — всегда под ×2),
   * поэтому ложных срабатываний на легальном прогрессе не бывает.
   * Нарушения не блокируют интерфейс: они лишь тихо режут начисления и
   * копят счётчик S.susp — по нему потом можно разобраться на сервере.
   * ==================================================================== */

  const SIGN_SALT = 'neonclick.v1.a7f3';

  /** 32-битный FNV-1a: цельная подпись без зависимостей и тяжёлой криптографии. */
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
  }

  /**
   * Каноническая подпись состояния. Поле sig в неё намеренно не входит.
   *
   * ★ ВЕРСИИ СХЕМЫ. Сейвы v1 подписаны по набору полей БЕЗ репоста (их в них
   * просто не было). Если считать подпись v2-набором, каждый честный игрок с
   * накопленным прогрессом при первом же запуске обновления получил бы
   * susp++ и предупреждение о повреждённом сейве. Поэтому набор полей
   * выбирается по версии данных, а не по версии кода.
   */
  function signatureOf(d) {
    const fields = [
      d.v, d.coins, d.total, d.clicks, d.upClick, d.upAuto,
      d.boostUntil, d.watched, d.susp, d.t0, d.lastSeen
    ];
    if (Number(d.v) >= 2) fields.push(d.shares, d.shareDay, d.shareN);
    // v:3 — хвост ДОБАВЛЯЕТСЯ, старые поля не переставляются и не выкидываются.
    // Иначе каждый существующий сейв v2 при первом запуске обновления получил
    // бы расхождение подписи и молча приписал себе нарушение susp — ровно тот
    // же класс ошибки, что «перекрасить игру = сбросить прогресс».
    if (Number(d.v) >= 3) {
      fields.push(d.riskDay, d.riskN, d.riskWins, d.riskLoss,
        d.riskBurned, d.rpStake, d.rpWon, d.rpIdx);
    }
    // v:4 — хвост гильдии и рейда. СНОВА ДОБАВЛЯЕТСЯ в конец: старые поля не
    // двигаются и не выкидываются. Тот же класс ошибки, что и выше: каждый
    // существующий сейв v3 при первом запуске обновления получил бы расхождение
    // подписи и молча приписал себе нарушение susp.
    if (Number(d.v) >= 4) {
      fields.push(d.gid, d.gState, d.rdWeek, d.rdEarned, d.rdHonor,
        d.rdBest, d.rdTries, d.rdLife, d.rdRedeemed, d.rdRedN);
    }
    return fnv1a(SIGN_SALT + '|' + fields.join(','));
  }

  /** Верхняя оценка того, сколько можно было заработать легально к этому моменту. */
  function plausibleCap(d, now) {
    const perClickMax = (CFG.click.base + d.upClick * CFG.click.perLevel)
      * (1 + CFG.combo.maxStack * CFG.combo.perStackBonus) * CFG.crit.mult;
    const seconds = Math.max(0, (now - (d.t0 || now)) / 1000);
    const passiveMax = d.upAuto * CFG.auto.perLevel * CFG.boost.mult * seconds;
    const adsMax = d.watched * CFG.freeCoinsReward;
    // ★ Репосты ОБЯЗАНЫ быть в потолке. Без этой строки легальные 3×500 монет
    //   в сутки античит списал бы как накрутку и срезал бы — то есть фича
    //   молча отнимала бы прогресс у самой активной аудитории.
    const shareMax = (d.shares || 0) * CFG.share.reward;
    return d.clicks * perClickMax + passiveMax + adsMax + shareMax;
  }

  /**
   * Приводит состояние к правдоподобному. Возвращает число исправленных
   * аномалий — вызывающий прибавляет их в S.susp.
   */
  function sanitize(d) {
    const A = CFG.anticheat;
    const now = Date.now();
    let fixes = 0;
    // Сейвы старых версий поля t0 не имеют: для них потолок правдоподобия НЕ
    // считаем вовсе. Иначе при первом же запуске обновления честный игрок
    // потерял бы прогресс — t0 был бы равен lastSeen, а «жизнь аккаунта» — нулю.
    const legacyT0 = !(Number(d.t0) > 0);
    const clamp = (value, lo, hi) => {
      const n = Number(value);
      if (!isFinite(n) || n < lo || n > hi) { fixes++; return Math.max(lo, Math.min(hi, isFinite(n) ? n : lo)); }
      return n;
    };
    d.upClick = Math.floor(clamp(d.upClick, 0, A.maxLevel));
    d.upAuto = Math.floor(clamp(d.upAuto, 0, A.maxLevel));
    d.clicks = Math.floor(clamp(d.clicks, 0, 1e12));
    d.watched = Math.floor(clamp(d.watched, 0, 1e7));
    // Поля репоста: shares монотонный (потолок правдоподобия считается от него),
    // shareN ограничен суточным лимитом — больше perDay в сейве быть не может
    // ни при каких честных обстоятельствах.
    d.shares = Math.floor(clamp(d.shares, 0, 1e7));
    d.shareDay = Math.floor(clamp(d.shareDay, 0, 1e7));
    d.shareN = Math.floor(clamp(d.shareN, 0, CFG.share.perDay));
    d.susp = Math.floor(clamp(d.susp, 0, 1e7));
    d.coins = clamp(d.coins, 0, Number.MAX_SAFE_INTEGER);
    d.total = clamp(d.total, 0, Number.MAX_SAFE_INTEGER);
    d.boostUntil = clamp(d.boostUntil, 0, now + A.maxBoostAheadMs);
    if (d.lastSeen > now + A.clockSkewMs) { d.lastSeen = now; fixes++; }   // часы из будущего
    if (legacyT0) d.t0 = Math.max(0, d.lastSeen - A.legacyT0Ms);           // «аккаунту как минимум 30 суток»
    else if (d.t0 > d.lastSeen) d.t0 = d.lastSeen;
    // total — «всего заработано»: он никогда не бывает меньше текущего баланса.
    if (d.coins > d.total) { d.coins = d.total; fixes++; }
    // Потолок правдоподобия — только в боевом режиме. В отладке (DEBUG=true в
    // локальной сборке) им пользуются тесты и разработка, которые умеют рисовать
    // монеты напрямую: сравнивать такие начисления с «жизнью аккаунта» бессмысленно.
    if (!legacyT0 && !DEBUG) {
      const cap = plausibleCap(d, now) * A.slack + 1000;
      if (d.total > cap) { d.total = cap; d.coins = Math.min(d.coins, cap); fixes++; }
    }
    // --- Риск-раунд (раздел 13c) ---
    // Порядок ВАЖЕН: этот блок идёт ПОСЛЕ потолка правдоподобия, потому что
    // опирается на окончательное d.total.
    d.riskDay = Math.floor(clamp(d.riskDay, 0, 1e7));
    d.riskN = Math.floor(clamp(d.riskN, 0, CFG.risk.perDay));   // больше лимита в сутки быть не может
    d.riskWins = Math.floor(clamp(d.riskWins, 0, 1e7));
    d.riskLoss = Math.floor(clamp(d.riskLoss, 0, 1e7));
    d.riskBurned = clamp(d.riskBurned, 0, d.total);             // сгореть больше, чем заработано, нельзя
    // Незакрытая ставка — ЭТО БУДУЩИЙ ВОЗВРАТ, то есть кран монет. Оставляем
    // только в разумных границах: не больше всего когда-либо заработанного.
    // Второй барьер — в closeRiskRound().
    d.rpStake = Math.floor(clamp(d.rpStake, 0, d.total));
    d.rpWon = Math.floor(clamp(d.rpWon, 0, 1));
    d.rpIdx = Math.floor(clamp(d.rpIdx, 0, Math.max(0, Math.min(CFG.risk.stakes.length, CFG.risk.boostMs.length) - 1)));
    // --- Гильдия и недельный рейд (раздел 13d) ---
    d.gid = Math.floor(clamp(d.gid, 0, 1e12));                 // id сообщества VK — до 12 знаков
    d.gState = Math.floor(clamp(d.gState, 0, 2));              // вне перечисленных 0|1|2 значения нет
    d.rdWeek = Math.floor(clamp(d.rdWeek, 0, 1e7));
    // Журнал недели — ЧАСТЬ подтверждённого заработка, поэтому больше S.total он
    // быть не может ни при каких честных обстоятельствах (тот же барьер, что у
    // riskBurned, и то же требование: идти ПОСЛЕ потолка правдоподобия).
    d.rdEarned = clamp(d.rdEarned, 0, d.total);
    // Честь монетой не является, но покупает ВРЕМЯ буста, значит обязана быть
    // ограничена сверху пожизненно накопленной: из нарисованного остатка не
    // должно появляться буста больше, чем когда-либо заработано.
    d.rdLife = clamp(d.rdLife, 0, 1e7);
    d.rdBest = clamp(d.rdBest, 0, d.rdLife);
    d.rdHonor = clamp(d.rdHonor, 0, d.rdLife);
    d.rdTries = Math.floor(clamp(d.rdTries, 0, 1e6));
    d.rdRedeemed = Math.floor(clamp(d.rdRedeemed, 0, 1e7));
    d.rdRedN = Math.floor(clamp(d.rdRedN, 0, CFG.raid.perDay));  // больше лимита в сутки быть не может
    return fixes;
  }

  /* --- Скользящее окно засчитанных кликов ---
   * Считаем по МОНОТОННЫМ часам (performance.now), а не по Date.now(): иначе
   * перевод системного времени на устройстве сбрасывал бы окно и лимитер
   * пропускал автокликер. Настенные часы остаются только для экономики. */
  const clickWindow = [];
  const monoNow = () => (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();

  /** true — клик узаконен; false — это автокликер, начисления не будет. */
  function clickPaid() {
    const A = CFG.anticheat;
    const t = monoNow();
    while (clickWindow.length && t - clickWindow[0] > A.windowMs) clickWindow.shift();
    if (clickWindow.length >= A.maxClicksPerSec) return false;
    clickWindow.push(t);
    return true;
  }

  /* ======================================================================
   * 16. ОБЛАЧНАЯ СИНХРОНИЗАЦИЯ ПРОГРЕССА (VKWebAppStorage)
   *
   * LocalStorage живёт на устройстве: переустановка VK или вход с нового
   * телефона обнуляли прогресс. VKWebAppStorage* хранит значение на стороне
   * VK и привязано к пользователю — прогресс переезжает за ним.
   *
   * Правила, которые диктуют лимиты VK (1000 вызовов в час, 4096 символов):
   *   • пишем не чаще раза в CFG.cloud.everyMs (45 сек) ≈ 80 вызовов в час;
   *   • держим собственный бюджет maxCallsPerHour = 700 — с запасом;
   *   • после неудачи — бэкофф на retryMs;
   *   • значение упаковано в ~110 символов с подписью, до 4096 далеко;
   *   • вне клиента VK облако просто выключено, игра работает как раньше.
   * ==================================================================== */

  const cloud = {
    on: false,        // хранилище доступно (мы в VK и клиент его поддерживает)
    fresh: true,      // локального сейва не было (новый телефон / переустановка VK)
    busy: false,      // запрос к облаку в полёте
    pending: false,   // есть изменения, которые ещё не ушли в облако
    pulled: false,    // однократное чтение при старте
    lastWrite: 0,
    nextAt: 0,        // раньше этой поры к облаку не обращаемся (бэкофф)
    calls: [],        // метки вызовов за последний час
    state: ''         // '' | 'sync' | 'wait' | 'err' — для статусной точки
  };

  const CLOUD_TITLES = {
    '': 'Облако VK недоступно: прогресс хранится на устройстве',
    sync: 'Прогресс синхронизирован с облаком VK',
    wait: 'Отправляем прогресс в облако VK…',
    err: 'Облако VK не отвечает: прогресс сохранён на устройстве'
  };

  /** Статусная точка в шапке: игрок видит, что прогресс уходит в облако VK. */
  function setCloudState(value) {
    if (cloud.state === value) return;
    cloud.state = value;
    const node = el.cloudDot;
    if (!node) return;
    node.className = 'cloud-dot' + (value ? ' cloud-dot--' + value : '');
    node.title = CLOUD_TITLES[value] || CLOUD_TITLES[''];
    node.hidden = false;
  }

  /**
   * Упаковка состояния для облака:
   * v4: "4|coins|…|rpIdx|gid|gState|rdWeek|rdEarned|rdHonor|rdBest|rdTries|rdLife|rdRedeemed|rdRedN#crc"
   * v3 (читается, но больше не пишется): те же поля без последних десяти.
   * v2 (читается, но больше не пишется): те же поля без восьми риск-раунда.
   * v1 (читается, но больше не пишется): без трёх полей репоста тоже.
   * Новые поля ДОБАВЛЯЮТСЯ В ХВОСТ — выкидывать или переставлять старые нельзя,
   * иначе любой уже лежащий в VK пакет стал бы нечитаемым.
   * Дробная часть монет отбрасывается (потеря не больше 1 монеты), зато значение
   * гарантированно влезает в лимит VK и не растёт без причины.
   */
  function packCloud(d) {
    const body = [
      d.v, Math.floor(d.coins), Math.floor(d.total), Math.floor(d.clicks),
      Math.floor(d.upClick), Math.floor(d.upAuto), Math.floor(d.boostUntil),
      Math.floor(d.watched), d.sound ? 1 : 0, Math.floor(d.susp),
      Math.floor(d.t0), Math.floor(d.lastSeen),
      Math.floor(d.shares || 0), Math.floor(d.shareDay || 0), Math.floor(d.shareN || 0),
      Math.floor(d.riskDay || 0), Math.floor(d.riskN || 0), Math.floor(d.riskWins || 0),
      Math.floor(d.riskLoss || 0), Math.floor(d.riskBurned || 0),
      Math.floor(d.rpStake || 0), Math.floor(d.rpWon || 0), Math.floor(d.rpIdx || 0),
      // v:4 — хвост гильдии и рейда (10 полей, всего 33). Добавлен в КОНЕЦ:
      // порядок старых 23 не двигается, иначе пакеты v3 стали бы нечитаемыми.
      Math.floor(d.gid || 0), Math.floor(d.gState || 0), Math.floor(d.rdWeek || 0),
      Math.floor(d.rdEarned || 0), Math.floor(d.rdHonor || 0), Math.floor(d.rdBest || 0),
      Math.floor(d.rdTries || 0), Math.floor(d.rdLife || 0),
      Math.floor(d.rdRedeemed || 0), Math.floor(d.rdRedN || 0)
    ].join('|');
    return body + '#' + fnv1a(SIGN_SALT + '#' + body);
  }

  /** Распаковка облачного значения. null — такое состояние мы не принимаем. */
  function unpackCloud(str) {
    if (typeof str !== 'string' || !str || str.length > CFG.cloud.valueMax) return null;
    const at = str.lastIndexOf('#');
    if (at <= 0 || at === str.length - 1) return null;
    const body = str.slice(0, at);
    if (fnv1a(SIGN_SALT + '#' + body) !== str.slice(at + 1)) return null;  // подмена или обрезка VK
    const p = body.split('|');
    const n = p.map(Number);
    // backward compatibility: v1 — 12 полей, v2 — 15. Новый код ОБЯЗАН читать
    // пакеты старой версии, иначе у всех уже играющих прогресс в VK станет
    // нечитаемым («сбросился в ноль» на глазах у игрока).
    const isV1 = p.length === 12 && n[0] === 1;
    const isV2 = p.length === 15 && n[0] === 2;
    const isV3 = p.length === 23 && n[0] === 3;
    const isV4 = p.length === 33 && n[0] === 4;
    if (!isV1 && !isV2 && !isV3 && !isV4) return null;        // чужая версия схемы
    if (n.some((x) => !isFinite(x) || x < 0)) return null;
    const d = {
      v: n[0], coins: n[1], total: n[2], clicks: n[3], upClick: n[4], upAuto: n[5],
      boostUntil: n[6], watched: n[7], sound: n[8] === 1, susp: n[9], t0: n[10],
      lastSeen: n[11], sig: '',
      shares: (isV2 || isV3) ? n[12] : 0, shareDay: (isV2 || isV3) ? n[13] : 0, shareN: (isV2 || isV3) ? n[14] : 0,
      // Пакет v3 привозит незакрытый раунд. Из v1/v2 взять нечего — 0, «раунда
      // нет»: потеря возврата при апдейте через старое облако предпочтительнее,
      // чем выдуманный возврат.
      riskDay: isV3 ? n[15] : 0, riskN: isV3 ? n[16] : 0, riskWins: isV3 ? n[17] : 0,
      riskLoss: isV3 ? n[18] : 0, riskBurned: isV3 ? n[19] : 0,
      rpStake: isV3 ? n[20] : 0, rpWon: isV3 ? n[21] : 0, rpIdx: isV3 ? n[22] : 0,
      // Пакет v4 привозит гильдию и рейд. Из v1/v2/v3 взять нечего — 0: «вне
      // гильдии, неделя ещё не ведётся». Выдуманная здесь принадлежность или
      // начисленная честь стоили бы игроку привилегии, которой он не зарабатывал.
      gid: isV4 ? n[23] : 0, gState: isV4 ? n[24] : 0, rdWeek: isV4 ? n[25] : 0,
      rdEarned: isV4 ? n[26] : 0, rdHonor: isV4 ? n[27] : 0, rdBest: isV4 ? n[28] : 0,
      rdTries: isV4 ? n[29] : 0, rdLife: isV4 ? n[30] : 0,
      rdRedeemed: isV4 ? n[31] : 0, rdRedN: isV4 ? n[32] : 0
    };
    sanitize(d);
    return d;
  }

  /** Не превысили ли мы собственный почасовой бюджет обращений к хранилищу. */
  function cloudBudgetOk(now) {
    while (cloud.calls.length && now - cloud.calls[0] > 3600000) cloud.calls.shift();
    return cloud.calls.length < CFG.cloud.maxCallsPerHour;
  }

  /**
   * Слияние облачного сейва с локальным. Побеждает более свежий по lastSeen,
   * но монотонные счётчики откатывать нельзя: иначе второе устройство с
   * устаревшим прогрессом «стёрло» бы результат первого.
   * @returns {{remoteWins:boolean, changed:boolean}}
   */
  function mergeCloud(r) {
    const before = packCloud(S);
    const now = Date.now();
    // Побеждает облако, если у нас чистый старт (новый телефон: локальный
    // lastSeen всё равно «свежее» облачного — он равен моменту запуска), либо
    // если удалённый прогресс реально новее.
    const remoteWins = cloud.fresh || (r.lastSeen || 0) > (S.lastSeen || 0) + 2000;
    const win = remoteWins ? r : S;
    const other = remoteWins ? S : r;
    const next = Object.assign({}, win);
    next.coins = win.coins;                                 // баланс — только у победителя, складывать нельзя
    next.total = Math.max(win.total, other.total);
    next.clicks = Math.max(win.clicks, other.clicks);
    next.watched = Math.max(win.watched, other.watched);
    next.shares = Math.max(win.shares || 0, other.shares || 0);
    // Суточный счётчик НЕ монотонен (сбрасывается на новых сутках), поэтому
    // брать max нельзя: старое облако с вчерашним shareN отняло бы сегодня
    // лимит. Переносим пару (shareDay, shareN) только если она СВЕЖЕЕ нашей.
    const wd = win.shareDay || 0, od = other.shareDay || 0;
    if (od > wd) { next.shareDay = od; next.shareN = other.shareN || 0; }
    else { next.shareN = Math.max(win.shareN || 0, od === wd ? (other.shareN || 0) : 0); }
    // --- Риск-раунд (раздел 13c) ---
    // Монотонные счётчики — max, как shares: откатывать их нельзя, иначе
    // «проигранное» вернётся с другого устройства.
    next.riskWins = Math.max(win.riskWins || 0, other.riskWins || 0);
    next.riskLoss = Math.max(win.riskLoss || 0, other.riskLoss || 0);
    next.riskBurned = Math.max(win.riskBurned || 0, other.riskBurned || 0);
    // Пара (riskDay, riskN) НЕ монотонна — сбрасывается на новых сутках,
    // поэтому тот же приём, что у shareDay/shareN: переносим только если свежее.
    const rkd = win.riskDay || 0, okr = other.riskDay || 0;
    if (okr > rkd) { next.riskDay = okr; next.riskN = other.riskN || 0; }
    else { next.riskN = Math.max(win.riskN || 0, okr === rkd ? (other.riskN || 0) : 0); }
    // Незакрытый раунд принадлежит ТОМУ же состоянию, что и баланс: ставка уже
    // списана у победителя. Складывать или брать max нельзя — это удвоило бы
    // возврат из денег, которых в игре нет.
    next.rpStake = win.rpStake || 0;
    next.rpWon = win.rpWon || 0;
    next.rpIdx = win.rpIdx || 0;
    // --- Гильдия и рейд (раздел 13d) ---
    // Принадлежность принадлежит ПОБЕДИТЕЛЮ, а не максимуму: max по gid свёл бы
    // «выйти из гильдии» к «снова вступить в неё» на втором устройстве.
    next.gid = win.gid || 0;
    next.gState = win.gState || 0;
    // Пожизненные итоги рейда монотонны — max, как shares/riskWins.
    next.rdBest = Math.max(win.rdBest || 0, other.rdBest || 0);
    next.rdTries = Math.max(win.rdTries || 0, other.rdTries || 0);
    next.rdLife = Math.max(win.rdLife || 0, other.rdLife || 0);
    // Остаток чести НЕ монотонен (он тратится), но и складывать его нельзя:
    // сумма двух устройств купила бы больше буста, чем когда-либо заработано.
    // Берём максимум и клампим пожизненной честью сверху.
    next.rdHonor = Math.min(next.rdLife, Math.max(win.rdHonor || 0, other.rdHonor || 0));
    // Пара (rdWeek, rdEarned) монотонности не имеет — журнал обнуляется на новой
    // неделе: переносим только если свежее (тот же приём, что shareDay/riskDay).
    const rdw = win.rdWeek || 0, odw = other.rdWeek || 0;
    if (odw > rdw) { next.rdWeek = odw; next.rdEarned = other.rdEarned || 0; }
    else { next.rdWeek = rdw; next.rdEarned = Math.max(win.rdEarned || 0, odw === rdw ? (other.rdEarned || 0) : 0); }
    const rdd = win.rdRedeemed || 0, odd = other.rdRedeemed || 0;
    if (odd > rdd) { next.rdRedeemed = odd; next.rdRedN = other.rdRedN || 0; }
    else { next.rdRedN = Math.max(win.rdRedN || 0, odd === rdd ? (other.rdRedN || 0) : 0); }
    // Версия схемы — ТЕКУЩАЯ. Поле v приехало из пакета победителя, и если это
    // старый v1/v2/v3, S получил бы старый номер, а packCloud пишет полный набор
    // полей v4: на выходе вышел бы пакет «1|…от 33 полей», который unpackCloud
    // отбрасывает как чужую версию — облачный прогресс стал бы нечитаемым
    // молча. Ловушка жила здесь ещё до v3 (v1-пакет + v2-записыватель).
    next.v = SCHEMA_V;
    next.susp = Math.max(win.susp, other.susp);
    next.boostUntil = Math.max(win.boostUntil, other.boostUntil);
    next.t0 = Math.min(win.t0 || now, other.t0 || now);
    next.lastSeen = Math.max(win.lastSeen || 0, other.lastSeen || 0);
    next.sig = '';
    if (next.coins > next.total) next.coins = next.total;
    Object.keys(S).forEach((k) => { if (k in next) S[k] = next[k]; });
    return { remoteWins, changed: before !== packCloud(S) };
  }

  /** Офлайн-доход начисляется ровно один раз за сессию — после слияния с облаком. */
  let offlineApplied = false;
  function applyOfflineOnce() {
    if (offlineApplied) return;
    offlineApplied = true;
    applyOfflineEarnings();
  }

  /** Однократное чтение облака при старте: «продолжить с другого устройства». */
  async function cloudPull() {
    if (cloud.pulled || !cloud.on) return false;
    cloud.pulled = true;
    const vk = VKAPI();
    if (!vk || !vk.storageGet) return false;
    cloud.busy = true;
    setCloudState('wait');
    let map = null;
    try { map = await vk.storageGet([CFG.cloud.key]); } catch (_) { map = null; }
    cloud.busy = false;
    if (!map) { setCloudState('err'); applyOfflineOnce(); return false; }
    const raw = map[CFG.cloud.key];
    if (!raw) { setCloudState('sync'); applyOfflineOnce(); return false; }   // облако пусто — первый запуск
    const remote = unpackCloud(raw);
    if (!remote) {
      setCloudState('err');
      applyOfflineOnce();
      toast('☁ Облачный сейв повреждён — продолжаем с локального прогресса', 'warn', 4200);
      return false;
    }
    const res = mergeCloud(remote);
    cloud.fresh = false;
    // Слияние могло принести незакрытый раунд с другого устройства (rp* едут
    // только от победителя по lastSeen) — доигрываем его сразу, пока игрок не
    // увидел баланс без возврата. Идемпотентно: на boot этот же раунд уже
    // закрыт, если он был локальным.
    resumeRiskRound();
    if (res.remoteWins) {
      // Офлайн-доход считаем УЖЕ от слитого состояния, а не от устаревшего локального.
      applyOfflineOnce();
      prevRankName = '';
      render();
      save(true);
      setCloudState('sync');
      if (res.changed) toast('☁ Прогресс восстановлен из облака VK: ' + fmt(Math.floor(S.coins)) + ' монет', 'good', 4200);
      return true;
    }
    if (res.changed) { save(true); cloud.pending = true; setCloudState('wait'); }  // локальный свежее — отправим
    else setCloudState('sync');
    applyOfflineOnce();
    return false;
  }

  /**
   * Запись в облако. force — при уходе в фон и сразу после награды; троттлинг
   * соблюдается всегда, иначе лимит VK (1000 вызовов/час) сгорает за минуты.
   */
  async function cloudPush(force) {
    if (!cloud.on || cloud.busy || !cloud.pending) return false;
    // Не отправляем прогресс, пока хоть раз НЕ прочитали облако. Push до pull
    // перезаписал бы удалённый (возможно, более свежий) пакет локальным, и игрок
    // потерял бы прогресс второго устройства — молча. Окно было узким и до
    // гильдий, но асинхронный probeGuild при запуске его расширяет: статус
    // членства приходит из моста VK через десятки миллисекунд и помечает сейв
    // грязным именно в этом интервале.
    if (!cloud.pulled) return false;
    const now = Date.now();
    if (now < cloud.nextAt) return false;
    if (!cloudBudgetOk(now)) { setCloudState('err'); return false; }
    if (now - cloud.lastWrite < (force ? CFG.cloud.minGapMs : CFG.cloud.everyMs)) return false;
    const vk = VKAPI();
    if (!vk || !vk.storageSet) return false;
    cloud.busy = true;
    setCloudState('wait');
    cloud.calls.push(now);
    let ok = false;
    try { ok = await vk.storageSet(CFG.cloud.key, packCloud(S)); } catch (_) { ok = false; }
    cloud.busy = false;
    cloud.lastWrite = Date.now();
    if (ok) { cloud.pending = false; setCloudState('sync'); return true; }
    cloud.nextAt = Date.now() + CFG.cloud.retryMs;            // бэкофф после неудачи
    setCloudState('err');
    return false;
  }

  /* ======================================================================
   * 17. ЗАПУСК ИГРЫ
   * ==================================================================== */

  function boot() {
    const hadSave = load();
    cloud.fresh = !hadSave;   // чистый старт → облако имеет приоритет
    // Раунд, оборванный закрытием приложения, доигрывается ДО первого пейнта:
    // иначе игрок увидел бы баланс «с уже списанной, но ещё не возвращённой
    // ставкой» — а это и есть тот самый тихий отъём выигрыша, от которого
    // защищает write-ahead (инвариант 2 раздела 13c).
    resumeRiskRound();
    // Неделя, истёкшая во время отсутствия, закрывается ДО офлайн-дохода: иначе
    // заработок вчерашнего дня попал бы в журнал СЕГОДНЯШНЕЙ недели и зачёл бы
    // честь по новым правилам. Порядок «сначала закрытие, потом начисление» —
    // единственный детерминированный из доступных на клиенте.
    settleRaid();
    buildGuildPicker();

    resizeFx();
    measureStage();
    bindCoin();
    bindUI();

    el.btnSound.classList.toggle('is-on', S.sound);
    el.btnSound.classList.toggle('is-off', !S.sound);
    el.btnSound.setAttribute('aria-pressed', String(S.sound));

    render();

    // ★ Офлайн-доход: ждём слияния с облаком (иначе начислим от устаревшего
    //   локального lastSeen), но не дольше CFG.cloud.pullFallbackMs.
    setTimeout(applyOfflineOnce, CFG.cloud.pullFallbackMs);

    // ★ Игровой тик (пассивный доход) — 5 раз в секунду по реальному времени.
    lastTickAt = Date.now();
    setInterval(tick, CFG.tickMs);

    // ★ Автосохранение прогресса каждую секунду (по требованию ТЗ) + попытка
    //   уйти в облако VK: внутри cloudPush свой троттлинг (45 сек), лимит VK
    //   1000 вызовов/час мы не приближаем.
    setInterval(() => { save(false); cloudPush(false); }, CFG.saveEveryMs);

    // Бережём прогресс при уходе приложения в фон/закрытии. LocalStorage —
    // синхронная запись (гарантирована), облако тут best-effort: если WebView
    // успеет замёрзнуть до ответа VK, догоним при следующем запуске.
    const flush = () => { save(true); cloudPush(true); };
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    window.addEventListener('vk:viewhide', flush);

    // Пересчёт геометрии сцены/канваса.
    let rt = 0;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => { resizeFx(); measureStage(); }, 150);
    });

    // ---- Интеграция с VK ----
    const vk = VKAPI();
    if (vk && vk.ready) {
      vk.ready.then(async (inVK) => {
        refreshAdAvailability();
        initGuild(inVK);
        if (!inVK && vk.isDemo()) {
          toast('🧪 Демо-режим: открыто вне VK. Награды за «рекламу» выдаются сразу.', 'warn', 5000);
        }
        // ---- Облако VK: только внутри клиента и только если он его поддерживает
        if (inVK && vk.hasStorage) {
          try { cloud.on = !!(await vk.hasStorage()); } catch (_) { cloud.on = false; }
        }
        if (cloud.on) await cloudPull();
        else { setCloudState(''); applyOfflineOnce(); }
      }).catch(() => { refreshAdAvailability(); initGuild(false); applyOfflineOnce(); });
    } else {
      refreshAdAvailability();
      initGuild(false);
      applyOfflineOnce();
    }

    if (!hadSave) {
      setTimeout(() => toast(TM().copy.tapNudge + ' Первый апгрейд стоит ' + fmt(costOf('click')) + ' ' + TM().cur + ' ' + TM().glyph, 'good', 5000), 700);
    }

    // >>> RELEASE-STRIP HOOK_BEGIN
    // Отладочный хук: NEON.state(), NEON.tap(), NEON.add(1000), NEON.save().
    // ★ Создается ТОЛЬКО при ?debug=1: в бою игрок не должен иметь возможности
    //   нарисовать себе монеты из консоли (раньше этот дырявый вход был всегда).
    // ★ В БОЕВОМ АРТЕФАКТЕ ЭТОГО БЛОКА НЕТ: tools/build-release.cjs вырезает
    //   регион между маркерами целиком и проверяет, что window.NEON в _site/
    //   не осталось. Причина, почему одного ?debug=1 мало: параметр виден в
    //   исходниках игры, а чтение монеточек из консоли — самый первый вопрос
    //   любого, кто откроет девтулзы в WebView.
    if (DEBUG) {
      window.NEON = {
        state: () => S,
        save: () => save(true),
        add: (n) => { earn(Number(n) || 0); render(); },
        tap: (clientX, clientY) => {
          if (!stageRect) measureStage();
          handleClick(
            typeof clientX === 'number' ? clientX : stageRect.left + stageRect.width / 2,
            typeof clientY === 'number' ? clientY : stageRect.top + stageRect.height / 2
          );
        },
        render: render,
        switchTab: (n) => switchTab(n),
        tab: () => activeTab,
        cloud: () => ({ on: cloud.on, pending: cloud.pending, state: cloud.state, calls: cloud.calls.length }),
        pack: () => packCloud(S),
        unpack: (s) => unpackCloud(s),          // проверка миграции схем v1/v2
        clearCooldown: () => { adLastShown.boost = adLastShown.coins = adLastShown.share = 0; },
        // --- Соло «Ва-банк» (только под ?debug=1, как и весь хук) ---
        // Тесты подменяют Math.random и вызывают playRisk(), затем читают сейв:
        // без прямого доступа к незакрытому раунду проверить write-ahead
        // (инвариант 2) невозможно — он существует ровно 900 мс.
        risk: () => ({
          pick: riskPick, quota: riskLeft(), stake: riskStakeOf(riskPick),
          block: riskBlock(riskPick), pending: S.rpStake, won: S.rpWon, idx: S.rpIdx,
          wins: S.riskWins, loss: S.riskLoss, burned: S.riskBurned, day: S.riskDay
        }),
        setRiskPick: setRiskPick,
        playRisk: () => playRisk(),
        riskClose: () => closeRiskRound(),
        // --- Гильдия и недельный рейд (только под ?debug=1, как и весь хук) ---
        // Тесты обязаны уметь: (а) сымитировать истёкшую неделю, (б) проверить
        // идемпотентность закрытия, (в) упереться в суточный лимит обменов —
        // всё это события масштаба 7 дней и вызывать «живьём» невозможно.
        guild: () => ({
          gid: currentGid(), state: S.gState | 0, role: guild.role,
          probed: guild.probed, busy: guild.busy,
          name: guild.info ? guild.info.name : '', available: GuildProvider.available()
        }),
        raid: () => ({
          week: S.rdWeek | 0, now: weekIndex(), earned: Math.floor(S.rdEarned || 0),
          pending: Math.floor((S.rdEarned || 0) / honorStep()),
          honor: Math.floor(S.rdHonor || 0), life: Math.floor(S.rdLife || 0),
          best: Math.floor(S.rdBest || 0), tries: S.rdTries | 0,
          tier: raidTier().name, left: raidRedeemLeft(), block: raidRedeemBlock()
        }),
        /** Откатываем rdWeek на n недель назад и закрываем: имитация истёкшей недели. */
        advanceWeek: (n) => {
          S.rdWeek = Math.max(1, weekIndex() - (Math.floor(Number(n) || 1)));
          const r = settleRaid();
          render();
          return r;
        },
        settleRaid: () => settleRaid(),
        redeemHonor: () => redeemHonor(),
        selectGuild: (id) => selectGuild(id),
        joinGuild: () => joinGuild(),
        leaveGuild: () => leaveGuild(),
        probeGuild: (id) => probeGuild(id == null ? currentGid() : id),
        /* Слияние с «облаком» другого устройства. remoteWins=true детерминированно
           делает победителем приехавший пакет (тот же флаг, что ставит чистый
           старт на новом телефоне), false — оставляет победителем локальный.
           Без этого хука правила слияния v4-полей проверять было бы нечем:
           в живом VK исход зависит от рассинхрона часов. */
        merge: (packStr, remoteWins) => {
          const r = typeof packStr === 'string' ? unpackCloud(packStr) : packStr;
          if (!r) return null;
          const keep = cloud.fresh;
          cloud.fresh = !!remoteWins;
          const res = mergeCloud(r);
          cloud.fresh = keep;
          save(true);
          render();
          return res;
        },
        cfg: CFG,
        // ---- ТЕМЫ (только под ?debug=1, как и весь хук) ----
        themes: () => Object.keys(THEMES),
        themeOf: (id) => THEMES[id] || null,
        theme: () => ({
          id: activeTheme,
          copyKeys: Object.keys(TM().copy),
          accent: getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim(),
          bgTop: getComputedStyle(document.documentElement).getPropertyValue('--bg-top').trim(),
          cur: TM().cur
        }),
        setTheme: (id) => {
          const r = applyTheme(id);
          shareShown = -1;      // сброс кэша подписи репоста: иначе останется текст прошлой темы
          render();
          return r;
        },
        themeIssues: themeIssues,
        themeSchema: () => ({ fields: THEME_FIELDS, copy: THEME_COPY_KEYS })
      };

      /* ---- ПЕРЕКЛЮЧАТЕЛЬ ТЕМ (только под ?debug=1) --------------------------
         Кнопки вместо «выпиши ?theme=sat в адресной строке». Всё, что делает
         виджет живым, — разметка, стили и поведение — лежит ВНУТРИ региона HOOK
         и вырезается tools/build-release.cjs целиком: style.css намеренно НЕ
         трогается, потому что билдер режет только game.js, и правила, написанные
         там, уехали бы в боевой артефакт мёртвым грузом. Что в бою ни хука, ни
         переключателя нет — .visual-check.cjs [12].

         1. ВЫБОР ЖИВЁТ В URL, а не в хранилище и не в сейве. Второй ключ
            LocalStorage — новая поверхность персональных данных: её обязан был
            бы назвать privacy-policy.md, а check-moderation-kit держит
            инвариант «к хранилищу игра обращается только через CFG.saveKey».
            Поле в сейве — правка схемы v4: её задело бы слияние с «облаком»
            другого устройства и проверки миграции в смоке. URL уже единственный
            источник темы и читается синхронно до первого пейнта (THEME_FROM_URL)
            — replaceState даёт перезагрузке ровно тот же покрытый тестами путь,
            без вспышки прошлого бренда (инвариант №2).
         2. ВИДЖЕТ НЕ ИМЕЕТ ПРАВА НАЕЗЖАТЬ НА ИГРУ. position:fixed у левой
            границы, по вертикали — центр экрана: монета центрирована в сцене и
            с полосой не пересекается ни на 390px, ни на 320px. Тап висит только
            на el.coin, поэтому стоящий ВНЕ #stage элемент не может ни начислить
            монеты, ни перехватить тап.
         3. ТЕМА — ТОЛЬКО ВИТРИНА. pick() не пишет в S и не вызывает save():
            переключение бренда не имеет права менять баланс и payload моста
            (инвариант №1).
         --------------------------------------------------------------------- */
      (function mountThemeSwitch() {
        const css = [
          '.sw-theme{position:fixed;z-index:40;left:calc(6px + var(--sa-l));top:50%;',
          'transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;gap:6px;',
          'padding:7px 6px;border-radius:16px;background:var(--glass);border:1px solid var(--line);',
          'backdrop-filter:blur(8px);pointer-events:auto}',
          '.sw-theme__t{font-size:9px;line-height:1;font-weight:600;letter-spacing:.08em;',
          'color:var(--muted);text-transform:uppercase;user-select:none}',
          '.sw-theme__b{width:34px;height:34px;padding:0;border-radius:50%;display:grid;place-items:center;',
          'cursor:pointer;background:transparent;border:1px solid var(--line);color:var(--muted);',
          'font-size:16px;line-height:1;transition:color .18s,border-color .18s,transform .12s}',
          '.sw-theme__b:active{transform:scale(.92)}',
          /* Подсветка активна ТОКЕНОМ темы: --cyan перекрашивает paintTokens(),
             поэтому рассинхрон «кнопка прошлого бренда подсвечена» невозможен. */
          '.sw-theme__b.is-on{color:var(--cyan);border-color:var(--cyan);box-shadow:0 0 12px rgba(0,229,255,.25)}'
        ].join('');
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);

        const box = document.createElement('div');
        box.className = 'sw-theme';
        box.setAttribute('role', 'group');
        box.setAttribute('aria-label', 'Переключатель тем (только отладка)');
        const cap = document.createElement('span');
        cap.className = 'sw-theme__t';
        cap.textContent = 'темы';
        box.appendChild(cap);

        /* Порядок кнопок = порядок реестра THEMES. data-sw-theme, а НЕ data-theme:
           тот зарезервирован за <html> и читается обоими наборами проверок как
           признак применённой темы. */
        const btns = Object.keys(THEMES).map((id) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'sw-theme__b';
          b.setAttribute('data-sw-theme', id);
          b.textContent = THEMES[id].glyph;
          b.title = id + ' — ' + THEMES[id].copy.logo;
          b.addEventListener('click', () => pick(id));
          box.appendChild(b);
          return b;
        });
        document.body.appendChild(box);
        mark();

        function mark() {
          btns.forEach((b) => b.classList.toggle('is-on', b.getAttribute('data-sw-theme') === activeTheme));
        }

        function remember(id) {
          try {
            const q = new URLSearchParams(location.search);
            q.set('theme', id);                 // debug=1 и прочие поля сохраняются
            history.replaceState(null, '',
              location.pathname + '?' + q.toString() + location.hash);
          } catch (_) {
            /* file:// и жёсткие песочницы: тема уже применена, запоминание —
               удобство, а не обязанность. Но не молча: см. ловушку 3. */
            console.warn('[theme] не удалось записать ?theme= в URL — выбор живёт до перезагрузки');
          }
        }
        function pick(id) {
          /* Единственный код-путь с харнесом: NEON.setTheme делает applyTheme,
             сброс кэша подписи репоста и render(). Дублировать эту тройку здесь
             — значит получить разъезд поведения между тестами и руками. */
          const applied = window.NEON.setTheme(id);
          mark();
          if (!applied) {
            // Неизвестная тема: applyTheme уже остался на реальной, подсветку
            // вернули mark(). Молча нельзя — иначе опечатка в реестре выглядит
            // как «кнопка не работает».
            toast('Тема «' + id + '» не найдена — осталось «' + activeTheme + '»', 'bad', 2400);
            return;
          }
          remember(id);
          toast('Тема: ' + id + ' — ' + TM().copy.logo, 'good', 2200);
        }

      })();
    }
    // <<< RELEASE-STRIP HOOK_END
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();






