"use strict";

let enginePromise;
const scriptUrl = new URL(document.currentScript.src);
const engineUrl = new URL("spread_pages_engine.wasm", scriptUrl);
engineUrl.search = scriptUrl.search;
const spotSymbols = new Map([["GRAM", "GRAMUSDT"], ["ETH", "ETHUSDT"], ["NOT", "NOTUSDT"]]);
const marketApi = document.querySelector('meta[name="spread-market-api"]')?.content;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function loadEngine() {
  const response = await fetch(engineUrl);
  if (!response.ok) throw new Error("Не удалось загрузить модуль расчёта.");
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
  return instance.exports;
}

async function estimateInBrowser(action, data) {
  enginePromise ??= loadEngine().catch(() => {
    enginePromise = undefined;
    throw new Error("Не удалось загрузить модуль расчёта. Попробуй ещё раз.");
  });
  const engine = await enginePromise;
  const input = encoder.encode(JSON.stringify({ action, ...data }));
  const inputOffset = engine.prepare_request(input.length);
  new Uint8Array(engine.memory.buffer, inputOffset, input.length).set(input);
  const outputOffset = engine.calculate_request();
  const output = new Uint8Array(engine.memory.buffer, outputOffset, engine.response_length());
  const reply = JSON.parse(decoder.decode(output));
  if (reply.error) throw new Error(reply.error);
  return reply.value;
}

async function loadPublicBook(asset) {
  const symbol = spotSymbols.get(asset);
  if (!symbol) throw new Error("Для этой связки укажи цену покупки вручную.");
  try {
    const response = await fetch("https://api.bybit.com/v5/market/orderbook?category=spot&symbol=" + symbol + "&limit=50", {
      credentials: "omit",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (data.retCode !== 0 || data.result?.s !== symbol || !data.result.a?.length) throw new Error();
    return data.result.a;
  } catch {
    throw new Error("Стакан Bybit недоступен. Можно указать цену покупки вручную.");
  }
}

async function loadMarket(path, data) {
  const url = new URL(path, marketApi);
  url.search = new URLSearchParams(data);
  const response = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(10000) });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Сервер рыночных данных недоступен.");
  return path === "/status" ? json : json.value;
}

window.spreadPages = {
  hasMarketApi: Boolean(marketApi),
  async call(action, data) {
    switch (action) {
      case "bybit": return loadPublicBook(data.asset ?? "GRAM");
      case "estimate":
      case "estimate_offers": return estimateInBrowser(action, data);
      case "saved_credentials": return marketApi ? loadMarket("/status") : { walt: false, bybit: false };
      case "walt": if (marketApi) return loadMarket("/walt", data); break;
      case "bybit_fee": if (marketApi) return loadMarket("/bybit-fee", data); break;
    }
    throw new Error("Это подключение доступно в локальной версии.");
  },
};
