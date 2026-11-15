"use strict";

function createTutorial({ showView, storage, getAsset, hasEstimate, externalWalt, compactLayout }) {
  const find = (selector) => document.querySelector(selector);
  const overlay = find("#tour");
  const spotlight = find("#tour-spotlight");
  const card = find("#tour-card");
  const title = find("#tour-title");
  const content = find("#tour-text");
  const feedback = find("#tour-feedback");
  const context = find("#tour-context");
  const next = find("#tour-next");
  const back = find("#tour-back");
  const skip = find("#tour-skip");
  const launch = find("#tour-start");
  const workspace = find("#workspace");
  const metric = (key) => () => find('[data-result="' + key + '"]').parentElement;
  const input = (name) => () => find('#trade [name="' + name + '"]');
  const visible = (element) => Boolean(element?.getClientRects().length);

  const steps = [
    { title: "Знакомство с калькулятором", target: 'nav [data-view="calculator"]',
      text: "Калькулятор помогает оценить, сколько денег принесёт сделка. На примере покупки {asset} и продажи за рубли пройди путь от ввода данных до результата." },
    { title: "Объём сделки", target: "#tour-volume", focus: input("ton"),
      text: "Введи, сколько {asset} хочешь купить. Для примера с GRAM можно взять 200 монет. От объёма зависят затраты и сумма продажи." },
    { title: "Курс покупки USDT", target: "#tour-rate", focus: input("rate"),
      text: "Укажи, сколько рублей стоит один USDT по твоему курсу. Для учебного примера возьмём 85 ₽. По этому курсу калькулятор переведёт цену покупки в рубли." },
    { title: "Источник цены покупки", target: "#book-mode",
      fallback: () => visible(find("#manual")) ? find("#manual") : find("#book-status"),
      text: "Стакан Bybit показывает цены и доступный объём на бирже. Калькулятор использует полученные данные, пока они свежие. При ошибке или для примерного расчёта выбери «Ручной ввод».",
      alternate: "Для этой связки цену покупки можно указать самостоятельно." },
    { title: "Цена покупки", target: "#manual", focus: input("manual_price"),
      fallback: () => visible(find("#book-mode")) ? find("#book-mode") : find("#book-status"),
      text: "Здесь укажи цену одной монеты в USDT. Для учебного расчёта с GRAM можно ввести 1,062 USDT. В режиме стакана приложение само считает среднюю цену на весь объём." },
    { title: "Цена продажи", target: "#tour-sale", focus: input("sale"),
      text: externalWalt
        ? "Укажи цену продажи одного {asset} в рублях. Учебный пример для GRAM — 98 ₽."
        : "Укажи цену продажи одного {asset} в рублях. Учебный пример для GRAM — 98 ₽. Можно ввести свою цену или применить объявление Walt P2P, если оно доступно для этой связки." },
    { title: "Объявления Walt P2P", target: "#tour-offers", fallback: "#tour-sale", offers: true,
      text: externalWalt
        ? "Нажми «Объявления», затем «Открыть Walt». Найди подходящее объявление и введи его цену в калькуляторе."
        : "Нажми «Объявления», чтобы посмотреть цены и лимиты Walt P2P. Кнопка «Применить» переносит цену в расчёт. К этому шагу можно вернуться после просмотра." },
    { title: "Способ продажи", target: "#walt-mode", fallback: "#tour-sale-fee",
      text: "Выбери, используешь ли ты чужое объявление или размещаешь своё. Для своего объявления укажи свой статус мерчанта. От этого может зависеть комиссия продажи.",
      alternate: "Для этой связки введи комиссию продажи в поле. Ставки зависят от условий твоей площадки." },
    { title: "Комиссия покупки", target: "#tour-buy-fee", focus: input("buy_fee"),
      text: "Комиссия покупки задаётся в процентах и уменьшает количество монет. Проверь ставку, которую подставило приложение, или укажи свою." },
    { title: "Комиссия вывода", target: "#tour-withdrawal", focus: input("withdrawal"),
      text: "За перевод монет могут списать фиксированное количество {asset}. Проверь данные выбранной сети. Если вводишь комиссию вручную, укажи количество монет. Для учебного примера можно ввести 0." },
    { title: "Комиссия продажи", target: "#tour-sale-fee", focus: input("sale_fee"),
      text: "Комиссия продажи уменьшает количество монет, за которое ты получишь рубли. Проверь ставку для своего способа продажи или введи её вручную." },
    { title: "Рассчитать спред", target: "#calculate", calculation: true,
      text: "Нажми «Рассчитать спред», чтобы увидеть затраты, монеты после комиссий и результат в рублях. Если данных не хватит, здесь появится подсказка." },
    { title: "Спред сделки", target: ".result", layoutFallback: "#percent",
      text: "Спред показывает прибыль или убыток в процентах от затрат на проданные монеты. Расчёт опирается на указанные цены и комиссии. Итог зависит от цены, по которой сделка исполнится." },
    { title: "Средняя цена покупки", target: metric("average"),
      text: "Это стоимость покупки в USDT, разделённая на число купленных монет. В стакане крупная покупка может охватить несколько цен, поэтому средняя отличается от первой цены." },
    { title: "Затраты на покупку", target: metric("cost"),
      text: "Калькулятор умножает стоимость всей покупки в USDT на твой курс USDT. Здесь показывается, сколько рублей ушло на покупку." },
    { title: "Монеты после вывода", target: metric("received"),
      text: "Это количество {asset}, которое останется после комиссий за покупку и вывод. Комиссия за продажу учитывается дальше." },
    { title: "К получению", target: metric("payout"),
      text: "Здесь показано, сколько рублей принесёт продажа. Калькулятор учитывает комиссию продажи, доступный объём и лимиты выбранного объявления." },
    { title: "Заработано", target: metric("profit"),
      text: "Из суммы к получению вычитаются затраты на проданные монеты. Если продаёшь часть объёма, учитываются затраты только на эту часть. Отрицательная сумма означает убыток." },
    { title: "Цена безубыточности", target: metric("breakeven"),
      text: "Калькулятор делит затраты на проданные монеты на их количество. Получается цена за одну монету, при которой выручка покроет учтённые затраты." },
    { title: "Сохранить расчёт", target: "#save",
      text: "Нажми «Сохранить расчёт», чтобы посмотреть его позже. Кнопка доступна после успешного расчёта." },
    { title: "История расчётов", target: 'nav [data-view="history"]', history: true,
      text: "Открой «Историю», чтобы увидеть сохранённые расчёты, суммы и комиссии. Там можно сравнить результаты сделок." },
    { title: "Обучение завершено",
      text: "Теперь ты знаешь, как ввести параметры сделки, учесть комиссии, рассчитать спред и сохранить результат. Обучение можно повторить в настройках." },
  ];

  let index = -1;
  let listeners;
  let observer;
  let frame;
  let observedTarget;
  const step = () => steps[index];
  const element = (target) => typeof target === "function" ? target() : target ? find(target) : null;

  function targetForStep() {
    const entry = step();
    if (entry.offers && !find("#market").hidden) return find("#market > header");
    const target = element(entry.target);
    return visible(target) ? target : element(entry.fallback);
  }

  function scheduleLayout() {
    if (!listeners || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      layout();
    });
  }

  function boundsOf(target) {
    if (!visible(target)) return null;
    const bounds = target.getBoundingClientRect();
    const viewport = target.closest("main, aside")?.getBoundingClientRect();
    const left = Math.max(0, (viewport?.left ?? 0), bounds.left - 4);
    const right = Math.min(innerWidth, (viewport?.right ?? innerWidth), bounds.right + 4);
    const top = Math.max(0, (viewport?.top ?? 0), bounds.top - 4);
    const bottom = Math.min(innerHeight, (viewport?.bottom ?? innerHeight), bounds.bottom + 4);
    return right > left + 4 && bottom > top + 4 ? { left, right, top, bottom } : null;
  }

  const margin = 12;
  const gap = 12;
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

  function placeCard(bounds, allowScroll) {
    const width = Math.min(355, innerWidth - margin * 2);
    const height = innerHeight - margin * 2;
    const area = { left: margin, right: innerWidth - margin, top: margin, bottom: innerHeight - margin };
    const options = bounds ? [
      { ...area, left: bounds.right + gap },
      { ...area, right: bounds.left - gap },
      { ...area, top: bounds.bottom + gap },
      { ...area, bottom: bounds.top - gap },
    ] : [area];
    card.style.maxHeight = "";
    let best;
    for (const region of options) {
      const availableHeight = region.bottom - region.top;
      const fitWidth = Math.min(width, region.right - region.left);
      if (fitWidth < Math.min(236, width) || availableHeight < Math.min(130, height)) continue;
      card.style.width = fitWidth + "px";
      const naturalHeight = card.offsetHeight;
      const fit = { region, width: fitWidth, height: Math.min(naturalHeight, availableHeight) };
      if (availableHeight >= naturalHeight) { best = fit; break; }
      if (allowScroll && (!best || fit.height > best.height)) best = fit;
    }
    if (!best) return false;
    const { region } = best;
    const centerX = bounds ? (bounds.left + bounds.right) / 2 : innerWidth / 2;
    const centerY = bounds ? (bounds.top + bounds.bottom) / 2 : innerHeight / 2;
    Object.assign(card.style, {
      width: best.width + "px",
      maxHeight: best.height + "px",
      left: clamp(centerX - best.width / 2, region.left, region.right - best.width) + "px",
      top: clamp(centerY - best.height / 2, region.top, region.bottom - best.height) + "px",
    });
    return true;
  }

  function layout() {
    if (!listeners) return;
    // Native modal dialogs are above the tour. Restore the same step when they close.
    overlay.hidden = Boolean(find("dialog[open]"));
    if (overlay.hidden) return;
    const entry = step();
    const target = targetForStep();
    if (observedTarget !== target) {
      if (observedTarget) resize.unobserve(observedTarget);
      if (target) resize.observe(target);
      observedTarget = target;
    }
    const primary = element(entry.target);
    const asset = getAsset();
    let text = entry.text;
    let contextLabel = "";
    let action = null;
    if (entry.offers && !find("#market").hidden) {
      text = externalWalt
        ? "Открой Walt, чтобы посмотреть объявления. Вернись в калькулятор и введи цену вручную."
        : "Здесь можно посмотреть цены, доступные объёмы и способы оплаты. Нажми «Вернуться в калькулятор», чтобы продолжить с этого шага.";
      contextLabel = "Вернуться в калькулятор";
      action = () => { showView("calculator"); revealTarget(); };
    } else if (entry.offers && visible(target) && !visible(primary)) {
      text = "Для этой связки объявления Walt недоступны. Введи цену продажи вручную и переходи дальше.";
    } else if (!visible(primary) && asset === "USDT" && (entry.target === "#book-mode" || entry.target === "#manual")) {
      text = "Для USDT применяется цена 1 USDT. Стоимость в рублях задаёт введённый тобой курс покупки USDT.";
    } else if (visible(target) && !visible(primary) && entry.target === "#manual") {
      if (visible(find("#book-mode"))) {
        text = "В режиме стакана средняя цена зависит от всего объёма покупки. Включи «Ручной ввод», чтобы открыть поле цены.";
      }
    } else if (visible(target) && !visible(primary) && entry.alternate) {
      text = entry.alternate;
    }
    let bounds = boundsOf(target);
    if (!bounds && entry.target) {
      if (find("#calculator").hidden && !entry.history) {
        text += " Открой калькулятор, чтобы увидеть этот элемент.";
        contextLabel = "Вернуться в калькулятор";
        action = () => { showView("calculator"); revealTarget(); };
      } else if (visible(target)) {
        contextLabel = "Показать элемент";
        action = revealTarget;
      }
    }
    const body = text.replaceAll("{asset}", asset);
    if (content.textContent !== body) content.textContent = body;
    if (context.textContent !== contextLabel) context.textContent = contextLabel;
    context.hidden = !action;
    context.onclick = action;
    next.disabled = Boolean(entry.calculation && !hasEstimate());
    if (!placeCard(bounds, false)) {
      bounds = boundsOf(element(entry.layoutFallback)) ?? bounds;
      if (!placeCard(bounds, true)) {
        bounds = null;
        placeCard(null, true);
      }
    }
    overlay.classList.toggle("has-spotlight", Boolean(bounds));
    if (bounds) {
      Object.assign(spotlight.style, {
        left: bounds.left + "px", top: bounds.top + "px",
        width: (bounds.right - bounds.left) + "px", height: (bounds.bottom - bounds.top) + "px",
      });
    }
  }

  const resize = new ResizeObserver(scheduleLayout);

  function revealTarget() {
    const target = targetForStep();
    if (!visible(target)) { scheduleLayout(); return; }
    target.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    if (step().calculation && !target.disabled) target.focus({ preventScroll: true });
    scheduleLayout();
  }

  function goTo(newIndex) {
    if (newIndex < 0 || newIndex >= steps.length) return;
    index = newIndex;
    const entry = step();
    overlay.hidden = false;
    feedback.textContent = "";
    feedback.classList.remove("error");
    title.textContent = entry.title;
    find("#tour-count").textContent = "Шаг " + (index + 1) + " из " + steps.length;
    back.disabled = index === 0;
    const last = index === steps.length - 1;
    skip.textContent = last ? "Начать заново" : "Пропустить";
    next.textContent = last ? "Завершить" : "Далее";
    if (!entry.history && !last) showView("calculator");
    revealTarget();
    layout();
    title.focus({ preventScroll: true });
    const inputTarget = entry.focus?.();
    if (!compactLayout.matches && visible(inputTarget)) inputTarget.focus({ preventScroll: true });
    else if (entry.calculation && !find("#calculate").disabled) find("#calculate").focus({ preventScroll: true });
    requestAnimationFrame(() => { if (listeners) overlay.classList.add("moving"); });
  }

  function finish(completed) {
    if (!listeners) return;
    if (completed) storage.write("tutorial-completed", true);
    listeners.abort();
    listeners = null;
    resize.disconnect();
    observedTarget = null;
    observer.disconnect();
    cancelAnimationFrame(frame);
    frame = undefined;
    context.onclick = null;
    overlay.hidden = true;
    overlay.classList.remove("moving", "has-spotlight");
    index = -1;
    find("nav [aria-current='page']")?.focus({ preventScroll: true });
  }

  launch.onclick = () => {
    if (listeners) finish(false);
    listeners = new AbortController();
    const { signal } = listeners;
    document.addEventListener("scroll", scheduleLayout, { capture: true, signal });
    window.addEventListener("resize", scheduleLayout, { signal });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !find("dialog[open]")) {
        event.preventDefault();
        finish(false);
      }
    }, { signal });
    observer = new MutationObserver((changes) => {
      if (changes.some(({ target }) => !overlay.contains(target))) layout();
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["hidden", "open", "disabled"] });
    resize.observe(workspace);
    goTo(0);
  };
  back.onclick = () => goTo(index - 1);
  skip.onclick = () => index === steps.length - 1 ? goTo(0) : finish(false);
  next.onclick = () => {
    if (!listeners || (step().calculation && !hasEstimate())) return;
    if (index === steps.length - 1) finish(true);
    else goTo(index + 1);
  };

  return {
    onCalculation(error) {
      if (!listeners || !step().calculation) return;
      if (error) {
        feedback.textContent = error;
        feedback.classList.add("error");
        scheduleLayout();
      } else {
        goTo(index + 1);
      }
    },
  };
}
