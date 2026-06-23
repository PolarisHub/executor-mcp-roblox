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

  /* place / job cell: stacked PlaceId + truncated JobId chip */
  td.place-cell { vertical-align: middle; }
  td.place-cell .mono.num { color: var(--dim); }
  td.place-cell .jobid {
    margin-top: 2px;
    font-size: 11px;
    color: var(--faint);
    cursor: pointer;
    display: inline-flex; align-items: center;
    padding: 1px 6px; border-radius: 4px;
    border: 1px solid transparent;
    transition: color .12s ease, border-color .12s ease, background-color .12s ease;
  }
  td.place-cell .jobid:hover {
    color: var(--dim); background: var(--panel-2); border-color: var(--border);
  }
  td.place-cell .jobid.copied { color: var(--ok); border-color: rgba(94,194,110,0.3); }

  /* ---- disconnect button ---- */
  td.kill-cell { width: 36px; padding-right: 14px; padding-left: 4px; text-align: right; }
  .kill {
    appearance: none; cursor: pointer; padding: 6px; border-radius: 6px;
    background: transparent; border: 1px solid transparent; color: var(--faint);
    display: inline-flex; align-items: center; justify-content: center;
    opacity: 0; transition: opacity .12s ease, color .12s ease,
      background-color .12s ease, border-color .12s ease;
  }
  tr.clickable:hover .kill { opacity: 0.85; }
  .kill:hover {
    opacity: 1; color: var(--err);
    background: rgba(226, 92, 84, 0.10); border-color: rgba(226, 92, 84, 0.32);
  }
  .kill:focus-visible {
    outline: none; opacity: 1;
    border-color: rgba(226, 92, 84, 0.5); color: var(--err);
  }
  .kill svg { width: 14px; height: 14px; }
  .kill.confirm {
    opacity: 1; color: #fff; padding: 4px 9px 4px 7px; gap: 5px;
    background: var(--err); border-color: var(--err);
    font: inherit; font-size: 11.5px; font-weight: 500; letter-spacing: 0.01em;
  }
  .kill.confirm:hover { background: #d04a42; border-color: #d04a42; }
  .kill.busy { opacity: 0.5; cursor: default; pointer-events: none; }

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
  .cicon {
    width: 16px; height: 16px; flex: none;
    display: inline-block; vertical-align: middle;
    background-image: url("/assets/class-icons.png");
    background-repeat: no-repeat; image-rendering: pixelated;
  }
  .trow .nm { color: var(--text); }
  .trow .cls { color: var(--dim); font-family: var(--mono); font-size: 11.5px; }
  .trow .cc { color: var(--faint); font-size: 11px; font-variant-numeric: tabular-nums; }
  .tchildren { display: none; }
  .tnode.open > .tchildren { display: block; }
  .tnode-msg { padding: 4px 12px; font-size: 12px; }
  .tnode-more {
    padding: 4px 12px; font-size: 12px; color: var(--accent); cursor: pointer;
    border-top: 1px dashed #232323; user-select: none;
  }
  .tnode-more:hover { background: var(--hover); color: var(--text); }
  .tnode-more.busy { color: var(--faint); cursor: default; }

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

  /* ---- output console ---- */
  /* ---- brief tab ---- */
  .brief-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 14px; margin-bottom: 18px;
  }
  .brief-card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px 14px;
  }
  .brief-h {
    font-size: 11px; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em;
    margin-bottom: 8px;
  }
  .brief-row { display: flex; align-items: baseline; gap: 12px; padding: 4px 0; font-size: 12.5px; }
  .brief-k { color: var(--dim); flex: none; min-width: 140px; }
  .brief-v { color: var(--text); }
  .brief-v .copy { cursor: pointer; border-bottom: 1px dashed transparent; }
  .brief-v .copy:hover { border-bottom-color: var(--accent); color: var(--accent); }
  .brief-section { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
  .brief-section-head { display: flex; align-items: center; margin-bottom: 10px; }
  .brief-section-head .sec { margin: 0; flex: 1; }
  .rchip {
    display: inline-block; padding: 1px 6px; margin: 0 3px 3px 0;
    border: 1px solid var(--border); border-radius: 3px;
    background: var(--panel-2); color: var(--dim); font-size: 10.5px;
  }

  /* ---- playbooks tab ---- */
  .pb-layout {
    display: grid; grid-template-columns: 260px 1fr; gap: 16px; align-items: start;
  }
  .pb-list {
    border: 1px solid var(--border); border-radius: 8px; background: var(--panel);
    max-height: 70vh; overflow: hidden; display: flex; flex-direction: column;
  }
  .pb-list-head {
    display: flex; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--border);
  }
  .pb-list-head .sec { margin: 0; flex: 1; }
  .pb-items { overflow-y: auto; }
  .pb-item {
    padding: 10px 12px; border-bottom: 1px solid #1f1f1f; cursor: pointer;
  }
  .pb-item:hover { background: var(--hover); }
  .pb-item.active { background: var(--panel-2); box-shadow: inset 2px 0 0 var(--accent); }
  .pb-item .nm { font-weight: 500; color: var(--text); }
  .pb-item .dsc { color: var(--faint); font-size: 11.5px; margin-top: 2px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pb-item .ts { color: var(--faint); font-size: 10.5px; margin-top: 2px; }
  .pb-tags { display: flex; gap: 3px; flex-wrap: wrap; margin-top: 4px; }
  .pb-tags .chip { font-size: 10px; padding: 1px 5px; }

  .pb-pane {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px;
    min-height: 60vh; display: flex; flex-direction: column;
  }
  .pb-pane .pb-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .pb-pane .pb-meta input.search { flex: 1; margin: 0; min-width: 120px; }
  .pb-pane .label { font-size: 11px; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
  .pb-pane .src {
    width: 100%; min-height: 220px; flex: 1; resize: vertical;
    background: #101012; border: 1px solid var(--border); border-radius: 8px;
    color: var(--text); font-family: var(--mono); font-size: 12.5px; padding: 10px 12px; outline: none;
  }
  .pb-pane .src:focus { border-color: var(--border-2); }
  .pb-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .pb-actions .danger { color: var(--err); border-color: rgba(226,92,84,0.3); }
  .pb-actions .danger:hover { background: rgba(226,92,84,0.08); }
  .pb-actions .primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .pb-actions .primary:hover { background: #5a8cf7; }
  .pb-params { display: grid; grid-template-columns: 120px 1fr; gap: 6px 10px; margin: 10px 0; }
  .pb-params .pname { color: var(--dim); align-self: center; font-family: var(--mono); font-size: 12px; }
  .pb-params input.search { margin: 0; }
  .pb-runres {
    margin-top: 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--panel-2); font-family: var(--mono); font-size: 12px;
    color: var(--dim); white-space: pre-wrap; max-height: 320px; overflow: auto;
  }
  .pb-runres.err { border-color: rgba(226,92,84,0.35); color: var(--err); }

  /* ---- repl tab ---- */
  .repl-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
  .repl-bar .sec { margin: 0; }
  .repl-bar #repl-client { font-size: 12px; }
  .repl-bar #repl-hint { font-size: 11px; color: var(--faint); }
  .repl-bar kbd {
    font-family: var(--mono); font-size: 10.5px; padding: 0 4px;
    border: 1px solid var(--border); border-radius: 3px; background: var(--panel-2); color: var(--dim);
  }
  .repl-editor-wrap { position: relative; }
  .repl-src {
    width: 100%; min-height: 220px; max-height: 50vh; resize: vertical;
    background: #101012; border: 1px solid var(--border); border-radius: 8px;
    color: var(--text); font-family: var(--mono); font-size: 13px; padding: 10px 12px; outline: none;
    line-height: 1.55;
  }
  .repl-src:focus { border-color: var(--border-2); }
  .repl-ac {
    position: absolute; min-width: 220px; max-height: 240px; overflow-y: auto;
    background: var(--panel); border: 1px solid var(--border-2); border-radius: 7px;
    box-shadow: 0 8px 20px rgba(0,0,0,0.4); display: none; z-index: 50;
  }
  .repl-ac.show { display: block; }
  .repl-ac-item {
    padding: 6px 12px; cursor: pointer; font-family: var(--mono); font-size: 12px; color: var(--dim);
    display: flex; align-items: center; gap: 10px;
  }
  .repl-ac-item:hover, .repl-ac-item.active { background: var(--panel-2); color: var(--text); }
  .repl-ac-item .at { color: var(--accent); }
  .repl-ac-item .desc { margin-left: auto; color: var(--faint); font-family: var(--font); font-size: 11px; max-width: 280px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; }
  #repl-result {
    margin-top: 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--panel-2); font-family: var(--mono); font-size: 12px; color: var(--dim);
    white-space: pre-wrap; max-height: 320px; overflow: auto; display: none;
  }
  #repl-result.show { display: block; }
  #repl-result.err { border-color: rgba(226,92,84,0.35); color: var(--err); }

  /* ---- spy tab ---- */
  .spy-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
  .spy-bar .search { flex: 1; margin-bottom: 0; }
  .spy-row .smethod { display: inline-block; padding: 0 6px; border-radius: 3px; font-size: 10.5px; }
  .spy-row .smethod.fire { background: rgba(94,194,110,0.10); color: var(--ok); border: 1px solid rgba(94,194,110,0.3); }
  .spy-row .smethod.invoke { background: rgba(107,155,255,0.10); color: var(--accent); border: 1px solid rgba(107,155,255,0.35); }
  .spy-row .smethod.blocked { background: rgba(226,92,84,0.10); color: var(--err); border: 1px solid rgba(226,92,84,0.35); }
  .spy-row .spath { font-family: var(--mono); font-size: 12px; }
  .spy-row .sargs { font-family: var(--mono); font-size: 11.5px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 480px; display: inline-block; vertical-align: middle; }
  .spy-row .scopy {
    background: none; border: 1px solid transparent; padding: 3px 7px; border-radius: 4px;
    color: var(--faint); font: inherit; font-size: 11px; cursor: pointer; opacity: 0;
    transition: opacity .12s ease, color .12s ease, border-color .12s ease;
  }
  .spy-row:hover .scopy { opacity: 1; }
  .spy-row .scopy:hover { color: var(--accent); border-color: rgba(107,155,255,0.35); }
  .spy-row .scopy.copied { color: var(--ok); border-color: rgba(94,194,110,0.4); }

  .out-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
  .out-filter { flex: 1; margin-bottom: 0; }
  .out-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dim); white-space: nowrap; cursor: pointer; }
  .out-toggle input { accent-color: var(--accent); }
  .out-legend { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--faint); white-space: nowrap; }
  .out-legend i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; margin-left: 8px; }
  .out-legend i.ok { background: var(--text); } .out-legend i.info { background: var(--accent); }
  .out-legend i.warn { background: var(--warn); } .out-legend i.err { background: var(--err); }
  .out-btn {
    appearance: none; background: var(--panel-2); border: 1px solid var(--border); color: var(--dim);
    font: inherit; font-size: 12px; padding: 6px 11px; border-radius: 7px; cursor: pointer; white-space: nowrap;
  }
  .out-btn:hover { background: var(--hover); color: var(--text); border-color: var(--border-2); }
  .console {
    height: calc(100vh - 230px); min-height: 280px; overflow-y: auto;
    background: #101012; border: 1px solid var(--border); border-radius: 8px; padding: 8px 0;
    font-family: var(--mono); font-size: 12.5px; line-height: 1.55;
  }
  .oline { display: flex; gap: 10px; padding: 1px 14px; white-space: pre-wrap; word-break: break-word; }
  .oline:hover { background: rgba(255,255,255,.02); }
  .oline .ot { color: var(--faint); flex: none; font-variant-numeric: tabular-nums; }
  .oline .oc { flex: none; width: 4px; border-radius: 2px; background: #333; }
  .oline .om { color: #cfd2d6; min-width: 0; }
  .oline.k-warn .om { color: var(--warn); } .oline.k-warn .oc { background: var(--warn); }
  .oline.k-error .om { color: #ff8a82; } .oline.k-error .oc { background: var(--err); }
  .oline.k-info .om { color: var(--accent); } .oline.k-info .oc { background: var(--accent); }
  .oline.k-system .om { color: var(--accent-2, #57e6c9); } .oline.k-system .oc { background: var(--ok); }
  .oline .oclient { color: var(--faint); flex: none; }
  .oline .osrc {
    flex: none; font-size: 10px; padding: 0 5px; border-radius: 3px;
    border: 1px solid var(--border); color: var(--faint); align-self: center;
  }
  .oline .osrc.src-script {
    color: var(--accent); border-color: rgba(107,155,255,0.4); background: rgba(107,155,255,0.07);
  }

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
  <button data-tab="brief">Brief</button>
  <button data-tab="spy">Spy<span class="count" id="t-spy">0</span></button>
  <button data-tab="playbooks">Playbooks<span class="count" id="t-playbooks">0</span></button>
  <button data-tab="repl">REPL</button>
  <button data-tab="output">Output<span class="count" id="t-output">0</span></button>
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

  <section class="panel" id="panel-brief"></section>

  <section class="panel" id="panel-playbooks">
    <div class="pb-layout">
      <aside class="pb-list">
        <div class="pb-list-head">
          <span class="sec">Playbooks</span>
          <button class="out-btn" id="pb-new" title="New playbook">+ New</button>
        </div>
        <div class="pb-items" id="pb-items"></div>
      </aside>
      <div class="pb-pane" id="pb-pane"></div>
    </div>
  </section>

  <section class="panel" id="panel-repl">
    <div class="repl-bar">
      <span class="sec">REPL</span>
      <span class="muted" id="repl-client">No client selected</span>
      <span class="count" id="repl-hint" style="margin-left:auto">type <kbd>mcp.</kbd> for autocomplete · <kbd>Ctrl+Enter</kbd> to run</span>
      <button class="out-btn primary" id="repl-run">Run on selected client</button>
      <button class="out-btn" id="repl-clear">Clear</button>
    </div>
    <div class="repl-editor-wrap">
      <textarea class="src repl-src" id="repl-src" spellcheck="false" placeholder="-- Luau, with mcp.* available
local p = mcp.getPlayers()
print(#p .. ' players')
return p"></textarea>
      <div class="repl-ac" id="repl-ac"></div>
    </div>
    <div id="repl-result"></div>
  </section>

  <section class="panel" id="panel-spy">
    <div class="spy-bar">
      <input class="search" id="spy-filter" type="text" placeholder="Filter by remote / method / args…" autocomplete="off" />
      <label class="out-toggle"><input type="checkbox" id="spy-autoref" checked /> Auto-refresh</label>
      <span class="count" id="spy-count"></span>
      <button class="out-btn" id="spy-refresh">Refresh</button>
      <button class="out-btn" id="spy-clear">Clear buffer</button>
    </div>
    <div id="spy-body"></div>
  </section>

  <section class="panel" id="panel-output">
    <div class="out-bar">
      <input class="search out-filter" id="out-filter" type="text" placeholder="Filter output…" autocomplete="off" />
      <select class="out-btn" id="out-scope" title="Scope">
        <option value="all">All output</option>
        <option value="game">Game only</option>
        <option value="script">Scripts only</option>
        <option value="recent-script">Most recent script</option>
      </select>
      <label class="out-toggle"><input type="checkbox" id="out-autoscroll" checked /> Auto-scroll</label>
      <span class="out-legend">
        <i class="ok"></i>print <i class="info"></i>info <i class="warn"></i>warn <i class="err"></i>error
      </span>
      <span class="count" id="out-count"></span>
      <button class="out-btn" id="out-clear">Clear</button>
    </div>
    <div class="console" id="console"></div>
  </section>
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

  var state = null, tools = [], pollFails = 0, iconMap = {};
  var outData = [], outFilter = "", outAutoscroll = true, outClearedAt = 0, outScope = "all";
  // Live activity log: WS-pushed records prepend here; state polls merge in
  // anything older we don't have yet. renderActivity reads from this.
  var liveActivity = [], liveActivityTotal = 0, liveActivityErrors = 0;
  function activityKey(r) { return r.at + ":" + r.toolName + ":" + (r.sessionId || ""); }
  function ingestActivityRecord(r, prepend) {
    if (!r || !r.toolName) return;
    var key = activityKey(r);
    for (var i = 0; i < liveActivity.length; i++) {
      if (activityKey(liveActivity[i]) === key) return;
    }
    if (prepend) liveActivity.unshift(r); else liveActivity.push(r);
    if (liveActivity.length > 200) liveActivity.length = 200;
  }
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
    if (tab === "output") renderOutput();
    if (tab === "brief") renderBrief();
    if (tab === "spy") renderSpy();
    if (tab === "playbooks") renderPlaybooks();
    if (tab === "repl") renderRepl();
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
      var kill = '<button class="kill" title="Disconnect this session" aria-label="Disconnect">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
        '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
        '<path d="M10 11v6"/><path d="M14 11v6"/></svg></button>';
      return '<tr class="clickable" data-client="' + esc(c.clientId) + '" data-name="' + esc(name) +
        '">' + "<td><div class=\\"who\\">" + av + "<div><div class=\\"nm\\">" + esc(name) +
        '</div><div class="id">' + esc(c.username || "") + (c.userId ? " · " + c.userId : "") + "</div></div></div></td>" +
        '<td><span class="chip">' + esc(c.executor || "unknown") + "</span></td>" +
        '<td class="place-cell"><div class="mono num">' + (c.placeId || "—") + "</div>" +
        (c.jobId
          ? '<div class="jobid mono" title="' + esc(c.jobId) + '" data-copy="' + esc(c.jobId) + '">job · ' + esc(String(c.jobId).slice(0, 8)) + "…</div>"
          : "") + "</td>" +
        '<td class="num muted">' + c.capabilities + "</td>" +
        '<td class="faint" data-at="' + c.connectedAt + '">' + relTime(c.connectedAt) + "</td>" +
        '<td class="go-cell">' + go + "</td>" +
        '<td class="kill-cell">' + kill + "</td></tr>";
    });
    el.innerHTML = '<div class="table-wrap"><table><thead><tr><th>Account</th><th>Executor</th>' +
      "<th>Place</th><th>Caps</th><th>Connected</th><th></th><th></th></tr></thead><tbody>" +
      rows.join("") + "</tbody></table></div>";
    el.querySelector("tbody").onclick = function (e) {
      var btn = e.target.closest(".kill");
      if (btn) {
        e.stopPropagation();
        handleKillClick(btn);
        return;
      }
      var jobChip = e.target.closest(".jobid");
      if (jobChip) {
        e.stopPropagation();
        var jid = jobChip.getAttribute("data-copy") || "";
        if (jid && navigator.clipboard) {
          navigator.clipboard.writeText(jid).then(function () {
            jobChip.classList.add("copied");
            setTimeout(function () { jobChip.classList.remove("copied"); }, 1000);
          }).catch(function () {});
        }
        return;
      }
      var tr = e.target.closest("tr.clickable");
      if (!tr) return;
      selectExploreClient(tr.getAttribute("data-client"), tr.getAttribute("data-name"));
    };
  }

  // Two-step destructive confirm on the inline trash button. First click expands
  // to "Disconnect?"; second click within 3s fires; clicking anywhere else cancels.
  var killArmed = null, killTimer = null;
  function disarmKill() {
    if (!killArmed) return;
    var b = killArmed;
    killArmed = null;
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
    if (b.isConnected) {
      b.classList.remove("confirm");
      b.innerHTML = b.getAttribute("data-icon") || "";
    }
  }
  document.addEventListener("click", function () { disarmKill(); });
  function handleKillClick(btn) {
    if (btn.classList.contains("busy")) return;
    if (killArmed === btn) {
      killArmed = null;
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      var tr = btn.closest("tr.clickable");
      var id = tr && tr.getAttribute("data-client");
      if (!id) return;
      btn.classList.add("busy");
      btn.textContent = "Disconnecting…";
      fetch("/api/clients/" + encodeURIComponent(id) + "/disconnect", { method: "POST" })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function () { pollState(); pollOutput(); })
        .catch(function () {
          btn.classList.remove("busy");
          btn.classList.remove("confirm");
          btn.innerHTML = btn.getAttribute("data-icon") || "";
        });
      return;
    }
    disarmKill();
    btn.setAttribute("data-icon", btn.innerHTML);
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></svg>Disconnect';
    btn.classList.add("confirm");
    killArmed = btn;
    killTimer = setTimeout(disarmKill, 3000);
  }

  // ---- activity ----
  function renderActivity() {
    var el = byId("panel-activity");
    if (!liveActivity.length && !state) { el.innerHTML = ""; return; }
    // Newest-first, capped to 80 rows on screen.
    var a = liveActivity.slice().sort(function (x, y) { return y.at - x.at; }).slice(0, 80);
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
    var idx = iconMap[cls];
    if (idx === undefined || idx === null) idx = 0;
    return '<span class="cicon" title="' + esc(cls) + '" style="background-position:-' + (idx * 16) + 'px 0"></span>';
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
  // Pull the first page on first access; subsequent calls (loadMoreChildren)
  // append. childCache shape: { children: [...], totalCount, hasMore, error? }.
  function loadChildren(path) {
    var cached = exp.childCache[path];
    if (cached && !cached.loading) return Promise.resolve(cached);
    var clientAtFetch = exp.clientId;
    return fetch("/api/explore/children?" + expQuery(path) + "&offset=0&limit=200")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (clientAtFetch !== exp.clientId) return null;
        if (data && data.error) { exp.childCache[path] = { error: data.error }; }
        else {
          exp.childCache[path] = {
            children: (data && data.children) || [],
            totalCount: (data && data.totalCount) || 0,
            hasMore: !!(data && data.hasMore),
          };
        }
        if (activeTab === "explorer") renderTree();
        return exp.childCache[path];
      })
      .catch(function () {
        exp.childCache[path] = { error: "Request failed." };
        if (activeTab === "explorer") renderTree();
        return exp.childCache[path];
      });
  }
  function loadMoreChildren(path) {
    var cached = exp.childCache[path];
    if (!cached || cached.loading || cached.error || !cached.hasMore) return Promise.resolve(cached);
    cached.loading = true;
    var offset = cached.children.length;
    var clientAtFetch = exp.clientId;
    return fetch("/api/explore/children?" + expQuery(path) + "&offset=" + offset + "&limit=200")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        cached.loading = false;
        if (clientAtFetch !== exp.clientId) return null;
        if (data && !data.error) {
          var more = (data && data.children) || [];
          cached.children = cached.children.concat(more);
          cached.hasMore = !!(data && data.hasMore);
          cached.totalCount = (data && data.totalCount) || cached.totalCount;
        }
        if (activeTab === "explorer") renderTree();
        return cached;
      })
      .catch(function () {
        cached.loading = false;
        return cached;
      });
  }
  // Debounced background prefetch on hover so the click-to-expand feels instant.
  var prefetchTimer = null;
  function schedulePrefetch(path) {
    if (exp.childCache[path]) return;
    if (prefetchTimer) clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(function () {
      prefetchTimer = null;
      if (!exp.childCache[path]) loadChildren(path);
    }, 250);
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
        if (cached.hasMore) {
          var remaining = (cached.totalCount || 0) - cached.children.length;
          var more = cached.loading ? "Loading more…" : "Load " + Math.min(200, remaining) + " more (" + remaining + " left)";
          var pad = (depth + 1) * 14 + 12;
          parts.push('<div class="tnode-more' + (cached.loading ? " busy" : "") + '" data-more="' + esc(path) +
            '" style="padding-left:' + pad + 'px">' + more + "</div>");
        }
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
    if (tree) {
      tree.onclick = function (e) {
        var more = e.target.closest(".tnode-more");
        if (more && !more.classList.contains("busy")) {
          var morePath = more.getAttribute("data-more");
          if (morePath) loadMoreChildren(morePath);
          return;
        }
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
        exp.crumb = crumbFor(path, name);
        var c = byId("exp-crumb"); if (c) c.innerHTML = renderCrumb();
        loadDetails(path, name);
      };
      // Debounced prefetch of children when the cursor enters an unexpanded
      // expandable node — by the time you click, the data is already there.
      tree.onmouseover = function (e) {
        var row = e.target.closest(".trow");
        if (!row) return;
        var chev = row.querySelector(".chev.has");
        if (!chev) return;
        var path = row.getAttribute("data-path");
        if (path && !exp.expanded[path]) schedulePrefetch(path);
      };
    }

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
      // Reconcile the live activity feed with the server's authoritative tail
      // (counters always win from the server, records merge by key).
      if (data && data.activity) {
        liveActivityTotal = data.activity.total;
        liveActivityErrors = data.activity.errors;
        var recent = data.activity.recent || [];
        for (var i = 0; i < recent.length; i++) ingestActivityRecord(recent[i], false);
      }
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
  function loadIcons() {
    fetch("/api/class-icons").then(function (r) { return r.json(); }).then(function (data) {
      iconMap = data || {};
      if (activeTab === "explorer" && exp.clientId) renderExplorer();
    }).catch(function () {});
  }

  // ---- repl tab ----
  var replState = { running: false, last: null, lastErr: null, acIndex: 0, acItems: [] };
  function kebabToCamel(s) {
    return s.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
  }
  function replSelectedClient() {
    return (exp && exp.clientId) || (state && state.clients[0] && state.clients[0].clientId) || null;
  }
  function renderRepl() {
    var cid = replSelectedClient();
    var label = "No client selected";
    if (cid && state) {
      var c = state.clients.find(function (x) { return x.clientId === cid; });
      if (c) label = "Target: " + (c.displayName || c.username || c.clientId.slice(0, 8));
    }
    var ce = byId("repl-client"); if (ce) ce.textContent = label;
    renderReplResult();
  }
  function renderReplResult() {
    var el = byId("repl-result");
    if (!el) return;
    if (replState.running) {
      el.classList.add("show"); el.classList.remove("err");
      el.textContent = "Running…";
      return;
    }
    if (replState.lastErr) {
      el.classList.add("show", "err");
      el.textContent = replState.lastErr;
      return;
    }
    if (replState.last !== null) {
      el.classList.add("show"); el.classList.remove("err");
      try { el.textContent = JSON.stringify(replState.last, null, 2); }
      catch (e) { el.textContent = String(replState.last); }
      return;
    }
    el.classList.remove("show", "err");
    el.textContent = "";
  }
  // Autocomplete: when the textarea ends with mcp.<partial>, surface a
  // filtered list of tool names from /api/tools and let Tab/Enter insert.
  function replAutocomplete() {
    var ta = byId("repl-src");
    var ac = byId("repl-ac");
    if (!ta || !ac) return;
    var pos = ta.selectionStart;
    var head = ta.value.slice(0, pos);
    var m = new RegExp("mcp\\.([A-Za-z0-9_]*)$").exec(head);
    if (!m || !tools.length) { ac.classList.remove("show"); return; }
    var prefix = m[1].toLowerCase();
    var camelTools = tools.map(function (t) { return { name: t.name, camel: kebabToCamel(t.name), title: t.title || "" }; });
    var matches = camelTools.filter(function (t) {
      return prefix === "" || t.camel.toLowerCase().indexOf(prefix) !== -1 || t.name.toLowerCase().indexOf(prefix) !== -1;
    }).slice(0, 30);
    if (!matches.length) { ac.classList.remove("show"); return; }
    replState.acItems = matches;
    if (replState.acIndex >= matches.length) replState.acIndex = 0;
    ac.innerHTML = matches.map(function (mt, i) {
      var camelHead = mt.camel.slice(0, prefix.length);
      var camelTail = mt.camel.slice(prefix.length);
      return '<div class="repl-ac-item' + (i === replState.acIndex ? " active" : "") +
        '" data-i="' + i + '">' +
        '<span class="at">' + esc(camelHead) + "</span><span>" + esc(camelTail) + "</span>" +
        '<span class="desc">' + esc(mt.title) + "</span>" +
        "</div>";
    }).join("");
    // Anchor near the cursor: approximate using textarea metrics.
    var rect = ta.getBoundingClientRect();
    var lines = head.split("\n");
    var lineH = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    var top = (lines.length) * lineH + 12;
    var left = Math.min(rect.width - 240, (lines[lines.length - 1].length * 7.4) + 14);
    ac.style.top = top + "px";
    ac.style.left = Math.max(8, left) + "px";
    ac.classList.add("show");
  }
  function replAcInsert(item) {
    var ta = byId("repl-src");
    if (!ta) return;
    var pos = ta.selectionStart;
    var head = ta.value.slice(0, pos);
    var tail = ta.value.slice(pos);
    var m = new RegExp("mcp\\.([A-Za-z0-9_]*)$").exec(head);
    if (!m) return;
    var head2 = head.slice(0, head.length - m[1].length) + item.camel;
    ta.value = head2 + tail;
    var newPos = head2.length;
    ta.selectionStart = ta.selectionEnd = newPos;
    byId("repl-ac").classList.remove("show");
    ta.focus();
  }
  function replRun() {
    var cid = replSelectedClient();
    if (!cid) { replState.lastErr = "No client connected."; renderReplResult(); return; }
    var src = byId("repl-src").value;
    if (!src.trim()) return;
    replState.running = true; replState.last = null; replState.lastErr = null;
    renderReplResult();
    fetch("/api/script/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: cid, source: src, persistent: true }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        replState.running = false;
        if (!data || !data.ok) replState.lastErr = (data && data.error) || "Run failed.";
        else replState.last = data.data;
        renderReplResult();
      })
      .catch(function () { replState.running = false; replState.lastErr = "Run failed."; renderReplResult(); });
  }
  // Wire the REPL once after init.
  setTimeout(function () {
    var ta = byId("repl-src");
    var ac = byId("repl-ac");
    var runBtn = byId("repl-run");
    var clearBtn = byId("repl-clear");
    if (!ta || !ac || !runBtn) return;
    ta.addEventListener("input", function () { replAutocomplete(); });
    ta.addEventListener("keydown", function (e) {
      if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); replRun(); return; }
      if (!ac.classList.contains("show")) return;
      if (e.key === "ArrowDown") { e.preventDefault(); replState.acIndex = (replState.acIndex + 1) % replState.acItems.length; replAutocomplete(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); replState.acIndex = (replState.acIndex - 1 + replState.acItems.length) % replState.acItems.length; replAutocomplete(); }
      else if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        var sel = replState.acItems[replState.acIndex];
        if (sel) replAcInsert(sel);
      } else if (e.key === "Escape") {
        ac.classList.remove("show");
      }
    });
    ac.onclick = function (e) {
      var row = e.target.closest(".repl-ac-item");
      if (!row) return;
      var idx = parseInt(row.getAttribute("data-i"), 10);
      replAcInsert(replState.acItems[idx]);
    };
    runBtn.onclick = function () { replRun(); };
    if (clearBtn) clearBtn.onclick = function () {
      ta.value = ""; replState.last = null; replState.lastErr = null; renderReplResult(); ta.focus();
    };
    document.addEventListener("click", function (e) {
      if (e.target.closest && (e.target.closest("#repl-ac") || e.target.closest("#repl-src"))) return;
      ac.classList.remove("show");
    });
  }, 0);

  // ---- playbooks tab ----
  var pbState = {
    items: null, selected: null, current: null, dirty: false,
    creating: false, running: false, runResult: null, runErr: null, err: null,
  };
  function pbExtractParams(src) {
    var out = [], seen = {};
    var re = new RegExp("\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}", "g");
    var m;
    while ((m = re.exec(src)) !== null) {
      if (!seen[m[1]]) { seen[m[1]] = true; out.push(m[1]); }
    }
    return out;
  }
  function pbItemHtml(p, active) {
    var tags = (p.tags || []).map(function (t) { return '<span class="chip">' + esc(t) + '</span>'; }).join("");
    return '<div class="pb-item' + (active ? " active" : "") + '" data-pb="' + esc(p.name) + '">' +
      '<div class="nm">' + esc(p.name) + '</div>' +
      (p.description ? '<div class="dsc">' + esc(p.description) + '</div>' : '') +
      (tags ? '<div class="pb-tags">' + tags + '</div>' : '') +
      '<div class="ts">' + (p.updatedAt ? relTime(p.updatedAt) : '—') + '</div>' +
      '</div>';
  }
  function renderPlaybookList() {
    var host = byId("pb-items");
    if (!host) return;
    if (!pbState.items) {
      host.innerHTML = '<div class="empty"><span class="spin"></span></div>';
      return;
    }
    if (!pbState.items.length) {
      host.innerHTML = '<div class="empty"><div class="h">No playbooks yet</div>' +
        '<div class="s">Click + New to save your first recipe.</div></div>';
      byId("t-playbooks").textContent = 0;
      return;
    }
    byId("t-playbooks").textContent = pbState.items.length;
    host.innerHTML = pbState.items.map(function (p) {
      return pbItemHtml(p, p.name === pbState.selected);
    }).join("");
    host.onclick = function (e) {
      var row = e.target.closest(".pb-item");
      if (!row) return;
      var name = row.getAttribute("data-pb");
      pbSelect(name);
    };
  }
  function renderPlaybookPane() {
    var pane = byId("pb-pane");
    if (!pane) return;
    if (pbState.err) {
      pane.innerHTML = '<div class="err-msg">' + esc(pbState.err) + '</div>';
      return;
    }
    if (pbState.creating) {
      pane.innerHTML = renderPbForm({ name: "", source: "", description: "", tags: [], params: [] }, true);
      pbWirePane();
      return;
    }
    if (!pbState.current) {
      pane.innerHTML = '<div class="empty"><div class="h">' +
        (pbState.items && pbState.items.length ? "Pick a playbook to view it" : "No playbook selected") +
        '</div></div>';
      return;
    }
    pane.innerHTML = renderPbForm(pbState.current, false);
    pbWirePane();
  }
  function renderPbForm(pb, isNew) {
    var paramRows = (pb.params || []).map(function (p) {
      return '<div class="pname">${' + esc(p) + '}</div>' +
        '<input class="search" data-param="' + esc(p) + '" placeholder="value" />';
    }).join("");
    var runRes = "";
    if (pbState.runErr) {
      runRes = '<div class="pb-runres err">' + esc(pbState.runErr) + '</div>';
    } else if (pbState.runResult) {
      var pretty;
      try { pretty = JSON.stringify(pbState.runResult, null, 2); }
      catch (e) { pretty = String(pbState.runResult); }
      runRes = '<div class="pb-runres">' + esc(pretty) + '</div>';
    }
    return '<div class="pb-meta">' +
      '<input class="search" id="pb-name" placeholder="name" value="' + esc(pb.name) + '" ' + (isNew ? "" : "readonly") + ' />' +
      '<input class="search" id="pb-desc" placeholder="description" value="' + esc(pb.description || "") + '" />' +
      '<input class="search" id="pb-tags" placeholder="tags (comma-sep)" value="' + esc((pb.tags || []).join(", ")) + '" />' +
      '</div>' +
      '<div class="label">Source</div>' +
      '<textarea class="src" id="pb-src" spellcheck="false">' + esc(pb.source || "") + '</textarea>' +
      (paramRows ? '<div class="label" style="margin-top:10px">Parameters</div>' +
        '<div class="pb-params">' + paramRows + '</div>' : '') +
      '<div class="pb-actions">' +
        '<button class="out-btn primary" id="pb-save">' + (isNew ? "Create" : "Save") + '</button>' +
        (!isNew ? '<button class="out-btn" id="pb-run">' + (pbState.running ? "Running…" : "Run on selected client") + '</button>' : '') +
        (!isNew ? '<button class="out-btn danger" id="pb-delete">Delete</button>' : '') +
        '<button class="out-btn" id="pb-cancel">' + (isNew ? "Cancel" : "Close") + '</button>' +
      '</div>' +
      runRes;
  }
  function pbWirePane() {
    var save = byId("pb-save");
    if (save) save.onclick = function () { pbSaveCurrent(byId("pb-name").value); };
    var cancel = byId("pb-cancel");
    if (cancel) cancel.onclick = function () {
      pbState.creating = false; pbState.current = null; pbState.selected = null;
      pbState.runResult = null; pbState.runErr = null;
      renderPlaybooks();
    };
    var del = byId("pb-delete");
    if (del) del.onclick = function () {
      if (!pbState.current) return;
      if (!confirm('Delete playbook "' + pbState.current.name + '"?')) return;
      pbDelete(pbState.current.name);
    };
    var run = byId("pb-run");
    if (run) run.onclick = function () { if (pbState.current) pbRun(pbState.current.name); };
    var src = byId("pb-src");
    if (src) src.oninput = function () {
      var params = pbExtractParams(src.value);
      // Auto-detect dollar-brace placeholders and re-render the params block.
      var prev = (pbState.current && pbState.current.params) || [];
      if (JSON.stringify(prev) !== JSON.stringify(params)) {
        if (pbState.creating) {
          renderPlaybookPane();
          // restore focus + cursor
          var t = byId("pb-src"); if (t) { t.focus(); t.value = src.value; }
        } else {
          pbState.current = Object.assign({}, pbState.current, { params: params });
          renderPlaybookPane();
          var t2 = byId("pb-src"); if (t2) { t2.focus(); t2.value = src.value; }
        }
      }
    };
  }
  function pbSelect(name) {
    pbState.selected = name;
    pbState.creating = false;
    pbState.runResult = null;
    pbState.runErr = null;
    fetch("/api/playbooks/" + encodeURIComponent(name))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.error) { pbState.err = data.error; pbState.current = null; }
        else {
          pbState.err = null;
          // Make sure we have a params array populated either from saved data or by scanning the source.
          var params = (data && data.params && data.params.length) ? data.params : pbExtractParams((data && data.source) || "");
          pbState.current = Object.assign({}, data, { params: params });
        }
        if (activeTab === "playbooks") renderPlaybooks();
      })
      .catch(function () {
        pbState.err = "Request failed.";
        if (activeTab === "playbooks") renderPlaybooks();
      });
  }
  function pbSaveCurrent(name) {
    var src = byId("pb-src").value;
    var desc = byId("pb-desc").value;
    var tagsRaw = byId("pb-tags").value;
    var tags = tagsRaw.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var params = pbExtractParams(src);
    fetch("/api/playbooks/" + encodeURIComponent(name), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: src, description: desc, tags: tags, params: params }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) {
          pbState.runErr = (data && data.error) || "Save failed.";
        } else {
          pbState.runErr = null;
          pbState.creating = false;
          pbState.selected = name;
        }
        pbLoadList(function () { if (pbState.selected) pbSelect(pbState.selected); else renderPlaybooks(); });
      })
      .catch(function () { pbState.runErr = "Save failed."; renderPlaybooks(); });
  }
  function pbDelete(name) {
    fetch("/api/playbooks/" + encodeURIComponent(name), { method: "DELETE" })
      .then(function () {
        pbState.current = null; pbState.selected = null;
        pbState.runResult = null; pbState.runErr = null;
        pbLoadList(function () { renderPlaybooks(); });
      })
      .catch(function () {});
  }
  function pbRun(name) {
    var clientId = (exp && exp.clientId) || (state && state.clients[0] && state.clients[0].clientId) || null;
    if (!clientId) { pbState.runErr = "No client connected to run on."; renderPlaybooks(); return; }
    var params = {};
    document.querySelectorAll("[data-param]").forEach(function (n) {
      params[n.getAttribute("data-param")] = n.value;
    });
    pbState.running = true; pbState.runResult = null; pbState.runErr = null;
    renderPlaybookPane();
    fetch("/api/playbooks/" + encodeURIComponent(name) + "/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: clientId, params: params }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        pbState.running = false;
        if (!data || !data.ok) pbState.runErr = (data && data.error) || "Run failed.";
        else pbState.runResult = data.data;
        renderPlaybookPane();
      })
      .catch(function () { pbState.running = false; pbState.runErr = "Run failed."; renderPlaybookPane(); });
  }
  function pbLoadList(then) {
    fetch("/api/playbooks")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        pbState.items = (data && data.playbooks) || [];
        if (typeof then === "function") then();
        else if (activeTab === "playbooks") renderPlaybooks();
        else byId("t-playbooks").textContent = pbState.items.length;
      })
      .catch(function () {
        pbState.items = [];
        renderPlaybooks();
      });
  }
  function renderPlaybooks() {
    if (pbState.items === null) { pbLoadList(); return; }
    renderPlaybookList();
    renderPlaybookPane();
  }
  // Initial load so the tab badge shows a count even before the user opens it.
  pbLoadList();
  // Wire the "+ New" button (panel is always in the DOM).
  setTimeout(function () {
    var nb = byId("pb-new");
    if (nb) nb.onclick = function () {
      pbState.creating = true; pbState.current = null; pbState.selected = null;
      pbState.runResult = null; pbState.runErr = null;
      renderPlaybooks();
      setTimeout(function () { var f = byId("pb-name"); if (f) f.focus(); }, 0);
    };
  }, 0);

  // ---- spy tab ----
  function spyArgsPreview(args) {
    if (!Array.isArray(args)) return "";
    try { return JSON.stringify(args).slice(0, 240); }
    catch (e) { return "<unencodable>"; }
  }
  function spySnippetFor(entry) {
    // The fire-remote tool spec lets us reproduce a captured call as a one-liner.
    var path = entry.remote || "";
    var args = Array.isArray(entry.args) ? entry.args : [];
    var argsJson;
    try { argsJson = JSON.stringify(args); }
    catch (e) { argsJson = "[]"; }
    return 'mcp.fireRemote({ path = "' + path.replace(/"/g, '\\"') + '", args = ' + argsJson + ' })';
  }
  function renderSpy() {
    var el = byId("panel-spy");
    if (!state) { el.innerHTML = ""; return; }
    var clientId = (exp && exp.clientId) || (state.clients[0] && state.clients[0].clientId) || null;
    if (spyState.clientId !== clientId) {
      spyState.clientId = clientId; spyState.data = null; spyState.err = null;
    }
    if (!clientId) {
      byId("spy-body").innerHTML = '<div class="empty"><div class="h">No client connected</div></div>';
      byId("spy-count").textContent = "";
      return;
    }
    if (!spyState.data && !spyState.err) loadSpyLogs(clientId);
    var d = spyState.data;
    var body = byId("spy-body");
    if (spyState.err) {
      body.innerHTML = '<div class="err-msg">' + esc(spyState.err) + "</div>";
      return;
    }
    if (!d) {
      body.innerHTML = '<div class="loading"><span class="spin"></span>Loading spy buffer…</div>';
      return;
    }
    if (d.notRunning) {
      body.innerHTML = '<div class="empty"><div class="h">Remote spy is not installed</div>' +
        '<div class="s">Run <span class="mono">ensure-remote-spy</span> via your MCP client to start capturing remote calls.</div></div>';
      byId("spy-count").textContent = "";
      byId("t-spy").textContent = 0;
      return;
    }
    if (d.error) {
      body.innerHTML = '<div class="err-msg">' + esc(d.error) + "</div>";
      return;
    }
    var logs = d.logs || [];
    byId("t-spy").textContent = d.count || 0;
    var q = spyState.filter.toLowerCase();
    var rows = logs.map(function (e) {
      if (q) {
        var hay = (String(e.remote || "") + " " + String(e.method || "") + " " + spyArgsPreview(e.args)).toLowerCase();
        if (hay.indexOf(q) === -1) return "";
      }
      var meth = String(e.method || "fire").toLowerCase();
      var label = e.blocked ? "blocked" : (meth.indexOf("invoke") !== -1 ? "invoke" : "fire");
      var snippet = spySnippetFor(e);
      var when = e.t ? relTime(e.t * (e.t < 1e12 ? 1000 : 1)) : "—";
      return '<tr class="spy-row">' +
        '<td class="faint num">' + esc(when) + "</td>" +
        '<td><span class="smethod ' + label + '">' + esc(label) + "</span></td>" +
        '<td><span class="spath">' + esc(String(e.remote || "—")) + "</span></td>" +
        '<td><span class="sargs" title="' + esc(spyArgsPreview(e.args)) + '">' + esc(spyArgsPreview(e.args)) + "</span></td>" +
        '<td class="num muted">' + (e.argCount || 0) + (e.argsTruncated ? "+" : "") + "</td>" +
        '<td style="text-align:right"><button class="scopy" data-copy="' + esc(snippet) + '" title="Copy as mcp.fireRemote">copy</button></td>" +
        "</tr>";
    }).filter(Boolean).join("");
    byId("spy-count").textContent = (logs.length || 0) + " shown / " + (d.count || 0) + " buffered" + (d.truncated ? " (truncated)" : "");
    body.innerHTML = rows
      ? '<div class="table-wrap"><table><thead><tr><th>When</th><th>Kind</th><th>Remote</th><th>Args</th><th>#</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>"
      : '<div class="empty"><div class="h">No matching captures</div></div>';
  }
  function loadSpyLogs(clientId) {
    fetch("/api/spy/logs?client=" + encodeURIComponent(clientId) + "&limit=300")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (spyState.clientId !== clientId) return;
        if (data && data.error) { spyState.err = data.error; spyState.data = null; }
        else { spyState.data = data; spyState.err = null; }
        if (activeTab === "spy") renderSpy();
      })
      .catch(function () {
        if (spyState.clientId !== clientId) return;
        spyState.err = "Request failed.";
        renderSpy();
      });
  }
  setInterval(function () {
    if (activeTab !== "spy" || !spyState.autoRefresh || !spyState.clientId) return;
    loadSpyLogs(spyState.clientId);
  }, 1500);

  // ---- brief tab ----
  var briefState = { clientId: null, summary: null, values: null, valuesLoading: false, summaryErr: null, valuesErr: null };
  function fmtNum(v) { if (typeof v !== "number") return esc(String(v)); return v.toLocaleString(); }
  function renderBrief() {
    var el = byId("panel-brief");
    if (!state) { el.innerHTML = ""; return; }
    // Target the currently-explored client if any, else the first connected one.
    var clientId = (exp && exp.clientId) || (state.clients[0] && state.clients[0].clientId) || null;
    if (briefState.clientId !== clientId) {
      briefState.clientId = clientId;
      briefState.summary = null;
      briefState.values = null;
      briefState.summaryErr = null;
      briefState.valuesErr = null;
    }
    if (!clientId) {
      el.innerHTML = '<div class="empty"><div class="h">No client connected</div>' +
        '<div class="s">Run the loader in your executor; the brief will populate from the first connected game.</div></div>';
      return;
    }
    if (!briefState.summary && !briefState.summaryErr) loadBriefSummary(clientId);
    var s = briefState.summary;
    var meta = "";
    if (briefState.summaryErr) {
      meta = '<div class="brief-card"><div class="err-msg">' + esc(briefState.summaryErr) + '</div></div>';
    } else if (!s) {
      meta = '<div class="brief-card"><div class="loading"><span class="spin"></span>Loading place…</div></div>';
    } else if (s.error) {
      meta = '<div class="brief-card"><div class="err-msg">' + esc(s.error) + '</div></div>';
    } else {
      var p = s.place || {}, c = s.counts || {}, who = s.player || {};
      function row(k, v) { return '<div class="brief-row"><div class="brief-k">' + esc(k) + '</div><div class="brief-v mono">' + v + '</div></div>'; }
      meta =
        '<div class="brief-card"><div class="brief-h">Place</div>' +
        row("PlaceId", '<span class="copy" data-copy="' + esc(String(p.placeId || "")) + '">' + esc(String(p.placeId || "—")) + "</span>") +
        row("GameId", esc(String(p.gameId || "—"))) +
        row("PlaceVersion", esc(String(p.placeVersion || "—"))) +
        row("JobId", '<span class="copy" data-copy="' + esc(String(p.jobId || "")) + '" title="' + esc(String(p.jobId || "")) + '">' + esc(String(p.jobId || "—").slice(0, 14) + (String(p.jobId || "").length > 14 ? "…" : "")) + "</span>") +
        row("CreatorType", esc(String(p.creatorType || "—")) + ' · id ' + esc(String(p.creatorId || "—"))) +
        row("Players", fmtNum(p.numPlayers || 0) + " / " + fmtNum(p.maxPlayers || 0)) +
        "</div>" +
        '<div class="brief-card"><div class="brief-h">Surfaces</div>' +
        row("ReplicatedStorage", '<span class="muted">' + (c.replicated ? (c.replicated.total + " items") : "—") + "</span>") +
        row("• RemoteEvent", fmtNum((c.replicated && c.replicated.RemoteEvent) || 0)) +
        row("• RemoteFunction", fmtNum((c.replicated && c.replicated.RemoteFunction) || 0)) +
        row("• ModuleScript", fmtNum((c.replicated && c.replicated.ModuleScript) || 0)) +
        row("Workspace scripts", fmtNum(((c.workspace && c.workspace.Script) || 0) + ((c.workspace && c.workspace.LocalScript) || 0))) +
        row("StarterPack Tools", fmtNum((c.starterPack && c.starterPack.Tool) || 0)) +
        "</div>" +
        '<div class="brief-card"><div class="brief-h">Local Player</div>' +
        row("Name", esc(who.name || "—")) +
        row("DisplayName", esc(who.displayName || "—")) +
        row("UserId", esc(String(who.userId || "—"))) +
        "</div>";
    }

    var v = briefState.values;
    var valuesHtml = "";
    if (briefState.valuesErr) {
      valuesHtml = '<div class="err-msg">' + esc(briefState.valuesErr) + '</div>';
    } else if (briefState.valuesLoading) {
      valuesHtml = '<div class="loading"><span class="spin"></span>Scanning leaderstats / Player / ReplicatedStorage…</div>';
    } else if (v && v.candidates) {
      if (!v.candidates.length) {
        valuesHtml = '<div class="muted">No candidate value paths found in the usual spots.</div>';
      } else {
        var rows = v.candidates.map(function (c) {
          var reasons = (c.reasons || []).map(function (r) { return '<span class="rchip">' + esc(r) + '</span>'; }).join("");
          return '<tr><td class="num muted">' + c.score + "</td>" +
            '<td class="mono">' + esc(c.path) + "</td>" +
            '<td>' + esc(c.class) + "</td>" +
            '<td class="mono">' + esc(String(c.value)) + "</td>" +
            '<td>' + reasons + "</td></tr>";
        }).join("");
        valuesHtml = '<div class="table-wrap"><table><thead><tr><th>Score</th><th>Path</th><th>Class</th><th>Value</th><th>Reasons</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
      }
    } else {
      valuesHtml = '<div class="muted">Click <b>Discover values</b> to scan candidate money/score/xp paths.</div>';
    }

    el.innerHTML =
      '<div class="brief-grid">' + meta + '</div>' +
      '<div class="brief-section">' +
        '<div class="brief-section-head"><span class="sec">Candidate value paths</span>' +
          '<button class="out-btn" id="brief-scan">' + (briefState.valuesLoading ? "Scanning…" : "Discover values") + '</button>' +
        '</div>' + valuesHtml +
      '</div>';

    var scanBtn = byId("brief-scan");
    if (scanBtn) scanBtn.onclick = function () { loadBriefValues(briefState.clientId); };
    // Wire .copy click-to-copy on PlaceId / JobId
    el.querySelectorAll(".copy").forEach(function (n) {
      n.onclick = function () {
        var v = n.getAttribute("data-copy") || "";
        if (v && navigator.clipboard) navigator.clipboard.writeText(v).catch(function () {});
      };
    });
  }
  function loadBriefSummary(clientId) {
    fetch("/api/brief?client=" + encodeURIComponent(clientId))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (briefState.clientId !== clientId) return;
        if (data && data.error) briefState.summaryErr = data.error;
        else briefState.summary = data;
        if (activeTab === "brief") renderBrief();
      })
      .catch(function () {
        if (briefState.clientId !== clientId) return;
        briefState.summaryErr = "Request failed.";
        if (activeTab === "brief") renderBrief();
      });
  }
  function loadBriefValues(clientId) {
    if (!clientId) return;
    briefState.valuesLoading = true; briefState.valuesErr = null; renderBrief();
    fetch("/api/brief/values?client=" + encodeURIComponent(clientId) + "&limit=80")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        briefState.valuesLoading = false;
        if (briefState.clientId !== clientId) return;
        if (data && data.error) briefState.valuesErr = data.error;
        else briefState.values = data;
        renderBrief();
      })
      .catch(function () {
        briefState.valuesLoading = false;
        if (briefState.clientId !== clientId) return;
        briefState.valuesErr = "Request failed.";
        renderBrief();
      });
  }

  // ---- output console ----
  function fmtClock(ts) {
    var d = new Date(ts);
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function mostRecentScriptToken() {
    for (var i = outData.length - 1; i >= 0; i--) {
      if (outData[i].source === "script" && outData[i].scriptToken) return outData[i].scriptToken;
    }
    return null;
  }
  function inScope(e) {
    if (outScope === "all") return true;
    var src = e.source || "game";
    if (outScope === "game") return src === "game";
    if (outScope === "script") return src === "script";
    if (outScope === "recent-script") {
      var tok = mostRecentScriptToken();
      return tok != null && e.scriptToken === tok;
    }
    return true;
  }
  function renderOutput() {
    var el = byId("console");
    if (!el) return;
    var q = outFilter.toLowerCase();
    var rows = [];
    for (var i = 0; i < outData.length; i++) {
      var e = outData[i];
      if (e.at <= outClearedAt) continue;
      if (!inScope(e)) continue;
      if (q && String(e.message).toLowerCase().indexOf(q) === -1) continue;
      var kind = e.kind || "print";
      var who = e.clientName ? '<span class="oclient">' + esc(e.clientName) + "</span>" : "";
      var srcTag = e.source === "script"
        ? '<span class="osrc src-script" title="' + esc(e.scriptToken || "") + '">script</span>'
        : "";
      rows.push('<div class="oline k-' + esc(kind) + '"><span class="ot">' + fmtClock(e.at) +
        '</span><span class="oc"></span>' + who + srcTag + '<span class="om">' + esc(e.message) + "</span></div>");
    }
    byId("out-count").textContent = rows.length + " lines";
    if (!rows.length) {
      el.innerHTML = '<div class="empty"><div class="h">No output yet</div>' +
        '<div class="s">Every print, warn and error from the game streams here live.</div></div>';
      return;
    }
    el.innerHTML = rows.join("");
    if (outAutoscroll) el.scrollTop = el.scrollHeight;
  }
  function pollOutput() {
    fetch("/api/output?limit=1200").then(function (r) { return r.json(); }).then(function (data) {
      var entries = (data && data.entries) || [];
      entries.reverse(); // API is newest-first; console reads top-down chronologically
      outData = entries;
      var visible = 0;
      for (var i = 0; i < outData.length; i++) { if (outData[i].at > outClearedAt) visible++; }
      byId("t-output").textContent = visible;
      if (activeTab === "output") renderOutput();
    }).catch(function () {});
  }
  byId("spy-filter").addEventListener("input", function (e) { spyState.filter = e.target.value; renderSpy(); });
  byId("spy-autoref").addEventListener("change", function (e) { spyState.autoRefresh = e.target.checked; });
  byId("spy-refresh").addEventListener("click", function () { if (spyState.clientId) loadSpyLogs(spyState.clientId); });
  byId("spy-clear").addEventListener("click", function () {
    if (!spyState.clientId) return;
    fetch("/api/spy/clear?client=" + encodeURIComponent(spyState.clientId), { method: "POST" })
      .then(function () { if (spyState.clientId) loadSpyLogs(spyState.clientId); })
      .catch(function () {});
  });
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest(".scopy");
    if (!btn) return;
    var v = btn.getAttribute("data-copy") || "";
    if (!v || !navigator.clipboard) return;
    navigator.clipboard.writeText(v).then(function () {
      btn.classList.add("copied"); btn.textContent = "copied";
      setTimeout(function () { btn.classList.remove("copied"); btn.textContent = "copy"; }, 900);
    }).catch(function () {});
  });
  byId("out-filter").addEventListener("input", function (e) { outFilter = e.target.value; renderOutput(); });
  byId("out-scope").addEventListener("change", function (e) { outScope = e.target.value; renderOutput(); });
  byId("out-autoscroll").addEventListener("change", function (e) {
    outAutoscroll = e.target.checked;
    if (outAutoscroll) renderOutput();
  });
  byId("out-clear").addEventListener("click", function () {
    outClearedAt = outData.length ? outData[outData.length - 1].at : Date.now();
    renderOutput();
    byId("t-output").textContent = 0;
  });

  // Live updates over WebSocket: output streams in as it happens, and
  // activity/client-change events nudge the existing state poll so it refreshes
  // immediately rather than waiting for the next 2s tick. The poll remains as
  // a resilience fallback if the WS drops.
  var ws = null, wsBackoff = 1000, wsRefreshTimer = null;
  function nudgeState() {
    if (wsRefreshTimer) return;
    wsRefreshTimer = setTimeout(function () { wsRefreshTimer = null; pollState(); }, 120);
  }
  function openWs() {
    try {
      var proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(proto + "://" + location.host + "/ws/dashboard");
    } catch (e) { setTimeout(openWs, wsBackoff); wsBackoff = Math.min(wsBackoff * 2, 15000); return; }
    ws.onopen = function () { wsBackoff = 1000; };
    ws.onmessage = function (ev) {
      var msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || !msg.type) return;
      if (msg.type === "output") {
        var added = msg.entries || [];
        if (!added.length) return;
        outData = outData.concat(added).slice(-1500);
        var visible = 0;
        for (var i = 0; i < outData.length; i++) { if (outData[i].at > outClearedAt) visible++; }
        byId("t-output").textContent = visible;
        if (activeTab === "output") renderOutput();
      } else if (msg.type === "activity") {
        if (msg.record) {
          ingestActivityRecord(msg.record, true);
          liveActivityTotal += 1;
          if (msg.record.outcome === "error") liveActivityErrors += 1;
          byId("s-calls").textContent = liveActivityTotal;
          byId("s-errs").textContent = liveActivityErrors;
          byId("t-activity").textContent = liveActivityTotal;
          if (activeTab === "activity") renderActivity();
        }
        nudgeState();
      } else if (msg.type === "client-change") {
        nudgeState();
      }
    };
    ws.onclose = function () {
      ws = null;
      setTimeout(openWs, wsBackoff);
      wsBackoff = Math.min(wsBackoff * 2, 15000);
    };
    ws.onerror = function () { try { ws && ws.close(); } catch (e) {} };
  }
  openWs();

  loadIcons();
  loadTools();
  pollState();
  pollOutput();
  setInterval(pollState, 2000);
  setInterval(loadTools, 30000);
  setInterval(pollOutput, 1500);
})();
</script>
</body>
</html>`;
}
