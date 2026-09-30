import { app } from "/scripts/app.js";

const NODE_TYPE = "ElvaxLLMTurbo";
const INPUT_TOOLTIPS = {
  "images.": "(needs GGUF model with vision support like Qwen or Gemma)",
  "audios.": "(needs GGUF model with audio input support like Gemma4 12b)",
};
const measureContext = document.createElement("canvas").getContext("2d");

function tooltipForInput(name) {
  if (name?.startsWith("images.")) return INPUT_TOOLTIPS["images."];
  if (name?.startsWith("audios.")) return INPUT_TOOLTIPS["audios."];
  return null;
}

function inputLabel(node, input) {
  const label = input.label || input.name?.split(".").at(-1) || "";
  const nodeContext = node.graph?.list_of_graphcanvas?.[0]?.ctx;
  measureContext.font = nodeContext?.font || `${window.LiteGraph?.NODE_TEXT_SIZE || 14}px Arial`;
  return { label, width: measureContext.measureText(label).width };
}

function installInputTooltips(node) {
  if (node.__elvaxLLMTurboTooltipsInstalled) return;
  node.__elvaxLLMTurboTooltipsInstalled = true;

  const tooltip = document.createElement("div");
  tooltip.style.cssText = "position:fixed;z-index:100000;display:none;max-width:320px;padding:7px 10px;border:1px solid #555;border-radius:5px;background:#222;color:#eee;box-shadow:0 2px 8px #0009;font:12px/1.4 sans-serif;pointer-events:none;";
  document.body.append(tooltip);

  let activeInput = null;
  let showTimer = null;
  let lastPointer = null;

  const hideTooltip = () => {
    clearTimeout(showTimer);
    showTimer = null;
    activeInput = null;
    tooltip.style.display = "none";
  };

  const positionTooltip = () => {
    if (!lastPointer || tooltip.style.display === "none") return;
    const left = Math.min(lastPointer.x + 14, window.innerWidth - tooltip.offsetWidth - 8);
    const top = Math.min(lastPointer.y + 16, window.innerHeight - tooltip.offsetHeight - 8);
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  };

  const originalMouseMove = node.onMouseMove;
  node.onMouseMove = function (event, pos, ...args) {
    const result = originalMouseMove?.call(this, event, pos, ...args);
    const slotIndex = this.inputs?.findIndex((input, index) => {
      if (!tooltipForInput(input.name)) return false;
      const connectionPos = this.getConnectionPos(true, index);
      const rowY = connectionPos[1] - this.pos[1];
      const labelStart = connectionPos[0] - this.pos[0] + 10;
      const { width } = inputLabel(this, input);
      return pos?.[0] >= labelStart && pos[0] <= labelStart + width
        && Math.abs(pos[1] - rowY) <= 8;
    }) ?? -1;

    if (slotIndex < 0) {
      hideTooltip();
      return result;
    }

    const input = this.inputs[slotIndex];
    const tooltipText = tooltipForInput(input.name);
    lastPointer = { x: event.clientX, y: event.clientY };

    if (activeInput !== input.name) {
      clearTimeout(showTimer);
      activeInput = input.name;
      tooltip.textContent = tooltipText;
      tooltip.style.display = "none";
      showTimer = setTimeout(() => {
        if (activeInput !== input.name) return;
        tooltip.style.display = "block";
        positionTooltip();
      }, 400);
    } else {
      positionTooltip();
    }
    return result;
  };

  const originalMouseLeave = node.onMouseLeave;
  node.onMouseLeave = function (...args) {
    hideTooltip();
    return originalMouseLeave?.apply(this, args);
  };

  const originalRemoved = node.onRemoved;
  node.onRemoved = function (...args) {
    hideTooltip();
    tooltip.remove();
    return originalRemoved?.apply(this, args);
  };
}

app.registerExtension({
  name: "elvax.llm-turbo-input-tooltips",
  nodeCreated(node) {
    if (node.comfyClass === NODE_TYPE || node.type === NODE_TYPE) {
      installInputTooltips(node);
    }
  },
});
