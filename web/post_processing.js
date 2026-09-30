import { app } from "/scripts/app.js";

const NODE_TYPE = "ElvaxPostProcessing";

function installToggle(node, toggleName, label, dependentNames, refresh) {
  const toggle = node.widgets?.find((widget) => widget.name === toggleName);
  const dependents = dependentNames
    .map((name) => node.widgets?.find((widget) => widget.name === name))
    .filter(Boolean);
  if (!toggle || toggle.__elvaxDisableInstalled) return;

  toggle.label = label;
  toggle.__elvaxDisableInstalled = true;
  const update = () => {
    for (const widget of dependents) widget.disabled = !toggle.value;
    refresh();
  };
  const callback = toggle.callback;
  toggle.callback = function (...args) {
    const result = callback?.apply(this, args);
    update();
    return result;
  };
  update();
}

function hideFixedWidget(node, name, value) {
  const widget = node.widgets?.find((item) => item.name === name);
  if (!widget) return;
  widget.value = value;
  widget.hidden = true;
  widget.type = "hidden";
  widget.computeSize = () => [0, -4];
}

app.registerExtension({
  name: "Elvax.PostProcessing",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;
    const optional = nodeData.input?.optional;
    const required = nodeData.input?.required;
    if (!optional?.audio_pass || !required?.images) return;

    const audioInput = optional.audio_pass;
    delete optional.audio_pass;
    const requiredInputs = Object.entries(required);
    requiredInputs.splice(requiredInputs.findIndex(([name]) => name === "images") + 1, 0, ["audio_pass", audioInput]);
    nodeData.input.required = Object.fromEntries(requiredInputs);

    const inputOrder = nodeData.input_order ??= {};
    inputOrder.optional = (inputOrder.optional ?? []).filter((name) => name !== "audio_pass");
    const requiredOrder = (inputOrder.required ?? Object.keys(required)).filter((name) => name !== "audio_pass");
    requiredOrder.splice(Math.max(0, requiredOrder.indexOf("images") + 1), 0, "audio_pass");
    inputOrder.required = requiredOrder;
  },
  nodeCreated(node) {
    if (node.type !== NODE_TYPE && node.comfyClass !== NODE_TYPE) return;
    const refresh = () => node.graph?.setDirtyCanvas(true, true);
    hideFixedWidget(node, "upscale_method", "lanczos");
    installToggle(node, "upscale", "UPSCALE (lanczos)", ["upscale_by"], refresh);
    installToggle(node, "interpolate", "INTERPOLATE (rife49)", ["original_fps", "interpolate_by"], refresh);
    installToggle(node, "grain", "FILM GRAIN", ["grain_intensity", "saturation_mix"], refresh);
    if (!node.__elvaxPostProcessingConfigureHook) {
      node.__elvaxPostProcessingConfigureHook = true;
      const onConfigure = node.onConfigure;
      node.onConfigure = function (...args) {
        const result = onConfigure?.apply(this, args);
        requestAnimationFrame(() => {
          for (const [toggleName, names] of [
            ["upscale", ["upscale_by"]],
            ["interpolate", ["original_fps", "interpolate_by"]],
            ["grain", ["grain_intensity", "saturation_mix"]],
          ]) {
            const enabled = Boolean(this.widgets?.find((widget) => widget.name === toggleName)?.value);
            for (const name of names) {
              const widget = this.widgets?.find((item) => item.name === name);
              if (widget) widget.disabled = !enabled;
            }
          }
          hideFixedWidget(this, "upscale_method", "lanczos");
          refresh();
        });
        return result;
      };
    }
  },
});
