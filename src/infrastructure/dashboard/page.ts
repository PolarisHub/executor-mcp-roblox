/**
 * The dashboard HTML page (self-contained: inlined CSS + JS).
 *
 * The whole page is a TypeScript template literal, so the embedded runtime
 * <script> avoids JavaScript template literals / backticks and any literal `${`
 * — all runtime strings are built with string concatenation and Array.join.
 */
export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Roblox Executor MCP</title>
<style>
  :root {
    --bg: #141414;
    --panel: #1b1b1b;
    --panel-2: #202020;
    --hover: #232323;
    --border: #2a2a2a;
    --border-2: #353535;
    --text: #e6e6e6;
    --dim: #9a9a9a;
    --faint: #6b6b6b;
    --accent: #6b9bff;
    --ok: #5ec26e;
    --err: #e25c54;
    --warn: #d6a14a;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: var(--font);
    font-size: 13px;
    color: var(--text);
    background: var(--bg);
    -webkit-font-smoothing: antialiased;
  }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: #2f2f2f; border-radius: 6px; border: 2px solid var(--bg); }
  ::-webkit-scrollbar-thumb:hover { background: #3a3a3a; }
  a { color: var(--accent); text-decoration: none; }

  /* ---- header ---- */
  header {
    display: flex;
    align-items: center;
    gap: 13px;
    padding: 12px 22px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }
  .mark {
    width: 34px; height: 34px; border-radius: 9px; flex: none;
    background: #1c2230; border: 1px solid #2b3346;
    display: grid; place-items: center; color: var(--accent);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }
  .mark svg { width: 18px; height: 18px; }
  .brand { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .title { font-size: 14.5px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.1; }
  .sub {
    display: flex; align-items: center; gap: 8px;
    color: var(--faint); font-size: 12px; line-height: 1.1;
  }
  .sub .mono { font-family: var(--mono); }
  .sub .lbl { color: var(--dim); }
  .dotsep { width: 3px; height: 3px; border-radius: 50%; background: #3a3a3a; flex: none; }
  .header-right { margin-left: auto; display: flex; align-items: center; gap: 18px; }
  .uptime-box { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
  .u-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.13em; color: var(--faint); }
  .uptime {
    font-family: var(--mono); font-size: 14px; color: var(--text);
    font-variant-numeric: tabular-nums; letter-spacing: 0.01em; line-height: 1;
  }
  .status {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 6px 12px; border-radius: 8px;
    border: 1px solid rgba(94, 194, 110, 0.25);
    background: rgba(94, 194, 110, 0.07);
    font-size: 12px; font-weight: 500; color: var(--ok); white-space: nowrap;
  }
  .status i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .status.off { color: var(--err); border-color: rgba(226, 92, 84, 0.25); background: rgba(226, 92, 84, 0.07); }

  /* ---- stat strip ---- */
  .strip {
    display: flex; border-bottom: 1px solid var(--border); background: var(--panel);
  }
  .strip .cell {
    padding: 11px 18px; border-right: 1px solid var(--border); min-width: 120px;
  }
  .strip .cell .k { font-size: 11px; color: var(--faint); text-transform: uppercase; letter-spacing: .06em; }
  .strip .cell .v { font-size: 19px; font-weight: 600; margin-top: 3px; font-variant-numeric: tabular-nums; }

  /* ---- tabs ---- */
  nav.tabs {
    display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--border);
    background: var(--bg);
  }
  nav.tabs button {
    appearance: none; background: none; border: none; cursor: pointer;
    color: var(--dim); font: inherit; font-size: 13px;
    padding: 11px 14px; border-bottom: 2px solid transparent; margin-bottom: -1px;
  }
  nav.tabs button:hover { color: var(--text); }
  nav.tabs button.active { color: var(--text); border-bottom-color: var(--accent); }
  nav.tabs button .count {
    margin-left: 7px; font-size: 11px; color: var(--faint);
    font-variant-numeric: tabular-nums;
  }

  main { padding: 18px; }
  .panel { display: none; }
  .panel.active { display: block; }

  /* ---- tables ---- */
  table { width: 100%; border-collapse: collapse; }
  thead th {
    text-align: left; font-size: 11px; font-weight: 500; color: var(--faint);
    text-transform: uppercase; letter-spacing: .05em;
    padding: 9px 14px; border-bottom: 1px solid var(--border);
  }
  tbody td { padding: 10px 14px; border-bottom: 1px solid #1f1f1f; vertical-align: middle; }
  tbody tr:hover { background: var(--panel); }
  .table-wrap { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--panel); }
  .mono { font-family: var(--mono); }
  .num { font-variant-numeric: tabular-nums; }
  .muted { color: var(--dim); }
  .faint { color: var(--faint); }

  /* ---- chips / badges ---- */
  .chip {
    display: inline-block; padding: 2px 8px; border-radius: 5px; font-size: 11px;
    background: var(--panel-2); border: 1px solid var(--border); color: var(--dim);
    white-space: nowrap;
  }
  .badge {
    display: inline-block; padding: 1px 7px; border-radius: 4px; font-size: 10px;
    text-transform: uppercase; letter-spacing: .04em; border: 1px solid transparent;
  }
  .badge.write { color: var(--err); border-color: rgba(226,92,84,.35); background: rgba(226,92,84,.08); }
  .badge.read { color: var(--faint); border-color: var(--border); }
  .badge.client { color: var(--warn); border-color: rgba(214,161,74,.3); background: rgba(214,161,74,.07); }
  .res { display: inline-flex; align-items: center; gap: 7px; }
  .res i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  .res.ok i { background: var(--ok); } .res.ok { color: var(--ok); }
  .res.error i { background: var(--err); } .res.error { color: var(--err); }

  /* ---- avatar ---- */
  .avatar {
    width: 26px; height: 26px; border-radius: 6px; flex: none; object-fit: cover;
    background: #262626; border: 1px solid var(--border-2);
    display: inline-grid; place-items: center; font-size: 11px; color: var(--dim); overflow: hidden;
  }
  .who { display: flex; align-items: center; gap: 10px; }
  .who .nm { font-weight: 500; }
  .who .id { font-size: 11px; color: var(--faint); font-family: var(--mono); }

  /* ---- tools tab ---- */
  .tools-layout { display: grid; grid-template-columns: 210px 1fr; gap: 16px; align-items: start; }
  .cats {
    border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--panel);
  }
  .cats button {
    display: flex; width: 100%; align-items: center; justify-content: space-between;
    appearance: none; background: none; border: none; cursor: pointer; font: inherit;
    color: var(--dim); padding: 8px 12px; border-bottom: 1px solid #1f1f1f; text-align: left;
  }
  .cats button:last-child { border-bottom: none; }
  .cats button:hover { background: var(--hover); color: var(--text); }
  .cats button.active { background: var(--panel-2); color: var(--text); box-shadow: inset 2px 0 0 var(--accent); }
  .cats button .c { font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }
  .search {
    width: 100%; padding: 9px 12px; margin-bottom: 12px;
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    color: var(--text); font: inherit; font-size: 13px; outline: none;
  }
  .search:focus { border-color: var(--border-2); }
  .search::placeholder { color: var(--faint); }
  .tool-list { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--panel); }
  .tool {
    padding: 11px 14px; border-bottom: 1px solid #1f1f1f; display: flex; gap: 12px; align-items: flex-start;
  }
  .tool:last-child { border-bottom: none; }
  .tool:hover { background: var(--hover); }
  .tool .body { min-width: 0; flex: 1; }
  .tool .top { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
  .tool .name { font-family: var(--mono); font-size: 13px; color: var(--text); }
  .tool .ttl { color: var(--dim); margin-top: 3px; }
  .tool .desc {
    color: var(--faint); margin-top: 5px; font-size: 12px; line-height: 1.5;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .tool .tags { display: flex; gap: 6px; align-items: center; flex: none; }

  /* ---- empty ---- */
  .empty { padding: 44px 18px; text-align: center; color: var(--faint); }
  .empty .h { color: var(--dim); font-size: 13px; }
  .empty .s { margin-top: 5px; font-size: 12px; }
  .toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .toolbar .count { color: var(--faint); font-size: 12px; margin-left: auto; }
  .sec { font-size: 11px; color: var(--faint); text-transform: uppercase; letter-spacing: .06em; margin: 0 0 10px 2px; }

  /* ---- clients: clickable rows ---- */
  tr.clickable { cursor: pointer; }
  tr.clickable .go {
    display: inline-flex; align-items: center; gap: 5px;
    color: var(--faint); font-size: 12px; visibility: hidden; white-space: nowrap;
  }
  tr.clickable:hover .go { visibility: visible; color: var(--accent); }
  tr.clickable .go svg { width: 13px; height: 13px; }
  td.go-cell { text-align: right; width: 1%; }

  /* ---- explorer ---- */
  .exp-toolbar {
    display: flex; align-items: center; gap: 12px; margin-bottom: 12px;
    padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel);
    flex-wrap: wrap;
  }
  .exp-toolbar .client {
    display: inline-flex; align-items: center; gap: 8px; font-weight: 550; min-width: 0;
  }
  .exp-toolbar .client .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: none; }
  .exp-crumb {
    display: flex; align-items: center; gap: 5px; min-width: 0; overflow: hidden;
    color: var(--dim); font-family: var(--mono); font-size: 12px; flex-wrap: wrap;
  }
  .exp-crumb .seg { cursor: pointer; color: var(--dim); white-space: nowrap; }
  .exp-crumb .seg:hover { color: var(--text); }
  .exp-crumb .seg.cur { color: var(--text); cursor: default; }
  .exp-crumb .sep { color: var(--faint); }
  .btn {
    appearance: none; cursor: pointer; font: inherit; font-size: 12px;
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 11px; border-radius: 7px;
    background: var(--panel-2); border: 1px solid var(--border); color: var(--dim);
  }
  .btn:hover { background: var(--hover); color: var(--text); border-color: var(--border-2); }
  .btn svg { width: 13px; height: 13px; }
  .btn[disabled] { opacity: .5; cursor: default; }
  .exp-toolbar .right { margin-left: auto; display: flex; align-items: center; gap: 8px; }

  .exp-layout { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 14px; align-items: start; }
  .exp-col {
    border: 1px solid var(--border); border-radius: 8px; background: var(--panel); overflow: hidden;
    display: flex; flex-direction: column; min-height: 320px;
  }
  .exp-col .col-head {
    padding: 8px 12px; border-bottom: 1px solid var(--border); color: var(--faint);
    font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
    display: flex; align-items: center; gap: 8px;
  }
  .exp-tree { overflow: auto; max-height: 64vh; padding: 4px 0; }

  .tnode { user-select: none; }
  .trow {
    display: flex; align-items: center; gap: 7px; padding: 4px 12px 4px 0;
    cursor: pointer; white-space: nowrap; line-height: 1.4;
  }
  .trow:hover { background: var(--hover); }
  .trow.sel { background: var(--panel-2); box-shadow: inset 2px 0 0 var(--accent); }
  .trow .chev {
    width: 16px; height: 16px; flex: none; display: inline-grid; place-items: center;
    color: var(--faint); border-radius: 4px;
  }
  .trow .chev.has:hover { background: var(--border); color: var(--text); }
  .trow .chev svg { width: 11px; height: 11px; transition: transform .12s ease; }
  .trow.open .chev svg { transform: rotate(90deg); }
  .trow .sq { width: 9px; height: 9px; border-radius: 2px; flex: none; }
  .trow .nm { color: var(--text); }
  .trow .cls { color: var(--dim); font-family: var(--mono); font-size: 11.5px; }
  .trow .cc { color: var(--faint); font-size: 11px; font-variant-numeric: tabular-nums; }
  .tchildren { display: none; }
  .tnode.open > .tchildren { display: block; }
  .tnode-msg { padding: 4px 12px; font-size: 12px; }

  /* details */
  .exp-details { overflow: auto; max-height: 64vh; }
  .det-head { padding: 12px; border-bottom: 1px solid var(--border); }
  .det-head .nm { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .det-head .cls { color: var(--dim); font-family: var(--mono); font-size: 12px; margin-top: 4px; }
  .det-head .full { color: var(--faint); font-family: var(--mono); font-size: 11.5px; margin-top: 4px; word-break: break-all; }
  .subtabs { display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--border); }
  .subtabs button {
    appearance: none; background: none; border: none; cursor: pointer; font: inherit; font-size: 12px;
    color: var(--dim); padding: 9px 11px; border-bottom: 2px solid transparent; margin-bottom: -1px;
  }
  .subtabs button:hover { color: var(--text); }
  .subtabs button.active { color: var(--text); border-bottom-color: var(--accent); }
  .subtabs button .c { margin-left: 6px; font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }
  .subpanel { display: none; padding: 4px 0; }
  .subpanel.active { display: block; }

  .ptable { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .ptable td { padding: 5px 12px; border-bottom: 1px solid #1f1f1f; vertical-align: top; word-break: break-word; }
  .ptable tr:last-child td { border-bottom: none; }
  .ptable td.pk { color: var(--dim); width: 42%; }
  .ptable td.pv { font-family: var(--mono); font-size: 12px; color: var(--text); }
  .pv-string { color: #8fcf9e; }
  .pv-number, .pv-boolean { color: var(--accent); }
  .pv-Instance { color: #c79bff; }
  .pv-nil { color: var(--faint); }
  .sublabel {
    font-size: 11px; color: var(--faint); text-transform: uppercase; letter-spacing: .06em;
    padding: 12px 12px 6px;
  }

  .csig { border-bottom: 1px solid #1f1f1f; }
  .csig:last-child { border-bottom: none; }
  .csig-head {
    display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer;
  }
  .csig-head:hover { background: var(--hover); }
  .csig-head .chev { width: 14px; color: var(--faint); display: inline-grid; place-items: center; }
  .csig-head .chev svg { width: 11px; height: 11px; transition: transform .12s ease; }
  .csig.open .csig-head .chev svg { transform: rotate(90deg); }
  .csig-head .sname { font-family: var(--mono); font-size: 12.5px; color: var(--text); }
  .cbadge {
    margin-left: auto; padding: 1px 7px; border-radius: 4px; font-size: 11px;
    background: var(--panel-2); border: 1px solid var(--border); color: var(--dim);
    font-variant-numeric: tabular-nums;
  }
  .csig-body { display: none; padding: 2px 12px 8px 34px; }
  .csig.open .csig-body { display: block; }
  .conn { display: flex; align-items: center; gap: 10px; padding: 4px 0; font-size: 12px; flex-wrap: wrap; }
  .conn .loc { font-family: var(--mono); color: var(--faint); }
  .conn .fn { font-family: var(--mono); color: var(--dim); }
  .conn .en { font-size: 10px; }
  .conn .en.on { color: var(--ok); } .conn .en.off { color: var(--err); }

  .spin {
    width: 12px; height: 12px; border-radius: 50%; flex: none;
    border: 2px solid var(--border-2); border-top-color: var(--accent);
    display: inline-block; animation: spin .7s linear infinite; vertical-align: middle;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading { color: var(--dim); display: inline-flex; align-items: center; gap: 8px; padding: 12px; }
  .err-msg { color: var(--err); opacity: .85; padding: 12px; font-size: 12px; }

  @media (max-width: 720px) {
    .tools-layout { grid-template-columns: 1fr; }
    .exp-layout { grid-template-columns: 1fr; }
    .strip { overflow-x: auto; }
  }
</style>
</head>
<body>
<header>
  <span class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"><path d="M12 3 3 7.5 12 12l9-4.5L12 3Z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/></svg></span>
  <div class="brand">
    <div class="title">Roblox Executor MCP</div>
    <div class="sub">
      <span class="lbl" id="m-label">—</span>
      <span class="dotsep"></span>
      <span class="mono" id="m-version">v—</span>
      <span class="dotsep"></span>
      <span class="mono" id="m-addr">—</span>
    </div>
  </div>
  <div class="header-right">
    <div class="uptime-box"><span class="u-label">Uptime</span><span class="uptime" id="m-uptime">00:00:00</span></div>
    <span class="status" id="m-status"><i></i><span id="m-status-text">Connecting</span></span>
  </div>
</header>

<div class="strip" id="strip">
  <div class="cell"><div class="k">Tools</div><div class="v num" id="s-tools">–</div></div>
  <div class="cell"><div class="k">Categories</div><div class="v num" id="s-cats">–</div></div>
  <div class="cell"><div class="k">Connected</div><div class="v num" id="s-conn">–</div></div>
  <div class="cell"><div class="k">Tool calls</div><div class="v num" id="s-calls">–</div></div>
  <div class="cell"><div class="k">Errors</div><div class="v num" id="s-errs">–</div></div>
</div>

<nav class="tabs" id="tabs">
  <button data-tab="clients" class="active">Clients<span class="count" id="t-clients">0</span></button>
  <button data-tab="tools">Tools<span class="count" id="t-tools">0</span></button>
  <button data-tab="activity">Activity<span class="count" id="t-activity">0</span></button>
  <button data-tab="explorer">Explorer</button>
</nav>

<main>
  <section class="panel active" id="panel-clients"></section>

  <section class="panel" id="panel-tools">
    <div class="tools-layout">
      <aside class="cats" id="cats"></aside>
      <div>
        <input class="search" id="search" type="text" placeholder="Search tools by name, title or description…" autocomplete="off" />
        <div class="toolbar"><span class="sec" id="tools-cat-label">All tools</span><span class="count" id="tools-count"></span></div>
        <div class="tool-list" id="tool-list"></div>
      </div>
    </div>
  </section>

  <section class="panel" id="panel-activity"></section>

  <section class="panel" id="panel-explorer"></section>
</main>

<script>
(function () {
  "use strict";
  var byId = function (id) { return document.getElementById(id); };
  function esc(v) {
    if (v === null || v === undefined) return "";
    return String(v).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }
  function relTime(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 1) return "now";
    if (s < 60) return s + "s ago";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }
  function fmtUptime(ms) {
    var t = Math.floor(ms / 1000);
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(h) + ":" + p(m) + ":" + p(s);
  }
  // stable per-category accent color
  function catColor(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    var hues = [210, 160, 280, 330, 30, 190, 120, 350, 250, 90];
    return "hsl(" + hues[h % hues.length] + ", 55%, 62%)";
  }
  function catDot(name) {
    return '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + catColor(name) + ';margin-right:7px;vertical-align:middle"></span>';
  }
  window.avFail = function (img) {
    var s = document.createElement("span");
    s.className = "avatar";
    s.textContent = img.getAttribute("data-init") || "?";
    img.replaceWith(s);
  };

  var state = null, tools = [], pollFails = 0;
  var activeTab = "clients", activeCat = "__all", query = "";

  // ---- explorer state ----
  var exp = {
    clientId: null,     // selected client id (explore target)
    clientName: "",     // display name
    childCache: {},     // path -> children array (cache; busted by refresh)
    expanded: {},       // path -> true if expanded in the tree
    selPath: null,      // currently selected instance path
    selName: "game",    // selected node display name
    crumb: [],          // breadcrumb: array of { name, path }
    detTab: "properties",
    detPath: null,      // path whose details are currently shown
    properties: null,   // last properties payload
    connections: null,  // last connections payload
    propsLoading: false, propsErr: null,
    connLoading: false, connErr: null,
  };
  var SVG_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

  // ---- tabs ----
  var tabsEl = byId("tabs");
  function switchTab(tab) {
    activeTab = tab;
    var btns = tabsEl.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", btns[i].getAttribute("data-tab") === tab);
    var panels = document.querySelectorAll(".panel");
    for (var j = 0; j < panels.length; j++) panels[j].classList.toggle("active", panels[j].id === "panel-" + tab);
    if (tab === "explorer") renderExplorer();
  }
  tabsEl.addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    switchTab(b.getAttribute("data-tab"));
  });

  // ---- search ----
  byId("search").addEventListener("input", function (e) { query = e.target.value.toLowerCase(); renderTools(); });

  // ---- status / header / strip ----
  function setStatus(kind, text) {
    var el = byId("m-status");
    el.className = "status" + (kind === "off" ? " off" : "");
    byId("m-status-text").textContent = text;
  }
  function renderHeader() {
    if (!state) return;
    byId("m-label").textContent = state.server.label;
    byId("m-version").textContent = "v" + state.server.version;
    byId("m-addr").textContent = state.server.host + ":" + state.server.port;
    byId("s-tools").textContent = state.catalog.total;
    byId("s-cats").textContent = state.catalog.categories.length;
    byId("s-conn").textContent = state.clients.length;
    byId("s-calls").textContent = state.activity.total;
    byId("s-errs").textContent = state.activity.errors;
    byId("t-clients").textContent = state.clients.length;
    byId("t-activity").textContent = state.activity.total;
  }
  // local uptime ticker
  var uptimeBase = 0, uptimeAt = 0;
  function tickUptime() {
    if (uptimeAt) byId("m-uptime").textContent = fmtUptime(uptimeBase + (Date.now() - uptimeAt));
  }

  // ---- clients ----
  function renderClients() {
    var el = byId("panel-clients");
    if (!state) { el.innerHTML = ""; return; }
    if (!state.clients.length) {
      el.innerHTML = '<div class="table-wrap"><div class="empty"><div class="h">No clients connected</div>' +
        '<div class="s">Run the loader in your executor and the session will appear here.</div></div></div>';
      return;
    }
    var rows = state.clients.map(function (c) {
      var name = c.displayName || c.username || c.clientId;
      var initial = esc((name[0] || "?").toUpperCase());
      var av = c.userId
        ? '<img class="avatar" data-init="' + initial + '" src="https://www.roblox.com/headshot-thumbnail/image?userId=' + c.userId + '&width=150&height=150&format=png" onerror="avFail(this)" />'
        : '<span class="avatar">' + initial + "</span>";
      var go = '<span class="go">Explore' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></span>';
      return '<tr class="clickable" data-client="' + esc(c.clientId) + '" data-name="' + esc(name) +
        '">' + "<td><div class=\\"who\\">" + av + "<div><div class=\\"nm\\">" + esc(name) +
        '</div><div class="id">' + esc(c.username || "") + (c.userId ? " · " + c.userId : "") + "</div></div></div></td>" +
        '<td><span class="chip">' + esc(c.executor || "unknown") + "</span></td>" +
        '<td class="mono num muted">' + (c.placeId || "—") + "</td>" +
        '<td class="num muted">' + c.capabilities + "</td>" +
        '<td class="faint" data-at="' + c.connectedAt + '">' + relTime(c.connectedAt) + "</td>" +
        '<td class="go-cell">' + go + "</td></tr>";
    });
    el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Account</th><th>Executor</th>' +
      "<th>Place</th><th>Caps</th><th>Connected</th><th></th></tr></thead><tbody>" + rows.join("") + "</tbody></table></div>";
    el.querySelector("tbody").onclick = function (e) {
      var tr = e.target.closest("tr.clickable");
      if (!tr) return;
      selectExploreClient(tr.getAttribute("data-client"), tr.getAttribute("data-name"));
    };
  }

  // ---- activity ----
  function renderActivity() {
    var el = byId("panel-activity");
    if (!state) { el.innerHTML = ""; return; }
    var a = state.activity.recent;
    if (!a.length) {
      el.innerHTML = '<div class="table-wrap"><div class="empty"><div class="h">No activity yet</div>' +
        '<div class="s">Tool calls will appear here as they happen.</div></div></div>';
      return;
    }
    var rows = a.map(function (r) {
      var res = r.outcome === "ok"
        ? '<span class="res ok"><i></i>ok</span>'
        : '<span class="res error"><i></i>' + esc(r.errorCode || "error") + "</span>";
      return '<tr><td class="faint num" data-at="' + r.at + '">' + relTime(r.at) + "</td>" +
        '<td class="mono">' + esc(r.toolName) + "</td>" +
        "<td>" + catDot(r.category) + '<span class="muted">' + esc(r.category) + "</span></td>" +
        "<td>" + res + "</td>" +
        '<td class="num muted">' + r.durationMs + " ms</td>" +
        '<td class="muted">' + esc(r.clientName || "—") + "</td></tr>";
    });
    el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Time</th><th>Tool</th><th>Category</th>' +
      "<th>Result</th><th>Duration</th><th>Client</th></tr></thead><tbody>" + rows.join("") + "</tbody></table></div>";
  }

  // ---- tools ----
  function renderCats() {
    if (!state) return;
    var cats = state.catalog.categories;
    var html = ['<button data-cat="__all" class="' + (activeCat === "__all" ? "active" : "") +
      '"><span>All tools</span><span class="c">' + state.catalog.total + "</span></button>"];
    for (var i = 0; i < cats.length; i++) {
      var c = cats[i];
      html.push('<button data-cat="' + esc(c.category) + '" class="' + (activeCat === c.category ? "active" : "") +
        '"><span>' + catDot(c.category) + esc(c.category) + '</span><span class="c">' + c.count + "</span></button>");
    }
    var el = byId("cats");
    el.innerHTML = html.join("");
    el.onclick = function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      activeCat = b.getAttribute("data-cat");
      renderCats();
      renderTools();
    };
  }
  function renderTools() {
    var el = byId("tool-list");
    var list = tools.filter(function (t) {
      if (activeCat !== "__all" && t.category !== activeCat) return false;
      if (!query) return true;
      return (t.name + " " + t.title + " " + t.description).toLowerCase().indexOf(query) !== -1;
    });
    byId("tools-cat-label").textContent = activeCat === "__all" ? "All tools" : activeCat;
    byId("tools-count").textContent = list.length + " of " + tools.length;
    byId("t-tools").textContent = tools.length;
    if (!list.length) {
      el.innerHTML = '<div class="empty"><div class="h">No tools match</div></div>';
      return;
    }
    var rows = list.map(function (t) {
      var badges = (t.mutatesState ? '<span class="badge write">writes</span>' : '<span class="badge read">read-only</span>') +
        (t.requiresClient ? "" : ' <span class="badge client">no client</span>');
      return '<div class="tool"><div class="body"><div class="top">' +
        '<span class="name">' + esc(t.name) + "</span>" +
        '<span class="chip">' + catDot(t.category) + esc(t.category) + "</span></div>" +
        '<div class="ttl">' + esc(t.title) + "</div>" +
        '<div class="desc">' + esc(t.description) + "</div></div>" +
        '<div class="tags">' + badges + "</div></div>";
    });
    el.innerHTML = rows.join("");
  }

  // ---- explorer ----
  function clientConnected(id) {
    if (!state || !id) return false;
    for (var i = 0; i < state.clients.length; i++) if (state.clients[i].clientId === id) return true;
    return false;
  }
  function expQuery(path) {
    return "client=" + encodeURIComponent(exp.clientId) + "&path=" + encodeURIComponent(path);
  }
  function classSquare(cls) {
    return '<span class="sq" style="background:' + catColor(cls || "?") + '"></span>';
  }

  function selectExploreClient(id, name) {
    exp.clientId = id;
    exp.clientName = name || id;
    exp.childCache = {};
    exp.expanded = { game: true };
    exp.selPath = "game";
    exp.selName = "game";
    exp.crumb = [{ name: "game", path: "game" }];
    exp.detPath = null;
    exp.properties = null; exp.connections = null;
    exp.propsErr = null; exp.connErr = null;
    exp.detTab = "properties";
    switchTab("explorer");
    loadChildren("game");
    loadDetails("game", "game");
  }

  // fetch children of a path (cached). cb() re-renders the tree when ready.
  function loadChildren(path) {
    if (exp.childCache[path]) return Promise.resolve(exp.childCache[path]);
    var clientAtFetch = exp.clientId;
    return fetch("/api/explore/children?" + expQuery(path))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (clientAtFetch !== exp.clientId) return null;
        if (data && data.error) { exp.childCache[path] = { error: data.error }; }
        else { exp.childCache[path] = { children: (data && data.children) || [], truncated: !!(data && data.truncated) }; }
        if (activeTab === "explorer") renderTree();
        return exp.childCache[path];
      })
      .catch(function () {
        exp.childCache[path] = { error: "Request failed." };
        if (activeTab === "explorer") renderTree();
        return exp.childCache[path];
      });
  }

  function loadDetails(path, name) {
    exp.selPath = path; exp.selName = name;
    exp.detPath = path;
    exp.properties = null; exp.connections = null;
    exp.propsErr = null; exp.connErr = null;
    exp.propsLoading = true; exp.connLoading = false;
    var clientAtFetch = exp.clientId;
    renderTree();    // reflect the new selection highlight without rebuilding the shell
    renderDetails(); // show loading state in the details panel

    fetch("/api/explore/properties?" + expQuery(path))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (clientAtFetch !== exp.clientId || exp.detPath !== path) return;
        exp.propsLoading = false;
        if (data && data.error) exp.propsErr = data.error; else exp.properties = data;
        renderDetails();
      })
      .catch(function () {
        if (clientAtFetch !== exp.clientId || exp.detPath !== path) return;
        exp.propsLoading = false; exp.propsErr = "Request failed."; renderDetails();
      });

    exp.connLoading = true;
    fetch("/api/explore/connections?" + expQuery(path))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (clientAtFetch !== exp.clientId || exp.detPath !== path) return;
        exp.connLoading = false;
        if (data && data.error) exp.connErr = data.error; else exp.connections = data;
        renderDetails();
      })
      .catch(function () {
        if (clientAtFetch !== exp.clientId || exp.detPath !== path) return;
        exp.connLoading = false; exp.connErr = "Request failed."; renderDetails();
      });
  }

  // build one tree node (and its loaded children) recursively
  function treeNodeHtml(node, depth) {
    var path = node.path;
    var isOpen = !!exp.expanded[path];
    var isSel = exp.selPath === path;
    var pad = 12 + depth * 16;
    var has = node.hasChildren;
    var chev = has ? '<span class="chev has" data-act="toggle">' + SVG_CHEV + "</span>"
                   : '<span class="chev"></span>';
    var cc = node.childCount ? '<span class="cc">' + node.childCount + "</span>" : "";
    var row = '<div class="trow' + (isOpen ? " open" : "") + (isSel ? " sel" : "") +
      '" data-path="' + esc(path) + '" data-name="' + esc(node.name) +
      '" style="padding-left:' + pad + 'px">' +
      chev + classSquare(node.class) +
      '<span class="nm">' + esc(node.name) + "</span>" +
      '<span class="cls">' + esc(node.class) + "</span>" + cc + "</div>";

    var childrenHtml = "";
    if (isOpen) {
      var cached = exp.childCache[path];
      if (!cached) {
        childrenHtml = '<div class="tnode-msg loading"><span class="spin"></span>Loading…</div>';
      } else if (cached.error) {
        childrenHtml = '<div class="tnode-msg err-msg">' + esc(cached.error) + "</div>";
      } else if (!cached.children.length) {
        childrenHtml = '<div class="tnode-msg faint">No children</div>';
      } else {
        var parts = [];
        for (var i = 0; i < cached.children.length; i++) parts.push(treeNodeHtml(cached.children[i], depth + 1));
        if (cached.truncated) parts.push('<div class="tnode-msg faint">…list truncated</div>');
        childrenHtml = parts.join("");
      }
    }
    return '<div class="tnode' + (isOpen ? " open" : "") + '"><div>' + row + "</div>" +
      '<div class="tchildren">' + childrenHtml + "</div></div>";
  }

  function renderTree() {
    var host = byId("exp-tree");
    if (!host) return;
    var root = { name: "game", class: "DataModel", path: "game", childCount: 0, hasChildren: true };
    host.innerHTML = treeNodeHtml(root, 0);
  }

  function valClass(type) {
    if (type === "string") return "pv-string";
    if (type === "number" || type === "boolean") return "pv-" + type;
    if (type === "Instance") return "pv-Instance";
    if (type === "nil") return "pv-nil";
    return "";
  }
  function propRows(list) {
    if (!list || !list.length) return null;
    var rows = list.map(function (p) {
      var v = (p.value === null || p.value === undefined) ? "" : String(p.value);
      return "<tr><td class=\\"pk\\">" + esc(p.name) + '</td><td class="pv ' + valClass(p.type) + '">' +
        esc(v) + "</td></tr>";
    });
    return '<table class="ptable"><tbody>' + rows.join("") + "</tbody></table>";
  }

  function renderProperties() {
    if (exp.propsLoading) return '<div class="loading"><span class="spin"></span>Loading properties…</div>';
    if (exp.propsErr) return '<div class="err-msg">' + esc(exp.propsErr) + "</div>";
    var d = exp.properties;
    if (!d) return '<div class="empty"><div class="s">No data.</div></div>';
    var out = [];
    var pr = propRows(d.properties);
    out.push(pr || '<div class="empty"><div class="s">No properties available.</div></div>');
    if (d.attributes && d.attributes.length) {
      out.push('<div class="sublabel">Attributes</div>');
      out.push(propRows(d.attributes));
    }
    return out.join("");
  }

  function renderConnections() {
    if (exp.connLoading) return '<div class="loading"><span class="spin"></span>Loading connections…</div>';
    if (exp.connErr) return '<div class="err-msg">' + esc(exp.connErr) + "</div>";
    var d = exp.connections;
    if (!d) return '<div class="empty"><div class="s">No data.</div></div>';
    var sigs = d.signals || [];
    if (!sigs.length) return '<div class="empty"><div class="s">No connected signals found.</div></div>';
    var out = [];
    for (var i = 0; i < sigs.length; i++) {
      var s = sigs[i];
      var conns = s.connections || [];
      var open = i === 0;
      var body = [];
      for (var j = 0; j < conns.length; j++) {
        var cn = conns[j];
        var loc = "";
        if (cn.source) loc = cn.source + (cn.line ? ":" + cn.line : "");
        var en = (cn.enabled === false) ? '<span class="en off">disabled</span>'
               : (cn.enabled === true) ? '<span class="en on">enabled</span>' : "";
        body.push('<div class="conn">' +
          (loc ? '<span class="loc">' + esc(loc) + "</span>" : '<span class="loc faint">unknown source</span>') +
          (cn.name ? '<span class="fn">fn ' + esc(cn.name) + "</span>" : "") +
          en + "</div>");
      }
      if (conns.length < s.count) body.push('<div class="conn faint">…and ' + (s.count - conns.length) + " more</div>");
      out.push('<div class="csig' + (open ? " open" : "") + '" data-sig="' + i + '">' +
        '<div class="csig-head"><span class="chev">' + SVG_CHEV + "</span>" +
        '<span class="sname">' + esc(s.name) + "</span>" +
        '<span class="cbadge">' + s.count + "</span></div>" +
        '<div class="csig-body">' + body.join("") + "</div></div>");
    }
    return out.join("");
  }

  function renderDetails() {
    var host = byId("exp-det-body");
    if (!host) return;
    var d = exp.properties;
    var nm = exp.selName;
    var cls = (d && d.class) || "";
    var full = (d && d.fullName) || exp.selPath || "";
    var propCount = (d && d.properties) ? d.properties.length : "";
    var connCount = (exp.connections && exp.connections.signals) ? exp.connections.signals.length : "";
    var head = '<div class="det-head"><div class="nm">' +
      (cls ? classSquare(cls) : "") + esc(nm) + "</div>" +
      (cls ? '<div class="cls">' + esc(cls) + "</div>" : "") +
      '<div class="full">' + esc(full) + "</div></div>";
    var subtabs = '<div class="subtabs">' +
      '<button data-sub="properties" class="' + (exp.detTab === "properties" ? "active" : "") +
        '">Properties<span class="c">' + propCount + "</span></button>" +
      '<button data-sub="connections" class="' + (exp.detTab === "connections" ? "active" : "") +
        '">Connections<span class="c">' + connCount + "</span></button></div>";
    var panels =
      '<div class="subpanel' + (exp.detTab === "properties" ? " active" : "") + '" id="sub-properties">' + renderProperties() + "</div>" +
      '<div class="subpanel' + (exp.detTab === "connections" ? " active" : "") + '" id="sub-connections">' + renderConnections() + "</div>";
    host.innerHTML = head + subtabs + panels;
  }

  function renderCrumb() {
    var parts = [];
    for (var i = 0; i < exp.crumb.length; i++) {
      var c = exp.crumb[i];
      var cur = i === exp.crumb.length - 1;
      if (i) parts.push('<span class="sep">›</span>');
      parts.push('<span class="seg' + (cur ? " cur" : "") + '" data-path="' + esc(c.path) +
        '" data-name="' + esc(c.name) + '">' + esc(c.name) + "</span>");
    }
    return parts.join("");
  }

  function renderExplorer() {
    var el = byId("panel-explorer");
    if (!el) return;
    if (!exp.clientId) {
      el.innerHTML = '<div class="table-wrap"><div class="empty"><div class="h">No client selected</div>' +
        '<div class="s">Select a client from the Clients tab to explore its game tree.</div></div></div>';
      return;
    }
    if (!clientConnected(exp.clientId)) {
      el.innerHTML = '<div class="table-wrap"><div class="empty"><div class="h">Client disconnected</div>' +
        '<div class="s">' + esc(exp.clientName) + " is no longer connected. Pick another client from the Clients tab.</div></div></div>";
      exp.clientId = null;
      return;
    }
    el.innerHTML =
      '<div class="exp-toolbar">' +
        '<span class="client"><span class="dot"></span>' + esc(exp.clientName) + "</span>" +
        '<span class="exp-crumb" id="exp-crumb">' + renderCrumb() + "</span>" +
        '<span class="right"><button class="btn" id="exp-refresh" title="Reload this node">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>Refresh</button></span>' +
      "</div>" +
      '<div class="exp-layout">' +
        '<div class="exp-col"><div class="col-head">Tree</div><div class="exp-tree" id="exp-tree"></div></div>' +
        '<div class="exp-col"><div class="col-head">Details</div><div class="exp-details" id="exp-det-body"></div></div>' +
      "</div>";

    renderTree();
    renderDetails();
    wireExplorer();
  }

  function wireExplorer() {
    var tree = byId("exp-tree");
    if (tree) tree.onclick = function (e) {
      var row = e.target.closest(".trow");
      if (!row) return;
      var path = row.getAttribute("data-path");
      var name = row.getAttribute("data-name");
      if (e.target.closest('[data-act="toggle"]')) {
        if (exp.expanded[path]) { delete exp.expanded[path]; }
        else { exp.expanded[path] = true; if (!exp.childCache[path]) loadChildren(path); }
        renderTree();
        return;
      }
      // select node -> rebuild breadcrumb from the DOM ancestry path
      exp.crumb = crumbFor(path, name);
      var c = byId("exp-crumb"); if (c) c.innerHTML = renderCrumb();
      loadDetails(path, name);
    };

    var det = byId("exp-det-body");
    if (det) det.onclick = function (e) {
      var sub = e.target.closest(".subtabs button");
      if (sub) { exp.detTab = sub.getAttribute("data-sub"); renderDetails(); return; }
      var sig = e.target.closest(".csig-head");
      if (sig) { sig.parentNode.classList.toggle("open"); return; }
    };

    var crumb = byId("exp-crumb");
    if (crumb) crumb.onclick = function (e) {
      var seg = e.target.closest(".seg");
      if (!seg || seg.classList.contains("cur")) return;
      var path = seg.getAttribute("data-path");
      var name = seg.getAttribute("data-name");
      exp.crumb = crumbFor(path, name);
      crumb.innerHTML = renderCrumb();
      if (!exp.expanded[path]) { exp.expanded[path] = true; if (!exp.childCache[path]) loadChildren(path); renderTree(); }
      loadDetails(path, name);
    };

    var refresh = byId("exp-refresh");
    if (refresh) refresh.onclick = function () {
      var p = exp.selPath || "game";
      delete exp.childCache[p];
      loadChildren(p);
      loadDetails(p, exp.selName);
    };
  }

  // reconstruct the breadcrumb by walking the cached tree from the root.
  function crumbFor(path, name) {
    var trail = findTrail("game", path);
    if (trail) return trail;
    return [{ name: "game", path: "game" }, { name: name, path: path }];
  }
  function findTrail(curPath, target) {
    var curName = curPath === "game" ? "game" : null;
    return walk(curPath, curName, target, []);
  }
  function walk(path, name, target, acc) {
    var here = acc.concat([{ name: name || path, path: path }]);
    if (path === target) return here;
    var cached = exp.childCache[path];
    if (!cached || cached.error || !cached.children) return null;
    for (var i = 0; i < cached.children.length; i++) {
      var ch = cached.children[i];
      var r = walk(ch.path, ch.name, target, here);
      if (r) return r;
    }
    return null;
  }

  function renderAll() {
    renderHeader();
    renderClients();
    renderActivity();
    renderCats();
    renderTools();
    if (activeTab === "explorer") {
      // keep the explorer's connected/disconnected notice fresh on each poll,
      // but don't clobber an in-progress browse — only re-render the shell when
      // the selected client just disconnected.
      if (exp.clientId && !clientConnected(exp.clientId)) renderExplorer();
    }
  }

  // refresh relative times in place
  setInterval(function () {
    var nodes = document.querySelectorAll("[data-at]");
    for (var i = 0; i < nodes.length; i++) {
      var ts = parseInt(nodes[i].getAttribute("data-at"), 10);
      if (ts) nodes[i].textContent = relTime(ts);
    }
  }, 5000);
  setInterval(tickUptime, 1000);

  function pollState() {
    fetch("/api/state").then(function (r) { return r.json(); }).then(function (data) {
      state = data; pollFails = 0;
      uptimeBase = data.server.uptimeMs; uptimeAt = Date.now();
      setStatus("on", "Live");
      renderAll();
      tickUptime();
    }).catch(function () {
      pollFails++;
      if (pollFails >= 2) setStatus("off", "Reconnecting");
    });
  }
  function loadTools() {
    fetch("/api/tools").then(function (r) { return r.json(); }).then(function (data) {
      tools = data; renderTools();
    }).catch(function () {});
  }

  loadTools();
  pollState();
  setInterval(pollState, 2000);
  setInterval(loadTools, 30000);
})();
</script>
</body>
</html>`;
}
