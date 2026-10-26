import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  classifyAttachment,
  MAX_DOCUMENT_BYTES,
  mimeForFilename,
} from "../../shared/attachments";
import { sniffMimeType } from "../src/channels/attachment-mime";
import { newInlineBudget, resolveAttachmentParts } from "../src/channels/attachment-parts";

describe("common chat files reach the model as actual extracted text", () => {
  test("a document over 32 MiB is extracted and charged for its readable text", async () => {
    // Add whitespace before xref, retaining a valid EOF and updating its offset.
    const pdf = readFileSync(new URL("./fixtures/common-files/invoice.pdf", import.meta.url));
    const xref = pdf.indexOf(Buffer.from("xref\n"));
    const padding = Buffer.alloc(33 * 1024 * 1024, 0x20);
    const tail = pdf.subarray(xref).toString("utf8").replace(/startxref\n\d+/, `startxref\n${xref + padding.length}`);
    const bytes = Buffer.concat([pdf.subarray(0, xref), padding, Buffer.from(tail)]);
    const budget = newInlineBudget();
    const parts = await resolveAttachmentParts(
      [{ type: "document", source: { type: "url", value: "/api/attachments/large" } }],
      async () => ({ name: "large.pdf", mimeType: "application/pdf", bytes }),
      "fail",
      budget,
    ) as Array<{ text: string }>;
    expect(parts[0].text).toContain("Quarterly revenue 12345");
    expect(budget.remaining).toBeGreaterThan(31 * 1024 * 1024);
    expect(budget.remaining).toBeLessThan(budget.limit);
  });
  for (const [name, expected] of [
    ["report.docx", "中文合同 金额12345"],
    ["sales.xlsx", "12345"],
    ["slides.pptx", "演讲者备注"],
    ["invoice.pdf", "Quarterly revenue 12345"],
    ["notes.odt", "开放文档12345"],
    ["bundle.zip", "notes.txt"],
  ]) {
    test(name, async () => {
      const bytes = readFileSync(
        new URL(`./fixtures/common-files/${name}`, import.meta.url),
      );
      const mimeType = sniffMimeType(bytes, "application/octet-stream", name);
      expect(classifyAttachment(mimeType)).toBe("file");
      const parts = (await resolveAttachmentParts(
        [
          {
            type: "document",
            source: { type: "url", value: "/api/attachments/file1" },
          },
        ],
        async () => ({ name, mimeType, bytes }),
      )) as Array<{ type: string; text: string }>;
      expect(parts[0].type).toBe("text");
      expect(parts[0].text).toContain(expected);
      expect(parts[0].text).not.toContain("PK\u0003\u0004");
    });
  }
  test("a corrupt document fails the asked turn and only notes an unavailable historical file", async () => {
    const content = [
      {
        type: "document",
        source: { type: "url", value: "/api/attachments/bad" },
      },
    ];
    const load = async () => ({
      name: "broken.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("%PDF-broken"),
    });
    await expect(resolveAttachmentParts(content, load)).rejects.toThrow(
      "无法读取附件",
    );
    const parts = (await resolveAttachmentParts(
      content,
      load,
      "note",
    )) as Array<{ text: string }>;
    expect(parts[0].text).toContain("未能读取");
  });
  test("binary Office claims require matching bytes and document upload size is unrestricted", () => {
    expect(
      sniffMimeType(
        Buffer.from("not a Word document"),
        "application/msword",
        "wrong.doc",
      ),
    ).toBe("application/octet-stream");
    expect(MAX_DOCUMENT_BYTES).toBe(Number.POSITIVE_INFINITY);
    for (const name of [
      "test.doc",
      "test.xls",
      "test.ppt",
      "test.rtf",
      "test.7z",
      "test.tar",
    ])
      expect(classifyAttachment(mimeForFilename(name)!)).toBe("file");
    for (const name of ["test.py", "test.ts", "test.yml", "test.tsv"])
      expect(classifyAttachment(mimeForFilename(name)!)).toBe("text");
  });
});
