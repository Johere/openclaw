import { definePluginEntry } from "./api.js";
import { DIAGRAM_TO_VISIO_AGENT_GUIDANCE } from "./src/prompt-guidance.js";
import { createDiagramToVisioTool } from "./src/tool.js";

export default definePluginEntry({
	id: "diagram-to-visio",
	name: "Diagram to Visio",
	description: "Convert diagram images to editable Visio (.vsdx) files.",
	register(api) {
		const tool = createDiagramToVisioTool({
			async describeImage(params) {
				// Use the plugin API's media understanding capability
				const result = await api.describeImage({
					image: params.imageBuffer,
					mime: params.mime,
					prompt: params.prompt,
					maxTokens: params.maxTokens,
				});
				return result.text;
			},
		});

		api.registerTool(
			() => ({
				name: tool.name,
				description: tool.description,
				schema: tool.schema,
				execute: tool.execute,
			}),
			{ name: tool.name },
		);

		api.on("before_prompt_build", async () => ({
			prependSystemContext: DIAGRAM_TO_VISIO_AGENT_GUIDANCE,
		}));
	},
});
