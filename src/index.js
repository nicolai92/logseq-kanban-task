/**
 * Logseq Kanban Board Plugin  v1.4.0
 * ------------------------------------
 * TODO | DOING | WAITING | DONE
 *
 * New in v1.4:
 *  - Robust date formatting: reads preferredDateFormat, handles all locale
 *    variants (dd.MM.yyyy, EEE/eee day-name capitalisation, etc.)
 *  - Progress bar in header: active (Todo+Doing) vs Done
 *  - Assignees: parse @name / assignee::Name from blocks, show on cards,
 *    set via add-form and context menu
 *  - Assignee filter: All / Mine / Others
 *  - "Request status" action: creates a follow-up block mentioning @assignee
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PANEL_ID = "kb-panel";
const STYLE_ID = "kb-styles";
const MENU_ID  = "kb-ctx-menu";

const COLUMNS = [
  { state: "TODO",    label: "Todo",    color: "#3b82f6", bg: "rgba(59,130,246,0.08)"  },
  { state: "DOING",   label: "Doing",   color: "#f59e0b", bg: "rgba(245,158,11,0.08)"  },
  { state: "WAITING", label: "Waiting", color: "#8b5cf6", bg: "rgba(139,92,246,0.08)"  },
  { state: "DONE",    label: "Done",    color: "#10b981", bg: "rgba(16,185,129,0.08)"  },
];

const PRIORITIES = [
  { value: "A", label: "A", color: "#ef4444", title: "High"   },
  { value: "B", label: "B", color: "#f97316", title: "Medium" },
  { value: "C", label: "C", color: "#eab308", title: "Low"    },
  { value: "",  label: "\u2014", color: "#9ca3af", title: "None" },
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let panelOpen   = false;
let isLoading   = false;
let lastTasks   = {};
let dragUUID    = null;
let dragMarker  = null;
let filterAssignee = "all";   // "all" | "mine" | "others"
let myName      = "";         // populated from getUserConfigs
let dateFormat  = "MMM do, yyyy"; // cached preferredDateFormat

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

/**
 * All Logseq date-format tokens, handled in longest-first order to avoid
 * partial matches (e.g. "dd" must be replaced before "d").
 * Handles both upper- and lower-case day/month abbreviations (EEE vs eee).
 */
function formatDay(day) {
  if (!day) return "";
  const s = String(day);
  if (s.length !== 8) return s;
  const date = new Date(Number(s.slice(0,4)), Number(s.slice(4,6))-1, Number(s.slice(6,8)));
  return applyDateFormat(date, dateFormat);
}

function applyDateFormat(date, pattern) {
  const ML = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const MS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const DL = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const DS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const y  = date.getFullYear();
  const mo = date.getMonth();
  const d  = date.getDate();
  const wd = date.getDay();

  function ordinal(n) {
    if (n >= 11 && n <= 13) return n + "th";
    return n + (["th","st","nd","rd","th","th","th","th","th","th"][n % 10] || "th");
  }

  // Replace tokens longest-first; handle both UPPER and lower case day variants
  return pattern
    .replace(/yyyy/g,  String(y))
    .replace(/yy/g,    String(y).slice(-2))
    .replace(/MMMM/g,  ML[mo])
    .replace(/MMM/g,   MS[mo])
    .replace(/MM/g,    String(mo+1).padStart(2,"0"))
    .replace(/M(?!a)/g, String(mo+1))     // avoid matching "Mar", "May"
    .replace(/EEEE|eeee/g, DL[wd])
    .replace(/EEE|eee/g,   DS[wd])
    .replace(/do/g,    ordinal(d))
    .replace(/dd/g,    String(d).padStart(2,"0"))
    .replace(/d/g,     String(d));
}

// ---------------------------------------------------------------------------
// User config (cached on open)
// ---------------------------------------------------------------------------

async function loadUserConfig() {
  try {
    const cfg = await logseq.App.getUserConfigs();
    if (cfg && cfg.preferredDateFormat) dateFormat = cfg.preferredDateFormat;
    if (cfg && cfg.preferredName)       myName     = cfg.preferredName;
  } catch(_) {}
}

async function getTodayPageName() {
  const today = new Date();
  try {
    const cfg = await logseq.App.getUserConfigs();
    return applyDateFormat(today, (cfg && cfg.preferredDateFormat) || dateFormat);
  } catch(_) {
    return applyDateFormat(today, dateFormat);
  }
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function parseAssignee(content) {
  // Prefer explicit property: assignee::[[First Lastname]] or assignee::Name
  const prop = content.match(/assignee::\s*(\[\[[^\]]+\]\]|[^\s,\]#\n\[]+)/i);
  if (prop) return prop[1].trim();
  // Fall back to first @mention
  const mention = content.match(/@([A-Z][a-z]+(?:\s[A-Z][a-z]+)*|[\w-]+)/);
  if (mention) return mention[1];
  return "";
}

/** Strip [[...]] brackets for display only */
function displayAssignee(raw) {
  return raw.replace(/^\[\[|\]\]$/g, "");
}

async function fetchTasks() {
  const groups  = emptyGroups();
  const MARKERS = ["TODO", "DOING", "DONE", "WAITING"];

  try {
    const query = `
      [:find ?uuid ?content ?page-name ?journal-day
       :where
         [?b :block/uuid ?uuid]
         [?b :block/content ?content]
         [?b :block/page ?p]
         (or [?p :block/original-name ?page-name]
             [?p :block/name ?page-name])
         (or [?p :block/journal-day ?journal-day]
             [(ground 0) ?journal-day])]
    `;

    const raw = await logseq.DB.datascriptQuery(query);
    if (!raw || !raw.length) return groups;

    const seen = new Set();

    for (const row of raw) {
      const [uuid, content, pageName, journalDay] = row;
      if (!content || typeof content !== "string") continue;
      const uuidStr = formatUUID(uuid);
      if (seen.has(uuidStr)) continue;

      // Clean logbook, clock, scheduled lines before any parsing
      const cleaned = cleanContent(content);
      const trimmed = cleaned.trimStart();

      let matched = null;
      for (const m of MARKERS) {
        if (trimmed.startsWith(m + " ") || trimmed.startsWith(m + "\t")) {
          matched = m; break;
        }
      }
      if (!matched) continue;

      const priority  = parsePriority(trimmed);
      const assignee  = parseAssignee(trimmed);
      const scheduled = parseScheduled(content); // parse from original (before clean strips it)
      const text      = stripMarker(trimmed);
      if (!text) continue;

      seen.add(uuidStr);
      groups[matched].push({
        uuid: uuidStr, text, priority, assignee, scheduled,
        pageName,
        displayPage: journalDay ? formatDay(journalDay) : pageName,
        journalDay:  journalDay || 0,
      });
    }

    // Sort: newest date first, then priority A>B>C>none
    const PRIO_ORDER = { A:0, B:1, C:2, "":3 };
    for (const m of MARKERS) {
      groups[m].sort((a, b) => {
        if (a.journalDay && b.journalDay && a.journalDay !== b.journalDay)
          return b.journalDay - a.journalDay;
        if (a.journalDay && !b.journalDay) return -1;
        if (!a.journalDay && b.journalDay) return 1;
        const pa = PRIO_ORDER[a.priority] !== undefined ? PRIO_ORDER[a.priority] : 3;
        const pb = PRIO_ORDER[b.priority] !== undefined ? PRIO_ORDER[b.priority] : 3;
        if (pa !== pb) return pa - pb;
        return a.pageName.localeCompare(b.pageName);
      });
    }
  } catch (err) {
    console.error("[Kanban] query failed:", err);
    for (const marker of ["TODO","DOING","DONE","WAITING"]) {
      try {
        const results = await logseq.DB.q("(task " + marker + ")");
        if (!results) continue;
        for (const block of results) {
          if (!block || !block.content) continue;
          const pn = (block.page && (block.page.originalName || block.page.name)) || "unknown";
          groups[marker].push({
            uuid: block.uuid, text: stripMarker(cleanContent(block.content)),
            priority: parsePriority(block.content),
            assignee: parseAssignee(block.content),
            scheduled: parseScheduled(block.content),
            pageName: pn, displayPage: pn, journalDay: 0,
          });
        }
      } catch (_) {}
    }
  }

  return groups;
}

function emptyGroups() {
  return { TODO: [], DOING: [], WAITING: [], DONE: [] };
}

function parsePriority(content) {
  const m = content.match(/^(?:TODO|DOING|DONE|WAITING)[\s\t]+(?:\[#([A-C])\]|#([A-C]))[\s\t]/i);
  if (m) return m[1] || m[2] || "";
  return "";
}

/**
 * Extract the SCHEDULED date from block content.
 * Logseq formats: SCHEDULED: <2025-01-14 Tue>  or  <2025-01-14 Tue 09:00>
 * Returns a Date object or null.
 */
function parseScheduled(content) {
  const m = content.match(/SCHEDULED:\s*<(\d{4}-\d{2}-\d{2})(?:\s+\w+)?(?:\s+[\d:]+)?>/i);
  if (!m) return null;
  const parts = m[1].split("-");
  return new Date(Number(parts[0]), Number(parts[1])-1, Number(parts[2]));
}

/**
 * Remove all Logseq noise from block content before displaying:
 *  - :LOGBOOK: ... :END:  blocks (clock entries live here)
 *  - Standalone CLOCK: lines
 *  - SCHEDULED: / DEADLINE: lines
 *  - Inline property lines (key:: value)
 */
function cleanContent(raw) {
  return raw
    // Remove :LOGBOOK: ... :END: block (multiline)
    .replace(/:LOGBOOK:[\s\S]*?:END:/gi, "")
    // Remove CLOCK: lines
    .replace(/^CLOCK:.*$/gim, "")
    // Remove SCHEDULED: and DEADLINE: lines
    .replace(/^(?:SCHEDULED|DEADLINE):\s*<[^>]+>.*$/gim, "")
    // Remove standalone inline properties (key:: value on their own line)
    .replace(/^\s*\w[\w-]*::\s*.+$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripMarker(content) {
  return content
    .replace(/^(TODO|DOING|DONE|WAITING)[\s\t]+/i, "")
    .replace(/^\[#[A-C]\][\s\t]*/,  "")
    .replace(/^#[A-C][\s\t]*/,      "")
    .replace(/assignee::\s*(?:\[\[[^\]]+\]\]|\S+)/gi, "")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function buildContent(marker, priority, text, assignee) {
  let c = marker;
  if (priority) c += " [#" + priority + "]";
  c += " " + text.trim();
  if (assignee && assignee.trim()) {
    // Wrap in [[]] if not already
    const a = assignee.trim();
    const wrapped = (a.startsWith("[[") && a.endsWith("]]")) ? a : "[[" + a + "]]";
    c += " assignee::" + wrapped;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Logseq write helpers
// ---------------------------------------------------------------------------

async function changeMarker(uuid, newMarker) {
  try {
    const block = await logseq.Editor.getBlock(uuid, { includeChildren: false });
    if (!block) return false;
    const newContent = block.content.replace(/^(TODO|DOING|DONE|WAITING)([\s\t])/i, newMarker + "$2");
    if (newContent === block.content) return false;
    await logseq.Editor.updateBlock(uuid, newContent);
    return true;
  } catch (err) { console.error("[Kanban] changeMarker:", err); return false; }
}

async function changePriority(uuid, newPriority) {
  try {
    const block = await logseq.Editor.getBlock(uuid, { includeChildren: false });
    if (!block) return false;
    let content = block.content.replace(/^(TODO|DOING|DONE|WAITING)([\s\t]+)(?:\[#[A-C]\]|#[A-C])[\s\t]*/i, "$1$2");
    if (newPriority) content = content.replace(/^(TODO|DOING|DONE|WAITING)([\s\t]+)/i, "$1$2[#" + newPriority + "] ");
    await logseq.Editor.updateBlock(uuid, content);
    return true;
  } catch (err) { console.error("[Kanban] changePriority:", err); return false; }
}

async function changeAssignee(uuid, assignee) {
  try {
    const block = await logseq.Editor.getBlock(uuid, { includeChildren: false });
    if (!block) return false;
    let content = block.content.replace(/\s*assignee::\s*(?:\[\[[^\]]+\]\]|\S+)/gi, "").trim();
    if (assignee && assignee.trim()) {
      const a = assignee.trim();
      const wrapped = (a.startsWith("[[") && a.endsWith("]]")) ? a : "[[" + a + "]]";
      content += " assignee::" + wrapped;
    }
    await logseq.Editor.updateBlock(uuid, content);
    return true;
  } catch (err) { console.error("[Kanban] changeAssignee:", err); return false; }
}

async function createTask(marker, priority, text, assignee) {
  try {
    const todayName = await getTodayPageName();
    const content   = buildContent(marker, priority, text, assignee);
    return await logseq.Editor.appendBlockInPage(todayName, content);
  } catch (err) {
    logseq.UI.showMsg("Failed to create task", "error");
    return null;
  }
}

/**
 * Create a "status check" follow-up block on today's journal page,
 * mentioning the assignee so they get a notification in Logseq.
 */
async function requestStatus(task) {
  try {
    const todayName = await getTodayPageName();
    const at = task.assignee ? "@" + task.assignee : "(unassigned)";
    const content = "TODO Status check with " + at + " re: " + task.text.slice(0,80) + " #follow-up";
    await logseq.Editor.appendBlockInPage(todayName, content);
    logseq.UI.showMsg("Follow-up added to today\u2019s journal", "success");
  } catch (err) {
    logseq.UI.showMsg("Could not create follow-up: " + err.message, "error");
  }
}

async function navigateToBlock(uuid) {
  try {
    const block = await logseq.Editor.getBlock(uuid, { includeChildren: false });
    if (!block) { logseq.UI.showMsg("Block not found", "warning"); return; }
    const page = await logseq.Editor.getPage(block.page.id);
    const pageName = (page && (page.originalName || page.name)) || String(block.page.id);
    await logseq.Editor.scrollToBlockInPage(pageName, block.uuid);
    destroyPanel();
  } catch (_) {
    try {
      const block = await logseq.Editor.getBlock(uuid, { includeChildren: false });
      if (block) {
        const page = await logseq.Editor.getPage(block.page.id);
        await logseq.App.pushState("page", { name: (page && (page.originalName || page.name)) || String(block.page.id) });
        destroyPanel();
      }
    } catch (__) { logseq.UI.showMsg("Could not navigate to block", "error"); }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatUUID(uuid) {
  if (typeof uuid === "string") return uuid;
  if (uuid && typeof uuid.toString === "function") return uuid.toString();
  return String(uuid);
}

function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function formatMarkdown(text) {
  let s = String(text).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(.+?)__/g,     "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+?)\*/g, "<em>$1</em>");
  s = s.replace(/_([^_\n]+?)_/g,   "<em>$1</em>");
  s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");
  s = s.replace(/`([^`]+)`/g, '<code style="font-family:monospace;font-size:11px;background:var(--ls-secondary-background-color,#f0f4f8);padding:0 3px;border-radius:3px;">$1</code>');
  s = s.replace(/==(.+?)==/g, '<mark style="background:#fef08a;color:inherit;border-radius:2px;padding:0 2px;">$1</mark>');
  return s;
}

function getCurrentMarker(uuid) {
  let found = null;
  Object.keys(lastTasks).forEach(function(m) {
    if (lastTasks[m].some(function(t) { return t.uuid === uuid; })) found = m;
  });
  return found;
}

function getTask(uuid) {
  let found = null;
  Object.keys(lastTasks).forEach(function(m) {
    lastTasks[m].forEach(function(t) { if (t.uuid === uuid) found = t; });
  });
  return found;
}

/** Tasks visible under current assignee filter.
 *  "mine"   = assigned to me OR unassigned (unassigned tasks default to me)
 *  "others" = assigned to someone else explicitly
 *  "all"    = everything
 */
function visibleTasks() {
  const result = {};
  Object.keys(lastTasks).forEach(function(m) {
    result[m] = lastTasks[m].filter(function(t) {
      if (filterAssignee === "mine") {
        // No assignee = mine; or explicitly assigned to me
        if (!t.assignee) return true;
        return t.assignee.replace(/^\[\[|\]\]$/g,"").toLowerCase() === myName.toLowerCase();
      }
      if (filterAssignee === "others") {
        if (!t.assignee) return false;
        return t.assignee.replace(/^\[\[|\]\]$/g,"").toLowerCase() !== myName.toLowerCase();
      }
      return true;
    });
  });
  return result;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function injectStyles() {
  const old = parent.document.getElementById(STYLE_ID);
  if (old) old.remove();
  const s = parent.document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    .kb-panel {
      position: fixed; top: 52px; right: 16px;
      width: 880px; max-width: calc(100vw - 32px);
      max-height: calc(100vh - 72px);
      display: flex; flex-direction: column;
      background: var(--ls-primary-background-color, #fff);
      border: 1px solid var(--ls-border-color, #e2e8f0);
      border-radius: 14px; box-shadow: 0 16px 48px rgba(0,0,0,0.20);
      z-index: 9999;
      font-family: var(--ls-font-family, system-ui, sans-serif);
      font-size: 13px; color: var(--ls-primary-text-color, #1a202c);
      opacity: 0; transform: translateY(-12px) scale(0.97);
      transition: opacity 0.2s ease, transform 0.2s ease;
      overflow: hidden;
    }
    .kb-panel--visible { opacity: 1; transform: translateY(0) scale(1); }

    /* ---- Header ---- */
    .kb-header {
      display: flex; flex-direction: column;
      border-bottom: 1px solid var(--ls-border-color, #e2e8f0); flex-shrink: 0;
    }
    .kb-header-top {
      display: flex; align-items: center; justify-content: space-between;
      padding: 11px 16px 6px;
    }
    .kb-header-left  { display: flex; align-items: center; gap: 10px; }
    .kb-header-right { display: flex; align-items: center; gap: 8px; }
    .kb-title    { font-size: 15px; font-weight: 700; letter-spacing: -.02em; }
    .kb-subtitle { font-size: 11px; opacity: .4; }

    /* ---- Progress bar ---- */
    .kb-progress-row {
      padding: 0 16px 10px;
      display: flex; align-items: center; gap: 10px;
    }
    .kb-progress-track {
      flex: 1; height: 6px; border-radius: 3px;
      background: var(--ls-secondary-background-color, #e2e8f0);
      overflow: hidden;
    }
    .kb-progress-fill {
      height: 100%; border-radius: 3px;
      background: linear-gradient(90deg, #10b981, #34d399);
      transition: width .4s ease;
    }
    .kb-progress-label { font-size: 10px; opacity: .5; white-space: nowrap; }

    /* ---- Filters ---- */
    .kb-filters {
      padding: 0 16px 10px; display: flex; align-items: center; gap: 6px;
    }
    .kb-filter-pill {
      padding: 3px 10px; border-radius: 10px; font-size: 11px; font-weight: 600;
      border: 1px solid var(--ls-border-color, #e2e8f0); cursor: pointer;
      background: none; color: var(--ls-secondary-text-color, #718096);
      transition: all .12s;
    }
    .kb-filter-pill--active {
      background: var(--ls-link-text-color, #4a90d9);
      border-color: var(--ls-link-text-color, #4a90d9); color: #fff;
    }

    .kb-refresh-btn {
      background: none; border: 1px solid var(--ls-border-color, #e2e8f0);
      border-radius: 6px; padding: 4px 8px; cursor: pointer;
      display: flex; align-items: center; gap: 4px;
      font-size: 11px; font-weight: 600;
      color: var(--ls-primary-text-color, #1a202c);
      opacity: .6; transition: opacity .15s;
    }
    .kb-refresh-btn:hover { opacity: 1; }
    .kb-refresh-btn.kb-spinning svg { animation: kb-spin 0.7s linear infinite; }
    @keyframes kb-spin { to { transform: rotate(360deg); } }

    .kb-close-btn {
      background: none; border: none; cursor: pointer; font-size: 18px;
      opacity: .4; padding: 0 3px; line-height: 1;
      color: var(--ls-primary-text-color, #1a202c); transition: opacity .15s;
    }
    .kb-close-btn:hover { opacity: .9; }

    /* ---- Board ---- */
    .kb-board { display: grid; grid-template-columns: repeat(4,1fr); flex:1; overflow:hidden; }

    /* ---- Columns ---- */
    .kb-col { display:flex; flex-direction:column; border-right:1px solid var(--ls-border-color,#e2e8f0); overflow:hidden; }
    .kb-col:last-child { border-right:none; }
    .kb-col-header {
      display:flex; align-items:center; justify-content:space-between;
      padding:10px 12px 8px; flex-shrink:0;
      border-bottom:1px solid var(--ls-border-color,#e2e8f0);
    }
    .kb-col-label { display:flex; align-items:center; gap:7px; font-size:11px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    .kb-col-dot   { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
    .kb-col-count { font-size:10px; font-weight:700; background:var(--ls-secondary-background-color,#f0f4f8); border-radius:10px; padding:1px 7px; opacity:.7; }
    .kb-col-body  { overflow-y:auto; flex:1; padding:8px 8px 4px; scrollbar-width:thin; }
    .kb-col-body.kb-drag-over { background:rgba(74,144,217,0.06); outline:2px dashed var(--ls-link-text-color,#4a90d9); outline-offset:-3px; border-radius:4px; }

    /* ---- Cards ---- */
    .kb-card {
      background:var(--ls-primary-background-color,#fff);
      border:1px solid var(--ls-border-color,#e8edf2);
      border-radius:8px; padding:8px 10px 7px; margin-bottom:6px;
      cursor:grab; transition:box-shadow .15s,transform .12s,opacity .15s;
      position:relative; overflow:hidden; user-select:none;
    }
    .kb-card::before { content:""; position:absolute; left:0; top:0; bottom:0; width:3px; border-radius:8px 0 0 8px; }
    .kb-card:hover   { box-shadow:0 3px 12px rgba(0,0,0,.10); transform:translateY(-1px); }
    .kb-card:active  { cursor:grabbing; }
    .kb-card.kb-card--dragging { opacity:.3; transform:scale(0.96); }

    .kb-card-top     { display:flex; align-items:flex-start; gap:6px; }
    .kb-priority     { flex-shrink:0; width:18px; height:18px; border-radius:4px; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:800; color:#fff; margin-top:1px; }
    .kb-priority--none { opacity:0; pointer-events:none; }
    .kb-card-text    { font-size:12px; line-height:1.5; word-break:break-word; flex:1; }
    .kb-card-actions { display:flex; gap:1px; flex-shrink:0; opacity:0; transition:opacity .15s; margin-top:1px; }
    .kb-card:hover .kb-card-actions { opacity:1; }
    .kb-card-btn {
      background:none; border:none; cursor:pointer; border-radius:3px;
      padding:2px 3px; display:flex; align-items:center;
      opacity:.5; transition:opacity .15s,background .15s;
      color:var(--ls-primary-text-color,#1a202c);
    }
    .kb-card-btn:hover { opacity:1; background:var(--ls-secondary-background-color,#e2e8f0); }

    /* Assignee chip */
    .kb-card-meta    { display:flex; align-items:center; gap:6px; margin-top:5px; padding-left:24px; flex-wrap:wrap; }
    .kb-card-page    { font-size:10px; opacity:.4; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:110px; }
    .kb-card-page-icon { opacity:.3; flex-shrink:0; }
    .kb-assignee-chip {
      font-size:10px; font-weight:700; padding:1px 6px; border-radius:8px;
      background:var(--ls-secondary-background-color,#e2e8f0);
      color:var(--ls-secondary-text-color,#4a5568);
      display:flex; align-items:center; gap:3px; flex-shrink:0;
    }
    .kb-assignee-chip--mine { background:#dbeafe; color:#1d4ed8; }
    .kb-scheduled-chip {
      font-size:10px; font-weight:700; padding:1px 6px; border-radius:8px;
      border:1px solid; display:flex; align-items:center; gap:3px; flex-shrink:0;
      background:transparent;
    }

    /* ---- Add task ---- */
    .kb-add-row { padding:0 8px 10px; flex-shrink:0; margin-top:6px; }
    .kb-add-btn {
      width:100%; background:none;
      border:1px dashed var(--ls-border-color,#d1d9e0); border-radius:7px; padding:6px 8px;
      cursor:pointer; font-size:11px; font-weight:600;
      color:var(--ls-secondary-text-color,#718096);
      display:flex; align-items:center; gap:5px;
      transition:border-color .15s,color .15s,background .15s;
    }
    .kb-add-btn:hover { border-color:var(--ls-link-text-color,#4a90d9); color:var(--ls-link-text-color,#4a90d9); background:rgba(74,144,217,.05); }
    .kb-add-form {
      padding:10px 10px 10px; flex-shrink:0;
      border-top:2px solid var(--ls-border-color,#e2e8f0);
      margin-top:4px;
    }
    .kb-add-priority-row { display:flex; gap:4px; margin-bottom:7px; }
    .kb-add-prio-btn {
      flex:1; border:1px solid var(--ls-border-color,#e2e8f0); border-radius:5px; padding:4px 0;
      cursor:pointer; font-size:10px; font-weight:800; background:none; transition:all .12s;
    }
    .kb-add-prio-btn.kb-prio-selected { color:#fff !important; border-color:transparent; }
    .kb-add-input {
      width:100%; box-sizing:border-box; border:1px solid var(--ls-link-text-color,#4a90d9);
      border-radius:6px; padding:7px 9px; font-size:12px; font-family:inherit;
      background:var(--ls-primary-background-color,#fff); color:var(--ls-primary-text-color,#1a202c);
      outline:none; resize:none; box-shadow:0 0 0 2px rgba(74,144,217,.12);
    }
    /* Assignee row with autocomplete */
    .kb-add-assignee-row { display:flex; align-items:center; gap:6px; margin-top:8px; position:relative; }
    .kb-add-assignee-wrap { flex:1; position:relative; }
    .kb-add-assignee-input {
      width:100%; box-sizing:border-box;
      border:1px solid var(--ls-border-color,#e2e8f0); border-radius:5px;
      padding:5px 9px; font-size:11px; font-family:inherit;
      background:var(--ls-primary-background-color,#fff); color:var(--ls-primary-text-color,#1a202c); outline:none;
    }
    .kb-add-assignee-input:focus { border-color:var(--ls-link-text-color,#4a90d9); }
    /* Suggestions dropdown */
    .kb-suggestions {
      position:absolute; top:calc(100% + 3px); left:0; right:0;
      background:var(--ls-primary-background-color,#fff);
      border:1px solid var(--ls-border-color,#e2e8f0);
      border-radius:7px; box-shadow:0 6px 20px rgba(0,0,0,.13);
      z-index:10002; overflow:hidden; max-height:160px; overflow-y:auto;
    }
    .kb-suggestion-item {
      padding:7px 12px; cursor:pointer; font-size:12px;
      display:flex; align-items:center; gap:7px;
      transition:background .1s;
    }
    .kb-suggestion-item:hover, .kb-suggestion-item.kb-suggestion--active {
      background:var(--ls-secondary-background-color,#f0f7ff);
    }
    .kb-suggestion-match { font-weight:700; color:var(--ls-link-text-color,#4a90d9); }
    .kb-add-form-actions { display:flex; gap:5px; margin-top:8px; }
    .kb-add-save-btn   { border:none; border-radius:5px; padding:5px 14px; font-size:11px; font-weight:700; cursor:pointer; background:var(--ls-link-text-color,#4a90d9); color:#fff; }
    .kb-add-save-btn:hover { opacity:.85; }
    .kb-add-cancel-btn { border:none; border-radius:5px; padding:5px 10px; font-size:11px; font-weight:600; cursor:pointer; background:var(--ls-secondary-background-color,#e2e8f0); color:var(--ls-primary-text-color,#1a202c); }
    .kb-add-cancel-btn:hover { opacity:.7; }

    /* ---- Empty / Skeleton ---- */
    .kb-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:24px 12px; opacity:.25; gap:6px; font-size:11px; text-align:center; }
    .kb-skeleton { border-radius:8px; margin-bottom:6px; background:linear-gradient(90deg,var(--ls-secondary-background-color,#f0f4f8) 25%,var(--ls-border-color,#e2e8f0) 50%,var(--ls-secondary-background-color,#f0f4f8) 75%); background-size:200% 100%; animation:kb-shimmer 1.4s infinite; }
    @keyframes kb-shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }

    /* ---- Footer ---- */
    .kb-footer { border-top:1px solid var(--ls-border-color,#e2e8f0); padding:6px 18px; font-size:10px; opacity:.3; display:flex; align-items:center; justify-content:space-between; flex-shrink:0; }

    /* ---- Context menu ---- */
    .kb-ctx-menu { position:fixed; z-index:10001; background:var(--ls-primary-background-color,#fff); border:1px solid var(--ls-border-color,#e2e8f0); border-radius:9px; box-shadow:0 8px 28px rgba(0,0,0,.18); padding:4px 0; min-width:180px; font-family:var(--ls-font-family,system-ui,sans-serif); font-size:12px; color:var(--ls-primary-text-color,#1a202c); }
    .kb-ctx-section { padding:5px 12px 3px; font-size:10px; font-weight:700; letter-spacing:.07em; text-transform:uppercase; opacity:.38; }
    .kb-ctx-item    { display:flex; align-items:center; gap:8px; padding:6px 14px; cursor:pointer; transition:background .1s; }
    .kb-ctx-item:hover { background:var(--ls-secondary-background-color,#f0f4f8); }
    .kb-ctx-item--active { opacity:.32; cursor:default; pointer-events:none; }
    .kb-ctx-dot  { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
    .kb-ctx-badge { width:16px; height:16px; border-radius:3px; display:flex; align-items:center; justify-content:center; font-size:9px; font-weight:800; color:#fff; flex-shrink:0; }
    .kb-ctx-sep  { height:1px; background:var(--ls-border-color,#e2e8f0); margin:3px 0; }
    .kb-ctx-assignee-input {
      margin:4px 12px 6px; width:calc(100% - 24px); box-sizing:border-box;
      border:1px solid var(--ls-border-color,#e2e8f0); border-radius:5px;
      padding:4px 8px; font-size:11px; font-family:inherit; outline:none;
      background:var(--ls-primary-background-color,#fff);
      color:var(--ls-primary-text-color,#1a202c);
    }
    .kb-ctx-assignee-input:focus { border-color:var(--ls-link-text-color,#4a90d9); }
  `;
  parent.document.head.appendChild(s);
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function iconKanban(sz, color) {
  sz=sz||18; color=color||"var(--ls-link-text-color,#4a90d9)";
  return '<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="'+color+'" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="6" height="18" rx="1.5"/><rect x="9" y="3" width="6" height="18" rx="1.5"/><rect x="17" y="3" width="6" height="18" rx="1.5"/><line x1="2.5" y1="6.5" x2="5.5" y2="6.5"/><line x1="2.5" y1="9" x2="5.5" y2="9"/><line x1="10.5" y1="6.5" x2="13.5" y2="6.5"/><line x1="18.5" y1="6.5" x2="21.5" y2="6.5"/><line x1="18.5" y1="9" x2="21.5" y2="9"/></svg>';
}
function iconRefresh(sz) { sz=sz||13; return '<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>'; }
function iconLink(sz)    { sz=sz||11; return '<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'; }
function iconArrows(sz)  { sz=sz||11; return '<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'; }
function iconPlus(sz)    { sz=sz||12; return '<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'; }
function iconPage(sz)    { sz=sz||10; return '<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'; }
function iconUser(sz)    { sz=sz||11; return '<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'; }
function iconBell(sz)    { sz=sz||11; return '<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'; }
function iconClock(sz, color) { sz=sz||10; color=color||"currentColor"; return '<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="'+color+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'; }

/**
 * Format a scheduled Date for the card chip.
 * Returns { label, color, title } \u2014 label is compact for small space.
 */
function buildScheduledChip(scheduled) {
  if (!scheduled) return "";
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sched = new Date(scheduled.getFullYear(), scheduled.getMonth(), scheduled.getDate());
  const diffDays = Math.round((sched - today) / 86400000);

  let color, label, title;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  if (diffDays < 0) {
    // Overdue
    color = "#ef4444";
    label = diffDays === -1 ? "Yesterday" : Math.abs(diffDays) + "d ago";
    title = "Overdue: scheduled " + months[scheduled.getMonth()] + " " + scheduled.getDate();
  } else if (diffDays === 0) {
    // Today
    color = "#f59e0b";
    label = "Today";
    title = "Due today";
  } else if (diffDays === 1) {
    color = "#f59e0b";
    label = "Tomorrow";
    title = "Due tomorrow";
  } else if (diffDays <= 7) {
    color = "#6b7280";
    label = "in " + diffDays + "d";
    title = "Scheduled " + months[scheduled.getMonth()] + " " + scheduled.getDate();
  } else {
    color = "#6b7280";
    label = months[scheduled.getMonth()] + " " + scheduled.getDate();
    title = "Scheduled " + scheduled.toLocaleDateString();
  }

  return '<span class="kb-scheduled-chip" style="color:' + color + ';border-color:' + color + '40;" title="' + esc(title) + '">' +
    iconClock(9, color) + label +
  '</span>';
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function buildProgress(tasks) {
  const active = ((tasks.TODO||[]).length + (tasks.DOING||[]).length + (tasks.WAITING||[]).length);
  const done   = (tasks.DONE||[]).length;
  const total  = active + done;
  if (total === 0) return "";

  const pct = Math.round((done / total) * 100);
  return [
    '<div class="kb-progress-row">',
      '<div class="kb-progress-track">',
        '<div class="kb-progress-fill" style="width:', pct, '%;"></div>',
      '</div>',
      '<span class="kb-progress-label">', done, " / ", total, " done (", pct, "%)</span>",
    "</div>",
  ].join("");
}

// ---------------------------------------------------------------------------
// Assignee filter pills
// ---------------------------------------------------------------------------

function buildFilterPills() {
  const pills = [
    { value:"all",    label:"All tasks" },
    { value:"mine",   label:"Assigned to me" },
    { value:"others", label:"Assigned to others" },
  ];
  return [
    '<div class="kb-filters">',
      pills.map(function(p) {
        return '<button class="kb-filter-pill' + (filterAssignee===p.value?" kb-filter-pill--active":"") + '" data-filter="' + p.value + '">' + p.label + '</button>';
      }).join(""),
    '</div>',
  ].join("");
}

// ---------------------------------------------------------------------------
// Card HTML
// ---------------------------------------------------------------------------

function buildPriorityBadge(priority) {
  if (!priority) return '<span class="kb-priority kb-priority--none"> </span>';
  const p = PRIORITIES.find(function(x){return x.value===priority;})||{color:"#9ca3af"};
  return '<span class="kb-priority" style="background:'+p.color+';" title="Priority '+priority+'">'+priority+'</span>';
}

function buildAssigneeChip(assignee) {
  if (!assignee) return "";
  const name  = displayAssignee(assignee);
  const isMe  = myName && name.toLowerCase() === myName.toLowerCase();
  const cls   = "kb-assignee-chip" + (isMe ? " kb-assignee-chip--mine" : "");
  return '<span class="' + cls + '">' + iconUser(9) + esc(name) + '</span>';
}

function buildCard(task, colColor) {
  const display      = task.text.length > 110 ? task.text.slice(0,107)+"..." : task.text;
  const formattedText= formatMarkdown(display);
  return [
    '<div class="kb-card" draggable="true" data-uuid="', esc(task.uuid), '">',
      '<style>.kb-card[data-uuid="', esc(task.uuid), '"]:before{background:', colColor, ';}</style>',
      '<div class="kb-card-top">',
        buildPriorityBadge(task.priority),
        '<div class="kb-card-text">', formattedText, '</div>',
        '<div class="kb-card-actions">',
          '<button class="kb-card-btn" data-action="navigate" data-uuid="', esc(task.uuid), '" title="Go to block">', iconLink(11), '</button>',
          '<button class="kb-card-btn" data-action="move-menu" data-uuid="', esc(task.uuid), '" title="Move / Priority / Assign">', iconArrows(11), '</button>',
        '</div>',
      '</div>',
      '<div class="kb-card-meta">',
        '<span class="kb-card-page-icon">', iconPage(), '</span>',
        '<span class="kb-card-page" title="', esc(task.pageName), '">', esc(task.displayPage||task.pageName), '</span>',
        buildScheduledChip(task.scheduled),
        buildAssigneeChip(task.assignee),
      '</div>',
    '</div>',
  ].join("");
}

// ---------------------------------------------------------------------------
// Add-task form
// ---------------------------------------------------------------------------

function buildAddForm(state) {
  const prioBtns = PRIORITIES.map(function(p) {
    const style = p.value ? 'color:'+p.color+';border-color:'+p.color+'20;' : 'color:#9ca3af;';
    return '<button class="kb-add-prio-btn" data-prio="'+p.value+'" style="'+style+'" title="'+p.title+'">'+( p.value || "\u2014")+'</button>';
  }).join("");

  return [
    '<div class="kb-add-row" data-state="', state, '">',
      '<button class="kb-add-btn" data-action="open-add" data-state="', state, '">', iconPlus(12), ' Task</button>',
    '</div>',
    '<div class="kb-add-form" data-state="', state, '" style="display:none;">',
      '<div class="kb-add-priority-row"><span style="font-size:10px;font-weight:700;opacity:.4;align-self:center;margin-right:2px;">Priority</span>', prioBtns, '</div>',
      '<textarea class="kb-add-input" placeholder="Task description..." rows="2"></textarea>',
      '<div class="kb-add-assignee-row">',
        '<span style="display:flex;align-items:center;gap:4px;font-size:10px;font-weight:700;opacity:.5;white-space:nowrap;">', iconUser(11), 'Assignee</span>',
        '<div class="kb-add-assignee-wrap">',
          '<input class="kb-add-assignee-input" placeholder="[[First Lastname]] or type to search..." autocomplete="off"/>',
          // Dropdown injected here by JS
        '</div>',
      '</div>',
      '<div class="kb-add-form-actions">',
        '<button class="kb-add-save-btn" data-action="save-add" data-state="', state, '">Add</button>',
        '<button class="kb-add-cancel-btn" data-action="cancel-add" data-state="', state, '">Cancel</button>',
      '</div>',
    '</div>',
  ].join("");
}

// ---------------------------------------------------------------------------
// Column + board HTML
// ---------------------------------------------------------------------------

function buildColumn(col, tasks, loading) {
  loading = loading || false;
  const count = tasks ? tasks.length : 0;
  let cards;
  if (loading) {
    cards = [52,68,52].map(function(h){ return '<div class="kb-skeleton" style="height:'+h+'px;"></div>'; }).join("");
  } else if (tasks && tasks.length) {
    cards = tasks.map(function(t){ return buildCard(t, col.color); }).join("");
  } else {
    cards = '<div class="kb-empty"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg><span>Nothing here</span></div>';
  }
  return [
    '<div class="kb-col" data-state="', col.state, '">',
      '<div class="kb-col-header" style="background:', col.bg, ';">',
        '<div class="kb-col-label"><span class="kb-col-dot" style="background:', col.color, ';"></span><span style="color:', col.color, ';">', col.label, '</span></div>',
        '<span class="kb-col-count">', loading?"...":count, '</span>',
      '</div>',
      '<div class="kb-col-body" data-col-state="', col.state, '">', cards, '</div>',
      buildAddForm(col.state),
    '</div>',
  ].join("");
}

function buildPanelHTML(tasks, loading) {
  loading = loading || false;
  const shown = visibleTasks();
  const total = Object.values(lastTasks).reduce(function(s,a){return s+a.length;},0);
  const subtitle = loading ? "Refreshing..." : total + " task" + (total!==1?"s":"") + " across your graph";

  return [
    '<div class="kb-header">',
      '<div class="kb-header-top">',
        '<div class="kb-header-left">',
          iconKanban(18),
          '<span class="kb-title">Kanban Board</span>',
          '<span class="kb-subtitle" id="kb-subtitle">', subtitle, '</span>',
        '</div>',
        '<div class="kb-header-right">',
          '<button class="kb-refresh-btn', loading?" kb-spinning":"", '" id="kb-refresh" title="Refresh">', iconRefresh(12), ' Refresh</button>',
          '<button class="kb-close-btn" id="kb-close">\u00D7</button>',
        '</div>',
      '</div>',
      buildProgress(lastTasks),
      buildFilterPills(),
    '</div>',
    '<div class="kb-board" id="kb-board">',
      COLUMNS.map(function(col){ return buildColumn(col, shown[col.state]||[], loading); }).join(""),
    '</div>',
    '<div class="kb-footer"><span>Logseq Kanban v1.4.0</span></div>',
  ].join("");
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

function showContextMenu(x, y, uuid, currentMarker, currentPriority, currentAssignee) {
  closeContextMenu();
  const menu = parent.document.createElement("div");
  menu.id = MENU_ID; menu.className = "kb-ctx-menu";

  const rows = [];
  rows.push('<div class="kb-ctx-section">Move to</div>');
  COLUMNS.forEach(function(col) {
    const active = col.state === currentMarker;
    rows.push('<div class="kb-ctx-item'+(active?" kb-ctx-item--active":"")+'" data-move-to="'+col.state+'" data-uuid="'+esc(uuid)+'"><span class="kb-ctx-dot" style="background:'+col.color+';"></span>'+col.label+(active?" \u2713":"")+' </div>');
  });

  rows.push('<div class="kb-ctx-sep"></div><div class="kb-ctx-section">Priority</div>');
  PRIORITIES.forEach(function(p) {
    const active = p.value === currentPriority;
    const badge = p.value
      ? '<span class="kb-ctx-badge" style="background:'+p.color+';">'+p.value+'</span>'
      : '<span class="kb-ctx-badge" style="background:#e5e7eb;color:#6b7280;">\u2014</span>';
    rows.push('<div class="kb-ctx-item'+(active?" kb-ctx-item--active":"")+'" data-set-priority="'+p.value+'" data-uuid="'+esc(uuid)+'">'+badge+p.title+(active?" \u2713":"")+'</div>');
  });

  rows.push('<div class="kb-ctx-sep"></div><div class="kb-ctx-section">Assignee</div>');
  rows.push('<div style="position:relative;margin:4px 12px 2px;"><input class="kb-ctx-assignee-input" style="margin:0;width:100%;box-sizing:border-box;" placeholder="[[First Lastname]]" value="'+esc(currentAssignee||"")+'"/></div>');
  rows.push('<div class="kb-ctx-item" data-action="ctx-set-assignee" data-uuid="'+esc(uuid)+'">' + iconUser(12) + ' Set assignee</div>');

  rows.push('<div class="kb-ctx-sep"></div>');
  if (currentAssignee) {
    rows.push('<div class="kb-ctx-item" data-action="ctx-request-status" data-uuid="'+esc(uuid)+'">' + iconBell(12) + ' Request status from @'+esc(currentAssignee)+'</div>');
  }
  rows.push('<div class="kb-ctx-item" data-action="ctx-navigate" data-uuid="'+esc(uuid)+'">' + iconLink(12) + ' Go to block</div>');

  menu.innerHTML = rows.join("");
  menu.style.left = x+"px"; menu.style.top = y+"px";
  parent.document.body.appendChild(menu);

  requestAnimationFrame(function() {
    const r = menu.getBoundingClientRect();
    if (r.right  > parent.innerWidth)  menu.style.left = (x-r.width-4)+"px";
    if (r.bottom > parent.innerHeight) menu.style.top  = (y-r.height-4)+"px";

    // Attach autocomplete to the assignee input in the context menu
    const ctxInp = menu.querySelector(".kb-ctx-assignee-input");
    if (ctxInp) attachAssigneeAutocomplete(ctxInp);
  });

  menu.addEventListener("click", async function(e) {
    const moveTo = e.target.closest("[data-move-to]");
    if (moveTo) { closeContextMenu(); await moveCard(moveTo.dataset.uuid, moveTo.dataset.moveTo); return; }
    const setPrio = e.target.closest("[data-set-priority]");
    if (setPrio) { closeContextMenu(); await updatePriority(setPrio.dataset.uuid, setPrio.dataset.setPriority); return; }

    const setAssignee = e.target.closest("[data-action='ctx-set-assignee']");
    if (setAssignee) {
      const inp = menu.querySelector(".kb-ctx-assignee-input");
      const name = inp ? inp.value.trim() : "";
      closeContextMenu();
      await updateAssignee(setAssignee.dataset.uuid, name);
      return;
    }
    const reqStatus = e.target.closest("[data-action='ctx-request-status']");
    if (reqStatus) {
      const task = getTask(reqStatus.dataset.uuid);
      closeContextMenu();
      if (task) await requestStatus(task);
      return;
    }
    const nav = e.target.closest("[data-action='ctx-navigate']");
    if (nav) { closeContextMenu(); await navigateToBlock(nav.dataset.uuid); }
  });

  // Also allow Enter in assignee input to set it
  const ctxAssigneeInp = menu.querySelector(".kb-ctx-assignee-input");
  if (ctxAssigneeInp) {
    ctxAssigneeInp.addEventListener("keydown", async function(e) {
      if (e.key !== "Enter") return;
      // Only fire if no autocomplete suggestion is active
      const box = ctxAssigneeInp.parentElement && ctxAssigneeInp.parentElement.querySelector(".kb-suggestions");
      const active = box && box.querySelector(".kb-suggestion--active");
      if (active) return; // let autocomplete handle it
      const name = ctxAssigneeInp.value.trim();
      const uuid2 = menu.querySelector("[data-action='ctx-set-assignee']").dataset.uuid;
      closeContextMenu();
      await updateAssignee(uuid2, name);
    });
  }
}

function closeContextMenu() {
  const old = parent.document.getElementById(MENU_ID);
  if (old) old.remove();
}

// ---------------------------------------------------------------------------
// Optimistic update helpers
// ---------------------------------------------------------------------------

async function moveCard(uuid, newMarker) {
  let task=null, oldMarker=null;
  Object.keys(lastTasks).forEach(function(m){ lastTasks[m].forEach(function(t){ if(t.uuid===uuid){task=t;oldMarker=m;} }); });
  if (!task||oldMarker===newMarker) return;
  lastTasks[oldMarker]=lastTasks[oldMarker].filter(function(t){return t.uuid!==uuid;});
  lastTasks[newMarker].unshift(Object.assign({},task));
  rerenderBoard();
  const ok=await changeMarker(uuid,newMarker);
  if (!ok){ lastTasks[newMarker]=lastTasks[newMarker].filter(function(t){return t.uuid!==uuid;}); lastTasks[oldMarker].unshift(task); rerenderBoard(); logseq.UI.showMsg("Failed to update task","error"); }
}

async function updatePriority(uuid, newPriority) {
  const task=getTask(uuid); if(!task) return;
  const old=task.priority; task.priority=newPriority;
  rerenderBoard();
  const ok=await changePriority(uuid,newPriority);
  if (!ok){ task.priority=old; rerenderBoard(); logseq.UI.showMsg("Failed to update priority","error"); }
}

async function updateAssignee(uuid, newAssignee) {
  const task=getTask(uuid); if(!task) return;
  const old=task.assignee; task.assignee=newAssignee;
  rerenderBoard();
  const ok=await changeAssignee(uuid,newAssignee);
  if (!ok){ task.assignee=old; rerenderBoard(); logseq.UI.showMsg("Failed to update assignee","error"); }
}

// ---------------------------------------------------------------------------
// Page autocomplete for assignee fields
// ---------------------------------------------------------------------------

/** Cache of all page names, loaded lazily on first keypress */
let _pageCache = null;

async function getPageNames() {
  if (_pageCache) return _pageCache;
  try {
    const pages = await logseq.DB.datascriptQuery(`
      [:find ?name
       :where [?p :block/original-name ?name]]
    `);
    _pageCache = (pages || []).map(function(r) { return String(r[0]); }).sort();
  } catch(_) {
    _pageCache = [];
  }
  return _pageCache;
}

function filterPages(query, allPages) {
  if (!query || query.length < 1) return [];
  const q = query.replace(/^\[\[|\]\]$/g,"").toLowerCase();
  if (!q) return [];
  return allPages
    .filter(function(p) { return p.toLowerCase().includes(q); })
    .slice(0, 8);
}

function highlightMatch(pageName, query) {
  const q = query.replace(/^\[\[|\]\]$/g,"");
  if (!q) return esc(pageName);
  const idx = pageName.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return esc(pageName);
  return esc(pageName.slice(0, idx)) +
    '<span class="kb-suggestion-match">' + esc(pageName.slice(idx, idx + q.length)) + '</span>' +
    esc(pageName.slice(idx + q.length));
}

/**
 * Attach live page-suggestion autocomplete to an assignee input.
 * Uses the host (parent) document for the dropdown since the input
 * is inside the panel iframe context.
 */
function attachAssigneeAutocomplete(input) {
  let activeIdx = -1;

  function closeSuggestions() {
    const existing = input.parentElement && input.parentElement.querySelector(".kb-suggestions");
    if (existing) existing.remove();
    activeIdx = -1;
  }

  function showSuggestions(pages, query) {
    closeSuggestions();
    if (!pages.length) return;

    const box = parent.document.createElement("div");
    box.className = "kb-suggestions";
    box.innerHTML = pages.map(function(p, i) {
      return '<div class="kb-suggestion-item" data-page="' + esc(p) + '" data-idx="' + i + '">' +
        iconUser(11) + highlightMatch(p, query) +
      '</div>';
    }).join("");

    // Click on suggestion
    box.addEventListener("mousedown", function(e) {
      e.preventDefault(); // prevent input blur before click fires
      const item = e.target.closest(".kb-suggestion-item");
      if (!item) return;
      input.value = "[[" + item.dataset.page + "]]";
      closeSuggestions();
      input.focus();
    });

    // Append inside the wrapper div
    if (input.parentElement) {
      input.parentElement.appendChild(box);
    }
  }

  input.addEventListener("input", async function() {
    const query = input.value;
    const pages = await getPageNames();
    const matches = filterPages(query, pages);
    showSuggestions(matches, query);
    activeIdx = -1;
  });

  input.addEventListener("keydown", function(e) {
    const box = input.parentElement && input.parentElement.querySelector(".kb-suggestions");
    const items = box ? box.querySelectorAll(".kb-suggestion-item") : [];

    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
      items.forEach(function(it, i) { it.classList.toggle("kb-suggestion--active", i === activeIdx); });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      items.forEach(function(it, i) { it.classList.toggle("kb-suggestion--active", i === activeIdx); });
    } else if (e.key === "Enter" && activeIdx >= 0 && items[activeIdx]) {
      e.preventDefault();
      e.stopPropagation();
      input.value = "[[" + items[activeIdx].dataset.page + "]]";
      closeSuggestions();
    } else if (e.key === "Escape") {
      closeSuggestions();
    }
  });

  input.addEventListener("blur", function() {
    // Small delay so mousedown on suggestion fires first
    setTimeout(closeSuggestions, 150);
  });
}

function rerenderBoard() {
  const board=parent.document.getElementById("kb-board");
  if (!board) return;
  const shown=visibleTasks();
  board.innerHTML=COLUMNS.map(function(col){ return buildColumn(col,shown[col.state]||[],false); }).join("");
  const panel=parent.document.getElementById(PANEL_ID);
  if (panel) attachBoardListeners(panel);

  const sub=parent.document.getElementById("kb-subtitle");
  if (sub){ const total=Object.values(lastTasks).reduce(function(s,a){return s+a.length;},0); sub.textContent=total+" task"+(total!==1?"s":"")+" across your graph"; }

  // Update progress bar
  const fill=parent.document.querySelector(".kb-progress-fill");
  const label=parent.document.querySelector(".kb-progress-label");
  if (fill&&label) {
    const active=(lastTasks.TODO||[]).length+(lastTasks.DOING||[]).length+(lastTasks.WAITING||[]).length;
    const done=(lastTasks.DONE||[]).length;
    const total2=active+done;
    const pct=total2?Math.round(done/total2*100):0;
    fill.style.width=pct+"%";
    label.textContent=done+" / "+total2+" done ("+pct+"%)";
  }

  // Update filter pills
  const filters=parent.document.querySelector(".kb-filters");
  if (filters) {
    filters.querySelectorAll(".kb-filter-pill").forEach(function(p){
      p.classList.toggle("kb-filter-pill--active", p.dataset.filter===filterAssignee);
    });
  }

  const rb=parent.document.getElementById("kb-refresh");
  if (rb) rb.classList.remove("kb-spinning");
}

// ---------------------------------------------------------------------------
// Panel lifecycle
// ---------------------------------------------------------------------------

function renderPanel(tasks, loading) {
  loading=loading||false;
  const existing=parent.document.getElementById(PANEL_ID);
  if (existing) {
    if (!loading) { rerenderBoard(); }
    else {
      const rb=existing.querySelector("#kb-refresh"); if(rb) rb.classList.add("kb-spinning");
      const sub=existing.querySelector("#kb-subtitle"); if(sub) sub.textContent="Refreshing...";
    }
    return;
  }
  injectStyles();
  const panel=parent.document.createElement("div");
  panel.id=PANEL_ID; panel.className="kb-panel";
  panel.innerHTML=buildPanelHTML(tasks,loading);
  parent.document.body.appendChild(panel);
  requestAnimationFrame(function(){ panel.classList.add("kb-panel--visible"); });
  attachPanelListeners(panel);
}

function destroyPanel() {
  closeContextMenu();
  const el=parent.document.getElementById(PANEL_ID);
  if(!el) return;
  el.classList.remove("kb-panel--visible");
  setTimeout(function(){el.remove();},200);
  panelOpen=false;
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function attachPanelListeners(panel) {
  panel.querySelector("#kb-close").addEventListener("click",destroyPanel);
  panel.querySelector("#kb-refresh").addEventListener("click",function(){if(!isLoading)loadAndRender();});

  // Filter pills
  panel.addEventListener("click",function(e){
    const pill=e.target.closest(".kb-filter-pill[data-filter]");
    if(!pill) return;
    filterAssignee=pill.dataset.filter;
    rerenderBoard();
  });

  attachBoardListeners(panel);
}

function attachBoardListeners(panel) {
  const board=panel.querySelector("#kb-board");
  if(!board) return;

  board.addEventListener("click",async function(e){
    closeContextMenu();

    const prio=e.target.closest(".kb-add-prio-btn");
    if(prio){
      const form=prio.closest(".kb-add-form"); if(!form) return;
      form.querySelectorAll(".kb-add-prio-btn").forEach(function(b){b.classList.remove("kb-prio-selected");b.style.background="";});
      const pv=prio.dataset.prio;
      if(pv){ const pd=PRIORITIES.find(function(x){return x.value===pv;}); prio.classList.add("kb-prio-selected"); prio.style.background=pd?pd.color:"#9ca3af"; prio.style.color="#fff"; }
      return;
    }

    const btn=e.target.closest("[data-action]");
    if(btn){
      const action=btn.dataset.action, uuid=btn.dataset.uuid, state=btn.dataset.state;

      if(action==="navigate"){ e.stopPropagation(); await navigateToBlock(uuid); return; }

      if(action==="move-menu"){
        e.stopPropagation();
        const task=getTask(uuid);
        const r=btn.getBoundingClientRect();
        showContextMenu(r.right+6,r.top,uuid,getCurrentMarker(uuid),task?task.priority:"",task?task.assignee:"");
        return;
      }

      if(action==="open-add"){
        board.querySelectorAll(".kb-add-form").forEach(function(f){f.style.display="none";});
        board.querySelectorAll(".kb-add-row").forEach(function(r2){r2.style.display="";});
        const col=btn.closest(".kb-col"); if(!col) return;
        col.querySelector(".kb-add-row").style.display="none";
        const form=col.querySelector(".kb-add-form"); form.style.display="block";
        form.querySelectorAll(".kb-add-prio-btn").forEach(function(b){b.classList.remove("kb-prio-selected");b.style.background="";const pd=PRIORITIES.find(function(x){return x.value===b.dataset.prio;});b.style.color=(pd&&pd.value)?pd.color:"#9ca3af";});
        const ta=form.querySelector(".kb-add-input"); if(ta){ta.value="";ta.focus();}
        const ai=form.querySelector(".kb-add-assignee-input");
        if(ai){
          ai.value="";
          // Attach autocomplete (idempotent \u2014 only once per input element)
          if (!ai._acAttached) { ai._acAttached = true; attachAssigneeAutocomplete(ai); }
        }
        return;
      }

      if(action==="cancel-add"){
        const col=btn.closest(".kb-col"); if(!col) return;
        col.querySelector(".kb-add-form").style.display="none";
        col.querySelector(".kb-add-row").style.display="";
        return;
      }

      if(action==="save-add"){
        const col=btn.closest(".kb-col"); if(!col) return;
        const form=col.querySelector(".kb-add-form");
        const ta=form.querySelector(".kb-add-input");
        const ai=form.querySelector(".kb-add-assignee-input");
        const text=(ta?ta.value:"").trim();
        if(!text){if(ta) ta.focus(); return;}
        const selPrio=form.querySelector(".kb-add-prio-btn.kb-prio-selected");
        const priority=selPrio?selPrio.dataset.prio:"";
        const assignee=(ai?ai.value:"").trim();

        btn.disabled=true; btn.textContent="Saving...";
        const block=await createTask(state,priority,text,assignee);
        if(block){
          const today=new Date();
          const jd=today.getFullYear()*10000+(today.getMonth()+1)*100+today.getDate();
          if(!lastTasks[state]) lastTasks[state]=[];
          lastTasks[state].unshift({uuid:block.uuid,text,priority,assignee,pageName:block.page?(block.page.originalName||block.page.name||""):"",displayPage:formatDay(jd),journalDay:jd});
          rerenderBoard();
          logseq.UI.showMsg("Task added","success");
        } else { btn.disabled=false; btn.textContent="Add"; }
        return;
      }
      return;
    }

    const card=e.target.closest(".kb-card[data-uuid]");
    if(card) await navigateToBlock(card.dataset.uuid);
  });

  board.addEventListener("contextmenu",function(e){
    const card=e.target.closest(".kb-card[data-uuid]"); if(!card) return;
    e.preventDefault();
    const task=getTask(card.dataset.uuid);
    showContextMenu(e.clientX,e.clientY,card.dataset.uuid,getCurrentMarker(card.dataset.uuid),task?task.priority:"",task?task.assignee:"");
  });

  board.addEventListener("keydown",function(e){
    if(e.key==="Enter"&&!e.shiftKey){
      const ta=e.target.closest(".kb-add-input"); if(!ta) return;
      e.preventDefault();
      const btn2=ta.closest(".kb-add-form").querySelector("[data-action='save-add']"); if(btn2) btn2.click();
    }
    if(e.key==="Escape"){
      const ta=e.target.closest(".kb-add-input"); if(!ta) return;
      const btn2=ta.closest(".kb-add-form").querySelector("[data-action='cancel-add']"); if(btn2) btn2.click();
    }
  });

  attachDragListeners(board);
}

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

function attachDragListeners(board){
  board.addEventListener("dragstart",function(e){
    const card=e.target.closest(".kb-card[data-uuid]"); if(!card) return;
    dragUUID=card.dataset.uuid; dragMarker=getCurrentMarker(dragUUID);
    e.dataTransfer.effectAllowed="move";
    setTimeout(function(){card.classList.add("kb-card--dragging");},0);
  });
  board.addEventListener("dragend",function(){
    board.querySelectorAll(".kb-card--dragging").forEach(function(c){c.classList.remove("kb-card--dragging");});
    board.querySelectorAll(".kb-drag-over").forEach(function(c){c.classList.remove("kb-drag-over");});
    dragUUID=null; dragMarker=null;
  });
  board.addEventListener("dragover",function(e){
    const body=e.target.closest(".kb-col-body"); if(!body) return;
    e.preventDefault(); e.dataTransfer.dropEffect="move";
    board.querySelectorAll(".kb-drag-over").forEach(function(c){if(c!==body)c.classList.remove("kb-drag-over");});
    body.classList.add("kb-drag-over");
  });
  board.addEventListener("dragleave",function(e){
    const body=e.target.closest(".kb-col-body");
    if(body&&!body.contains(e.relatedTarget)) body.classList.remove("kb-drag-over");
  });
  board.addEventListener("drop",async function(e){
    e.preventDefault();
    const body=e.target.closest(".kb-col-body"); if(!body) return;
    body.classList.remove("kb-drag-over");
    const newMarker=body.dataset.colState;
    if(!newMarker||!dragUUID||newMarker===dragMarker) return;
    await moveCard(dragUUID,newMarker);
  });
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

async function loadAndRender(){
  isLoading=true;
  _pageCache = null; // invalidate page name cache so suggestions are fresh
  renderPanel(lastTasks,true);
  try {
    const tasks=await fetchTasks();
    lastTasks=tasks;
    renderPanel(tasks,false);
  } catch(err) {
    logseq.UI.showMsg("Kanban: failed to load tasks","error");
    renderPanel(lastTasks,false);
  } finally { isLoading=false; }
}

// ---------------------------------------------------------------------------
// Toolbar + Bootstrap
// ---------------------------------------------------------------------------

function registerToolbarButton(){
  logseq.App.registerUIItem("toolbar",{
    key:"kanban-toggle",
    template:[
      '<a class="button kb-toolbar-btn" data-on-click="togglePanel" title="Kanban Board" style="display:flex;align-items:center;justify-content:center;">',
        '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">',
          '<rect x="1" y="3" width="6" height="18" rx="1.5"/><rect x="9" y="3" width="6" height="18" rx="1.5"/><rect x="17" y="3" width="6" height="18" rx="1.5"/>',
          '<line x1="2.5" y1="6.5" x2="5.5" y2="6.5"/><line x1="2.5" y1="9" x2="5.5" y2="9"/>',
          '<line x1="10.5" y1="6.5" x2="13.5" y2="6.5"/>',
          '<line x1="18.5" y1="6.5" x2="21.5" y2="6.5"/><line x1="18.5" y1="9" x2="21.5" y2="9"/>',
        '</svg>',
      '</a>',
    ].join(""),
  });
}

function main(){
  logseq.provideModel({
    async togglePanel(){
      if(panelOpen){destroyPanel();}
      else{
        panelOpen=true;
        await loadUserConfig();
        await loadAndRender();
      }
    },
  });
  registerToolbarButton();
  setTimeout(function(){
    try{ logseq.Editor.registerSlashCommand("Kanban Board",async function(){ panelOpen=true; await loadUserConfig(); await loadAndRender(); }); }catch(_){}
  },500);
  parent.document.addEventListener("click",function(e){
    closeContextMenu();
    if(!panelOpen) return;
    const panel=parent.document.getElementById(PANEL_ID);
    const menu=parent.document.getElementById(MENU_ID);
    if(menu&&menu.contains(e.target)) return;
    if(panel&&!panel.contains(e.target)&&!e.target.closest(".kb-toolbar-btn")) destroyPanel();
  });
  console.info("[Kanban] v1.4.0 loaded.");
}

logseq.ready(main).catch(console.error);
