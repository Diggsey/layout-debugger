/**
 * Render a LayoutSpec to an HTML document string.
 */
import type { LayoutSpec } from "./format";

function renderNode(spec: LayoutSpec, depth = 0): string {
  const tag = spec.tag ?? "div";
  const attrs: string[] = [];

  if (spec.target) {
    attrs.push('data-testid="target"');
  }

  if (spec.style && Object.keys(spec.style).length > 0) {
    const css = Object.entries(spec.style)
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ");
    attrs.push(`style="${css}"`);
  }

  const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";
  const indent = "  ".repeat(depth + 1);

  if (!spec.children || spec.children.length === 0) {
    const content = spec.text ?? "";
    return `${indent}<${tag}${attrStr}>${content}</${tag}>`;
  }

  const childHtml = spec.children.map((c) => renderNode(c, depth + 1)).join("\n");
  return `${indent}<${tag}${attrStr}>\n${childHtml}\n${indent}</${tag}>`;
}

export function renderSpecToHtml(spec: LayoutSpec): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>* { margin: 0; padding: 0; }</style>
</head>
<body>
${renderNode(spec)}
</body>
</html>`;
}
