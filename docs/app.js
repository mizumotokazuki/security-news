(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const PAGE = 60;
  const STORE_KEY = "secnews-filters";

  const state = { period: 3, region: "all", cat: "all", onlyHigh: false, q: "", shown: PAGE };
  let data = { items: [], categories: [], sources: [] };
  let digest = null;

  try { Object.assign(state, JSON.parse(localStorage.getItem(STORE_KEY) || "{}"), { q: "", shown: PAGE }); } catch {}
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify({ period: state.period, region: state.region, cat: state.cat, onlyHigh: state.onlyHigh })); } catch {} };

  const esc = (s = "") => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const catLabel = (id) => data.categories.find((c) => c.id === id)?.label || id;
  const catVar = (id) => `--cat: var(--c-${id})`;

  function ago(iso) {
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    if (m < 60) return `${Math.max(m, 1)}分前`;
    if (m < 1440) return `${Math.round(m / 60)}時間前`;
    return `${Math.round(m / 1440)}日前`;
  }
  function dayLabel(iso) {
    const d = new Date(iso);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
    const base = d.toLocaleDateString("ja-JP", { month: "long", day: "numeric", weekday: "short" });
    return diff === 0 ? `今日 ${base}` : diff === 1 ? `昨日 ${base}` : base;
  }

  function inPeriod(i) { return Date.now() - new Date(i.date) <= state.period * 864e5; }
  function baseFiltered() {
    const q = state.q.trim().toLowerCase();
    return data.items.filter((i) =>
      inPeriod(i) &&
      (state.region === "all" || i.region === state.region) &&
      (!state.onlyHigh || i.importance >= 3) &&
      (!q || `${i.title} ${i.summary} ${i.ai?.title || ""} ${i.ai?.summary || ""} ${i.source}`.toLowerCase().includes(q))
    );
  }

  function renderDigest() {
    const day = data.items.filter((i) => Date.now() - new Date(i.date) <= 864e5);
    const high = day.filter((i) => i.importance >= 3).length;
    const count = (ids) => day.filter((i) => ids.includes(i.category)).length;
    const stats = `
      <div class="stats">
        <div class="stat"><b>${day.length}</b><span>24時間の新着</span></div>
        <div class="stat high"><b>${high}</b><span>要注意</span></div>
        <div class="stat"><b>${count(["vuln"])}</b><span>脆弱性</span></div>
        <div class="stat"><b>${count(["breach", "ransomware"])}</b><span>漏えい・ランサム</span></div>
        <div class="stat"><b>${count(["takedown"])}</b><span>摘発（良いニュース）</span></div>
      </div>`;

    if (digest && Date.now() - new Date(digest.generatedAt) < 2 * 864e5) {
      $("#digest").innerHTML = `
        <h2>今日のまとめ（AI要約）</h2>
        <p class="headline">${esc(digest.headline)}</p>
        <p>${esc(digest.overview)}</p>
        <ul>${digest.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
        ${stats}`;
    } else {
      // AI を使わずに件数から文章を組み立てる
      const kev = day.filter((i) => i.kev).length;
      const jp = day.filter((i) => i.region === "jp").length;
      const parts = [];
      if (count(["breach"])) parts.push(`情報漏えい・不正アクセス ${count(["breach"])}件`);
      if (count(["ransomware"])) parts.push(`ランサムウェア ${count(["ransomware"])}件`);
      if (count(["vuln"])) parts.push(`脆弱性 ${count(["vuln"])}件`);
      if (count(["phishing"])) parts.push(`詐欺・フィッシング ${count(["phishing"])}件`);
      const headline = high ? `要注意のニュースが${high}件あります` : "大きな注意喚起は出ていません";
      const overview = [
        `直近24時間で${day.length}件（国内${jp}件・海外${day.length - jp}件）のニュースがありました。`,
        parts.length ? `主な内訳は${parts.join("、")}です。` : "",
        kev ? `実際の攻撃での悪用が確認された脆弱性が${kev}件追加されています。該当製品を使っている場合は早めの更新を。` : "",
        count(["takedown"]) ? `一方で、逮捕・摘発などの良いニュースも${count(["takedown"])}件ありました。` : ""
      ].join("");
      // 国内記事（日本語で読める）を優先して要注意を並べる
      const top = day.filter((i) => i.importance >= 3).sort((a, b) => (a.region === "jp" ? 0 : 1) - (b.region === "jp" ? 0 : 1)).slice(0, 5);
      $("#digest").innerHTML = `
        <h2>この24時間のまとめ</h2>
        <p class="headline">${headline}</p>
        <p>${overview}</p>
        ${top.length ? `<ul>${top.map((i) => `<li><a href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.ai?.title || i.title)}</a></li>`).join("")}</ul>` : ""}
        ${stats}`;
    }
  }

  function renderChips(items) {
    const counts = {};
    for (const i of items) counts[i.category] = (counts[i.category] || 0) + 1;
    const chips = [{ id: "all", label: "すべて" }, ...data.categories]
      .map((c) => {
        const n = c.id === "all" ? items.length : counts[c.id] || 0;
        if (c.id !== "all" && !n && state.cat !== c.id) return "";
        const style = c.id === "all" ? "" : `style="${catVar(c.id)}"`;
        return `<button class="chip" data-v="${c.id}" ${style} aria-pressed="${state.cat === c.id}">${c.id === "all" ? "" : '<span class="dot"></span>'}${esc(c.label)} <span class="n">${n}</span></button>`;
      })
      .join("");
    $("#cats").innerHTML = chips;
  }

  function card(i) {
    const title = i.ai?.title || i.title;
    const summary = i.ai?.summary || i.summary;
    const imp = i.importance >= 3 ? '<span class="badge high">要注意</span>' : i.importance === 2 ? '<span class="badge mid">注目</span>' : "";
    const action = i.ai?.action && i.ai.action !== "特になし" ? `<p class="action">👉 ${esc(i.ai.action)}</p>` : "";
    // 英語記事は Google 翻訳経由で日本語で読めるようにする（無料）
    const isEnglish = !i.ai && !/[぀-ヿ一-鿿]/.test(i.title);
    const translate = isEnglish ? `<a class="tr" href="https://translate.google.com/translate?sl=auto&tl=ja&u=${encodeURIComponent(i.link)}" target="_blank" rel="noopener">🌐 日本語で読む</a>` : "";
    return `
      <article class="card" style="${catVar(i.category)}">
        <div class="meta">
          <span class="badge cat">${esc(catLabel(i.category))}</span>${imp}${i.kev ? '<span class="badge kev">悪用確認</span>' : ""}
          <span>${esc(i.source)}</span><span>${i.region === "jp" ? "国内" : "海外"}</span><time datetime="${i.date}">${ago(i.date)}</time>
        </div>
        <h3><a href="${esc(i.link)}" target="_blank" rel="noopener">${esc(title)}</a></h3>
        ${i.ai?.title && i.ai.title !== i.title ? `<p class="orig">${esc(i.title)}</p>` : ""}
        ${summary ? `<p class="sum clamp">${esc(summary)}</p>` : ""}
        ${summary.length > 110 || translate ? `<div class="links">${summary.length > 110 ? '<button class="more">続きを表示</button>' : ""}${translate}</div>` : ""}
        ${action}
      </article>`;
  }

  function render() {
    const base = baseFiltered();
    renderChips(base);
    const items = state.cat === "all" ? base : base.filter((i) => i.category === state.cat);
    const view = items.slice(0, state.shown);
    let html = "", lastDay = "";
    for (const i of view) {
      const d = dayLabel(i.date);
      if (d !== lastDay) { html += `<h2 class="day">${d}</h2>`; lastDay = d; }
      html += card(i);
    }
    if (items.length > view.length) html += `<button class="loadmore" id="loadmore">さらに表示（残り ${items.length - view.length}件）</button>`;
    $("#list").innerHTML = html;
    $("#empty").hidden = items.length > 0;

    for (const [sel, key] of [["#period", "period"], ["#region", "region"]])
      for (const b of document.querySelectorAll(`${sel} button`)) b.setAttribute("aria-pressed", String(b.dataset.v == state[key]));
    $("#onlyHigh").checked = state.onlyHigh;
  }

  function renderMeta() {
    const u = new Date(data.updatedAt);
    $("#updated").textContent = isNaN(u) ? "" : `更新: ${u.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
    $("#sources").innerHTML = "収集元: " + data.sources.map((s) => `<span class="${s.ok ? "ok" : "ng"}" title="${esc(s.ok ? s.count + "件" : s.error)}">${s.ok ? "●" : "×"}</span> ${esc(s.name)}`).join("、");
  }

  // ---------- イベント ----------
  function bindSeg(sel, key, parse = (v) => v) {
    $(sel).addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      state[key] = parse(b.dataset.v); state.shown = PAGE; save(); render();
    });
  }
  bindSeg("#period", "period", Number);
  bindSeg("#region", "region");
  $("#cats").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    state.cat = state.cat === b.dataset.v ? "all" : b.dataset.v; state.shown = PAGE; save(); render();
  });
  $("#onlyHigh").addEventListener("change", (e) => { state.onlyHigh = e.target.checked; state.shown = PAGE; save(); render(); });
  let t; $("#q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; state.shown = PAGE; render(); }, 150); });
  $("#list").addEventListener("click", (e) => {
    if (e.target.id === "loadmore") { state.shown += PAGE; render(); return; }
    if (e.target.classList.contains("more")) {
      const sum = e.target.closest(".card").querySelector(".sum"); sum.classList.toggle("clamp");
      e.target.textContent = sum.classList.contains("clamp") ? "続きを表示" : "閉じる";
    }
  });

  // ---------- 読み込み ----------
  async function load() {
    try {
      const res = await fetch("data/news.json", { cache: "no-cache" });
      data = await res.json();
    } catch {
      $("#updated").textContent = "データを読み込めませんでした";
      return;
    }
    try {
      const r = await fetch("data/digest.json", { cache: "no-cache" });
      if (r.ok) digest = await r.json();
    } catch {}
    renderMeta(); renderDigest(); render();
  }

  load();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(); });
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
