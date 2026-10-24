import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  classifyAttachment,
  MAX_DOCUMENT_BYTES,
  mimeForFilename,
} from "../../shared/attachments";
import { sniffMimeType } from "../src/channels/attachment-mime";
import { resolveAttachmentParts } from "../src/channels/attachment-parts";

describe("common chat files reach the model as actual extracted text", () => {
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
  test("binary Office claims require matching bytes and the 20 MB limit is exported", () => {
    expect(
      sniffMimeType(
        Buffer.from("not a Word document"),
        "application/msword",
        "wrong.doc",
      ),
    ).toBe("application/octet-stream");
    expect(MAX_DOCUMENT_BYTES).toBe(20 * 1024 * 1024);
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
