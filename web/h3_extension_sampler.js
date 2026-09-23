import { app } from "/scripts/app.js";

// ComfyUI renders required inputs before optional inputs. previous_latent must
// remain optional so generation one can leave it unwired, but visually it is
// the start of every continuation lane.
app.registerExtension({
  name: "h3-extension-bridge.sampler-input-order",
  nodeCreated(node) {
    if (
      node.type !== "ElvaxH3ExtensionSampler" &&
      node.comfyClass !== "ElvaxH3ExtensionSampler"
    ) return;

    // Optional sockets are added after nodeCreated in the current frontend.
    // Defer one frame, but only for this exact custom-node instance.
    requestAnimationFrame(() => {
      const index = node.inputs?.findIndex(
        (input) => input.name === "previous_latent",
      );
      if (index > 0) {
        const [previousLatent] = node.inputs.splice(index, 1);
        node.inputs.unshift(previousLatent);
        node.setSize(node.computeSize());
      }
    });
  },
});

