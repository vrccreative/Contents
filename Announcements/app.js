"use strict";

/*
 * お知らせ一覧ビューア
 * 公開 announcements.json を読み、ワールドのメニュー「お知らせ」タブに表示中の内容を
 * 同じ並び（上が新しい）で一覧する。テキスト / 画像 / テキスト＋画像 に対応。
 * 依存ゼロ・CDN不使用・file:// でも動作する（データ取得はフォールバック方式）。
 *
 * このページは /Announcements/ に置かれ、データは同フォルダ内の v1/ にある。
 */

const CONFIG = {
  owner: "vrccreative",
  repo: "Contents",
  branch: "main",
  // このページ（/Announcements/）から見たデータの相対パス
  jsonRel: "v1/announcements.json",
  imageRelDir: "v1/images",
  // 公開は手動運用。長期間更新が無ければ気付けるよう鮮度を表示する（警告の閾値）
  freshWarnDays: 120,
};

// このフォルダ（/Announcements）の raw 基点
const RAW_DIR = `https://raw.githubusercontent.com/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}/Announcements`;
// commits API はリポジトリ直下からのパスで指定する
const COMMITS_PATH = `Announcements/${CONFIG.jsonRel}`;
const COMMITS_API = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/commits?path=${encodeURIComponent(COMMITS_PATH)}&per_page=1`;

const $ = (id) => document.getElementById(id);

// 画像URLの基点。JSONを相対で取得できたら相対、raw から取得したら raw に合わせる
let IMG_BASE = CONFIG.imageRelDir;

document.addEventListener("DOMContentLoaded", () => {
  $("reload").addEventListener("click", run);
  run();
});

async function run() {
  setStatus("loading", "読み込み中…");
  $("list").hidden = true;
  $("list").innerHTML = "";
  try {
    const { data, source, imgBase } = await loadData();
    IMG_BASE = imgBase;
    render(data);
    $("source-note").textContent = `データ取得元: ${source}`;
    loadFreshness(); // 鮮度は後追い（失敗しても本体は表示する）
  } catch (e) {
    setStatus("error", `お知らせを読み込めませんでした：${e.message}`);
  }
}

/* ---------- データ取得（相対 → raw フォールバック） ---------- */

async function loadData() {
  // 1) 同一オリジンの相対パス（Pages 上 / ローカル HTTP サーバー上で有効）
  try {
    const r = await fetch(CONFIG.jsonRel, { cache: "no-store" });
    if (r.ok) return { data: await r.json(), source: `${CONFIG.jsonRel}（同一オリジン）`, imgBase: CONFIG.imageRelDir };
  } catch (_) { /* file:// では fetch がブロックされるので raw に回す */ }

  // 2) raw.githubusercontent（ACAO:* のため file:// でも取得可＝ライブ公開値）
  const rawUrl = `${RAW_DIR}/${CONFIG.jsonRel}`;
  const r2 = await fetch(rawUrl, { cache: "no-store" });
  if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
  return { data: await r2.json(), source: `${rawUrl}（ライブ公開値）`, imgBase: `${RAW_DIR}/${CONFIG.imageRelDir}` };
}

/* ---------- 鮮度（最終公開日） ---------- */

async function loadFreshness() {
  const badge = $("freshness");
  try {
    const r = await fetch(COMMITS_API, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const commits = await r.json();
    if (!Array.isArray(commits) || commits.length === 0) throw new Error("コミット情報なし");
    const c = commits[0];
    const dateStr = c.commit && c.commit.committer && c.commit.committer.date;
    const when = new Date(dateStr);
    const days = Math.floor((Date.now() - when.getTime()) / 86400000);
    const ymd = when.toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" });

    const cls = days >= CONFIG.freshWarnDays ? "badge-warn" : "badge-ok";
    badge.className = `badge ${cls}`;
    badge.textContent = `最終更新 ${ymd}（${days}日前）`;
    badge.title = (c.commit && c.commit.message) ? c.commit.message.split("\n")[0] : "";
  } catch (e) {
    badge.className = "badge badge-muted";
    badge.textContent = "更新日時を取得できませんでした";
    badge.title = String(e && e.message ? e.message : e);
  }
}

/* ---------- 描画 ---------- */

function render(data) {
  const items = data && Array.isArray(data.items) ? data.items : [];
  const list = $("list");
  list.innerHTML = "";

  if (items.length === 0) {
    setStatus("empty", "現在お知らせはありません。");
    list.hidden = true;
    return;
  }

  for (const item of items) {
    list.appendChild(renderCard(item));
  }
  list.hidden = false;
  setStatus("ok", `${items.length} 件のお知らせを表示中（上が新しい順）`);
}

function renderCard(item) {
  const card = el("article", "ann-card");

  const body = typeof item.body === "string" ? item.body : "";
  const hasBody = body.trim() !== "";
  const hasImage = typeof item.slot === "number";
  const typeLabel = hasImage ? (hasBody ? "テキスト＋画像" : "画像") : "テキスト";

  // ヘッダー（タイトル + 種別バッジ + 日付）
  const head = el("div", "ann-head");
  const titleWrap = el("div");
  const title = el("h2", "ann-title");
  title.textContent = item.title || "(無題)";
  const type = el("span", "ann-type");
  type.textContent = typeLabel;
  title.appendChild(type);
  titleWrap.appendChild(title);
  head.appendChild(titleWrap);

  if (item.date) {
    const date = el("span", "ann-date");
    date.textContent = item.date;
    head.appendChild(date);
  }
  card.appendChild(head);

  // 本文（上）— ワールドと同じく改行を保持
  if (hasBody) {
    const p = el("p", "ann-body");
    p.textContent = body;
    card.appendChild(p);
  }

  // 画像（下）
  if (hasImage) {
    const rev = typeof item.rev === "number" ? item.rev : 0;
    const img = document.createElement("img");
    img.className = "ann-image";
    img.loading = "lazy";
    img.alt = item.title || "お知らせ画像";
    img.src = `${IMG_BASE}/slot${item.slot}.png?v=${rev}`;
    img.addEventListener("error", () => {
      img.remove();
      const miss = el("div", "ann-image-missing");
      miss.textContent = "画像を読み込めませんでした（公開直後は反映に数分かかることがあります）。";
      card.appendChild(miss);
    });
    card.appendChild(img);
  }

  return card;
}

/* ---------- ヘルパー ---------- */

function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function setStatus(kind, text) {
  const s = $("status");
  s.className = `status status-${kind}`;
  s.textContent = text;
  s.hidden = false;
}
