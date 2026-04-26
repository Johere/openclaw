import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { DiagramRepresentation } from "../types.js";
import { buildVsdx } from "./vsdx-builder.js";

const simpleDiagram: DiagramRepresentation = {
	diagramType: "flowchart",
	title: "Test Flow",
	shapes: [
		{ id: "s1", type: "rounded-rectangle", label: "Start", row: 0, column: 0 },
		{ id: "s2", type: "diamond", label: "Decision?", row: 1, column: 0 },
		{ id: "s3", type: "rectangle", label: "Process A", row: 2, column: 0 },
		{ id: "s4", type: "rectangle", label: "Process B", row: 2, column: 1 },
	],
	connections: [
		{ id: "c1", from: { shapeId: "s1", port: "bottom" }, to: { shapeId: "s2", port: "top" } },
		{
			id: "c2",
			from: { shapeId: "s2", port: "bottom" },
			to: { shapeId: "s3", port: "top" },
			label: "Yes",
		},
		{
			id: "c3",
			from: { shapeId: "s2", port: "right" },
			to: { shapeId: "s4", port: "left" },
			label: "No",
			lineStyle: "dashed",
		},
	],
};

describe("buildVsdx", () => {
	it("produces a valid ZIP buffer", async () => {
		const buffer = await buildVsdx(simpleDiagram);
		expect(buffer).toBeInstanceOf(Buffer);
		expect(buffer.length).toBeGreaterThan(0);

		// Verify it's a valid ZIP
		const zip = await JSZip.loadAsync(buffer);
		expect(Object.keys(zip.files).length).toBeGreaterThan(0);
	});

	it("contains all required OPC parts", async () => {
		const buffer = await buildVsdx(simpleDiagram);
		const zip = await JSZip.loadAsync(buffer);

		const requiredParts = [
			"[Content_Types].xml",
			"_rels/.rels",
			"visio/document.xml",
			"visio/_rels/document.xml.rels",
			"visio/pages/pages.xml",
			"visio/pages/_rels/pages.xml.rels",
			"visio/pages/page1.xml",
			"docProps/core.xml",
			"docProps/app.xml",
		];

		for (const part of requiredParts) {
			expect(zip.files[part], `Missing part: ${part}`).toBeDefined();
		}
	});

	it("page1.xml contains shape elements for all shapes and connectors", async () => {
		const buffer = await buildVsdx(simpleDiagram);
		const zip = await JSZip.loadAsync(buffer);
		const pageContent = await zip.files["visio/pages/page1.xml"].async("string");

		// Should have shapes for: 4 shapes + 3 connectors
		expect(pageContent).toContain("Start");
		expect(pageContent).toContain("Decision?");
		expect(pageContent).toContain("Process A");
		expect(pageContent).toContain("Process B");
		expect(pageContent).toContain("Yes");
		expect(pageContent).toContain("No");
	});

	it("core.xml contains the diagram title", async () => {
		const buffer = await buildVsdx(simpleDiagram);
		const zip = await JSZip.loadAsync(buffer);
		const coreContent = await zip.files["docProps/core.xml"].async("string");
		expect(coreContent).toContain("Test Flow");
	});

	it("handles diagrams with groups", async () => {
		const diagramWithGroups: DiagramRepresentation = {
			diagramType: "architecture",
			shapes: [
				{ id: "s1", type: "rectangle", label: "Service A", row: 0, column: 0, groupId: "g1" },
				{ id: "s2", type: "rectangle", label: "Service B", row: 0, column: 1, groupId: "g1" },
			],
			connections: [],
			groups: [{ id: "g1", label: "VPC", shapeIds: ["s1", "s2"], fillColor: "#E8F0FE" }],
		};

		const buffer = await buildVsdx(diagramWithGroups);
		const zip = await JSZip.loadAsync(buffer);
		const pageContent = await zip.files["visio/pages/page1.xml"].async("string");
		expect(pageContent).toContain("VPC");
		expect(pageContent).toContain("Service A");
		expect(pageContent).toContain("Service B");
	});

	it("handles an empty diagram", async () => {
		const buffer = await buildVsdx({ diagramType: "generic", shapes: [], connections: [] });
		const zip = await JSZip.loadAsync(buffer);
		expect(zip.files["visio/pages/page1.xml"]).toBeDefined();
	});
});
