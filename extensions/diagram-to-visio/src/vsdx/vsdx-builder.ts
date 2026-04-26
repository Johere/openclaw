import JSZip from "jszip";
import type { DiagramRepresentation } from "../types.js";
import { computeLayout } from "./layout-engine.js";
import { buildConnectorXml, buildGroupBackgroundXml, buildShapeXml } from "./shape-mapper.js";
import {
	appPropsXml,
	contentTypesXml,
	corePropsXml,
	documentRelsXml,
	documentXml,
	pageXml,
	pagesRelsXml,
	pagesXml,
	rootRelsXml,
} from "./xml-templates.js";

/**
 * Build a .vsdx file (as a Buffer) from a DiagramRepresentation.
 * The .vsdx is an OPC ZIP containing Visio 2013+ XML parts.
 */
export async function buildVsdx(diagram: DiagramRepresentation): Promise<Buffer> {
	const layout = computeLayout(diagram);
	const { pageWidth, pageHeight, shapes, connectors, groups } = layout;

	// Build shape XML fragments.
	// Groups go first (background), then shapes (foreground), then connectors.
	const xmlParts: string[] = [];

	// Group backgrounds
	const groupBaseId = 0;
	for (let i = 0; i < groups.length; i++) {
		const g = groups[i];
		xmlParts.push(
			buildGroupBackgroundXml(
				i,
				g.label,
				g.pinX,
				g.pinY,
				g.width,
				g.height,
				g.fillColor,
				groupBaseId,
			),
		);
	}

	// Shapes
	for (let i = 0; i < shapes.length; i++) {
		const sl = shapes[i];
		xmlParts.push(
			buildShapeXml(
				sl.shape,
				groups.length + i,
				sl.pinX,
				sl.pinY,
				sl.width,
				sl.height,
			),
		);
	}

	// Connectors
	const connBaseCount = groups.length + shapes.length;
	for (let i = 0; i < connectors.length; i++) {
		const cl = connectors[i];
		xmlParts.push(
			buildConnectorXml(cl.conn, i, cl.fromX, cl.fromY, cl.toX, cl.toY, connBaseCount),
		);
	}

	const allShapesXml = xmlParts.join("\n");

	// Assemble the OPC ZIP package.
	const zip = new JSZip();
	zip.file("[Content_Types].xml", contentTypesXml());
	zip.file("_rels/.rels", rootRelsXml());
	zip.file("visio/document.xml", documentXml());
	zip.file("visio/_rels/document.xml.rels", documentRelsXml());
	zip.file("visio/pages/pages.xml", pagesXml(pageWidth, pageHeight));
	zip.file("visio/pages/_rels/pages.xml.rels", pagesRelsXml());
	zip.file("visio/pages/page1.xml", pageXml(pageWidth, pageHeight, allShapesXml));
	zip.file("docProps/core.xml", corePropsXml(diagram.title));
	zip.file("docProps/app.xml", appPropsXml());

	return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) as Promise<Buffer>;
}
