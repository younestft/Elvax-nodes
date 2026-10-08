import { app } from "/scripts/app.js";

const STAGE_SEED = "ElvaxStageSeed";
const CHAIN_SEED = "ElvaxChainSeed";
const MAX_SEED = 1125899906842624;

function stageSeeds() {
  return (app.graph?._nodes || []).filter((node) => node.comfyClass === STAGE_SEED);
}

function seedWidget(node) {
  return node.widgets?.find((widget) => widget.name === "seed");
}

function stageModeWidget(node) {
  return node.widgets?.find((widget) => widget.name === "mode");
}

function chainModeWidget(node) {
  return node.widgets?.find((widget) => widget.name === "mode");
}

function refreshNode(node) {
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
}

function setBooleanValue(node, widget, value) {
  if (!widget) return;
  const changed = widget.value !== value;
  widget.value = value;
  if (changed) widget.callback?.call(widget, value, app.canvas, node);
  refreshNode(node);
}

function distinctSeeds(nodes, reserved = new Set()) {
  const used = new Set(reserved);
  return nodes.map(() => {
    let seed;
    do {
      seed = Math.floor(Math.random() * (MAX_SEED + 1));
    } while (used.has(seed));
    used.add(seed);
    return seed;
  });
}

function setRandomize(nodes, enabled) {
  nodes.forEach((node) => {
    setBooleanValue(node, stageModeWidget(node), enabled);
  });
}

function assignSeeds(nodes, fixed) {
  const selected = new Set(nodes);
  const reserved = new Set(stageSeeds()
    .filter((node) => !selected.has(node))
    .map((node) => Number(seedWidget(node)?.value)));
  const seeds = distinctSeeds(nodes, reserved);
  nodes.forEach((node, index) => {
    const widget = seedWidget(node);
    if (!widget) return;
    const control = stageModeWidget(node);
    if (control && fixed) setBooleanValue(node, control, false);
    widget.value = seeds[index];
    refreshNode(node);
  });
}

function setFixedSeed(node) {
  assignSeeds([node], true);
}

function installStageSeed(node) {
  const legacyMode = node.properties?.elvaxSeedMode;
  if (legacyMode === "random" && stageModeWidget(node)) stageModeWidget(node).value = true;
  if (node.properties) delete node.properties.elvaxSeedMode;
  if (node.__elvaxStageSeedInstalled) return;
  node.__elvaxStageSeedInstalled = true;
  node.addWidget("button", "New Fixed", null, () => setFixedSeed(node), { serialize: false });
}

function installChainSeed(node) {
  if (node.__elvaxChainSeedInstalled) return;
  node.__elvaxChainSeedInstalled = true;
  const control = chainModeWidget(node);
  if (control && !control.__elvaxRandomizeAllHook) {
    const originalCallback = control.callback;
    control.callback = function (...args) {
      const enabled = typeof args[0] === "boolean" ? args[0] : control.value === true;
      control.value = enabled;
      setRandomize(stageSeeds(), enabled);
      return originalCallback?.apply(this, args);
    };
    control.__elvaxRandomizeAllHook = true;
  }
  node.addWidget("button", "New Fixed", null, () => {
    const allControl = chainModeWidget(node);
    setBooleanValue(node, allControl, false);
    setRandomize(stageSeeds(), false);
    assignSeeds(stageSeeds(), true);
    refreshNode(node);
  }, { serialize: false });
}

app.registerExtension({
  name: "elvax.seed-nodes",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const install = nodeData.name === STAGE_SEED
      ? installStageSeed
      : nodeData.name === CHAIN_SEED
        ? installChainSeed
        : null;
    if (!install) return;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalCreated?.apply(this, args);
      install(this);
      return result;
    };

    const originalConfigured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      const result = originalConfigured?.apply(this, args);
      install(this);
      return result;
    };
  },
  async setup() {
    const originalGraphToPrompt = app.graphToPrompt;
    if (!originalGraphToPrompt || originalGraphToPrompt.__elvaxSeedHook) return;
    const graphToPrompt = async function (...args) {
      const randomNodes = stageSeeds().filter((node) => stageModeWidget(node)?.value === true);
      if (randomNodes.length) assignSeeds(randomNodes, false);
      return originalGraphToPrompt.apply(this, args);
    };
    graphToPrompt.__elvaxSeedHook = true;
    app.graphToPrompt = graphToPrompt;
  },
});
