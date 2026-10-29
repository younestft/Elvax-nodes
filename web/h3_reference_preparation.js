import { app } from "/scripts/app.js";

app.registerExtension({
  name: "elvax.h3-reference-preparation",
  beforeRegisterVueAppNodeDefs(definitions) {
    const index = definitions.findIndex(definition => definition.name === "ElvaxH3PrepareReferences");
    if (index !== -1) definitions.splice(index, 1);
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === "ElvaxH3PrepareReferences") nodeType.skip_list = true;
    if (nodeData.name === "ElvaxH3StageSettings") {
      delete nodeData.input.optional?.prepared_base;
      delete nodeData.input.optional?.prepared_video;
      if (nodeData.input_order?.optional) {
        nodeData.input_order.optional = nodeData.input_order.optional.filter(
          name => name !== "prepared_base" && name !== "prepared_video",
        );
      }
    }
  },
});
