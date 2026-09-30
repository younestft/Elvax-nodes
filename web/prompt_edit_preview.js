import { app } from "/scripts/app.js";

const NODE_TYPE = "ElvaxPromptEditPreview";
const MIN_BODY_HEIGHT = 80;

function removeObsoleteWidgetSockets(node) {
  for (let index = (node.inputs?.length ?? 0) - 1; index >= 0; index--) {
    const input = node.inputs[index];
    if ((input.name === "mode" || input.name === "text") && input.link == null) {
      node.removeInput(index);
    }
  }
}

function installModeLayout(node) {
  if (node.__elvaxPromptEditPreviewInstalled) return;
  const modeWidget = node.widgets?.find((widget) => widget.name === "mode");
  const textWidget = node.widgets?.find((widget) => widget.name === "text");
  if (!modeWidget || !textWidget) return;

  removeObsoleteWidgetSockets(node);
  node.__elvaxPromptEditPreviewInstalled = true;
  let previewText = null;
  const width = node.size?.[0] || 300;
  const naturalSize = node.computeSize();
  const textSize = textWidget.computeSize?.(width) || [width, 180];
  const nodeChromeHeight = Math.max(0, naturalSize[1] - textSize[1]);
  let bodyHeight = Math.max(MIN_BODY_HEIGHT, (node.size?.[1] || naturalSize[1]) - nodeChromeHeight);

  const root = document.createElement("div");
  root.style.cssText = "position:relative;width:100%;height:100%;box-sizing:border-box;overflow:hidden;";
  const editor = document.createElement("textarea");
  editor.spellcheck = false;
  editor.style.cssText = "position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;resize:none;overflow:auto;padding:8px;border:1px solid #555;border-radius:4px;background:#202020;color:#ddd;font:12px monospace;line-height:1.45;outline:none;";
  const previewContent = document.createElement("pre");
  previewContent.style.cssText = "position:absolute;inset:0;margin:0;padding:8px 48px 8px 8px;overflow:auto;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #555;border-radius:4px;background:#202020;color:#ddd;font:12px/1.45 sans-serif;user-select:text;";
  const previewActions = document.createElement("div");
  previewActions.style.cssText = "position:absolute;top:6px;right:16px;display:flex;flex-direction:column;gap:4px;opacity:0;pointer-events:none;transition:opacity 100ms;";
  const actionStyle = "display:flex;align-items:center;justify-content:center;width:26px;height:26px;box-sizing:border-box;padding:3px;border:1px solid transparent;border-radius:4px;background:transparent;color:#bbb;cursor:pointer;transition:background-color 100ms,border-color 100ms,color 100ms;";
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.title = "Copy to clipboard";
  copyButton.setAttribute("aria-label", "Copy to clipboard");
  copyButton.style.cssText = actionStyle;
  const copyIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
  const copiedIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
  const editIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 16.5 11.8-11.8a2.1 2.1 0 0 1 3 3L7 19.5l-3.5 1L4 16.5Z"/><path d="m14.7 6.3 3 3"/><path d="m4 16.5 3 3"/></svg>';
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.title = "Edit this preview text";
  editButton.setAttribute("aria-label", "Edit this preview text");
  editButton.innerHTML = editIcon;
  editButton.style.cssText = actionStyle;
  copyButton.innerHTML = copyIcon;
  for (const button of [copyButton, editButton]) {
    button.addEventListener("pointerenter", () => {
      button.style.background = "#383838";
      button.style.borderColor = "#666";
      button.style.color = "#fff";
    });
    button.addEventListener("pointerleave", () => {
      button.style.background = "transparent";
      button.style.borderColor = "transparent";
      button.style.color = "#bbb";
    });
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
  }
  copyButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(previewText ?? "");
      copyButton.innerHTML = copiedIcon;
      copyButton.title = "Copied to clipboard";
      app.extensionManager.toast.add({
        severity: "success",
        summary: "Copied",
        detail: "Text copied to clipboard",
        life: 2000,
      });
      setTimeout(() => {
        copyButton.innerHTML = copyIcon;
        copyButton.title = "Copy to clipboard";
      }, 1200);
    } catch {
      app.extensionManager.toast.add({
        severity: "error",
        summary: "Copy failed",
        detail: "The browser could not access the clipboard",
        life: 2500,
      });
    }
  });
  editButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (previewText == null || String(previewText).length === 0) return;

    const value = String(previewText);
    textWidget.value = value;
    editor.value = value;
    textWidget.callback?.(value, app.canvas, node);
    modeWidget.value = true;
    modeWidget.callback?.(true, app.canvas, node);
    update();
  });
  for (const eventName of ["pointerdown", "pointermove"]) {
    root.addEventListener(eventName, (event) => event.stopPropagation());
  }
  root.addEventListener("pointerenter", () => {
    if (previewActions.style.display !== "none") {
      previewActions.style.opacity = "1";
      previewActions.style.pointerEvents = "auto";
    }
  });
  root.addEventListener("pointerleave", () => {
    previewActions.style.opacity = "0";
    previewActions.style.pointerEvents = "none";
  });
  editor.addEventListener("input", () => {
    textWidget.value = editor.value;
    textWidget.callback?.(textWidget.value, app.canvas, node);
    node.graph?.setDirtyCanvas(true, true);
  });
  previewActions.append(copyButton, editButton);
  root.append(editor, previewContent, previewActions);

  textWidget.hidden = true;
  textWidget.type = "hidden";
  textWidget.computeSize = () => [0, -4];

  const bodyWidget = node.addDOMWidget("prompt_body", "div", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => MIN_BODY_HEIGHT,
    getMaxHeight: () => bodyHeight,
    getHeight: () => bodyHeight,
  });
  bodyWidget.computeLayoutSize = () => ({
    minHeight: Math.min(MIN_BODY_HEIGHT, bodyHeight),
    maxHeight: bodyHeight,
    minWidth: 1,
  });

  const update = () => {
    const source = node.inputs?.find((input) => input.name === "source");
    const previewMode = !Boolean(modeWidget.value);
    const hasSource = source?.link != null;
    const hasPreviewText = previewText != null && String(previewText).length > 0;
    if (editor.value !== String(textWidget.value ?? "")) {
      editor.value = String(textWidget.value ?? "");
    }
    editor.style.display = previewMode ? "none" : "block";
    previewContent.style.display = previewMode ? "block" : "none";
    previewActions.style.display = previewMode && hasSource && hasPreviewText ? "flex" : "none";
    previewActions.style.opacity = "0";
    previewActions.style.pointerEvents = "none";
    const visiblePreview = hasSource ? previewText : null;
    previewContent.textContent = visiblePreview
      ?? "(Connect source and run the workflow to preview source text.)";
    previewContent.style.color = visiblePreview === null ? "#888" : "#ddd";
    node.graph?.setDirtyCanvas(true, true);
  };

  const originalCallback = modeWidget.callback;
  modeWidget.callback = function (...args) {
    const result = originalCallback?.apply(this, args);
    update();
    return result;
  };

  const originalConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) {
    const result = originalConnectionsChange?.apply(this, args);
    update();
    return result;
  };

  const originalExecuted = node.onExecuted;
  node.onExecuted = function (output) {
    const result = originalExecuted?.apply(this, arguments);
    previewText = output?.elvax_prompt_preview?.[0] ?? null;
    update();
    return result;
  };

  const originalResize = node.onResize;
  node.onResize = function (...args) {
    const result = originalResize?.apply(this, args);
    bodyHeight = Math.max(MIN_BODY_HEIGHT, node.size[1] - nodeChromeHeight);
    node.graph?.setDirtyCanvas(true, true);
    return result;
  };

  const originalConfigure = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = originalConfigure?.apply(this, args);
    removeObsoleteWidgetSockets(node);
    requestAnimationFrame(update);
    return result;
  };

  update();
}

app.registerExtension({
  name: "elvax.prompt-edit-preview",
  nodeCreated(node) {
    if (node.comfyClass === NODE_TYPE || node.type === NODE_TYPE) {
      installModeLayout(node);
    }
  },
});
