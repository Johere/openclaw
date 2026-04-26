import { describe, expect, it } from "vitest";
import { buildConnectorXml, buildGroupBackgroundXml, buildShapeXml } from "./shape-mapper.js";

describe("buildShapeXml", () => {
	it("produces a Shape element with correct ID and position", () => {
		const xml = buildShapeXml(
			{ id: "s1", type: "rectangle", label: "Test", row: 0, column: 0 },
			0,
			2.0,
			3.0,
			1.5,
			1.0,
		);
		expect(xml).toContain('ID="1"');
		expect(xml).toContain('NameU="s1"');
		expect(xml).toContain('N="PinX" V="2"');
		expect(xml).toContain('N="PinY" V="3"');
		expect(xml).toContain('N="Width" V="1.5"');
		expect(xml).toContain("<Text>Test</Text>");
	});

	it("escapes special characters in labels", () => {
		const xml = buildShapeXml(
			{ id: "s1", type: "rectangle", label: "A & B", row: 0, column: 0 },
			0,
			1,
			1,
			1.5,
			1.0,
		);
		expect(xml).toContain("A &amp; B");
	});

	it("includes sublabel when provided", () => {
		const xml = buildShapeXml(
			{ id: "s1", type: "rectangle", label: "Main", sublabel: "Sub", row: 0, column: 0 },
			0,
			1,
			1,
			1.5,
			1.0,
		);
		expect(xml).toContain("Main\nSub");
	});

	it("uses custom fill color when provided", () => {
		const xml = buildShapeXml(
			{ id: "s1", type: "rectangle", label: "Red", row: 0, column: 0, fillColor: "#FF0000" },
			0,
			1,
			1,
			1.5,
			1.0,
		);
		expect(xml).toContain('N="FillForegnd" V="#FF0000"');
	});

	it("produces diamond geometry for diamond type", () => {
		const xml = buildShapeXml(
			{ id: "s1", type: "diamond", label: "Decision", row: 0, column: 0 },
			0,
			1,
			1,
			1.5,
			1.0,
		);
		expect(xml).toContain("Geometry1");
		// Diamond has midpoint vertices
		expect(xml).toContain('V="0.75"'); // half width
		expect(xml).toContain('V="0.5"'); // half height
	});

	it("produces ellipse geometry for circle type", () => {
		const xml = buildShapeXml(
			{ id: "s1", type: "circle", label: "Node", row: 0, column: 0 },
			0,
			1,
			1,
			1.5,
			1.0,
		);
		expect(xml).toContain("Ellipse");
	});

	it("produces rounded rectangle geometry", () => {
		const xml = buildShapeXml(
			{ id: "s1", type: "rounded-rectangle", label: "Rounded", row: 0, column: 0 },
			0,
			1,
			1,
			1.5,
			1.0,
		);
		expect(xml).toContain("EllipticalArcTo");
	});
});

describe("buildConnectorXml", () => {
	it("produces a connector shape with begin/end coordinates", () => {
		const xml = buildConnectorXml(
			{ id: "c1", from: { shapeId: "s1" }, to: { shapeId: "s2" } },
			0,
			1.0,
			2.0,
			3.0,
			4.0,
			5,
		);
		expect(xml).toContain('ID="6"'); // baseShapeCount + connIndex + 1
		expect(xml).toContain('N="BeginX" V="1"');
		expect(xml).toContain('N="EndY" V="4"');
		expect(xml).toContain('N="EndArrow" V="4"'); // single arrow default
	});

	it("uses dashed line pattern", () => {
		const xml = buildConnectorXml(
			{
				id: "c1",
				from: { shapeId: "s1" },
				to: { shapeId: "s2" },
				lineStyle: "dashed",
			},
			0,
			0,
			0,
			1,
			1,
			0,
		);
		expect(xml).toContain('N="LinePattern" V="2"');
	});

	it("includes label when provided", () => {
		const xml = buildConnectorXml(
			{
				id: "c1",
				from: { shapeId: "s1" },
				to: { shapeId: "s2" },
				label: "Yes",
			},
			0,
			0,
			0,
			1,
			1,
			0,
		);
		expect(xml).toContain("<Text>Yes</Text>");
	});

	it("sets no arrows when arrowStyle is none", () => {
		const xml = buildConnectorXml(
			{
				id: "c1",
				from: { shapeId: "s1" },
				to: { shapeId: "s2" },
				arrowStyle: "none",
			},
			0,
			0,
			0,
			1,
			1,
			0,
		);
		expect(xml).toContain('N="EndArrow" V="0"');
		expect(xml).toContain('N="BeginArrow" V="0"');
	});
});

describe("buildGroupBackgroundXml", () => {
	it("produces a semi-transparent background shape", () => {
		const xml = buildGroupBackgroundXml(0, "My Group", 2, 3, 4, 2, "#D9E2F3", 10);
		expect(xml).toContain('ID="11"');
		expect(xml).toContain('N="FillForegndTrans" V="0.7"');
		expect(xml).toContain("<Text>My Group</Text>");
		expect(xml).toContain('N="LinePattern" V="2"'); // dashed border
	});
});
