import { test, expect } from "@playwright/test";
import { renderAscii, type DagInput } from "../src/core/dag-layout";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const casesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "dag-layout");

/** Parse a markdown test case: extract the JSON input and text expected output. */
function parseCase(content: string): { title: string; input: DagInput[]; expected: string } {
  const titleMatch = content.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : "untitled";

  const blocks = [...content.matchAll(/```(\w+)\n([\s\S]*?)```/g)];
  const jsonBlock = blocks.find(b => b[1] === "json");
  const textBlock = blocks.find(b => b[1] === "text");

  if (!jsonBlock) throw new Error("Missing ```json block");
  if (!textBlock) throw new Error("Missing ```text block");

  return {
    title,
    input: JSON.parse(jsonBlock[2]),
    expected: textBlock[2],
  };
}

function norm(s: string): string {
  return s.split("\n").map(l => l.replace(/\s+$/, "")).join("\n").replace(/^\n+|\n+$/g, "");
}

const files = fs.readdirSync(casesDir).filter(f => f.endsWith(".md")).sort();

for (const file of files) {
  const content = fs.readFileSync(path.join(casesDir, file), "utf-8");
  const { title, input, expected } = parseCase(content);

  test(`${file}: ${title}`, () => {
    const actual = renderAscii(input);
    expect(norm(actual)).toBe(norm(expected));
  });
}
