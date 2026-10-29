import { app } from "/scripts/app.js";

app.registerExtension({
    name: "elvax.turbo-encoding-speed",
    nodeCreated(node) {
        if (node.comfyClass !== "ElvaxPostProcessing") return;
        const widget = node.widgets?.find(item => item.name === "encoding_speed");
        if (!widget || !node.drawWidgets) return;
        const drawWidgets = node.drawWidgets;
        node.drawWidgets = function (ctx, ...args) {
            const value = widget.value;
            const shortValue = typeof value === "string" ? value.split(" - ")[0] : value;
            const fillText = ctx.fillText;
            const measureText = ctx.measureText;
            ctx.fillText = function (text, ...rest) {
                return fillText.call(this, text === value ? shortValue : text, ...rest);
            };
            ctx.measureText = function (text) {
                return measureText.call(this, text === value ? shortValue : text);
            };
            try {
                return drawWidgets.call(this, ctx, ...args);
            } finally {
                ctx.fillText = fillText;
                ctx.measureText = measureText;
            }
        };
    },
    beforeConfigureGraph(graph) {
        for (const node of graph.nodes ?? []) {
            if (node.type === "ElvaxPostProcessing" && node.widgets_values?.length === 14) {
                node.widgets_values.splice(12, 0, "Ultrafast - Fastest, largest file");
            }
        }
    },
});
