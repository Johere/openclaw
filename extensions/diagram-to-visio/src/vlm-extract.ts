import type { DiagramRepresentation, DiagramType } from "./types.js";
import { buildExtractionPrompt, buildRetryPrompt } from "./vlm-prompts.js";

export interface VlmExtractDeps {
	/** Describe an image using a VLM. Returns the text response. */
	describeImage: (params: {
		imageBuffer: Buffer;
		mime: string;
		prompt: string;
		maxTokens?: number;
	}) => Promise<string>;
}

export interface ExtractOptions {
	imageBuffer: Buffer;
	mime: string;
	diagramTypeHint?: DiagramType | "auto";
}

/**
 * Extract a DiagramRepresentation from a diagram image via VLM.
 * Performs one extraction pass + programmatic validation.
 * Retries once if JSON parsing fails.
 */
export async function extractDiagram(
	deps: VlmExtractDeps,
	options: ExtractOptions,
): Promise<DiagramRepresentation> {
	const prompt = buildExtractionPrompt(options.diagramTypeHint);

	const response = await deps.describeImage({
		imageBuffer: options.imageBuffer,
		mime: options.mime,
		prompt,
		maxTokens: 4096,
	});

	const firstAttempt = tryParseResponse(response);
	if (firstAttempt.ok) {
		return validateAndRepair(firstAttempt.value);
	}

	// Retry once with error feedback.
	const retryPrompt = buildRetryPrompt(firstAttempt.error);
	const retryResponse = await deps.describeImage({
		imageBuffer: options.imageBuffer,
		mime: options.mime,
		prompt: `${prompt}\n\n${retryPrompt}`,
		maxTokens: 4096,
	});

	const secondAttempt = tryParseResponse(retryResponse);
	if (secondAttempt.ok) {
		return validateAndRepair(secondAttempt.value);
	}

	throw new Error(`Failed to extract diagram structure from image: ${secondAttempt.error}`);
}

type ParseResult =
	| { ok: true; value: DiagramRepresentation }
	| { ok: false; error: string };

/** Try to parse the VLM response as JSON. Handles optional code fences. */
function tryParseResponse(response: string): ParseResult {
	let text = response.trim();

	// Strip markdown code fences if present
	const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
	if (fenceMatch) {
		text = fenceMatch[1].trim();
	}

	try {
		const parsed = JSON.parse(text) as DiagramRepresentation;
		if (!parsed.shapes || !Array.isArray(parsed.shapes)) {
			return { ok: false, error: "Response missing 'shapes' array" };
		}
		if (!parsed.connections || !Array.isArray(parsed.connections)) {
			return { ok: false, error: "Response missing 'connections' array" };
		}
		return { ok: true, value: parsed };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: msg };
	}
}

/** Validate and repair common VLM mistakes in the extracted diagram. */
function validateAndRepair(diagram: DiagramRepresentation): DiagramRepresentation {
	// Ensure diagramType has a valid value
	const validTypes = new Set(["flowchart", "architecture", "sequence", "org-chart", "generic"]);
	if (!validTypes.has(diagram.diagramType)) {
		diagram.diagramType = "generic";
	}

	// Collect valid shape IDs
	const shapeIds = new Set<string>();
	for (const shape of diagram.shapes) {
		shapeIds.add(shape.id);

		// Default grid positions
		if (typeof shape.row !== "number" || shape.row < 0) {
			shape.row = 0;
		}
		if (typeof shape.column !== "number" || shape.column < 0) {
			shape.column = 0;
		}

		// Default type
		const validTypes = new Set([
			"rectangle", "rounded-rectangle", "circle", "ellipse",
			"diamond", "hexagon", "cylinder", "parallelogram",
			"cloud", "document", "generic",
		]);
		if (!validTypes.has(shape.type)) {
			shape.type = "generic";
		}
	}

	// Remove connections referencing invalid shape IDs
	diagram.connections = diagram.connections.filter(
		(conn) => shapeIds.has(conn.from.shapeId) && shapeIds.has(conn.to.shapeId),
	);

	// Validate groups
	if (diagram.groups) {
		for (const group of diagram.groups) {
			group.shapeIds = group.shapeIds.filter((id) => shapeIds.has(id));
		}
		diagram.groups = diagram.groups.filter((g) => g.shapeIds.length > 0);
	}

	return diagram;
}
