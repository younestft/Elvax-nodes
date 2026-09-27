import { app } from "/scripts/app.js";

function isLlmTurboComboMenu(values) {
  const node = app.canvas?.current_node;
  if (node?.type !== "ElvaxLLMTurbo" && node?.comfyClass !== "ElvaxLLMTurbo") {
    return false;
  }
  return ["model", "mmproj", "mtp_model"].some((name) => {
    const choices = node.widgets?.find((widget) => widget.name === name)?.options?.values;
    return Array.isArray(choices)
      && choices.length === values?.length
      && choices.every((value, index) => value === values[index]);
  });
}

app.registerExtension({
  name: "Elvax.LLMTurboModelSearch",
  init() {
    const OriginalContextMenu = globalThis.LiteGraph?.ContextMenu;
    if (!OriginalContextMenu || OriginalContextMenu.__elvaxModelSearch) return;

    function FilteredContextMenu(values, options) {
      const menu = new OriginalContextMenu(values, options);
      if (!isLlmTurboComboMenu(values)
          || menu.root.querySelector(".comfy-context-menu-filter")) {
        return menu;
      }

      const filter = document.createElement("input");
      filter.classList.add("comfy-context-menu-filter");
      filter.placeholder = "Filter list";
      const entries = Array.from(menu.root.querySelectorAll(".litemenu-entry"));
      menu.root.prepend(filter);
      filter.addEventListener("input", () => {
        const query = filter.value.toLocaleLowerCase();
        for (const entry of entries) {
          entry.style.display = !query
            || entry.textContent?.toLocaleLowerCase().includes(query)
            ? "block"
            : "none";
        }
      });
      requestAnimationFrame(() => filter.focus());
      return menu;
    }

    FilteredContextMenu.prototype = OriginalContextMenu.prototype;
    FilteredContextMenu.__elvaxModelSearch = true;
    globalThis.LiteGraph.ContextMenu = FilteredContextMenu;
  },
});
