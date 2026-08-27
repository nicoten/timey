/**
 * Renders an invoice to PDF.
 *
 * Drawn with jsPDF rather than assembled in Rust: it ships the Helvetica metrics
 * needed to right-align the numeric columns, which is the one thing a hand-rolled
 * writer cannot do without reproducing a font's width tables.
 *
 * Coordinates are PostScript points from the top-left of US Letter (612 x 792).
 */

import { jsPDF } from "jspdf";

import { hoursDecimal, type InvoiceDraft, type InvoiceLine } from "./api";
import { formatMoney } from "./money";

const LEFT = 40;
const RIGHT = 572;
const PAGE_BOTTOM = 792;

/** Column geometry: separators, and the right edge each figure aligns to. */
const DIVIDERS = [367, 420, 494];
const QUANTITY_RIGHT = 412;
const UNIT_RIGHT = 486;
const AMOUNT_RIGHT = 566;

/** Where the right-hand blocks sit: caption edge, rule, then content. */
const CAPTION_RIGHT = 409;
const BLOCK_RULE = 416;

/** Leading inside the stacked right-hand blocks. */
const LINE_GAP = 13.5;
const ROW_HEIGHT = 26;
const TABLE_TOP_FIRST = 214;
const TABLE_TOP_LATER = 96;
/** Rows stop here so the totals and footer always have room. */
const ROWS_BOTTOM = 690;
const TOTALS_SPACE = 52;

const INK: [number, number, number] = [31, 35, 40];
const MUTED: [number, number, number] = [113, 121, 132];
const RULE: [number, number, number] = [206, 212, 218];

/** `2026-08-01` -> `08/01/2026`. */
function usDate(date: string): string {
  return `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;
}

export function renderInvoicePdf(draft: InvoiceDraft): Uint8Array {
  const doc = new jsPDF({ unit: "pt", format: "letter", compress: true });

  const capacity = (top: number) =>
    Math.max(1, Math.floor((ROWS_BOTTOM - TOTALS_SPACE - top - ROW_HEIGHT) / ROW_HEIGHT));

  const pages = paginate(draft.lines, capacity(TABLE_TOP_FIRST), capacity(TABLE_TOP_LATER));

  pages.forEach((lines, index) => {
    if (index > 0) doc.addPage();

    const top = index === 0 ? TABLE_TOP_FIRST : TABLE_TOP_LATER;
    if (index === 0) drawHeader(doc, draft);

    const tableBottom = drawTable(doc, lines, top);

    // The amount due belongs on the page that closes the invoice.
    if (index === pages.length - 1) {
      drawTotal(doc, draft, tableBottom);
    }

    drawFooter(doc, index + 1, pages.length);
  });

  return new Uint8Array(doc.output("arraybuffer"));
}

function paginate(
  lines: InvoiceLine[],
  firstCapacity: number,
  laterCapacity: number,
): InvoiceLine[][] {
  if (lines.length === 0) return [[]];

  const pages: InvoiceLine[][] = [];
  let index = 0;
  while (index < lines.length) {
    const capacity = pages.length === 0 ? firstCapacity : laterCapacity;
    pages.push(lines.slice(index, index + capacity));
    index += capacity;
  }
  return pages;
}

function drawHeader(doc: jsPDF, draft: InvoiceDraft): void {
  // Title
  doc.setFont("helvetica", "bold");
  doc.setFontSize(26);
  doc.setTextColor(...INK);
  doc.text("INVOICE", LEFT, 62);

  // From, top right
  labelledBlock(doc, {
    label: "From",
    labelRight: CAPTION_RIGHT,
    dividerX: BLOCK_RULE,
    dividerTop: 34,
    dividerBottom: 52,
    baseline: 46,
    lines: [{ text: draft.senderName, bold: true, size: 13 }],
  });

  const metaTop = 131;

  // Invoice identity, left
  const meta: [string, string, boolean][] = [
    ["Invoice ID", String(draft.number), true],
    ["Issue Date", usDate(draft.issueDate), false],
    ["Due Date", `${usDate(draft.issueDate)} (upon receipt)`, false],
  ];

  doc.setLineWidth(0.8);
  doc.setDrawColor(...RULE);
  doc.line(99, metaTop - 13, 99, metaTop + (meta.length - 1) * 17 + 6);

  meta.forEach(([label, value, bold], index) => {
    const baseline = metaTop + index * 17;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(...MUTED);
    doc.text(label, LEFT, baseline);

    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setTextColor(...INK);
    doc.text(value, 106, baseline);
  });

  // Client, right
  const clientLines: { text: string; bold?: boolean; size?: number }[] = [
    { text: draft.client.name, bold: true, size: 13 },
  ];
  if (draft.client.ein) clientLines.push({ text: `EIN: ${draft.client.ein}`, size: 11 });
  for (const line of (draft.client.address ?? "").split("\n")) {
    if (line.trim() !== "") clientLines.push({ text: line.trim(), size: 11 });
  }

  labelledBlock(doc, {
    label: "Invoice For",
    labelRight: CAPTION_RIGHT,
    dividerX: BLOCK_RULE,
    dividerTop: metaTop - 13,
    dividerBottom: metaTop + (clientLines.length - 1) * LINE_GAP + 6,
    baseline: metaTop,
    lines: clientLines,
  });
}

/** A right-aligned caption, a vertical rule, then stacked lines beside it. */
function labelledBlock(
  doc: jsPDF,
  block: {
    label: string;
    labelRight: number;
    dividerX: number;
    dividerTop: number;
    dividerBottom: number;
    baseline: number;
    lines: { text: string; bold?: boolean; size?: number }[];
  },
): void {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(...MUTED);
  doc.text(block.label, block.labelRight, block.baseline, { align: "right" });

  doc.setLineWidth(0.8);
  doc.setDrawColor(...RULE);
  doc.line(block.dividerX, block.dividerTop, block.dividerX, block.dividerBottom);

  let baseline = block.baseline;
  for (const line of block.lines) {
    doc.setFont("helvetica", line.bold ? "bold" : "normal");
    doc.setFontSize(line.size ?? 11);
    doc.setTextColor(...INK);
    doc.text(line.text, block.dividerX + 8, baseline);
    baseline += LINE_GAP;
  }
}

/** Draws the header row and the given lines; returns the y of the closing rule. */
function drawTable(doc: jsPDF, lines: InvoiceLine[], top: number): number {
  const headerBaseline = top + 14;
  const firstRowTop = top + 24;

  doc.setLineWidth(0.8);
  doc.setDrawColor(...RULE);
  doc.line(LEFT, top, RIGHT, top);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(...INK);
  doc.text("Description", LEFT + 4, headerBaseline);
  doc.text("Quantity", QUANTITY_RIGHT, headerBaseline, { align: "right" });
  doc.text("Unit Price", UNIT_RIGHT, headerBaseline, { align: "right" });
  doc.text("Amount", AMOUNT_RIGHT, headerBaseline, { align: "right" });

  doc.line(LEFT, firstRowTop, RIGHT, firstRowTop);

  lines.forEach((line, index) => {
    const baseline = firstRowTop + index * ROW_HEIGHT + 17;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    doc.setTextColor(...INK);
    doc.text(line.description, LEFT + 4, baseline);
    doc.text(hoursDecimal(line.minutes), QUANTITY_RIGHT, baseline, { align: "right" });
    doc.text(formatMoney(line.rateCents), UNIT_RIGHT, baseline, { align: "right" });

    doc.setFont("helvetica", "bold");
    doc.text(formatMoney(line.amountCents), AMOUNT_RIGHT, baseline, { align: "right" });
  });

  const bottom = firstRowTop + lines.length * ROW_HEIGHT;

  // Column separators run the height of the table.
  for (const x of DIVIDERS) {
    doc.line(x, top, x, bottom);
  }
  doc.line(LEFT, bottom, RIGHT, bottom);

  return bottom;
}

function drawTotal(doc: jsPDF, draft: InvoiceDraft, tableBottom: number): void {
  const baseline = tableBottom + 30;
  const amount = formatMoney(draft.totalCents);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(...INK);

  // Positioned off the measured width of the figure rather than a fixed column:
  // a large total is wide enough to run under a fixed label position.
  const amountLeft = AMOUNT_RIGHT - doc.getTextWidth(amount);
  doc.text("Amount Due", amountLeft - 18, baseline, { align: "right" });
  doc.text(amount, AMOUNT_RIGHT, baseline, { align: "right" });
}

function drawFooter(doc: jsPDF, page: number, total: number): void {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(...INK);
  doc.text(`Page ${page} of ${total}`, (LEFT + RIGHT) / 2, PAGE_BOTTOM - 36, {
    align: "center",
  });
}
