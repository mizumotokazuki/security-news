# セキュリティニュース

国内外のセキュリティの出来事（脆弱性、情報漏えい、ランサムウェア、詐欺、摘発などの良いニュースまで）を自動で集め、
カテゴリ・重要度ごとに整理して、PC・スマホ・タブレットのどれからでも見られる Web ページにするツールです。

## 仕組み

```
feeds.json（収集元13件）
   │  scripts/collect.mjs  … RSS / CISA KEV を取得 → 重複除去 → カテゴリ分類 → 重要度付け
   │                         （APIキーがあれば Claude で日本語要約・「今日のまとめ」も作成）
   ▼
docs/data/news.json
   │
   ▼
docs/index.html（PWA）… スマホのホーム画面に追加すればアプリのように使える。オフラインでも最後の内容を表示
```

| 機能 | 内容 |
|---|---|
| 収集元 | JPCERT/CC, JVN, IPA, Security NEXT, ScanNetSecurity, piyolog, ITmedia, The Hacker News, BleepingComputer, Krebs on Security, SecurityWeek, Dark Reading, CISA KEV |
| 分類 | 摘発・テイクダウン / ランサムウェア / 情報漏えい・不正アクセス / 脆弱性 / フィッシング・詐欺 / マルウェア / サイバー攻撃 / 政策・法規制 / 対策・製品・技術 |
| 重要度 | 「要注意」（悪用確認・ゼロデイ・緊急・大規模流出など）、「注目」、通常 |
| 絞り込み | 期間（24時間〜30日）、国内／海外、カテゴリ、要注意のみ、キーワード検索 |
| その他 | 用語ミニ解説、ダークモード自動対応、30日分を保持 |

## 1. まず自分の PC で見る

Node.js 20 以上が必要です。

```bash
npm start
```

ブラウザで http://localhost:8080 を開きます。同じ Wi-Fi のスマホからは、表示された `http://192.168.x.x:8080` で見られます。
最新化したいときは `npm run collect` を実行してください。

## 2. どこからでも見られるようにする（推奨: GitHub Pages、無料）

GitHub が 3 時間ごとに自動で収集・公開するので、PC の電源が切れていても更新され、URL を開けばどの端末からでも見られます。

1. GitHub で新しいリポジトリを作成（例: `security-news`）。
2. このフォルダの中身をそのリポジトリに push。
   ```bash
   git init -b main
   ```
   ```bash
   git add .
   ```
   ```bash
   git commit -m "初回"
   ```
   ```bash
   git remote add origin https://github.com/<ユーザー名>/security-news.git
   ```
   ```bash
   git push -u origin main
   ```
3. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** に変更。
4. **Actions** タブで「ニュース収集と公開」を一度手動実行（Run workflow）。
5. `https://<ユーザー名>.github.io/security-news/` が公開 URL です。スマホでは共有メニューの「ホーム画面に追加」でアプリのように使えます。

> 公開リポジトリにすると URL を知っている人は誰でも閲覧できます（中身は公開ニュースの見出しだけなので問題は少ないですが、気になる場合は有料プランの非公開 Pages か、Cloudflare Pages + Access などを使ってください）。

## 費用について（基本は無料）

| 項目 | 費用 |
|---|---|
| ニュース収集・分類・表示 | 無料（API キー不要） |
| GitHub Actions / GitHub Pages | **公開リポジトリなら無料**（非公開リポジトリで Pages を使うには有料プランが必要） |
| 英語記事の日本語化 | 無料（各記事の「🌐 日本語で読む」から Google 翻訳で表示） |
| 今日のまとめ | 無料（件数と要注意記事から自動で文章を作成） |
| AI 要約（下記 3.） | 有料・任意。設定しなければ一切使われません |

## 3. （任意・有料）AI による日本語要約

Anthropic の API キー（従量課金）を設定すると、英語記事も含めて「日本語タイトル・2〜3文の要約・取るべき行動」と、トップの「今日のまとめ」が付きます。

- ローカル: `npm install` のあと、`.env.example` を `.env` にコピーしてキーを貼り付け、`npm run collect`（環境変数 `ANTHROPIC_API_KEY` でも可）
- GitHub: **Settings → Secrets and variables → Actions** に `ANTHROPIC_API_KEY` を登録

既定のモデルは `claude-opus-5-5`（effort: low）です。1回の実行で要約するのは新着最大 80 件、要約済みの記事は再要約しません。
費用を抑えたい場合は環境変数 `CLAUDE_MODEL=claude-haiku-5-5` や `MAX_AI_ITEMS` で調整できます。

## カスタマイズ

- **収集元の追加・停止**: `feeds.json` を編集（RSS/Atom なら URL を足すだけ）。
- **分類キーワード・重要度**: `scripts/collect.mjs` の `CATEGORIES`, `HIGH_RE`, `MID_RE`。
- **保持期間**: 環境変数 `RETENTION_DAYS`（既定 30 日）。
- **更新頻度**: `.github/workflows/collect.yml` の `cron`。

## 注意

各記事の著作権は配信元にあります。本ツールは RSS で配信されている見出しと概要のみを表示し、本文は元記事へリンクしています。
