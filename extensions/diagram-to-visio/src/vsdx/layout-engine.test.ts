import { describe, expect, it } from "vitest";
import type { DiagramRepresentation } from "../types.js";
import { computeLayout } from "./layout-engine.js";

function makeDiagram(overrides: Partial<DiagramRepresentation> = {}): DiagramRepresentation {
	return {
		diagramType: "generic",
		shapes: [],
		connections: [],
		...overrides,
	};
}

describe("computeLayout", () => {
	it("returns minimum page dimensions for empty diagram", () => {
		const layout = computeLayout(makeDiagram());
		expect(layout.pageWidth).toBeGreaterThanOrEqual(11);
		expect(layout.pageHeight).toBeGreaterThanOrEqual(8.5);
		expect(layout.shapes).toHaveLength(0);
		expect(layout.connectors).toHaveLength(0);
	});

	it("places a single shape at row 0, col 0", () => {
		const layout = computeLayout(
			makeDiagram({
				shapes: [{ id: "s1", type: "rectangle", label: "A", row: 0, column: 0 }],
			}),
		);
		expect(layout.shapes).toHaveLength(1);
		const s = layout.shapes[0];
		expect(s.width).toBe(1.5);
		expect(s.height).toBe(1.0);
		// PinX should be margin + half width
		expect(s.pinX).toBe(0.5 + 0.75);
	});

	it("places shapes in correct relative positions", () => {
		const layout = computeLayout(
			makeDiagram({
				shapes: [
					{ id: "s1", type: "rectangle", label: "Top", row: 0, column: 0 },
					{ id: "s2", type: "rectangle", label: "Bottom", row: 1, column: 0 },
					{ id: "s3", type: "rectangle", label: "Right", row: 0, column: 1 },
				],
			}),
		);
		const [s1, s2, s3] = layout.shapes;
		// s2 should be below s1 (lower pinY in Visio coordinates)
		expect(s2.pinY).toBeLessThan(s1.pinY);
		// s3 should be right of s1 (higher pinX)
		expect(s3.pinX).toBeGreaterThan(s1.pinX);
	});

	it("creates connectors between shapes", () => {
		const layout = computeLayout(
			makeDiagram({
				shapes: [
					{ id: "s1", type: "rectangle", label: "A", row: 0, column: 0 },
					{ id: "s2", type: "rectangle", label: "B", row: 1, column: 0 },
				],
				connections: [
					{
						id: "c1",
						from: { shapeId: "s1", port: "bottom" },
						to: { shapeId: "s2", port: "top" },
					},
				],
			}),
		);
		expect(layout.connectors).toHaveLength(1);
		const c = layout.connectors[0];
		// From should be at s1's bottom, to at s2's top
		expect(c.fromY).toBeLessThan(layout.shapes[0].pinY);
		expect(c.toY).toBeGreaterThan(layout.shapes[1].pinY);
	});

	it("skips connectors with invalid shape references", () => {
		const layout = computeLayout(
			makeDiagram({
				shapes: [{ id: "s1", type: "rectangle", label: "A", row: 0, column: 0 }],
				connections: [
					{
						id: "c1",
						from: { shapeId: "s1" },
						to: { shapeId: "s_missing" },
					},
				],
			}),
		);
		expect(layout.connectors).toHaveLength(0);
	});

	it("computes group bounding boxes", () => {
		const layout = computeLayout(
			makeDiagram({
				shapes: [
					{ id: "s1", type: "rectangle", label: "A", row: 0, column: 0, groupId: "g1" },
					{ id: "s2", type: "rectangle", label: "B", row: 0, column: 1, groupId: "g1" },
				],
				groups: [{ id: "g1", label: "Group 1", shapeIds: ["s1", "s2"] }],
			}),
		);
		expect(layout.groups).toHaveLength(1);
		const g = layout.groups[0];
		// Group should encompass both shapes
		expect(g.width).toBeGreaterThan(layout.shapes[0].width);
	});

	it("handles colSpan for wider shapes", () => {
		const layout = computeLayout(
			makeDiagram({
				shapes: [
					{ id: "s1", type: "rectangle", label: "Wide", row: 0, column: 0, colSpan: 2 },
				],
			}),
		);
		const s = layout.shapes[0];
		// Width should be 2 cells + spacing between them
		expect(s.width).toBe(2 * 1.5 + 0.75);
	});

	it("auto-routes connectors without explicit ports", () => {
		const layout = computeLayout(
			makeDiagram({
				shapes: [
					{ id: "s1", type: "rectangle", label: "Left", row: 0, column: 0 },
					{ id: "s2", type: "rectangle", label: "Right", row: 0, column: 2 },
				],
				connections: [{ id: "c1", from: { shapeId: "s1" }, to: { shapeId: "s2" } }],
			}),
		);
		expect(layout.connectors).toHaveLength(1);
		const c = layout.connectors[0];
		// Should auto-detect horizontal direction: from right side of s1 to left side of s2
		expect(c.fromX).toBeGreaterThan(layout.shapes[0].pinX);
		expect(c.toX).toBeLessThan(layout.shapes[1].pinX);
	});
});
