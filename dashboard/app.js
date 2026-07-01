"use strict";

/*
 * 運営ヘルスダッシュボード
 * 公開 users.json を読み、メンバーリスト（配信枠権限 / 支援者ボード / スタッフ）を
 * 個別に閲覧でき、tier / admin ロール / 更新鮮度も集計表示する。
 * 依存ゼロ・CDN不使用・file:// でも動作する（データ取得はフォールバック方式）。
 */

const CONFIG = {
  owner: "vrccreative",
  repo: "Contents",
  branch: "main",
  path: "Users/v2/users.json",
  // ワールド側 UserDataLoader / GAS(#789) と揃えた既知 tier 語彙
  knownTiers: ["premium", "standard", "lite"],
  // 自動 push は月次想定。経過日数の警告しきい値（運用サイクルに合わせて調整可）
  freshWarnDays: 45,
  freshErrDays: 75,
  // tier を持つメンバーリスト定義。
  //   nameField … 名前列（fanbox_credits だけ fanbox_name）
  //   allowDup  … 同名の重複を許容するか（fanbox_credits は同名別人ありのため許容 = 重複を警告しない）
  lists: [
    { key: "fanbox", label: "配信枠権限 (Fanbox)", desc: "配信画面の枠用の権限を持つメンバー（フォーム申請済みの支援者）。", nameField: "player_name", allowDup: false },
    { key: "fanbox_credits", label: "支援者ボード (全体)", desc: "支援者ボードに表示する全支援者。同じ名前でも別人のことがあるため、重複していても正常です。", nameField: "fanbox_name", allowDup: true },
    { key: "staff", label: "スタッフ", desc: "運営スタッフ。", nameField: "player_name", allowDup: false },
  ],
  // roles を持つ配列
  roleArrays: ["admin"],
};

const RAW_URL = `https://raw.githubusercontent.com/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}/${CONFIG.path}`;
const RELATIVE_URL = `../${CONFIG.path}`;
const COMMITS_API = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/commits?path=${encodeURIComponent(CONFIG.path)}&per_page=1`;

const $ = (id) => document.getElementById(id);

let DATA = null;          // 読み込んだ users.json
let ACTIVE_LIST = null;   // 現在表示中のリスト key
let PENDING_WARNINGS = [];

document.addEventListener("DOMContentLoaded", () => {
  $("reload").addEventListener("click", run);
  $("list-search").addEventListener("input", () => renderListView());
  run();
});

async function run() {
  setStatus("loading", "読み込み中…");
  hidePanels();
  try {
    const { data, source } = await loadData();
    DATA = data;
    renderAll(data);
    $("source-note").textContent = `データ取得元: ${source}`;
    setStatus("ok", "読み込み完了");
    loadFreshness(); // 鮮度は非同期で後追い（失敗しても本体は表示する）
  } catch (e) {
    setStatus("error", `メンバーデータを読み込めませんでした：${e.message}`);
  }
}

/* ---------- データ取得（相対 → raw フォールバック） ---------- */

async function loadData() {
  // 1) 同一オリジンの相対パス（Pages 上 / ローカル HTTP サーバー上で有効）
  try {
    const r = await fetch(RELATIVE_URL, { cache: "no-store" });
    if (r.ok) return { data: await r.json(), source: `${RELATIVE_URL}（同一オリジン）` };
  } catch (_) { /* file:// では fetch がブロックされるので raw に回す */ }

  // 2) raw.githubusercontent（ACAO:* のため file:// でも取得可＝ライブ公開値）
  const r2 = await fetch(RAW_URL, { cache: "no-store" });
  if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
  return { data: await r2.json(), source: `${RAW_URL}（ライブ公開値）` };
}

/* ---------- 鮮度（自動 push が生きているか） ---------- */

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

    let cls = "badge-ok";
    if (days >= CONFIG.freshErrDays) cls = "badge-err";
    else if (days >= CONFIG.freshWarnDays) cls = "badge-warn";
    badge.className = `badge ${cls}`;
    badge.textContent = `最終更新 ${ymd}（${days}日前）`;
    badge.title = (c.commit && c.commit.message) ? c.commit.message.split("\n")[0] : "";

    if (days >= CONFIG.freshWarnDays) {
      addWarning(days >= CONFIG.freshErrDays ? "err" : "warn",
        `メンバーデータが ${days} 日間更新されていません。自動更新が止まっている可能性があります（通常は毎月更新されます）。`);
    }
  } catch (e) {
    badge.className = "badge badge-muted";
    badge.textContent = "更新日時を取得できませんでした";
    badge.title = String(e && e.message ? e.message : e);
  }
}

/* ---------- 全体描画 ---------- */

function renderAll(data) {
  PENDING_WARNINGS = [];
  LIST_CHECKED.clear();
  renderCards(data);
  // 表示中タブに関わらず、存在する全リストの構造チェックを初回に集計する
  for (const l of CONFIG.lists) {
    if (Array.isArray(data[l.key])) collectListWarnings(l, data[l.key]);
  }
  renderLists(data);
  renderRoles(data, PENDING_WARNINGS);
  paintWarnings();
}

function renderCards(data) {
  const cards = [];
  for (const list of CONFIG.lists) {
    if (Array.isArray(data[list.key])) cards.push(card(list.label, data[list.key].length, "件"));
  }
  for (const key of CONFIG.roleArrays) {
    if (Array.isArray(data[key])) cards.push(card(key, data[key].length, "人"));
  }
  const el = $("cards");
  el.innerHTML = cards.join("");
  el.hidden = cards.length === 0;
}

function card(label, value, unit) {
  return `<div class="card"><div class="label">${esc(label)}</div>` +
    `<div class="value">${value}<span class="sub"> ${esc(unit)}</span></div></div>`;
}

/* ---------- メンバーリスト（タブで個別閲覧） ---------- */

function renderLists(data) {
  const present = CONFIG.lists.filter((l) => Array.isArray(data[l.key]));
  const missing = CONFIG.lists.filter((l) => !Array.isArray(data[l.key]));

  // 存在しないリストの注記（例: 現公開ファイルに fanbox_credits がまだ無い場合）
  $("list-missing").innerHTML = missing.length
    ? "まだ公開データに含まれていないリスト: " + missing.map((l) => esc(l.label)).join(" / ") +
      "（次回の自動更新で表示されます）。"
    : "";

  if (present.length === 0) { $("lists-panel").hidden = true; return; }
  if (!present.some((l) => l.key === ACTIVE_LIST)) ACTIVE_LIST = present[0].key;

  // タブ生成
  $("list-tabs").innerHTML = present.map((l) =>
    `<button type="button" class="tab${l.key === ACTIVE_LIST ? " active" : ""}" data-key="${esc(l.key)}">` +
    `${esc(l.label)} <span class="tab-count">${data[l.key].length}</span></button>`
  ).join("");
  for (const btn of $("list-tabs").querySelectorAll(".tab")) {
    btn.addEventListener("click", () => {
      ACTIVE_LIST = btn.dataset.key;
      $("list-search").value = "";
      renderLists(DATA); // タブの active 更新
    });
  }

  const active = CONFIG.lists.find((l) => l.key === ACTIVE_LIST);
  $("list-desc").textContent = active ? active.desc : "";
  renderListTierBreakdown(active, data[active.key]);
  renderListView();
  $("lists-panel").hidden = false;
}

function renderListTierBreakdown(list, rows) {
  const counts = Object.create(null);
  for (const r of rows) {
    const tier = r && typeof r.tier === "string" ? r.tier : "(未設定)";
    counts[tier] = (counts[tier] || 0) + 1;
  }
  const ordered = [...CONFIG.knownTiers.filter((t) => t in counts),
                   ...Object.keys(counts).filter((t) => !CONFIG.knownTiers.includes(t)).sort()];
  $("list-tiers").innerHTML = ordered.map((t) => {
    const unknown = !CONFIG.knownTiers.includes(t);
    return `<span class="chip${unknown ? " bad" : ""}">${esc(t)} <b>${counts[t]}</b></span>`;
  }).join("");
}

function renderListView() {
  const list = CONFIG.lists.find((l) => l.key === ACTIVE_LIST);
  if (!list || !DATA || !Array.isArray(DATA[list.key])) { $("list-view").innerHTML = ""; return; }
  const rows = DATA[list.key];
  const q = $("list-search").value.trim().toLowerCase();

  let shown = 0;
  let body = "";
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const name = r[list.nameField] != null ? String(r[list.nameField]) : "";
    if (q && !name.toLowerCase().includes(q)) continue;
    shown++;
    const tier = typeof r.tier === "string" ? r.tier : "(未設定)";
    const unknown = !CONFIG.knownTiers.includes(tier);
    const nameCell = name.trim() === "" ? `<span class="chip bad">(空)</span>` : esc(name);
    body += `<tr><td class="num">${shown}</td><td>${nameCell}</td>` +
      `<td>${unknown ? `<span class="chip bad">${esc(tier)}</span>` : esc(tier)}</td></tr>`;
  }

  $("list-count").textContent = q ? `${shown} / ${rows.length} 件（絞り込み中）` : `${rows.length} 件`;
  $("list-view").innerHTML =
    `<table><thead><tr><th class="num">#</th><th>名前</th><th>会員区分</th></tr></thead>` +
    `<tbody>${body || `<tr><td colspan="3" class="note">該当なし</td></tr>`}</tbody></table>`;
}

// リスト単位の構造/語彙チェック（重複・空名・未知 tier）。renderAll から存在する全リスト分を
// 呼ぶ。タブ切替や検索の再描画で二重計上しないよう、リストごとに1回だけ集計する。
const LIST_CHECKED = new Set();
function collectListWarnings(list, rows) {
  if (LIST_CHECKED.has(list.key)) return;
  LIST_CHECKED.add(list.key);

  const counts = Object.create(null);
  let emptyNames = 0, unknownTier = 0, dup = 0;
  for (const r of rows) {
    const name = r && r[list.nameField] != null ? String(r[list.nameField]).trim() : "";
    if (name === "") emptyNames++;
    else {
      counts[name] = (counts[name] || 0) + 1;
      if (counts[name] === 2) dup++; // 2件目で1回だけ計上
    }
    const tier = r && typeof r.tier === "string" ? r.tier : "";
    if (tier === "" || !CONFIG.knownTiers.includes(tier)) unknownTier++;
  }
  if (emptyNames > 0) addWarning("err", `${list.label}：名前が空の行が ${emptyNames} 件あります。`);
  if (unknownTier > 0) addWarning("err", `${list.label}：会員区分が未設定または想定外の行が ${unknownTier} 件あります（正しくは premium / standard / lite）。`);
  if (!list.allowDup && dup > 0) addWarning("warn", `${list.label}：同じ名前が重複しています（${dup} 名分）。二重登録の可能性があります。`);
}

/* ---------- admin ロール棚卸し ---------- */

const ROLE_ARRAY_ROWS = Object.create(null); // key -> rows（クリック時のメンバー引き当て用）
let ACTIVE_ROLE = null;                       // { arrayKey, token } 選択中の権限・タグ

function renderRoles(data, warnings) {
  const blocks = [];
  for (const key of CONFIG.roleArrays) {
    const rows = data[key];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    ROLE_ARRAY_ROWS[key] = rows;

    const counts = Object.create(null);
    let emptyNames = 0, emptyRoles = 0, badTokens = 0;
    for (const r of rows) {
      if (!r || !r.player_name || String(r.player_name).trim() === "") emptyNames++;
      const list = normalizeRoles(r && r.roles);
      if (list.length === 0) emptyRoles++;
      const seen = Object.create(null);
      for (const raw of list) {
        const t = String(raw).trim();
        if (t === "") { badTokens++; continue; }
        if (seen[t]) { badTokens++; continue; }
        seen[t] = true;
        counts[t] = (counts[t] || 0) + 1;
      }
    }

    const tokens = Object.keys(counts).sort();
    const groups = { "権限 (perm_)": [], "タグ (tag_)": [], "その他": [] };
    for (const t of tokens) {
      if (t.startsWith("perm_")) groups["権限 (perm_)"].push(t);
      else if (t.startsWith("tag_")) groups["タグ (tag_)"].push(t);
      else groups["その他"].push(t);
    }
    let html = `<div class="arr-title">管理者（${rows.length} 人 / 権限・タグ ${tokens.length} 種）</div>`;
    for (const [g, arr] of Object.entries(groups)) {
      if (arr.length === 0) continue;
      html += `<div class="note" style="margin:8px 0 4px">${esc(g)}</div>`;
      html += arr.map((t) => {
        const active = ACTIVE_ROLE && ACTIVE_ROLE.arrayKey === key && ACTIVE_ROLE.token === t;
        return `<span class="chip role-chip${active ? " active" : ""}" data-arraykey="${esc(key)}" data-role="${esc(t)}">` +
          `${esc(t)} <b>${counts[t]}</b></span>`;
      }).join("");
    }
    blocks.push(html);

    if (emptyNames > 0) warnings.push({ level: "err", msg: `管理者リスト：名前が空の行が ${emptyNames} 件あります。` });
    if (emptyRoles > 0) warnings.push({ level: "warn", msg: `管理者リスト：権限が未設定の行が ${emptyRoles} 件あります。` });
    if (badTokens > 0) warnings.push({ level: "warn", msg: `管理者リスト：権限の記載に空欄や重複が ${badTokens} 件あります。` });
  }
  const el = $("roles");
  el.innerHTML = blocks.join("");
  for (const chip of el.querySelectorAll(".role-chip")) {
    chip.addEventListener("click", () => {
      const sel = { arrayKey: chip.dataset.arraykey, token: chip.dataset.role };
      // 同じチップの再クリックで選択解除
      if (ACTIVE_ROLE && ACTIVE_ROLE.arrayKey === sel.arrayKey && ACTIVE_ROLE.token === sel.token) {
        ACTIVE_ROLE = null;
      } else {
        ACTIVE_ROLE = sel;
      }
      for (const c of el.querySelectorAll(".role-chip")) {
        c.classList.toggle("active", ACTIVE_ROLE && c.dataset.arraykey === ACTIVE_ROLE.arrayKey && c.dataset.role === ACTIVE_ROLE.token);
      }
      renderRoleMembers();
    });
  }
  $("roles-panel").hidden = blocks.length === 0;
  renderRoleMembers();
}

// 選択中の権限・タグを持つメンバーを一覧表示する
function renderRoleMembers() {
  const box = $("role-members");
  if (!box) return;
  if (!ACTIVE_ROLE) {
    box.innerHTML = `<p class="note">権限・タグをクリックすると、付与されているメンバーを表示します。</p>`;
    return;
  }
  const rows = ROLE_ARRAY_ROWS[ACTIVE_ROLE.arrayKey] || [];
  const token = ACTIVE_ROLE.token;

  const members = rows.filter((r) => normalizeRoles(r && r.roles).map((s) => String(s).trim()).includes(token));
  const body = members.map((r, i) => {
    const name = r && r.player_name != null ? String(r.player_name) : "";
    const nameCell = name.trim() === "" ? `<span class="chip bad">(空)</span>` : esc(name);
    const others = normalizeRoles(r && r.roles).map((s) => String(s).trim()).filter((s) => s !== "" && s !== token);
    const otherChips = others.length ? others.map((s) => `<span class="chip">${esc(s)}</span>`).join("") : `<span class="note">なし</span>`;
    return `<tr><td class="num">${i + 1}</td><td>${nameCell}</td><td>${otherChips}</td></tr>`;
  }).join("");

  box.innerHTML =
    `<div class="arr-title">「${esc(token)}」を持つメンバー：${members.length} 人</div>` +
    `<table><thead><tr><th class="num">#</th><th>名前</th><th>その他の権限・タグ</th></tr></thead>` +
    `<tbody>${body || `<tr><td colspan="3" class="note">該当なし</td></tr>`}</tbody></table>`;
}

function normalizeRoles(roles) {
  if (Array.isArray(roles)) return roles.map(String);
  if (typeof roles === "string") return roles.split(",");
  return [];
}

/* ---------- 警告パネル ---------- */

function addWarning(level, msg) {
  PENDING_WARNINGS.push({ level, msg });
  paintWarnings();
}

function paintWarnings() {
  const ul = $("warnings");
  if (PENDING_WARNINGS.length === 0) {
    ul.innerHTML = `<li class="ok">問題は見つかりませんでした。メンバーデータは正常です。</li>`;
  } else {
    const order = { err: 0, warn: 1 };
    const sorted = PENDING_WARNINGS.slice().sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));
    ul.innerHTML = sorted.map((w) => `<li class="${w.level}">${esc(w.msg)}</li>`).join("");
  }
  $("warnings-panel").hidden = false;
}

/* ---------- ユーティリティ ---------- */

function setStatus(kind, msg) {
  const el = $("status");
  el.className = "status " + (kind === "error" ? "status-error" : kind === "ok" ? "status-ok" : "status-loading");
  el.textContent = msg;
}

function hidePanels() {
  for (const id of ["cards", "lists-panel", "roles-panel", "warnings-panel"]) $(id).hidden = true;
  $("source-note").textContent = "";
  LIST_CHECKED.clear();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
