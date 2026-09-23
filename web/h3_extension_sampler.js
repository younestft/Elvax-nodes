import { app } from "/scripts/app.js";

const PIPE_IN = "ElvaxDynamicPipeIn";
const PIPE_OUT = "ElvaxDynamicPipeOut";
const MAX_PIPE_SLOTS = 32;
const PIPE_DEFAULT_WIDTH = 260;

function isNode(node, type) {
  return node?.type === type || node?.comfyClass === type;
}

function linkedOutput(node, input) {
  if (input.link == null) return null;
  const link = node.graph?.links?.[input.link];
  const origin = link && node.graph.getNodeById(link.origin_id);
  return origin?.outputs?.[link.origin_slot] ?? null;
}

function labelFor(output, fallback) {
  return output?.label || output?.name || fallback;
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
  for (const input of node.inputs) {
    const output = linkedOutput(node, input);
    input.label = labelFor(output, input.name);
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
    node.outputs[index].label = labelFor(output, node.outputs[index].name);
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
    if (
      node.type !== "ElvaxH3ExtensionSampler" &&
      node.comfyClass !== "ElvaxH3ExtensionSampler"
    ) return;

    // Optional sockets are added after nodeCreated in the current frontend.
    // Defer one frame, but only for this exact custom-node instance.
    requestAnimationFrame(() => {
      const previousIndex = node.inputs?.findIndex(
        (input) => input.name === "previous_latent",
      );
      if (previousIndex > 0) {
        const [previousLatent] = node.inputs.splice(previousIndex, 1);
        node.inputs.unshift(previousLatent);
      }
      const modelIndex = node.inputs?.findIndex(
        (input) => input.name === "model",
      );
      if (modelIndex > 1) {
        const [model] = node.inputs.splice(modelIndex, 1);
        node.inputs.splice(1, 0, model);
      }
      if (previousIndex > 0 || modelIndex > 1) {
        node.setSize(node.computeSize());
        node.graph?.setDirtyCanvas(true, true);
      }
    });
  },
});
