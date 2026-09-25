import { app } from "/scripts/app.js";

const PIPE_IN = "ElvaxDynamicPipeIn";
const PIPE_OUT = "ElvaxDynamicPipeOut";
const MAX_PIPE_SLOTS = 32;
const PIPE_DEFAULT_WIDTH = 260;
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

function labelFor(output, fallback) {
  return output?.label || output?.name || fallback;
}

function frontendGetName(node) {
  if (node?.type !== "GetNode" && node?.comfyClass !== "GetNode") return null;
  const widget = node.widgets?.find((item) => item.name === "Constant")
    || node.widgets?.[0];
  const value = typeof widget?.value === "string" ? widget.value.trim() : "";
  return value || null;
}

function connectedValueLabel(node, input, fallback) {
  const source = linkedOrigin(node, input);
  return frontendGetName(source) || labelFor(linkedOutput(node, input), fallback);
}

function refreshPipeLabelsFromGetNode(getNode) {
  for (const linkId of getNode.outputs?.[0]?.links || []) {
    const link = getNode.graph?.links?.[linkId];
    const target = link && getNode.graph?.getNodeById(link.target_id);
    if (isNode(target, PIPE_IN)) syncPipeIn(target);
  }
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
      requestAnimationFrame(() => refreshPipeLabelsFromGetNode(node));
      return result;
    };
  }

  const originalRename = node.onRename;
  if (originalRename) {
    node.onRename = function (...args) {
      const result = originalRename.apply(this, args);
      requestAnimationFrame(() => refreshPipeLabelsFromGetNode(node));
      return result;
    };
  }

  const originalConfigure = node.onConfigure;
  if (originalConfigure) {
    node.onConfigure = function (...args) {
      const result = originalConfigure.apply(this, args);
      setTimeout(() => refreshPipeLabelsFromGetNode(node), 0);
      return result;
    };
  }

  const originalConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) {
    const result = originalConnectionsChange?.apply(this, args);
    requestAnimationFrame(() => refreshPipeLabelsFromGetNode(node));
    return result;
  };
  requestAnimationFrame(() => refreshPipeLabelsFromGetNode(node));
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
  // Leave room for the title and keep any extra width chosen by the user.
  size[0] = Math.max(PIPE_DEFAULT_WIDTH, size[0], node.size?.[0] || 0);
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
  for (const input of node.inputs) {
    const output = linkedOutput(node, input);
    input.label = connectedValueLabel(node, input, input.name);
    input.type = output?.type || "*";
  }
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
  entries.forEach((input, index) => {
    const output = linkedOutput(source, input);
    node.outputs[index].label = connectedValueLabel(
      source,
      input,
      node.outputs[index].name,
    );
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

function putInputAt(inputs, name, index) {
  const current = inputs.findIndex((input) => input.name === name);
  if (current < 0 || current === index) return;
  const [input] = inputs.splice(current, 1);
  inputs.splice(index, 0, input);
}

function putInputBefore(inputs, name, beforeName) {
  const current = inputs.findIndex((input) => input.name === name);
  const target = inputs.findIndex((input) => input.name === beforeName);
  if (current < 0 || target < 0 || current === target - 1) return;
  const [input] = inputs.splice(current, 1);
  const targetAfterRemoval = inputs.findIndex((item) => item.name === beforeName);
  inputs.splice(targetAfterRemoval, 0, input);
}

function reorderSamplerInputs(node) {
  if (!Array.isArray(node.inputs)) return;

  const before = node.inputs.slice();
  const ordered = before.slice();
  putInputAt(ordered, "previous_latent", 0);
  putInputAt(ordered, "model", 1);
  putInputBefore(ordered, "transition_mode", "video_context_length");
  if (ordered.every((input, index) => input === before[index])) return;

  // Input objects keep their link ids when moved. Keep the graph's separate
  // target_slot values in sync, preferring those ids to recover links left
  // stale by an earlier version of this reorder.
  const inputByLink = new Map();
  for (const input of before) {
    if (input.link != null) inputByLink.set(String(input.link), input);
  }
  const indexByInput = new Map(ordered.map((input, index) => [input, index]));
  node.inputs.splice(0, node.inputs.length, ...ordered);

  const graphLinks = node.graph?.links;
  const entries = graphLinks instanceof Map
    ? [...graphLinks.entries()]
    : Object.entries(graphLinks ?? {});
  for (const [key, link] of entries) {
    if (String(link?.target_id) !== String(node.id)) continue;
    const input = inputByLink.get(String(link.id ?? key))
      ?? before[link.target_slot];
    const targetSlot = indexByInput.get(input);
    if (targetSlot !== undefined) link.target_slot = targetSlot;
  }
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

// ComfyUI renders required inputs before optional inputs. previous_latent must
// remain optional so generation one can leave it unwired, but visually it is
// the start of every continuation lane.
app.registerExtension({
  name: "elvax.dynamic-pipes-and-sampler-layout",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== PIPE_IN && nodeData.name !== PIPE_OUT) return;
    const originalCreated = nodeType.prototype.onNodeCreated;
    const originalConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalCreated?.apply(this, args);
      requestAnimationFrame(() => installDynamicPipe(this));
      return result;
    };
    nodeType.prototype.onConfigure = function (...args) {
      const result = originalConfigure?.apply(this, args);
      requestAnimationFrame(() => {
        installDynamicPipe(this);
        if (isNode(this, PIPE_IN)) syncPipeIn(this);
        if (isNode(this, PIPE_OUT)) syncPipeOut(this);
      });
      return result;
    };
  },
  nodeCreated(node) {
    if (node.type === "GetNode" || node.comfyClass === "GetNode") {
      installGetNodeLabelSync(node);
      return;
    }

    const isSampler =
      node.type === "ElvaxH3ExtensionSampler" ||
      node.comfyClass === "ElvaxH3ExtensionSampler";
    const isReferenceSampler =
      node.type === "ElvaxH3ExtensionReferenceSampler" ||
      node.comfyClass === "ElvaxH3ExtensionReferenceSampler";
    if (!isSampler && !isReferenceSampler) return;

    if (!node.__elvaxSamplerConfigureHook) {
      node.__elvaxSamplerConfigureHook = true;
      const originalConfigure = node.onConfigure;
      node.onConfigure = function (...args) {
        const result = originalConfigure?.apply(this, args);
        requestAnimationFrame(() => {
          const before = this.inputs?.slice();
          reorderSamplerInputs(this);
          installTransitionModeTooltip(this);
          installDurationControls(this);
          if (before && before.some((input, index) => input !== this.inputs[index])) {
            this.setSize(this.computeSize());
            this.graph?.setDirtyCanvas(true, true);
          }
        });
        return result;
      };
    }

    // Optional sockets are added after nodeCreated in the current frontend.
    // Defer one frame, but only for this exact custom-node instance.
    requestAnimationFrame(() => {
      const before = node.inputs?.slice();
      reorderSamplerInputs(node);
      installTransitionModeTooltip(node);
      installDurationControls(node);
      if (before && before.some((input, index) => input !== node.inputs[index])) {
        node.setSize(node.computeSize());
        node.graph?.setDirtyCanvas(true, true);
      }
    });
  },
});
