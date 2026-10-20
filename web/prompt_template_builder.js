import { app } from "/scripts/app.js";

const NODE_TYPE = "ElvaxPromptTemplateBuilder";
const DEFAULT_NODE_WIDTH = 936;
const TYPES = ["string", "number", "boolean", "object", "array", "json"];
const HIDDEN_FIELDS_KEY = "__elvax_prompt_template_builder__";
const FIELD_COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e", "#10b981", "#14b8a6",
  "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef", "#ec4899",
  "#fca5a5", "#fdba74", "#fcd34d", "#fde047", "#bef264", "#86efac", "#6ee7b7", "#5eead4",
  "#67e8f9", "#7dd3fc", "#93c5fd", "#a5b4fc", "#c4b5fd", "#d8b4fe", "#f0abfc", "#f9a8d4",
];

function pointerSegment(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function parsePromptJSON(text) {
  const result = JSON.parse(text, (key, value, context) => {
    if (typeof value !== "number") return value;
    if (/^-?\d+$/.test(context.source) && !Number.isSafeInteger(value)) return JSON.rawJSON(context.source);
    if (!Number.isFinite(value)) throw new Error("JSON numbers must be finite.");
    return Number.isInteger(value) && !Number.isSafeInteger(value) ? JSON.rawJSON(context.source) : value;
  });
  const stack = [];
  for (const token of String(text).match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) || []) {
    if (token === "{" || token === "[") stack.push({ object: token === "{", key: true, names: new Set() });
    else if (token === "}" || token === "]") stack.pop();
    else if (token === ",") { if (stack.at(-1)?.object) stack.at(-1).key = true; }
    else if (token.startsWith('"') && stack.at(-1)?.object && stack.at(-1).key) {
      const frame = stack.at(-1);
      const name = JSON.parse(token);
      if (frame.names.has(name)) throw new Error(`Duplicate JSON field "${name}". Rename one of these fields.`);
      frame.names.add(name);
      frame.key = false;
    }
  }
  return result;
}

function normalizeItem(item) {
  const type = TYPES.includes(item?.type) ? item.type : "string";
  let value = item?.value ?? "";
  if (type === "object") value = Array.isArray(value) ? value.map(normalizeField) : [];
  if (type === "array") value = Array.isArray(value) ? value.map(normalizeItem) : [];
  return { type, value, expanded: Boolean(item?.expanded), hidden: Boolean(item?.hidden), color: FIELD_COLORS.includes(item?.color) ? item.color : "" };
}

function normalizeField(field) {
  const normalized = normalizeItem(field);
  return { key: String(field?.key ?? ""), ...normalized };
}

function containerRows(rows) {
  return rows.flatMap((row) => row.type === "object" || row.type === "array"
    ? [row, ...containerRows(row.value)] : []);
}

function visitContainers(rows, visit, path = "", arrayItems = false) {
  rows.forEach((row, index) => {
    const pointer = `${path}/${arrayItems ? index : pointerSegment(row.key)}`;
    if (row.type !== "object" && row.type !== "array") return;
    visit(row, pointer);
    visitContainers(row.value, visit, pointer, row.type === "array");
  });
}

function expansionState(rows) {
  const expanded = Object.create(null);
  visitContainers(rows, (row, path) => { expanded[path] = row.expanded === true; });
  return expanded;
}

function restoreExpansion(rows, expanded) {
  visitContainers(rows, (row, path) => {
    row.expanded = typeof expanded?.[path] === "boolean" ? expanded[path] : true;
  });
}

function collectUnnamedFields(rows, parent = "", arrayItems = false, unnamed = []) {
  rows.forEach((row, index) => {
    const key = String(row.key ?? "").trim();
    if (!arrayItems && !key) {
      unnamed.push({ parent, index, field: row });
    } else if (row.type === "object" || row.type === "array") {
      collectUnnamedFields(row.value, `${parent}/${arrayItems ? index : pointerSegment(key)}`, row.type === "array", unnamed);
    }
  });
  return unnamed;
}

function restoreUnnamedFields(rows, unnamed) {
  if (!Array.isArray(unnamed)) return;
  const parents = new Map([["", rows]]);
  visitContainers(rows, (row, path) => { parents.set(path, row.value); });
  const groups = new Map();
  for (const entry of unnamed) {
    if (typeof entry?.parent !== "string" || !Number.isInteger(entry.index) || entry.index < 0
      || !entry.field || String(entry.field.key ?? "").trim()) continue;
    const parent = parents.get(entry.parent);
    if (!parent) continue;
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(entry);
  }
  for (const [parent, entries] of groups) {
    entries.sort((a, b) => a.index - b.index);
    for (const entry of entries) parent.splice(Math.min(entry.index, parent.length), 0, normalizeField(entry.field));
  }
}

function parseBuilderData(value) {
  try {
    const saved = JSON.parse(value || "[]");
    if (Array.isArray(saved)) {
      return {
        rows: saved.map(normalizeField),
        keys: { video_count: "video_count", video_duration: "video_duration" },
        wrapValues: true,
      };
    }
    if (Array.isArray(saved?.fields)) {
      return {
        rows: saved.fields.map(normalizeField),
        keys: {
          video_count: String(saved.keys?.video_count ?? "video_count"),
          video_duration: String(saved.keys?.video_duration ?? "video_duration"),
        },
        wrapValues: saved.wrapValues == null ? true : Boolean(saved.wrapValues),
        fixedValues: saved.fixedValues && typeof saved.fixedValues === "object" ? saved.fixedValues : null,
        fixedEnabled: saved.fixedEnabled || null,
        filename: String(saved.filename || "Untitled").replace(/\.json$/i, ""),
        modified: Boolean(saved.modified),
      };
    }
    return { rows: [], keys: { video_count: "video_count", video_duration: "video_duration" }, wrapValues: true };
  } catch {
    return { rows: [], keys: { video_count: "video_count", video_duration: "video_duration" }, wrapValues: true };
  }
}

function isSerializedBuilderData(value) {
  try {
    const saved = JSON.parse(value);
    return Array.isArray(saved) || Array.isArray(saved?.fields);
  } catch {
    return false;
  }
}

function fixedValueText(key, value) {
  const text = String(value ?? "");
  const valid = key === "video_count" ? /^\d*$/.test(text) : /^\d*(?:\.\d*)?$/.test(text);
  return valid ? text : "";
}

function fieldFromValue(key, value, path, hiddenFields, fieldColors = {}) {
  const hidden = hiddenFields.has(path);
  const color = FIELD_COLORS.includes(fieldColors[path]) ? fieldColors[path] : "";
  if (JSON.isRawJSON(value)) return { key, type: "number", value: value.rawJSON, expanded: false, hidden, color };
  if (Array.isArray(value)) {
    return { key, type: "array", value: value.map((item, index) => itemFromValue(item, `${path}/${index}`, hiddenFields, fieldColors)), expanded: false, hidden, color };
  }
  if (value !== null && typeof value === "object") {
    return {
      key,
      type: "object",
      value: Object.entries(value).map(([childKey, childValue]) => fieldFromValue(childKey, childValue, `${path}/${pointerSegment(childKey)}`, hiddenFields, fieldColors)),
      expanded: false,
      hidden,
      color,
    };
  }
  if (value === null) return { key, type: "json", value: "null", expanded: false, hidden, color };
  return { key, type: typeof value, value: typeof value === "boolean" ? value : String(value), expanded: false, hidden, color };
}

function itemFromValue(value, path, hiddenFields, fieldColors = {}) {
  const field = fieldFromValue("", value, path, hiddenFields, fieldColors);
  return { type: field.type, value: field.value, expanded: field.expanded, hidden: field.hidden, color: field.color };
}

function valueFromRow(row, label, pointer = "", includeHidden = false, hiddenFields = null, fieldColors = null) {
  if (row.type === "number") {
    const value = parsePromptJSON(String(row.value));
    if (!JSON.isRawJSON(value) && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`Field "${label}" must contain a finite number.`);
    }
    return value;
  }
  if (row.type === "boolean") return row.value === true || String(row.value).toLowerCase() === "true";
  if (row.type === "json") return parsePromptJSON(row.value);
  if (row.type === "object") return objectFromRows(row.value, label, pointer, includeHidden, hiddenFields, fieldColors);
  if (row.type === "array") {
    return row.value.flatMap((item, index) => {
      const itemPointer = `${pointer}/${index}`;
      if (item.hidden) hiddenFields?.push(itemPointer);
      if (FIELD_COLORS.includes(item.color) && fieldColors) fieldColors[itemPointer] = item.color;
      if (item.hidden && !includeHidden) return [];
      return [valueFromRow(item, `${label}[${index + 1}]`, itemPointer, includeHidden, hiddenFields, fieldColors)];
    });
  }
  return String(row.value ?? "");
}

function objectFromRows(rows, path = "root", pointer = "", includeHidden = false, hiddenFields = null, fieldColors = null) {
  const names = new Set();
  return Object.fromEntries(rows.flatMap((row) => {
    const key = String(row.key || "").trim();
    if (!key) return [];
    const childPointer = `${pointer}/${pointerSegment(key)}`;
    if (row.hidden) hiddenFields?.push(childPointer);
    if (FIELD_COLORS.includes(row.color) && fieldColors) fieldColors[childPointer] = row.color;
    if (row.hidden && !includeHidden) return [];
    if (names.has(key)) throw new Error(`Duplicate field "${path}.${key}". Rename one of these fields.`);
    names.add(key);
    return [[key, valueFromRow(row, `${path}.${key}`, childPointer, includeHidden, hiddenFields, fieldColors)]];
  }));
}

function installNode(node) {
  if (node.__elvaxPromptTemplateBuilderInstalled) return;
  const dataWidget = node.widgets?.find((widget) => widget.name === "fields_json");
  const videoCountWidget = node.widgets?.find((widget) => widget.name === "video_count");
  const videoDurationWidget = node.widgets?.find((widget) => widget.name === "video_duration");
  if (!dataWidget || !videoCountWidget || !videoDurationWidget) return;
  node.__elvaxPromptTemplateBuilderInstalled = true;

  const savedData = parseBuilderData(dataWidget.value);
  const rows = savedData.rows;
  let fieldKeys = savedData.keys;
  let wrapValues = savedData.wrapValues;
  let fixedEnabled = savedData.fixedEnabled || {
    video_count: Number(videoCountWidget.value) > 0,
    video_duration: Number(videoDurationWidget.value) > 0,
  };
  let filename = savedData.filename || "Untitled";
  let modified = Boolean(savedData.modified);
  const root = document.createElement("div");
  let colorOverlay = null;
  let jsonOverlay = null;
  let loadRequest = 0;
  let dragState = null;
  const scrollTimers = new Set();
  let syncFrame = null;
  let layoutFrame = null;
  const pendingValueResizes = new Set();
  root.className = "elvax-prompt-template-builder";
  root.style.cssText = "position:relative;width:100%;box-sizing:border-box;padding:8px;color:var(--fg-color,#ddd);font:12px/1.4 sans-serif;";
  const dropMarker = document.createElement("div");
  dropMarker.className = "elvax-prompt-template-builder__drop-marker";
  dropMarker.hidden = true;

  const style = document.createElement("style");
  style.textContent = `
    .elvax-prompt-template-builder__head,.elvax-prompt-template-builder__row,.elvax-prompt-template-builder__fixed-row { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(48px,74px) minmax(0,1.5fr) max-content; gap:5px; align-items:center; }
    .elvax-prompt-template-builder__head { padding:0 1px 4px; color:var(--descrip-text,#999); font-size:10px; }
    .elvax-prompt-template-builder__row { margin-bottom:5px; align-items:start; }
    .elvax-prompt-template-builder__row--colored > :not(.elvax-prompt-template-builder__actions) { border-color:var(--elvax-field-color); background:var(--elvax-field-background); }
    .elvax-prompt-template-builder__fixed-fields { display:grid; gap:5px; margin-bottom:10px; }
    .elvax-prompt-template-builder__fixed-name { display:flex; min-width:0; align-items:center; gap:6px; }
    .elvax-prompt-template-builder__fixed-row input:disabled { opacity:.4; }
    .elvax-prompt-template-builder__fixed-number { display:flex; align-items:center; min-width:0; height:27px; border:1px solid var(--border-color,#555); border-radius:4px; background:var(--comfy-input-bg,#202020); }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__fixed-number input { flex:1; width:0; border:0; background:transparent; text-align:center; padding:4px 0; height:25px; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__number-step { display:flex; flex:0 0 20px; align-items:center; justify-content:center; align-self:stretch; width:20px; height:auto; padding:0; border:0; border-radius:0; background:transparent; color:#a9b7c2; transition:color 120ms; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__number-step:hover:not(:disabled) { background:transparent; color:#d2e5f3; }
    .elvax-prompt-template-builder__number-step svg { width:12px; height:12px; pointer-events:none; }
    .elvax-prompt-template-builder__number-step:disabled { opacity:.3; cursor:default; }
    .elvax-prompt-template-builder input,.elvax-prompt-template-builder select,.elvax-prompt-template-builder button,.elvax-prompt-template-builder textarea { min-width:0; box-sizing:border-box; height:27px; border:1px solid var(--border-color,#555); border-radius:4px; background:var(--comfy-input-bg,#202020); color:var(--fg-color,#ddd); font:inherit; }
    .elvax-prompt-template-builder input { width:100%; padding:4px 6px; }
    .elvax-prompt-template-builder select { width:100%; padding:2px 3px; }
    .elvax-prompt-template-builder select option { background:var(--comfy-input-bg,#202020); color:var(--fg-color,#ddd); }
    .elvax-prompt-template-builder textarea { width:100%; min-height:27px; padding:4px 6px; line-height:17px; }
    .elvax-prompt-template-builder__value-textarea { display:block; resize:none; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; white-space:pre; }
    .elvax-prompt-template-builder__value-textarea::-webkit-scrollbar { display:none; }
    .elvax-prompt-template-builder__value-textarea--wrap { overflow-x:hidden; overflow-wrap:anywhere; white-space:pre-wrap; }
    .elvax-prompt-template-builder__text-field { display:flex; align-items:stretch; min-width:0; overflow:hidden; border:1px solid var(--border-color,#555); border-radius:4px; background:var(--comfy-input-bg,#202020); }
    .elvax-prompt-template-builder__text-field:focus-within { border-color:#7899ba; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__text-field textarea { flex:1 1 0; width:0; min-width:0; min-height:25px; height:25px; padding:4px 6px; border:0; border-radius:0; background:transparent; outline:none; box-shadow:none; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__scroll-arrow { display:flex; flex:0 0 20px; align-items:center; justify-content:center; align-self:stretch; width:20px; height:auto; padding:0; border:0; border-radius:0; background:#ffffff06; color:#91a9bc; transition:color 120ms,background 120ms; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__scroll-arrow:hover { background:#ffffff12; color:#d2e5f3; }
    .elvax-prompt-template-builder__scroll-arrow svg { width:12px; height:12px; pointer-events:none; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__scroll-arrow:disabled,.elvax-prompt-template-builder .elvax-prompt-template-builder__scroll-arrow[hidden] { display:none; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__row--hidden .elvax-prompt-template-builder__scroll-arrow:disabled:not([hidden]) { display:flex; cursor:default; }
    .elvax-prompt-template-builder input[aria-invalid="true"] { border-color:#d86e78; }
    .elvax-prompt-template-builder button { padding:2px 5px; cursor:pointer; }
    .elvax-prompt-template-builder button:hover { border-color:#888; background:#383838; }
    .elvax-prompt-template-builder__action-button { border-color:#55728f !important; background:#34485a !important; }
    .elvax-prompt-template-builder__action-button:hover { border-color:#7899ba !important; background:#405b73 !important; }
    .elvax-prompt-template-builder__action-button--add { border-color:#61785e !important; background:#3c4939 !important; }
    .elvax-prompt-template-builder__action-button--add:hover { border-color:#829d7e !important; background:#4a5b46 !important; }
    .elvax-prompt-template-builder__fixed-actions { grid-column:3 / 5; display:flex; flex-wrap:nowrap; min-width:0; align-items:center; gap:6px; margin-left:10px; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__fixed-actions button { display:inline-flex; align-items:center; justify-content:center; flex:0 0 116px; width:116px; height:28px; padding:0 8px; border:1px solid #ffffff24 !important; border-radius:5px; background:#2b3035 !important; color:#d7dfe6; font-size:12px; font-weight:500; line-height:1; white-space:nowrap; box-shadow:none; transition:background 120ms,border-color 120ms,color 120ms; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__fixed-actions button:hover:not(:disabled) { border-color:#7899ba !important; background:#35414c !important; color:#fff; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__fixed-actions button:focus-visible { outline:2px solid #7899ba; outline-offset:2px; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__fixed-actions button:disabled { opacity:.4; cursor:default; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__fixed-actions .elvax-prompt-template-builder__wrap-toggle[data-active="true"] { border-color:#54836c !important; background:#283e34 !important; color:#b9e5ce; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__fixed-actions .elvax-prompt-template-builder__wrap-toggle[data-active="true"]:hover { background:#314c40 !important; border-color:#78ad91 !important; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__fixed-actions .elvax-prompt-template-builder__wrap-toggle[data-active="false"] { border-color:#825454 !important; background:#402c2f !important; color:#e7b5bb; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__fixed-actions .elvax-prompt-template-builder__wrap-toggle[data-active="false"]:hover { border-color:#ad7878 !important; background:#50363a !important; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__fixed-actions .elvax-prompt-template-builder__expand-toggle[data-active="true"] { border-color:#54836c !important; background:#283e34 !important; color:#b9e5ce; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__fixed-actions .elvax-prompt-template-builder__expand-toggle[data-active="true"]:hover { border-color:#78ad91 !important; background:#314c40 !important; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__fixed-actions .elvax-prompt-template-builder__expand-toggle[data-active="false"] { border-color:#825454 !important; background:#402c2f !important; color:#e7b5bb; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__fixed-actions .elvax-prompt-template-builder__expand-toggle[data-active="false"]:hover { border-color:#ad7878 !important; background:#50363a !important; }
    .elvax-prompt-template-builder__filename { display:flex; align-items:center; flex:0 1 210px; min-width:90px; max-width:100%; height:27px; box-sizing:border-box; padding:0 7px 0 0; gap:3px; border:1px solid #ffffff24; border-radius:5px; background:#242424; color:var(--descrip-text,#999); transition:border-color 120ms,background 120ms; }
    .elvax-prompt-template-builder__filename:hover { border-color:#ffffff45; background:#292929; }
    .elvax-prompt-template-builder__filename:focus-within { border-color:#7899ba; background:#242c34; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__filename input { flex:1 1 auto; width:0; height:25px; background:transparent; border:0; border-radius:0; text-overflow:ellipsis; outline:none; box-shadow:none; }
    .elvax-prompt-template-builder__filename-extension { flex:none; padding-left:5px; border-left:1px solid #ffffff18; font-size:11px; color:#9ca8b3; user-select:none; }
    .elvax-prompt-template-builder__modified { color:#edc966; flex:none; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__wrap-toggle { appearance:none; }
    .elvax-prompt-template-builder .elvax-prompt-template-builder__wrap-toggle::before,.elvax-prompt-template-builder .elvax-prompt-template-builder__wrap-toggle::after { content:none !important; display:none !important; }
    .elvax-prompt-template-builder__actions { display:flex; justify-content:flex-end; gap:4px; }
    .elvax-prompt-template-builder__actions .elvax-prompt-template-builder__icon-button,.elvax-prompt-template-builder__fixed-name .elvax-prompt-template-builder__icon-button { display:grid; width:26px; height:26px; flex:0 0 26px; place-items:center; padding:0; border:1px solid var(--border-color,#555); border-radius:6px; background:transparent; color:var(--descrip-text,#aaa); transition:color 120ms,border-color 120ms,background-color 120ms,transform 120ms; }
    .elvax-prompt-template-builder__drag-handle { cursor:grab !important; touch-action:none; }
    .elvax-prompt-template-builder__drag-handle:active { cursor:grabbing !important; }
    .elvax-prompt-template-builder__drag-handle svg { pointer-events:none; }
    .elvax-prompt-template-builder__row-group--dragging > .elvax-prompt-template-builder__row { opacity:.68; }
    .elvax-prompt-template-builder__drop-marker { position:absolute; z-index:2; height:4px; border-radius:4px; background:#8ab4d0; box-shadow:0 0 6px #8ab4d066; pointer-events:none; }
    .elvax-prompt-template-builder__row-group--drop-into > .elvax-prompt-template-builder__row { outline:1px solid #8ab4d0; outline-offset:1px; border-radius:5px; }
    .elvax-prompt-template-builder__icon-button svg { width:14px; height:14px; }
    .elvax-prompt-template-builder__icon-button:hover { transform:translateY(-1px); border-color:#888 !important; background:#3b3b3b !important; color:#fff !important; }
    .elvax-prompt-template-builder__icon-button:disabled { opacity:.35; cursor:default; transform:none; }
    .elvax-prompt-template-builder__icon-button--remove:hover { border-color:#a85d5d !important; background:#492d2d !important; color:#ffbaba !important; }
    .elvax-prompt-template-builder__row--hidden > :not(.elvax-prompt-template-builder__actions) { opacity:.42; }
    .elvax-prompt-template-builder__container-toggle { width:100%; overflow:hidden; text-align:left; text-overflow:ellipsis; white-space:nowrap; }
    .elvax-prompt-template-builder__nested { margin:2px 0 8px 12px; padding-left:9px; border-left:1px solid var(--border-color,#555); }
    .elvax-prompt-template-builder__nested-add { margin:0 0 5px; padding:3px 9px !important; }
    .elvax-prompt-template-builder__toolbar { display:flex; flex-wrap:wrap; gap:6px; margin-top:2px; padding-bottom:8px; }
    .elvax-prompt-template-builder__toolbar button { padding:3px 9px; }
    .elvax-prompt-template-builder__empty { margin:2px 0 7px; color:var(--descrip-text,#999); }
    .elvax-prompt-template-builder__overlay { position:fixed; inset:0; z-index:10000; display:grid; place-items:center; background:#0009; }
    .elvax-prompt-template-builder__dialog { display:flex; width:min(560px,80vw); height:min(440px,75vh); flex-direction:column; gap:8px; padding:12px; border:1px solid #555; border-radius:7px; background:var(--comfy-menu-bg,#292929); box-shadow:0 8px 30px #0009; }
    .elvax-prompt-template-builder__dialog textarea { flex:1; min-height:0; resize:none; padding:8px; border:1px solid #555; border-radius:4px; background:var(--comfy-input-bg,#202020); color:var(--fg-color,#ddd); font:12px/1.5 monospace; }
    .elvax-prompt-template-builder__dialog-actions { display:flex; justify-content:flex-end; gap:6px; }
    .elvax-prompt-template-builder__dialog.elvax-prompt-template-builder__color-dialog { width:min(340px,90vw); height:auto; color:var(--fg-color,#ddd); font:12px/1.4 sans-serif; }
    .elvax-prompt-template-builder__color-grid { display:grid; grid-template-columns:repeat(8,minmax(0,1fr)); gap:6px; }
    .elvax-prompt-template-builder__color-swatch { width:100%; height:30px; padding:0; border:2px solid transparent; border-radius:5px; cursor:pointer; }
    .elvax-prompt-template-builder__color-swatch:hover,.elvax-prompt-template-builder__color-swatch:focus-visible { outline:2px solid #fff; outline-offset:1px; }
    .elvax-prompt-template-builder__color-swatch[aria-pressed="true"] { border-color:#fff; box-shadow:inset 0 0 0 2px #202020; }
    .elvax-prompt-template-builder__color-dialog .elvax-prompt-template-builder__dialog-actions button { height:27px; padding:3px 9px; border:1px solid #555; border-radius:4px; background:var(--comfy-input-bg,#202020); color:var(--fg-color,#ddd); cursor:pointer; }
    .elvax-prompt-template-builder__color-dialog .elvax-prompt-template-builder__dialog-actions button[aria-pressed="true"] { border-color:#aaa; }
  `;
  root.append(style);

  const fixedControls = document.createElement("div");
  fixedControls.className = "elvax-prompt-template-builder__fixed-fields";
  const fixedInputs = new Map();
  for (const [key, widget] of [
    ["video_count", videoCountWidget],
    ["video_duration", videoDurationWidget],
  ]) {
    const line = document.createElement("div");
    line.className = "elvax-prompt-template-builder__fixed-row";
    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.value = fieldKeys[key];
    keyInput.__elvaxFixedKey = key;
    keyInput.placeholder = key;
    keyInput.title = key === "video_count"
      ? "Default: video_count. You can rename it, e.g. Number of unique videos."
      : "Default: video_duration. You can rename it, e.g. Video Duration In Seconds.";
    keyInput.__elvaxHelpTitle = keyInput.title;
    keyInput.setAttribute("aria-label", `${key} JSON key`);
    keyInput.addEventListener("input", () => {
      fieldKeys[key] = keyInput.value;
      sync();
    });
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = key === "video_count" ? "numeric" : "decimal";
    input.value = fixedValueText(key, widget.value);
    input.placeholder = "value";
    input.title = key === "video_count" ? "Number of videos" : "Video duration value";
    widget.value = input.value;
    input.setAttribute("aria-label", key);
    input.addEventListener("keydown", (event) => {
      if (["-", "+", "e", "E"].includes(event.key)
        || key === "video_count" && event.key === ".") event.preventDefault();
    });
    input.addEventListener("input", () => {
      input.value = fixedValueText(key, input.value);
      widget.value = input.value;
      widget.callback?.(widget.value, app.canvas, node);
      sync();
    });
    const commitValue = () => {
      if (!(Number(input.value) > 0)) input.value = key === "video_count" ? "1" : "0.1";
      widget.value = input.value;
      widget.callback?.(widget.value, app.canvas, node);
      sync();
    };
    input.addEventListener("change", commitValue);
    const number = document.createElement("div");
    number.className = "elvax-prompt-template-builder__fixed-number";
    const steps = [-1, 1].map((direction) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "elvax-prompt-template-builder__number-step";
      button.innerHTML = makeIcon(direction < 0 ? '<path d="m14 7-5 5 5 5"/>' : '<path d="m10 7 5 5-5 5"/>');
      button.title = direction < 0 ? "Decrease value" : "Increase value";
      button.setAttribute("aria-label", button.title);
      button.addEventListener("click", () => {
        if (key === "video_count") {
          const value = /^\d+$/.test(input.value) ? BigInt(input.value) : 1n;
          const next = value + BigInt(direction);
          input.value = String(next < 1n ? 1n : next);
        } else input.value = String(Math.max(0.1, Math.round((Number(input.value || 0.1) + direction * 0.1) * 1e10) / 1e10));
        commitValue();
      });
      return button;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        steps[event.key === "ArrowUp" ? 1 : 0].click();
      }
    });
    number.append(steps[0], input, steps[1]);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "elvax-prompt-template-builder__icon-button";
    const update = () => {
      const enabled = fixedEnabled[key] === true;
      toggle.setAttribute("aria-pressed", String(!enabled));
      toggle.title = enabled ? "Field enabled. Click to exclude it from JSON."
        : "Field disabled. Click to include it in JSON.";
      toggle.setAttribute("aria-label", toggle.title);
      toggle.innerHTML = makeIcon('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>' + (!enabled ? '<path d="m3 3 18 18"/>' : ""));
      keyInput.disabled = !enabled;
      input.disabled = !enabled;
      for (const step of steps) step.disabled = !enabled;
      if (enabled && !(Number(input.value) > 0)) widget.value = input.value = key === "video_count" ? "1" : "0.1";
    };
    toggle.addEventListener("click", () => {
      fixedEnabled[key] = !fixedEnabled[key];
      update();
      sync();
    });
    update();
    const name = document.createElement("div");
    name.className = "elvax-prompt-template-builder__fixed-name";
    name.append(toggle, keyInput);
    line.append(name, number);
    fixedControls.append(line);
    fixedInputs.set(key, { key: keyInput, value: input, update });
    widget.hidden = true;
    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
  }

  const list = document.createElement("div");
  const measuredValueWidths = new WeakMap();
  const valueResizeObserver = new ResizeObserver((entries) => {
    const changed = entries.filter(({ target }) => {
      const width = target.clientWidth;
      const previous = measuredValueWidths.get(target);
      measuredValueWidths.set(target, width);
      return width > 0 && width !== previous;
    });
    if (!changed.length) return;
    for (const { target } of changed) pendingValueResizes.add(target);
    scheduleMinimumNodeSize();
  });
  let measuredRootWidth = 0;
  const rootResizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width || 0;
    if (!width || Math.abs(width - measuredRootWidth) < 1) return;
    measuredRootWidth = width;
    scheduleMinimumNodeSize();
  });
  rootResizeObserver.observe(root);
  const originalRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    for (const timer of scrollTimers) clearInterval(timer);
    cancelAnimationFrame(syncFrame);
    cancelAnimationFrame(layoutFrame);
    rootResizeObserver.disconnect();
    valueResizeObserver.disconnect();
    colorOverlay?.remove();
    jsonOverlay?.remove();
    loadRequest += 1;
    colorOverlay = null;
    return originalRemoved?.apply(this, args);
  };
  const toolbar = document.createElement("div");
  toolbar.className = "elvax-prompt-template-builder__toolbar";
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "elvax-prompt-template-builder__action-button elvax-prompt-template-builder__action-button--add";
  addButton.textContent = "+ Add field";
  const loadButton = document.createElement("button");
  loadButton.type = "button";
  loadButton.className = "elvax-prompt-template-builder__action-button";
  loadButton.textContent = "Load Template";
  loadButton.title = "Load a prompt template from a JSON file";
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "elvax-prompt-template-builder__action-button";
  saveButton.textContent = "Save Template";
  saveButton.title = "Save the current prompt template as a JSON file";
  const fixedActions = document.createElement("div");
  fixedActions.className = "elvax-prompt-template-builder__fixed-actions";
  fixedActions.append(loadButton, saveButton);
  const filenameField = document.createElement("div");
  filenameField.className = "elvax-prompt-template-builder__filename";
  const filenameInput = document.createElement("input");
  filenameInput.value = filename;
  filenameInput.placeholder = "Filename";
  filenameInput.setAttribute("aria-label", "JSON filename");
  filenameInput.title = "Filename for the next save. The original file is not renamed.";
  const extensionLabel = document.createElement("span");
  extensionLabel.className = "elvax-prompt-template-builder__filename-extension";
  extensionLabel.textContent = ".json";
  const modifiedDot = document.createElement("span");
  modifiedDot.className = "elvax-prompt-template-builder__modified";
  modifiedDot.textContent = "●";
  modifiedDot.title = "Unsaved changes";
  const updateFilename = () => {
    filenameInput.value = filename;
    modifiedDot.hidden = !modified;
  };
  updateFilename();
  filenameField.append(filenameInput, extensionLabel, modifiedDot);
  fixedActions.append(filenameField);
  filenameInput.addEventListener("input", () => {
    filename = filenameInput.value;
    sync();
  });
  filenameInput.addEventListener("change", () => {
    filename = (filenameInput.value.trim().replace(/\.json$/i, "") || "Untitled").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "") || "Untitled";
    updateFilename();
    sync();
  });
  fixedControls.firstElementChild.append(fixedActions);
  const wrapToggle = document.createElement("button");
  wrapToggle.type = "button";
  wrapToggle.className = "elvax-prompt-template-builder__action-button elvax-prompt-template-builder__wrap-toggle";
  wrapToggle.title = "Toggle wrapping for string Value fields only";
  const updateWrapToggle = () => {
    wrapToggle.textContent = wrapValues ? "Wrapped text" : "Unwrapped text";
    wrapToggle.dataset.active = String(wrapValues);
    wrapToggle.setAttribute("aria-pressed", String(wrapValues));
    wrapToggle.setAttribute("aria-label", `Wrap text ${wrapValues ? "on" : "off"}`);
    wrapToggle.title = `Wrap text is ${wrapValues ? "on" : "off"}`;
  };
  updateWrapToggle();
  const viewActions = document.createElement("div");
  viewActions.className = "elvax-prompt-template-builder__fixed-actions";
  wrapToggle.style.marginLeft = "0";
  const expandToggle = document.createElement("button");
  expandToggle.type = "button";
  expandToggle.className = "elvax-prompt-template-builder__action-button elvax-prompt-template-builder__expand-toggle";
  const newButton = document.createElement("button");
  newButton.type = "button";
  newButton.className = "elvax-prompt-template-builder__action-button";
  newButton.textContent = "New Template";
  newButton.title = "Start a new empty template";
  const updateExpandToggle = () => {
    const containers = containerRows(rows);
    const expanded = containers.some((row) => row.expanded);
    const allExpanded = containers.length > 0 && containers.every((row) => row.expanded);
    const mixed = expanded && !allExpanded;
    expandToggle.textContent = mixed ? "Partly expanded" : allExpanded ? "Expanded fields" : "Collapsed fields";
    expandToggle.dataset.active = mixed ? "mixed" : String(allExpanded);
    expandToggle.title = mixed ? "Some fields are expanded. Click to collapse all."
      : allExpanded ? "All fields are expanded. Click to collapse all."
      : "All fields are collapsed. Click to expand all.";
    expandToggle.disabled = !containers.length;
  };
  expandToggle.addEventListener("click", () => {
    const containers = containerRows(rows);
    const expanded = !containers.some((row) => row.expanded);
    for (const row of containers) row.expanded = expanded;
    sync();
    render();
  });
  viewActions.append(wrapToggle, expandToggle, newButton);
  fixedControls.children[1].append(viewActions);
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".json,application/json";
  fileInput.style.display = "none";
  toolbar.append(addButton, fileInput);

  const contentHeight = () => Math.ceil(fixedControls.offsetHeight + list.offsetHeight + toolbar.offsetHeight + 26);
  const serializeBuilderState = () => JSON.stringify({
    fields: rows,
    keys: fieldKeys,
    wrapValues,
    fixedEnabled,
    filename,
    modified,
    fixedValues: {
      video_count: videoCountWidget.value,
      video_duration: videoDurationWidget.value,
    },
  });
  const sync = (markModified = true) => {
    if (markModified) modified = true;
    modifiedDot.hidden = !modified;
    updateDuplicateWarnings();
    if (syncFrame == null) syncFrame = requestAnimationFrame(() => {
      syncFrame = null;
      dataWidget.value = serializeBuilderState();
      dataWidget.callback?.(dataWidget.value, app.canvas, node);
    });
    node.graph?.setDirtyCanvas(true, true);
  };
  function scheduleMinimumNodeSize() {
    if (layoutFrame != null) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = null;
      for (const value of pendingValueResizes) if (value.isConnected) value.__elvaxResize?.();
      pendingValueResizes.clear();
      updateMinimumNodeSize();
    });
  }
  function updateDuplicateWarnings() {
    const fixedNames = Object.entries(fieldKeys).map(([name, value]) => String(value || "").trim() || name);
    const scopes = new Map();
    const counts = (fields) => {
      if (!scopes.has(fields)) {
        const names = new Map();
        for (const row of fields) {
          const key = String(row.key || "").trim();
          names.set(key, (names.get(key) || 0) + 1);
        }
        scopes.set(fields, names);
      }
      return scopes.get(fields);
    };
    for (const input of root.querySelectorAll("input")) {
      if (!input.__elvaxField && !input.__elvaxFixedKey) continue;
      const key = input.value.trim() || input.__elvaxFixedKey || "";
      const count = input.__elvaxField
        ? (counts(input.__elvaxScope).get(key) || 0) + (input.__elvaxScope === rows ? fixedNames.filter((name) => name === key).length : 0)
        : fixedNames.filter((name) => name === key).length + (counts(rows).get(key) || 0);
      const invalid = !!key && count > 1;
      input.setAttribute("aria-invalid", String(invalid));
      if (invalid) input.title = "This name is already used here. Rename one of the fields.";
      else if (input.title === "This name is already used here. Rename one of the fields.") {
        if (input.__elvaxHelpTitle) input.title = input.__elvaxHelpTitle;
        else input.removeAttribute("title");
      }
    }
  }
  const fixedFields = () => {
    const fields = Object.create(null);
    const count = String(videoCountWidget.value ?? "").trim();
    const duration = String(videoDurationWidget.value ?? "").trim();
    if (fixedEnabled.video_count) {
      const value = Number(count);
      if (!Number.isInteger(value) || value < 0) throw new Error("video_count must be a non-negative integer.");
      const key = String(fieldKeys.video_count || "").trim() || "video_count";
      fields[key] = parsePromptJSON(count || "0");
    }
    if (fixedEnabled.video_duration) {
      const value = Number(duration);
      if (!Number.isFinite(value) || value < 0) throw new Error("video_duration must be a non-negative number.");
      const key = String(fieldKeys.video_duration || "").trim() || "video_duration";
      fields[key] = value;
    }
    return fields;
  };
  const jsonObject = (includeHidden = false, hiddenFields = null, fieldColors = null) => {
    const fields = objectFromRows(rows, "root", "", includeHidden, hiddenFields, fieldColors);
    const fixed = fixedFields();
    const names = Object.entries(fieldKeys).map(([name, value]) => String(value || "").trim() || name);
    if (new Set(names).size !== names.length) throw new Error("The two fixed fields must have different names.");
    for (const key of names) if (Object.hasOwn(fields, key)) throw new Error(`Field "${key}" conflicts with a fixed field. Rename it.`);
    return { ...fixed, ...fields };
  };
  const toast = (severity, summary, detail) => {
    app.extensionManager?.toast?.add({ severity, summary, detail, life: 3000 });
  };

  function openJsonEditor(row) {
    jsonOverlay?.remove();
    const overlay = document.createElement("div");
    jsonOverlay = overlay;
    overlay.className = "elvax-prompt-template-builder__overlay";
    const dialog = document.createElement("section");
    dialog.className = "elvax-prompt-template-builder__dialog";
    const title = document.createElement("strong");
    title.textContent = `Edit JSON value${row.key ? ` - ${row.key}` : ""}`;
    const editor = document.createElement("textarea");
    editor.spellcheck = false;
    editor.value = String(row.value || "");
    const actions = document.createElement("div");
    actions.className = "elvax-prompt-template-builder__dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save";
    cancel.addEventListener("click", () => overlay.remove());
    save.addEventListener("click", () => {
      try { parsePromptJSON(editor.value); }
      catch (error) { toast("error", "Invalid JSON", error.message); return; }
      row.value = editor.value;
      sync();
      render();
      overlay.remove();
    });
    overlay.addEventListener("pointerdown", (event) => event.stopPropagation());
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) overlay.remove();
    });
    actions.append(cancel, save);
    dialog.append(title, editor, actions);
    overlay.append(dialog);
    document.body.append(overlay);
    editor.focus();
  }

  function setType(row, type) {
    row.type = type;
    row.value = type === "boolean" ? false
      : type === "object" || type === "array" ? [] : "";
    row.expanded = type === "object" || type === "array";
  }

  function makeIcon(path) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  }

  function openFieldColor(row, refresh = render) {
    colorOverlay?.remove();
    const overlay = document.createElement("div");
    overlay.className = "elvax-prompt-template-builder__overlay";
    colorOverlay = overlay;
    const dialog = document.createElement("section");
    dialog.className = "elvax-prompt-template-builder__dialog elvax-prompt-template-builder__color-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "Choose field color");
    dialog.setAttribute("aria-modal", "true");
    const title = document.createElement("strong");
    title.textContent = `Field color${row.key ? ` - ${row.key}` : ""}`;
    const palette = document.createElement("div");
    palette.className = "elvax-prompt-template-builder__color-grid";
    const close = () => {
      overlay.remove();
      if (colorOverlay === overlay) colorOverlay = null;
    };
    const choose = (color) => {
      row.color = color;
      sync();
      refresh();
      close();
    };
    for (const [index, color] of FIELD_COLORS.entries()) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "elvax-prompt-template-builder__color-swatch";
      swatch.style.backgroundColor = color;
      swatch.title = `Color ${index + 1}: ${color}`;
      swatch.setAttribute("aria-label", swatch.title);
      swatch.setAttribute("aria-pressed", String(row.color === color));
      swatch.addEventListener("click", () => choose(color));
      palette.append(swatch);
    }
    const actions = document.createElement("div");
    actions.className = "elvax-prompt-template-builder__dialog-actions";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "None";
    reset.title = "Remove this field's color";
    reset.setAttribute("aria-pressed", String(!row.color));
    reset.addEventListener("click", () => choose(""));
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Close";
    cancel.addEventListener("click", close);
    actions.append(reset, cancel);
    dialog.append(title, palette, actions);
    overlay.append(dialog);
    overlay.addEventListener("pointerdown", (event) => event.stopPropagation());
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    });
    document.body.append(overlay);
    palette.querySelector('[aria-pressed="true"]')?.focus();
    if (!overlay.contains(document.activeElement)) reset.focus();
  }

  function clearDragIndicators() {
    dropMarker.hidden = true;
    root.querySelectorAll(".elvax-prompt-template-builder__row-group--drop-into")
      .forEach((element) => element.classList.remove("elvax-prompt-template-builder__row-group--drop-into"));
  }

  function findDragDestination(clientX, clientY) {
    const bounds = root.getBoundingClientRect();
    if (clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom) return null;
    const scaleX = bounds.width / root.offsetWidth;
    const scaleY = bounds.height / root.offsetHeight;
    for (const group of root.querySelectorAll(".elvax-prompt-template-builder__row-group")) {
      const row = group.__elvaxRow;
      if (row.type !== "object" && row.type !== "array") continue;
      const rect = group.firstElementChild.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top + 5 * scaleY && clientY <= rect.bottom - 5 * scaleY) {
        return { fields: row.value, arrayItems: row.type === "array", insertIndex: row.value.length, marker: group, into: true };
      }
    }
    let nearest = null;
    for (const list of root.querySelectorAll(".elvax-prompt-template-builder__fields-list")) {
      const rect = list.getBoundingClientRect();
      if (clientX < rect.left - 12 * scaleX || clientX > rect.right) continue;
      const groups = [...list.children].filter((group) => group.__elvaxRow);
      for (let index = 0; index <= groups.length; index++) {
        const next = groups[index];
        const previous = groups[index - 1];
        const line = (next || previous)?.firstElementChild;
        const lineRect = line?.getBoundingClientRect();
        const left = lineRect?.left ?? rect.left;
        const right = line ? line.lastElementChild.getBoundingClientRect().left - 5 * scaleX : rect.right - 121 * scaleX;
        const y = next ? previous
          ? (previous.getBoundingClientRect().bottom + next.getBoundingClientRect().top) / 2
          : next.getBoundingClientRect().top - 2 * scaleY
          : previous ? previous.getBoundingClientRect().bottom + 2 * scaleY
          : list.querySelector(".elvax-prompt-template-builder__empty").getBoundingClientRect().bottom + 2 * scaleY;
        const distance = Math.abs(clientY - y);
        if (distance > 18 * scaleY) continue;
        if (nearest && (distance > nearest.distance + scaleY || Math.abs(distance - nearest.distance) <= scaleY && left <= nearest.left)) continue;
        nearest = { fields: list.__elvaxFields, arrayItems: list.__elvaxArrayItems, insertIndex: index, marker: next || previous || list, distance, left, right, y };
      }
    }
    return nearest;
  }

  function showDropMarker(destination) {
    const bounds = root.getBoundingClientRect();
    const scaleX = bounds.width / root.offsetWidth;
    const scaleY = bounds.height / root.offsetHeight;
    dropMarker.style.left = `${(destination.left - bounds.left) / scaleX}px`;
    dropMarker.style.top = `${(destination.y - bounds.top) / scaleY - 2}px`;
    dropMarker.style.width = `${(destination.right - destination.left) / scaleX}px`;
    dropMarker.hidden = false;
  }

  function nextObjectKey(fields, base) {
    const names = new Set(fields.map((field) => String(field.key ?? "").trim()));
    if (base === "item") {
      for (let index = 1; ; index++) if (!names.has(`item_${index}`)) return `item_${index}`;
    }
    if (!names.has(base)) return base;
    for (let index = 2; ; index++) if (!names.has(`${base}_${index}`)) return `${base}_${index}`;
  }

  function rowContainsList(row, list) {
    if (row.type !== "object" && row.type !== "array") return false;
    return row.value === list || row.value.some((child) => rowContainsList(child, list));
  }

  function renderFields(target, fields, arrayItems = false, showHeader = false, inheritedHidden = false) {
    target.classList.add("elvax-prompt-template-builder__fields-list");
    target.__elvaxFields = fields;
    target.__elvaxArrayItems = arrayItems;
    target.replaceChildren();
    if (showHeader) {
      const header = document.createElement("div");
      header.className = "elvax-prompt-template-builder__head";
      for (const label of ["Key", "Type", "Value", ""]) {
        const cell = document.createElement("span");
        cell.textContent = label;
        header.append(cell);
      }
      target.append(header);
    }
    if (!fields.length) {
      const empty = document.createElement("div");
      empty.className = "elvax-prompt-template-builder__empty";
      empty.textContent = showHeader ? "No fields yet. Add a field to start building your JSON." : "Empty";
      target.append(empty);
    }

    function renderRow(target, row, index) {
      for (const value of target.querySelectorAll("textarea")) valueResizeObserver.unobserve(value);
      target.replaceChildren();
      const refresh = () => {
        renderRow(target, row, index);
        updateExpandToggle();
        updateDuplicateWarnings();
        scheduleMinimumNodeSize();
      };
      const line = document.createElement("div");
      const rowHidden = inheritedHidden || row.hidden;
      line.className = `elvax-prompt-template-builder__row${rowHidden ? " elvax-prompt-template-builder__row--hidden" : ""}`;
      if (FIELD_COLORS.includes(row.color)) {
        line.classList.add("elvax-prompt-template-builder__row--colored");
        line.style.setProperty("--elvax-field-color", row.color);
        line.style.setProperty("--elvax-field-background", `${row.color}26`);
      }
      let key;
      if (arrayItems) {
        key = document.createElement("span");
        key.textContent = `Item ${index + 1}`;
        key.style.cssText = "overflow:hidden;color:var(--descrip-text,#aaa);text-overflow:ellipsis;white-space:nowrap;";
      } else {
        key = document.createElement("input");
        key.placeholder = "field_name";
        key.value = row.key;
        key.__elvaxField = row;
        key.__elvaxScope = fields;
        key.disabled = rowHidden;
        key.setAttribute("aria-label", "Field key");
        key.addEventListener("input", () => { row.key = key.value; sync(); });
      }

      const type = document.createElement("select");
      type.setAttribute("aria-label", "Field type");
      for (const optionType of TYPES) {
        const option = document.createElement("option");
        option.value = optionType;
        option.textContent = optionType;
        type.append(option);
      }
      type.value = row.type;
      type.disabled = rowHidden;
      type.addEventListener("change", () => {
        setType(row, type.value);
        sync();
        refresh();
      });

      let value;
      if (row.type === "boolean") {
        value = document.createElement("select");
        for (const bool of [false, true]) {
          const option = document.createElement("option");
          option.value = String(bool);
          option.textContent = String(bool);
          value.append(option);
        }
        value.value = String(row.value === true || String(row.value) === "true");
        value.addEventListener("change", () => { row.value = value.value === "true"; sync(); });
      } else if (row.type === "json") {
        value = document.createElement("button");
        value.type = "button";
        value.textContent = "Edit JSON…";
        value.title = "Edit a raw JSON value";
        value.addEventListener("click", () => openJsonEditor(row));
      } else if (row.type === "object" || row.type === "array") {
        value = document.createElement("button");
        value.type = "button";
        value.className = "elvax-prompt-template-builder__container-toggle";
        const childCount = row.value.length;
        const itemLabel = row.type === "object" ? "field" : "item";
        value.textContent = `${row.expanded ? "▾" : "▸"} ${childCount} ${itemLabel}${childCount === 1 ? "" : "s"}`;
        value.title = row.expanded ? "Collapse children" : "Expand children";
        value.addEventListener("click", () => {
          row.expanded = !row.expanded;
          sync();
          refresh();
        });
      } else if (row.type === "string") {
        value = document.createElement("textarea");
        value.className = `elvax-prompt-template-builder__value-textarea${wrapValues ? " elvax-prompt-template-builder__value-textarea--wrap" : ""}`;
        value.rows = 1;
        value.wrap = wrapValues ? "soft" : "off";
        value.value = String(row.value ?? "");
        value.setAttribute("aria-label", "Field value");
        const cell = document.createElement("div");
        cell.className = "elvax-prompt-template-builder__text-field";
        value.__elvaxCell = cell;
        const arrows = [-1, 1].map((direction) => {
          const arrow = document.createElement("button");
          arrow.type = "button";
          arrow.className = "elvax-prompt-template-builder__scroll-arrow";
          arrow.innerHTML = makeIcon(direction < 0 ? '<path d="m14 7-5 5 5 5"/>' : '<path d="m10 7 5 5-5 5"/>');
          arrow.title = direction < 0 ? "Scroll text left" : "Scroll text right";
          arrow.setAttribute("aria-label", arrow.title);
          arrow.hidden = true;
          const stop = () => { clearInterval(arrow.__timer); scrollTimers.delete(arrow.__timer); };
          arrow.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            if (arrow.disabled) return;
            arrow.setPointerCapture(event.pointerId);
            value.scrollLeft += direction * 45;
            stop();
            arrow.__timer = setInterval(() => { value.scrollLeft += direction * 20; }, 35);
            scrollTimers.add(arrow.__timer);
          });
          for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) arrow.addEventListener(event, stop);
          arrow.addEventListener("click", (event) => { if (!event.detail) value.scrollLeft += direction * 45; });
          return arrow;
        });
        cell.append(arrows[0], value, arrows[1]);
        const updateArrowState = (pinEnd = false) => {
          if (rowHidden) {
            arrows[0].disabled = true;
            arrows[1].disabled = true;
            arrows[0].hidden = true;
            value.scrollLeft = 0;
            return;
          }
          const scroll = value.scrollLeft;
          const atEnd = pinEnd === true || scroll >= value.scrollWidth - value.clientWidth - 1;
          arrows[0].disabled = value.scrollLeft <= 1;
          arrows[1].disabled = atEnd;
          value.scrollLeft = scroll <= 1 ? 0 : atEnd ? value.scrollWidth - value.clientWidth : scroll;
        };
        const updateArrows = () => {
          const previousScroll = value.scrollLeft;
          const atEnd = previousScroll > 1 && previousScroll >= value.scrollWidth - value.clientWidth - 1;
          for (const arrow of arrows) arrow.hidden = true;
          const overflow = !wrapValues && value.scrollWidth > value.clientWidth + 1;
          for (const arrow of arrows) arrow.hidden = !overflow;
          value.scrollLeft = previousScroll;
          updateArrowState(atEnd);
        };
        value.addEventListener("scroll", () => updateArrowState());
        const resize = () => {
          if (!value.clientWidth) return;
          updateArrows();
          value.style.height = "25px";
          const height = value.scrollHeight;
          value.style.height = `${Math.max(25, Math.min(height, 158))}px`;
          value.style.overflowY = height > 158 ? "auto" : "hidden";
        };
        value.__elvaxResize = resize;
        valueResizeObserver.observe(value);
        value.addEventListener("input", () => {
          row.value = value.value;
          sync();
          resize();
          scheduleMinimumNodeSize();
        });
      } else {
        value = document.createElement("input");
        value.placeholder = row.type === "number" ? "e.g. 3" : "value";
        value.value = String(row.value ?? "");
        value.setAttribute("aria-label", "Field value");
        value.addEventListener("input", () => { row.value = value.value; sync(); });
      }
      value.disabled = rowHidden && row.type !== "object" && row.type !== "array";

      const actions = document.createElement("div");
      actions.className = "elvax-prompt-template-builder__actions";
      const dragHandle = document.createElement("button");
      dragHandle.type = "button";
      dragHandle.className = "elvax-prompt-template-builder__icon-button elvax-prompt-template-builder__drag-handle";
      dragHandle.innerHTML = makeIcon('<path d="M4 6h16M4 12h16M4 18h16"/>');
      dragHandle.title = "Drag to reorder field";
      dragHandle.setAttribute("aria-label", dragHandle.title);
      dragHandle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        dragHandle.setPointerCapture(event.pointerId);
        dragState = { sourceFields: fields, sourceArrayItems: arrayItems, row, source: target, destination: null, marker: null, insertIndex: index, pointerId: event.pointerId, x: event.clientX, y: event.clientY, started: false };
      });
      dragHandle.addEventListener("pointermove", (event) => {
        const state = dragState;
        if (!state || state.pointerId !== event.pointerId) return;
        if (!state.started && Math.hypot(event.clientX - state.x, event.clientY - state.y) < 4) return;
        state.started = true;
        state.source.classList.add("elvax-prompt-template-builder__row-group--dragging");
        clearDragIndicators();
        const destination = findDragDestination(event.clientX, event.clientY);
        if (!destination || rowContainsList(state.row, destination.fields)) {
          state.destination = null;
          state.marker = null;
          return;
        }
        const sourceIndex = state.sourceFields.indexOf(state.row);
        const adjustedIndex = destination.insertIndex - (sourceIndex < destination.insertIndex ? 1 : 0);
        const noChange = destination.fields === state.sourceFields && sourceIndex === adjustedIndex;
        if (noChange) {
          clearDragIndicators();
          state.destination = null;
          state.marker = null;
          return;
        }
        if (destination.into) {
          destination.marker.classList.add("elvax-prompt-template-builder__row-group--drop-into");
        } else showDropMarker(destination);
        state.destination = destination;
        state.marker = destination.marker;
        state.insertIndex = destination.insertIndex;
      });
      const finishDrag = (event, drop) => {
        const state = dragState;
        if (!state || state.pointerId !== event.pointerId) return;
        state.source.classList.remove("elvax-prompt-template-builder__row-group--dragging");
        clearDragIndicators();
        dragState = null;
        if (!drop || !state.started || !state.destination || !state.marker) return;
        const from = state.sourceFields.indexOf(state.row);
        let to = state.insertIndex;
        if (state.destination.fields === state.sourceFields && from < to) to--;
        if (state.destination.fields === state.sourceFields && from === to) return;
        state.sourceFields.splice(from, 1);
        let moved = state.row;
        if (state.sourceArrayItems !== state.destination.arrayItems) {
          if (state.destination.arrayItems) {
            moved = { type: "object", value: [state.row], expanded: false, hidden: false, color: "" };
          } else {
            moved = { ...state.row, key: nextObjectKey(state.destination.fields, "item") };
          }
        } else if (!state.destination.arrayItems) {
          moved.key = nextObjectKey(state.destination.fields, String(moved.key ?? "").trim());
        }
        state.destination.fields.splice(Math.max(0, Math.min(to, state.destination.fields.length)), 0, moved);
        sync();
        render();
      };
      dragHandle.addEventListener("pointerup", (event) => finishDrag(event, true));
      dragHandle.addEventListener("pointercancel", (event) => finishDrag(event, false));
      dragHandle.addEventListener("lostpointercapture", (event) => finishDrag(event, false));
      actions.append(dragHandle);
      const color = document.createElement("button");
      color.type = "button";
      color.className = "elvax-prompt-template-builder__icon-button";
      color.innerHTML = makeIcon('<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.7 1.7 0 0 1 .8-3.3H17a4 4 0 0 0 4-4c0-4-4-7-9-7Z"/><circle cx="7.5" cy="10" r=".7"/><circle cx="11" cy="7" r=".7"/><circle cx="15.5" cy="8" r=".7"/>');
      color.title = "Choose field color";
      color.setAttribute("aria-label", color.title);
      color.disabled = inheritedHidden;
      if (row.color) color.style.color = row.color;
      color.addEventListener("click", () => openFieldColor(row, refresh));
      actions.append(color);
      const hide = document.createElement("button");
      hide.type = "button";
      hide.className = "elvax-prompt-template-builder__icon-button";
      hide.innerHTML = makeIcon('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>' + (row.hidden ? '<path d="m3 3 18 18"/>' : ""));
      hide.title = row.hidden ? "Show field" : "Hide field";
      hide.setAttribute("aria-label", hide.title);
      hide.setAttribute("aria-pressed", String(Boolean(row.hidden)));
      hide.disabled = inheritedHidden;
      hide.addEventListener("click", () => {
        row.hidden = !row.hidden;
        sync();
        refresh();
      });
      actions.append(hide);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "elvax-prompt-template-builder__icon-button elvax-prompt-template-builder__icon-button--remove";
      remove.innerHTML = makeIcon('<path d="m18 6-12 12M6 6l12 12"/>');
      remove.title = "Remove field";
      remove.setAttribute("aria-label", "Remove field");
      remove.addEventListener("click", () => {
        fields.splice(index, 1);
        sync();
        render();
      });
      actions.append(remove);
      line.append(key, type, value.__elvaxCell || value, actions);
      target.append(line);

      if ((row.type === "object" || row.type === "array") && row.expanded) {
        const nested = document.createElement("div");
        nested.className = "elvax-prompt-template-builder__nested elvax-prompt-template-builder__fields-list";
        const nestedFields = row.value;
        renderFields(nested, nestedFields, row.type === "array", false, rowHidden);
        const addChild = document.createElement("button");
        addChild.type = "button";
        addChild.className = "elvax-prompt-template-builder__nested-add elvax-prompt-template-builder__action-button elvax-prompt-template-builder__action-button--add";
        addChild.textContent = row.type === "object" ? "+ Add field" : "+ Add item";
        addChild.disabled = rowHidden;
        addChild.addEventListener("click", () => {
          nestedFields.push(row.type === "object"
            ? { key: "", type: "string", value: "", expanded: false, hidden: false, color: "" }
            : { type: "string", value: "", expanded: false, hidden: false, color: "" });
          sync();
          refresh();
        });
        nested.append(addChild);
        target.append(nested);
      }
    }
    fields.forEach((row, index) => {
      const group = document.createElement("div");
      group.className = "elvax-prompt-template-builder__row-group";
      group.__elvaxRow = row;
      target.append(group);
      renderRow(group, row, index);
    });
  }

  function render() {
    for (const timer of scrollTimers) clearInterval(timer);
    scrollTimers.clear();
    updateExpandToggle();
    valueResizeObserver.disconnect();
    colorOverlay?.remove();
    colorOverlay = null;
    jsonOverlay?.remove();
    jsonOverlay = null;
    renderFields(list, rows, false, true);
    updateDuplicateWarnings();
    node.graph?.setDirtyCanvas(true, true);
    scheduleMinimumNodeSize();
  }

  addButton.addEventListener("click", () => {
    rows.push({ key: "", type: "string", value: "", expanded: false, hidden: false, color: "" });
    sync();
    render();
  });
  wrapToggle.addEventListener("click", () => {
    wrapValues = !wrapValues;
    updateWrapToggle();
    sync();
    render();
  });
  newButton.addEventListener("click", async () => {
    const request = ++loadRequest;
    if (modified) {
      const confirmed = await app.extensionManager.dialog.confirm({ title: "Start a new template?", message: "Unsaved changes will be lost." });
      if (!confirmed || request !== loadRequest) return;
    }
    rows.length = 0;
    fieldKeys = { video_count: "video_count", video_duration: "video_duration" };
    fixedEnabled = { video_count: false, video_duration: false };
    for (const [key, controls] of fixedInputs) {
      controls.key.value = fieldKeys[key];
      controls.value.value = "";
      const widget = key === "video_count" ? videoCountWidget : videoDurationWidget;
      widget.value = "";
      widget.callback?.("", app.canvas, node);
      controls.update();
    }
    wrapValues = true;
    updateWrapToggle();
    filename = "Untitled";
    modified = false;
    updateFilename();
    sync(false);
    render();
  });
  loadButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    const request = ++loadRequest;
    try {
      if (modified) {
        const confirmed = await app.extensionManager.dialog.confirm({ title: "Replace current template?", message: "Unsaved changes will be lost." });
        if (!confirmed || request !== loadRequest) return;
      }
      const parsed = parsePromptJSON(await file.text());
      if (request !== loadRequest) return;
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object" || JSON.isRawJSON(parsed)) {
        throw new Error("The file must contain a JSON object at its top level.");
      }
      const metadataKey = Object.hasOwn(parsed, HIDDEN_FIELDS_KEY) ? HIDDEN_FIELDS_KEY : "__elvax_json_prompt_builder__";
      const metadata = parsed[metadataKey];
      const hasHiddenMetadata = metadata?.version === 1 && Array.isArray(metadata.hiddenFields);
      const hiddenFields = new Set(hasHiddenMetadata
        ? metadata.hiddenFields.filter((path) => typeof path === "string")
        : []);
      const fieldColors = hasHiddenMetadata && metadata.fieldColors && typeof metadata.fieldColors === "object"
        && !Array.isArray(metadata.fieldColors) ? metadata.fieldColors : {};
      const loadedObject = { ...parsed };
      if (hasHiddenMetadata) delete loadedObject[metadataKey];
      const storedFixed = hasHiddenMetadata ? metadata.fixedFields : null;
      const loadedKeys = { video_count: "video_count", video_duration: "video_duration" };
      const loadedEnabled = {};
      for (const key of ["video_count", "video_duration"]) {
        if (typeof storedFixed?.[key]?.name === "string") loadedKeys[key] = storedFixed[key].name;
      }
      const loadedFixed = [];
      for (const [key, widget, isValid] of [
        ["video_count", videoCountWidget, (value) => Number.isInteger(value) && value >= 0],
        ["video_duration", videoDurationWidget, (value) => Number.isFinite(value) && value >= 0],
      ]) {
        const jsonKey = String(loadedKeys[key] || "").trim() || key;
        const loadedValue = storedFixed?.[key] ? storedFixed[key].value : loadedObject[jsonKey];
        loadedEnabled[key] = storedFixed?.[key] ? storedFixed[key].enabled === true : Object.hasOwn(loadedObject, jsonKey);
        const value = !jsonKey || loadedValue == null ? "" : JSON.isRawJSON(loadedValue) ? loadedValue.rawJSON : String(loadedValue);
        if (value && !isValid(Number(value))) throw new Error(`"${key}" must be a valid number.`);
        const normalized = fixedValueText(key, value);
        if (value && !normalized) throw new Error(`"${key}" has an invalid format.`);
        loadedFixed.push([key, widget, normalized]);
      }
      const fixedKeys = new Set(Object.entries(loadedKeys).map(([name, value]) => String(value || "").trim() || name));
      const loadedRows = Object.entries(loadedObject)
        .filter(([key]) => !fixedKeys.has(key))
        .map(([key, value]) => fieldFromValue(key, value, `/${pointerSegment(key)}`, hiddenFields, fieldColors));
      for (const [key, widget, normalized] of loadedFixed) {
        widget.value = normalized;
        fixedInputs.get(key).value.value = normalized;
        widget.callback?.(normalized, app.canvas, node);
      }
      fieldKeys = loadedKeys;
      fixedEnabled = loadedEnabled;
      for (const [key, controls] of fixedInputs) {
        controls.key.value = fieldKeys[key];
        controls.update();
      }
      rows.splice(0, rows.length, ...loadedRows);
      const layout = hasHiddenMetadata ? metadata.layout : null;
      restoreExpansion(rows, layout?.expanded);
      if (hasHiddenMetadata) restoreUnnamedFields(rows, metadata.unnamedFields);
      wrapValues = typeof layout?.wrapValues === "boolean" ? layout.wrapValues : true;
      updateWrapToggle();
      filename = file.name.replace(/\.json$/i, "") || "Untitled";
      modified = false;
      updateFilename();
      sync(false);
      render();
      toast("success", "Template loaded", `${loadedRows.length} fields imported.`);
    } catch (error) {
      if (request !== loadRequest) return;
      toast("error", "Could not load template", error.message || "The file is not valid JSON.");
    }
  });
  saveButton.addEventListener("click", () => {
    try {
      const hiddenFields = [];
      const fieldColors = {};
      const savedObject = jsonObject(true, hiddenFields, fieldColors);
      {
        if (Object.hasOwn(savedObject, HIDDEN_FIELDS_KEY)) {
          throw new Error(`Rename the field "${HIDDEN_FIELDS_KEY}" before saving field metadata.`);
        }
        savedObject[HIDDEN_FIELDS_KEY] = { version: 1, hiddenFields, fieldColors,
          unnamedFields: collectUnnamedFields(rows),
          layout: { wrapValues, expanded: expansionState(rows) },
          fixedFields: Object.fromEntries([...fixedInputs].map(([key, controls]) => [key,
            { name: fieldKeys[key], value: controls.value.value, enabled: fixedEnabled[key] === true }])) };
      }
      const json = JSON.stringify(savedObject, null, 2);
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const download = document.createElement("a");
      download.href = url;
      const downloadName = `${(filename.trim().replace(/\.json$/i, "") || "Untitled").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "") || "Untitled"}.json`;
      download.download = downloadName;
      download.click();
      filename = downloadName.slice(0, -5);
      modified = false;
      updateFilename();
      sync(false);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("success", "Template saved", `Download requested: ${downloadName}.`);
    } catch (error) {
      toast("error", "Could not save template", error.message || "Check the field values.");
    }
  });

  for (const eventName of ["pointerdown", "pointermove", "contextmenu"]) {
    root.addEventListener(eventName, (event) => event.stopPropagation());
  }
  root.addEventListener("wheel", (event) => {
    const text = event.target.closest?.(".elvax-prompt-template-builder__text-field")?.querySelector("textarea");
    if (text && !text.disabled && !wrapValues && text.scrollWidth > text.clientWidth + 1) {
      event.preventDefault();
      event.stopPropagation();
      text.scrollLeft += (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * (event.deltaMode === 1 ? 17 : event.deltaMode === 2 ? text.clientWidth : 1);
      return;
    }
    if (event.target instanceof HTMLTextAreaElement && event.target.scrollHeight > event.target.clientHeight + 1) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    app.canvas._mousewheel_callback(event);
  }, { capture: true, passive: false });
  root.append(fixedControls, list, toolbar, dropMarker);

  dataWidget.serializeValue = serializeBuilderState;
  dataWidget.hidden = true;
  dataWidget.type = "hidden";
  dataWidget.computeSize = () => [0, -4];
  const domWidget = node.addDOMWidget("prompt_template_builder", "div", root, {
    serialize: false,
    hideOnZoom: false,
    getHeight: contentHeight,
    getMinHeight: contentHeight,
  });
  domWidget.computeLayoutSize = () => ({ minHeight: Math.max(50, contentHeight()), minWidth: DEFAULT_NODE_WIDTH - 16 });

  function updateRootWidth() {
    const width = Math.max(0, (node.size?.[0] || 0) - 16);
    if (width) root.style.width = `${width}px`;
  }

  const originalResize = node.onResize;
  node.onResize = function (size) {
    size[0] = Math.max(size[0], DEFAULT_NODE_WIDTH);
    size[1] = Math.max(size[1], this.min_size?.[1] || 0);
    const result = originalResize?.apply(this, arguments);
    updateRootWidth();
    return result;
  };

  const originalComputeSize = node.computeSize;
  node.computeSize = function (...args) {
    const size = originalComputeSize.apply(this, args);
    size[0] = DEFAULT_NODE_WIDTH;
    if (this.min_size?.[1]) size[1] = this.min_size[1];
    return size;
  };

  function updateMinimumNodeSize() {
    const widgetHeight = Math.max(50, contentHeight());
    const widgetTop = Number.isFinite(domWidget.last_y) && domWidget.last_y > 0
      ? domWidget.last_y
      : Math.max(0, (node.computeSize?.()[1] || widgetHeight) - widgetHeight);
    const minimumHeight = Math.ceil(widgetTop + widgetHeight + 10);
    node.min_size = [DEFAULT_NODE_WIDTH, minimumHeight];
    if ((node.size?.[1] || 0) !== minimumHeight || node.size?.[0] < DEFAULT_NODE_WIDTH) {
      node.setSize([Math.max(node.size?.[0] || 0, DEFAULT_NODE_WIDTH), minimumHeight]);
    }
  }

  const initialSize = node.computeSize();
  node.setSize([Math.max(node.size?.[0] || 0, DEFAULT_NODE_WIDTH), initialSize[1]]);
  updateRootWidth();
  const originalConfigure = node.onConfigure;
  node.onConfigure = function (...args) {
    loadRequest += 1;
    const result = originalConfigure?.apply(this, args);
    requestAnimationFrame(() => {
      if (!isSerializedBuilderData(dataWidget.value) && isSerializedBuilderData(videoDurationWidget.value)) {
        const savedCount = fixedValueText("video_count", dataWidget.value);
        const savedDuration = fixedValueText("video_duration", videoCountWidget.value);
        dataWidget.value = videoDurationWidget.value;
        videoCountWidget.value = savedCount;
        videoDurationWidget.value = savedDuration;
        fixedInputs.get("video_count").value.value = savedCount;
        fixedInputs.get("video_duration").value.value = savedDuration;
      }
      const configuredData = parseBuilderData(dataWidget.value);
      rows.splice(0, rows.length, ...configuredData.rows);
      fieldKeys = configuredData.keys;
      wrapValues = configuredData.wrapValues;
      fixedEnabled = configuredData.fixedEnabled || {
        video_count: Number(videoCountWidget.value) > 0,
        video_duration: Number(videoDurationWidget.value) > 0,
      };
      filename = configuredData.filename || "Untitled";
      modified = Boolean(configuredData.modified);
      updateFilename();
      updateWrapToggle();
      for (const key of ["video_count", "video_duration"]) {
        fixedInputs.get(key).key.value = fieldKeys[key];
        if (configuredData.fixedValues && Object.hasOwn(configuredData.fixedValues, key)) {
          const value = fixedValueText(key, configuredData.fixedValues[key]);
          const widget = key === "video_count" ? videoCountWidget : videoDurationWidget;
          widget.value = value;
          fixedInputs.get(key).value.value = value;
        }
        fixedInputs.get(key).update();
      }
      render();
      updateRootWidth();
      scheduleMinimumNodeSize();
    });
    return result;
  };
  render();
}

app.registerExtension({
  name: "elvax.prompt-template-builder",
  nodeCreated(node) {
    if (node.comfyClass === NODE_TYPE || node.type === NODE_TYPE) installNode(node);
  },
});
