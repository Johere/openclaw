import type { DiagramConnection, DiagramShape, ShapeType } from "../types.js";
import {
	CONNECTOR_COLOR,
	DEFAULT_FILL_COLOR,
	DEFAULT_STROKE_COLOR,
	DEFAULT_TEXT_COLOR,
} from "./constants.js";
import { escapeXml, visioColor } from "./xml-templates.js";

/**
 * Build the Visio <Shape> XML for a single diagram shape.
 * Coordinates are in Visio page units (inches), with origin at bottom-left.
 */
export function buildShapeXml(
	shape: DiagramShape,
	shapeIndex: number,
	pinX: number,
	pinY: number,
	width: number,
	height: number,
): string {
	const id = shapeIndex + 1; // Visio shape IDs are 1-based
	const fill = visioColor(shape.fillColor ?? DEFAULT_FILL_COLOR);
	const stroke = visioColor(shape.strokeColor ?? DEFAULT_STROKE_COLOR);
	const textColor = DEFAULT_TEXT_COLOR;
	const geom = geometrySection(shape.type, width, height);
	const labelText = shape.sublabel
		? `${escapeXml(shape.label)}\n${escapeXml(shape.sublabel)}`
		: escapeXml(shape.label);

	return `    <Shape ID="${id}" NameU="${escapeXml(shape.id)}" Type="Shape">
      <Cell N="PinX" V="${pinX}"/>
      <Cell N="PinY" V="${pinY}"/>
      <Cell N="Width" V="${width}"/>
      <Cell N="Height" V="${height}"/>
      <Cell N="LocPinX" V="${width / 2}"/>
      <Cell N="LocPinY" V="${height / 2}"/>
      <Cell N="FillForegnd" V="${fill}"/>
      <Cell N="LineColor" V="${stroke}"/>
      <Cell N="LineWeight" V="0.01"/>
      <Cell N="Char.Color" V="${textColor}"/>
      <Cell N="Char.Size" V="0.1111"/>
      <Cell N="VerticalAlign" V="1"/>
      <Cell N="Para.HorzAlign" V="1"/>
${geom}
      <Text>${labelText}</Text>
    </Shape>`;
}

/**
 * Build the Visio <Shape> XML for a connector between two shapes.
 */
export function buildConnectorXml(
	conn: DiagramConnection,
	connIndex: number,
	fromX: number,
	fromY: number,
	toX: number,
	toY: number,
	baseShapeCount: number,
): string {
	const id = baseShapeCount + connIndex + 1;
	const color = visioColor(CONNECTOR_COLOR);
	const linePattern = conn.lineStyle === "dashed" ? "2" : conn.lineStyle === "dotted" ? "3" : "1";

	// Arrow end markers: 0=none, 4=filled arrow
	const beginArrow = conn.arrowStyle === "double" ? "4" : "0";
	const endArrow = conn.arrowStyle === "none" ? "0" : "4";

	const labelXml = conn.label
		? `      <Text>${escapeXml(conn.label)}</Text>`
		: "";

	return `    <Shape ID="${id}" NameU="${escapeXml(conn.id)}" Type="Shape">
      <Cell N="BeginX" V="${fromX}"/>
      <Cell N="BeginY" V="${fromY}"/>
      <Cell N="EndX" V="${toX}"/>
      <Cell N="EndY" V="${toY}"/>
      <Cell N="LineColor" V="${color}"/>
      <Cell N="LineWeight" V="0.01"/>
      <Cell N="LinePattern" V="${linePattern}"/>
      <Cell N="BeginArrow" V="${beginArrow}"/>
      <Cell N="EndArrow" V="${endArrow}"/>
      <Cell N="LayMember" V="1"/>
      <Section N="Geometry1">
        <Cell N="NoFill" V="1"/>
        <Cell N="NoLine" V="0"/>
        <Row T="MoveTo" IX="1">
          <Cell N="X" V="${fromX}"/>
          <Cell N="Y" V="${fromY}"/>
        </Row>
        <Row T="LineTo" IX="2">
          <Cell N="X" V="${toX}"/>
          <Cell N="Y" V="${toY}"/>
        </Row>
      </Section>
${labelXml}
    </Shape>`;
}

/**
 * Build a group background rectangle for a DiagramGroup.
 */
export function buildGroupBackgroundXml(
	groupIndex: number,
	groupLabel: string,
	pinX: number,
	pinY: number,
	width: number,
	height: number,
	fillColor: string | undefined,
	baseId: number,
): string {
	const id = baseId + groupIndex + 1;
	const fill = visioColor(fillColor ?? "#D9E2F3");
	const stroke = visioColor("#8FAADC");

	return `    <Shape ID="${id}" NameU="group_${groupIndex}" Type="Shape">
      <Cell N="PinX" V="${pinX}"/>
      <Cell N="PinY" V="${pinY}"/>
      <Cell N="Width" V="${width}"/>
      <Cell N="Height" V="${height}"/>
      <Cell N="LocPinX" V="${width / 2}"/>
      <Cell N="LocPinY" V="${height / 2}"/>
      <Cell N="FillForegnd" V="${fill}"/>
      <Cell N="FillForegndTrans" V="0.7"/>
      <Cell N="LineColor" V="${stroke}"/>
      <Cell N="LinePattern" V="2"/>
      <Cell N="LineWeight" V="0.01"/>
      <Cell N="Char.Color" V="#404040"/>
      <Cell N="Char.Size" V="0.1389"/>
      <Cell N="VerticalAlign" V="0"/>
      <Cell N="Para.HorzAlign" V="0"/>
      <Section N="Geometry1">
        <Row T="MoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>
        <Row T="LineTo" IX="2"><Cell N="X" V="${width}"/><Cell N="Y" V="0"/></Row>
        <Row T="LineTo" IX="3"><Cell N="X" V="${width}"/><Cell N="Y" V="${height}"/></Row>
        <Row T="LineTo" IX="4"><Cell N="X" V="0"/><Cell N="Y" V="${height}"/></Row>
        <Row T="LineTo" IX="5"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>
      </Section>
      <Text>${escapeXml(groupLabel)}</Text>
    </Shape>`;
}

// ── Geometry helpers ──

function geometrySection(shapeType: ShapeType, w: number, h: number): string {
	switch (shapeType) {
		case "circle":
		case "ellipse":
			return ellipseGeometry(w, h);
		case "diamond":
			return diamondGeometry(w, h);
		case "rounded-rectangle":
			return roundedRectGeometry(w, h);
		case "hexagon":
			return hexagonGeometry(w, h);
		case "cylinder":
			return cylinderGeometry(w, h);
		case "parallelogram":
			return parallelogramGeometry(w, h);
		default:
			return rectGeometry(w, h);
	}
}

function rectGeometry(w: number, h: number): string {
	return `      <Section N="Geometry1">
        <Row T="MoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>
        <Row T="LineTo" IX="2"><Cell N="X" V="${w}"/><Cell N="Y" V="0"/></Row>
        <Row T="LineTo" IX="3"><Cell N="X" V="${w}"/><Cell N="Y" V="${h}"/></Row>
        <Row T="LineTo" IX="4"><Cell N="X" V="0"/><Cell N="Y" V="${h}"/></Row>
        <Row T="LineTo" IX="5"><Cell N="X" V="0"/><Cell N="Y" V="0"/></Row>
      </Section>`;
}

function roundedRectGeometry(w: number, h: number): string {
	const r = Math.min(w, h) * 0.15; // corner radius
	return `      <Section N="Geometry1">
        <Row T="MoveTo" IX="1"><Cell N="X" V="${r}"/><Cell N="Y" V="0"/></Row>
        <Row T="LineTo" IX="2"><Cell N="X" V="${w - r}"/><Cell N="Y" V="0"/></Row>
        <Row T="EllipticalArcTo" IX="3"><Cell N="X" V="${w}"/><Cell N="Y" V="${r}"/><Cell N="A" V="${w - r / 2}"/><Cell N="B" V="${r / 2}"/><Cell N="C" V="0"/><Cell N="D" V="1"/></Row>
        <Row T="LineTo" IX="4"><Cell N="X" V="${w}"/><Cell N="Y" V="${h - r}"/></Row>
        <Row T="EllipticalArcTo" IX="5"><Cell N="X" V="${w - r}"/><Cell N="Y" V="${h}"/><Cell N="A" V="${w - r / 2}"/><Cell N="B" V="${h - r / 2}"/><Cell N="C" V="0"/><Cell N="D" V="1"/></Row>
        <Row T="LineTo" IX="6"><Cell N="X" V="${r}"/><Cell N="Y" V="${h}"/></Row>
        <Row T="EllipticalArcTo" IX="7"><Cell N="X" V="0"/><Cell N="Y" V="${h - r}"/><Cell N="A" V="${r / 2}"/><Cell N="B" V="${h - r / 2}"/><Cell N="C" V="0"/><Cell N="D" V="1"/></Row>
        <Row T="LineTo" IX="8"><Cell N="X" V="0"/><Cell N="Y" V="${r}"/></Row>
        <Row T="EllipticalArcTo" IX="9"><Cell N="X" V="${r}"/><Cell N="Y" V="0"/><Cell N="A" V="${r / 2}"/><Cell N="B" V="${r / 2}"/><Cell N="C" V="0"/><Cell N="D" V="1"/></Row>
      </Section>`;
}

function ellipseGeometry(w: number, h: number): string {
	return `      <Section N="Geometry1">
        <Row T="Ellipse" IX="1">
          <Cell N="X" V="${w / 2}"/>
          <Cell N="Y" V="${h / 2}"/>
          <Cell N="A" V="${w}"/>
          <Cell N="B" V="${h / 2}"/>
          <Cell N="C" V="${w / 2}"/>
          <Cell N="D" V="${h}"/>
        </Row>
      </Section>`;
}

function diamondGeometry(w: number, h: number): string {
	return `      <Section N="Geometry1">
        <Row T="MoveTo" IX="1"><Cell N="X" V="${w / 2}"/><Cell N="Y" V="0"/></Row>
        <Row T="LineTo" IX="2"><Cell N="X" V="${w}"/><Cell N="Y" V="${h / 2}"/></Row>
        <Row T="LineTo" IX="3"><Cell N="X" V="${w / 2}"/><Cell N="Y" V="${h}"/></Row>
        <Row T="LineTo" IX="4"><Cell N="X" V="0"/><Cell N="Y" V="${h / 2}"/></Row>
        <Row T="LineTo" IX="5"><Cell N="X" V="${w / 2}"/><Cell N="Y" V="0"/></Row>
      </Section>`;
}

function hexagonGeometry(w: number, h: number): string {
	const inset = w * 0.25;
	return `      <Section N="Geometry1">
        <Row T="MoveTo" IX="1"><Cell N="X" V="${inset}"/><Cell N="Y" V="0"/></Row>
        <Row T="LineTo" IX="2"><Cell N="X" V="${w - inset}"/><Cell N="Y" V="0"/></Row>
        <Row T="LineTo" IX="3"><Cell N="X" V="${w}"/><Cell N="Y" V="${h / 2}"/></Row>
        <Row T="LineTo" IX="4"><Cell N="X" V="${w - inset}"/><Cell N="Y" V="${h}"/></Row>
        <Row T="LineTo" IX="5"><Cell N="X" V="${inset}"/><Cell N="Y" V="${h}"/></Row>
        <Row T="LineTo" IX="6"><Cell N="X" V="0"/><Cell N="Y" V="${h / 2}"/></Row>
        <Row T="LineTo" IX="7"><Cell N="X" V="${inset}"/><Cell N="Y" V="0"/></Row>
      </Section>`;
}

function cylinderGeometry(w: number, h: number): string {
	const capH = h * 0.15;
	return `      <Section N="Geometry1">
        <Row T="MoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="${capH}"/></Row>
        <Row T="LineTo" IX="2"><Cell N="X" V="0"/><Cell N="Y" V="${h - capH}"/></Row>
        <Row T="EllipticalArcTo" IX="3"><Cell N="X" V="${w}"/><Cell N="Y" V="${h - capH}"/><Cell N="A" V="${w / 2}"/><Cell N="B" V="${h}"/><Cell N="C" V="0"/><Cell N="D" V="1"/></Row>
        <Row T="LineTo" IX="4"><Cell N="X" V="${w}"/><Cell N="Y" V="${capH}"/></Row>
        <Row T="EllipticalArcTo" IX="5"><Cell N="X" V="0"/><Cell N="Y" V="${capH}"/><Cell N="A" V="${w / 2}"/><Cell N="B" V="0"/><Cell N="C" V="0"/><Cell N="D" V="1"/></Row>
      </Section>
      <Section N="Geometry2">
        <Cell N="NoFill" V="1"/>
        <Row T="MoveTo" IX="1"><Cell N="X" V="0"/><Cell N="Y" V="${capH}"/></Row>
        <Row T="EllipticalArcTo" IX="2"><Cell N="X" V="${w}"/><Cell N="Y" V="${capH}"/><Cell N="A" V="${w / 2}"/><Cell N="B" V="${capH * 2}"/><Cell N="C" V="0"/><Cell N="D" V="1"/></Row>
      </Section>`;
}

function parallelogramGeometry(w: number, h: number): string {
	const skew = w * 0.2;
	return `      <Section N="Geometry1">
        <Row T="MoveTo" IX="1"><Cell N="X" V="${skew}"/><Cell N="Y" V="0"/></Row>
        <Row T="LineTo" IX="2"><Cell N="X" V="${w}"/><Cell N="Y" V="0"/></Row>
        <Row T="LineTo" IX="3"><Cell N="X" V="${w - skew}"/><Cell N="Y" V="${h}"/></Row>
        <Row T="LineTo" IX="4"><Cell N="X" V="0"/><Cell N="Y" V="${h}"/></Row>
        <Row T="LineTo" IX="5"><Cell N="X" V="${skew}"/><Cell N="Y" V="0"/></Row>
      </Section>`;
}
