"use strict";

const $ = (id) => document.getElementById(id);
const form = $("trade");
const field = (name) => form.elements.namedItem(name);
const fieldNames = ["ton", "rate", "sale", "buyMode", "manual_price", "buy_fee", "withdrawal", "sale_fee", "waltMode"];
const cacheAge = 60_000;
const adsRefreshInterval = 5_000;
const allOrdersRefreshInterval = 30_000;
const ordersPerPage = 50;
const bookMaxAge = 15_000;
const bybitFeeAge = 60_000;
const baseBuyFee = "0.1";
// Walt fee schedule for sell ads in RUB, published on 9 November 2026.
const waltFees = { taker: "0", merchant: "2", trusted: "1.6" };
const storage = {
  read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
};

const themes = $("theme-options");
const themeOptions = Array.from(themes.querySelectorAll('input[name="theme"]'));
const availableThemes = new Set(themeOptions.map((option) => option.value));
const storedTheme = storage.read("theme", "black");
const currentTheme = availableThemes.has(storedTheme) ? storedTheme : "black";
document.documentElement.dataset.theme = currentTheme;
for (const option of themeOptions) {
  option.checked = option.value === currentTheme;
}
themes.addEventListener("change", (event) => {
  const theme = event.target.value;
  if (!availableThemes.has(theme)) return;
  document.documentElement.dataset.theme = theme;
  storage.write("theme", theme);
});

let nextId = 0;
async function call(action, data = {}) {
  if (window.spreadPages) return window.spreadPages.call(action, data);
  const id = ++nextId;
  let response;
  try {
    const request = await fetch("/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action, ...data }),
      signal: AbortSignal.timeout(14_000),
    });
    if (!request.ok) throw new Error();
    response = await request.json();
  } catch {
    throw new Error("Не удалось связаться с сервером сайта.");
  }
  if (response.error) throw new Error(response.error);
  return response.value;
}

let book = null;
let bookTime = 0;
let bookRequest = null;
let waltConnected = false;
let bybitLogin = null;
let bybitFees = null;
let bybitFeeRequest = null;
let offers = [];
let offersPage = 1;
let offersSide = null;
let hasNextPage = false;
let offerTime = 0;
let offerPreview = null;
let showAllOrders = false;
let allOrdersLoaded = false;
let highestPriceFirst = false;
let adsRequest = 0;
let adsLoading = false;
let selected = null;
let estimate = null;
let version = 0;
let calculationRun = 0;
let history = storage.read("history", []);
const saved = storage.read("trade", {});
for (const name of fieldNames) {
  if (typeof saved[name] === "string") field(name).value = saved[name];
}
if (!field("buyMode").value) field("buyMode").value = "book";
if (!field("waltMode").value) field("waltMode").value = "taker";

const fmt = (value, digits = 2) => Number(value).toLocaleString("ru-RU", { maximumFractionDigits: digits });
const signed = (value) => (Number(value) > 0 ? "+" : "") + fmt(value);
const clock = (date) => new Date(date).toLocaleTimeString("ru-RU");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const compactLayout = matchMedia("(max-width: 680px)");

function enableSlidingOptions(group) {
  const indicator = document.createElement("div");
  indicator.className = "price-indicator";
  indicator.setAttribute("aria-hidden", "true");
  indicator.hidden = true;
  group.prepend(indicator);

  let animation;
  const positionWithin = (rect, origin) => ({
    transform: `translate(${rect.left - origin.left}px, ${rect.top - origin.top}px)`,
    width: rect.width + "px",
    height: rect.height + "px",
  });
  function move(animate) {
    const selectedLabel = group.querySelector("input:checked")?.closest("label");
    if (!selectedLabel || !group.getClientRects().length) {
      animation?.cancel();
      indicator.hidden = true;
      return;
    }
    const origin = group.getBoundingClientRect();
    const from = animate && !indicator.hidden && !reduceMotion.matches
      ? positionWithin(indicator.getBoundingClientRect(), origin) : null;
    const to = positionWithin(selectedLabel.getBoundingClientRect(), origin);
    animation?.cancel();
    indicator.hidden = false;
    Object.assign(indicator.style, to);
    if (from) animation = indicator.animate([from, to], { duration: 280, easing: "cubic-bezier(.2,.7,.25,1)" });
  }
  group.addEventListener("change", () => move(true));
  const observer = new ResizeObserver(() => move(false));
  observer.observe(group);
  for (const label of group.querySelectorAll("label")) observer.observe(label);
  move(false);
}

for (const group of document.querySelectorAll(".price-options")) enableSlidingOptions(group);

const statusAnimations = new WeakMap();
function status(id, message, error = false) {
  const element = $(id);
  const changed = element.textContent !== message;
  element.textContent = message;
  element.classList.toggle("error", error);
  if (!changed) return;
  statusAnimations.get(element)?.cancel();
  if (message && !reduceMotion.matches) {
    statusAnimations.set(element, element.animate(
      [{ opacity: 0.35 }, { opacity: 1 }],
      { duration: 220, easing: "ease-out" }
    ));
  }
}
function showView(id) {
  if (!$(id).hidden) return;
  if (id !== "settings") {
    for (const account of Object.keys(credentialFields)) setCredentialVisibility(account, false);
  }
  document.querySelectorAll(".view").forEach((view) => { view.hidden = view.id !== id; });
  document.querySelectorAll("nav [data-view]").forEach((button) => {
    if (button.dataset.view === id) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("workspace").scrollTop = 0;
  if (id === "calculator") pollBook();
  if (id === "market") {
    offerPreview = null;
    renderOffers();
    const refreshDelay = allOrdersLoaded ? allOrdersRefreshInterval : adsRefreshInterval;
    if (waltConnected && !adsLoading && Date.now() - offerTime >= refreshDelay) {
      loadAds(offersPage, { silent: Boolean(offerTime) });
    } else if (!waltConnected) {
      status("market-status", "Подключи Walt в настройках, чтобы видеть объявления.");
    } else if (!adsLoading) {
      refreshOfferSpreads();
    }
  }
}
document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

function updateMode() {
  $("manual").hidden = field("buyMode").value !== "manual";
}
function persistForm() {
  // A quote from an ad must be selected again after reopening the app.
  storage.write("trade", Object.fromEntries(fieldNames.map((name) =>
    [name, name === "sale" && selected ? "" : field(name).value])));
}
function invalidate() {
  version++;
  estimate = null;
  $("save").disabled = true;
  $("save-status").textContent = "";
  $("percent").className = "percent";
  $("calculator").classList.remove("has-result");
  $("percent").textContent = "—";
  $("profit").classList.remove("positive", "negative");
  document.querySelectorAll("[data-result]").forEach((node) => { node.textContent = "—"; });
  document.querySelectorAll("[data-partial]").forEach((node) => { node.hidden = true; });
  status("trade-status", "");
}
function clearSelection(message = "Цена указана вручную.") {
  selected = null;
  status("sale-source", message);
}
form.addEventListener("input", (event) => {
  if (event.target === field("sale")) clearSelection();
  if (event.target.name === "waltMode" && selected?.side === "BUY" && event.target.value !== "taker") {
    clearSelection("Цена скопирована из Walt. Для своего объявления проверь цену вручную.");
  }
  updateMode();
  showFees();
  invalidate();
  persistForm();
});
function parseDecimal(input, label) {
  const value = input.trim().replace(/[ \u00a0\u202f]/g, "").replace(",", ".");
  if (!/^(?:\d{1,7}(?:\.\d{1,8})?|\.\d{1,8})$/.test(value)) {
    throw new Error("Проверь поле «" + label + "».");
  }
  return value.startsWith(".") ? "0" + value : value;
}
function decimal(name, label) {
  return parseDecimal(field(name).value, label);
}

function salePrice() {
  try {
    const price = decimal("sale", "Цена продажи за GRAM, ₽");
    if (Number(price) > 0 && Number(price) <= 1_000_000) return price;
  } catch {
    // Give the field location rather than returning a generic validation error.
  }
  throw new Error("Укажи цену за 1 GRAM в рублях в блоке «Продажа за рубли» или выбери объявление Walt.");
}

function manualFee(name) {
  return field(name).value.trim() !== "";
}

function needsBybitFees() {
  return bybitLogin && (!manualFee("withdrawal") || !manualFee("buy_fee")) &&
    (!bybitFees || Date.now() - bybitFees.time > bybitFeeAge);
}

function tradeFees(waltMode) {
  const manualWithdrawal = manualFee("withdrawal");
  if (!manualWithdrawal && !bybitFees?.withdrawal) {
    throw new Error(window.spreadPages
      ? "Укажи комиссию вывода в GRAM. Если её нет, введи 0."
      : "Комиссия вывода неизвестна. Подключи Bybit в настройках или введи сумму вручную.");
  }
  return {
    buy_fee: manualFee("buy_fee") ? decimal("buy_fee", "Комиссия покупки") : (bybitFees?.trading?.percent ?? baseBuyFee),
    withdrawal: manualWithdrawal ? decimal("withdrawal", "Комиссия вывода") : bybitFees.withdrawal.fixed,
    withdrawal_percent: manualWithdrawal ? "0" : bybitFees.withdrawal.percent,
    sale_fee: manualFee("sale_fee") ? decimal("sale_fee", "Комиссия Walt") : waltFees[waltMode],
  };
}

function purchaseQuote() {
  return field("buyMode").value === "manual"
    ? { manual_price: decimal("manual_price", "Цена покупки"), asks: [] }
    : { manual_price: null, asks: book };
}

function offerLimits(ad) {
  return { min_amount: ad.minAmount, max_amount: ad.maxAmount, quantity: ad.lastQuantity };
}

const credentialFields = {
  walt: { button: "show-walt-key", key: "key", status: "key-status", label: "ключ" },
  bybit: { button: "show-bybit-keys", key: "bybit-key", secret: "bybit-secret", status: "bybit-fee-status", label: "ключи" },
};
const credentialRevision = { walt: 0, bybit: 0 };

function setCredentialVisibility(account, visible) {
  const { button, key, secret, label } = credentialFields[account];
  $(key).type = visible ? "text" : "password";
  if (secret) $(secret).type = $(key).type;
  $(button).setAttribute("aria-pressed", String(visible));
  $(button).textContent = (visible ? "Скрыть " : "Показать ") + label;
}

function updateCredentialPlaceholders() {
  $("key").placeholder = waltConnected ? "••••••••" : "";
  $("bybit-key").placeholder = $("bybit-secret").placeholder = bybitLogin ? "••••••••" : "";
}

for (const [account, { button, key, secret, status: statusId }] of Object.entries(credentialFields)) {
  $(button).onclick = async () => {
    if ($(key).type === "text") {
      setCredentialVisibility(account, false);
      return;
    }
    $(button).disabled = true;
    const revision = credentialRevision[account];
    try {
      if (!$(key).value && (!secret || !$(secret).value)) {
        const saved = await call("reveal_credential", { account });
        if ($("settings").hidden || revision !== credentialRevision[account]) return;
        if (!$(key).value && (!secret || !$(secret).value)) {
          if (!saved?.key) { status(statusId, "Сохранённых ключей пока нет."); return; }
          $(key).value = saved.key;
          if (secret) $(secret).value = saved.secret;
        }
      }
      setCredentialVisibility(account, true);
    } catch (error) {
      status(statusId, error.message, true);
    } finally {
      $(button).disabled = false;
    }
  };
}

function showFees() {
  const trading = bybitFees?.trading;
  const withdrawal = bybitFees?.withdrawal;
  const waltFee = waltFees[field("waltMode").value];
  field("buy_fee").placeholder = fmt(trading?.percent ?? baseBuyFee, 8);
  field("withdrawal").placeholder = withdrawal ? fmt(withdrawal.fixed, 8) : "Укажи комиссию";
  field("sale_fee").placeholder = fmt(waltFee, 8);
  const buyText = manualFee("buy_fee") ? "покупка вручную" :
    "покупка " + fmt(trading?.percent ?? baseBuyFee, 8) + "% (" + (trading ? "ставка Bybit" : "базовая оценка") + ")";
  let withdrawText = window.spreadPages ? "укажи комиссию вывода вручную" : "укажи вывод вручную или подключи Bybit";
  if (manualFee("withdrawal")) withdrawText = "вывод вручную";
  else if (withdrawal) {
    withdrawText = "вывод " + fmt(withdrawal.fixed, 8) + " GRAM";
    if (Number(withdrawal.percent)) withdrawText += " + " + fmt(withdrawal.percent, 8) + "%";
  }
  const sellText = manualFee("sale_fee") ? "Walt вручную" : "Walt " + fmt(waltFee) + "% по тарифу";
  status("fee-summary", [buyText, withdrawText, sellText].join(" · "));
}

function refreshBybitFees() {
  const login = bybitLogin;
  if (!login) return Promise.resolve();
  if (bybitFeeRequest) return bybitFeeRequest;
  status("bybit-fee-status", "Запрашиваю тарифы у Bybit…");
  $("connect-bybit").disabled = true;
  bybitFeeRequest = Promise.allSettled([
    call("bybit_fee", { kind: "trading" }),
    call("bybit_fee", { kind: "withdrawal" }),
  ]).then(([trading, withdrawal]) => {
    if (bybitLogin !== login) return;
    bybitFees = {
      trading: trading.status === "fulfilled" ? trading.value : null,
      withdrawal: withdrawal.status === "fulfilled" ? withdrawal.value : null,
      time: Date.now(),
    };
    const errors = [...new Set([trading, withdrawal].filter(item => item.status === "rejected").map(item => item.reason.message))];
    status("bybit-fee-status", errors.length ? errors.join(" ") : "Тарифы получены в " + clock(bybitFees.time) + ".", Boolean(errors.length));
    showFees();
  }).finally(() => {
    if (bybitLogin !== login) return;
    bybitFeeRequest = null;
    $("connect-bybit").disabled = false;
  });
  return bybitFeeRequest;
}

$("connect-bybit").onclick = async () => {
  const key = $("bybit-key").value.trim();
  const secret = $("bybit-secret").value.trim();
  if (!key || !secret) {
    if (!key && !secret && bybitLogin) { invalidate(); refreshBybitFees(); return; }
    status("bybit-fee-status", "Введи API Key и API Secret.", true);
    return;
  }
  $("connect-bybit").disabled = $("disconnect-bybit").disabled = true;
  credentialRevision.bybit++;
  try {
    await call("save_bybit", { login: { key, secret } });
    bybitLogin = {};
    bybitFees = null;
    $("bybit-key").value = $("bybit-secret").value = "";
    setCredentialVisibility("bybit", false);
    updateCredentialPlaceholders();
    invalidate();
    showFees();
    await refreshBybitFees();
  } catch (error) {
    status("bybit-fee-status", error.message, true);
  } finally {
    $("connect-bybit").disabled = $("disconnect-bybit").disabled = false;
  }
};
$("disconnect-bybit").onclick = async () => {
  $("connect-bybit").disabled = $("disconnect-bybit").disabled = true;
  credentialRevision.bybit++;
  try {
    await call("forget_credential", { account: "bybit" });
    bybitLogin = bybitFees = bybitFeeRequest = null;
    $("bybit-key").value = $("bybit-secret").value = "";
    setCredentialVisibility("bybit", false);
    updateCredentialPlaceholders();
    status("bybit-fee-status", "Bybit не подключён.");
    invalidate();
    showFees();
  } catch (error) {
    status("bybit-fee-status", error.message, true);
  } finally {
    $("connect-bybit").disabled = $("disconnect-bybit").disabled = false;
  }
};

function refreshBook() {
  bookRequest ??= fetchBook().finally(() => { bookRequest = null; });
  return bookRequest;
}

async function fetchBook() {
  const quote = $("book-status");
  const updated = $("book-updated");
  try {
    book = await call("bybit");
    bookTime = Date.now();
    const text = "Лучшая цена: " + fmt(book[0][0], 8) + " USDT";
    if (quote.textContent !== text) quote.textContent = text;
    quote.classList.remove("error");
    updated.textContent = clock(bookTime);
    return true;
  } catch (error) {
    const text = book && Date.now() - bookTime <= bookMaxAge
      ? "Последняя цена: " + fmt(book[0][0], 8) + " USDT"
      : error.message;
    if (quote.textContent !== text) quote.textContent = text;
    quote.classList.add("error");
    return false;
  }
}

function pollBook() {
  if (!document.hidden && !$("calculator").hidden) refreshBook();
}
setInterval(pollBook, 1000);
document.addEventListener("visibilitychange", pollBook);

form.onsubmit = async (event) => {
  event.preventDefault();
  invalidate();
  const revision = version;
  const run = ++calculationRun;
  const saleAd = selected?.side === "BUY" ? selected : null;
  $("calculate").disabled = true;
  try {
    const trade = {
      ton: decimal("ton", "Объём сделки"),
      rate: decimal("rate", "Курс покупки USDT"),
      sale: selected ? selected.price : salePrice(),
    };
    if (saleAd) {
      if (Date.now() - saleAd.time > cacheAge) throw new Error("Открой Walt P2P и выбери объявление заново.");
      trade.ad_limits = offerLimits(saleAd);
    }
    if (needsBybitFees()) {
      status("trade-status", "Обновляю комиссии Bybit…");
      await refreshBybitFees();
      if (revision !== version) return;
      status("trade-status", "");
    }
    Object.assign(trade, tradeFees(field("waltMode").value));
    if (field("buyMode").value !== "manual" && (!book || Date.now() - bookTime > bookMaxAge)) {
      status("trade-status", "Обновляю стакан Bybit…");
      const loaded = await refreshBook();
      if (revision !== version) return;
      if (!loaded) throw new Error("Укажи цену покупки GRAM вручную и повтори расчёт.");
      status("trade-status", "");
    }
    Object.assign(trade, purchaseQuote());
    const result = await call("estimate", { trade });
    if (revision !== version) return;
    if (saleAd) {
      if (Date.now() - saleAd.time > cacheAge) throw new Error("Открой Walt P2P и выбери объявление заново.");
      if (Number(result.payout) < Number(saleAd.minAmount)) {
        throw new Error("Сумма продажи " + fmt(result.payout) + " ₽. Лимит объявления " + fmt(saleAd.minAmount) + "–" + fmt(saleAd.maxAmount) + " ₽.");
      }
    }
    $("percent").textContent = signed(result.percent) + " %";
    if (Number(result.profit) !== 0) $("percent").classList.add(Number(result.profit) > 0 ? "positive" : "negative");
    $("profit").textContent = signed(result.profit) + " ₽";
    $("profit").classList.toggle("positive", Number(result.profit) > 0);
    $("profit").classList.toggle("negative", Number(result.profit) < 0);
    $("calculator").classList.add("has-result");
    for (const [name, unit, digits] of [["average"," USDT",8], ["cost"," ₽",2], ["received"," GRAM",8], ["sold"," GRAM",8], ["remaining"," GRAM",8], ["sold_cost"," ₽",2], ["payout"," ₽",2], ["breakeven"," ₽/GRAM",4]]) {
      document.querySelector('[data-result="' + name + '"]').textContent = fmt(result[name], digits) + unit;
    }
    document.querySelectorAll("[data-partial]").forEach((node) => { node.hidden = Number(result.remaining) <= 0; });
    estimate = {
      time: Date.now(), result,
      inputs: {
        ...Object.fromEntries(fieldNames.map((name) => [name, field(name).value])),
        buy_fee: trade.buy_fee, withdrawal: result.withdrawal_fee, sale_fee: trade.sale_fee,
      },
      saleSource: selected ? (saleAd ? "Walt · " : "Ориентир по Walt · ") + selected.nickname : "Ручная цена",
    };
    $("save").disabled = false;
  } catch (error) {
    if (revision === version) status("trade-status", error.message, true);
  } finally {
    if (run === calculationRun) {
      $("calculate").disabled = false;
      if (revision === version && compactLayout.matches && !$("calculator").hidden) {
        $("trade-result").scrollIntoView({ block: "start", behavior: reduceMotion.matches ? "instant" : "smooth" });
      }
    }
  }
};

function row(title, description, button) {
  const item = document.createElement("div");
  item.className = "row";
  const text = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const detail = document.createElement("small");
  detail.textContent = description;
  text.append(heading, detail);
  item.append(text);
  if (button) item.append(button);
  return item;
}
function smallButton(text, action) {
  const button = document.createElement("button");
  button.className = "quiet";
  button.textContent = text;
  button.onclick = action;
  return button;
}
function renderHistory(newItem = null) {
  const list = $("history-list");
  $("history-clear").disabled = !history.length;
  list.replaceChildren();
  if (!history.length) { list.append(Object.assign(document.createElement("p"), { textContent: "Пока нет сохранённых расчётов." })); }
  for (const item of history) {
    const remove = smallButton("Удалить", () => {
      const updated = history.filter((row) => row !== item);
      if (storage.write("history", updated)) { history = updated; renderHistory(); }
    });
    const fees = item.inputs;
    const extras = " · курс " + fees.rate + " ₽ · комиссии " + (fees.buy_fee || 0) + "% / " + (fees.withdrawal || 0) + " GRAM / " + (fees.sale_fee || 0) + "%";
    const partial = Number(item.result.remaining) > 0 ?
      " · к продаже " + fmt(item.result.sold, 8) + " GRAM · остаток " + fmt(item.result.remaining, 8) + " GRAM" : "";
    const entry = row(signed(item.result.percent) + " % · " + signed(item.result.profit) + " ₽",
      new Date(item.time).toLocaleString("ru-RU") + " · " + fees.ton + " GRAM · " + fees.sale + " ₽/GRAM · " + item.saleSource + partial + extras, remove);
    if (item === newItem) entry.classList.add("history-row-enter");
    list.append(entry);
  }
}

const historyClear = $("history-clear");
const historyHoldMs = 1000;
let historyHoldTimer;
historyClear.style.setProperty("--hold-duration", historyHoldMs + "ms");

function cancelHistoryHold() {
  clearTimeout(historyHoldTimer);
  historyHoldTimer = undefined;
  historyClear.classList.remove("holding");
}

function startHistoryHold() {
  if (historyClear.disabled || historyHoldTimer !== undefined) return;
  status("history-clear-status", "");
  historyClear.classList.add("holding");
  historyHoldTimer = setTimeout(() => {
    cancelHistoryHold();
    if ($("history").hidden || document.hidden || !history.length) return;
    if (!storage.write("history", [])) {
      status("history-clear-status", "Не удалось очистить историю.", true);
      return;
    }
    history = [];
    historyClear.classList.add("cleared");
    $("history-clear-label").textContent = "История очищена";
    renderHistory();
    setTimeout(() => {
      historyClear.classList.remove("cleared");
      $("history-clear-label").textContent = "Очистить историю";
    }, 1200);
  }, historyHoldMs);
}

historyClear.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !event.isPrimary) return;
  historyClear.setPointerCapture(event.pointerId);
  startHistoryHold();
});
for (const event of ["pointerup", "pointercancel", "lostpointercapture", "blur"]) {
  historyClear.addEventListener(event, cancelHistoryHold);
}
historyClear.addEventListener("pointermove", (event) => {
  if (historyHoldTimer === undefined || !historyClear.hasPointerCapture(event.pointerId)) return;
  const { left, right, top, bottom } = historyClear.getBoundingClientRect();
  if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) {
    cancelHistoryHold();
  }
});
const isHoldKey = (event) => event.key === " " || event.key === "Enter";
historyClear.addEventListener("keydown", (event) => {
  if (!isHoldKey(event)) return;
  event.preventDefault();
  if (!event.repeat) startHistoryHold();
});
historyClear.addEventListener("keyup", (event) => {
  if (!isHoldKey(event)) return;
  event.preventDefault();
  cancelHistoryHold();
});
window.addEventListener("blur", cancelHistoryHold);
document.addEventListener("visibilitychange", cancelHistoryHold);

$("save").onclick = () => {
  if (!estimate) return;
  const updated = [estimate, ...history].slice(0, 250);
  if (!storage.write("history", updated)) { status("trade-status", "Не удалось записать историю.", true); return; }
  history = updated;
  renderHistory(estimate);
  $("save").disabled = true;
  status("trade-status", "");
  $("save-status").textContent = "Расчёт сохранён";
};

function resetAds() {
  adsRequest++;
  adsLoading = false;
  $("offers").inert = false;
  offers = [];
  offerPreview = null;
  showAllOrders = false;
  allOrdersLoaded = false;
  offerTime = 0;
  offersPage = 1;
  offersSide = null;
  hasNextPage = false;
  renderOffers();
}
$("activate-key").onclick = async () => {
  const key = $("key").value.trim();
  if (!key) { status("key-status", "Введи ключ.", true); return; }
  $("activate-key").disabled = $("forget-key").disabled = true;
  credentialRevision.walt++;
  try {
    await call("save_walt", { key });
    waltConnected = true;
    $("key").value = "";
    setCredentialVisibility("walt", false);
    updateCredentialPlaceholders();
    resetAds();
    status("key-status", "Ключ сохранён. Проверяю доступ к объявлениям…");
    await loadAds(1);
  } catch (error) {
    status("key-status", error.message, true);
  } finally {
    $("activate-key").disabled = $("forget-key").disabled = false;
  }
};
$("forget-key").onclick = async () => {
  $("activate-key").disabled = $("forget-key").disabled = true;
  credentialRevision.walt++;
  try {
    await call("forget_credential", { account: "walt" });
  } catch (error) {
    status("key-status", error.message, true);
    return;
  } finally {
    $("activate-key").disabled = $("forget-key").disabled = false;
  }
  waltConnected = false;
  $("key").value = "";
  setCredentialVisibility("walt", false);
  updateCredentialPlaceholders();
  resetAds();
  if (selected) {
    field("sale").value = "";
    clearSelection("Введи цену вручную или выбери объявление.");
    invalidate();
    persistForm();
  }
  status("key-status", "Ключ не введён.");
  status("market-status", "");
};

function normalizeWaltOffer(ad, side) {
  if (!ad || !["string", "number"].includes(typeof ad.id) ||
      !["TON", "GRAM"].includes(ad.cryptoCurrency) || ad.fiatCurrency !== "RUB" || ad.side !== side ||
      typeof ad.nickname !== "string" || !Array.isArray(ad.payments) ||
      !ad.payments.every((method) => typeof method === "string")) return null;
  const values = {};
  for (const name of ["price", "minAmount", "maxAmount", "lastQuantity"]) {
    const value = String(ad[name]);
    const valid = name === "price" ? /^\d{1,7}(?:\.\d{1,20})?$/ : /^\d{1,12}(?:\.\d{1,16})?$/;
    if (!valid.test(value) || Number(value) <= 0) return null;
    values[name] = value;
  }
  if (Number(values.price) < 0.00000001 || Number(values.price) > 1_000_000 ||
      Number(values.minAmount) > Number(values.maxAmount)) return null;
  return { ...ad, ...values };
}

function sellableGram() {
  try {
    const volume = Number(decimal("ton", "Объём сделки"));
    if (volume <= 0 || volume > 1_000_000) return null;
    const buyFee = Number(manualFee("buy_fee") ? decimal("buy_fee", "Комиссия покупки") : (bybitFees?.trading?.percent ?? baseBuyFee));
    const manualWithdrawal = manualFee("withdrawal");
    const withdrawal = Number(manualWithdrawal ? decimal("withdrawal", "Комиссия вывода") : (bybitFees?.withdrawal?.fixed ?? 0));
    const withdrawalPercent = Number(manualWithdrawal ? 0 : (bybitFees?.withdrawal?.percent ?? 0));
    const saleFee = Number(manualFee("sale_fee") ? decimal("sale_fee", "Комиссия Walt") : waltFees.taker);
    if ([buyFee, withdrawalPercent, saleFee].some((fee) => fee >= 100)) return null;
    return Math.max(0, volume * (1 - buyFee / 100) - withdrawal) * (1 - withdrawalPercent / 100) * (1 - saleFee / 100);
  } catch {
    return null;
  }
}

async function previewOfferSpreads(pageOffers, side, request = adsRequest) {
  if (!pageOffers.length || $("market").hidden) return null;
  const canSell = side === "BUY";
  const results = new Map();
  try {
    const ton = decimal("ton", "Объём сделки");
    const rate = decimal("rate", "Курс покупки USDT");
    if (needsBybitFees()) await refreshBybitFees();
    const fees = tradeFees(canSell ? "taker" : field("waltMode").value);
    if (field("buyMode").value !== "manual" && (!book || Date.now() - bookTime > bookMaxAge)) {
      if (!await refreshBook()) throw new Error("Нет свежего стакана Bybit. Укажи цену покупки вручную.");
    }
    const trade = { ton, rate, sale: pageOffers[0].price, ...fees, ...purchaseQuote() };
    let firstError;
    for (let offset = 0; offset < pageOffers.length; offset += ordersPerPage) {
      if (request !== adsRequest) return null;
      const batch = pageOffers.slice(offset, offset + ordersPerPage);
      const estimates = await call("estimate_offers", {
        trade,
        offers: batch.map((ad) => ({ sale: ad.price, ad_limits: canSell ? offerLimits(ad) : null })),
      });
      estimates.forEach((result, index) => {
        if ("Ok" in result) results.set(String(batch[index].id), result.Ok);
        else firstError ??= result.Err;
      });
    }
    const message = results.size ? "" : "Спред не рассчитан. " + (firstError ?? "");
    return { results, message };
  } catch (error) {
    return { results, message: "Спред не рассчитан. " + error.message };
  }
}

async function refreshOfferSpreads() {
  const request = adsRequest;
  const revision = version;
  const preview = await previewOfferSpreads(offers, offersSide);
  if (request !== adsRequest || revision !== version || $("market").hidden) return;
  offerPreview = preview;
  renderOffers();
}

function renderOffers() {
  const sellSelected = document.querySelector('input[name="side"]:checked').value === "BUY";
  const allButton = $("all-orders");
  allButton.hidden = !sellSelected;
  allButton.disabled = !waltConnected;
  allButton.textContent = showAllOrders ? "Вернуть фильтры" : "Показать все ордеры";
  $("highest-price").hidden = !sellSelected;
  $("highest-price").setAttribute("aria-pressed", String(highestPriceFirst));
  $("market-amount").disabled = allOrdersLoaded;
  const filter = document.querySelector('input[name="payment"]:checked').value;
  const allowed = filter ? filter.split("|") : [];
  const amountText = $("market-amount").value.trim().replace(/[ \u00a0\u202f]/g, "").replace(",", ".");
  const amount = amountText === "" ? null : Number(amountText);
  const invalid = !allOrdersLoaded && amount !== null && (!/^\d{1,12}(?:\.\d{0,2})?$/.test(amountText) || amount <= 0);
  $("market-amount").setAttribute("aria-invalid", String(invalid));
  status("market-amount-status", invalid ? "Укажи сумму больше нуля, до двух знаков после запятой." : "", invalid);
  const kopecks = (rubles) => Math.round(rubles * 100);
  const covers = (value, target) => value + target * Number.EPSILON * 4 >= target;
  const buyAds = offersSide === "BUY";
  const preview = Date.now() - offerTime <= cacheAge ? offerPreview : null;
  const spreads = preview?.results;
  const order = buyAds
    ? highestPriceFirst ? "По цене за GRAM, от высокой к низкой" : "По чистой прибыли"
    : "Цена объявления используется как ориентир для продажи.";
  $("market-spread-status").textContent = [offerTime ? order : "", preview?.message].filter(Boolean).join(" · ");
  const sellable = buyAds ? sellableGram() : null;
  const visible = invalid ? [] : offers.filter((ad) => {
    if (allowed.length && !ad.payments.some((method) => allowed.includes(method.toLowerCase()))) return false;
    if (allOrdersLoaded) return true;
    const quantity = Number(ad.lastQuantity);
    const price = Number(ad.price);
    const available = Math.min(Number(ad.maxAmount), quantity * price);
    const minimum = Number(ad.minAmount);
    const spread = spreads?.get(String(ad.id));
    if (spread === null || !covers(available, minimum) ||
        (spread === undefined && sellable !== null && !covers(sellable * price, minimum))) return false;
    return amount === null || (kopecks(amount) >= kopecks(minimum) && kopecks(amount) <= kopecks(available));
  });
  visible.sort((first, second) => {
    const priceDifference = Number(second.price) - Number(first.price);
    if (!buyAds) return -priceDifference;
    if (highestPriceFirst) return priceDifference;
    const profit = (ad) => Number(spreads?.get(String(ad.id))?.profit ?? -Infinity);
    return (profit(second) - profit(first)) || priceDifference;
  });
  let pageOffers = visible;
  const count = $("orders-count");
  const countLabel = allOrdersLoaded ? "Ордеров: " : "Ордеров на странице: ";
  const countText = countLabel + fmt(visible.length, 0);
  if (count.textContent !== countText) count.textContent = countText;
  count.hidden = !offerTime || invalid;
  let canAdvance = hasNextPage && offersPage < 100;
  if (allOrdersLoaded) {
    const pageCount = Math.max(1, Math.ceil(visible.length / ordersPerPage));
    offersPage = Math.min(offersPage, pageCount);
    const start = (offersPage - 1) * ordersPerPage;
    pageOffers = visible.slice(start, start + ordersPerPage);
    canAdvance = offersPage < pageCount;
  }
  $("page").textContent = "Страница " + offersPage;
  $("prev-page").disabled = adsLoading || !offerTime || offersPage <= 1;
  $("next-page").disabled = adsLoading || !canAdvance;
  const list = $("offers");
  const workspace = $("workspace");
  const scrollTop = workspace.scrollTop;
  const existing = new Map([...list.querySelectorAll(".row[data-id]")].map((element) => [element.dataset.id, element]));
  const nodes = pageOffers.map((ad) => {
    const id = String(ad.id);
    let element = existing.get(id);
    if (!element) {
      element = row("", "", smallButton("Применить", () => {
        const current = offers.find((item) => String(item.id) === id);
        if (!current) return;
        if (Date.now() - offerTime > cacheAge) {
          status("market-status", "Список устарел. Дождись автоматического обновления.", true);
          return;
        }
        selected = { ...current, time: offerTime };
        field("sale").value = current.price;
        if (current.side === "BUY") field("waltMode").value = "taker";
        showFees();
        const source = current.side === "BUY" ? "Walt · " : "Ориентир по цене Walt · ";
        status("sale-source", source + current.nickname + " · " + clock(offerTime));
        persistForm();
        showView("calculator");
        form.requestSubmit();
      }));
      element.dataset.id = id;
      const spreadLine = document.createElement("small");
      spreadLine.className = "offer-spread";
      element.firstElementChild.append(spreadLine);
    }
    const title = element.querySelector("strong");
    const detail = element.querySelector("small");
    const titleText = fmt(ad.price, 8) + " ₽/GRAM · " + ad.nickname;
    const detailText = fmt(ad.minAmount) + "–" + fmt(ad.maxAmount) + " ₽ · " + fmt(ad.lastQuantity, 8) + " GRAM · " + ad.payments.join(", ");
    if (title.textContent !== titleText) title.textContent = titleText;
    if (detail.textContent !== detailText) detail.textContent = detailText;
    const result = spreads?.get(id);
    const spreadLine = element.querySelector(".offer-spread");
    spreadLine.hidden = !result && !(allOrdersLoaded && result === null);
    if (allOrdersLoaded && result === null) {
      spreadLine.textContent = "Объём сделки ниже минимума объявления.";
      spreadLine.classList.remove("positive", "negative");
    }
    if (result) {
      const label = buyAds ? "Спред " : "Спред по ориентиру ";
      const volume = (buyAds ? "к продаже " : "для ") + fmt(result.sold, 8) + " GRAM";
      const spreadText = label + signed(result.percent) + " % · " + signed(result.profit) + " ₽ · " + volume;
      if (spreadLine.textContent !== spreadText) spreadLine.textContent = spreadText;
      spreadLine.classList.toggle("positive", Number(result.profit) > 0);
      spreadLine.classList.toggle("negative", Number(result.profit) < 0);
    }
    return element;
  });
  if (offerTime && !nodes.length && !invalid) {
    const empty = document.createElement("p");
    empty.textContent = allOrdersLoaded ? "С выбранным способом оплаты ордеров нет." : "На этой странице нет подходящих объявлений.";
    nodes.push(empty);
  }
  const keep = new Set(nodes);
  for (const child of [...list.children]) {
    if (!keep.has(child)) child.remove();
  }
  nodes.forEach((element, index) => {
    if (list.children[index] !== element) list.insertBefore(element, list.children[index] || null);
  });
  if (!$("market").hidden) {
    workspace.scrollTop = scrollTop;
  }
}
async function loadAds(page, { silent = false } = {}) {
  if (!waltConnected) { status("market-status", "Добавь ключ Walt в настройках.", true); return; }
  if (silent && adsLoading) return;
  const request = ++adsRequest;
  const side = document.querySelector('input[name="side"]:checked').value;
  const all = side === "BUY" && showAllOrders;
  const switching = offersSide !== null && offersSide !== side;
  const list = $("offers");
  let changedSide = false;
  adsLoading = true;
  list.inert = switching || allOrdersLoaded !== all;
  if (!silent) {
    renderOffers();
    status("market-status", "Загрузка объявлений…");
  }
  try {
    const loaded = new Map();
    let pageNumber = all ? 1 : page;
    let receivedAt;
    let fullPage;
    do {
      const data = await call("walt", { side, page: pageNumber });
      if (request !== adsRequest) return;
      receivedAt ??= Date.now();
      for (const ad of data) {
        const offer = normalizeWaltOffer(ad, side);
        if (offer) loaded.set(String(offer.id), offer);
      }
      fullPage = data.length >= ordersPerPage;
      pageNumber++;
    } while (all && fullPage && pageNumber <= 100);
    const nextOffers = [...loaded.values()];
    const revision = version;
    const preview = await previewOfferSpreads(nextOffers, side, request);
    if (request !== adsRequest) return;
    offers = nextOffers;
    offerPreview = revision === version ? preview : null;
    offersPage = all ? (allOrdersLoaded ? offersPage : 1) : page;
    offersSide = side;
    allOrdersLoaded = all;
    changedSide = switching;
    hasNextPage = !all && fullPage;
    offerTime = receivedAt;
    $("market-status").textContent = "Обновлено в " + clock(offerTime);
    if (all && fullPage) $("market-status").textContent += " · достигнут предел в 100 страниц";
    $("market-status").classList.remove("error");
    status("key-status", "Walt ответил на запрос объявлений.");
  } catch (error) {
    if (request === adsRequest) {
      if (side === "BUY") showAllOrders = allOrdersLoaded;
      if (switching) document.querySelector(`input[name="side"][value="${offersSide}"]`).checked = true;
      status("market-status", error.message + (offerTime ? " · Показаны предыдущие данные от " + clock(offerTime) : ""), true);
      status("key-status", error.message, true);
    }
  } finally {
    if (request === adsRequest) {
      adsLoading = false;
      list.inert = false;
      renderOffers();
      if (changedSide && !reduceMotion.matches) {
        list.getAnimations().forEach((animation) => animation.cancel());
        list.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 240, easing: "ease-out" });
      }
    }
  }
}
$("market-amount").oninput = renderOffers;
function changeOffersPage(step) {
  if (allOrdersLoaded) {
    offersPage += step;
    renderOffers();
  } else {
    loadAds(offersPage + step);
  }
}
$("prev-page").onclick = () => changeOffersPage(-1);
$("next-page").onclick = () => changeOffersPage(1);
$("highest-price").onclick = () => {
  highestPriceFirst = !highestPriceFirst;
  if (allOrdersLoaded) offersPage = 1;
  renderOffers();
};
$("all-orders").onclick = () => {
  showAllOrders = !showAllOrders;
  loadAds(1);
};
document.querySelectorAll('input[name="side"]').forEach((input) => input.addEventListener("change", () => {
  if (waltConnected) loadAds(1);
  else renderOffers();
}));
document.querySelectorAll('input[name="payment"]').forEach((input) => input.addEventListener("change", () => {
  if (allOrdersLoaded) offersPage = 1;
  renderOffers();
}));
setInterval(() => {
  if (waltConnected && !document.hidden && !$("market").hidden &&
      (!allOrdersLoaded || Date.now() - offerTime >= allOrdersRefreshInterval)) {
    loadAds(offersPage, { silent: true });
  }
}, adsRefreshInterval);
updateMode();
showFees();
renderHistory();
pollBook();
async function connectSavedAccounts() {
  const buttons = ["activate-key", "forget-key", "connect-bybit", "disconnect-bybit"];
  for (const id of buttons) $(id).disabled = true;
  let savedAccounts;
  try {
    savedAccounts = await call("saved_credentials");
  } catch (error) {
    status("key-status", error.message, true);
    status("bybit-fee-status", error.message, true);
    return;
  } finally {
    for (const id of buttons) $(id).disabled = false;
  }
  waltConnected = savedAccounts.walt;
  status("key-status", waltConnected ? "Ключ загружен." : "Ключ не введён.");
  if (waltConnected && !$("market").hidden) loadAds(1);
  if (savedAccounts.bybit) {
    bybitLogin = {};
    refreshBybitFees();
  }
  updateCredentialPlaceholders();
}
connectSavedAccounts();
