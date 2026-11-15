"use strict";

let enginePromise;
const pagesBase = new URL(".", document.currentScript.src);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function loadEngine() {
  const response = await fetch(new URL("spread_pages_engine.wasm", pagesBase));
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

async function loadPublicBook() {
  try {
    const response = await fetch("https://api.bybit.com/v5/market/orderbook?category=spot&symbol=GRAMUSDT&limit=50", {
      credentials: "omit",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (data.retCode !== 0 || data.result?.s !== "GRAMUSDT" || !data.result.a?.length) throw new Error();
    return data.result.a;
  } catch {
    throw new Error("Стакан Bybit недоступен. Можно указать цену покупки вручную.");
  }
}

window.spreadPages = {
  async call(action, data) {
    switch (action) {
      case "bybit": return loadPublicBook();
      case "estimate":
      case "estimate_offers": return estimateInBrowser(action, data);
      case "saved_credentials": return { walt: false, bybit: false };
      default: throw new Error("Это подключение доступно в локальной версии.");
    }
  },
};
