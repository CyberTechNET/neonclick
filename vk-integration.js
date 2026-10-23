/* ==========================================================================
 * vk-integration.js — слой интеграции с VK Bridge (единственный файл,
 * который знает что-либо про VK).
 *
 * Что делает:
 *   1. Сам подгружает SDK VK Bridge: сначала собственный файл рядом с игрой
 *      (vk-bridge.3.0.2.js), и только при его отсутствии — CDN (unpkg, с
 *      фолбэком на jsDelivr).
 *   2. Вызывает обязательный VKWebAppInit.
 *   3. Даёт игре удобный API:
 *        VK.ready                 → Promise<boolean> (true = мы внутри VK)
 *        VK.showRewardedAd(scene) → Promise<{ok, code, message}>  ← РЕКЛАМА
 *        VK.hasRewardedAds()      → Promise<boolean> (есть ли заполнение)
 *        VK.storageGet(keys)      → Promise<Object|null>   ← ОБЛАКО: прогресс
 *        VK.storageSet(key, value)→ Promise<boolean>
 *        VK.hasStorage()          → Promise<boolean>
 *        VK.haptic(type)          → вибро-отклик
 *        VK.share() / VK.close()
 *        VK.shareLink()           → каноническая ссылка vk.com/app… для шаринга
 *        VK.guildLaunch()         → {groupId, role}  ← ГИЛЬДИЯ = сообщество VK
 *        VK.guildInfo(groupId)    → Promise<{name, isMember, photo, ...}|null>
 *        VK.joinGroup(groupId)    → Promise<boolean> (VKWebAppJoinGroup)
 *        VK.leaveGroup(groupId)   → Promise<boolean> (VKWebAppLeaveGroup)
 *
 * Игра (game.js) работает только с этими обещаниях и ничего не знает про
 * протокол VKWebApp*, поэтому её можно запускать и в обычном браузере.
 * ========================================================================== */

(function (global) {
  'use strict';

  /* ---------- SDK VK Bridge: свой файл, затем CDN ---------- */
  /**
   * Порядок источников: локальный файл → unpkg → jsDelivr. Локальный идёт
   * первым по трём причинам: (а) запуск игры перестаёт зависеть от доступности
   * чужого CDN в момент тапа; (б) в консоли VK WebView не появляется варнингов
   * и сетевых ошибок, которые ловит модерация при проверке размещения; (в) CDN
   * отдаёт «latest», а значит в один прекрасный день мост мог приехать версии,
   * с которой наши наборы проверок не знакомы. Версия и sha256 локального файла
   * зафиксированы в tools/vendor.json и сверяются сборкой боевого артефакта.
   * CDN остаются фолбэком на случай, если файл потеряется при выкладке.
   */
  const SDK_LOCAL = 'vk-bridge.3.0.2.js';
  const CDN_MAIN = 'https://unpkg.com/@vkontakte/vk-bridge@3.0.2/dist/browser.min.js';
  const CDN_BACKUP = 'https://cdn.jsdelivr.net/npm/@vkontakte/vk-bridge@3.0.2/dist/browser.min.js';

  /**
   * Демо-режим: если открыть index.html НЕ внутри VK (обычный браузер,
   * localhost), награда за «просмотр рекламы» выдаётся без рекламы — чтобы
   * игру можно было отлаживать локально.
   *
   * ★ ФЛАГ В РЕПОЗИТОРИИ ОБЯЗАН БЫТЬ ВЫКЛЮЧЕН. Включённый здесь «true» значит,
   *   что публичная сборка раздаёт +1000 монет и ×2 по клику на кнопку, не
   *   показав ни одного ролика: VKWebAppShowNativeAds не вызывается вовсе,
   *   монетизация обнуляется. Это не «забыть перед публикацией», а дыра.
   *
   * Инвариант машинный, а не на словах. Наборам проверок демо всё же нужен
   * (иначе ветку наград не покрыть), поэтому они собирают ДЕМО-СБОРКУ
   * подменой текста файла прямо в прогоне: see withDemo() в .smoke-test.cjs,
   * .visual-check.cjs и .vk-mock-check.cjs. Та подмена бросает ошибку, если
   * строка ниже окажется выключенной не единственным объявлением флага, — то
   * есть возврат сюда «true» ломает прогон, а не проходит мимо него.
   */
  const DEMO_MODE = false;

  /* Таймауты (мс): bridge.send внутри WebView иногда не резолвится. */
  const T_INIT = 4000;
  const T_ADS_CHECK = 6000;
  /* ПЕРВОЕ сообщение о показе и ВЕСЬ показ. Разведены нарочно: клиент вправе
     ответить несколько раз подряд (loading → opened → closed), и прогресс
     приходит быстро, а терминальное сообщение — после ролика. Держать на
     первый ответ весь бюджет 90 с означало бы резать длинный ролик на 15-й
     секунде тишины, а ждать терминального — все 90, пока идёт загрузка. */
  const T_ADS_FIRST = 15000;
  const T_ADS_SHOW = 90000;
  const ADS_POLL = 120;        // с какой частотой разбираем очередь сообщений показа
  /* Имена событий клиента, несущих сообщение о показе. Вендор vk-bridge 3.0.2
     объявляет их ровно три (src/types/data.ts:1547-1549): само имя метода,
     «…Result» и «…Failed». Failed несёт error_type и приходит отказом промиса
     send, поэтому в список не попадает. */
  const ADS_EVENT_TYPES = ['VKWebAppShowNativeAds', 'VKWebAppShowNativeAdsResult'];
  const ADS_ERR_TYPES = ['VKWebAppShowNativeAdsFailed'];
  const ADS_CACHE_TTL = 60000; // сколько верим ответу VKWebAppCheckNativeAds

  const st = {
    bridge: null,     // window.vkBridge после загрузки с CDN
    inVK: false,      // true, если приложение реально открыто в клиенте VK
    adsCache: null,   // кэш ответа VKWebAppCheckNativeAds
    adsCacheTs: 0,
    storageCache: null, // кэш ответа «доступно ли VKWebAppStorage*»
    loadPromise: null,
    readyPromise: null
  };

  /* ---------- Утилиты ---------- */
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Гонка «мост ответил / время вышло». */
  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      delay(ms).then(() => { throw new Error('timeout:' + (label || 'call')); })
    ]);
  }

  /** Вставка <script> с CDN: резолвится, только если появился window.vkBridge. */
  function injectScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = () => (global.vkBridge ? resolve(global.vkBridge) : reject(new Error('no global: ' + src)));
      s.onerror = () => reject(new Error('load failed: ' + src));
      document.head.appendChild(s);
    });
  }

  /** Грузит SDK с CDN один раз (повторные вызовы получают тот же промис). */
  function loadBridgeSDK() {
    if (st.bridge) return Promise.resolve(st.bridge);
    // SDK мог быть положен на окно раньше (обычный <script> тег выше) — не качаем дважды.
    if (global.vkBridge) { st.bridge = global.vkBridge; return Promise.resolve(st.bridge); }
    if (st.loadPromise) return st.loadPromise;

    st.loadPromise = withTimeout(
      injectScript(SDK_LOCAL)
        .catch(() => injectScript(CDN_MAIN))
        .catch(() => injectScript(CDN_BACKUP)),
      8000,
      'sdk-load'
    )
      .then((bridge) => (st.bridge = bridge || global.vkBridge || null))
      .catch((err) => {
        console.warn('[VK] не удалось загрузить vk-bridge (свой файл и оба CDN):', err && err.message);
        st.bridge = global.vkBridge || null;
        return st.bridge;
      });

    return st.loadPromise;
  }

  /** Поддерживается ли конкретный обработчик текущим клиентом VK. */
  async function supports(name) {
    const b = st.bridge;
    if (!b) return false;
    try {
      if (typeof b.supportsAsync === 'function') return !!(await withTimeout(b.supportsAsync(name), 2500));
      if (typeof b.supports === 'function') return !!b.supports(name);
    } catch (_) { /* не критично */ }
    return false;
  }

  /** Безопасный вызов необязательных методов: ошибки глушатся. */
  async function safeCall(name, params) {
    if (!st.bridge) return null;
    if (!(await supports(name))) return null;
    try {
      return await withTimeout(st.bridge.send(name, params || {}), 5000, name);
    } catch (err) {
      console.warn('[VK] ' + name + ' ->', err && err.message);
      return null;
    }
  }

  /**
   * Значения vk_platform, которые реально передаёт VK. Сверено с официальным
   * валидатором launch-параметров (@vkontakte/vk-bridge 3.x,
   * packages/core/src/types/data/values.ts → getLaunchParamsResponsePlatformsSet)
   * и разделом «Параметры запуска» (dev.vk.ru/mini-apps/development/launch-params).
   */
  const VK_PLATFORMS = [
    'desktop_web',              // ← боевой запуск: десктопная версия VK, vk_ref=left_nav
    'desktop_web_messenger',
    'desktop_app_messenger',
    'mobile_web',
    'mobile_android',
    'mobile_android_messenger',
    'mobile_iphone',
    'mobile_iphone_messenger',
    'mobile_ipad'
  ];
  /* Значений вида web_external / mvk_external / android_external /
     iphone_external / ipad_external в списке НЕТ — намеренно. Ими VK помечает
     обратное: запуск СНАРУЖИ клиента VK (обычный браузер). Пропустить их сюда
     означало бы объявить себя «внутри VK» перед чужим браузером и слать
     VKWebAppInit, рекламу и шаринг туда, где их никто не обслуживает. */

  /**
   * Признаки запуска внутри VK по URL — запасная ветка на случай, когда
   * isEmbedded() не сработал (мост не поднял признак, приложение открыли по
   * прямой ссылке vk.com/app…, старый клиент).
   *
   * ЛОВУШКА ПРЕЖНЕЙ ВЕРСИИ: она смотрела на platform=vk_mobile|vk_pc — ни
   * такого имени параметра, ни таких значений VK не передаёт никогда. Боевой запуск
   * (vk_platform=desktop_web) проходил мимо, и всё распознавание держалось на
   * одном-единственном vk_app_id: удалит VK этот параметр из своей сборки URL
   * (или завернёт его в location_search, как он делает с query приложения) — и
   * приложение перестанет замечать клиента, молча уйдя в режим «вне VK»:
   * без рекламы, без облака, без гильдии. Ошибки при этом нет никакой.
   *
   * Поэтому: читаем официальные имена через launchParam() (тот же порядок
   * источников, что у appLink()/guildLaunch(): search → location_search → hash),
   * и любого из независимых признаков достаточно.
   */
  function looksLikeVKLaunch() {
    // 1. Идентификатор приложения: прислать его может только VK (из его настроек).
    if (/^\d+$/.test(String(launchParam(['vk_app_id', 'app_id', 'aid']) || ''))) return true;
    // 2. Платформа запуска — из документированного перечня (не *_external).
    const plat = launchParam(['vk_platform', 'platform']);
    if (plat && VK_PLATFORMS.indexOf(plat) >= 0) return true;
    // 3. Флаги установки/моста, которые в чужом URL не появляются.
    if (launchParam(['is_app', 'vk_is_app_user'])) return true;
    if (launchParam(['impl']) === 'bridge') return true;
    // 4. Пара «кто + когда» (vk_user_id + vk_ts) — осколок подписи запуска:
    //    её генерирует только VK; отдельно взятый user_id из чужой ссылки — нет.
    if (launchParam(['vk_user_id', 'user_id']) && launchParam(['vk_ts', 'ts'])) return true;
    return false;
  }
  /* ======================================================================
   * 1. ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ
   * ==================================================================== */

  /**
   * Инициализация Mini App.
   * Именно здесь выполняется обязательный вызов:
   *
   *      vkBridge.send('VKWebAppInit');
   *
   * @returns {Promise<boolean>} true — мы внутри клиента VK.
   */
  async function init() {
    const bridge = await loadBridgeSDK();
    if (!bridge) { st.inVK = false; return false; }

    // Определяем окружение: WebView/iframe клиента VK или обычный браузер.
    try { st.inVK = !!(bridge.isEmbedded && bridge.isEmbedded()); } catch (_) { st.inVK = false; }
    if (!st.inVK) st.inVK = looksLikeVKLaunch();

    if (st.inVK) {
      // ОБЯЗАТЕЛЬНЫЙ первый вызов любого Mini App.
      try {
        await withTimeout(bridge.send('VKWebAppInit'), T_INIT, 'VKWebAppInit');
      } catch (err) {
        console.warn('[VK] VKWebAppInit не подтвердился:', err && err.message);
      }

      // Тёмный статус-бар (метод необязательный — ошибки глушатся).
      safeCall('VKWebAppSetViewSettings', { statusBarStyle: 'light', androidStatusBarColor: '#06060d' });

      // Пробрасываем события клиента VK как обычные DOM-события,
      // чтобы game.js мог, например, сохранить прогресс при уходе в фон.
      try {
        bridge.subscribe((event) => {
          const type = event && event.detail && event.detail.type;
          if (type !== 'VKWebAppViewHide' && type !== 'VKWebAppViewShow') return;
          global.dispatchEvent(new CustomEvent('vk:' + type.slice(8).toLowerCase(), { detail: event.detail.data }));
        });
      } catch (_) { /* ignore */ }

      // Прогреваем кэш доступности рекламы, чтобы кнопка реагировала мгновенно.
      hasRewardedAds(true).catch(() => {});
    }

    console.info('[VK] init завершён. Внутри VK:', st.inVK, '| демо-режим:', DEMO_MODE && !st.inVK);
    return st.inVK;
  }

  /* ======================================================================
   * 2. МОНЕТИЗАЦИЯ: REWARD VIDEO (VKWebAppShowNativeAds)
   * ==================================================================== */

  /**
   * ★ Имя параметра рекламы — по официальному контракту vk-bridge 3.x
   * (dist/types/data.d.ts):
   *     EAdsFormats = 'reward' | 'interstitial'
   *     ShowNativeAdsRequest  = { ad_format: EAdsFormats; use_waterfall?: boolean }
   *     CheckNativeAdsRequest = { ad_format: EAdsFormats; use_waterfall?: boolean }
   * Параметр называется AD_FORMAT, а НЕ «format». Со своим именем параметра
   * клиент VK не получает формат запроса, ролик не подбирается и монетизация
   * умирает молча (ошибка 3 / пустое заполнение) — при этом вне клиента VK
   * ничего не меняется и баг не виден ни в одном браузере. Поэтому моки
   * проверок сверяют имя параметра строго (.vk-mock-check.cjs, .stress-check.cjs).
   */
  const AD_FORMAT_REWARD = 'reward';
  const adRequest = () => ({ ad_format: AD_FORMAT_REWARD });

  /**
   * Тексты ошибок рекламного SDK VK.
   * Коды приходят в error_data.error_code метода VKWebAppShowNativeAds.
   */
  const AD_ERRORS = {
    1: 'Неизвестная ошибка рекламы. Попробуй ещё раз чуть позже.',
    2: 'Ошибка рекламы на стороне VK. Мы уже чиним — попробуй позже.',
    3: 'Дневной лимит показов исчерпан. Возвращайся завтра 🙌',
    4: 'Реклама недоступна на этом устройстве.',
    5: 'Реклама ещё не готова. Подожди минуту и попробуй снова.',
    6: 'Этот формат рекламы не поддерживается.',
    7: 'Сейчас нет свободных роликов. Попробуй через пару минут.'
  };

  /** Приводит ошибку bridge к единому виду {ok:false, code, message}. */
  function normalizeAdError(err) {
    if (!err) return { ok: false, code: 'unknown', message: AD_ERRORS[1] };
    if (err.message && /^timeout:/.test(err.message)) {
      return { ok: false, code: 'timeout', message: 'Реклама зависла при загрузке. Попробуй ещё раз.' };
    }
    const code = err.error_data && err.error_data.error_code != null
      ? Number(err.error_data.error_code)
      : (err.error_code != null ? Number(err.error_code) : null);
    if (code != null && AD_ERRORS[code]) return { ok: false, code: 'error_' + code, message: AD_ERRORS[code] };
    if (code != null) return { ok: false, code: 'error_' + code, message: AD_ERRORS[1] };
    return { ok: false, code: 'failed', message: AD_ERRORS[7] };
  }

  /**
   * Есть ли что показывать прямо сейчас (VKWebAppCheckNativeAds).
   * Ответ кэшируется на ADS_CACHE_TTL мс, чтобы не спамить мост.
   */
  async function hasRewardedAds(force) {
    if (!st.bridge || !st.inVK) return false;
    const now = Date.now();
    if (!force && st.adsCache != null && now - st.adsCacheTs < ADS_CACHE_TTL) return st.adsCache;
    try {
      const res = await withTimeout(st.bridge.send('VKWebAppCheckNativeAds', adRequest()), T_ADS_CHECK, 'check');
      st.adsCache = !!(res && (res.result === true || (Array.isArray(res.result) && res.result.length > 0)));
    } catch (err) {
      st.adsCache = false;
    }
    st.adsCacheTs = now;
    return st.adsCache;
  }
  /**
   * Вердикт ОДНОГО сообщения клиента о показе.
   *
   * Терминальное — то, после которого показ больше не ждём:
   *   { result: true }            → контракт вендора (data.ts:1280), успех;
   *   success | completed         → то же самое именем типа (новые клиенты);
   *   closed | ended | finished   → ролик ЗАКРЫТ, то есть состоялся. Именами
   *                                'error'/'failed'/'load-error' клиент называет
   *                                несостоявшийся показ, поэтому 'closed' —
   *                                награда, а не отказ. Прежняя сборка считала
   *                                'closed' досрочным закрытием и не выдавала
   *                                награду за досмотренный ролик: флага
   *                                «досмотрел до конца» в ответе VK нет, и
   *                                отказывать по нему значило красть награду
   *                                у честного игрока целиком.
   * Нетерминальные — loading | opened: ролик ещё идёт, ждём следующее сообщение.
   *
   * @returns {{term:boolean, opened?:boolean, res?:{ok:boolean, code:string, message?:string}}|null}
   *          null — сообщение не о показе (пустой объект, служебные поля).
   */
  function classifyAdShow(msg) {
    if (!msg || typeof msg !== 'object') return null;
    // Ошибочное сообщение моста: error_type/error_code приезжают и промисом,
    // и подпиской — приводим к одному виду в обоих случаях.
    if (msg.error_type != null || msg.error_code != null
      || (msg.error_data && msg.error_data.error_code != null)) {
      return { term: true, res: normalizeAdError(msg) };
    }
    if (msg.result === true) return { term: true, res: { ok: true, code: 'success' } };
    if (msg.result === false) return { term: true, res: { ok: false, code: 'no_fill', message: AD_ERRORS[7] } };
    const t = msg.type != null ? String(msg.type) : '';
    if (!t) return null;
    if (t === 'success' || t === 'completed') return { term: true, res: { ok: true, code: 'success' } };
    if (t === 'closed' || t === 'ended' || t === 'finished') return { term: true, res: { ok: true, code: 'closed' } };
    if (t === 'loading' || t === 'opened') return { term: false, opened: t === 'opened' };
    if (t === 'load-error') return { term: true, res: { ok: false, code: 'load_error', message: AD_ERRORS[5] } };
    if (t === 'error') {
      return { term: true, res: { ok: false, code: 'error', message: AD_ERRORS[Number(msg.error_code) || 1] } };
    }
    if (t === 'failed') return { term: true, res: { ok: false, code: 'no_fill', message: AD_ERRORS[7] } };
    if (t === 'skipped') {
      return { term: true, res: { ok: false, code: 'skipped', message: 'Ролик закрыт досрочно — награда не начислена.' } };
    }
    // Неизвестный ответ обязан называть себя: без этого единственная диагностика
    // для разработчика — «не включилось х2» со слов игрока.
    return {
      term: true,
      res: { ok: false, code: 'unknown', message: 'Неизвестный ответ рекламы («' + t + '»). Попробуй ещё раз.' }
    };
  }

  /**
   * ★ ГЛАВНАЯ ТОЧКА МОНЕТИЗАЦИИ ★
   * Показывает награждаемую рекламу (Reward Video) и возвращает результат.
   *
   * Порядок действий:
   *   1) VKWebAppCheckNativeAds { ad_format: 'reward' } — спрашиваем, есть ли ролик;
   *   2) VKWebAppShowNativeAds  { ad_format: 'reward' } — показываем ролик;
   *   3) Дожимаемся ТЕРМИНАЛЬНОГО сообщения и только тогда решаем награду.
   *
   * Почему подписка, а не один ответ на send. Вендоренный vk-bridge 3.0.2
   * резолвит промис ПЕРВЫМ сообщением с этим request_id и после этого забывает
   * заявку (в бандле: V.resolve(t, …) обнуляет слот), а клиент по показу шлёт
   * сообщения несколько раз подряд — EventReceiveNames объявляет
   * 'VKWebAppShowNativeAds' | '…Result' | '…Failed' (src/types/data.ts:1547-1549).
   * Заявка, доверяющая первому ответу, ловила «loading»/«opened» и объявляла их
   * отказом: игрок досматривал ролик и не получал ни ×2, ни монет — ровно та
   * жалоба, что пришла от игрока. Поэтому подписываемся ДО отправки, а промис
   * send остаётся только первым сообщением (и источником ошибки).
   *
   * @param {string} scene — идентификатор точки монетизации для логов
   *                         ('double_income' | 'free_coins').
   * @returns {Promise<{ok:boolean, code:string, message?:string}>}
   */
  async function showRewardedAd(scene) {
    // Ждём завершения инициализации: иначе на первых секундах запуска,
    // пока мост ещё не определился, реальный игрок внутри VK получил бы
    // демо-награду без просмотра ролика (гонка на старте).
    await awaitReady();

    // Вне клиента VK реклама физически недоступна.
    if (!st.bridge || !st.inVK) {
      if (!DEMO_MODE) {
        return { ok: false, code: 'no_vk', message: 'Реклама доступна только внутри VK.' };
      }
      // Локальная отладка: имитируем просмотр и всё равно дарим награду.
      await delay(1200);
      return { ok: true, code: 'demo', message: 'Демо-режим (вне VK): награда выдана без рекламы.' };
    }

    // 1. Проверяем готовность рекламного блока.
    const ready = await hasRewardedAds();
    if (!ready) {
      return { ok: false, code: 'no_fill', message: AD_ERRORS[5] };
    }

    // 2. ★ ЗДЕСЬ ВЫЗЫВАЕТСЯ РЕКЛАМА VK ★
    //    Метод: VKWebAppShowNativeAds, параметр ad_format: 'reward' (видео за награду).
    //    Подписка ставится ДО отправки: без неё терминальное сообщение «closed»
    //    прилетело бы уже после того, как промис send разойдётся на «loading»,
    //    и досмотренный ролик стал бы отказом.
    const bridge = st.bridge;
    const inbox = [];
    const seen = [];
    let verdict = null, opened = false;

    const feed = (msg) => {
      if (verdict) return;
      const v = classifyAdShow(msg);
      if (!v) return;
      seen.push(msg.type != null ? String(msg.type)
        : (msg.result === true ? 'result:true' : (msg.result === false ? 'result:false' : 'error')));
      if (v.opened) opened = true;
      if (v.term) verdict = v.res;
    };
    const onShow = (event) => {
      const d = event && event.detail;
      if (!d) return;
      const name = String(d.type || '');
      if (ADS_EVENT_TYPES.indexOf(name) < 0 && ADS_ERR_TYPES.indexOf(name) < 0) return;
      inbox.push(d.data);
    };
    let detach = null;
    try {
      if (typeof bridge.subscribe === 'function') {
        bridge.subscribe(onShow);
        if (typeof bridge.unsubscribe === 'function') detach = () => bridge.unsubscribe(onShow);
      }
    } catch (_) { /* мост без подписки: остаёмся на одном ответе send */ }

    const started = Date.now();
    let sendErr = null;
    try {
      feed(await withTimeout(
        bridge.send('VKWebAppShowNativeAds', adRequest()),
        T_ADS_FIRST,
        'show:' + scene
      ));
    } catch (err) {
      sendErr = err;
    }

    /* 3. Дожим терминального сообщения. Опрос очереди, а не «вечный» промис:
          mock-мосты прогонов (jsdom) доставляют ответ только через send и обязаны
          давать ровно тот же вердикт, что живой клиент с лестницей. */
    while (!verdict && Date.now() - started < T_ADS_SHOW) {
      while (inbox.length && !verdict) feed(inbox.shift());
      if (verdict || sendErr) break;
      await delay(ADS_POLL);
    }
    if (detach) { try { detach(); } catch (_) { /* уже снята */ } }
    st.adsCache = null;                   // кэш протух: при следующем клике проверим заново

    if (!verdict && sendErr) {
      console.warn('[VK] VKWebAppShowNativeAds ошибка (' + scene + '):', sendErr);
      verdict = normalizeAdError(sendErr);
    }
    if (!verdict) {
      verdict = {
        ok: false, code: 'timeout',
        message: opened
          ? 'Ролик не завершился. Попробуй ещё раз.'
          : 'Реклама зависла при загрузке. Попробуй ещё раз.'
      };
    }
    console.info('[VK] VKWebAppShowNativeAds (' + scene + ') ->', seen.join(' → ') || 'нет ответа', verdict);
    return verdict;
  }

  /* ======================================================================
   * 3. ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ VK
   * ==================================================================== */

  /** Вибро-отклик: 'selection' | 'success' | 'warning' | 'error' | 'notification'. */
  function haptic(type) {
    return safeCall('VKWebAppHapticNotification', { type: type || 'selection' });
  }

  /**
   * Каноническая ссылка, по которой приложение открывается ВНУТРИ VK.
   *
   * ВАЖНО: location.href внутри мини-приложения — это адрес НАШЕГО хостинга
   * (https://site.example/index.html?app_id=...). Отдавать другу такую ссылку
   * нельзя: он получит голую веб-страницу вне VK, где реклама не крутится,
   * облака нет, а при DEMO_MODE=false игра просто бессмысленна.
   *
   * Формат — по документации VK («Параметры запуска», раздел про vk_group_id):
   *   приложение пользователя  →  https://vk.com/app{vk_app_id}
   *   приложение сообщества    →  https://vk.com/app{vk_app_id}_-{group_id}
   *                                  (пример из docs: vk.com/app6909581_-166562603)
   * Оба id VK подставляет в URL iframe сам, поэтому хардкодить app_id не нужно.
   *
   * ДВЕ ЛОВУШКИ, закрытые здесь:
   * 1) Имя параметра. VK привозит сообщество в vk_group_id; прежний код читал
   *    только group_id/gid, то есть на БОЕВОМ запуске из паблика ссылку друга
   *    он собрал бы как для личного приложения — репосты, за которые игрок
   *    получил 500 монет, вели бы не в то размещение (мёртвая виральная петля,
   *    причём оплаченная). Читаем официальное имя первыми, старые — лишь как
   *    совместимость с нашими же стендами (?app_id=…&group_id=-1).
   * 2) ЗНАК. vk_group_id VK передаёт ПОЛОЖИТЕЛЬНЫМ числом, а в ссылке
   *    сообщество всегда пишется с минусом. Копировать значение как есть —
   *    значит выдать vk.com/app6909581_166562603: битая ссылка, которую VK
   *    не отдаёт никому. Поэтому суффикс собирается от модуля.
   *
   * Источники те же, что у guildLaunch(): VK кладёт launch-параметры плоско в
   * query iframe'а, но при прямых ссылках они могут приехать в location_search
   * или хэше — читать только location.search значило бы иногда шарить null и
   * молча скатываться на адрес хостинга (см. fallback в share()).
   */
  function appLink() {
    const appId = launchParam(['vk_app_id', 'app_id', 'aid']);
    if (!appId || !/^\d+$/.test(String(appId))) return null;
    const rawGid = launchParam(['vk_group_id', 'group_id', 'gid']);
    const gid = rawGid ? parseInt(String(rawGid), 10) : 0;
    const suffix = (gid && isFinite(gid)) ? '_-' + Math.abs(gid) : '';
    return 'https://vk.com/app' + appId + suffix;
  }

  /**
   * Шаринг ссылки на игру.
   *
   * Контракт (vk-bridge 3.x, data.d.ts):
   *   запрос  VKWebAppShare: { link?: string }   — поля options/title НЕТ,
   *   ответ   LinkShareResult[]                  — пустой массив = игрок
   *                                                закрыл диалог, не поделившись.
   * Поэтому возвращаем булево «реально поделились», а не сырой ответ моста:
   * пустой массив — truthy, и `if (res)` дарило «Спасибо за репост!» за отказ.
   * @returns {Promise<boolean>}
   */
  async function share(link) {
    const url = link || appLink() || location.href.split('#')[0];
    const res = await safeCall('VKWebAppShare', { link: url });
    if (res == null) return false;                      // мост недоступен / отклонён
    if (Array.isArray(res)) return res.length > 0;      // штатный ответ 3.x
    if (typeof res === 'boolean') return res;           // на случай старых клиентов
    return !!(res.result || res.post_id || res.users);
  }

  /** Закрытие приложения (например, по кнопке «выйти»). */
  function close(status) {
    return safeCall('VKWebAppClose', { status: status || 'success' });
  }

  /* ======================================================================
   * 3b. ОБЛАЧНОЕ ХРАНИЛИЩЕ ПРОГРЕССА (VKWebAppStorage*)
   *
   * Контракт сверен по официальному пакету @vkontakte/vk-bridge 3.0.2
   * (dist/types/data.d.ts):
   *
   *   VKWebAppStorageGet      { keys: string[] }             -> { keys: [{key, value}] }
   *   VKWebAppStorageGetKeys  { count: number, offset: number } -> { keys: string[] }
   *   VKWebAppStorageSet      { key: string, value: string }  -> { result: true }
   *
   * Ограничения VK на переменные приложения (vk.com/dev/storage.set):
   *   • имя ключа — только [a-zA-Z_\-0-9], длина <= 100;
   *   • значение — сохраняются только ПЕРВЫЕ 4096 символов;
   *   • не более 1000 переменных на пользователя;
   *   • не более 1000 ВЫЗОВОВ В ЧАС на пользователя ← потолок частоты синка,
   *     поэтому game.js пишет в облако не чаще CFG.cloud.everyMs.
   *
   * Отдельного хендлера удаления в vk-bridge v3 нет: переменную удаляют
   * пустой строкой (то же указание в документации storage.set).
   * ==================================================================== */

  const T_STORAGE = 8000;              // мс на ответ хранилища
  const STORAGE_VALUE_MAX = 4096;      // столько VK реально сохраняет

  /** Ждём завершения VKWebAppInit: до него облако обращаться нельзя (гонка на старте). */
  async function awaitReady() {
    if (st.readyPromise) { try { await st.readyPromise; } catch (_) {} }
  }

  /** Доступно ли облачное хранилище в этом клиенте VK. */
  async function hasStorage() {
    if (st.storageCache === true) return true;
    await awaitReady();
    if (!st.bridge || !st.inVK) return false;
    if (!(await supports('VKWebAppStorageSet'))) return false;
    st.storageCache = true;
    return true;
  }

  /**
   * Чтение переменных. Возвращает карту { ключ -> значение } или null,
   * если облако недоступно / ответ не разобрать. Отсутствующий ключ
   * приходит как пустая строка.
   * @param {string[]} keys
   */
  async function storageGet(keys) {
    if (!(await hasStorage())) return null;
    try {
      const res = await withTimeout(
        st.bridge.send('VKWebAppStorageGet', { keys: keys }),
        T_STORAGE, 'storageGet'
      );
      // v3 присылает { keys: [{key, value}] }, старые клиенты — { values: [...] }.
      const list = res && Array.isArray(res.keys) ? res.keys
        : (res && Array.isArray(res.values) ? res.values : null);
      if (!list) return null;
      const map = {};
      keys.forEach((k) => { map[k] = ''; });
      list.forEach((item) => {
        if (item && typeof item.key === 'string') map[item.key] = typeof item.value === 'string' ? item.value : '';
      });
      return map;
    } catch (err) {
      console.warn('[VK] VKWebAppStorageGet ->', err && (err.message || (err.error_data && err.error_data.error_reason)));
      return null;
    }
  }

  /**
   * Запись переменной. true — VK подтвердил запись ({ result: true }).
   * Значение длиннее 4096 символов не отправляем: VK молча обрезал бы
   * хвост, и мы получили бы битый/неподписанный сейв.
   * @returns {Promise<boolean>}
   */
  async function storageSet(key, value) {
    if (!(await hasStorage())) return false;
    const v = typeof value === 'string' ? value : String(value == null ? '' : value);
    if (v.length > STORAGE_VALUE_MAX) {
      console.warn('[VK] storageSet: значение длиннее лимита VK (' + v.length + ' > ' + STORAGE_VALUE_MAX + '), запись отменена');
      return false;
    }
    try {
      const res = await withTimeout(
        st.bridge.send('VKWebAppStorageSet', { key: key, value: v }),
        T_STORAGE, 'storageSet'
      );
      return !!(res && (res.result === true || res.result === 1 || res.written === 1));
    } catch (err) {
      const code = err && err.error_data && err.error_data.error_code;
      console.warn('[VK] VKWebAppStorageSet ->', code != null ? 'error_code ' + code : err && err.message);
      return false;
    }
  }

  /* ======================================================================
   * 3c. ГИЛЬДИИ = СООБЩЕСТВА VK (launch-параметры + VKWebAppGetGroupInfo)
   *
   * Мы НЕ изобретаем свою идентичность. Гильдия — это обычное сообщество VK,
   * список участников которого ведёт НЕ наш код, а VK. Отсюда два подарка:
   * авторитетный реестр членов (проверяется полем is_member) и вступление в
   * один вызов моста. Всё, что потребовало бы своего сервера, здесь бесплатно.
   *
   * Контракты сверены по официальному пакету @vkontakte/vk-bridge 3.x:
   *   VKWebAppGetGroupInfo  { group_id: number } -> { id, name, screen_name,
   *                                                is_member: 0|1,
   *                                                photo_50|100|200, description }
   *   VKWebAppJoinGroup     { group_id: number } -> { result: true }
   *   VKWebAppLeaveGroup    { group_id: number } -> { result: true }
   * launch-параметры: vk_group_id, vk_viewer_group_role
   *   (роли: admin | editor | member | moder | none)
   *
   * Чего здесь СОЗНАТЕЛЬНО нет: VKWebAppGetCommunityToken + VKWebAppCallAPIMethod
   * для записи общего счёта гильдии. Технически это работает, но community-токен
   * отдаётся В БРАУЗЕР КАЖДОМУ участнику, значит любой выписал бы любой счёт.
   * Для экономики это прямой конфликт с античитом игры, поэтому не делается даже
   * за косметические награды.
   * ==================================================================== */

  const T_GUILD = 6000;                        // мс на ответ VK о сообществе
  const GUILD_ROLES = ['admin', 'editor', 'member', 'moder', 'none'];

  /**
   * Чтение launch-параметра из ТРЁХ источников, в том же порядке, что и для
   * темы (см. THEME_FROM_URL в game.js).
   *
   * ЛОВУШКА: в клиенте VK страница живёт в iframe, чей URL собирает сам VK.
   * Часть параметров VK кладёт в query iframe'а напрямую, а query самого
   * приложения заворачивает в параметр location_search; размещения по QR кладут
   * всё в хэш. Читать только location.search — значит тихо потерять гильдию у
   * всей аудитории внутри VK, и тихо потому, что ошибки не будет.
   */
  function launchParam(names) {
    const wanted = Array.isArray(names) ? names : [names];
    const grab = (q) => {
      for (let i = 0; i < wanted.length; i++) {
        const v = q.get(wanted[i]);
        if (v) return v;
      }
      return null;
    };
    try {
      const own = grab(new URLSearchParams(location.search));
      if (own) return own;
      const wrapped = new URLSearchParams(location.search).get('location_search');
      if (wrapped) { const v = grab(new URLSearchParams(wrapped)); if (v) return v; }
      if (location.hash) {
        const v = grab(new URLSearchParams(String(location.hash).replace(/^[#/]+/, '')));
        if (v) return v;
      }
    } catch (_) { /* location недоступен */ }
    return null;
  }

  /**
   * Гильдия, ИЗ КОТОРОЙ открыто приложение, и роль игрока в ней. Оба значения
   * сообщает VK — это авторитет клиента, а не нашего кода, поэтому подделать их
   * из игры нельзя (в отличие от любого поля сейва).
   * @returns {{groupId:number, role:string}|null}
   */
  function guildLaunch() {
    const raw = launchParam(['vk_group_id', 'group_id', 'gid']);
    const id = Math.abs(parseInt(raw, 10) || 0);
    if (!id || !isFinite(id)) return null;
    const r = String(launchParam(['vk_viewer_group_role', 'viewer_group_role']) || '');
    return { groupId: id, role: GUILD_ROLES.indexOf(r) >= 0 ? r : 'none' };
  }

  /**
   * Карточка сообщества. null — VK не ответил или метод не поддержан: гильдия
   * НЕ имеет права уронить игру, поэтому вызывающий обязан показать
   * «не проверено», а не ошибку.
   * @returns {Promise<{id:number, name:string, screenName:string, isMember:boolean, photo:string}|null>}
   */
  async function guildInfo(groupId) {
    const id = Math.abs(parseInt(groupId, 10) || 0);
    if (!id) return null;
    await awaitReady();
    if (!st.bridge || !st.inVK) return null;
    if (!(await supports('VKWebAppGetGroupInfo'))) return null;
    let res;
    try {
      res = await withTimeout(st.bridge.send('VKWebAppGetGroupInfo', { group_id: id }), T_GUILD, 'guildInfo');
    } catch (err) {
      console.warn('[VK] VKWebAppGetGroupInfo ->', err && (err.message || (err.error_data && err.error_data.error_reason)));
      return null;
    }
    // Разные клиенты кладут данные то в group, то плоско на верхний уровень.
    const g = res && res.group ? res.group : res;
    if (!g || typeof g !== 'object') return null;
    const out = {
      id: Number(g.id) || id,
      name: typeof g.name === 'string' ? g.name : '',
      screenName: typeof g.screen_name === 'string' ? g.screen_name : '',
      isMember: g.is_member === 1 || g.is_member === true,
      photo: typeof g.photo_200 === 'string' ? g.photo_200
        : (typeof g.photo_100 === 'string' ? g.photo_100
          : (typeof g.photo_50 === 'string' ? g.photo_50 : ''))
    };
    // Пустой ответ — не данные: без имени и screen_name узел нечем назвать,
    // а молча нарисовать «гильдию #0» хуже, чем сказать правду.
    if (!out.name && !out.screenName) return null;
    return out;
  }

  /** Единый путь вступления/выхода: true — только если VK подтвердил запись. */
  async function groupSwitch(method, groupId) {
    const id = Math.abs(parseInt(groupId, 10) || 0);
    if (!id) return false;
    await awaitReady();
    if (!st.bridge || !st.inVK) return false;
    if (!(await supports(method))) return false;
    try {
      const res = await withTimeout(st.bridge.send(method, { group_id: id }), T_GUILD, method);
      return !!(res && (res.result === true || res.result === 1));
    } catch (err) {
      console.warn('[VK] ' + method + ' ->', err && (err.message || (err.error_data && err.error_data.error_reason)));
      return false;
    }
  }

  const joinGroup = (groupId) => groupSwitch('VKWebAppJoinGroup', groupId);
  const leaveGroup = (groupId) => groupSwitch('VKWebAppLeaveGroup', groupId);

  /* ======================================================================
   * 4. ПУБЛИЧНЫЙ API ДЛЯ game.js
   * ==================================================================== */

  const VK = {
    /** Resolves true, если инициализация в клиенте VK прошла успешно. */
    ready: Promise.resolve(false),
    isVK: () => st.inVK,
    isDemo: () => !st.inVK && DEMO_MODE,
    init: init,
    hasRewardedAds: hasRewardedAds,
    showRewardedAd: showRewardedAd,
    hasStorage: hasStorage,
    storageGet: storageGet,
    storageSet: storageSet,
    haptic: haptic,
    share: share,
    shareLink: appLink,
    close: close,
    guildLaunch: guildLaunch,
    guildInfo: guildInfo,
    joinGroup: joinGroup,
    leaveGroup: leaveGroup,
    get bridge() { return st.bridge; }
  };

  // Автозапуск: грузим SDK с CDN и сразу шлём VKWebAppInit.
  st.readyPromise = init().catch((err) => {
    console.warn('[VK] init упал:', err);
    return false;
  });
  VK.ready = st.readyPromise;

  global.VK = VK;
})(window);


