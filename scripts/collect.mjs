// セキュリティニュース収集スクリプト
// 使い方: node scripts/collect.mjs
// feeds.json の RSS / Atom / CISA KEV を取得し、分類・重要度付けをして docs/data/news.json に保存する。
// ANTHROPIC_API_KEY が設定されていれば、Claude で日本語の要約と「今日のまとめ」も作る。

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ローカル実行時は .env（git には含めない）から ANTHROPIC_API_KEY などを読み込む
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {}
const DATA_DIR = path.join(ROOT, "docs", "data");
const NEWS_FILE = path.join(DATA_DIR, "news.json");
const DIGEST_FILE = path.join(DATA_DIR, "digest.json");

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);
const MAX_ITEMS = 2000;
const MAX_AI_ITEMS = Number(process.env.MAX_AI_ITEMS || 80); // 1回の実行で AI 要約する最大件数
const AI_BATCH = 15;
const AI_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

// ---------- 分類ルール ----------
// 上から順に評価し、最初に一致したものを主カテゴリにする（複数一致はタグとして残す）
const CATEGORIES = [
  { id: "takedown",   label: "摘発・テイクダウン", re: /逮捕|摘発|検挙|起訴|有罪|判決|送検|テイクダウン|takedown|arrest|extradit|sentenced|charged|indicted|seized|dismantl|disrupt(ed|s)? .*(botnet|operation|infrastructure)|law enforcement|europol|FBI/i },
  { id: "ransomware", label: "ランサムウェア",     re: /ランサム|ransom|lockbit|blackcat|alphv|akira|clop|black ?basta|qilin|play ransomware|身代金/i },
  { id: "breach",     label: "情報漏えい・不正アクセス", re: /漏えい|漏洩|流出|不正アクセス|個人情報|情報が?外部|breach|leak|exposed|stolen data|data theft|compromis|unauthori[sz]ed access|hacked|exfiltrat/i },
  { id: "vuln",       label: "脆弱性",             re: /脆弱性|CVE-\d{4}-\d+|ゼロデイ|アップデート|パッチ|修正版|vulnerab|zero-?day|0-?day|patch|exploit|RCE|remote code|security update|flaw|bug bounty/i },
  { id: "phishing",   label: "フィッシング・詐欺", re: /フィッシング|詐欺|なりすまし|偽(の)?サイト|スミッシング|phish|scam|fraud|smish|impersonat|business email compromise|BEC/i },
  { id: "malware",    label: "マルウェア",         re: /マルウェア|ウイルス|トロイ|ボット|バックドア|malware|trojan|backdoor|botnet|infostealer|stealer|spyware|worm|loader|RAT\b|rootkit/i },
  { id: "attack",     label: "サイバー攻撃",       re: /攻撃|DDoS|APT|標的型|サプライチェーン|改ざん|attack|threat actor|campaign|espionage|nation-?state|supply.?chain|hacktivist|wiper/i },
  { id: "policy",     label: "政策・法規制・ガイドライン", re: /法律|法案|規制|政府|省|庁|ガイドライン|指針|制度|NISC|総務省|経産省|警察庁|regulation|law\b|legislat|policy|government|sanction|compliance|GDPR|SEC\b|CISA (issues|releases|directive)|executive order/i },
  { id: "defense",    label: "対策・製品・技術",   re: /.*/ } // その他すべて
];

// 重要度: 3=要注意 / 2=注目 / 1=通常
const HIGH_RE = /緊急|悪用(が)?確認|ゼロデイ|actively exploited|exploited in the wild|zero-?day|0-?day|critical|CVSS (score of )?(9|10)|emergency|大規模|million|百万|万件|万人/i;
const MID_RE = /重要|注意喚起|ランサム|漏えい|漏洩|流出|ransom|breach|high-severity|severe|warn/i;

// ---------- ユーティリティ ----------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function cleanText(s = "") {
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = decodeEntities(s); // エスケープされた HTML を先に戻してからタグを除去する
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s.replace(/\s+/g, " ").trim();
}

function tag(block, names) {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, "i"));
    if (m) return m[1];
  }
  return "";
}

function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const pick = links.find((a) => /rel=["']alternate["']/i.test(a)) || links.find((a) => !/rel=/i.test(a)) || links[0];
  const href = pick?.match(/href=["']([^"']+)["']/i);
  return href ? decodeEntities(href[1]) : "";
}

function parseDate(s) {
  const d = new Date(cleanText(s));
  return isNaN(d) ? null : d.toISOString();
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function normalizeUrl(u) {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) if (/^utm_|^fbclid$|^ref$/i.test(k)) url.searchParams.delete(k);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return u;
  }
}

function hashId(s) {
  let h = 5381;
  for (const c of s) h = ((h * 33) ^ c.codePointAt(0)) >>> 0;
  return h.toString(36);
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SecurityNewsCollector/1.0)", Accept: "application/rss+xml, application/atom+xml, application/xml, application/json, text/xml, */*" },
    signal: AbortSignal.timeout(20000),
    redirect: "follow"
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // 古い国内サイトは Shift_JIS / EUC-JP のことがある
  const head = buf.subarray(0, 300).toString("latin1");
  const enc = (head.match(/encoding=["']([^"']+)["']/i)?.[1] || res.headers.get("content-type")?.match(/charset=([^;]+)/i)?.[1] || "utf-8").toLowerCase();
  try {
    return new TextDecoder(enc).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

// ---------- パーサ ----------
function parseFeed(xml, feed) {
  const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const blocks = isAtom ? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [] : xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  return blocks.map((b) => {
    const title = cleanText(tag(b, ["title"]));
    let link = isAtom ? atomLink(b) : cleanText(tag(b, ["link"]));
    if (!link) link = b.match(/rdf:about=["']([^"']+)["']/i)?.[1] || cleanText(tag(b, ["guid"]));
    const date = parseDate(tag(b, ["pubDate", "dc:date", "published", "updated", "date"]));
    const summary = cleanText(tag(b, ["description", "summary", "content:encoded", "content"]));
    return { title, link: normalizeUrl(link), date, summary: truncate(summary, 400), source: feed.name, sourceId: feed.id, region: feed.region };
  }).filter((i) => i.title && i.link);
}

function parseKev(json, feed) {
  const data = JSON.parse(json);
  const since = Date.now() - RETENTION_DAYS * 864e5;
  return (data.vulnerabilities || [])
    .filter((v) => new Date(v.dateAdded).getTime() >= since)
    .map((v) => ({
      title: `[悪用確認] ${v.cveID} ${v.vendorProject} ${v.product}: ${v.vulnerabilityName}`,
      link: `https://nvd.nist.gov/vuln/detail/${v.cveID}`,
      date: new Date(v.dateAdded + "T00:00:00Z").toISOString(),
      summary: truncate(`${v.shortDescription} 対応: ${v.requiredAction}${v.knownRansomwareCampaignUse === "Known" ? "（ランサムウェアでの悪用あり）" : ""}`, 400),
      source: feed.name,
      sourceId: feed.id,
      region: feed.region,
      kev: true
    }));
}

function classify(item) {
  const text = `${item.title} ${item.summary}`;
  // タイトルで判定できればそれを優先し、本文の付随的な単語に引きずられないようにする
  const match = (s) => CATEGORIES.filter((c) => c.id !== "defense" && c.re.test(s)).map((c) => c.id);
  const titleHits = match(item.title);
  const hits = titleHits.length ? [...new Set([...titleHits, ...match(item.summary)])] : match(item.summary);
  if (item.kev && !hits.includes("vuln")) hits.unshift("vuln");
  const category = hits[0] || "defense";
  let importance = 1;
  if (item.kev || HIGH_RE.test(text)) importance = 3;
  else if (MID_RE.test(text) || ["ransomware", "breach"].includes(category)) importance = 2;
  return { category, tags: hits, importance };
}

// ---------- Claude による日本語要約（任意） ----------
const AI_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title_ja: { type: "string" },
          summary_ja: { type: "string" },
          action_ja: { type: "string" },
          category: { type: "string", enum: CATEGORIES.map((c) => c.id) },
          importance: { type: "integer", enum: [1, 2, 3] }
        },
        required: ["id", "title_ja", "summary_ja", "action_ja", "category", "importance"],
        additionalProperties: false
      }
    }
  },
  required: ["items"],
  additionalProperties: false
};

const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    overview: { type: "string" },
    points: { type: "array", items: { type: "string" } }
  },
  required: ["headline", "overview", "points"],
  additionalProperties: false
};

const AI_SYSTEM = `あなたはセキュリティに詳しくない一般の人にも分かるようにニュースを説明する編集者です。
専門用語には短い言い換えを添え、事実だけを書き、推測で補わないでください。
カテゴリ ID: ${CATEGORIES.map((c) => `${c.id}=${c.label}`).join(", ")}
重要度: 3=多くの人・組織が今すぐ対応すべき / 2=注目すべき / 1=参考情報`;

async function createClient() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    return new Anthropic();
  } catch {
    console.warn("! @anthropic-ai/sdk が見つかりません。`npm install` を実行すると AI 要約が有効になります。");
    return null;
  }
}

async function askJson(client, schema, prompt, maxTokens) {
  const res = await client.beta.messages.create({
    model: AI_MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: AI_SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }]
  });
  if (res.stop_reason === "refusal") throw new Error(`refusal (${res.stop_details?.category ?? "unknown"})`);
  if (res.stop_reason === "max_tokens") throw new Error("出力が max_tokens で途切れました");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}

async function enrichWithAI(client, items) {
  const targets = items.filter((i) => !i.ai).sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, MAX_AI_ITEMS);
  for (let i = 0; i < targets.length; i += AI_BATCH) {
    const batch = targets.slice(i, i + AI_BATCH);
    const input = batch.map((t) => ({ id: t.id, source: t.source, title: t.title, summary: t.summary }));
    try {
      const out = await askJson(
        client,
        AI_SCHEMA,
        `次のセキュリティニュースそれぞれについて、日本語タイトル(title_ja, 40字以内)、何が起きたかの要約(summary_ja, 2〜3文)、読者が取るべき行動(action_ja, 1文。特に無ければ「特になし」)、カテゴリ、重要度を返してください。\n\n${JSON.stringify(input)}`,
        16000
      );
      for (const r of out.items) {
        const t = batch.find((b) => b.id === r.id);
        if (!t) continue;
        t.ai = { title: r.title_ja, summary: r.summary_ja, action: r.action_ja };
        t.category = r.category;
        t.importance = r.importance;
      }
      console.log(`  AI 要約 ${Math.min(i + AI_BATCH, targets.length)}/${targets.length}`);
    } catch (e) {
      console.warn(`! AI 要約に失敗: ${e.message}`);
    }
  }
}

async function buildDigest(client, items) {
  const since = Date.now() - 864e5 * 1.5;
  const recent = items
    .filter((i) => i.date && new Date(i.date).getTime() >= since)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 40)
    .map((i) => ({ title: i.ai?.title || i.title, summary: i.ai?.summary || i.summary, source: i.source, importance: i.importance }));
  if (!recent.length) return null;
  try {
    const out = await askJson(
      client,
      DIGEST_SCHEMA,
      `直近1日ほどのセキュリティニュースです。全体像が一目で分かる「今日のまとめ」を作ってください。headline は30字以内、overview は3〜4文、points は特に押さえるべき出来事を3〜5個（各1文）。\n\n${JSON.stringify(recent)}`,
      8000
    );
    return { ...out, generatedAt: new Date().toISOString() };
  } catch (e) {
    console.warn(`! まとめの作成に失敗: ${e.message}`);
    return null;
  }
}

// ---------- メイン ----------
async function main() {
  const { feeds } = JSON.parse(await fs.readFile(path.join(ROOT, "feeds.json"), "utf8"));
  await fs.mkdir(DATA_DIR, { recursive: true });

  let existing = [];
  try {
    existing = JSON.parse(await fs.readFile(NEWS_FILE, "utf8")).items || [];
  } catch {}

  const status = [];
  const fetched = [];
  await Promise.all(
    feeds.filter((f) => f.enabled !== false).map(async (feed) => {
      try {
        const body = await fetchText(feed.url);
        const items = feed.type === "kev" ? parseKev(body, feed) : parseFeed(body, feed);
        fetched.push(...items);
        status.push({ id: feed.id, name: feed.name, ok: true, count: items.length });
        console.log(`✓ ${feed.name}: ${items.length}件`);
      } catch (e) {
        status.push({ id: feed.id, name: feed.name, ok: false, error: e.message });
        console.warn(`✗ ${feed.name}: ${e.message}`);
      }
    })
  );

  // 既存データとマージ（既存の AI 要約は引き継ぐ）
  const byId = new Map(existing.map((i) => [i.id, i]));
  const seenTitles = new Set(existing.map((i) => i.title.toLowerCase()));
  const now = new Date().toISOString();
  let added = 0;
  for (const item of fetched) {
    const id = hashId(item.link);
    if (byId.has(id)) continue;
    const key = item.title.toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    item.id = id;
    item.date ||= now;
    item.fetchedAt = now;
    Object.assign(item, classify(item));
    byId.set(id, item);
    added++;
  }

  const cutoff = Date.now() - RETENTION_DAYS * 864e5;
  let items = [...byId.values()]
    .filter((i) => new Date(i.date).getTime() >= cutoff)
    .filter((i) => new Date(i.date).getTime() <= Date.now() + 864e5) // 未来日付の誤データを除外
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_ITEMS);

  const client = await createClient();
  let digest = null;
  if (client) {
    console.log(`Claude (${AI_MODEL}) で要約中…`);
    await enrichWithAI(client, items);
    digest = await buildDigest(client, items);
  }

  const categories = CATEGORIES.map(({ id, label }) => ({ id, label }));
  await fs.writeFile(NEWS_FILE, JSON.stringify({ updatedAt: now, categories, sources: status, items }, null, 0));
  if (digest) await fs.writeFile(DIGEST_FILE, JSON.stringify(digest, null, 2));

  console.log(`\n新着 ${added}件 / 保存 ${items.length}件 → ${path.relative(ROOT, NEWS_FILE)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
