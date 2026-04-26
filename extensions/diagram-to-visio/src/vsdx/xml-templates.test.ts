import { describe, expect, it } from "vitest";
import {
	appPropsXml,
	contentTypesXml,
	corePropsXml,
	documentRelsXml,
	documentXml,
	escapeXml,
	pageXml,
	pagesRelsXml,
	pagesXml,
	rootRelsXml,
} from "./xml-templates.js";

describe("escapeXml", () => {
	it("escapes all special XML characters", () => {
		expect(escapeXml('a < b > c & d "e" \'f\'')).toBe(
			"a &lt; b &gt; c &amp; d &quot;e&quot; &apos;f&apos;",
		);
	});

	it("handles empty string", () => {
		expect(escapeXml("")).toBe("");
	});

	it("returns plain text unchanged", () => {
		expect(escapeXml("Hello World")).toBe("Hello World");
	});
});

describe("XML template functions", () => {
	it("contentTypesXml produces well-formed XML with required content types", () => {
		const xml = contentTypesXml();
		expect(xml).toContain('<?xml version="1.0"');
		expect(xml).toContain("vnd.ms-visio.drawing.main+xml");
		expect(xml).toContain("vnd.ms-visio.page+xml");
		expect(xml).toContain("vnd.ms-visio.pages+xml");
	});

	it("rootRelsXml includes visio document relationship", () => {
		const xml = rootRelsXml();
		expect(xml).toContain("visio/document.xml");
		expect(xml).toContain("docProps/core.xml");
		expect(xml).toContain("docProps/app.xml");
	});

	it("documentXml includes creator", () => {
		const xml = documentXml();
		expect(xml).toContain("OpenClaw diagram-to-visio");
	});

	it("documentRelsXml points to pages", () => {
		const xml = documentRelsXml();
		expect(xml).toContain("pages/pages.xml");
	});

	it("pagesXml includes page dimensions", () => {
		const xml = pagesXml(11, 8.5);
		expect(xml).toContain('V="11"');
		expect(xml).toContain('V="8.5"');
		expect(xml).toContain("Page-1");
	});

	it("pagesRelsXml points to page1", () => {
		const xml = pagesRelsXml();
		expect(xml).toContain("page1.xml");
	});

	it("corePropsXml includes title when provided", () => {
		const xml = corePropsXml("Test Diagram");
		expect(xml).toContain("<dc:title>Test Diagram</dc:title>");
	});

	it("corePropsXml escapes title with special characters", () => {
		const xml = corePropsXml("A & B <test>");
		expect(xml).toContain("A &amp; B &lt;test&gt;");
	});

	it("corePropsXml omits title when not provided", () => {
		const xml = corePropsXml();
		expect(xml).not.toContain("<dc:title>");
	});

	it("appPropsXml includes application name", () => {
		const xml = appPropsXml();
		expect(xml).toContain("OpenClaw");
	});

	it("pageXml wraps shapes in PageContents/Shapes", () => {
		const shapesXml = '<Shape ID="1">test</Shape>';
		const xml = pageXml(11, 8.5, shapesXml);
		expect(xml).toContain("<PageContents");
		expect(xml).toContain("<Shapes>");
		expect(xml).toContain(shapesXml);
		expect(xml).toContain("</Shapes>");
	});
});
