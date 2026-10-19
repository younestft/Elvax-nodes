import { app } from "/scripts/app.js";

const NODE_TYPE = "ElvaxJSONPromptSplitter";
const BUILDER_TYPE = "ElvaxPromptTemplateBuilder";
const MAX_PROMPTS = 32;
const MIN_HEIGHT = 130;
const SLOT_HEIGHT = 22;
const BYPASS_TOOLTIP = "Automatically bypasses unused stage groups or enables them based on video count.";
let configuringGraph = false;

function isNode(node, type) {
  return node?.type === type || node?.comfyClass === type;
}

function widgetValue(node, name) {
  return node?.widgets?.find((widget) => widget.name === name)?.value;
}

function linkSource(node, input) {
  if (input?.link == null) return null;
  const link = node.graph?.links?.[input.link];
  return link ? node.graph?.getNodeById(link.origin_id) : null;
}

function setName(node) {
  return String(widgetValue(node, "Constant") ?? "").trim();
}

function builderForSource(node, visited = new Set()) {
  if (!node || visited.has(node)) return null;
  visited.add(node);
  if (isNode(node, BUILDER_TYPE)) return node;

  if (node.type === "Reroute" || node.comfyClass === "Reroute") {
    return builderForSource(node.graph?.getNodeById(node.graph?.links?.[node.inputs?.[0]?.link]?.origin_id), visited);
  }

  if (node.type === "GetNode" || node.comfyClass === "GetNode") {
    const name = setName(node);
    const setter = (node.graph?._nodes || []).find((candidate) =>
      (candidate.type === "SetNode" || candidate.comfyClass === "SetNode") && setName(candidate) === name,
    );
    return builderForSource(linkSource(setter, setter?.inputs?.[0]), visited);
  }
  return null;
}

function sourceVideoCount(node) {
  const input = node.inputs?.find((item) => item.name === "json_string");
  const linkedBuilder = builderForSource(linkSource(node, input));
  const builders = (node.graph?._nodes || []).filter((candidate) => isNode(candidate, BUILDER_TYPE));
  const builder = linkedBuilder || (builders.length === 1 ? builders[0] : null);
  const raw = widgetValue(builder, "video_count");
  if (raw == null || String(raw).trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? Math.min(MAX_PROMPTS, value) : null;
}

function requiredHeight(node) {
  return Math.max(MIN_HEIGHT, node.computeSize()[1], 40 + Math.max(node.inputs?.length || 0, node.outputs?.length || 0) * SLOT_HEIGHT);
}

function splitters(graph = app.graph, found = [], visited = new Set()) {
  if (!graph || visited.has(graph)) return found;
  visited.add(graph);
  for (const node of graph._nodes) {
    if (isNode(node, NODE_TYPE)) found.push(node);
    if (node.isSubgraphNode?.()) splitters(node.subgraph, found, visited);
  }
  return found;
}

function restoreStageModes(node, keep = new Set()) {
  const modes = node.properties.elvaxStageModes;
  if (!modes || !node.graph) return;
  for (const [id, mode] of Object.entries(modes)) {
    if (keep.has(id)) continue;
    const target = node.graph.getNodeById(id);
    if (target?.mode === 4) target.mode = mode;
    delete modes[id];
  }
  if (!Object.keys(modes).length) delete node.properties.elvaxStageModes;
}

function syncStageGroups(node, count) {
  if (!node.properties.bypass_unused_stages || node.mode !== 0) {
    restoreStageModes(node);
    return;
  }
  if (count === null) return;

  for (const target of node.graph._nodes) target.updateArea();
  const bypass = new Set();
  const active = new Set();
  const assignments = node.properties.elvaxStageGroups || [];
  assignments.forEach((id, index) => {
    if (id == null) return;
    const group = node.graph._groups.find((group) => group.id === id);
    if (!group) return;
    group.recomputeInsideNodes();
    for (const target of group.nodes) {
      if (target === node) continue;
      (index < count ? active : bypass).add(String(target.id));
    }
  });
  for (const id of active) bypass.delete(id);
  restoreStageModes(node, bypass);
  for (const id of bypass) {
    const target = node.graph.getNodeById(id);
    if (target.mode === 4) continue;
    node.properties.elvaxStageModes ||= {};
    node.properties.elvaxStageModes[id] ??= target.mode;
    target.mode = 4;
  }
}

function syncStageAssignments(node) {
  const enabled = node.properties.bypass_unused_stages === true;
  node.__elvaxStageToggle.value = enabled;
  if (!enabled) return;
  if (!Array.isArray(node.properties.elvaxStageGroups)) node.properties.elvaxStageGroups = [];
  const assignments = node.properties.elvaxStageGroups;
  for (const group of node.graph._groups) {
    const match = /^stage[\s_-]*(\d+)$/i.exec(group.title.trim());
    if (!match) continue;
    const stage = Number(match[1]);
    if (stage < 1 || stage > MAX_PROMPTS) continue;
    const assigned = assignments[stage - 1];
    if (!assignments.includes(group.id) && !node.graph._groups.some(group => group.id === assigned)) {
      assignments[stage - 1] = group.id;
    }
  }
}

function syncOutputs(node) {
  if (!node.graph || configuringGraph) return;
  const previousOutputCount = node.outputs.length;
  const count = sourceVideoCount(node);
  if (count !== null || !node.__elvaxJSONPromptSplitterConfigured) {
    const outputCount = count ?? 0;
    while (node.outputs.length > outputCount) {
      if (node.outputs.at(-1)?.links?.length) break;
      node.removeOutput(node.outputs.length - 1);
    }
    while (node.outputs.length < outputCount) {
      node.addOutput(`prompt_${node.outputs.length + 1}`, "STRING");
    }
  }
  node.outputs.forEach((output, index) => {
    const name = `prompt_${index + 1}`;
    output.name = name;
    output.label = name;
  });
  if (node.outputs.length > previousOutputCount) {
    const height = requiredHeight(node);
    if (height > node.size[1]) node.setSize([node.size[0], height]);
  }
  syncStageAssignments(node);
  syncStageGroups(node, count);
  node.graph?.setDirtyCanvas(true, true);
}

function install(node) {
  if (node.__elvaxJSONPromptSplitterInstalled) return;
  node.__elvaxJSONPromptSplitterInstalled = true;
  node.properties.bypass_unused_stages ??= false;
  const toggle = node.addWidget("toggle", "bypass_unused_stages", node.properties.bypass_unused_stages, (value) => {
    node.properties.bypass_unused_stages = value;
    syncOutputs(node);
  }, { serialize: false });
  toggle.tooltip = BYPASS_TOOLTIP;
  node.__elvaxStageToggle = toggle;
  const jsonInput = node.inputs?.find((input) => input.name === "json_string");
  if (jsonInput) jsonInput.label = "JSON";
  const originalNodeConfigure = node.configure;
  node.configure = function (data, ...args) {
    const savedOutputCount = Array.isArray(data.outputs) ? data.outputs.length : null;
    const result = originalNodeConfigure.call(this, data, ...args);
    if (savedOutputCount !== null) {
      while (this.outputs.length > savedOutputCount && !this.outputs.at(-1)?.links?.length) {
        this.removeOutput(this.outputs.length - 1);
      }
    }
    return result;
  };
  const originalConfigure = node.onConfigure;
  node.onConfigure = function (...args) {
    this.__elvaxJSONPromptSplitterConfigured = true;
    const result = originalConfigure?.apply(this, args);
    requestAnimationFrame(() => syncOutputs(this));
    return result;
  };
  const originalRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    restoreStageModes(this);
    return originalRemoved?.apply(this, args);
  };
  const originalConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function (...args) {
    const result = originalConnectionsChange?.apply(this, args);
    requestAnimationFrame(() => syncOutputs(this));
    return result;
  };
  requestAnimationFrame(() => {
    syncOutputs(node);
    if (node.__elvaxJSONPromptSplitterConfigured) return;
    node.setSize([Math.max(330, node.size[0]), requiredHeight(node)]);
  });
}

app.registerExtension({
  name: "elvax.json-prompt-splitter",
  setup() {
    window.setInterval(() => {
      for (const node of splitters()) syncOutputs(node);
    }, 150);
    const originalGraphToPrompt = app.graphToPrompt;
    app.graphToPrompt = function (...args) {
      for (const node of splitters(args[0] || app.graph)) syncOutputs(node);
      return originalGraphToPrompt.apply(this, args);
    };
  },
  beforeConfigureGraph() {
    configuringGraph = true;
  },
  afterConfigureGraph() {
    configuringGraph = false;
    for (const node of splitters()) syncOutputs(node);
  },
  nodeCreated(node) {
    if (isNode(node, NODE_TYPE)) install(node);
  },
  loadedGraphNode(node) {
    if (!isNode(node, NODE_TYPE)) return;
    node.__elvaxJSONPromptSplitterConfigured = true;
    install(node);
    requestAnimationFrame(() => {
      syncOutputs(node);
      node.setSize([node.size[0], requiredHeight(node)]);
    });
  },
});
