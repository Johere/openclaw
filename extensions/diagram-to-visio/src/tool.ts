import { Type } from "@sinclair/typebox";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { DiagramType } from "./types.js";
import { extractDiagram } from "./vlm-extract.js";
import { buildVsdx } from "./vsdx/vsdx-builder.js";

export const diagramToVisioToolSchema = Type.Object(
	{
		image_path: Type.String({
			description: "Path to the diagram image file (PNG/JPG/WebP) or URL.",
		}),
		diagram_type: Type.Optional(
			Type.Unsafe<string>({
				type: "string",
				enum: ["flowchart", "architecture", "sequence", "org-chart", "auto"],
				description: "Hint for diagram type. Default: auto-detect.",
			}),
		),
		output_path: Type.Optional(
			Type.String({
				description: "Output path for the .vsdx file. Defaults to a temp directory.",
			}),
		),
	},
	{ additionalProperties: false },
);

export interface DiagramToVisioToolDeps {
	/** Describe an image using a VLM. Returns the text response. */
	describeImage: (params: {
		imageBuffer: Buffer;
		mime: string;
		prompt: string;
		maxTokens?: number;
	}) => Promise<string>;
}

interface ToolInput {
	image_path: string;
	diagram_type?: string;
	output_path?: string;
}

interface ToolResult {
	filePath: string;
	diagramType: string;
	shapeCount: number;
	connectionCount: number;
}

/** Infer MIME type from file extension. */
function inferMime(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".png")) {
		return "image/png";
	}
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
		return "image/jpeg";
	}
	if (lower.endsWith(".webp")) {
		return "image/webp";
	}
	if (lower.endsWith(".gif")) {
		return "image/gif";
	}
	return "image/png";
}

export function createDiagramToVisioTool(deps: DiagramToVisioToolDeps) {
	return {
		name: "diagram_to_visio",
		description:
			"Convert a diagram image (architecture diagram, flowchart, org chart, etc.) into an editable Visio (.vsdx) file.",
		schema: diagramToVisioToolSchema,
		async execute(input: ToolInput): Promise<ToolResult> {
			// Read the image
			const imageBuffer = await readFile(input.image_path);
			const mime = inferMime(input.image_path);

			// Extract diagram structure via VLM
			const diagram = await extractDiagram(deps, {
				imageBuffer,
				mime,
				diagramTypeHint: (input.diagram_type as DiagramType | "auto") ?? "auto",
			});

			// Build .vsdx
			const vsdxBuffer = await buildVsdx(diagram);

			// Write output
			const outputPath =
				input.output_path ?? join(tmpdir(), `diagram-${Date.now()}.vsdx`);
			await writeFile(outputPath, vsdxBuffer);

			return {
				filePath: outputPath,
				diagramType: diagram.diagramType,
				shapeCount: diagram.shapes.length,
				connectionCount: diagram.connections.length,
			};
		},
	};
}
