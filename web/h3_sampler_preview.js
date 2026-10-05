import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_TYPE = "ElvaxH3SamplerPreview";
const PREVIEW_PROPERTY = "elvaxH3PreviewVideo";
const MIN_PREVIEW_HEIGHT = 180;
const PREVIEW_BOTTOM_SPACE = 16;
const installedNodes = new WeakSet();
let loopAllH3Previews = false;

function updateLoopState() {
  document.querySelectorAll(".elvax-h3-preview-video").forEach((video) => {
    video.loop = loopAllH3Previews;
  });
  document.querySelectorAll(".elvax-h3-loop-toggle").forEach((button) => {
    button.setAttribute("aria-pressed", String(loopAllH3Previews));
    button.style.backgroundColor = loopAllH3Previews ? "#36553b" : "#222c";
    button.style.borderColor = loopAllH3Previews ? "#8b9" : "#666";
  });
}

function previewUrl(entry) {
  const params = new URLSearchParams({
    filename: entry.filename,
    subfolder: entry.subfolder || "",
    type: entry.type || "temp",
  });
  return api.apiURL(`/view?${params}`);
}

function previewEntry(output) {
  const item = output?.elvax_h3_video?.find((entry) => entry?.filename);
  if (!item) return null;
  return {
    filename: item.filename,
    subfolder: item.subfolder || "",
    type: item.type || "temp",
  };
}

function findNodeByQualifiedId(rootGraph, qualifiedId) {
  if (!rootGraph || qualifiedId == null) return null;
  const parts = String(qualifiedId).split(":");
  let graph = rootGraph;
  for (let index = 0; index < parts.length - 1; index++) {
    const parent = graph?.getNodeById?.(parseInt(parts[index], 10));
    if (!parent?.subgraph) return null;
    graph = parent.subgraph;
  }
  return graph?.getNodeById?.(parseInt(parts.at(-1), 10)) || null;
}

function base64Blob(data, mime) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

function makeToolbarIcon(paths) {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "18");
  icon.setAttribute("height", "18");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2.5");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    icon.append(path);
  }
  return icon;
}

function installPreview(node) {
  if (installedNodes.has(node)) return;
  installedNodes.add(node);

  const root = document.createElement("div");
  root.style.cssText = "position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:100%;min-height:180px;overflow:hidden;background:#111;";
  const video = document.createElement("video");
  video.className = "elvax-h3-preview-video";
  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.loop = loopAllH3Previews;
  video.style.cssText = "display:none;width:100%;height:100%;max-height:480px;object-fit:contain;background:#111;";
  const supportsLivePreview = node.comfyClass === NODE_TYPE || node.type === NODE_TYPE;
  const liveImage = supportsLivePreview ? document.createElement("img") : null;
  const liveVideo = supportsLivePreview ? document.createElement("video") : null;
  let liveVideoUrl = null;
  if (liveImage) {
    liveImage.style.cssText = "display:none;width:100%;height:100%;max-height:480px;object-fit:contain;background:#111;";
    liveImage.alt = "Live sampler preview";
    liveVideo.className = "elvax-h3-preview-video";
    liveVideo.muted = true;
    liveVideo.autoplay = true;
    liveVideo.loop = true;
    liveVideo.playsInline = true;
    liveVideo.style.cssText = "display:none;width:100%;height:100%;max-height:480px;object-fit:contain;background:#111;";
  }
  const toolbar = document.createElement("div");
  toolbar.style.cssText = "position:absolute;top:8px;right:8px;display:none;gap:6px;z-index:2;opacity:0;transition:opacity 120ms ease;";

  function makeActionButton(label, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    if (label instanceof Element) button.append(label);
    else button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.style.cssText = "display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:1px solid #666;border-radius:4px;background:#222c;color:#fff;font:600 18px/1 Arial,sans-serif;cursor:pointer;";
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    toolbar.append(button);
    return button;
  }

  let activeEntry = null;
  const updateToolbar = () => {
    toolbar.style.display = activeEntry ? "flex" : "none";
    toolbar.style.opacity = root.matches(":hover") ? "1" : "0";
  };
  const loopButton = makeActionButton(makeToolbarIcon([
    "M3 12c0-4 5-6 9 0s9 4 9 0-5-6-9 0-9 4-9 0",
  ]), "Loop all H3 previews", () => {
    loopAllH3Previews = !loopAllH3Previews;
    updateLoopState();
  });
  loopButton.classList.add("elvax-h3-loop-toggle");
  updateLoopState();
  makeActionButton("↗", "Open preview in a new tab", () => {
    if (activeEntry) window.open(previewUrl(activeEntry), "_blank");
  });
  makeActionButton(makeToolbarIcon([
    "M20 11a8 8 0 0 0-14.8-4L3 10",
    "M3 5v5h5",
    "M4 13a8 8 0 0 0 14.8 4L21 14",
    "M21 19v-5h-5",
  ]), "Sync preview", () => {
    for (const preview of document.querySelectorAll(
      ".vhs_preview video, .elvax-h3-preview-video",
    )) {
      try {
        preview.currentTime = 0;
      } catch {}
      preview.play().catch(() => {});
    }
  });
  root.addEventListener("pointerenter", updateToolbar);
  root.addEventListener("pointerleave", updateToolbar);
  root.addEventListener("wheel", (event) => {
    event.preventDefault();
    app.canvas._mousewheel_callback(event);
  }, { capture: true, passive: false });

  let middleDragPointer = null;
  root.addEventListener("pointerdown", (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    middleDragPointer = event.pointerId;
    root.setPointerCapture(event.pointerId);
    app.canvas._mousedown_callback(event);
  }, true);
  root.addEventListener("pointermove", (event) => {
    if (event.pointerId !== middleDragPointer) return;
    event.preventDefault();
    app.canvas._mousemove_callback(event);
  }, true);
  const finishMiddleDrag = (event) => {
    if (event.pointerId !== middleDragPointer) return;
    event.preventDefault();
    middleDragPointer = null;
    app.canvas._mouseup_callback(event);
  };
  root.addEventListener("pointerup", finishMiddleDrag, true);
  root.addEventListener("pointercancel", finishMiddleDrag, true);
  root.append(toolbar);

  const message = document.createElement("div");
  message.textContent = "Run the sampler to create a video preview.";
  message.style.cssText = "padding:12px;color:#aaa;font:12px sans-serif;text-align:center;";
  root.append(video);
  if (liveImage) root.append(liveImage, liveVideo);
  root.append(message);

  const widget = node.addDOMWidget("h3_video_preview", "div", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => MIN_PREVIEW_HEIGHT,
  });
  widget.computeLayoutSize = () => ({ minHeight: MIN_PREVIEW_HEIGHT, minWidth: 1 });

  function enforcePreviewMinimumHeight() {
    const size = node.computeSize?.();
    if (!size) return;
    const previewTop = Number.isFinite(widget.last_y) && widget.last_y > 0
      ? widget.last_y
      : Math.max(0, size[1] - MIN_PREVIEW_HEIGHT);
    const minimumHeight = Math.ceil(
      previewTop + MIN_PREVIEW_HEIGHT + PREVIEW_BOTTOM_SPACE,
    );
    node.min_size = [node.min_size?.[0] || 0, minimumHeight];
    if ((node.size?.[1] || 0) < minimumHeight) {
      node.setSize([node.size?.[0] || size[0], minimumHeight]);
    }
  }
  requestAnimationFrame(() => requestAnimationFrame(enforcePreviewMinimumHeight));

  function showEntry(entry) {
    if (liveImage) {
      liveImage.style.display = "none";
      liveImage.removeAttribute("src");
      liveVideo.pause();
      liveVideo.removeAttribute("src");
      liveVideo.style.display = "none";
      if (liveVideoUrl) URL.revokeObjectURL(liveVideoUrl);
      liveVideoUrl = null;
    }
    if (!entry?.filename) {
      activeEntry = null;
      video.pause();
      video.removeAttribute("src");
      video.style.display = "none";
      updateToolbar();
      message.textContent = "Run the sampler to create a video preview.";
      message.style.display = "block";
      node.graph?.setDirtyCanvas(true, true);
      return;
    }

    activeEntry = entry;
    updateToolbar();
    video.src = previewUrl(entry);
    video.style.display = "block";
    message.style.display = "none";
    video.load();
    node.graph?.setDirtyCanvas(true, true);
  }

  function showLivePreview(data) {
    if (!supportsLivePreview || !data?.image) return;
    const mime = data.mime || "image/jpeg";
    activeEntry = null;
    updateToolbar();
    video.pause();
    video.removeAttribute("src");
    video.style.display = "none";
    message.style.display = "none";
    if (mime === "video/mp4") {
      liveImage.style.display = "none";
      liveImage.removeAttribute("src");
      liveVideo.pause();
      if (liveVideoUrl) URL.revokeObjectURL(liveVideoUrl);
      liveVideoUrl = URL.createObjectURL(base64Blob(data.image, mime));
      liveVideo.src = liveVideoUrl;
      liveVideo.style.display = "block";
      liveVideo.load();
      liveVideo.play().catch(() => {});
    } else {
      liveVideo.pause();
      liveVideo.removeAttribute("src");
      liveVideo.style.display = "none";
      if (liveVideoUrl) URL.revokeObjectURL(liveVideoUrl);
      liveVideoUrl = null;
      liveImage.src = `data:${mime};base64,${data.image}`;
      liveImage.style.display = "block";
    }
    node.graph?.setDirtyCanvas(true, true);
  }

  function receiveOutput(output) {
    if (output?.elvax_h3_live_preview) {
      node.properties ??= {};
      delete node.properties[PREVIEW_PROPERTY];
      return;
    }
    const entry = previewEntry(output);
    node.properties ??= {};
    if (entry) node.properties[PREVIEW_PROPERTY] = entry;
    else delete node.properties[PREVIEW_PROPERTY];
    showEntry(entry);
  }
  node.__elvaxH3ShowPreview = showEntry;
  node.__elvaxH3ShowLivePreview = showLivePreview;

  video.addEventListener("error", () => {
    activeEntry = null;
    updateToolbar();
    video.style.display = "none";
    message.textContent = "Preview expired or unavailable. Run the sampler again.";
    message.style.display = "block";
  });

  const originalExecuted = node.onExecuted;
  node.onExecuted = function (output) {
    const result = originalExecuted?.apply(this, arguments);
    receiveOutput(output);
    return result;
  };

  const originalConfigure = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = originalConfigure?.apply(this, args);
    requestAnimationFrame(() => showEntry(this.properties?.[PREVIEW_PROPERTY]));
    return result;
  };
  requestAnimationFrame(() => showEntry(node.properties?.[PREVIEW_PROPERTY]));
}

app.registerExtension({
  name: "elvax.h3-sampler-preview",
  nodeCreated(node) {
    if (node.comfyClass === NODE_TYPE || node.type === NODE_TYPE) {
      installPreview(node);
    }
  },
});

api.addEventListener("executed", ({ detail }) => {
  let node = app.graph.getNodeById(detail?.node);
  if (!node && typeof detail?.node === "string") {
    node = app.graph.getNodeById(parseInt(detail.node, 10));
  }
  if (!node || node.comfyClass !== NODE_TYPE && node.type !== NODE_TYPE) return;
  if (detail?.output?.elvax_h3_live_preview) {
    node.properties ??= {};
    delete node.properties[PREVIEW_PROPERTY];
    return;
  }
  const entry = previewEntry(detail?.output);
  node.properties ??= {};
  if (entry) node.properties[PREVIEW_PROPERTY] = entry;
  else delete node.properties[PREVIEW_PROPERTY];
  node.__elvaxH3ShowPreview?.(entry);
});

api.addEventListener("kj_preview_override", ({ detail }) => {
  const node = findNodeByQualifiedId(app.graph, detail?.node_id);
  if (node?.comfyClass !== NODE_TYPE && node?.type !== NODE_TYPE) return;
  node.__elvaxH3ShowLivePreview?.(detail);
});
