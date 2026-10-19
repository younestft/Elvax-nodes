import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { CIRCUIT_SWITCH, REROUTE_SWITCH, ROUTE_CHANGED, selectedOutput } from "./reroute_switch.js";

const NODE_TYPE = "ElvaxVideoComparePro";
const MIN_HEIGHT = 180;
const MIN_SIZE = 360;
const GENERATION_ORDER = ["Steps", "Sampler", "Scheduler", "Model", "LoRA", "Seed",
  "CFG", "Denoise", "Duration", "Final resolution", "Frame rate"];

export function comparisonDuration(videos) {
  const durations = videos.filter((video) => video.hasAttribute("src"))
    .map((video) => video.duration).filter((duration) => Number.isFinite(duration) && duration > 0);
  return durations.length ? Math.max(...durations) : 0;
}

function mediaURL(entry) {
  return api.apiURL(`/view?${new URLSearchParams({
    filename: entry.filename, subfolder: entry.subfolder || "", type: entry.type || "input",
  })}`);
}

function inputSlot(node, role) {
  return node.inputs?.findIndex((input) => input.name === `${role}_video`) ?? -1;
}

function inputNode(node, role) {
  let slot = inputSlot(node, role);
  let source = node;
  const visited = new Set();
  while (source && !visited.has(source)) {
    visited.add(source);
    if (source.type === "GetNode") {
      source = source.findSetter(source.graph);
      slot = 0;
      continue;
    }
    const linkId = source.inputs?.[slot]?.link;
    const graph = source.graph;
    const link = linkId == null ? null : graph?.links?.[linkId];
    source = link ? graph.getNodeById(link.origin_id) : null;
    if (!source) return null;
    if (source.type === CIRCUIT_SWITCH && source.widgets?.find((widget) => widget.name === "closed")?.value === false) return null;
    if (source.type === REROUTE_SWITCH && link.origin_slot !== selectedOutput(source)) return null;
    if (!["Reroute", "Reroute (rgthree)", "SetNode", "GetNode", REROUTE_SWITCH, CIRCUIT_SWITCH].includes(source.type)) return source;
    slot = 0;
  }
  return null;
}

function inputKey(node, role) {
  const slot = inputSlot(node, role);
  const link = slot >= 0 ? node.inputs[slot]?.link : null;
  return link == null ? null : String(link);
}

function timeLabel(time) {
  const seconds = Math.max(0, Math.floor(time || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function install(node) {
  if (node.__elvaxVideoComparePro) return;
  node.__elvaxVideoComparePro = true;
  node.properties ||= {};
  node.properties.elvaxVideoComparePro ||= { position: 50, volume: 1, muted: false, loop: true, audioSource: null };
  const state = () => node.properties.elvaxVideoComparePro;
  function migrateAudioDefault() {
    if (state().audioAuto === undefined) {
      state().audioAuto = true;
      state().audioSource = "before";
    }
    if (state().audioDefaultVersion === 1) return;
    state().muted = false;
    state().audioDefaultVersion = 1;
  }
  migrateAudioDefault();
  let disposed = false;
  let animation = 0;
  let playing = false;
  let playStarting = false;
  let playRequest = 0;
  let playbackMaster = null;
  let audioContext = null;
  let audioUnavailable = false;
  let lastAudioSource = null;
  let lastVisibleSide = null;
  let lastTickTime = -Infinity;
  const audioGains = new Map();
  let playbackDuration = 0;
  let renderedTime = null;
  let seekRenderTarget = null;
  let pendingFrameSteps = 0;
  let frameStepInFlight = false;
  let pendingTimelineSeek = null;
  let resumeAfterSeek = false;
  let timelineDragging = false;
  const frameQueues = new Map();
  const frameIntervals = new Map();
  const frameCallbacks = new Map();
  let middlePointer = null;
  let hoveringVideo = false;
  let cachedVideoBounds = null;
  const captureRequests = { before: 0, after: 0 };
  const captureButtons = new Map();
  const autoCheckboxes = new Map();
  const uploadStatus = { before: "", after: "" };
  const uploads = new Map();

  const root = document.createElement("div");
  root.className = "elvax-video-compare-pro";
  root.style.cssText = "position:relative;display:flex;flex-direction:column;gap:var(--compare-gap,6px);width:100%;height:100%;min-height:0;min-width:0;box-sizing:border-box;contain:size;overflow:hidden;font:12px Arial,sans-serif;color:#eee;";
  const style = document.createElement("style");
  style.textContent = `
    .elvax-video-compare-pro,.elvax-video-compare-pro * {user-select:none;-webkit-user-select:none;}
    .elvax-video-compare-pro .status {user-select:text;-webkit-user-select:text;}
    .elvax-video-compare-pro .generation-panel,.elvax-video-compare-pro .generation-panel * {user-select:text;-webkit-user-select:text;}
    .elvax-video-compare-pro button,.elvax-video-compare-pro input {outline:none !important;-webkit-tap-highlight-color:transparent;}
    .elvax-video-compare-pro input[type=range]:focus,.elvax-video-compare-pro input[type=range]:focus-visible {outline:none !important;}
    .elvax-video-compare-pro input[type=range]::-moz-focus-outer {border:0;}
    .elvax-video-compare-pro button {box-sizing:border-box;font:12px Arial,sans-serif;color:#eee;cursor:pointer;white-space:nowrap;}
    .elvax-video-compare-pro button:disabled {opacity:.5;cursor:wait;}
    .elvax-video-compare-pro .capture-row {display:flex;}
    .elvax-video-compare-pro .captions {--caption-inset:8px;position:relative;z-index:1;width:100%;min-width:0;box-sizing:border-box;display:flex;flex:0 0 auto;align-items:center;gap:8px;padding:6px calc(var(--caption-right,0px) + var(--caption-inset)) 6px calc(var(--caption-left,0px) + var(--caption-inset));font-size:11px;line-height:16px;}
    .elvax-video-compare-pro .media-row {position:relative;display:grid;flex:1;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);min-height:0;min-width:0;overflow:hidden;}
    .elvax-video-compare-pro .generation-open .media-row {grid-template-columns:minmax(0,1fr) 6px minmax(0,var(--generation-panel-width,50%));}
    .elvax-video-compare-pro .media-row > .captions {grid-area:1 / 1;grid-template-columns:minmax(0,1fr) minmax(0,2fr) minmax(0,1fr);min-height:40px;}
    .elvax-video-compare-pro .media-row > .stage {grid-area:2 / 1;min-width:0;}
    .elvax-video-compare-pro .generation-panel {grid-area:1 / 3 / 3 / 4;display:none;flex-direction:column;min-width:0;min-height:0;box-sizing:border-box;overflow:hidden;border:1px solid #ffffff1c;border-radius:0;background:#171b20;color:#c7cdd3;font-size:11px;line-height:1.5;container-type:inline-size;}
    .elvax-video-compare-pro .generation-resizer {grid-area:1 / 2 / 3 / 3;display:none;position:relative;cursor:col-resize;touch-action:none;}
    .elvax-video-compare-pro .generation-open .generation-resizer {display:block;}
    .elvax-video-compare-pro .generation-resizer::after {content:"";position:absolute;inset:0 2px;background:#ffffff14;transition:background .15s;}
    .elvax-video-compare-pro .generation-resizer:hover::after,.elvax-video-compare-pro .generation-resizer:focus-visible::after {background:#8bd4ff80;}
    .elvax-video-compare-pro .generation-header {display:flex;flex:0 0 auto;align-items:center;gap:6px;min-height:40px;padding:4px 6px;box-sizing:border-box;border-bottom:1px solid #ffffff0d;}
    .elvax-video-compare-pro .generation-header .generation-heading {flex:1;min-width:0;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .elvax-video-compare-pro .generation-heading {color:#dce7ef;font-size:11px;font-weight:600;}
    .elvax-video-compare-pro .generation-toggle {position:relative;display:inline-flex;flex:0 0 24px;align-items:center;justify-content:center;width:24px;height:24px;padding:4px;border:1px solid #ffffff18;border-radius:5px;background:#17232c;color:#8bd4ff;}
    .elvax-video-compare-pro .generation-toggle:hover {background:#ffffff0c;border-color:#ffffff14;color:#fff;}
    .elvax-video-compare-pro .generation-toggle[aria-expanded=true] {border-color:#ffffff20;border-radius:2px;background:#202b34;color:#b9e3ff;}
    .elvax-video-compare-pro .generation-icon {width:15px;height:15px;flex:0 0 15px;transform:scaleX(-1);}
    .elvax-video-compare-pro .generation-toggle[aria-expanded=true] .generation-icon {transform:none;}
    .elvax-video-compare-pro .generation-count {margin-left:auto;padding:2px 6px;border-radius:4px;background:#8bd4ff12;color:#a9cce3;font-size:9px;white-space:nowrap;}
    .elvax-video-compare-pro .generation-count:empty {display:none;}
    @container (max-width: 240px) {.generation-count {display:none;}}
    .elvax-video-compare-pro .generation-content {display:block;flex:1;min-height:0;overflow:auto;padding:12px;scrollbar-width:thin;scrollbar-color:#ffffff26 transparent;}
    .elvax-video-compare-pro .generation-comparison {position:relative;margin-top:12px;overflow:hidden;border:1px solid #ffffff12;border-radius:8px;background:#13181d;}
    .elvax-video-compare-pro .generation-comparison.has-rows.before-active {background-image:linear-gradient(to right,#39b98116 0 50%,transparent 50% 100%);}
    .elvax-video-compare-pro .generation-comparison.has-rows.after-active {background-image:linear-gradient(to right,transparent 0 50%,#39b98116 50% 100%);}
    .elvax-video-compare-pro .generation-comparison.has-rows::before {content:"";position:absolute;top:0;bottom:0;left:50%;width:1px;background:#ffffff24;pointer-events:none;}
    .elvax-video-compare-pro .generation-comparison.before-active .generation-columns > :first-child,.elvax-video-compare-pro .generation-comparison.before-active .generation-value:first-child,.elvax-video-compare-pro .generation-comparison.after-active .generation-columns > :last-child,.elvax-video-compare-pro .generation-comparison.after-active .generation-value:last-child {color:#91dbb6;}
    .elvax-video-compare-pro .generation-columns,.elvax-video-compare-pro .generation-values {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));}
    .elvax-video-compare-pro .generation-columns {min-height:32px;padding:7px 0;box-sizing:border-box;background:#ffffff04;color:#c1ccd5;font-size:11px;letter-spacing:.01em;border-bottom:1px solid #ffffff18;}
    .elvax-video-compare-pro .generation-columns .generation-heading {display:flex;align-items:center;font-size:inherit;font-weight:600;color:inherit;line-height:1.2;}
    .elvax-video-compare-pro .generation-columns .generation-heading:first-child,.elvax-video-compare-pro .generation-value:first-child {padding-left:6px;padding-right:8px;}
    .elvax-video-compare-pro .generation-columns .generation-heading:last-child,.elvax-video-compare-pro .generation-value:last-child {padding-left:8px;padding-right:6px;}
    .elvax-video-compare-pro .generation-table {display:flex;flex-direction:column;}
    .elvax-video-compare-pro .generation-row {min-width:0;padding:7px 0 8px;border-bottom:1px solid #ffffff14;}
    .elvax-video-compare-pro .generation-name {width:50%;box-sizing:border-box;margin:0 0 3px;padding:0 8px 0 6px;color:#8d9aa7;font-size:10px;overflow-wrap:anywhere;}
    .elvax-video-compare-pro .generation-value {min-width:0;overflow-wrap:anywhere;}
    .elvax-video-compare-pro .generation-strength {color:#f2cf62;}
    .elvax-video-compare-pro .generation-row.is-different .generation-value:last-child {color:#b9dcf3;}
    .elvax-video-compare-pro .generation-empty {padding:12px;border:1px solid #ffffff0c;border-radius:5px;background:#ffffff03;color:#9aa6b1;}
    .elvax-video-compare-pro .generation-controls {display:flex;align-items:center;margin-bottom:12px;color:#9da8b3;font-size:10px;}
    .elvax-video-compare-pro .generation-controls label {display:flex;align-items:center;gap:6px;cursor:pointer;}
    .elvax-video-compare-pro .generation-controls input {appearance:none;position:relative;flex:0 0 13px;width:13px;height:13px;margin:0;border:1px solid #65717b;border-radius:3px;background:#ffffff05;cursor:pointer;}
    .elvax-video-compare-pro .generation-controls input:checked {border-color:#8bd4ff;background:#8bd4ff;}
    .elvax-video-compare-pro .generation-controls input:checked::after {content:"";position:absolute;left:4px;top:1px;width:3px;height:6px;border:solid #17232c;border-width:0 1.5px 1.5px 0;transform:rotate(45deg);}
    .elvax-video-compare-pro .generation-controls input:focus-visible {box-shadow:0 0 0 2px #8bd4ff40;}
    .elvax-video-compare-pro .caption-label {color:#bbb;transition:color .16s ease,text-shadow .16s ease;}
    .elvax-video-compare-pro .caption-label {flex:0 0 auto;white-space:nowrap;}
    .elvax-video-compare-pro .caption-after {grid-area:1 / 3;display:flex;align-items:center;justify-content:flex-end;gap:6px;}
    .elvax-video-compare-pro .caption-label.is-active {color:#00ff78;text-shadow:0 0 8px #00ff7866;}
    .elvax-video-compare-pro .caption-label.audio-source-hover {text-decoration:underline;text-decoration-color:#8bd4ffcc;text-decoration-thickness:1px;text-underline-offset:2px;}
    .elvax-video-compare-pro .capture-control {display:flex;align-items:center;flex:1 1 0;min-width:0;overflow:hidden;border:1px solid #666;border-radius:4px;background:#333;}
    .elvax-video-compare-pro .capture {flex:1 1 0;min-width:0;min-height:26px;padding:5px 6px;line-height:16px;border:0;background:transparent;}
    .elvax-video-compare-pro .capture-auto {display:flex;flex:0 0 auto;align-items:center;gap:4px;padding:0 6px;cursor:pointer;color:#c1cbd3;font-size:10px;}
    .elvax-video-compare-pro .capture-auto input {appearance:none;position:relative;width:11px;height:11px;margin:0;border:1px solid #86939f;border-radius:3px;background:#ffffff05;cursor:pointer;}
    .elvax-video-compare-pro .capture-auto input:checked {border-color:#8bd4ff;background:#8bd4ff;}
    .elvax-video-compare-pro .capture-auto input:checked::after {content:"";position:absolute;left:3px;top:1px;width:3px;height:5px;border:solid #17232c;border-width:0 1.5px 1.5px 0;transform:rotate(45deg);}
    .elvax-video-compare-pro .capture-auto input:focus-visible {box-shadow:0 0 0 2px #8bd4ff40;}
    .elvax-video-compare-pro .capture-control:has(.capture:not(:disabled)):hover {background:#444;}
    .elvax-video-compare-pro .capture:disabled {cursor:default;}
    .elvax-video-compare-pro .mode-row {display:grid;grid-template-columns:repeat(3,minmax(0,1fr));flex:0 0 auto;gap:4px;padding:2px 8px;box-sizing:border-box;border-bottom:1px solid #ffffff12;}
    .elvax-video-compare-pro .mode-cell {position:relative;min-width:0;}
    .elvax-video-compare-pro .mode-button {display:flex;align-items:center;justify-content:center;width:100%;height:24px;padding:1px 8px;border:1px solid transparent;border-radius:6px;background:transparent;font-size:10px;line-height:16px;color:#929eaa;transition:background .15s,color .15s,border-color .15s;}
    .elvax-video-compare-pro .mode-button.before-after-control {gap:4px;padding-left:2px;padding-right:2px;}
    .elvax-video-compare-pro .before-after-option {font-size:inherit;color:#929eaa;transition:color .15s;}
    .elvax-video-compare-pro .before-after-option.is-current {color:#d6ecff;}
    .elvax-video-compare-pro .before-after-switch {position:relative;flex:0 0 2em;width:2em;height:1.2em;box-sizing:border-box;border:0;border-radius:8em;background:#293541;box-shadow:inset 0 0 0 1px #68798a;}
    .elvax-video-compare-pro .before-after-switch::after {content:"";position:absolute;top:50%;left:.2em;width:.8em;height:.8em;border-radius:50%;background:#d6ecff;transform:translateY(-50%);transition:transform .18s cubic-bezier(.2,.8,.2,1);}
    .elvax-video-compare-pro .before-after-switch[data-side=after]::after {transform:translate(.8em,-50%);}
    .elvax-video-compare-pro .before-after-switch[data-side=neutral] {background:#25282d;box-shadow:inset 0 0 0 1px #454b52;}
    .elvax-video-compare-pro .before-after-arrows {position:absolute;left:50%;top:50%;display:none;width:1.4em;height:.9em;overflow:visible;transform:translate(-50%,-50%);}
    .elvax-video-compare-pro .before-after-arrows path {fill:none;stroke:#9aa3ad;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}
    .elvax-video-compare-pro .before-after-switch[data-side=neutral]::after {display:none;}
    .elvax-video-compare-pro .before-after-switch[data-side=neutral] .before-after-arrows {display:block;}
    .elvax-video-compare-pro .mode-button:hover {background:#ffffff0c;color:#eee;}
    .elvax-video-compare-pro .mode-button[aria-pressed=true] {background:#243749;border-color:#4c6a83;color:#d6ecff;}
    .elvax-video-compare-pro .mode-button:disabled,.elvax-video-compare-pro .mode-button:disabled:hover,.elvax-video-compare-pro .mode-button:disabled[aria-pressed=true] {background:#242629;border-color:#3b3e42;color:#747a80;opacity:.6;cursor:default;}
    .elvax-video-compare-pro .mode-button:disabled .before-after-option {color:#747a80;}
    .elvax-video-compare-pro .mode-button:disabled .before-after-switch {background:#292c30;box-shadow:inset 0 0 0 1px #454b52;}
    .elvax-video-compare-pro .mode-button:disabled .before-after-switch::after {background:#81878e;}
    .elvax-video-compare-pro .mode-button:disabled .before-after-arrows path {stroke:#747a80;}
    .elvax-video-compare-pro .transport button {display:flex;flex:0 0 24px;align-items:center;justify-content:center;width:24px;height:24px;padding:3px;background:transparent;border:0;border-radius:4px;}
    .elvax-video-compare-pro .transport button:hover {background:#ffffff24;}
    .elvax-video-compare-pro .transport button.audio-source {background:#8bd4ff16;box-shadow:inset 0 0 0 1px #8bd4ff40;color:#8bd4ff;font-size:11px;font-weight:600;}
    .elvax-video-compare-pro .transport button.audio-source:disabled {cursor:default;}
    .elvax-video-compare-pro .audio-control {display:flex;align-items:center;flex:0 0 auto;border:1px solid #8bd4ff40;border-radius:4px;background:#8bd4ff0b;}
    .elvax-video-compare-pro .audio-control button.audio-source {background:transparent;box-shadow:none;}
    .elvax-video-compare-pro .audio-control .capture-auto {padding:0 5px;}
    .elvax-video-compare-pro:fullscreen .audio-control .capture-auto {font-size:14px;}
    .elvax-video-compare-pro .transport {gap:4px;padding:4px 6px;}
    .elvax-video-compare-pro .time {flex:0 0 auto;font-variant-numeric:tabular-nums;white-space:nowrap;font-size:11px;}
    .elvax-video-compare-pro .volume {flex:0 1 42px;width:42px;min-width:14px;}
    .elvax-video-compare-pro input[type=range] {appearance:none;height:3px;margin:0;background:#888;cursor:pointer;min-width:0;}
    .elvax-video-compare-pro input[type=range]::-webkit-slider-thumb {appearance:none;width:9px;height:9px;background:white;border-radius:50%;}
    .elvax-video-compare-pro .blend-control {grid-area:1 / 2;position:relative;justify-self:center;width:100%;max-width:200px;min-width:0;height:15px;box-sizing:border-box;}
    .elvax-video-compare-pro .blend-control::before {content:"";position:absolute;inset:0;border-radius:2px;background:linear-gradient(90deg,#8faabb26 var(--blend-fill,50%),#ffffff04 var(--blend-fill,50%));box-shadow:inset 0 -1px #ffffff18;transition:filter .15s;pointer-events:none;}
    .elvax-video-compare-pro .blend-control::after {content:"";position:absolute;left:clamp(1px,var(--blend-fill,50%),calc(100% - 1px));top:4px;bottom:4px;width:1px;background:#b7cbd8;opacity:0;pointer-events:none;transition:opacity .15s;}
    .elvax-video-compare-pro .blend-control:hover::before,.elvax-video-compare-pro .blend-control:focus-within::before {filter:brightness(1.4);}
    .elvax-video-compare-pro .blend-control:hover::after,.elvax-video-compare-pro .blend-control:focus-within::after {opacity:1;}
    .elvax-video-compare-pro input.blend[type=range] {position:absolute;inset:0;z-index:1;width:100%;height:100%;min-width:0;margin:0;background:transparent;cursor:ew-resize;touch-action:none;}
    .elvax-video-compare-pro input.blend[type=range]::-webkit-slider-thumb {width:1px;height:1px;background:transparent;box-shadow:none;}
    .elvax-video-compare-pro input.blend[type=range]::-moz-range-thumb {width:1px;height:1px;border:0;background:transparent;}
    .elvax-video-compare-pro .blend-value {position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;color:#b8c6d0;font-size:9px;line-height:1;font-variant-numeric:tabular-nums;white-space:nowrap;}
    .elvax-video-compare-pro .status:empty {display:none;}
    .elvax-video-compare-pro:fullscreen {background:#111;padding:16px;box-sizing:border-box;--compare-gap:12px;}
    .elvax-video-compare-pro:fullscreen .capture-row {display:none;}
    .elvax-video-compare-pro:fullscreen .mode-row {padding:8px;gap:6px;}
    .elvax-video-compare-pro:fullscreen .mode-row {width:100%;align-self:stretch;padding:8px max(8px,calc((100% - 960px)/2 + 8px));box-sizing:border-box;}
    .elvax-video-compare-pro:fullscreen .mode-button {height:40px;padding:4px;font-size:clamp(16px,1.25vw,22px);line-height:1;}
    .elvax-video-compare-pro:fullscreen .captions {--caption-inset:12px;font-size:clamp(16px,1.4vw,24px);line-height:1.4;padding-top:10px;padding-bottom:10px;}
    .elvax-video-compare-pro:fullscreen .generation-panel {font-size:clamp(11px,.75vw,14px);}
    .elvax-video-compare-pro:fullscreen .generation-open .media-row {grid-template-columns:minmax(0,1fr) 6px minmax(0,var(--generation-fullscreen-width,33.333333%));}
    .elvax-video-compare-pro:fullscreen .generation-header {height:57px;min-height:57px;padding:4px 12px;}
    .elvax-video-compare-pro:fullscreen .generation-header .generation-heading {font-size:clamp(15px,1vw,20px);}
    .elvax-video-compare-pro:fullscreen .generation-count {padding:4px 8px;font-size:clamp(12px,.75vw,16px);}
    .elvax-video-compare-pro:fullscreen .generation-controls {margin-bottom:16px;font-size:clamp(14px,.9vw,18px);}
    .elvax-video-compare-pro:fullscreen .generation-controls label {gap:10px;}
    .elvax-video-compare-pro:fullscreen .generation-controls input {flex-basis:18px;width:18px;height:18px;}
    .elvax-video-compare-pro:fullscreen .generation-controls input:checked::after {left:5px;top:2px;width:5px;height:8px;}
    .elvax-video-compare-pro:fullscreen .generation-toggle {flex-basis:48px;width:48px;height:48px;padding:8px;}
    .elvax-video-compare-pro:fullscreen .generation-icon {width:28px;height:28px;flex-basis:28px;}
    .elvax-video-compare-pro:fullscreen .generation-content {padding:12px;}
    .elvax-video-compare-pro:fullscreen .media-row {width:100%;}
    .elvax-video-compare-pro:fullscreen .blend-value {font-size:clamp(13px,1vw,16px);}
    .elvax-video-compare-pro:fullscreen .blend-control {height:30px;max-width:240px;}
    .elvax-video-compare-pro:fullscreen .video-panel,.elvax-video-compare-pro:fullscreen .status {width:100%;}
    .elvax-video-compare-pro:fullscreen .transport {gap:4px;padding:8px 6px;}
    .elvax-video-compare-pro:fullscreen .transport button {flex-basis:36px;width:36px;height:44px;}
    .elvax-video-compare-pro:fullscreen .transport button svg {width:30px;height:30px;}
    .elvax-video-compare-pro:fullscreen .transport button.audio-source {font-size:18px;}
    .elvax-video-compare-pro:fullscreen .time {font-size:14px;}
    .elvax-video-compare-pro:fullscreen .volume {flex-basis:84px;width:84px;}
    .elvax-video-compare-pro:fullscreen input[type=range] {height:5px;}
    .elvax-video-compare-pro:fullscreen input[type=range]::-webkit-slider-thumb {width:12px;height:12px;}
    .elvax-video-compare-pro:fullscreen input[type=range]::-moz-range-thumb {width:12px;height:12px;background:white;border:0;border-radius:50%;}
    .elvax-video-compare-pro:fullscreen input.blend[type=range] {height:100%;}
    .elvax-video-compare-pro:fullscreen input.blend[type=range]::-webkit-slider-thumb {width:1px;height:1px;background:transparent;}
    .elvax-video-compare-pro:fullscreen input.blend[type=range]::-moz-range-thumb {width:1px;height:1px;background:transparent;}
    .elvax-video-compare-pro:fullscreen input.blend[type=range] {background-size:100% 5px;}
    .elvax-video-compare-pro:fullscreen .time-seek {background-size:100% 5px !important;}
  `;
  const buttons = document.createElement("div");
  buttons.className = "capture-row";
  buttons.style.cssText = "gap:6px;flex-shrink:0;";
  const modes = document.createElement("div");
  modes.className = "mode-row";
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Comparison mode");
  const modeButtons = new Map();
  const modeCells = new Map();
  for (const [mode, label, title] of [
    ["split", "Slider", "Hover over the video to compare Before on the left and After on the right."],
    ["overlay", "Before/After", "Toggle between showing Before and After. Use the Overlay slider to blend them."],
    ["side-by-side", "Side by Side", "Show both complete videos beside each other."],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mode-button";
    if (mode === "overlay") {
      button.classList.add("before-after-control");
      button.innerHTML = '<span class="before-after-option before-after-option-before">Before</span><span class="before-after-switch" aria-hidden="true"><svg class="before-after-arrows" viewBox="0 0 20 12"><path d="M8 2 3 6l5 4M12 2l5 4-5 4"/></svg></span><span class="before-after-option before-after-option-after">After</span>';
    } else {
      button.textContent = label;
    }
    button.title = title;
    button.setAttribute("aria-label", title);
    button.dataset.enabledTitle = title;
    button.dataset.mode = mode;
    button.addEventListener("click", () => {
      if (mode === "overlay") {
        const alreadySelected = state().mode === "overlay";
        state().mode = "overlay";
        state().blend = alreadySelected && state().blend <= 0.5 ? 1 : 0;
      } else {
        state().mode = mode;
      }
      updateView(true);
      node.graph?.setDirtyCanvas(true, true);
    });
    modeButtons.set(mode, button);
    const cell = document.createElement("div");
    cell.className = "mode-cell";
    cell.append(button);
    modes.append(cell);
    modeCells.set(mode, cell);
  }
  const blend = document.createElement("input");
  blend.className = "blend";
  blend.type = "range";
  blend.min = "0";
  blend.max = "1";
  blend.step = ".01";
  blend.title = "Blend: 0% Before, 100% After";
  blend.setAttribute("aria-label", "Blend");
  const blendValue = document.createElement("output");
  blendValue.className = "blend-value";
  const blendControl = document.createElement("div");
  blendControl.className = "blend-control";
  blendControl.title = "Click or drag to blend. Arrow keys adjust by 1%. Double-click resets to 50%.";
  blendControl.append(blend, blendValue);
  blend.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || blend.disabled) return;
    event.stopPropagation();
    state().mode = "overlay";
    updateView();
  });
  blend.addEventListener("input", () => {
    state().blend = Number(blend.value);
    state().mode = "overlay";
    updateView(true);
  });
  blend.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (blend.disabled) return;
    state().blend = 0.5;
    state().mode = "overlay";
    updateView(true);
  });
  const panel = document.createElement("div");
  panel.className = "video-panel";
  panel.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;background:#111;border-radius:4px;";
  const stage = document.createElement("div");
  const emptyHint = document.createElement("div");
  emptyHint.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:20px;text-align:center;pointer-events:none;color:#aeb8c1;font-size:12px;line-height:1.5;";
  const emptyTitle = document.createElement("div");
  emptyTitle.textContent = "Drag and drop videos here, or connect video inputs and click Load.";
  const emptyDetail = document.createElement("div");
  emptyDetail.textContent = "Drop left for Before · Drop right for After";
  emptyDetail.style.cssText = "font-size:10px;color:#77838e;";
  emptyHint.append(emptyTitle, emptyDetail);
  stage.className = "stage";
  stage.tabIndex = 0;
  stage.style.cssText = "position:relative;display:flex;align-items:center;justify-content:center;flex:1;min-height:0;overflow:hidden;background:#111;outline:none;";
  const mediaRow = document.createElement("div");
  mediaRow.className = "media-row";
  const videos = [document.createElement("video"), document.createElement("video")];
  const videoStyle = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:transparent;pointer-events:none;";
  for (const video of videos) {
    video.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
    video.preload = "metadata";
    video.playsInline = true;
    video.muted = true;
    frameQueues.set(video, []);
    frameIntervals.set(video, 1 / 30);
  }
  const [before, after] = videos;
  const frameSurfaces = videos.map(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 0;
    return canvas;
  });
  const afterClip = document.createElement("div");
  afterClip.style.cssText = "position:absolute;inset:0;background:#111;pointer-events:none;";
  afterClip.append(after, frameSurfaces[1]);
  const message = document.createElement("div");
  message.className = "status";
  message.style.cssText = "flex:0 0 auto;box-sizing:border-box;padding:6px 8px;border:1px solid #ffffff24;border-radius:6px;background:#111d;text-align:center;color:#aaa;overflow-wrap:anywhere;";
  function updateStatus() {
    message.textContent = [...Object.values(uploadStatus), audioUnavailable ? "Audio unavailable. Video playback is still available." : ""].filter(Boolean).join(" · ");
  }
  const captions = document.createElement("div");
  captions.className = "captions";
  captions.style.cssText = "display:grid;flex:0 0 auto;align-items:center;gap:8px;color:#bbb;";
  const labels = ["Before", "After"].map((text) => {
    const label = document.createElement("div");
    label.className = "caption-label";
    label.textContent = text;
    return label;
  });
  const generationToggle = document.createElement("button");
  generationToggle.type = "button";
  generationToggle.className = "generation-toggle";
  generationToggle.title = "Show Generation Differences";
  generationToggle.setAttribute("aria-label", generationToggle.title);
  generationToggle.innerHTML = '<svg class="generation-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 3.5h4M3 7.5h3M3 11.5h2M10 3l3 3-3 3M13 6H8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 10.5h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  generationToggle.setAttribute("aria-expanded", "false");
  const generationCount = document.createElement("span");
  generationCount.className = "generation-count";
  const generationPanel = document.createElement("section");
  generationPanel.className = "generation-panel";
  generationPanel.setAttribute("aria-label", "Generation differences");
  const generationHeader = document.createElement("div");
  generationHeader.className = "generation-header";
  const generationHeading = document.createElement("div");
  generationHeading.className = "generation-heading";
  generationHeading.textContent = "Generation Differences";
  generationHeading.title = generationHeading.textContent;
  generationHeader.append(generationHeading, generationCount);
  const generationContent = document.createElement("div");
  generationContent.className = "generation-content";
  const generationColumns = document.createElement("div");
  generationColumns.className = "generation-columns";
  const generationTable = document.createElement("div");
  generationTable.className = "generation-table";
  const generationComparison = document.createElement("div");
  generationComparison.className = "generation-comparison";
  generationComparison.append(generationColumns, generationTable);
  const generationControls = document.createElement("div");
  generationControls.className = "generation-controls";
  const showMatchingLabel = document.createElement("label");
  const showMatching = document.createElement("input");
  showMatching.type = "checkbox";
  showMatchingLabel.append(showMatching, document.createTextNode("Show matching settings"));
  generationControls.append(showMatchingLabel);
  generationContent.append(generationControls, generationComparison);
  generationPanel.append(generationHeader, generationContent);
  const afterGroup = document.createElement("div");
  afterGroup.className = "caption-after";
  afterGroup.append(labels[1], generationToggle);
  const generationResizer = document.createElement("div");
  generationResizer.className = "generation-resizer";
  generationResizer.tabIndex = 0;
  generationResizer.setAttribute("role", "separator");
  generationResizer.setAttribute("aria-orientation", "vertical");
  generationResizer.setAttribute("aria-valuemin", "20");
  generationResizer.setAttribute("aria-valuemax", "80");
  generationResizer.setAttribute("aria-label", "Resize video and generation differences panel");
  generationResizer.title = "Drag to resize. Double-click to reset.";
  mediaRow.append(captions, stage, generationResizer, generationPanel);
  let panelResize = null;
  function syncPanelWidth() {
    cachedVideoBounds = null;
    const normal = Number.isFinite(state().generationPanelWidth) ? state().generationPanelWidth : .5;
    const fullscreen = Number.isFinite(state().generationFullscreenWidth) ? state().generationFullscreenWidth : 1 / 3;
    mediaRow.style.setProperty("--generation-panel-width", `${normal * 100}%`);
    mediaRow.style.setProperty("--generation-fullscreen-width", `${fullscreen * 100}%`);
    generationResizer.setAttribute("aria-valuenow", String(Math.round((document.fullscreenElement === root ? fullscreen : normal) * 100)));
  }
  function resizePanel(ratio) {
    const width = mediaRow.clientWidth;
    const minimum = Math.min(.45, Math.max(.2, 150 / width));
    const maximum = Math.max(.55, Math.min(.8, 1 - 126 / width));
    const property = document.fullscreenElement === root ? "generationFullscreenWidth" : "generationPanelWidth";
    state()[property] = Math.max(minimum, Math.min(maximum, ratio));
    syncPanelWidth();
  }
  generationResizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const width = mediaRow.getBoundingClientRect().width;
    panelResize = { pointerId: event.pointerId, x: event.clientX,
      ratio: generationPanel.getBoundingClientRect().width / width };
    generationResizer.setPointerCapture(event.pointerId);
    generationResizer.focus({ preventScroll: true });
  });
  generationResizer.addEventListener("pointermove", (event) => {
    if (panelResize?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    resizePanel(panelResize.ratio + (panelResize.x - event.clientX) / mediaRow.getBoundingClientRect().width);
  });
  function finishPanelResize(event) {
    if (panelResize?.pointerId !== event.pointerId) return;
    panelResize = null;
    if (generationResizer.hasPointerCapture(event.pointerId)) generationResizer.releasePointerCapture(event.pointerId);
    node.graph?.change();
  }
  generationResizer.addEventListener("pointerup", finishPanelResize);
  generationResizer.addEventListener("pointercancel", finishPanelResize);
  generationResizer.addEventListener("lostpointercapture", finishPanelResize);
  generationResizer.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    resizePanel(document.fullscreenElement === root ? 1 / 3 : .5);
    node.graph?.change();
  });
  generationResizer.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const ratio = generationPanel.getBoundingClientRect().width / mediaRow.getBoundingClientRect().width;
    resizePanel(ratio + (event.key === "ArrowLeft" ? 1 : -1) * (event.shiftKey ? .05 : .01));
    node.graph?.change();
  });
  let generationOpen = Boolean(state().generationOpen);
  function generationValue(item, value) {
    const text = String(value).replace(/model strength\s+([-+]?(?:\d*\.)?\d+)/g, "strength: $1");
    return item.name.startsWith("LoRA ") ? text.replace(/^(.+?)\s+\(([^()]*(?:strength)[^()]*)\)$/i, "($2) $1") : text;
  }
  function settingsMap(entry) {
    return new Map((entry?.generation || []).flatMap((item) => item.name === "Seed" || item.name.startsWith("LoRA ") ? []
        : [[item.name, item.values.map((value) => generationValue(item, value)).join(item.staged ? " > " : ", ")]]));
  }
  function seedPairs(beforeEntry, afterEntry) {
    const read = (entry) => {
      const item = entry.generation?.find((setting) => setting.name === "Seed");
      return (item?.values || []).map((value, index) => ({ ...item.sources?.[index],
        title: item.labels?.[index] || `Seed ${index + 1}`, value: String(value) }));
    };
    const before = read(beforeEntry);
    const after = read(afterEntry);
    const used = new Set();
    const pairs = before.map((seed) => {
      let index = seed.workflow ? after.findIndex((other, i) => !used.has(i)
        && other.workflow === seed.workflow && other.id === seed.id && other.type === seed.type) : -1;
      if (index < 0) {
        const matches = after.map((other, i) => ({ other, i })).filter(({ other, i }) => !used.has(i)
          && other.title === seed.title && other.type === seed.type
          && !(seed.workflow && other.workflow === seed.workflow));
        if (matches.length === 1 && before.filter((other) => other.title === seed.title && other.type === seed.type).length === 1) index = matches[0].i;
      }
      if (index >= 0) used.add(index);
      return { before: seed, after: index >= 0 ? after[index] : null };
    });
    after.forEach((seed, i) => { if (!used.has(i)) pairs.push({ before: null, after: seed }); });
    return pairs;
  }
  function loraSettings(entry) {
    const occurrences = new Map();
    return (entry?.generation || []).filter((item) => item.name.startsWith("LoRA ")).flatMap((item) =>
      item.values.map((value) => {
        const text = generationValue(item, value);
        const name = text.replace(/^\(([^)]*strength[^)]*)\)\s*/i, "").trim();
        const identity = name.replace(/[\\/]+/g, "/").toLocaleLowerCase();
        const occurrence = occurrences.get(identity) || 0;
        occurrences.set(identity, occurrence + 1);
        const strengths = [...strengthValues(text)].sort(([a], [b]) => a.localeCompare(b));
        return { key: `${identity}\u0000${occurrence}`, text, comparison: JSON.stringify([identity, strengths]) };
      }));
  }
  const strengthPattern = /\b(clip strength|model strength|strength)\s*:?\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/gi;
  function strengthValues(text) {
    const details = text.match(/^\(([^)]*strength[^)]*)\)/i)?.[1] || "";
    return new Map([...details.matchAll(strengthPattern)].map((match) => [match[1].toLowerCase() === "clip strength" ? "clip" : "model", Number(match[2])]));
  }
  function renderGenerationValue(element, text, highlightSetting, otherText, staged) {
    if (staged) {
      const otherValues = otherText.split(" > ");
      text.split(" > ").forEach((text, index) => {
        if (index) element.append(document.createTextNode(" > "));
        const value = document.createElement("span");
        if (text !== "Unknown" && text !== otherValues[index]) value.className = "generation-strength";
        value.textContent = text;
        element.append(value);
      });
      return;
    }
    if (highlightSetting && text !== "Unavailable") {
      const value = document.createElement("span");
      value.className = "generation-strength";
      value.textContent = text;
      element.append(value);
      return;
    }
    const otherStrengths = strengthValues(otherText);
    const detailsEnd = text.startsWith("(") ? text.indexOf(")") : -1;
    let start = 0;
    for (const match of text.matchAll(strengthPattern)) {
      const label = match[1].toLowerCase() === "clip strength" ? "clip" : "model";
      if (match.index > detailsEnd || Number(match[2]) === otherStrengths.get(label)) continue;
      element.append(document.createTextNode(text.slice(start, match.index) + match[0].slice(0, -match[2].length)));
      const number = document.createElement("span");
      number.className = "generation-strength";
      number.textContent = match[2];
      element.append(number);
      start = match.index + match[0].length;
    }
    element.append(document.createTextNode(text.slice(start)));
  }
  let generationPanelSignature = null;
  function updateGenerationPanel() {
    syncPanelWidth();
    const bothLoaded = Boolean(state().before && state().after);
    const visible = bothLoaded;
    panel.classList.toggle("generation-open", visible && generationOpen);
    generationPanel.style.display = visible && generationOpen ? "flex" : "none";
    if (visible && generationOpen) generationHeader.prepend(generationToggle);
    else afterGroup.append(generationToggle);
    generationToggle.style.display = visible ? "inline-flex" : "none";
    generationToggle.setAttribute("aria-expanded", String(visible && generationOpen));
    generationToggle.title = generationOpen ? "Hide Generation Differences" : "Show Generation Differences";
    generationToggle.setAttribute("aria-label", generationToggle.title);
    if (!bothLoaded) {
      generationPanelSignature = null;
      generationCount.textContent = "";
      return;
    }
    const signature = [state().before.generation, state().after.generation, showMatching.checked];
    if (generationPanelSignature && signature.every((value, index) => value === generationPanelSignature[index])) return;
    generationPanelSignature = signature;
    const beforeSettings = settingsMap(state().before);
    const afterSettings = settingsMap(state().after);
    const stagedNames = new Set([...(state().before.generation || []), ...(state().after.generation || [])]
      .filter((item) => item.staged).map((item) => item.name));
    const beforeLoras = new Map(loraSettings(state().before).map((item) => [item.key, item]));
    const afterLoras = new Map(loraSettings(state().after).map((item) => [item.key, item]));
    const loraNameToKey = new Map();
    const seedNameToPair = new Map(seedPairs(state().before, state().after).map((pair, index) => [`Seed ${index + 1}`, pair]));
    for (const key of new Set([...beforeLoras.keys(), ...afterLoras.keys()])) {
      loraNameToKey.set(`LoRA ${loraNameToKey.size + 1}`, key);
    }
    const rank = (name) => {
      const index = GENERATION_ORDER.indexOf(name.replace(/^(LoRA|Seed) \d+$/, "$1"));
      return index < 0 ? GENERATION_ORDER.length : index;
    };
    const names = [...new Set([...beforeSettings.keys(), ...afterSettings.keys(), ...loraNameToKey.keys(), ...seedNameToPair.keys()])]
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true }));
    const rows = names.map((name) => {
      const seedPair = seedNameToPair.get(name);
      const seedLabels = seedPair ? [seedPair.before?.title, seedPair.after?.title] : [];
      const label = [...new Set(seedLabels.filter(Boolean))].join(" / ") || name;
      const loraKey = loraNameToKey.get(name);
      const beforeLora = beforeLoras.get(loraKey);
      const afterLora = afterLoras.get(loraKey);
      const beforeValue = seedPair ? seedPair.before?.value : loraKey === undefined ? beforeSettings.get(name) : beforeLora?.text;
      const afterValue = seedPair ? seedPair.after?.value : loraKey === undefined ? afterSettings.get(name) : afterLora?.text;
      const staged = stagedNames.has(name);
      const beforeStages = beforeValue?.split(" > ") || [];
      const afterStages = afterValue?.split(" > ") || [];
      if (staged) {
        const length = Math.max(beforeStages.length, afterStages.length);
        while (beforeStages.length < length) beforeStages.push("Unknown");
        while (afterStages.length < length) afterStages.push("Unknown");
      }
      return {
        name,
        label,
        staged,
        before: staged ? beforeStages.join(" > ") : beforeValue || "Unavailable",
        after: staged ? afterStages.join(" > ") : afterValue || "Unavailable",
        differs: loraKey === undefined ? beforeValue !== afterValue : beforeLora?.comparison !== afterLora?.comparison,
      };
    });
    const different = rows.filter((row) => row.differs);
    generationCount.textContent = different.length ? `${different.length} ${different.length === 1 ? "change" : "changes"}` : "";
    generationColumns.replaceChildren();
    for (const text of ["Before", "After"]) {
      const heading = document.createElement("div");
      heading.className = "generation-heading";
      heading.textContent = text;
      generationColumns.append(heading);
    }
    generationTable.replaceChildren();
    const shownRows = showMatching.checked ? rows : different;
    generationComparison.classList.toggle("has-rows", shownRows.length > 0);
    generationColumns.style.display = shownRows.length ? "grid" : "none";
    for (const row of shownRows) {
      const setting = document.createElement("div");
      setting.className = "generation-row";
      setting.classList.toggle("is-different", row.differs);
      const name = document.createElement("div");
      name.className = "generation-name";
      name.textContent = row.label;
      const values = document.createElement("div");
      values.className = "generation-values";
      for (const [text, otherText] of [[row.before, row.after], [row.after, row.before]]) {
        const value = document.createElement("div");
        value.className = "generation-value";
        renderGenerationValue(value, text, row.differs && ["Steps", "Sampler", "Scheduler"].includes(row.name), otherText, row.staged);
        values.append(value);
      }
      setting.append(name, values);
      generationTable.append(setting);
    }
    if (!shownRows.length) {
      const empty = document.createElement("div");
      empty.className = "generation-empty";
      empty.textContent = rows.length ? "No differences found in available metadata." : "Generation settings are unavailable for one or both videos.";
      generationTable.append(empty);
    }
    generationControls.style.display = rows.length ? "flex" : "none";
  }
  generationToggle.addEventListener("click", () => {
    generationOpen = !generationOpen;
    state().generationOpen = generationOpen;
    updateGenerationPanel();
    syncCaptionsToVideo();
    node.graph?.change();
    node.graph?.setDirtyCanvas(true, true);
  });
  showMatching.checked = Boolean(state().showMatching);
  showMatching.addEventListener("change", () => {
    state().showMatching = showMatching.checked;
    updateGenerationPanel();
    node.graph?.change();
  });
  captions.append(labels[0], blendControl, afterGroup);
  const divider = document.createElement("div");
  divider.setAttribute("aria-hidden", "true");
  divider.tabIndex = -1;
  divider.style.cssText = "position:absolute;top:0;bottom:0;width:20px;transform:translateX(-50%);pointer-events:none;";
  const line = document.createElement("div");
  line.style.cssText = "position:absolute;left:50%;top:0;bottom:0;width:1px;transform:translateX(-50%);background:#ffffffe0;box-shadow:0 0 2px #0006;";
  divider.append(line);

  const transport = document.createElement("div");
  transport.className = "transport";
  transport.style.cssText = "display:flex;flex:0 0 auto;align-items:center;box-sizing:border-box;border-top:1px solid #ffffff24;background:#111d;";
  function iconButton(parent, title, paths, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${paths.map((path) => `<path d="${path}"/>`).join("")}</svg>`;
    button.addEventListener("click", action);
    parent.append(button);
    return button;
  }
  const playButton = iconButton(transport, "Play / pause", ["M8 5l11 7-11 7z"], togglePlayback);
  const time = document.createElement("span");
  time.className = "time";
  const seek = document.createElement("input");
  seek.className = "time-seek";
  seek.type = "range";
  seek.min = "0";
  seek.max = "0";
  seek.step = ".001";
  seek.value = "0";
  seek.title = "Seek both videos";
  seek.style.cssText = "flex:1 1 0;width:0;min-width:10px;height:12px;background:linear-gradient(#888,#888) center / 100% 3px no-repeat;";
  transport.append(time, seek);
  const mute = iconButton(transport, "Mute / unmute audio", ["M11 5L6 9H3v6h3l5 4z", "M16 9l5 6M21 9l-5 6"], () => {
    state().muted = !state().muted;
    applyAudio();
  });
  const audioSource = document.createElement("button");
  audioSource.type = "button";
  audioSource.className = "audio-source";
  audioSource.addEventListener("pointerenter", updateAudioCaptionHover);
  audioSource.addEventListener("pointerleave", updateAudioCaptionHover);
  audioSource.addEventListener("click", () => {
    state().audioAuto = false;
    audioAuto.checked = false;
    state().audioSource = audioVideo() === after ? "before" : "after";
    applyAudio(true);
    node.graph?.change();
  });
  const audioControl = document.createElement("div");
  audioControl.className = "audio-control";
  const audioAutoLabel = document.createElement("label");
  audioAutoLabel.className = "capture-auto";
  audioAutoLabel.title = "Switch audio when a side becomes fully visible. Keep that audio between endpoints.";
  const audioAuto = document.createElement("input");
  audioAuto.type = "checkbox";
  audioAuto.checked = state().audioAuto;
  audioAuto.setAttribute("aria-label", "Automatic audio switching");
  audioAutoLabel.addEventListener("pointerdown", (event) => event.stopPropagation());
  audioAuto.addEventListener("change", () => {
    state().audioAuto = audioAuto.checked;
    updateAutoAudio(true);
    node.graph?.change();
  });
  audioAutoLabel.append(audioAuto, document.createTextNode("Auto"));
  audioControl.append(audioSource, audioAutoLabel);
  transport.append(audioControl);
  const volume = document.createElement("input");
  volume.type = "range";
  volume.min = "0";
  volume.max = "1";
  volume.step = ".01";
  volume.value = String(state().volume ?? 1);
  volume.title = "Audio volume";
  volume.className = "volume";
  transport.append(volume);
  iconButton(transport, "Fullscreen", ["M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"], () => {
    if (document.fullscreenElement === root) document.exitFullscreen();
    else root.requestFullscreen().catch(() => {});
  });

  function primary() { return state().before ? before : after; }
  function audioVideo() {
    if (state().audioSource === "after" && state().after) return after;
    if (state().audioSource === "before" && state().before) return before;
    if (state().before && inputKey(node, "before")) return before;
    if (state().after && inputKey(node, "after")) return after;
    return state().before ? before : after;
  }
  function playbackVideo() {
    if (playbackMaster) return playbackMaster;
    const audio = audioVideo();
    const target = seekRenderTarget ?? pendingTimelineSeek ?? renderedTime ?? state().time ?? 0;
    if (!audio.error && audio.hasAttribute("src") && (!Number.isFinite(audio.duration) || target < audio.duration)) return audio;
    return !after.error && after.hasAttribute("src") && (before.error || !before.hasAttribute("src") || (after.duration || 0) > (before.duration || 0)) ? after : before;
  }
  function applyAudio(feedback = false) {
    const selected = audioVideo();
    const source = selected === after ? "after" : "before";
    const targetVolume = Number(state().volume ?? 1);
    if (feedback && lastAudioSource && lastAudioSource !== selected) playSwitchTick();
    lastAudioSource = selected;
    for (const video of videos) {
      video.volume = targetVolume;
      if (audioUnavailable) video.muted = true;
      else if (audioContext) {
        video.muted = false;
        const gain = audioGains.get(video).gain;
        const now = audioContext.currentTime;
        gain.cancelAndHoldAtTime(now);
        gain.linearRampToValueAtTime(video === selected && !state().muted ? 1 : 0, now + .025);
      } else video.muted = video !== selected || Boolean(state().muted);
    }
    const muted = audioUnavailable || Boolean(state().muted) || targetVolume === 0;
    mute.style.color = muted ? "#aaa" : "#8bd4ff";
    mute.title = `Mute / unmute ${source === "after" ? "After" : "Before"} audio`;
    mute.setAttribute("aria-label", mute.title);
    mute.querySelectorAll("path")[1].setAttribute("d", muted ? "M16 9l5 6M21 9l-5 6" : "M16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14");
    audioSource.textContent = source === "after" ? "A" : "B";
    audioSource.disabled = audioUnavailable || !state().before || !state().after;
    audioAuto.disabled = audioUnavailable;
    audioSource.title = `Audio: ${source === "after" ? "After (A)" : "Before (B)"}${audioSource.disabled ? "" : `. Click to switch to ${source === "after" ? "Before (B)" : "After (A)"}`}.`;
    audioSource.setAttribute("aria-label", audioSource.title);
    updateAudioCaptionHover();
    volume.title = `${source === "after" ? "After" : "Before"} audio volume`;
  }
  async function initializeAudio() {
    if (audioUnavailable || disposed) return;
    try {
      if (!audioContext) {
        audioContext = new AudioContext();
        for (const video of videos) {
          const gain = audioContext.createGain();
          gain.gain.value = 0;
          audioContext.createMediaElementSource(video).connect(gain);
          gain.connect(audioContext.destination);
          audioGains.set(video, gain);
        }
      }
      await audioContext.resume();
    } catch {
      audioUnavailable = true;
      for (const video of videos) video.muted = true;
      updateStatus();
    }
  }
  function playSwitchTick() {
    const targetVolume = Number(state().volume ?? 1);
    if (disposed || audioUnavailable || state().muted || targetVolume === 0) return;
    if (!audioContext || audioContext.state !== "running") {
      initializeAudio().then(() => { if (!disposed) playSwitchTick(); }).catch(() => {});
      return;
    }
    const now = audioContext.currentTime;
    if (now - lastTickTime < .015) return;
    lastTickTime = now;
    const tone = audioContext.createOscillator();
    const envelope = audioContext.createGain();
    tone.frequency.setValueAtTime(1800, now);
    tone.frequency.exponentialRampToValueAtTime(900, now + .009);
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(.012 * targetVolume, now + .001);
    envelope.gain.exponentialRampToValueAtTime(.00001, now + .009);
    tone.connect(envelope);
    envelope.connect(audioContext.destination);
    tone.onended = () => { tone.disconnect(); envelope.disconnect(); };
    tone.start(now);
    tone.stop(now + .010);
  }
  function updateAutoAudio(feedback = false) {
    if (!state().audioAuto || !state().before || !state().after) return;
    let source = null;
    if (state().mode === "split") {
      if (state().position === 100) source = "before";
      else if (state().position === 0) source = "after";
    } else if (state().mode === "overlay") {
      if (state().blend === 0) source = "before";
      else if (state().blend === 1) source = "after";
    }
    if (!source || source === state().audioSource) return;
    state().audioSource = source;
    applyAudio(feedback);
  }
  function updateAudioCaptionHover() {
    const hovered = audioSource.matches(":hover");
    labels[0].classList.toggle("audio-source-hover", hovered && audioSource.textContent === "B");
    labels[1].classList.toggle("audio-source-hover", hovered && audioSource.textContent === "A");
  }
  function videoBounds() {
    if (cachedVideoBounds) return cachedVideoBounds;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    if (!width || !height) return { x: 0, y: 0, width, height };
    const bounds = videos.flatMap((video, index) => {
      if (!video.hasAttribute("src") || !video.videoWidth || !video.videoHeight) return [];
      const surface = frameSurfaces[index];
      const boxWidth = surface.clientWidth;
      const boxHeight = surface.clientHeight;
      if (!boxWidth || !boxHeight) return [];
      const scale = Math.min(boxWidth / video.videoWidth, boxHeight / video.videoHeight);
      const contentWidth = video.videoWidth * scale;
      const contentHeight = video.videoHeight * scale;
      return [{ x: surface.offsetLeft + (boxWidth - contentWidth) / 2,
        y: surface.offsetTop + (boxHeight - contentHeight) / 2,
        width: contentWidth, height: contentHeight }];
    });
    if (!bounds.length) return { x: 0, y: 0, width, height };
    const x = Math.min(...bounds.map((rect) => rect.x));
    const y = Math.min(...bounds.map((rect) => rect.y));
    cachedVideoBounds = { x, y, width: Math.max(...bounds.map((rect) => rect.x + rect.width)) - x,
      height: Math.max(...bounds.map((rect) => rect.y + rect.height)) - y };
    return cachedVideoBounds;
  }
  function syncCaptionsToVideo() {
    if (!captions.isConnected || !stage.clientWidth) return;
    const bounds = videoBounds();
    const left = bounds.x;
    const right = stage.clientWidth - bounds.x - bounds.width;
    captions.style.setProperty("--caption-left", `${Math.max(0, left)}px`);
    captions.style.setProperty("--caption-right", `${Math.max(0, right)}px`);
    captions.style.transform = `translateY(${Math.max(0, bounds.y)}px)`;
  }
  function position(value, feedback = false) {
    state().position = Math.max(0, Math.min(100, Number(value) || 0));
    updateAutoAudio(feedback);
    const both = Boolean(state().before && state().after);
    labels[0].classList.toggle("is-active", both && ((state().mode === "split" && state().position === 100) || (state().mode === "overlay" && state().blend === 0)));
    labels[1].classList.toggle("is-active", both && ((state().mode === "split" && state().position === 0) || (state().mode === "overlay" && state().blend === 1)));
    const visibleSide = labels[0].classList.contains("is-active") ? "before"
      : labels[1].classList.contains("is-active") ? "after" : null;
    if (visibleSide) {
      if (feedback && lastVisibleSide && visibleSide !== lastVisibleSide) playSwitchTick();
      lastVisibleSide = visibleSide;
    }
    generationComparison.classList.toggle("before-active", labels[0].classList.contains("is-active"));
    generationComparison.classList.toggle("after-active", labels[1].classList.contains("is-active"));
    const bounds = videoBounds();
    const x = bounds.x + bounds.width * state().position / 100;
    if (state().mode === "split" && state().before && state().after) {
      afterClip.style.clipPath = `inset(0 0 0 ${stage.clientWidth ? 100 * x / stage.clientWidth : 0}%)`;
    }
    divider.style.left = `${x}px`;
    divider.style.top = `${bounds.y}px`;
    divider.style.bottom = "auto";
    divider.style.height = `${bounds.height}px`;
    divider.style.opacity = hoveringVideo ? "1" : "0";
    divider.setAttribute("aria-valuenow", String(Math.round(state().position)));
  }
  function updateView(feedback = false) {
    cachedVideoBounds = null;
    hoveringVideo = false;
    if (!modeButtons.has(state().mode)) state().mode = "split";
    delete state().singleView;
    delete state().splitDirection;
    state().blend ??= .5;
    const mode = state().mode;
    const both = Boolean(state().before && state().after);
    const split = both && mode === "split";
    const sideBySide = both && mode === "side-by-side";
    const layoutStyle = sideBySide
      ? "position:relative;inset:auto;flex:0 1 auto;width:auto;height:100%;max-width:50%;object-fit:contain;background:transparent;pointer-events:none;"
      : videoStyle;
    for (const surface of frameSurfaces) surface.style.cssText = layoutStyle;
    before.style.display = state().before ? "block" : "none";
    frameSurfaces[0].style.display = state().before ? "block" : "none";
    frameSurfaces[1].style.display = state().after ? "block" : "none";
    afterClip.style.display = sideBySide ? "contents" : state().after ? "block" : "none";
    afterClip.style.left = "0";
    afterClip.style.width = "100%";
    afterClip.style.clipPath = "none";
    afterClip.style.opacity = both && mode === "overlay" ? String(state().blend) : "1";
    divider.style.display = split ? "block" : "none";
    divider.tabIndex = -1;
    stage.style.cursor = split ? "ew-resize" : "default";
    for (const [key, button] of modeButtons) {
      button.setAttribute("aria-pressed", String(key === mode));
      button.disabled = !both;
    }
    blendControl.style.display = mode === "overlay" ? "block" : "none";
    captions.style.display = state().before || state().after ? "grid" : "none";
    blend.disabled = !both;
    blend.value = String(state().blend);
    blendValue.textContent = `Overlay · ${Math.round(state().blend * 100)}%`;
    blendControl.style.setProperty("--blend-fill", `${Math.round(state().blend * 100)}%`);
    const beforeAfter = modeButtons.get("overlay");
    const percentage = Math.round(state().blend * 100);
    blend.setAttribute("aria-valuetext", `${percentage}% After blend`);
    const showing = percentage === 0 ? "Before" : percentage === 100 ? "After" : `Overlay : ${percentage}%`;
    const next = percentage <= 50 ? "After" : "Before";
    const active = state().mode === "overlay";
    const beforeSelected = active && percentage === 0;
    const afterSelected = active && percentage === 100;
    beforeAfter.querySelector(".before-after-switch").dataset.side = beforeSelected ? "before" : afterSelected ? "after" : "neutral";
    beforeAfter.querySelector(".before-after-option-before").classList.toggle("is-current", beforeSelected);
    beforeAfter.querySelector(".before-after-option-after").classList.toggle("is-current", afterSelected);
    beforeAfter.title = state().mode === "overlay"
      ? `Showing ${showing}. Click to switch to ${next}; use the Overlay slider to blend.`
      : "Click to show Before, then click again to switch to After. Use the Overlay slider to blend.";
    for (const [key, button] of modeButtons) {
      const title = button.disabled
        ? "Connect sockets and load videos first"
        : key === "overlay" ? beforeAfter.title : button.dataset.enabledTitle;
      button.title = title;
      button.setAttribute("aria-label", title);
      modeCells.get(key).title = title;
    }
    labels[0].style.display = state().before ? "block" : "none";
    labels[1].style.display = state().after ? "block" : "none";
    updateGenerationPanel();
    position(state().position ?? 50, feedback);
    syncCaptionsToVideo();
  }
  function updateTime() {
    const duration = playbackDuration || comparisonDuration(videos);
    const active = videos.filter((video) => video.hasAttribute("src"));
    const ended = active.length && active.every((video) => video.ended);
    const current = Math.min(pendingTimelineSeek ?? seekRenderTarget ?? (ended ? duration : renderedTime) ?? state().time ?? 0, duration);
    if (seek.max !== String(duration)) seek.max = String(duration);
    if (seek.value !== String(current)) seek.value = String(current);
    const text = `${timeLabel(current)} / ${timeLabel(duration)}`;
    if (time.textContent !== text) time.textContent = text;
  }
  function seekBoth(value, force = false) {
    const duration = playbackDuration || comparisonDuration(videos);
    const target = Math.max(0, duration ? Math.min(value, duration) : value);
    if (playing || playStarting) {
      pause();
      resumeAfterSeek = true;
    }
    const active = videos.filter((video) => video.hasAttribute("src") && !video.error);
    if (!active.length) {
      seekRenderTarget = null;
      updateTime();
      return;
    }
    const cached = active.map((video) => frameQueues.get(video).findLast((entry) =>
      Math.abs(entry.time - target) < .000001 || (entry.time <= target && entry.end - target > .00001)));
    if (cached.every(Boolean)) drawFrames(active, cached);
    clearQueuedFrames();
    seekRenderTarget = target;
    for (const video of active) {
      video.playbackRate = 1;
      const time = Number.isFinite(video.duration) ? Math.min(target, video.duration) : target;
      if (video.readyState > 0 && (force || Math.abs(video.currentTime - time) > .001)) {
        video.currentTime = time;
      }
    }
    state().time = target;
    for (const video of videos) captureFrame(video);
    updateTime();
  }
  function clearQueuedFrames(video) {
    const queues = video ? [frameQueues.get(video)] : frameQueues.values();
    for (const queue of queues) {
      for (const entry of queue) entry.frame.close();
      queue.length = 0;
    }
  }
  function stepFrame(direction) {
    if (playing || playStarting) pause();
    resumeAfterSeek = false;
    if (pendingTimelineSeek !== null) flushTimelineSeek();
    pendingFrameSteps += direction;
    flushFrameSteps();
  }
  function finishFrameStep() {
    if (!frameStepInFlight) return;
    frameStepInFlight = false;
    if (pendingFrameSteps) queueMicrotask(flushFrameSteps);
  }
  function flushFrameSteps() {
    if (disposed || frameStepInFlight || seekRenderTarget !== null || !pendingFrameSteps) return;
    const clock = playbackVideo();
    if (!clock.hasAttribute("src") || clock.readyState === 0) {
      pendingFrameSteps = 0;
      return;
    }
    const queue = frameQueues.get(clock);
    const steps = pendingFrameSteps;
    pendingFrameSteps = 0;
    const current = renderedTime ?? state().time ?? 0;
    const frame = queue.find((entry) => entry.time <= current && current < entry.end) ??
      queue.reduce((closest, entry) => !closest || Math.abs(entry.time - current) < Math.abs(closest.time - current) ? entry : closest, null);
    const interval = frame && frame.end > frame.time ? frame.end - frame.time : frameIntervals.get(clock) || 1 / 30;
    // Seek inside the frame to avoid microsecond rounding across a frame boundary.
    const target = (frame?.time ?? current) + steps * interval + interval / 4;
    const duration = comparisonDuration(videos);
    frameStepInFlight = true;
    seekBoth(Math.max(0, Math.min(target, duration || target)), true);
    if (seekRenderTarget === null) finishFrameStep();
  }
  function renderFramePair() {
    if (disposed) return;
    const active = videos.filter((video) => video.hasAttribute("src") && !video.error);
    if (!active.length) return;
    if (active.some((video) => video.seeking)) return;
    const clock = playbackVideo();
    const queue = frameQueues.get(clock);
    for (let index = queue.length - 1; index >= 0; index--) {
      const candidate = queue[index];
      const target = seekRenderTarget ?? candidate.time;
      if (seekRenderTarget !== null) {
        if (!(candidate.time <= target + .000001 && target < candidate.end) &&
          !(target >= clock.duration && candidate === queue.at(-1))) continue;
      } else if (renderedTime !== null && candidate.time <= renderedTime + .000001) continue;
      const pair = active.map((video) => {
        if (video === clock) return candidate;
        const frames = frameQueues.get(video);
        return frames.findLast((entry) => Math.abs(entry.time - candidate.time) < .000001) ??
          frames.findLast((entry) =>
          (entry.time <= target && entry.end - target > .00001) ||
          (target >= video.duration && entry === frames.at(-1)));
      });
      if (pair.some((entry) => !entry)) continue;
      drawFrames(active, pair);
      active.forEach((video, videoIndex) => {
        const entry = pair[videoIndex];
        const frames = frameQueues.get(video);
        while (frames.length > 1 && frames[1].time <= entry.time) frames.shift().frame.close();
      });
      renderedTime = candidate.time;
      if (!playing) state().time = renderedTime;
      const completedSeek = seekRenderTarget !== null;
      seekRenderTarget = null;
      updateTime();
      if (completedSeek) {
        finishFrameStep();
        flushTimelineSeek();
        flushFrameSteps();
        if (resumeAfterSeek && !timelineDragging && seekRenderTarget === null && pendingTimelineSeek === null) play();
      }
      return;
    }
  }
  function drawFrames(active, pair) {
    let resized = false;
    active.forEach((video, index) => {
      const canvas = frameSurfaces[videos.indexOf(video)];
      if (canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; resized = true; }
      if (canvas.height !== video.videoHeight) { canvas.height = video.videoHeight; resized = true; }
      canvas.getContext("2d").drawImage(pair[index].frame, 0, 0, canvas.width, canvas.height);
    });
    if (resized) {
      cachedVideoBounds = null;
      position(state().position ?? 50);
      syncCaptionsToVideo();
    }
  }
  function pause(alignFrames = false) {
    const pauseTime = alignFrames && playbackMaster
      ? renderedTime ?? playbackMaster.currentTime : null;
    playRequest++;
    playStarting = false;
    playing = false;
    resumeAfterSeek = false;
    cancelAnimationFrame(animation);
    animation = 0;
    videos.forEach((video) => { video.pause(); video.playbackRate = 1; });
    if (Number.isFinite(pauseTime)) seekBoth(pauseTime + .000001, true);
    playbackMaster = null;
    playbackDuration = 0;
    playButton.querySelector("path").setAttribute("d", "M8 5l11 7-11 7z");
  }
  function tick() {
    if (!playing || disposed) return;
    const master = playbackVideo();
    if (master.seeking) {
      updateTime();
      animation = requestAnimationFrame(tick);
      return;
    }
    for (const video of videos) {
      if (video !== master && !video.ended && video.readyState >= 2 && !video.seeking && !master.seeking) {
        const drift = video.currentTime - master.currentTime;
        if (Math.abs(drift) > .12) {
          video.playbackRate = 1;
          clearQueuedFrames(video);
          video.currentTime = Number.isFinite(video.duration)
            ? Math.min(master.currentTime, video.duration)
            : master.currentTime;
        } else {
          const correction = video === audioVideo() ? .005 : .05;
          const rate = drift > .01 ? 1 - correction : drift < -.01 ? 1 + correction : 1;
          if (video.playbackRate !== rate) video.playbackRate = rate;
        }
      }
    }
    updateTime();
    animation = requestAnimationFrame(tick);
  }
  function waitForMetadata(video) {
    if (video.readyState >= 1 || video.error) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        video.removeEventListener("loadedmetadata", done);
        video.removeEventListener("error", done);
        video.removeEventListener("abort", done);
        video.removeEventListener("emptied", done);
        resolve();
      };
      video.addEventListener("loadedmetadata", done);
      video.addEventListener("error", done);
      video.addEventListener("abort", done);
      video.addEventListener("emptied", done);
    });
  }
  function togglePlayback() {
    if (resumeAfterSeek) pause();
    else if (playing || playStarting) pause(true);
    else play();
  }
  async function play() {
    if (playing || playStarting || disposed) return;
    pendingFrameSteps = 0;
    frameStepInFlight = false;
    if (seekRenderTarget !== null || pendingTimelineSeek !== null) {
      resumeAfterSeek = true;
      return;
    }
    resumeAfterSeek = false;
    const active = videos.filter((video) => video.hasAttribute("src"));
    if (!active.length) return;
    playStarting = true;
    const request = ++playRequest;
    await initializeAudio();
    if (request !== playRequest || disposed) return;
    await Promise.all(active.map(waitForMetadata));
    if (request !== playRequest || disposed) return;
    playStarting = false;
    const ready = active.filter((video) => video.hasAttribute("src") && !video.error && video.readyState >= 1);
    if (!ready.length) return;
    const selectedAudio = audioVideo();
    playbackMaster = ready.includes(selectedAudio) && !selectedAudio.ended
      ? selectedAudio
      : ready.reduce((longest, video) => (video.duration || 0) > (longest.duration || 0) ? video : longest);
    playbackDuration = comparisonDuration(ready);
    if (playbackDuration && playbackMaster.currentTime >= playbackDuration - Math.min(.025, playbackDuration / 2)) {
      resumeAfterSeek = true;
      seekBoth(0);
      return;
    }
    const toPlay = ready.filter((video) => !video.ended);
    applyAudio();
    playing = true;
    updateStatus();
    playButton.querySelector("path").setAttribute("d", "M8 5v14M16 5v14");
    cancelAnimationFrame(animation);
    tick();
    const results = await Promise.allSettled(toPlay.map((video) => video.play()));
    if (request !== playRequest || disposed) return;
    const failed = results.flatMap((result, index) => result.status === "rejected" ? [{ video: toPlay[index], error: result.reason }] : []);
    if (failed.length) {
      pause();
      const failure = failed[0];
      if (failure.error?.name !== "AbortError") {
        message.textContent = `Could not play the ${failure.video === before ? "Before" : "After"} video: ${failure.error?.message || "video unavailable"}`;
      }
    }
  }
  function finishPlayback() {
    if (!playing) return;
    const duration = playbackDuration || comparisonDuration(videos);
    pause();
    if (state().loop) { seekBoth(0); play(); }
    else {
      seekBoth(Math.max(0, duration - .000001), true);
      state().time = duration;
      updateTime();
    }
  }
  function show() {
    emptyHint.style.display = state().before?.filename || state().after?.filename ? "none" : "flex";
    pause();
    pendingTimelineSeek = null;
    timelineDragging = false;
    pendingFrameSteps = 0;
    frameStepInFlight = false;
    seekRenderTarget = null;
    clearQueuedFrames();
    renderedTime = null;
    for (let index = 0; index < videos.length; index++) {
      const role = index ? "after" : "before";
      const entry = state()[role];
      const video = videos[index];
      if (entry?.filename) {
        const url = mediaURL(entry);
        if (video.getAttribute("src") !== url) {
          frameSurfaces[index].width = frameSurfaces[index].height = 0;
          video.src = url;
          video.load();
        }
      }
      else {
        frameSurfaces[index].width = frameSurfaces[index].height = 0;
        video.removeAttribute("src");
        video.load();
      }
    }
    updateStatus();
    updateView();
    applyAudio();
    volume.value = String(state().volume ?? 1);
    seekBoth(state().time || 0);
    updateTime();
  }
  function captureFrame(video) {
    if (disposed || video.error || video.seeking || video.readyState < 2 || !video.hasAttribute("src")) return;
    const frame = new VideoFrame(video);
    const time = frame.timestamp / 1000000;
    if (frame.duration > 0) frameIntervals.set(video, frame.duration / 1000000);
    const queue = frameQueues.get(video);
    const duplicate = queue.findIndex((entry) => Math.abs(entry.time - time) < .000001);
    if (duplicate >= 0) {
      frame.close();
      renderFramePair();
      return;
    }
    const previous = queue.at(-1);
    if (!(frame.duration > 0) && playing && previous && time > previous.time && time - previous.time < .1) {
      frameIntervals.set(video, time - previous.time);
    }
    queue.push({ frame, time, end: time + (frame.duration > 0 ? frame.duration / 1000000 : frameIntervals.get(video)) });
    while (queue.length > 6) queue.shift().frame.close();
    renderFramePair();
  }
  for (const video of videos) {
    const recordFrame = () => {
      if (disposed) return;
      frameCallbacks.set(video, video.requestVideoFrameCallback(recordFrame));
      captureFrame(video);
    };
    frameCallbacks.set(video, video.requestVideoFrameCallback(recordFrame));
    video.addEventListener("loadeddata", () => captureFrame(video));
    video.addEventListener("seeked", () => {
      captureFrame(video);
      flushTimelineSeek();
    });
    video.addEventListener("emptied", () => {
      clearQueuedFrames(video);
      frameIntervals.set(video, 1 / 30);
    });
    video.addEventListener("loadedmetadata", () => {
      if (disposed) return;
      cachedVideoBounds = null;
      const target = playing && playbackMaster ? playbackMaster.currentTime : state().time || 0;
      const time = Number.isFinite(video.duration) ? Math.min(target, video.duration) : target;
      if (Math.abs(video.currentTime - time) > .001) video.currentTime = time;
      updateTime();
      updateGenerationPanel();
      position(state().position ?? 50);
      syncCaptionsToVideo();
    });
    video.addEventListener("timeupdate", updateTime);
    video.addEventListener("ended", () => {
      if (video !== playbackMaster) return;
      const nextMaster = videos.find((candidate) => candidate !== video && candidate.hasAttribute("src") && !candidate.ended && !candidate.error);
      if (nextMaster && video.duration < playbackDuration - .001) {
        playbackMaster = nextMaster;
        nextMaster.playbackRate = 1;
      } else {
        finishPlayback();
      }
    });
    video.addEventListener("error", () => {
      if (!disposed && video.hasAttribute("src")) {
        pause();
        pendingTimelineSeek = null;
        pendingFrameSteps = 0;
        frameStepInFlight = false;
        seekRenderTarget = null;
        message.textContent = `Could not load the ${video === before ? "Before" : "After"} video: ${video.error?.message || "video unavailable"}`;
      }
    });
  }
  function flushTimelineSeek(final = false) {
    if (disposed || pendingTimelineSeek === null) return;
    if (!final && (seekRenderTarget !== null || videos.some((video) => video.seeking))) return;
    const target = pendingTimelineSeek;
    pendingTimelineSeek = null;
    seekBoth(target);
  }
  function finishTimelineSeek() {
    timelineDragging = false;
    flushTimelineSeek(true);
    if (resumeAfterSeek && seekRenderTarget === null && pendingTimelineSeek === null) play();
  }
  seek.addEventListener("pointerdown", (event) => {
    if (event.button === 0) timelineDragging = true;
  });
  seek.addEventListener("input", () => {
    pendingFrameSteps = 0;
    frameStepInFlight = false;
    pendingTimelineSeek = Number(seek.value);
    updateTime();
    flushTimelineSeek();
  });
  seek.addEventListener("change", finishTimelineSeek);
  seek.addEventListener("pointercancel", finishTimelineSeek);
  volume.addEventListener("input", () => { state().volume = Number(volume.value); state().muted = false; applyAudio(); });
  function hoverDivider(event) {
    if (event.buttons || state().mode !== "split" || !state().before || !state().after) return;
    const bounds = stage.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const video = videoBounds();
    const x = (event.clientX - bounds.left) * stage.clientWidth / bounds.width;
    const y = (event.clientY - bounds.top) * stage.clientHeight / bounds.height;
    if (x < video.x || x > video.x + video.width) {
      position(state().position >= 50 ? 100 : 0, true);
      hideDivider();
      return;
    }
    if (y < video.y || y > video.y + video.height) {
      position(state().position >= 50 ? 100 : 0, true);
      hideDivider();
      return;
    }
    hoveringVideo = true;
    if (video.width) position(100 * (x - video.x) / video.width, true);
  }
  stage.addEventListener("pointerenter", hoverDivider);
  stage.addEventListener("pointermove", hoverDivider);
  function hideDivider() {
    hoveringVideo = false;
    position(state().position ?? 50);
  }
  stage.addEventListener("pointerleave", (event) => {
    const bounds = stage.getBoundingClientRect();
    const video = videoBounds();
    const x = (event.clientX - bounds.left) * stage.clientWidth / bounds.width;
    const y = (event.clientY - bounds.top) * stage.clientHeight / bounds.height;
    if (y < video.y || y > video.y + video.height || x < video.x || x > video.x + video.width) {
      position(state().position >= 50 ? 100 : 0, true);
    }
    hideDivider();
  });
  stage.addEventListener("pointercancel", hideDivider);
  function overBeforeAfterVideo(event) {
    if (state().mode !== "overlay" || !state().before || !state().after) return false;
    const rect = stage.getBoundingClientRect();
    const bounds = videoBounds();
    const x = (event.clientX - rect.left) * stage.clientWidth / rect.width;
    const y = (event.clientY - rect.top) * stage.clientHeight / rect.height;
    return x >= bounds.x && x <= bounds.x + bounds.width
      && y >= bounds.y && y <= bounds.y + bounds.height;
  }
  stage.addEventListener("pointerdown", (event) => {
    if (event.button === 2 && overBeforeAfterVideo(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.button !== 0) return;
    event.stopPropagation();
    stage.focus({ preventScroll: true });
  });
  stage.addEventListener("click", (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    togglePlayback();
  });
  stage.addEventListener("contextmenu", (event) => {
    if (!overBeforeAfterVideo(event)) return;
    event.preventDefault();
    event.stopPropagation();
    modeButtons.get("overlay").click();
  });
  async function capture(role, button) {
    const source = inputNode(node, role);
    const key = inputKey(node, role);
    if (!source) return;
    const request = ++captureRequests[role];
    uploadStatus[role] = "";
    updateStatus();
    button.__elvaxLoading = true;
    button.disabled = true;
    try {
      let entry = state()[`${role}LatestKey`] === key ? state()[`${role}Latest`] : null;
      if (source.type === "LoadVideo") {
        const filename = source.widgets?.find((widget) => widget.name === "file")?.value;
        if (filename) entry = { filename, type: "input" };
        else throw new Error("No video is available from the connected node yet.");
      }
      if (source.type === "SaveVideo" || source.comfyClass === "SaveVideo") {
        const output = app.nodeOutputs?.[source.id]?.images?.findLast((video) => video.type === "output" && video.filename);
        if (!output) throw new Error("No video is available from the connected node yet.");
        entry = output;
      }
      if (!entry) throw new Error(`No video is available from the ${role === "before" ? "Before" : "After"} socket.`);
      const response = await api.fetchApi("/elvax/video-compare-pro/capture", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not prepare the selected video.");
      if (disposed || request !== captureRequests[role] || key !== inputKey(node, role) || source !== inputNode(node, role)) return;
      state()[role] = result;
      state().time = 0;
      show();
      node.graph?.setDirtyCanvas(true, true);
    } catch (error) { if (!disposed) message.textContent = error.message; }
    finally {
      if (!disposed && request === captureRequests[role]) {
        button.__elvaxLoading = false;
        button.disabled = !inputNode(node, role);
      }
    }
  }
  const dropOverlay = document.createElement("div");
  dropOverlay.style.cssText = "position:absolute;inset:0;z-index:100;display:none;gap:6px;padding:6px;background:#111d;pointer-events:none;";
  const dropZones = ["before", "after"].map((role) => {
    const zone = document.createElement("div");
    zone.textContent = `Drop ${role === "before" ? "Before" : "After"} video`;
    zone.style.cssText = "flex:1;display:flex;align-items:center;justify-content:center;border:2px dashed #60707c;border-radius:8px;background:#20262eee;color:#c5d4df;font-size:16px;font-weight:600;";
    dropOverlay.append(zone);
    return zone;
  });
  root.append(dropOverlay);
  const videoFile = (file) => /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(file.name);
  const dropRole = (event) => event.clientX < root.getBoundingClientRect().left + root.getBoundingClientRect().width / 2 ? "before" : "after";
  root.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    dropOverlay.style.display = "flex";
    dropZones.forEach((zone, index) => {
      const active = (dropRole(event) === "before" ? 0 : 1) === index;
      zone.style.borderColor = active ? "#8bd4ff" : "#60707c";
      zone.style.background = active ? "#294459ee" : "#20262eee";
    });
  });
  root.addEventListener("dragleave", (event) => {
    if (!root.contains(event.relatedTarget)) dropOverlay.style.display = "none";
  });
  async function uploadDroppedVideo(file, role) {
    uploads.get(role)?.abort();
    const controller = new AbortController();
    uploads.set(role, controller);
    const request = ++captureRequests[role];
    const button = captureButtons.get(role);
    button.__elvaxLoading = true;
    button.disabled = true;
    uploadStatus[role] = `Loading ${role === "before" ? "Before" : "After"} video…`;
    updateStatus();
    try {
      const data = new FormData();
      data.append("video", file);
      const response = await api.fetchApi("/elvax/video-compare-pro/upload", { method: "POST", body: data, signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load the dropped video.");
      if (disposed || request !== captureRequests[role]) return;
      state()[role] = result;
      state().time = 0;
      uploadStatus[role] = "";
      show();
      node.graph?.change();
      node.graph?.setDirtyCanvas(true, true);
    } catch (error) {
      if (!disposed && request === captureRequests[role]) {
        uploadStatus[role] = `${role === "before" ? "Before" : "After"}: ${error.message}`;
        updateStatus();
      }
    } finally {
      if (uploads.get(role) === controller) uploads.delete(role);
      if (!disposed && request === captureRequests[role]) {
        button.__elvaxLoading = false;
        updateLoadButtons();
      }
    }
  }
  root.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    dropOverlay.style.display = "none";
    const files = [...event.dataTransfer.files].filter(videoFile);
    if (!files.length) {
      message.textContent = "Drop a video file (MP4, WebM, MOV, MKV, AVI, or M4V).";
      return;
    }
    if (files.length > 1) {
      uploadDroppedVideo(files[0], "before");
      uploadDroppedVideo(files[1], "after");
    } else uploadDroppedVideo(files[0], dropRole(event));
  });
  for (const role of ["before", "after"]) {
    const control = document.createElement("div");
    control.className = "capture-control";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "capture";
    button.textContent = `Load : ${role === "before" ? "Before" : "After"} Video`;
    button.title = `Load a video from the ${role}_video socket.`;
    button.addEventListener("click", () => capture(role, button));
    captureButtons.set(role, button);
    const autoLabel = document.createElement("label");
    autoLabel.className = "capture-auto";
    autoLabel.title = `Automatically load the ${role === "before" ? "Before" : "After"} video when the workflow produces a result.`;
    const auto = document.createElement("input");
    auto.type = "checkbox";
    auto.checked = Boolean(state()[`${role}Auto`]);
    auto.setAttribute("aria-label", `Auto load ${role} video`);
    auto.addEventListener("change", () => {
      state()[`${role}Auto`] = auto.checked;
      node.graph?.change();
      node.graph?.setDirtyCanvas(true, true);
    });
    autoLabel.addEventListener("pointerdown", (event) => {
      if (event.button === 0) event.stopPropagation();
    });
    autoLabel.append(auto, document.createTextNode("Auto"));
    autoCheckboxes.set(role, auto);
    control.append(button, autoLabel);
    buttons.append(control);
  }
  function updateLoadButtons() {
    for (const [role, button] of captureButtons) {
      autoCheckboxes.get(role).checked = Boolean(state()[`${role}Auto`]);
      const input = node.inputs?.[inputSlot(node, role)];
      const available = Boolean(inputNode(node, role));
      button.title = input?.link == null
        ? `Connect a video output to the ${role}_video socket.`
        : !available ? "The connected route is inactive or has no video source."
        : `Load a video from the ${role}_video socket.`;
      button.disabled = Boolean(button.__elvaxLoading) || !available;
    }
  }
  const oldConnectionsChanged = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    const slot = arguments[1];
    const connected = arguments[2];
    const result = oldConnectionsChanged?.apply(this, arguments);
    if (connected && !state().audioAuto && state().audioSource == null) {
      state().audioSource = this.inputs?.[slot]?.name === "after_video" ? "after" : "before";
    }
    updateLoadButtons();
    updateView();
    updateStatus();
    applyAudio();
    return result;
  };
  updateLoadButtons();
  api.addEventListener(ROUTE_CHANGED, updateLoadButtons);
  root.addEventListener("wheel", (event) => {
    event.preventDefault();
    if (generationPanel.contains(event.target) && generationContent.scrollHeight > generationContent.clientHeight) {
      event.stopPropagation();
      const step = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? generationContent.clientHeight : 1;
      generationContent.scrollTop += event.deltaY * step;
      return;
    }
    app.canvas._mousewheel_callback(event);
  }, { capture: true, passive: false });
  root.addEventListener("pointerdown", (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    middlePointer = event.pointerId;
    root.setPointerCapture(middlePointer);
    app.canvas._mousedown_callback(event);
  }, true);
  root.addEventListener("pointermove", (event) => {
    if (event.pointerId === middlePointer) { event.preventDefault(); app.canvas._mousemove_callback(event); }
  }, true);
  const finishMiddle = (event) => {
    if (event.pointerId !== middlePointer) return;
    middlePointer = null;
    app.canvas._mouseup_callback(event);
  };
  root.addEventListener("pointerup", finishMiddle, true);
  root.addEventListener("pointercancel", finishMiddle, true);
  root.addEventListener("keydown", (event) => {
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      (event.target === seek ||
        (!["INPUT", "BUTTON", "SELECT", "TEXTAREA"].includes(event.target.tagName) && !event.target.isContentEditable))) {
      event.preventDefault(); event.stopPropagation();
      stepFrame(event.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (event.code === "Space" && event.target.tagName !== "INPUT" && event.target.tagName !== "BUTTON") {
      event.preventDefault(); event.stopPropagation();
      if (event.repeat) return;
      togglePlayback();
    }
  });
  stage.append(before, frameSurfaces[0], afterClip, divider, emptyHint);
  panel.append(modes, mediaRow, transport);
  root.append(style, buttons, panel, message);
  const widget = node.addDOMWidget("video_compare_pro", "div", root, {
    serialize: false, hideOnZoom: false, getMinHeight: () => MIN_HEIGHT,
  });
  widget.computeLayoutSize = () => ({ minHeight: MIN_HEIGHT, minWidth: 1 });
  const oldComputeSize = node.computeSize;
  node.computeSize = function () {
    const size = oldComputeSize.apply(this, arguments);
    size[0] = Math.max(MIN_SIZE, size[0]);
    size[1] = Math.max(MIN_SIZE, size[1]);
    return size;
  };
  const oldResize = node.onResize;
  node.onResize = function (size) {
    size[0] = Math.max(MIN_SIZE, size[0]);
    size[1] = Math.max(MIN_SIZE, size[1]);
    return oldResize?.apply(this, arguments);
  };
  function enforceMinimumSize() {
    if (disposed || document.fullscreenElement === root) return;
    if (node.size[0] < MIN_SIZE || node.size[1] < MIN_SIZE) {
      node.setSize([Math.max(MIN_SIZE, node.size[0]), Math.max(MIN_SIZE, node.size[1])]);
    }
  }
  const sizeObserver = new ResizeObserver(() => {
    enforceMinimumSize();
    syncPanelWidth();
    position(state().position ?? 50);
    syncCaptionsToVideo();
  });
  sizeObserver.observe(root);
  sizeObserver.observe(stage);
  let compareWasFullscreen = document.fullscreenElement === root;
  function onFullscreenChange() {
    const isFullscreen = document.fullscreenElement === root;
    if (isFullscreen === compareWasFullscreen) return;
    compareWasFullscreen = isFullscreen;
    cachedVideoBounds = null;
    captions.style.removeProperty("--caption-left");
    captions.style.removeProperty("--caption-right");
    captions.style.transform = "";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (disposed) return;
      syncPanelWidth();
      position(state().position ?? 50);
      syncCaptionsToVideo();
    }));
  }
  document.addEventListener("fullscreenchange", onFullscreenChange);
  node.setSize([560, 560]);
  const oldSerialized = node.onSerialize;
  node.onSerialize = function (data) {
    const result = oldSerialized?.apply(this, arguments);
    data.properties = {
      ...data.properties,
      elvaxVideoComparePro: JSON.parse(JSON.stringify({
        ...state(),
        time: renderedTime ?? state().time ?? 0,
      })),
    };
    return result;
  };
  const oldConfigured = node.onConfigure;
  node.onConfigure = function () {
    for (const role of ["before", "after"]) {
      ++captureRequests[role];
      uploads.get(role)?.abort();
      uploadStatus[role] = "";
      captureButtons.get(role).__elvaxLoading = false;
    }
    uploads.clear();
    lastVisibleSide = null;
    lastAudioSource = null;
    const result = oldConfigured?.apply(this, arguments);
    this.properties.elvaxVideoComparePro ||= { position: 50, volume: 1, muted: false, loop: true, audioSource: null };
    this.properties.elvaxVideoComparePro = JSON.parse(JSON.stringify(this.properties.elvaxVideoComparePro));
    generationOpen = Boolean(state().generationOpen);
    showMatching.checked = Boolean(state().showMatching);
    migrateAudioDefault();
    audioAuto.checked = state().audioAuto;
    updateLoadButtons();
    enforceMinimumSize();
    show();
    return result;
  };
  const oldExecuted = node.onExecuted;
  node.onExecuted = function (data) {
    const result = oldExecuted?.apply(this, arguments);
    let autoLoaded = false;
    for (const role of ["before", "after"]) {
      const entry = data?.[`elvax_compare_pro_${role}_video`]?.[0];
      if (entry) {
        state()[`${role}Latest`] = entry;
        state()[`${role}LatestKey`] = inputKey(this, role);
        if (state()[`${role}Auto`] && inputNode(this, role)) {
          ++captureRequests[role];
          uploads.get(role)?.abort();
          uploadStatus[role] = "";
          captureButtons.get(role).__elvaxLoading = false;
          state()[role] = entry;
          autoLoaded = true;
        }
      }
    }
    if (autoLoaded) {
      state().time = 0;
      show();
      updateLoadButtons();
      this.graph?.setDirtyCanvas(true, true);
    }
    updateStatus();
    return result;
  };
  const oldRemoved = node.onRemoved;
  node.onRemoved = function () {
    for (const controller of uploads.values()) controller.abort();
    uploads.clear();
    if (audioContext) audioContext.close();
    disposed = true;
    api.removeEventListener(ROUTE_CHANGED, updateLoadButtons);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    sizeObserver.disconnect();
    pause();
    clearQueuedFrames();
    for (const canvas of frameSurfaces) canvas.width = canvas.height = 0;
    for (const video of videos) {
      video.cancelVideoFrameCallback(frameCallbacks.get(video));
      video.removeAttribute("src");
      video.load();
    }
    return oldRemoved?.apply(this, arguments);
  };
  show();
}

app.registerExtension({
  name: "Elvax.VideoComparePro",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;
    const oldCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = oldCreated?.apply(this, arguments);
      install(this);
      return result;
    };
  },
});
