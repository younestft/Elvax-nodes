import { app } from "/scripts/app.js";

const PIPE_IN = "ElvaxDynamicPipeIn";
const PIPE_OUT = "ElvaxDynamicPipeOut";
const MAX_PIPE_SLOTS = 32;
const PIPE_DEFAULT_WIDTH = 260;
const SAMPLER_NODE_TYPES = new Set([
  "ElvaxH3ExtensionSampler",
  "ElvaxH3SamplerPreview",
  "ElvaxH3SamplerPreviewV2",
]);
const HOLLOW_CIRCLE_SHAPE = 7;
const TRANSITION_MODE_TOOLTIPS = {
  "motion context":
    "Continues from the previous stage's latent context.",
  "hard cut":
    "Skips the new stage's first 5 frames at the join; this is a latent-space cut.",
};

function isNode(node, type) {
  return node?.type === type || node?.comfyClass === type;
}

function linkedOutput(node, input) {
  if (input.link == null) return null;
  const link = node.graph?.links?.[input.link];
  const origin = link && node.graph.getNodeById(link.origin_id);
  return origin?.outputs?.[link.origin_slot] ?? null;
}

function linkedOrigin(node, input) {
  if (input.link == null) return null;
  const link = node.graph?.links?.[input.link];
  return link ? node.graph?.getNodeById(link.origin_id) ?? null : null;
}

function isRerouteNode(node) {
  return node?.type === "Reroute" || node?.comfyClass === "Reroute";
}

function connectedOutput(node, input) {
  const visited = new Set();
  let source = linkedOrigin(node, input);
  let output = linkedOutput(node, input);
  while (isRerouteNode(source) && !visited.has(source)) {
    visited.add(source);
    const upstream = source.inputs?.find((item) => item.link != null);
    if (!upstream) break;
    output = linkedOutput(source, upstream);
    source = linkedOrigin(source, upstream);
  }
  return { source, output };
}

function labelFor(output, fallback) {
  return output?.label || output?.name || fallback;
}

function uniqueLabels(labels) {
  const used = new Set();
  const nextSuffix = new Map();
  return labels.map((label) => {
    const base = String(label);
    let candidate = base;
    let suffix = nextSuffix.get(base) || 2;
    while (used.has(candidate)) {
      candidate = `${base}_${suffix++}`;
    }
    used.add(candidate);
    nextSuffix.set(base, suffix);
    return candidate;
  });
}

function frontendGetName(node) {
  if (node?.type !== "GetNode" && node?.comfyClass !== "GetNode") return null;
  const widget = node.widgets?.find((item) => item.name === "Constant")
    || node.widgets?.[0];
  const value = typeof widget?.value === "string" ? widget.value.trim() : "";
  return value || null;
}

function connectedValueLabel(node, input, fallback) {
  const { source, output } = connectedOutput(node, input);
  return frontendGetName(source) || labelFor(output, fallback);
}

function refreshDownstreamPipeLabels(sourceNode) {
  const visited = new Set();
  const pending = [sourceNode];
  while (pending.length) {
    const source = pending.pop();
    if (!source || visited.has(source)) continue;
    visited.add(source);
    for (const output of source.outputs || []) {
      for (const linkId of output.links || []) {
        const link = source.graph?.links?.[linkId];
        const target = link && source.graph?.getNodeById(link.target_id);
        if (isNode(target, PIPE_IN)) syncPipeIn(target);
        else if (isRerouteNode(target)) pending.push(target);
      }
    }
  }
}

function installRerouteLabelSync(node) {
  if (node.__elvaxRerouteLabelSyncInstalled) return;
  node.__elvaxRerouteLabelSyncInstalled = true;
  const refresh = () => requestAnimationFrame(() => refreshDownstreamPipeLabels(node));

  const originalConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) {
    const result = originalConnectionsChange?.apply(this, args);
    refresh();
    return result;
  };

  const originalConfigure = node.onConfigure;
  node.onConfigure = function (...args) {
    const result = originalConfigure?.apply(this, args);
    refresh();
    return result;
  };
  refresh();
}

function installGetNodeLabelSync(node) {
  if (node.__elvaxGetLabelSyncInstalled) return;
  node.__elvaxGetLabelSyncInstalled = true;

  const widget = node.widgets?.find((item) => item.name === "Constant")
    || node.widgets?.[0];
  if (widget) {
    const originalCallback = widget.callback;
    widget.callback = function (...args) {
      const result = originalCallback?.apply(this, args);
      requestAnimationFrame(() => refreshDownstreamPipeLabels(node));
      return result;
    };
  }

  const originalRename = node.onRename;
  if (originalRename) {
    node.onRename = function (...args) {
      const result = originalRename.apply(this, args);
      requestAnimationFrame(() => refreshDownstreamPipeLabels(node));
      return result;
    };
  }

  const originalConfigure = node.onConfigure;
  if (originalConfigure) {
    node.onConfigure = function (...args) {
      const result = originalConfigure.apply(this, args);
      setTimeout(() => refreshDownstreamPipeLabels(node), 0);
      return result;
    };
  }

  const originalConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) {
    const result = originalConnectionsChange?.apply(this, args);
    requestAnimationFrame(() => refreshDownstreamPipeLabels(node));
    return result;
  };
  requestAnimationFrame(() => refreshDownstreamPipeLabels(node));
}

function installDurationControls(node) {
  const duration = node.widgets?.find((item) => item.name === "duration_s");
  const useInitial = node.widgets?.find(
    (item) => item.name === "use_initial_duration",
  );
  if (!useInitial || !duration) return;
  const updateDisabled = () => {
    duration.disabled = Boolean(useInitial.value);
    node.graph?.setDirtyCanvas(true, true);
  };
  if (!useInitial.__elvaxDurationToggleInstalled) {
    useInitial.__elvaxDurationToggleInstalled = true;
    const originalCallback = useInitial.callback;
    useInitial.callback = function (...args) {
      const result = originalCallback?.apply(this, args);
      updateDisabled();
      return result;
    };
  }
  updateDisabled();
}

function finishLayout(node) {
  const size = node.computeSize();
  const currentWidth = node.size?.[0] || 0;
  size[0] = node.__elvaxDynamicPipeFresh
    ? PIPE_DEFAULT_WIDTH
    : currentWidth || Math.max(PIPE_DEFAULT_WIDTH, size[0]);
  node.__elvaxDynamicPipeFresh = false;
  node.setSize(size);
  node.graph?.setDirtyCanvas(true, true);
}

function syncPipeIn(node) {
  node.inputs ??= [];
  // Keep connected sockets plus one trailing free socket. This also cleans
  // up excess auto-grown sockets after users disconnect values.
  for (let index = node.inputs.length - 1; index >= 0; index--) {
    if (node.inputs[index].link == null) node.removeInput(index);
  }
  node.inputs.forEach((input, index) => {
    input.name = `value_${index + 1}`;
  });
  if (node.inputs.length < MAX_PIPE_SLOTS) {
    node.addInput(`value_${node.inputs.length + 1}`, "*");
  }
  const labels = uniqueLabels(node.inputs.map((input) =>
    connectedValueLabel(node, input, input.name),
  ));
  node.inputs.forEach((input, index) => {
    const { output } = connectedOutput(node, input);
    input.label = labels[index];
    input.type = output?.type || "*";
  });
  const last = node.inputs.at(-1);
  if ((!last || last.link != null) && node.inputs.length < MAX_PIPE_SLOTS) {
    node.addInput(`value_${node.inputs.length + 1}`, "*");
  }
  finishLayout(node);
  const links = node.outputs?.[0]?.links || [];
  for (const linkId of links) {
    const link = node.graph?.links?.[linkId];
    const target = link && node.graph.getNodeById(link.target_id);
    if (isNode(target, PIPE_OUT)) syncPipeOut(target);
  }
}

function pipeSource(node) {
  const pipeInput = node.inputs?.find((input) => input.name === "pipe");
  if (!pipeInput || pipeInput.link == null) return null;
  const link = node.graph?.links?.[pipeInput.link];
  const origin = link && node.graph.getNodeById(link.origin_id);
  return isNode(origin, PIPE_IN) ? origin : null;
}

function syncPipeOut(node) {
  const source = pipeSource(node);
  const entries = source?.inputs?.filter((input) => input.link != null) ?? [];
  while (node.outputs.length > entries.length) {
    const last = node.outputs.at(-1);
    if (last.links?.length) break;
    node.removeOutput(node.outputs.length - 1);
  }
  while (node.outputs.length < entries.length) {
    node.addOutput(`value_${node.outputs.length + 1}`, "*");
  }
  const labels = uniqueLabels(entries.map((input, index) =>
    connectedValueLabel(source, input, node.outputs[index].name),
  ));
  entries.forEach((input, index) => {
    const { output } = connectedOutput(source, input);
    node.outputs[index].label = labels[index];
    node.outputs[index].type = output?.type || "*";
  });
  // Keep unused output slots harmless but invisible in meaning; do not remove
  // them automatically because deleting a connected slot would break a saved
  // workflow.
  for (let index = entries.length; index < node.outputs.length; index++) {
    node.outputs[index].label = node.outputs[index].name;
    node.outputs[index].type = "*";
  }
  finishLayout(node);
}

function installDynamicPipe(node) {
  if (node.__elvaxDynamicPipeInstalled) return;
  node.__elvaxDynamicPipeInstalled = true;
  const original = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) {
    const result = original?.apply(this, args);
    requestAnimationFrame(() => {
      if (isNode(node, PIPE_IN)) syncPipeIn(node);
      if (isNode(node, PIPE_OUT)) syncPipeOut(node);
    });
    return result;
  };
  requestAnimationFrame(() => {
    if (isNode(node, PIPE_IN)) syncPipeIn(node);
    if (isNode(node, PIPE_OUT)) syncPipeOut(node);
  });
}

function moveInputBefore(items, name, beforeName) {
  const current = items.findIndex(([itemName]) => itemName === name);
  const target = items.findIndex(([itemName]) => itemName === beforeName);
  if (current < 0 || target < 0 || current === target - 1) return items;
  const [item] = items.splice(current, 1);
  items.splice(items.findIndex(([itemName]) => itemName === beforeName), 0, item);
  return items;
}

function moveOptionalInputBefore(nodeData, name, beforeName) {
  const optional = nodeData.input?.optional;
  const required = nodeData.input?.required;
  if (!optional?.[name] || !required) return;

  const spec = optional[name];
  delete optional[name];
  const requiredEntries = Object.entries(required);
  requiredEntries.splice(
    Math.max(0, requiredEntries.findIndex(([inputName]) => inputName === beforeName)),
    0,
    [name, spec],
  );
  nodeData.input.required = Object.fromEntries(requiredEntries);

  const inputOrder = nodeData.input_order ??= {};
  inputOrder.optional = (inputOrder.optional ?? []).filter((inputName) => inputName !== name);
  const requiredOrder = (inputOrder.required ?? Object.keys(required)).filter(
    (inputName) => inputName !== name,
  );
  const targetIndex = requiredOrder.indexOf(beforeName);
  requiredOrder.splice(targetIndex < 0 ? 0 : targetIndex, 0, name);
  inputOrder.required = requiredOrder;
}

function moveRequiredInputBefore(nodeData, name, beforeName) {
  const required = nodeData.input?.required;
  if (!required?.[name] || !required?.[beforeName]) return;

  nodeData.input.required = Object.fromEntries(
    moveInputBefore(Object.entries(required), name, beforeName),
  );
  const inputOrder = nodeData.input_order ??= {};
  inputOrder.required = moveInputBefore(
    (inputOrder.required ?? Object.keys(required)).map((inputName) => [inputName]),
    name,
    beforeName,
  ).map(([inputName]) => inputName);
}

function setPreviousLatentSocketShape(node) {
  const input = node.inputs?.find((item) => item.name === "previous_latent");
  if (input && input.shape !== HOLLOW_CIRCLE_SHAPE) {
    input.shape = HOLLOW_CIRCLE_SHAPE;
    node.graph?.setDirtyCanvas(true, true);
  }
}

function syncSamplerLinkSlots(node, configuredInputs) {
  const links = node.graph?.links;
  if (!links || node.id == null || !configuredInputs?.size) return;

  const entries = links instanceof Map ? links.values() : Object.values(links);
  const linksById = new Map();
  for (const link of entries) {
    if (link?.id != null) linksById.set(String(link.id), link);
  }

  const repairs = [...configuredInputs].flatMap(([linkId, inputName]) => {
    const link = linksById.get(linkId);
    const targetSlot = node.inputs?.findIndex((input) => input.name === inputName) ?? -1;
    return link && String(link.target_id) === String(node.id) && targetSlot >= 0
      ? [{ link, linkId, targetSlot }]
      : [];
  });
  if (!repairs.length) return;

  const repairedIds = new Set(repairs.map(({ linkId }) => linkId));
  let changed = false;
  for (const input of node.inputs ?? []) {
    if (input.link != null && repairedIds.has(String(input.link))) {
      input.link = null;
      changed = true;
    }
  }
  for (const { link, linkId, targetSlot } of repairs) {
    const input = node.inputs[targetSlot];
    if (link.target_slot !== targetSlot || input.link !== link.id) changed = true;
    link.target_slot = targetSlot;
    input.link = link.id ?? linkId;
  }
  if (changed) node.graph.setDirtyCanvas(true, true);
}

function installTransitionModeTooltip(node) {
  const widget = node.widgets?.find((item) => item.name === "transition_mode");
  if (!widget || widget.__elvaxTransitionTooltipInstalled) return;

  widget.label = "transition_mode";
  widget.__elvaxTransitionTooltipInstalled = true;
  const videoContext = node.widgets?.find(
    (item) => item.name === "video_context_length",
  );
  const audioContext = node.widgets?.find(
    (item) => item.name === "audio_context_length",
  );
  const updateTooltip = () => {
    const isCustomExtensionSampler =
      node.type === "ElvaxH3ExtensionSampler" ||
      node.comfyClass === "ElvaxH3ExtensionSampler";
    const previousLatent = node.inputs?.find(
      (input) => input.name === "previous_latent",
    );
    const waitingForPreviousLatent =
      isCustomExtensionSampler && previousLatent?.link == null;
    widget.disabled = waitingForPreviousLatent;
    widget.tooltip = waitingForPreviousLatent
      ? "Connect previous_latent to enable transition_mode."
      : TRANSITION_MODE_TOOLTIPS[widget.value]
        || "Choose how this H3 stage relates to the preceding stage.";
    const contextDisabled =
      (isCustomExtensionSampler && waitingForPreviousLatent)
      || widget.value === "hard cut";
    if (videoContext) {
      videoContext.disabled = contextDisabled;
    }
    if (audioContext) {
      audioContext.disabled = contextDisabled;
    }
    node.graph?.setDirtyCanvas(true, true);
  };
  if (!node.__elvaxTransitionConnectionHookInstalled) {
    node.__elvaxTransitionConnectionHookInstalled = true;
    const originalConnectionsChange = node.onConnectionsChange;
    node.onConnectionsChange = function (...args) {
      const result = originalConnectionsChange?.apply(this, args);
      requestAnimationFrame(updateTooltip);
      return result;
    };
  }
  const originalCallback = widget.callback;
  widget.callback = function (...args) {
    const result = originalCallback?.apply(this, args);
    updateTooltip();
    return result;
  };
  updateTooltip();
}

app.registerExtension({
  name: "elvax.dynamic-pipes-and-sampler-layout",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (SAMPLER_NODE_TYPES.has(nodeData.name)) {
      const firstRequired = Object.keys(nodeData.input?.required ?? {})[0];
      moveOptionalInputBefore(nodeData, "previous_latent", firstRequired);
      if (nodeData.name === "ElvaxH3ExtensionSampler") {
        moveRequiredInputBefore(nodeData, "model", "conditioning");
        moveRequiredInputBefore(nodeData, "transition_mode", "video_context_length");
      }
      return;
    }
    if (nodeData.name !== PIPE_IN && nodeData.name !== PIPE_OUT) return;
    const originalCreated = nodeType.prototype.onNodeCreated;
    const originalConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalCreated?.apply(this, args);
      this.__elvaxDynamicPipeFresh = true;
      requestAnimationFrame(() => installDynamicPipe(this));
      return result;
    };
    nodeType.prototype.onConfigure = function (...args) {
      const result = originalConfigure?.apply(this, args);
      this.__elvaxDynamicPipeFresh = false;
      requestAnimationFrame(() => {
        installDynamicPipe(this);
        if (isNode(this, PIPE_IN)) syncPipeIn(this);
        if (isNode(this, PIPE_OUT)) syncPipeOut(this);
      });
      return result;
    };
  },
  nodeCreated(node) {
    if (isRerouteNode(node)) {
      installRerouteLabelSync(node);
      return;
    }

    if (node.type === "GetNode" || node.comfyClass === "GetNode") {
      installGetNodeLabelSync(node);
      return;
    }

    if (isNode(node, "ElvaxH3StageSettings")) {
      if (!node.__elvaxStageSettingsConfigureHook) {
        node.__elvaxStageSettingsConfigureHook = true;
        const originalConfigure = node.onConfigure;
        node.onConfigure = function (...args) {
          const result = originalConfigure?.apply(this, args);
          requestAnimationFrame(() => installTransitionModeTooltip(this));
          return result;
        };
      }
      requestAnimationFrame(() => installTransitionModeTooltip(node));
      return;
    }

    const isPreviewSampler =
      node.type === "ElvaxH3SamplerPreview" ||
      node.comfyClass === "ElvaxH3SamplerPreview" ||
      node.type === "ElvaxH3SamplerPreviewV2" ||
      node.comfyClass === "ElvaxH3SamplerPreviewV2";
    const isSampler =
      node.type === "ElvaxH3ExtensionSampler" ||
      node.comfyClass === "ElvaxH3ExtensionSampler" ||
      isPreviewSampler;
    if (!isSampler) return;

    if (!node.__elvaxSamplerConfigureHook) {
      node.__elvaxSamplerConfigureHook = true;
      const originalConfigure = node.onConfigure;
      node.onConfigure = function (...args) {
        const configuredInputs = new Map(
          (args[0]?.inputs ?? [])
            .filter((input) => input.link != null)
            .map((input) => [String(input.link), input.name]),
        );
        const result = originalConfigure?.apply(this, args);
        requestAnimationFrame(() => {
          syncSamplerLinkSlots(this, configuredInputs);
          setPreviousLatentSocketShape(this);
          installTransitionModeTooltip(this);
          installDurationControls(this);
        });
        return result;
      };
    }

    requestAnimationFrame(() => {
      setPreviousLatentSocketShape(node);
      installTransitionModeTooltip(node);
      installDurationControls(node);
    });
  },
});
