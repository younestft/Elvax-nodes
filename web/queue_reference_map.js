import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_TYPE = "ElvaxQueueReferenceMap";
const POLL_INTERVAL_MS = 2500;
const NODE_HEIGHT = 360;
const nodeViews = new Set();
let pollTimer = null;
let refreshTimer = null;
let refreshInProgress = false;

function nodeOrder(prompt, extraData) {
  const workflowNodes = extraData?.extra_pnginfo?.workflow?.nodes || [];
  const ids = workflowNodes.map((node) => String(node.id));
  for (const id of Object.keys(prompt || {})) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.map((id) => [id, prompt?.[id]]).filter(([, node]) => node);
}

function findFirstImage(prompt, extraData) {
  for (const [id, node] of nodeOrder(prompt, extraData)) {
    if (!/load[\w]*image/i.test(node.class_type || "")) continue;
    const workflowNode = (extraData?.extra_pnginfo?.workflow?.nodes || [])
      .find((candidate) => String(candidate.id) === id);
    const value = node.inputs?.image ?? workflowNode?.widgets_values?.[0];
    let filename = value;
    let subfolder = node.inputs?.subfolder || "";
    let type = node.inputs?.type || "input";
    if (value && typeof value === "object") {
      filename = value.filename || value.name || value.asset_hash;
      subfolder = value.subfolder ?? subfolder;
      type = value.type ?? type;
    }
    if (typeof filename !== "string" || !filename.trim()) continue;

    const match = filename.match(/^(.*?)(?:\s+\[(input|output|temp)\])?$/i);
    filename = match?.[1] || filename;
    const pathParts = filename.replace(/\\/g, "/").split("/");
    if (pathParts.length > 1 && !subfolder) {
      subfolder = pathParts.slice(0, -1).join("/");
      filename = pathParts[pathParts.length - 1];
    }
    return {
      filename,
      type: (match?.[2] || type).toLowerCase(),
      subfolder,
    };
  }
  return null;
}

function resolveText(value, prompt, seen = new Set()) {
  if (typeof value === "string") return value.trim() || null;
  if (!Array.isArray(value) || value.length < 2) return null;

  const sourceId = String(value[0]);
  if (seen.has(sourceId)) return null;
  const source = prompt?.[sourceId];
  if (!source) return null;

  const nextSeen = new Set(seen).add(sourceId);
  const sourceInputs = source.inputs || {};
  for (const key of ["text", "prompt", "positive", "string", "value", "source"]) {
    const text = resolveText(sourceInputs[key], prompt, nextSeen);
    if (text) return text;
  }
  return null;
}

function findFirstPrompt(prompt, extraData) {
  for (const [, node] of nodeOrder(prompt, extraData)) {
    if (!/(cliptextencode|text.*multiline|prompt)/i.test(node.class_type || "")) continue;
    const inputs = node.inputs || {};
    for (const key of ["text", "prompt", "positive", "string", "value", "source"]) {
      const text = resolveText(inputs[key], prompt);
      if (text) return text;
    }
  }
  return null;
}

function queueItem(tuple, state) {
  return {
    promptId: tuple[1],
    prompt: tuple[2] || {},
    extraData: tuple[3] || {},
    state,
  };
}

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function addStyles() {
  if (document.getElementById(`${NODE_TYPE}-styles`)) return;
  const style = document.createElement("style");
  style.id = `${NODE_TYPE}-styles`;
  style.textContent = `
    .elvax-queue-map { height: ${NODE_HEIGHT}px; box-sizing: border-box; overflow: auto; padding: 9px; color: var(--fg-color, #eee); background: var(--comfy-input-bg, #222); font: 12px/1.4 sans-serif; }
    .elvax-queue-map__header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 1px 2px 6px; }
    .elvax-queue-map__title { margin: 0; font-size: 14px; font-weight: 600; }
    .elvax-queue-map__total { display: flex; align-items: baseline; gap: 5px; color: var(--descrip-text, #aaa); }
    .elvax-queue-map__count, .elvax-queue-map__state { color: var(--descrip-text, #aaa); }
    .elvax-queue-map__item { padding: 8px 2px; border-top: 1px solid var(--border-color, #444); }
    .elvax-queue-map__item-header { display: flex; align-items: center; gap: 7px; margin-bottom: 7px; }
    .elvax-queue-map__state-dot { width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: #999; }
    .elvax-queue-map__state-dot--running { background: #76cf76; }
    .elvax-queue-map__number { font-weight: 600; }
    .elvax-queue-map__cancel { margin-left: auto; padding: 3px 8px; border: 1px solid var(--border-color, #555); border-radius: 5px; color: var(--fg-color, #eee); background: transparent; cursor: pointer; }
    .elvax-queue-map__cancel:hover { border-color: #d66; color: #ffb0b0; }
    .elvax-queue-map__cancel:disabled { opacity: .55; cursor: wait; }
    .elvax-queue-map__body { display: grid; grid-template-columns: 68px minmax(0, 1fr); gap: 8px; }
    .elvax-queue-map__thumb { display: grid; width: 68px; height: 60px; place-items: center; overflow: hidden; border-radius: 4px; color: #aaa; background: #181818; font-size: 10px; text-align: center; }
    .elvax-queue-map__thumb img { width: 100%; height: 100%; object-fit: contain; }
    .elvax-queue-map__label { margin: 0 0 2px; color: var(--descrip-text, #aaa); font-size: 9px; letter-spacing: .04em; text-transform: uppercase; }
    .elvax-queue-map__prompt { display: -webkit-box; overflow: hidden; color: var(--fg-color, #ddd); -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow-wrap: anywhere; }
    .elvax-queue-map__empty, .elvax-queue-map__error { padding: 14px 4px; color: var(--descrip-text, #aaa); }
    .elvax-queue-map__error { color: #ffaaaa; }
  `;
  document.head.append(style);
}

function createImageThumbnail(image) {
  const container = el("div", "elvax-queue-map__thumb", "No image");
  if (!image) return container;

  container.textContent = "";
  const thumbnail = document.createElement("img");
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder,
    type: image.type,
  });
  thumbnail.src = api.apiURL(`/view?${query.toString()}`);
  thumbnail.alt = image.filename;
  thumbnail.onerror = () => {
    container.textContent = "Image unavailable";
  };
  container.append(thumbnail);
  return container;
}

function createItem(item, view, order) {
  const row = el("article", "elvax-queue-map__item");
  const header = el("div", "elvax-queue-map__item-header");
  const dot = el("span", `elvax-queue-map__state-dot${item.state === "Running" ? " elvax-queue-map__state-dot--running" : ""}`);
  dot.setAttribute("aria-hidden", "true");
  header.append(dot, el("span", "elvax-queue-map__number", `#${order}`), el("span", "elvax-queue-map__state", item.state));

  const cancel = el("button", "elvax-queue-map__cancel", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("pointerdown", (event) => event.stopPropagation());
  cancel.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const confirmed = app.extensionManager?.dialog?.confirm
      ? await app.extensionManager.dialog.confirm({
          title: "Cancel queue item?",
          message: `Cancel #${item.number}?`,
        })
      : window.confirm(`Cancel #${item.number}?`);
    if (!confirmed) return;

    cancel.disabled = true;
    cancel.textContent = "Cancelling…";
    try {
      const response = await api.fetchApi(`/api/jobs/${encodeURIComponent(item.promptId)}/cancel`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(`ComfyUI returned ${response.status}`);
      app.extensionManager?.toast?.add({
        severity: "info",
        summary: "Cancel requested",
        detail: `Queue #${item.number}`,
        life: 2500,
      });
      view.signature = null;
      refreshQueue();
    } catch (error) {
      cancel.disabled = false;
      cancel.textContent = "Cancel";
      app.extensionManager?.toast?.add({
        severity: "error",
        summary: "Could not cancel queue item",
        detail: error.message || "ComfyUI request failed.",
        life: 4000,
      });
    }
  });
  header.append(cancel);

  const body = el("div", "elvax-queue-map__body");
  const image = findFirstImage(item.prompt, item.extraData);
  const details = document.createElement("div");
  const promptLabel = el("div", "elvax-queue-map__label", "First prompt");
  const prompt = findFirstPrompt(item.prompt, item.extraData);
  const promptText = el("div", "elvax-queue-map__prompt", prompt || "Prompt unavailable");
  details.append(promptLabel, promptText);
  body.append(createImageThumbnail(image), details);
  row.append(header, body);
  return row;
}

function renderView(view, items) {
  const signature = JSON.stringify(items.map((item) => [item.promptId, item.state]));
  if (signature === view.signature) return;
  view.signature = signature;
  const scrollTop = view.list.scrollTop;
  const fragment = document.createDocumentFragment();
  if (!items.length) {
    fragment.append(el("div", "elvax-queue-map__empty", "No queued or running items."));
  } else {
    items.forEach((item, index) => fragment.append(createItem(item, view, index + 1)));
  }
  view.list.replaceChildren(fragment);
  view.list.scrollTop = scrollTop;
  view.count.textContent = String(items.length);
}

async function refreshQueue() {
  if (refreshInProgress || nodeViews.size === 0) return;
  refreshInProgress = true;
  try {
    const response = await api.fetchApi("/queue");
    if (!response.ok) throw new Error(`ComfyUI returned ${response.status}`);
    const queue = await response.json();
    const items = [
      ...(queue.queue_running || []).map((tuple) => queueItem(tuple, "Running")),
      ...(queue.queue_pending || []).map((tuple) => queueItem(tuple, "Queued")),
    ];
    for (const view of nodeViews) {
      if (!view.root.isConnected) continue;
      view.error.style.display = "none";
      renderView(view, items);
    }
  } catch (error) {
    for (const view of nodeViews) {
      if (!view.root.isConnected) continue;
      view.error.textContent = `Could not load queue: ${error.message || "request failed"}`;
      view.error.style.display = "block";
    }
  } finally {
    refreshInProgress = false;
  }
}

function startPolling() {
  if (pollTimer) return;
  addStyles();
  refreshQueue();
  pollTimer = setInterval(refreshQueue, POLL_INTERVAL_MS);
  api.addEventListener("status", onStatus);
}

function stopPolling() {
  if (nodeViews.size) return;
  clearInterval(pollTimer);
  clearTimeout(refreshTimer);
  pollTimer = null;
  api.removeEventListener("status", onStatus);
}

function onStatus() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshQueue, 150);
}

function installNode(node) {
  if (node.__elvaxQueueReferenceMapInstalled) return;
  node.__elvaxQueueReferenceMapInstalled = true;

  const root = document.createElement("div");
  root.className = "elvax-queue-map";
  const header = el("div", "elvax-queue-map__header");
  const title = el("h2", "elvax-queue-map__title", "Queue Reference Map");
  const total = el("div", "elvax-queue-map__total");
  total.append(el("span", "", "Generations in queue:"));
  const count = el("span", "elvax-queue-map__count", "0");
  total.append(count);
  header.append(title, total);
  const list = document.createElement("div");
  const error = el("div", "elvax-queue-map__error", "");
  error.style.display = "none";
  root.append(header, list, error);

  const widget = node.addDOMWidget("queue_reference_map", "div", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => NODE_HEIGHT,
    getHeight: () => NODE_HEIGHT,
  });
  widget.computeLayoutSize = () => ({ minHeight: NODE_HEIGHT, minWidth: 250 });
  node.min_size = [Math.max(node.min_size?.[0] || 0, 280), Math.max(node.min_size?.[1] || 0, NODE_HEIGHT + 80)];
  if ((node.size?.[1] || 0) < NODE_HEIGHT + 80) {
    node.setSize([Math.max(node.size?.[0] || 280, 280), NODE_HEIGHT + 80]);
  }

  const view = { root, list, count, error, signature: null };
  nodeViews.add(view);
  startPolling();

  const originalRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    nodeViews.delete(view);
    stopPolling();
    return originalRemoved?.apply(this, args);
  };
}

app.registerExtension({
  name: "elvax.queue-reference-map",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;
    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalCreated?.apply(this, args);
      installNode(this);
      return result;
    };
  },
});
