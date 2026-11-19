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
const bookRefreshInterval = 3_000;
const bybitFeeAge = 20 * 60_000;
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
const bybitRoutes = ["GRAM", "USDT", "ETH", "NOT"].map((asset) => ({
  id: asset, asset, source: "Bybit", destination: "Walt",
}));
const bingxRoutes = bybitRoutes.map(item => ({ ...item, id: `BingX-${item.asset}`, source: "BingX" }));
const presetRoutes = [...bybitRoutes, ...bingxRoutes];
const supportedAssets = new Set(presetRoutes.map(({ asset }) => asset));
const customRoutes = storage.read("custom-routes", []);
const routes = [...presetRoutes, ...customRoutes];
const activeRouteId = storage.read("active-route", "GRAM");
let route = routes.find(({ id }) => id === activeRouteId) ?? presetRoutes[0];
let routeRevision = 0;
const usesBybit = () => /^bybit(?: spot)?$/i.test(route.source) && supportedAssets.has(route.asset);
const usesBingx = () => /^bingx(?: spot)?$/i.test(route.source) && supportedAssets.has(route.asset);
const exchangeName = () => usesBingx() ? "BingX" : "Bybit";
const usesWalt = () => /^walt(?: p2p)?$/i.test(route.destination) && supportedAssets.has(route.asset);
const directUsdt = () => route.asset === "USDT";
const hasOrderBook = () => (usesBybit() || usesBingx()) && !directUsdt();
const usesOrderBook = () => hasOrderBook() && field("buyMode").value === "book";
const automaticBuyFee = () => hasOrderBook() ? (routeFees?.trading?.percent ?? baseBuyFee) : "0";
const saleFeeRate = (mode) => usesWalt() ? waltFees[mode] : "0";
const tradeStorageKey = () => route.id === "GRAM" ? "trade" : "trade." + route.id;

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
const bookRequests = new Map();
const bookSnapshots = new Map();
let waltLocal = false;
let waltRelay = false;
const waltConnected = () => waltLocal || waltRelay;
let bybitLogin = null;
let bybitRelay = false;
let p2pRateRequest = null;
let p2pRateCache = null;
let autoBybitRate = false;
const autoP2pRate = $("auto-p2p-rate");
autoP2pRate.checked = storage.read("auto-p2p-rate", false) === true;
$("auto-p2p-access-note").hidden = !window.spreadPages || window.spreadPages.hasP2pAccess;
let p2pPreferenceRevision = 0;
let bingxRelay = false;
let bingxLocal = false;
const bingxConnected = () => bingxRelay || bingxLocal;
const bingxFeeRequests = new Map();
const bingxFeeCache = new Map();
let routeFees = null;
let bybitFeeRequest = null;
const feeRequests = new Map();
const feeCache = new Map();
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
function restoreTradeForm() {
  const saved = storage.read(tradeStorageKey(), {});
  autoBybitRate = saved.autoBybitRate === true;
  for (const name of fieldNames) field(name).value = typeof saved[name] === "string" ? saved[name] : "";
  field("buyMode").value = hasOrderBook() && saved.buyMode !== "manual" ? "book" : "manual";
  if (!field("waltMode").value) field("waltMode").value = "taker";
}
restoreTradeForm();

const fmt = (value, digits = 2) => Number(value).toLocaleString("ru-RU", { maximumFractionDigits: digits });
const signed = (value) => (Number(value) > 0 ? "+" : "") + fmt(value);
const clock = (date) => new Date(date).toLocaleTimeString("ru-RU");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

function enableSlidingOptions(group, selected = () => group.querySelector("input:checked")?.closest("label"), indicatorClass = "price-indicator") {
  const indicator = document.createElement("div");
  indicator.className = indicatorClass;
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
    const target = selected();
    if (!target || !group.getClientRects().length) {
      animation?.cancel();
      indicator.hidden = true;
      return;
    }
    const origin = group.getBoundingClientRect();
    const from = animate && !indicator.hidden && !reduceMotion.matches
      ? positionWithin(indicator.getBoundingClientRect(), origin) : null;
    const to = positionWithin(target.getBoundingClientRect(), origin);
    animation?.cancel();
    indicator.hidden = false;
    Object.assign(indicator.style, to);
    if (from) animation = indicator.animate([from, to], { duration: 280, easing: "cubic-bezier(.2,.7,.25,1)" });
  }
  group.addEventListener("change", () => move(true));
  group.addEventListener("refresh-selection", () => move(false));
  const observer = new ResizeObserver(() => move(false));
  observer.observe(group);
  for (const label of group.querySelectorAll("label")) observer.observe(label);
  move(false);
  return move;
}

for (const group of document.querySelectorAll(".price-options")) enableSlidingOptions(group);
const moveRouteIndicator = enableSlidingOptions($("route-list"),
  () => $("route-list").querySelector('.route-card[aria-pressed="true"]'), "route-indicator");

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
  if (id === "routes") moveRouteIndicator(false);
  if (id === "settings") refreshCloudflareStatuses();
  if (id === "conversion") {
    if (!$("conversion-rate").value) $("conversion-rate").value = storage.read("trade", {}).rate ?? "";
    updateConversion();
  }
  if (id === "market") {
    offerPreview = null;
    renderOffers();
    const refreshDelay = allOrdersLoaded ? allOrdersRefreshInterval : adsRefreshInterval;
    if (waltConnected() && !adsLoading && Date.now() - offerTime >= refreshDelay) {
      loadAds(offersPage, { silent: Boolean(offerTime) });
    } else if (!waltConnected()) {
      status("market-status", "Подключи Walt в настройках, чтобы видеть объявления.");
    } else if (!adsLoading) {
      refreshOfferSpreads();
    }
  }
}
document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

const cloudflareServices = [...document.querySelectorAll("[data-cloudflare-service]")].map(node => {
  const label = document.createElement("span");
  label.className = "cloudflare-dot";
  label.setAttribute("role", "img");
  label.setAttribute("aria-label", "Ожидает проверки");
  const detail = document.createElement("small");
  node.replaceChildren(label, detail);
  return { node, label, detail };
});
const cloudflareCheckInterval = 30_000;
const cloudflareLabels = { ready: "Работает", partial: "Работает частично", unconfigured: "Не настроено", error: "Ошибка" };
let cloudflareCheckedAt = 0;
let cloudflareChecking = false;

async function checkCloudflareService(service) {
  const probe = async id => {
    try {
      const result = await call("cloudflare_status", { service: id });
      return Object.hasOwn(cloudflareLabels, result?.state) ? result : { state: "error" };
    } catch (error) {
      return { state: "error", detail: error.message };
    }
  };
  if (service !== "bingx" && service !== "bybit") return probe(service);

  const feesProbe = service === "bybit" ? checkBybitFees() : probe("bingx_fees");
  const [book, fees] = await Promise.all([probe(`${service}_book`), feesProbe]);
  if (book.state === "ready" && fees.state === "ready") return { state: "ready" };
  const state = [book, fees].some(part => part.state === "ready") ? "partial" :
    [book, fees].some(part => part.state === "error") ? "error" : "unconfigured";
  const detail = [["Стакан", book], ["Комиссии", fees]]
    .filter(([, part]) => part.state !== "ready")
    .map(([name, part]) => `${name} · ${part.detail || cloudflareLabels[part.state]}`).join(" ");
  return { state, detail: service === "bybit" && book.state === "ready" ? "Стакан работает. " + detail : detail };
}

async function checkBybitFees() {
  if (!bybitLogin) return { state: "unconfigured", detail: "Подключи ключ Bybit в настройках." };
  const fees = await Promise.allSettled([loadBybitFee("trading", "GRAM"), loadBybitFee("withdrawal", "GRAM")]);
  const errors = [...new Set(fees.filter(result => result.status === "rejected").map(result => result.reason.message))];
  return errors.length ? { state: "error", detail: errors.join(" ") } : { state: "ready" };
}

async function refreshCloudflareStatuses(force = false) {
  if ($("settings").hidden || document.hidden || cloudflareChecking ||
      (!force && Date.now() - cloudflareCheckedAt < cloudflareCheckInterval)) return;
  cloudflareChecking = true;
  $("check-cloudflare").disabled = true;
  if (!cloudflareCheckedAt) $("cloudflare-checked").textContent = "Проверяю…";
  try {
    await Promise.all(cloudflareServices.map(async ({ node, label, detail }) => {
      const { state, detail: message = "" } = await checkCloudflareService(node.dataset.cloudflareService);
      if (node.dataset.state !== state) node.dataset.state = state;
      if (label.getAttribute("aria-label") !== cloudflareLabels[state]) {
        label.setAttribute("aria-label", cloudflareLabels[state]);
        label.title = cloudflareLabels[state];
      }
      if (detail.textContent !== message) detail.textContent = message;
    }));
    cloudflareCheckedAt = Date.now();
    $("cloudflare-checked").textContent = "Проверено в " + clock(cloudflareCheckedAt);
  } finally {
    cloudflareChecking = false;
    $("check-cloudflare").disabled = false;
  }
}

$("check-cloudflare").onclick = () => refreshCloudflareStatuses(true);
setInterval(refreshCloudflareStatuses, 5_000);
document.addEventListener("visibilitychange", () => refreshCloudflareStatuses());

function updateMode() {
  $("manual").hidden = directUsdt() || usesOrderBook();
}
function persistForm() {
  // A quote from an ad must be selected again after reopening the app.
  storage.write(tradeStorageKey(), {
    ...Object.fromEntries(fieldNames.map((name) => [name, name === "sale" && selected ? "" : field(name).value])),
    autoBybitRate,
  });
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
  if (event.target.name === "purchaseExchange") return;
  if (event.target === field("sale")) clearSelection();
  if (event.target === field("rate")) {
    autoBybitRate = false;
    status("bybit-p2p-rate-status", "");
  }
  if (event.target.name === "waltMode" && selected?.side === "BUY" && event.target.value !== "taker") {
    clearSelection("Цена скопирована из Walt. Для своего объявления проверь цену вручную.");
  }
  updateMode();
  showFees();
  invalidate();
  persistForm();
});

async function importBybitP2pRate(explicit = false) {
  const enabled = usesBybit() && Boolean(window.spreadPages?.hasP2pAccess || bybitRelay);
  $("bybit-rate-import").hidden = !enabled;
  $("bingx-p2p-rate-status").hidden = !usesBingx();
  const previous = field("rate").value;
  if (!enabled || (!explicit && (!autoP2pRate.checked || (previous.trim() && !autoBybitRate)))) return;
  const revision = routeRevision;
  const preference = p2pPreferenceRevision;
  const stillEnabled = () => explicit || (autoP2pRate.checked && preference === p2pPreferenceRevision);
  const button = $("bybit-p2p-rate");
  if (explicit) status("bybit-p2p-rate-status", "Загружаю курс…");
  button.disabled = true;
  try {
    const cached = !explicit && p2pRateCache && Date.now() - p2pRateCache.at < 5 * 60_000;
    if (!cached) {
      p2pRateRequest ??= call("bybit_last_usdt_rate").then(result => {
        p2pRateCache = { ...result, at: Date.now() };
      }).finally(() => { p2pRateRequest = null; });
      await p2pRateRequest;
    }
    if (!stillEnabled() || revision !== routeRevision || previous !== field("rate").value) return;
    const rate = parseDecimal(p2pRateCache.rate, "Курс покупки USDT").replace(".", ",");
    if (previous !== rate) {
      field("rate").value = rate;
      invalidate();
      if (!$("market").hidden) refreshOfferSpreads();
    }
    autoBybitRate = true;
    persistForm();
    status("bybit-p2p-rate-status", "Ордер от " + new Date(p2pRateCache.time).toLocaleDateString("ru-RU"));
  } catch (error) {
    if (stillEnabled() && revision === routeRevision) status("bybit-p2p-rate-status", error.message, true);
  } finally {
    button.disabled = Boolean(p2pRateRequest);
  }
}

$("bybit-p2p-rate").onclick = () => importBybitP2pRate(true);
autoP2pRate.onchange = () => {
  p2pPreferenceRevision++;
  storage.write("auto-p2p-rate", autoP2pRate.checked);
  if (autoP2pRate.checked) importBybitP2pRate();
  else status("bybit-p2p-rate-status", "");
};
setInterval(() => {
  if (!document.hidden && (!$("calculator").hidden || !$("market").hidden)) importBybitP2pRate();
}, 60_000);
function parseDecimal(input, label) {
  const value = input.trim().replace(/[ \u00a0\u202f]/g, "").replace(",", ".");
  if (!/^(?:\d{1,9}(?:\.\d{1,8})?|\.\d{1,8})$/.test(value)) {
    throw new Error("Проверь поле «" + label + "».");
  }
  return value.startsWith(".") ? "0" + value : value;
}
function decimal(name, label) {
  return parseDecimal(field(name).value, label);
}

function salePrice() {
  try {
    const price = decimal("sale", "Цена продажи за " + route.asset + ", ₽");
    if (Number(price) > 0 && Number(price) <= 100_000_000) return price;
  } catch {
    // Give the field location rather than returning a generic validation error.
  }
  throw new Error("Укажи цену за 1 " + route.asset + " в рублях в блоке «Продажа за рубли».");
}

function manualFee(name) {
  return field(name).value.trim() !== "";
}

function needsRouteFees() {
  return (usesBingx() ? bingxConnected() : usesBybit() && bybitLogin) &&
    ((usesWalt() && !manualFee("withdrawal")) || (hasOrderBook() && !manualFee("buy_fee"))) &&
    (!routeFees || Date.now() - routeFees.time > bybitFeeAge);
}

function tradeFees(waltMode) {
  const manualWithdrawal = manualFee("withdrawal");
  const withdrawal = usesWalt() ? routeFees?.withdrawal : null;
  if (!manualWithdrawal && !withdrawal) {
    const hint = usesBingx() && routeFees?.withdrawalError ? routeFees.withdrawalError + " Введи сумму вручную." :
      usesBybit() && usesWalt() ? "Подключи Bybit в настройках или введи сумму вручную." : "Введи сумму вручную.";
    throw new Error("Комиссия вывода неизвестна. " + hint);
  }
  return {
    buy_fee: manualFee("buy_fee") ? decimal("buy_fee", "Комиссия покупки") : automaticBuyFee(),
    withdrawal: manualWithdrawal ? decimal("withdrawal", "Комиссия вывода") : withdrawal.fixed,
    withdrawal_percent: manualWithdrawal ? "0" : withdrawal.percent,
    sale_fee: manualFee("sale_fee") ? decimal("sale_fee", "Комиссия продажи") : saleFeeRate(waltMode),
  };
}

function purchaseQuote() {
  if (directUsdt()) return { manual_price: "1", asks: [] };
  if (usesOrderBook()) return { manual_price: null, asks: book };
  return { manual_price: decimal("manual_price", "Цена покупки"), asks: [] };
}

function offerLimits(ad) {
  return { min_amount: ad.minAmount, max_amount: ad.maxAmount, quantity: ad.lastQuantity };
}

const credentialFields = {
  walt: { button: "show-walt-key", key: "key", status: "key-status", label: "ключ", saved: () => waltLocal },
  bybit: { button: "show-bybit-keys", key: "bybit-key", secret: "bybit-secret", status: "bybit-fee-status", label: "ключи", saved: () => Boolean(bybitLogin?.local) },
  bingx: { button: "show-bingx-keys", key: "bingx-key", secret: "bingx-secret", status: "bingx-fee-status", label: "ключи", saved: () => bingxLocal },
};
const credentialRevision = { walt: 0, bybit: 0, bingx: 0 };

function setCredentialVisibility(account, visible) {
  const { button, key, secret, label } = credentialFields[account];
  $(key).type = visible ? "text" : "password";
  if (secret) $(secret).type = $(key).type;
  $(button).setAttribute("aria-pressed", String(visible));
  $(button).textContent = (visible ? "Скрыть " : "Показать ") + label;
  updateCredentialPlaceholders();
}

function updateCredentialPlaceholders() {
  for (const { key, secret, saved } of Object.values(credentialFields)) {
    const masked = saved() && $(key).type === "password";
    for (const input of secret ? [$(key), $(secret)] : [$(key)]) {
      if (masked) input.placeholder = "••••••••";
      else input.removeAttribute("placeholder");
    }
  }
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
  const trading = routeFees?.trading;
  const withdrawal = usesWalt() ? routeFees?.withdrawal : null;
  const saleFee = saleFeeRate(field("waltMode").value);
  const automaticFee = automaticBuyFee();
  field("buy_fee").placeholder = fmt(automaticFee, 8);
  field("withdrawal").placeholder = withdrawal ? fmt(withdrawal.fixed, 8) : "Укажи комиссию";
  field("sale_fee").placeholder = fmt(saleFee, 8);
  const buyText = manualFee("buy_fee") ? "покупка вручную" :
    "покупка " + fmt(automaticFee, 8) + "%" + (hasOrderBook() ? (trading ? " (ставка " + exchangeName() + ")" : " (базовая оценка)") : "");
  let withdrawText = usesBybit() && usesWalt() ? "укажи вывод вручную или подключи Bybit" : "укажи вывод вручную";
  if (manualFee("withdrawal")) withdrawText = "вывод вручную";
  else if (withdrawal) {
    withdrawText = "вывод " + fmt(withdrawal.fixed, 8) + " " + route.asset;
    if (Number(withdrawal.percent)) withdrawText += " + " + fmt(withdrawal.percent, 8) + "%";
  }
  const sellText = manualFee("sale_fee") ? "продажа вручную" : "продажа " + fmt(saleFee) + "%" + (usesWalt() ? " по тарифу Walt" : "");
  status("fee-summary", [buyText, withdrawText, sellText].join(" · "));
}

function loadBybitFee(kind, asset, force = false) {
  const key = `${kind}:${asset}`;
  const cached = feeCache.get(key);
  if (!force && cached && Date.now() - cached.time < bybitFeeAge) return Promise.resolve(cached.value);
  if (feeRequests.has(key)) return feeRequests.get(key);
  const login = bybitLogin;
  const request = call("bybit_fee", { kind, asset }).then(value => {
    if (bybitLogin === login) feeCache.set(key, { value, time: Date.now() });
    return value;
  }).finally(() => {
    if (feeRequests.get(key) === request) feeRequests.delete(key);
  });
  feeRequests.set(key, request);
  return request;
}

function resetBybitFeeCache() {
  bybitFeeRequest = null;
  if (usesBybit()) routeFees = null;
  feeRequests.clear();
  feeCache.clear();
  updateConversion();
}

function loadBingxFees(asset, spot, walt) {
  const id = `${asset}:${spot}:${walt}`;
  const cached = bingxFeeCache.get(id);
  let request = bingxFeeRequests.get(id);
  if (cached && Date.now() - cached.time < bybitFeeAge) request = Promise.resolve(cached);
  if (!request) {
    const revision = credentialRevision.bingx;
    request = Promise.allSettled([
      spot ? call("bingx_fee", { kind: "trading", asset }) : null,
      walt ? call("bingx_fee", { kind: "withdrawal", asset }) : null,
    ]).then(([trading, withdrawal]) => {
      const fees = {
        trading: trading.status === "fulfilled" ? trading.value : null,
        withdrawal: withdrawal.status === "fulfilled" ? withdrawal.value : null,
        withdrawalError: withdrawal.status === "rejected" ? withdrawal.reason.message : "",
        errors: [trading, withdrawal].filter(item => item.status === "rejected").map(item => item.reason.message),
        time: Date.now(),
      };
      if (credentialRevision.bingx === revision) bingxFeeCache.set(id, fees);
      return fees;
    }).finally(() => { if (bingxFeeRequests.get(id) === request) bingxFeeRequests.delete(id); });
    bingxFeeRequests.set(id, request);
  }
  return request;
}

function refreshRouteFees() {
  if (!usesBingx()) return refreshBybitFees();
  if (!bingxConnected()) return Promise.resolve();
  const revision = routeRevision;
  const credentials = credentialRevision.bingx;
  return loadBingxFees(route.asset, hasOrderBook(), usesWalt()).then(fees => {
    if (routeRevision !== revision || credentialRevision.bingx !== credentials) return;
    routeFees = fees;
    const errors = [...new Set(fees.errors)];
    const sources = [...new Set([fees.trading?.source, fees.withdrawal?.source].filter(Boolean))];
    const source = sources.length === 2 ? "через Cloudflare и напрямую" : sources[0] === "direct" ? "напрямую из BingX" : "через Cloudflare";
    const message = errors.length ? errors.join(" ") : "Тарифы получены " + source + " в " + clock(fees.time) + ".";
    status("bingx-fee-status", message + (bingxLocal ? " Запасной ключ сохранён." : ""), Boolean(errors.length));
    showFees();
  });
}

function refreshBybitFees(force = false) {
  const login = bybitLogin;
  if (!login || !usesBybit()) return Promise.resolve();
  if (bybitFeeRequest) return bybitFeeRequest;
  const revision = routeRevision;
  const asset = route.asset;
  status("bybit-fee-status", "Запрашиваю тарифы у Bybit…");
  $("connect-bybit").disabled = true;
  bybitFeeRequest = Promise.allSettled([
    hasOrderBook() ? loadBybitFee("trading", asset, force) : null,
    usesWalt() ? loadBybitFee("withdrawal", asset, force) : null,
  ]).then(([trading, withdrawal]) => {
    if (bybitLogin !== login || routeRevision !== revision) return;
    const now = Date.now();
    routeFees = {
      trading: trading.status === "fulfilled" ? trading.value : null,
      withdrawal: withdrawal.status === "fulfilled" ? withdrawal.value : null,
      time: Math.min(now,
        trading.status === "fulfilled" && trading.value ? (feeCache.get(`trading:${asset}`)?.time ?? now) : now,
        withdrawal.status === "fulfilled" && withdrawal.value ? (feeCache.get(`withdrawal:${asset}`)?.time ?? now) : now),
    };
    const errors = [...new Set([trading, withdrawal].filter(item => item.status === "rejected").map(item => item.reason.message))];
    const sources = [...new Set([routeFees.trading?.source, routeFees.withdrawal?.source].filter(Boolean))];
    const source = sources.length === 2 ? " через Cloudflare и напрямую" : sources[0] === "relay" ? " через Cloudflare" : " напрямую из Bybit";
    status("bybit-fee-status", errors.length ? errors.join(" ") : "Тарифы получены" + source + " в " + clock(routeFees.time) + ".", Boolean(errors.length));
    showFees();
    updateConversion();
  }).finally(() => {
    if (bybitLogin !== login || routeRevision !== revision) return;
    bybitFeeRequest = null;
    $("connect-bybit").disabled = false;
  });
  return bybitFeeRequest;
}

$("connect-bybit").onclick = async () => {
  const key = $("bybit-key").value.trim();
  const secret = $("bybit-secret").value.trim();
  if (!key || !secret) {
    if (!key && !secret && bybitLogin) { invalidate(); refreshBybitFees(true); return; }
    status("bybit-fee-status", "Введи API Key и API Secret.", true);
    return;
  }
  $("connect-bybit").disabled = $("disconnect-bybit").disabled = true;
  credentialRevision.bybit++;
  try {
    await call("save_bybit", { login: { key, secret } });
    bybitLogin = { local: true };
    resetBybitFeeCache();
    $("bybit-key").value = $("bybit-secret").value = "";
    setCredentialVisibility("bybit", false);
    updateCredentialPlaceholders();
    invalidate();
    showFees();
    await refreshBybitFees();
  } catch (error) {
    status("bybit-fee-status", error.message, true);
  } finally {
    $("connect-bybit").disabled = false;
    $("disconnect-bybit").disabled = !bybitLogin?.local;
  }
};
$("disconnect-bybit").onclick = async () => {
  $("connect-bybit").disabled = $("disconnect-bybit").disabled = true;
  credentialRevision.bybit++;
  try {
    await call("forget_credential", { account: "bybit" });
    bybitLogin = bybitRelay ? { local: false } : null;
    resetBybitFeeCache();
    $("bybit-key").value = $("bybit-secret").value = "";
    setCredentialVisibility("bybit", false);
    updateCredentialPlaceholders();
    status("bybit-fee-status", bybitRelay ? "Доступ к тарифам через Cloudflare настроен." : "Bybit не подключён.");
    invalidate();
    showFees();
    if (bybitRelay) refreshBybitFees();
  } catch (error) {
    status("bybit-fee-status", error.message, true);
  } finally {
    $("connect-bybit").disabled = false;
    $("disconnect-bybit").disabled = !bybitLogin?.local;
  }
};

function showBingxConnection() {
  const message = bingxRelay ? "Доступ к тарифам через Cloudflare настроен." : "";
  const backup = bingxLocal ? "Запасной ключ сохранён." : "";
  $("disconnect-bingx").disabled = !bingxLocal;
  status("bingx-fee-status", [message, backup].filter(Boolean).join(" ") || "Добавь ключ BingX для доступа к тарифам.");
}

function updateBingxCredentials() {
  credentialRevision.bingx++;
  bingxFeeRequests.clear();
  bingxFeeCache.clear();
  $("bingx-key").value = $("bingx-secret").value = "";
  setCredentialVisibility("bingx", false);
  updateCredentialPlaceholders();
  if (usesBingx()) {
    routeFees = null;
    invalidate();
    showFees();
    refreshRouteFees();
  }
  updateConversion();
}

async function changeBingxCredentials(action, data, connected) {
  $("connect-bingx").disabled = $("disconnect-bingx").disabled = true;
  $("show-bingx-keys").disabled = true;
  status("bingx-fee-status", connected ? "Проверяю ключ напрямую в BingX…" : "Удаляю запасной ключ…");
  try {
    await call(action, data);
    bingxLocal = connected;
    updateBingxCredentials();
    showBingxConnection();
  } catch (error) {
    status("bingx-fee-status", error.message, true);
  } finally {
    $("connect-bingx").disabled = $("show-bingx-keys").disabled = false;
    $("disconnect-bingx").disabled = !bingxLocal;
  }
}

$("connect-bingx").onclick = () => {
  const key = $("bingx-key").value.trim();
  const secret = $("bingx-secret").value.trim();
  if (!key || !secret) {
    status("bingx-fee-status", "Введи API Key и API Secret BingX.", true);
    return;
  }
  changeBingxCredentials("save_bingx", { login: { key, secret } }, true);
};
$("disconnect-bingx").onclick = () => changeBingxCredentials("forget_credential", { account: "bingx" }, false);

const bookKey = (asset, source) => `${source}:${asset}`;

function loadBook(asset, source = "bybit") {
  const id = bookKey(asset, source);
  const cached = bookSnapshots.get(id);
  if (cached && Date.now() - cached.time < bookRefreshInterval - 250) return Promise.resolve(cached);
  if (bookRequests.has(id)) return bookRequests.get(id);
  const request = call(source, { asset }).then(asks => {
    const snapshot = { asks, time: Date.now() };
    bookSnapshots.set(id, snapshot);
    return snapshot;
  }).finally(() => bookRequests.delete(id));
  bookRequests.set(id, request);
  return request;
}

function refreshBook() {
  if (!hasOrderBook()) return Promise.resolve(false);
  const revision = routeRevision;
  bookRequest ??= fetchBook(revision).finally(() => {
    if (routeRevision === revision) bookRequest = null;
  });
  return bookRequest;
}

async function fetchBook(revision) {
  const quote = $("book-status");
  const updated = $("book-updated");
  try {
    const snapshot = await loadBook(route.asset, usesBingx() ? "bingx" : "bybit");
    if (routeRevision !== revision) return false;
    book = snapshot.asks;
    bookTime = snapshot.time;
    const text = "Покупка по стакану от " + fmt(book[0][0], 8) + " USDT";
    if (quote.textContent !== text) quote.textContent = text;
    quote.classList.remove("error");
    updated.textContent = clock(bookTime);
    return true;
  } catch (error) {
    if (routeRevision !== revision) return false;
    const text = book && Date.now() - bookTime <= bookMaxAge
      ? "Покупка от " + fmt(book[0][0], 8) + " USDT (последний стакан)"
      : error.message;
    if (quote.textContent !== text) quote.textContent = text;
    quote.classList.add("error");
    if (usesBingx() && !book && error.message.startsWith("На BingX нет активного стакана")) {
      field("buyMode").value = "manual";
      $("book-mode").querySelector(".price-options").dispatchEvent(new Event("refresh-selection"));
      updateMode();
    }
    return false;
  }
}

function pollBook() {
  if (document.hidden) return;
  refreshBook();
  updateConversion();
}
function pollRouteFees() {
  if (!document.hidden && (!routeFees || Date.now() - routeFees.time >= bybitFeeAge)) refreshRouteFees();
}
setInterval(pollBook, bookRefreshInterval);
setInterval(pollRouteFees, 10_000);
document.addEventListener("visibilitychange", pollBook);
document.addEventListener("visibilitychange", pollRouteFees);

const conversionForm = $("conversion-form");
const conversionExchange = conversionForm.elements.namedItem("conversionExchange");
const conversionFeesInputs = ["buy-fee", "withdrawal"];
const savedConversion = storage.read("conversion", {});
const manualConversionFees = savedConversion.fees ?? {
  bybit: Object.fromEntries(conversionFeesInputs.map(key => [key, savedConversion[key] ?? ""])),
};
let conversionSource = savedConversion.exchange === "bingx" ? "bingx" : "bybit";
conversionExchange.value = conversionSource;
for (const key of ["rubles", "rate"]) $("conversion-" + key).value = savedConversion[key] ?? "";
function restoreConversionFees() {
  for (const key of conversionFeesInputs) {
    $("conversion-" + key).value = manualConversionFees[conversionSource]?.[key] ?? "";
  }
}
restoreConversionFees();
let conversionRun = 0;
let conversionFeeCheck = null;

function conversionFees() {
  if (!bybitLogin) return Promise.resolve();
  if (conversionFeeCheck?.login === bybitLogin && Date.now() < conversionFeeCheck.expires) {
    return conversionFeeCheck.request;
  }
  const login = bybitLogin;
  const now = Date.now();
  const request = Promise.allSettled([loadBybitFee("trading", "GRAM"), loadBybitFee("withdrawal", "GRAM")]);
  const check = { login, expires: now + bybitFeeAge, request };
  conversionFeeCheck = check;
  request.then(([trading, withdrawal]) => {
    if (conversionFeeCheck !== check || bybitLogin !== login) return;
    check.expires = bybitFeeAge + Math.min(now,
      trading.status === "fulfilled" ? (feeCache.get("trading:GRAM")?.time ?? now) : now,
      withdrawal.status === "fulfilled" ? (feeCache.get("withdrawal:GRAM")?.time ?? now) : now);
  });
  return request;
}

function showConversion(result, message = "", error = false) {
  const copyButton = $("conversion-received");
  copyButton.disabled = !result;
  for (const [id, key, unit] of [
    ["received", "received", "GRAM"], ["usdt", "usdt", "USDT"], ["gross", "gross", "GRAM"],
    ["buy-cost", "buy_fee", "GRAM"], ["withdrawal-cost", "withdrawal_fee", "GRAM"],
  ]) {
    const element = $("conversion-" + id);
    const value = result ? fmt(result[key], 8) + " " + unit : "—";
    if (element.textContent !== value) element.textContent = value;
  }
  status("conversion-status", message, error);
}

let copyStatusTimer;
$("conversion-received").onclick = async (event) => {
  const button = event.currentTarget;
  if (button.disabled) return;
  const amount = button.textContent.replace(/\s|GRAM/g, "");
  let copied = false;
  try {
    await navigator.clipboard.writeText(amount);
    copied = true;
  } catch {
    const buffer = document.createElement("textarea");
    buffer.className = "clipboard-buffer";
    buffer.value = amount;
    buffer.readOnly = true;
    document.body.append(buffer);
    try {
      buffer.select();
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      buffer.remove();
      button.focus();
    }
  }
  clearTimeout(copyStatusTimer);
  status("conversion-copy-status", copied ? "Скопировано" : "Выдели сумму и нажми Ctrl+C.", !copied);
  copyStatusTimer = setTimeout(() => status("conversion-copy-status", ""), 2500);
};

async function updateConversion() {
  if ($("conversion").hidden) return;
  const run = ++conversionRun;
  const source = conversionSource;
  const exchange = source === "bingx" ? "BingX" : "Bybit";
  const read = key => $("conversion-" + key).value.trim();
  const number = (key, label) => parseDecimal(read(key), label);
  try {
    let bingxFees;
    if (source === "bingx") {
      if (bingxConnected()) bingxFees = await loadBingxFees("GRAM", true, true);
    } else {
      await conversionFees();
    }
    if (run !== conversionRun || $("conversion").hidden) return;
    const currentFee = kind => {
      const cached = feeCache.get(`${kind}:GRAM`);
      return cached && Date.now() - cached.time < bybitFeeAge ? cached.value : null;
    };
    const trading = source === "bingx" ? bingxFees?.trading : currentFee("trading");
    const withdrawal = source === "bingx" ? bingxFees?.withdrawal : currentFee("withdrawal");
    const buyInput = $("conversion-buy-fee");
    const withdrawalInput = $("conversion-withdrawal");
    buyInput.placeholder = fmt(trading?.percent ?? baseBuyFee, 8);
    withdrawalInput.placeholder = withdrawal ? fmt(withdrawal.fixed, 8) : "Укажи комиссию";
    const buyHint = read("buy-fee") ? "покупка вручную" : trading ? "покупка по тарифу " + exchange : "покупка по оценочной ставке 0,1%";
    const withdrawHint = read("withdrawal") ? "вывод вручную" : withdrawal ? "вывод по тарифу " + exchange : "укажи комиссию вывода";
    status("conversion-fee-status", `${buyHint} · ${withdrawHint}`);
    if (!read("rubles") || !read("rate")) { showConversion(null); return; }
    if (!read("withdrawal") && !withdrawal) throw new Error(bingxFees?.withdrawalError || "Комиссия вывода по TON неизвестна.");
    const snapshot = await loadBook("GRAM", source).catch(error => {
      const previous = bookSnapshots.get(bookKey("GRAM", source));
      if (previous && Date.now() - previous.time <= bookMaxAge) return previous;
      throw error;
    });
    if (run !== conversionRun || $("conversion").hidden) return;
    const result = await call("convert", { conversion: {
      rubles: number("rubles", "Сумма"), rate: number("rate", "Твой курс USDT"),
      buy_fee: read("buy-fee") ? number("buy-fee", "Комиссия покупки") : (trading?.percent ?? baseBuyFee),
      withdrawal: read("withdrawal") ? number("withdrawal", "Комиссия вывода") : withdrawal.fixed,
      withdrawal_percent: read("withdrawal") ? "0" : withdrawal.percent,
      asks: snapshot.asks,
    } });
    if (run !== conversionRun || $("conversion").hidden) return;
    const stale = Date.now() - snapshot.time >= bookRefreshInterval * 2;
    showConversion(result, `Оценка по ${stale ? "последнему доступному " : ""}стакану ${exchange}.`);
  } catch (error) {
    if (run === conversionRun && !$("conversion").hidden) showConversion(null, error.message, true);
  }
}

let conversionInputTimer;
function saveConversion() {
  storage.write("conversion", {
    rubles: $("conversion-rubles").value, rate: $("conversion-rate").value,
    exchange: conversionSource, fees: manualConversionFees,
  });
}
conversionForm.oninput = event => {
  if (event.target.name === "conversionExchange") return;
  manualConversionFees[conversionSource] = Object.fromEntries(conversionFeesInputs.map(key => [key, $("conversion-" + key).value]));
  saveConversion();
  conversionRun++;
  clearTimeout(conversionInputTimer);
  conversionInputTimer = setTimeout(updateConversion, 180);
};
conversionForm.onchange = event => {
  if (event.target.name !== "conversionExchange") return;
  clearTimeout(conversionInputTimer);
  conversionSource = conversionExchange.value;
  restoreConversionFees();
  saveConversion();
  status("conversion-copy-status", "");
  showConversion(null);
  updateConversion();
};
conversionForm.onsubmit = event => { event.preventDefault(); updateConversion(); };

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
    if (needsRouteFees()) {
      status("trade-status", "Обновляю комиссии " + exchangeName() + "…");
      await refreshRouteFees();
      if (revision !== version) return;
      status("trade-status", "");
    }
    Object.assign(trade, tradeFees(field("waltMode").value));
    if (usesOrderBook() && (!book || Date.now() - bookTime > bookMaxAge)) {
      status("trade-status", "Обновляю стакан " + exchangeName() + "…");
      const loaded = await refreshBook();
      if (revision !== version) return;
      if (!loaded) throw new Error("Укажи цену покупки " + route.asset + " вручную и повтори расчёт.");
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
    const unitAsset = " " + route.asset;
    for (const [name, unit, digits] of [["average"," USDT",8], ["cost"," ₽",2], ["received",unitAsset,8], ["sold",unitAsset,8], ["remaining",unitAsset,8], ["sold_cost"," ₽",2], ["payout"," ₽",2], ["breakeven"," ₽/" + route.asset,4]]) {
      document.querySelector('[data-result="' + name + '"]').textContent = fmt(result[name], digits) + unit;
    }
    document.querySelectorAll("[data-partial]").forEach((node) => { node.hidden = Number(result.remaining) <= 0; });
    estimate = {
      time: Date.now(), result, asset: route.asset,
      inputs: {
        ...Object.fromEntries(fieldNames.map((name) => [name, field(name).value])),
        buy_fee: trade.buy_fee, withdrawal: result.withdrawal_fee, sale_fee: trade.sale_fee,
      },
      saleSource: selected ? (saleAd ? "Walt · " : "Ориентир по Walt · ") + selected.nickname : "Ручная цена",
    };
    $("save").disabled = false;
    tutorial.onCalculation();
  } catch (error) {
    if (revision === version) {
      status("trade-status", error.message, true);
      tutorial.onCalculation(error.message);
    }
  } finally {
    if (run === calculationRun) {
      $("calculate").disabled = false;
      if (revision === version && estimate && $("tour").hidden && !$("calculator").hidden &&
          matchMedia("(max-width: 680px)").matches) {
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
    const unit = " " + (item.asset ?? "GRAM");
    const extras = " · курс " + fees.rate + " ₽ · комиссии " + (fees.buy_fee || 0) + "% / " + (fees.withdrawal || 0) + unit + " / " + (fees.sale_fee || 0) + "%";
    const partial = Number(item.result.remaining) > 0 ?
      " · к продаже " + fmt(item.result.sold, 8) + unit + " · остаток " + fmt(item.result.remaining, 8) + unit : "";
    const entry = row(signed(item.result.percent) + " % · " + signed(item.result.profit) + " ₽",
      new Date(item.time).toLocaleString("ru-RU") + " · " + fees.ton + unit + " · " + fees.sale + " ₽/" + unit.trim() + " · " + item.saleSource + partial + extras, remove);
    if (item === newItem) entry.classList.add("history-row-enter");
    list.append(entry);
  }
}

const historyClear = $("history-clear");
historyClear.addEventListener("contextmenu", (event) => event.preventDefault());
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

function renderRoutes() {
  $("routes-custom-group").hidden = !customRoutes.length;
  for (const [id, items] of [["routes-bybit", bybitRoutes], ["routes-bingx", bingxRoutes], ["routes-custom", customRoutes]]) {
    $(id).replaceChildren(...items.map(buildRouteCard));
  }
  moveRouteIndicator(false);
}

function buildRouteCard(item) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "panel route-card";
  card.dataset.routeId = item.id;
  card.setAttribute("aria-pressed", String(route === item));
  card.setAttribute("aria-label", `${item.asset} · ${item.source} → ${item.destination}`);
  const asset = document.createElement("strong");
  asset.textContent = item.asset;
  card.append(asset);
  if (customRoutes.includes(item)) {
    const platforms = document.createElement("small");
    platforms.textContent = item.source + " → " + item.destination;
    card.append(platforms);
  }
  card.onclick = () => selectRoute(item);
  return card;
}

function updateRouteView() {
  const labels = {
    asset: route.asset,
    source: (usesBybit() || usesBingx()) && !directUsdt() ? exchangeName().toUpperCase() + " SPOT" : route.source.toUpperCase(),
    destination: usesWalt() ? "WALT P2P" : route.destination.toUpperCase(),
  };
  for (const node of document.querySelectorAll("[data-route-text]")) {
    node.textContent = node.dataset.routeText.replace(/\{(asset|source|destination)\}/g, (_, key) => labels[key]);
  }
  document.title = "Спред · " + route.asset;
  document.querySelector('[aria-describedby="hint-received"]').setAttribute("aria-label", "Подсказка: " + route.asset + " после вывода");
  $("book-mode").hidden = !hasOrderBook();
  $("purchase-exchange").hidden = !presetRoutes.includes(route);
  const exchange = usesBingx() ? "bingx" : "bybit";
  if (field("purchaseExchange").value !== exchange) {
    field("purchaseExchange").value = exchange;
    $("purchase-exchange").querySelector(".price-options").dispatchEvent(new Event("refresh-selection"));
  }
  $("book-mode").querySelector(".price-options").dispatchEvent(new Event("refresh-selection"));
  $("exchange-book-label").textContent = "Стакан " + exchangeName();
  $("book-status").textContent = directUsdt() ? "1 USDT за 1 USDT" : hasOrderBook() ? "Загрузка стакана…" : "";
  $("book-status").classList.remove("error");
  $("book-updated").textContent = "";
  $("walt-mode").hidden = !usesWalt();
  const network = route.asset === "ETH" ? "ETH" : "TON";
  const withdrawalLabel = (usesBybit() || usesBingx()) && usesWalt() ? "Вывод по " + network : "Комиссия вывода";
  $("withdrawal-label").textContent = withdrawalLabel + ", " + route.asset;
  for (const button of document.querySelectorAll('[data-view="market"]')) button.hidden = !usesWalt();
  clearSelection(usesWalt() ? "Введи цену вручную или выбери объявление." : "Введи цену продажи вручную.");
  updateMode();
  showFees();
}

function selectRoute(item) {
  if (item === route) return;
  persistForm();
  route = item;
  status("bybit-p2p-rate-status", "");
  $("market-withdrawal").value = "";
  status("market-withdrawal-status", "");
  routeRevision++;
  storage.write("active-route", route.id);
  book = bookRequest = routeFees = bybitFeeRequest = null;
  bookTime = 0;
  $("connect-bybit").disabled = false;
  restoreTradeForm();
  invalidate();
  for (const card of $("route-list").querySelectorAll(".route-card")) {
    card.setAttribute("aria-pressed", String(card.dataset.routeId === route.id));
  }
  moveRouteIndicator(true);
  updateRouteView();
  resetAds();
  status("market-status", "");
  if (!usesWalt() && !$("market").hidden) showView("calculator");
  if (usesWalt() && !$("market").hidden) loadAds(1);
  if (usesBybit() && bybitLogin) {
    status("bybit-fee-status", bybitRelay ? "Доступ к тарифам через Cloudflare настроен." : "Ключ Bybit подключён.");
  }
  refreshRouteFees();
  pollBook();
  importBybitP2pRate();
}

$("purchase-exchange").addEventListener("change", () => {
  const target = (field("purchaseExchange").value === "bingx" ? bingxRoutes : bybitRoutes)
    .find(item => item.asset === route.asset);
  if (!target || target === route) return;
  const shared = (selected ? ["ton", "rate"] : ["ton", "rate", "sale"]).map(name => [name, field(name).value]);
  selectRoute(target);
  for (const [name, value] of shared) if (!field(name).value) field(name).value = value;
  persistForm();
});

$("route-add").onclick = () => {
  $("route-form").reset();
  $("route-error").textContent = "";
  $("route-dialog").showModal();
};
$("route-cancel").onclick = () => $("route-dialog").close();
$("route-form").onsubmit = (event) => {
  event.preventDefault();
  const fields = new FormData(event.currentTarget);
  const asset = fields.get("asset").trim().toUpperCase();
  const source = fields.get("source").trim();
  const destination = fields.get("destination").trim();
  if (!asset || !source || !destination) {
    $("route-error").textContent = "Укажи монету и обе площадки.";
    return;
  }
  const item = { id: "custom-" + customRoutes.length, asset, source, destination };
  if (!storage.write("custom-routes", [...customRoutes, item])) {
    $("route-error").textContent = "Не удалось сохранить связку.";
    return;
  }
  customRoutes.push(item);
  routes.push(item);
  $("route-dialog").close();
  selectRoute(item);
  renderRoutes();
  $("routes-custom").lastElementChild.focus();
};
$("activate-key").onclick = async () => {
  const key = $("key").value.trim();
  if (!key) { status("key-status", "Введи ключ.", true); return; }
  $("activate-key").disabled = $("forget-key").disabled = true;
  credentialRevision.walt++;
  try {
    await call("save_walt", { key });
    waltLocal = true;
    $("key").value = "";
    setCredentialVisibility("walt", false);
    updateCredentialPlaceholders();
    resetAds();
    status("key-status", usesWalt() ? "Ключ сохранён. Проверяю доступ к объявлениям…" : "Ключ сохранён.");
    await loadAds(1);
  } catch (error) {
    status("key-status", error.message, true);
  } finally {
    $("activate-key").disabled = false;
    $("forget-key").disabled = !waltLocal;
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
    $("activate-key").disabled = false;
    $("forget-key").disabled = !waltLocal;
  }
  waltLocal = false;
  $("forget-key").disabled = true;
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
  status("key-status", waltRelay ? "Доступ Walt через Cloudflare настроен." : "Ключ не введён.");
  status("market-status", "");
  if (waltRelay && usesWalt()) loadAds(1);
};

function normalizeWaltOffer(ad, side) {
  const validAsset = ad?.cryptoCurrency === route.asset || (route.asset === "GRAM" && ad?.cryptoCurrency === "TON");
  if (!ad || !["string", "number"].includes(typeof ad.id) ||
      !validAsset || ad.fiatCurrency !== "RUB" || ad.side !== side ||
      typeof ad.nickname !== "string" || !Array.isArray(ad.payments) ||
      !ad.payments.every((method) => typeof method === "string")) return null;
  const values = {};
  for (const name of ["price", "minAmount", "maxAmount", "lastQuantity"]) {
    const value = String(ad[name]);
    const valid = name === "price" ? /^\d{1,9}(?:\.\d{1,20})?$/ : /^\d{1,12}(?:\.\d{1,16})?$/;
    if (!valid.test(value) || Number(value) <= 0) return null;
    values[name] = value;
  }
  if (Number(values.price) < 0.00000001 || Number(values.price) > 100_000_000 ||
      Number(values.minAmount) > Number(values.maxAmount)) return null;
  return { ...ad, ...values };
}

function sellableGram() {
  try {
    const volume = Number(decimal("ton", "Объём сделки"));
    if (volume <= 0 || volume > 1_000_000) return null;
    const buyFee = Number(manualFee("buy_fee") ? decimal("buy_fee", "Комиссия покупки") : automaticBuyFee());
    const manualWithdrawal = manualFee("withdrawal");
    if (!manualWithdrawal && !routeFees?.withdrawal) return null;
    const withdrawal = Number(manualWithdrawal ? decimal("withdrawal", "Комиссия вывода") : (routeFees?.withdrawal?.fixed ?? 0));
    const withdrawalPercent = Number(manualWithdrawal ? 0 : (routeFees?.withdrawal?.percent ?? 0));
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
  let needsWithdrawal = false;
  try {
    const ton = decimal("ton", "Объём сделки");
    const rate = decimal("rate", "Курс покупки USDT");
    if (needsRouteFees()) await refreshRouteFees();
    needsWithdrawal = !manualFee("withdrawal") && !routeFees?.withdrawal;
    const fees = tradeFees(canSell ? "taker" : field("waltMode").value);
    if (usesOrderBook() && (!book || Date.now() - bookTime > bookMaxAge)) {
      if (!await refreshBook()) throw new Error("Нет свежего стакана " + exchangeName() + ". Укажи цену покупки вручную.");
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
    return { results, message: "Спред не рассчитан. " + error.message, needsWithdrawal };
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
  allButton.disabled = !waltConnected();
  allButton.textContent = showAllOrders ? "Вернуть фильтры" : "Показать все ордеры";
  $("highest-price").hidden = !sellSelected;
  $("highest-price").setAttribute("aria-pressed", String(highestPriceFirst));
  const filter = document.querySelector('input[name="payment"]:checked').value;
  const allowed = filter ? filter.split("|") : [];
  const amountText = $("market-amount").value.trim().replace(/[ \u00a0\u202f]/g, "").replace(",", ".");
  const amount = amountText === "" ? null : Number(amountText);
  const invalid = amount !== null && (!/^\d{1,12}(?:\.\d{0,2})?$/.test(amountText) || amount <= 0);
  $("market-amount").setAttribute("aria-invalid", String(invalid));
  status("market-amount-status", invalid ? "Укажи сумму больше нуля, до двух знаков после запятой." : "", invalid);
  const kopecks = (rubles) => Math.round(rubles * 100);
  const covers = (value, target) => value + target * Number.EPSILON * 4 >= target;
  const buyAds = offersSide === "BUY";
  const preview = Date.now() - offerTime <= cacheAge ? offerPreview : null;
  const spreads = preview?.results;
  const order = buyAds
    ? highestPriceFirst ? "По цене за " + route.asset + ", от высокой к низкой" : "По чистой прибыли"
    : "Цена объявления используется как ориентир для продажи.";
  $("market-spread-status").textContent = [offerTime ? order : "", preview?.message].filter(Boolean).join(" · ");
  $("market-spread-fix").hidden = !preview?.needsWithdrawal;
  $("market-connect-bybit").hidden = !usesBybit() || Boolean(bybitLogin);
  const sellable = buyAds ? sellableGram() : null;
  const visible = invalid ? [] : offers.filter((ad) => {
    if (allowed.length && !ad.payments.some((method) => allowed.includes(method.toLowerCase()))) return false;
    if (allOrdersLoaded && amount === null) return true;
    const quantity = Number(ad.lastQuantity);
    const price = Number(ad.price);
    const available = Math.min(Number(ad.maxAmount), quantity * price);
    const minimum = Number(ad.minAmount);
    const matchesAmount = amount === null || (kopecks(amount) >= kopecks(minimum) && kopecks(amount) <= kopecks(available));
    if (allOrdersLoaded) return matchesAmount;
    const spread = spreads?.get(String(ad.id));
    if (spread === null || !covers(available, minimum) ||
        (spread === undefined && sellable !== null && !covers(sellable * price, minimum))) return false;
    return matchesAmount;
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
    const titleText = fmt(ad.price, 8) + " ₽/" + route.asset + " · " + ad.nickname;
    const detailText = fmt(ad.minAmount) + "–" + fmt(ad.maxAmount) + " ₽ · " + fmt(ad.lastQuantity, 8) + " " + route.asset + " · " + ad.payments.join(", ");
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
      const volume = (buyAds ? "к продаже " : "для ") + fmt(result.sold, 8) + " " + route.asset;
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
  if (!usesWalt()) return;
  if (!waltConnected()) { status("market-status", "Добавь ключ Walt в настройках.", true); return; }
  if (silent && adsLoading) return;
  const request = ++adsRequest;
  const asset = route.asset;
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
      const data = await call("walt", { side, page: pageNumber, asset });
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
$("market-spread-fix").onsubmit = event => {
  event.preventDefault();
  const input = $("market-withdrawal");
  try {
    const fee = parseDecimal(input.value, "Комиссия вывода");
    field("withdrawal").value = fee;
    input.value = "";
    status("market-withdrawal-status", "");
    persistForm();
    invalidate();
    showFees();
    refreshOfferSpreads();
  } catch (error) {
    status("market-withdrawal-status", error.message, true);
    input.focus();
  }
};

$("market-connect-bybit").onclick = () => {
  showView("settings");
  $("bybit-key").focus();
};

$("market-amount").oninput = () => {
  if (allOrdersLoaded) offersPage = 1;
  renderOffers();
};
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
  if (waltConnected() && !$("market").hidden) loadAds(1);
  else renderOffers();
}));
document.querySelectorAll('input[name="payment"]').forEach((input) => input.addEventListener("change", () => {
  if (allOrdersLoaded) offersPage = 1;
  renderOffers();
}));
setInterval(() => {
  if (waltConnected() && !document.hidden && !$("market").hidden &&
      (!allOrdersLoaded || Date.now() - offerTime >= allOrdersRefreshInterval)) {
    loadAds(offersPage, { silent: true });
  }
}, adsRefreshInterval);
renderRoutes();
updateRouteView();
renderHistory();
pollBook();
async function connectSavedAccounts() {
  const buttons = ["activate-key", "forget-key", "connect-bybit", "disconnect-bybit", "connect-bingx", "disconnect-bingx"];
  for (const id of buttons) $(id).disabled = true;
  let savedAccounts;
  try {
    savedAccounts = await call("saved_credentials");
  } catch (error) {
    status("key-status", error.message, true);
    status("bybit-fee-status", error.message, true);
    status("bingx-fee-status", error.message, true);
    return;
  } finally {
    for (const id of ["activate-key", "connect-bybit", "connect-bingx"]) $(id).disabled = false;
  }
  waltLocal = Boolean(savedAccounts.walt);
  waltRelay = Boolean(savedAccounts.walt_relay);
  $("forget-key").disabled = !waltLocal;
  bingxRelay = Boolean(savedAccounts.bingx);
  bingxLocal = Boolean(savedAccounts.bingx_local);
  showBingxConnection();
  status("key-status", waltRelay ? "Доступ Walt через Cloudflare настроен." : waltLocal ? "Ключ Walt подключён." : "Ключ не введён.");
  if (waltConnected()) loadAds(1);
  bybitRelay = Boolean(savedAccounts.bybit_relay);
  if (savedAccounts.bybit || bybitRelay) {
    bybitLogin = { local: Boolean(savedAccounts.bybit) };
    $("disconnect-bybit").disabled = !bybitLogin.local;
    status("bybit-fee-status", bybitRelay ? "Доступ к тарифам через Cloudflare настроен." : "Ключ Bybit подключён.");
  }
  refreshRouteFees();
  updateCredentialPlaceholders();
  updateConversion();
  importBybitP2pRate();
}
connectSavedAccounts();
function missingTutorialInput(name) {
  if (name === "manual_price" && (directUsdt() || usesOrderBook())) return "";
  if (name === "sale" && selected) return "";
  if (name === "withdrawal" && !manualFee(name) && usesWalt() && routeFees?.withdrawal) return "";
  const labels = { ton: "объём сделки", rate: "курс покупки USDT", manual_price: "цену покупки", sale: "цену продажи", withdrawal: "комиссию вывода" };
  try {
    const value = Number(decimal(name, labels[name]));
    if (name === "withdrawal" ? value >= 0 : value > 0) return "";
  } catch {
    // The tour asks for this field before allowing the user to continue.
  }
  return name === "withdrawal" ? "Укажи комиссию вывода. Для учебного расчёта можно ввести 0." : `Введи ${labels[name]} числом больше нуля.`;
}

const tutorial = createTutorial({ showView, storage, getAsset: () => route.asset, hasEstimate: () => Boolean(estimate), missingInput: missingTutorialInput });
