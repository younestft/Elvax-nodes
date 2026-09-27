import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_TYPE = "ElvaxLoadCropImage";
const CROP_WIDGETS = ["crop_x", "crop_y", "crop_width", "crop_height"];
const HANDLE_SIZE = 7;
const MIN_PREVIEW_HEIGHT = 190;
const RESOLUTION_HEIGHT = 18;
const MIN_WIDGET_HEIGHT = MIN_PREVIEW_HEIGHT + 22 + RESOLUTION_HEIGHT;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizedRect(x1, y1, x2, y2) {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  return {
    x: left,
    y: top,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

function viewUrl(value) {
  if (!value || value === "None") return null;
  let path = String(value).replace(/\\/g, "/");
  let type = "input";
  const annotation = path.match(/\s+\[(input|output|temp)\]$/i);
  if (annotation) {
    type = annotation[1].toLowerCase();
    path = path.slice(0, annotation.index);
  }
  const parts = path.split("/");
  const filename = parts.pop();
  const params = new URLSearchParams({
    filename,
    subfolder: parts.join("/"),
    type,
    elvax_preview: String(Date.now()),
  });
  return api.apiURL(`/view?${params}`);
}

function installCropUI(node) {
  if (node.__elvaxLoadCropInstalled) return;
  const imageWidget = node.widgets?.find((widget) => widget.name === "image");
  const cropWidgets = Object.fromEntries(
    CROP_WIDGETS.map((name) => [name, node.widgets?.find((widget) => widget.name === name)]),
  );
  if (!imageWidget || CROP_WIDGETS.some((name) => !cropWidgets[name])) return;
  node.__elvaxLoadCropInstalled = true;

  // Keep Comfy's upload control, but let this widget own the image preview.
  Object.defineProperty(node, "imgs", {
    configurable: true,
    get: () => undefined,
    set: () => {},
  });

  for (const widget of Object.values(cropWidgets)) {
    widget.hidden = true;
    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
  }

  const root = document.createElement("div");
  root.dataset.elvaxLoadCropPreview = "true";
  root.style.cssText = "display:flex;flex-direction:column;gap:6px;width:100%;box-sizing:border-box;pointer-events:none;";
  const buttons = document.createElement("div");
  buttons.style.cssText = "display:flex;gap:6px;width:calc(100% - 12px);margin:-8px 6px 0;pointer-events:auto;";

  function makeButton(label) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.cssText = "flex:1;min-width:0;height:24px;padding:2px 8px;border:1px solid #555;border-radius:0;background:#242424;color:#bbb;font:12px sans-serif;line-height:18px;text-align:center;cursor:pointer;";
    button.addEventListener("mouseenter", () => {
      if (!button.disabled) {
        button.style.background = "#3a3a3a";
        button.style.borderColor = "#777";
        button.style.color = "#fff";
      }
    });
    button.addEventListener("mouseleave", () => styleButton(button));
    button.addEventListener("mousedown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    return button;
  }

  function styleButton(button) {
    button.style.opacity = button.disabled ? "0.42" : "1";
    button.style.cursor = button.disabled ? "default" : "pointer";
    button.style.background = "#242424";
    button.style.borderColor = "#555";
    button.style.color = "#bbb";
  }

  const restoreButton = makeButton("Restore");
  const cropButton = makeButton("Crop");
  buttons.append(restoreButton, cropButton);

  const nodeBackground = node.bgcolor || window.LiteGraph.NODE_DEFAULT_BGCOLOR;
  const preview = document.createElement("div");
  preview.style.cssText = "display:flex;flex:1 1 auto;flex-direction:column;justify-content:center;align-items:center;min-height:0;margin:0 -10px -10px;overflow:hidden;border-radius:0 0 10px 10px;pointer-events:none;";
  preview.style.backgroundColor = nodeBackground;
  const imageWrap = document.createElement("div");
  imageWrap.style.cssText = "position:relative;flex:0 0 auto;pointer-events:none;";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;max-width:100%;user-select:none;pointer-events:none;";
  const interaction = document.createElement("div");
  interaction.style.cssText = "position:absolute;inset:10px;touch-action:none;pointer-events:auto;cursor:crosshair;outline:none;";
  interaction.tabIndex = 0;
  imageWrap.append(canvas, interaction);
  const resolution = document.createElement("div");
  resolution.style.cssText = `flex:0 0 ${RESOLUTION_HEIGHT}px;height:${RESOLUTION_HEIGHT}px;padding-top:3px;box-sizing:border-box;color:#aaa;font:10px/12px sans-serif;text-align:center;white-space:nowrap;user-select:none;`;
  preview.append(imageWrap, resolution);
  root.append(buttons, preview);
  const ctx = canvas.getContext("2d");

  let editorHeight = 76;
  const domWidget = node.addDOMWidget("crop_preview", "div", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => MIN_WIDGET_HEIGHT,
    getMaxHeight: () => editorHeight,
    getHeight: () => editorHeight,
  });
  if (!document.getElementById("elvax-load-crop-widget-style")) {
    const style = document.createElement("style");
    style.id = "elvax-load-crop-widget-style";
    style.textContent = ".dom-widget:has(>[data-elvax-load-crop-preview]){pointer-events:none!important}";
    document.head.append(style);
  }

  let source = null;
  let imageWidth = 0;
  let imageHeight = 0;
  let viewRect = null;
  let selection = null;
  let appliedCrop = null;
  let drag = null;
  let initialSizeApplied = false;

  function readAppliedCrop() {
    const crop = {
      x: Number(cropWidgets.crop_x.value) || 0,
      y: Number(cropWidgets.crop_y.value) || 0,
      width: Number(cropWidgets.crop_width.value) || 0,
      height: Number(cropWidgets.crop_height.value) || 0,
    };
    return crop.width > 0 && crop.height > 0 ? crop : null;
  }

  function setCropWidgets(crop) {
    const values = crop
      ? [crop.x, crop.y, crop.width, crop.height].map(Math.round)
      : [0, 0, 0, 0];
    CROP_WIDGETS.forEach((name, index) => {
      const widget = cropWidgets[name];
      widget.value = values[index];
      widget.callback?.(widget.value, app.canvas, node);
    });
  }

  function updateButtons() {
    const view = viewRect || { x: 0, y: 0, width: imageWidth, height: imageHeight };
    const isFullView = selection
      && selection.x <= 0 && selection.y <= 0
      && selection.x + selection.width >= view.width
      && selection.y + selection.height >= view.height;
    cropButton.disabled = !selection || selection.width < 1 || selection.height < 1
      || isFullView;
    restoreButton.disabled = !appliedCrop;
    styleButton(cropButton);
    styleButton(restoreButton);
  }

  function previewDimensions() {
    const maxWidth = Math.max(1, preview.clientWidth || 320);
    const previewTop = Number.isFinite(domWidget.last_y) && domWidget.last_y > 0
      ? domWidget.last_y : 94;
    const maxHeight = Math.max(MIN_PREVIEW_HEIGHT, (node.size?.[1] || 0) - previewTop - 32 - RESOLUTION_HEIGHT);
    const view = viewRect || { x: 0, y: 0, width: imageWidth || 16, height: imageHeight || 9 };
    const scale = Math.min(maxWidth / view.width, maxHeight / view.height);
    const width = Math.max(1, Math.round(view.width * scale));
    const height = Math.max(1, Math.round(view.height * scale));
    return { width, height };
  }

  function updateMinimumNodeSize(growFreshNode = false) {
    const size = node.computeSize?.();
    if (!size) return;
    const previewTop = Number.isFinite(domWidget.last_y) && domWidget.last_y > 0
      ? domWidget.last_y
      : Math.max(0, size[1] - editorHeight);
    const minimumHeight = Math.max(size[1], Math.ceil(previewTop + MIN_WIDGET_HEIGHT + 10));
    node.min_size = [nativeMinimumWidth, minimumHeight];
    if (growFreshNode && !node.__elvaxWasConfigured) {
      const targetHeight = minimumHeight + 8;
      if ((node.size?.[1] || 0) < targetHeight) {
        node.setSize([Math.max(node.size?.[0] || 0, nativeMinimumWidth), targetHeight]);
      }
    }
  }

  function scheduleMinimumNodeSize(growFreshNode = false) {
    requestAnimationFrame(() => updateMinimumNodeSize(growFreshNode));
  }

  function resizeCanvas() {
    const size = previewDimensions();
    const previewHeight = Math.max(MIN_PREVIEW_HEIGHT, size.height);
    editorHeight = previewHeight + 22 + RESOLUTION_HEIGHT;
    const view = viewRect || { width: size.width, height: size.height };
    const pixelWidth = Math.max(1, Math.round(view.width));
    const pixelHeight = Math.max(1, Math.round(view.height));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    imageWrap.style.width = `${size.width}px`;
    imageWrap.style.height = `${size.height}px`;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    resolution.textContent = source && imageWidth && imageHeight ? `${pixelWidth} × ${pixelHeight}` : "";
    draw();
  }

  function draw() {
    const width = canvas.width;
    const height = canvas.height;
    if (!width || !height) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = nodeBackground;
    ctx.fillRect(0, 0, width, height);
    if (source && imageWidth && imageHeight) {
      const view = viewRect || { x: 0, y: 0, width: imageWidth, height: imageHeight };
      ctx.drawImage(source, view.x, view.y, view.width, view.height, 0, 0, width, height);
    } else {
      ctx.fillStyle = "#999";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Choose an image to crop", width / 2, height / 2);
      updateButtons();
      return;
    }

    if (selection && selection.width > 0 && selection.height > 0) {
      const view = viewRect || { width: imageWidth, height: imageHeight };
      const sx = width / view.width;
      const sy = height / view.height;
      const left = selection.x * sx;
      const top = selection.y * sy;
      const boxWidth = selection.width * sx;
      const boxHeight = selection.height * sy;
      const right = left + boxWidth;
      const bottom = top + boxHeight;
      ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
      ctx.fillRect(0, 0, width, top);
      ctx.fillRect(0, top, left, boxHeight);
      ctx.fillRect(right, top, width - right, boxHeight);
      ctx.fillRect(0, bottom, width, height - bottom);
      ctx.strokeStyle = "#f4f4f4";
      ctx.lineWidth = 1;
      ctx.strokeRect(left + 0.5, top + 0.5, Math.max(0, boxWidth - 1), Math.max(0, boxHeight - 1));

      const handle = Math.max(4, HANDLE_SIZE * width / Math.max(1, preview.clientWidth));
      const half = handle / 2;
      const points = [
        [left, top], [left + boxWidth / 2, top], [right, top],
        [left, top + boxHeight / 2], [right, top + boxHeight / 2],
        [left, bottom], [left + boxWidth / 2, bottom], [right, bottom],
      ];
      ctx.fillStyle = "#f4f4f4";
      ctx.strokeStyle = "#555";
      ctx.lineWidth = Math.max(1, width / Math.max(1, preview.clientWidth));
      for (const [x, y] of points) {
        ctx.fillRect(x - half, y - half, handle, handle);
        ctx.strokeRect(x - half + 0.5, y - half + 0.5, Math.max(1, handle - 1), Math.max(1, handle - 1));
      }
    }
    updateButtons();
  }

  function pointFromEvent(event) {
    const bounds = canvas.getBoundingClientRect();
    const view = viewRect || { width: imageWidth, height: imageHeight };
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width * view.width, 0, view.width),
      y: clamp((event.clientY - bounds.top) / bounds.height * view.height, 0, view.height),
    };
  }

  function hitTest(point) {
    if (!selection) return "draw";
    const view = viewRect || { width: imageWidth, height: imageHeight };
    const toleranceX = 9 * view.width / Math.max(1, canvas.getBoundingClientRect().width);
    const toleranceY = 9 * view.height / Math.max(1, canvas.getBoundingClientRect().height);
    const left = selection.x;
    const top = selection.y;
    const right = left + selection.width;
    const bottom = top + selection.height;
    const nearLeft = Math.abs(point.x - left) <= toleranceX;
    const nearRight = Math.abs(point.x - right) <= toleranceX;
    const nearTop = Math.abs(point.y - top) <= toleranceY;
    const nearBottom = Math.abs(point.y - bottom) <= toleranceY;
    const withinX = point.x >= left - toleranceX && point.x <= right + toleranceX;
    const withinY = point.y >= top - toleranceY && point.y <= bottom + toleranceY;

    if (withinX && withinY) {
      if (nearTop && nearLeft) return "nw";
      if (nearTop && nearRight) return "ne";
      if (nearBottom && nearLeft) return "sw";
      if (nearBottom && nearRight) return "se";
      if (nearTop) return "n";
      if (nearBottom) return "s";
      if (nearLeft) return "w";
      if (nearRight) return "e";
      if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) return "move";
    }
    return "draw";
  }

  const cursors = {
    n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
    ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize",
    move: "move", draw: "crosshair",
  };

  function cancelSelection() {
    if (drag) {
      if (interaction.hasPointerCapture(drag.pointerId)) interaction.releasePointerCapture(drag.pointerId);
      drag = null;
    }
    selection = null;
    draw();
  }

  function selectNode() {
    app.canvas?.selectNode(node, false);
  }

  root.addEventListener("pointerdown", (event) => {
    if (event.button === 0) selectNode();
  }, true);

  root.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (selection || drag) {
      cancelSelection();
      return;
    }
    const graphCanvas = app.canvas;
    if (graphCanvas?.convertEventToCanvasOffset) {
      const offset = graphCanvas.convertEventToCanvasOffset(event);
      event.canvasX = offset[0];
      event.canvasY = offset[1];
    }
    graphCanvas?.processContextMenu(node, event);
  });

  async function copyImage() {
    if (!source || !imageWidth || !imageHeight) return;
    const view = viewRect || { x: 0, y: 0, width: imageWidth, height: imageHeight };
    const image = document.createElement("canvas");
    image.width = view.width;
    image.height = view.height;
    image.getContext("2d").drawImage(source, view.x, view.y, view.width, view.height, 0, 0, view.width, view.height);
    const blob = new Promise((resolve) => image.toBlob(resolve, "image/png"));
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    } catch (error) {
      console.warn("Load/Crop Image: could not copy image", error);
    }
  }

  function onKeyDown(event) {
    if (event.key === "Escape" && (selection || drag) && (document.activeElement === interaction || app.canvas?.selected_nodes?.[node.id])) {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelSelection();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "c") return;
    if (!app.canvas?.selected_nodes?.[node.id] || Object.keys(app.canvas.selected_nodes).length !== 1) return;
    if (event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(event.target.tagName))) return;
    if (!source) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    copyImage();
  }
  window.addEventListener("keydown", onKeyDown, true);

  interaction.addEventListener("pointerdown", (event) => {
    if (!source || !imageWidth || !imageHeight || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    interaction.focus({ preventScroll: true });
    const point = pointFromEvent(event);
    const mode = hitTest(point);
    drag = { mode, start: point, original: selection && { ...selection }, pointerId: event.pointerId };
    if (mode === "draw") selection = { x: point.x, y: point.y, width: 0, height: 0 };
    interaction.setPointerCapture(event.pointerId);
    draw();
  });

  interaction.addEventListener("pointermove", (event) => {
    if (!source || !imageWidth || !imageHeight) return;
    const point = pointFromEvent(event);
    if (!drag) {
      interaction.style.cursor = cursors[hitTest(point)] || "crosshair";
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    if (drag.mode === "draw") {
      selection = normalizedRect(drag.start.x, drag.start.y, point.x, point.y);
    } else if (drag.mode === "move") {
      const original = drag.original;
      selection = {
        ...original,
        x: clamp(original.x + dx, 0, viewRect.width - original.width),
        y: clamp(original.y + dy, 0, viewRect.height - original.height),
      };
    } else {
      const original = drag.original;
      let left = original.x;
      let top = original.y;
      let right = original.x + original.width;
      let bottom = original.y + original.height;
      if (drag.mode.includes("w")) left = clamp(original.x + dx, 0, right - 1);
      if (drag.mode.includes("e")) right = clamp(original.x + original.width + dx, left + 1, viewRect.width);
      if (drag.mode.includes("n")) top = clamp(original.y + dy, 0, bottom - 1);
      if (drag.mode.includes("s")) bottom = clamp(original.y + original.height + dy, top + 1, viewRect.height);
      selection = { x: left, y: top, width: right - left, height: bottom - top };
    }
    interaction.style.cursor = cursors[drag.mode] || "crosshair";
    draw();
  });

  function finishDrag(event) {
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    drag = null;
    if (selection) {
      selection = {
        x: Math.round(selection.x),
        y: Math.round(selection.y),
        width: Math.round(selection.width),
        height: Math.round(selection.height),
      };
      if (selection.width < 1 || selection.height < 1) selection = null;
    }
    draw();
  }
  interaction.addEventListener("pointerup", finishDrag);
  interaction.addEventListener("pointercancel", finishDrag);

  cropButton.addEventListener("click", () => {
    if (cropButton.disabled) return;
    appliedCrop = {
      x: Math.round(viewRect.x + selection.x),
      y: Math.round(viewRect.y + selection.y),
      width: Math.round(selection.width),
      height: Math.round(selection.height),
    };
    viewRect = { ...appliedCrop };
    selection = null;
    setCropWidgets(appliedCrop);
    resizeCanvas();
    node.graph?.setDirtyCanvas(true, true);
  });

  restoreButton.addEventListener("click", () => {
    if (restoreButton.disabled) return;
    appliedCrop = null;
    viewRect = { x: 0, y: 0, width: imageWidth, height: imageHeight };
    selection = null;
    setCropWidgets(null);
    resizeCanvas();
    node.graph?.setDirtyCanvas(true, true);
  });

  function loadPreview(resetCrop) {
    const url = viewUrl(imageWidget.value);
    source = null;
    imageWidth = 0;
    imageHeight = 0;
    viewRect = null;
    if (resetCrop) {
      selection = null;
      appliedCrop = null;
      setCropWidgets(null);
    } else {
      appliedCrop = readAppliedCrop();
      selection = null;
    }
    resizeCanvas();
    if (!url) return;

    const path = String(imageWidget.value || "").toLowerCase();
    const isVideo = /\.(mp4|m4v|mov|webm|avi|mkv|mpeg|mpg)(?:\s+\[(?:input|output|temp)\])?$/.test(path);
    const media = isVideo ? document.createElement("video") : new Image();
    source = media;
    if (isVideo) {
      media.muted = true;
      media.playsInline = true;
      media.preload = "metadata";
      media.addEventListener("loadeddata", () => {
        imageWidth = media.videoWidth;
        imageHeight = media.videoHeight;
        viewRect = appliedCrop
          ? { ...appliedCrop }
          : { x: 0, y: 0, width: imageWidth, height: imageHeight };
        resizeCanvas();
        if (!initialSizeApplied) {
          initialSizeApplied = true;
          scheduleMinimumNodeSize(true);
        }
      }, { once: true });
    } else {
      media.onload = () => {
        imageWidth = media.naturalWidth;
        imageHeight = media.naturalHeight;
        viewRect = appliedCrop
          ? { ...appliedCrop }
          : { x: 0, y: 0, width: imageWidth, height: imageHeight };
        resizeCanvas();
        if (!initialSizeApplied) {
          initialSizeApplied = true;
          scheduleMinimumNodeSize(true);
        }
      };
    }
    media.onerror = () => {
      source = null;
      imageWidth = 0;
      imageHeight = 0;
      resizeCanvas();
    };
    media.src = url;
  }

  domWidget.computeLayoutSize = () => ({ minHeight: MIN_WIDGET_HEIGHT, maxHeight: editorHeight, minWidth: 0 });
  const nativeMinimumWidth = new window.LiteGraph.registered_node_types.LoadImage().computeSize()[0];
  if (node.__elvaxWasConfigured) initialSizeApplied = true;
  scheduleMinimumNodeSize();
  const resizeObserver = new ResizeObserver(() => {
    resizeCanvas();
  });
  resizeObserver.observe(preview);
  node.__elvaxCropPreviewCleanup = () => {
    resizeObserver.disconnect();
    window.removeEventListener("keydown", onKeyDown, true);
  };
  const originalRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    node.__elvaxCropPreviewCleanup();
    return originalRemoved?.apply(this, args);
  };

  const originalImageCallback = imageWidget.callback;
  imageWidget.callback = function (...args) {
    const result = originalImageCallback?.apply(this, args);
    loadPreview(true);
    return result;
  };

  const originalConfigure = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = originalConfigure?.apply(this, args);
    requestAnimationFrame(() => {
      loadPreview(false);
    });
    return result;
  };

  const originalResize = node.onResize;
  node.onResize = function (...args) {
    const result = originalResize?.apply(this, args);
    requestAnimationFrame(() => resizeCanvas());
    return result;
  };

  loadPreview(false);
  updateButtons();
  if (domWidget) node.graph?.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "Elvax.LoadCropImage",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;
    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalCreated?.apply(this, args);
      requestAnimationFrame(() => installCropUI(this));
      return result;
    };
    const originalConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = originalConfigure?.apply(this, args);
      requestAnimationFrame(() => installCropUI(this));
      return result;
    };
  },
});
