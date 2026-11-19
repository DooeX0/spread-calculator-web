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

async function checkMarketService(service) {
  const requests = {
    bybit_book: () => loadPublicBook("GRAM"),
    bingx_book: () => loadMarket("/bingx-book", { asset: "ETH" }),
    bingx_fees: () => Promise.all([
      loadMarket("/bingx-fee", { asset: "ETH", kind: "trading" }),
      loadMarket("/bingx-fee", { asset: "ETH", kind: "withdrawal" }),
    ]),
    walt: () => loadMarket("/walt", { asset: "GRAM", side: "BUY", page: 1 }),
  };
  if (!Object.hasOwn(requests, service)) return { state: "unconfigured" };
  if (!marketApi && service !== "bybit_book") return { state: "unconfigured" };
  await requests[service]();
  return { state: "ready" };
}

window.spreadPages = {
  hasMarketApi: Boolean(marketApi),
  async call(action, data) {
    switch (action) {
      case "bybit": return loadPublicBook(data.asset ?? "GRAM");
      case "bingx": if (marketApi) return loadMarket("/bingx-book", data); break;
      case "bingx_fee": if (marketApi) return loadMarket("/bingx-fee", data); break;
      case "cloudflare_status": return checkMarketService(data.service);
      case "convert":
      case "estimate":
      case "estimate_offers": return estimateInBrowser(action, data);
      case "saved_credentials": {
        if (!marketApi) return {};
        const accounts = await loadMarket("/status");
        return { bybit: accounts.bybit, walt_relay: accounts.walt, bingx: accounts.bingx };
      }
      case "walt": if (marketApi) return loadMarket("/walt", data); break;
      case "bybit_fee": if (marketApi) return loadMarket("/bybit-fee", data); break;
    }
    throw new Error("Это подключение доступно в локальной версии.");
  },
};
