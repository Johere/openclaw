import { describe, expect, it } from "vitest";
import type { VlmExtractDeps } from "./vlm-extract.js";
import { extractDiagram } from "./vlm-extract.js";

const validResponse = JSON.stringify({
	diagramType: "flowchart",
	title: "Test",
	shapes: [
		{ id: "s1", type: "rectangle", label: "Start", row: 0, column: 0 },
		{ id: "s2", type: "diamond", label: "Check", row: 1, column: 0 },
	],
	connections: [
		{ id: "c1", from: { shapeId: "s1", port: "bottom" }, to: { shapeId: "s2", port: "top" } },
	],
});

function mockDeps(responses: string[]): VlmExtractDeps {
	let callIndex = 0;
	return {
		async describeImage() {
			return responses[callIndex++] ?? "";
		},
	};
}

describe("extractDiagram", () => {
	it("parses a valid JSON response", async () => {
		const result = await extractDiagram(mockDeps([validResponse]), {
			imageBuffer: Buffer.from("fake"),
			mime: "image/png",
		});
		expect(result.diagramType).toBe("flowchart");
		expect(result.shapes).toHaveLength(2);
		expect(result.connections).toHaveLength(1);
	});

	it("handles JSON wrapped in markdown code fences", async () => {
		const fenced = "```json\n" + validResponse + "\n```";
		const result = await extractDiagram(mockDeps([fenced]), {
			imageBuffer: Buffer.from("fake"),
			mime: "image/png",
		});
		expect(result.shapes).toHaveLength(2);
	});

	it("retries once on invalid JSON, succeeds on second attempt", async () => {
		const result = await extractDiagram(mockDeps(["not json at all", validResponse]), {
			imageBuffer: Buffer.from("fake"),
			mime: "image/png",
		});
		expect(result.shapes).toHaveLength(2);
	});

	it("throws after two failed attempts", async () => {
		await expect(
			extractDiagram(mockDeps(["bad json", "still bad"]), {
				imageBuffer: Buffer.from("fake"),
				mime: "image/png",
			}),
		).rejects.toThrow("Failed to extract diagram structure");
	});

	it("removes connections with invalid shape references", async () => {
		const response = JSON.stringify({
			diagramType: "generic",
			shapes: [{ id: "s1", type: "rectangle", label: "A", row: 0, column: 0 }],
			connections: [
				{ id: "c1", from: { shapeId: "s1" }, to: { shapeId: "s_nonexistent" } },
			],
		});
		const result = await extractDiagram(mockDeps([response]), {
			imageBuffer: Buffer.from("fake"),
			mime: "image/png",
		});
		expect(result.connections).toHaveLength(0);
	});

	it("defaults invalid shape types to generic", async () => {
		const response = JSON.stringify({
			diagramType: "flowchart",
			shapes: [{ id: "s1", type: "trapezoid", label: "A", row: 0, column: 0 }],
			connections: [],
		});
		const result = await extractDiagram(mockDeps([response]), {
			imageBuffer: Buffer.from("fake"),
			mime: "image/png",
		});
		expect(result.shapes[0].type).toBe("generic");
	});

	it("defaults negative grid positions to 0", async () => {
		const response = JSON.stringify({
			diagramType: "generic",
			shapes: [{ id: "s1", type: "rectangle", label: "A", row: -1, column: -2 }],
			connections: [],
		});
		const result = await extractDiagram(mockDeps([response]), {
			imageBuffer: Buffer.from("fake"),
			mime: "image/png",
		});
		expect(result.shapes[0].row).toBe(0);
		expect(result.shapes[0].column).toBe(0);
	});

	it("removes empty groups", async () => {
		const response = JSON.stringify({
			diagramType: "generic",
			shapes: [{ id: "s1", type: "rectangle", label: "A", row: 0, column: 0 }],
			connections: [],
			groups: [{ id: "g1", label: "Empty", shapeIds: ["s_missing"] }],
		});
		const result = await extractDiagram(mockDeps([response]), {
			imageBuffer: Buffer.from("fake"),
			mime: "image/png",
		});
		expect(result.groups).toHaveLength(0);
	});

	it("respects diagramTypeHint", async () => {
		let capturedPrompt = "";
		const deps: VlmExtractDeps = {
			async describeImage(params) {
				capturedPrompt = params.prompt;
				return validResponse;
			},
		};
		await extractDiagram(deps, {
			imageBuffer: Buffer.from("fake"),
			mime: "image/png",
			diagramTypeHint: "architecture",
		});
		expect(capturedPrompt).toContain("architecture");
	});
});
