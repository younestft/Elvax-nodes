import { app } from "/scripts/app.js";

const settings = ["temperature", "top_k", "top_p", "min_p", "repeat_penalty", "presence_penalty"];
let presets = [];

app.registerExtension({
  name: "Elvax.LLMTurbo",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "ElvaxLLMTurbo") return;
    presets = nodeData.input.required.inference_preset[1].elvax_presets;
    if (!nodeData.input.required.compact_mode) {
      nodeData.input.required = Object.fromEntries(Object.entries(nodeData.input.required).flatMap(([name, input]) =>
        name === "inference_preset" ? [["compact_mode", ["BOOLEAN", {
          default: false, socketless: true,
          tooltip: "Hide all settings below this without changing their values.",
        }]], [name, input]] : [[name, input]]));
      const order = nodeData.input_order?.required;
      if (order) order.splice(order.indexOf("inference_preset"), 0, "compact_mode");
    }
  },
  beforeConfigureGraph(graph) {
    for (const node of graph.nodes ?? []) {
      if (node.type !== "ElvaxLLMTurbo") continue;
      const order = node.properties?.elvax_llm_widget_order ?? 0;
      if (order >= 3) continue;
      if (order === 0) {
        if ([18, 19].includes(node.widgets_values?.length) && typeof node.widgets_values.at(-1) === "number") {
          node.widgets_values.splice(node.widgets_values.length - 1, 0, "Auto", "No custom builds found");
          node.widgets_values.push(true);
        }
        const values = node.widgets_values;
        if (![21, 22].includes(values?.length)) continue;
        const controlCount = values.length === 22 ? 1 : 0;
        node.widgets_values = [
          ...values.slice(0, 4),
          ...values.slice(13, 14 + controlCount),
          values[4],
          ...values.slice(7, 13),
          values[5], values[6],
          ...values.slice(14 + controlCount),
        ];
      }
      const values = node.widgets_values;
      if (order < 2) {
        if (![21, 22].includes(values?.length)) continue;
        const controlCount = values.length === 22 ? 1 : 0;
        values.splice(6 + controlCount, 0, "Custom");
      }
      if (![22, 23].includes(values?.length)) continue;
      const controlCount = values.length === 23 ? 1 : 0;
      values.splice(6 + controlCount, 0, false);
      node.properties ??= {};
      node.properties.elvax_llm_widget_order = 3;
    }
  },
  nodeCreated(node) {
    if (node.comfyClass !== "ElvaxLLMTurbo") return;
    const computeSize = node.computeSize;
    node.computeSize = function (...args) {
      const size = computeSize.apply(this, args);
      size[0] = Math.max(400, size[0]);
      return size;
    };
    const onResize = node.onResize;
    node.onResize = function (size, ...args) {
      size[0] = Math.max(400, size[0]);
      return onResize?.call(this, size, ...args);
    };
    node.min_size = [400, node.min_size?.[1] ?? 0];
    const preset = node.widgets?.find(widget => widget.name === "inference_preset");
    const sampling = settings.map(name => node.widgets?.find(widget => widget.name === name));
    const matches = definition => definition?.values && settings.every((name, index) => sampling[index]?.value === definition.values[name]);
    if (preset && sampling.every(Boolean)) {
      preset.callback = function (value) {
        const definition = presets.find(item => item.name === value);
        if (definition?.values) {
          sampling.forEach((widget, index) => { widget.value = definition.values[settings[index]]; });
        }
        node.graph?.setDirtyCanvas(true, true);
      };
      for (const widget of sampling) {
        const callback = widget.callback;
        widget.callback = function (...args) {
          const result = callback?.apply(this, args);
          preset.value = "Custom";
          node.graph?.setDirtyCanvas(true, true);
          return result;
        };
      }
      const configurePreset = node.onConfigure;
      node.onConfigure = function (...args) {
        const result = configurePreset?.apply(this, args);
        if (!matches(presets.find(item => item.name === preset.value))) preset.value = "Custom";
        return result;
      };
    }
    const penalty = node.widgets?.find(widget => widget.name === "presence_penalty");
    if (penalty) {
      const computeSize = penalty.computeSize;
      penalty.computeSize = function (width) {
        const size = computeSize?.call(this, width) ?? [width, LiteGraph.NODE_WIDGET_HEIGHT];
        return [size[0], size[1] + LiteGraph.NODE_WIDGET_HEIGHT + 4];
      };
    }
    node.setSize([550, node.computeSize()[1]]);
    const compact = node.widgets?.find(widget => widget.name === "compact_mode");
    if (compact) {
      compact.options.serialize = false;
      const controls = node.widgets.slice(node.widgets.indexOf(compact) + 1).map(widget => ({
        widget, type: widget.type, hidden: Boolean(widget.hidden), computeSize: widget.computeSize,
      }));
      let isCompact = false;
      let expandedColumns;
      const updateCompact = (resize = true) => {
        const hidden = Boolean(compact.value);
        if (hidden === isCompact) return;
        const previousMinimum = node.computeSize()[1];
        const previousHeight = node.size[1];
        const root = LiteGraph.vueNodesMode ? document.querySelector(`[data-node-id="${node.id}"]`) : null;
        const grid = root?.querySelector("[data-testid=node-widgets]");
        const compactRow = grid?.querySelector('[data-widget-name="compact_mode"]');
        const scale = root ? root.getBoundingClientRect().width / node.size[0] : 1;
        const compactBottom = compactRow ? (compactRow.getBoundingClientRect().bottom - root.getBoundingClientRect().top) / scale : null;
        if (grid) {
          if (hidden) {
            expandedColumns = grid.style.gridTemplateColumns;
            const labelWidth = getComputedStyle(grid).gridTemplateColumns.split(" ")[1];
            grid.style.gridTemplateColumns = `min-content minmax(0, ${labelWidth}) minmax(125px, 1fr)`;
          } else {
            grid.style.gridTemplateColumns = expandedColumns ?? "";
          }
        }
        for (const control of controls) {
          control.widget.type = hidden ? "hidden" : control.type;
          control.widget.hidden = hidden ? true : control.hidden;
          control.widget.computeSize = hidden ? () => [0, -4] : control.computeSize;
        }
        isCompact = hidden;
        if (resize && compactRow) {
          requestAnimationFrame(() => {
            if (!node.graph || !grid.isConnected || Boolean(compact.value) !== hidden) return;
            const rect = root.getBoundingClientRect();
            const scale = rect.width / node.size[0];
            const bottom = (compactRow.getBoundingClientRect().bottom - rect.top) / scale;
            const height = rect.height / scale - LiteGraph.NODE_TITLE_HEIGHT;
            node.setSize([node.size[0], height + compactBottom - bottom]);
            node.graph?.setDirtyCanvas(true, true);
          });
        } else if (resize) {
          const height = node.computeSize()[1];
          node.setSize([node.size[0], Math.max(height, previousHeight + height - previousMinimum)]);
        }
        node.graph?.setDirtyCanvas(true, true);
      };
      const callback = compact.callback;
      compact.callback = function (...args) {
        const result = callback?.apply(this, args);
        updateCompact();
        return result;
      };
      const configureCompact = node.onConfigure;
      node.onConfigure = function (...args) {
        const result = configureCompact?.apply(this, args);
        updateCompact(false);
        return result;
      };
      updateCompact();
    }
    const serialize = node.onSerialize;
    node.onSerialize = function (data) {
      const result = serialize?.apply(this, arguments);
      data.properties ??= {};
      data.properties.elvax_llm_widget_order = 3;
      return result;
    };
    const backend = node.widgets?.find(widget => widget.name === "gpu_backend");
    const custom = node.widgets?.find(widget => widget.name === "custom_build");
    if (!backend || !custom) return;
    const refresh = () => {
      const choices = backend.options?.values;
      if (backend.value === "Auto" && Array.isArray(choices) && choices.includes("Metal") && !choices.includes("Auto")) {
        backend.value = "Metal";
      }
      custom.disabled = backend.value !== "Custom";
      node.graph?.setDirtyCanvas(true, true);
    };
    const callback = backend.callback;
    backend.callback = function (...args) {
      const result = callback?.apply(this, args);
      refresh();
      return result;
    };
    const configure = node.onConfigure;
    node.onConfigure = function (...args) {
      const result = configure?.apply(this, args);
      refresh();
      return result;
    };
    refresh();
  },
});
