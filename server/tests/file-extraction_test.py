"""Real document parsing fixtures; no model, network, database or user files."""
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
import gzip
import bz2
import lzma
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/extract-attachment.py"
spec = importlib.util.spec_from_file_location("attachment_reader", SCRIPT)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


def zipped(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    return output.getvalue()


def fixtures():
    from openpyxl import Workbook
    book = Workbook()
    sheet = book.active
    sheet.title = "销售数据"
    sheet.append(["产品", "金额"])
    sheet.append(["测试产品", 12345])
    sheet["C3"] = "=SUM(B2:B2)"
    sheet["B4"] = "空首列仍能读取"
    data = io.BytesIO()
    book.save(data)
    book.close()
    # A complete minimal PDF with one text page and valid xref offsets.
    stream = b"BT /F1 12 Tf 40 740 Td (Quarterly revenue 12345) Tj ET"
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
               b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"]
    pdf = b"%PDF-1.4\n"
    positions = [0]
    for number, value in enumerate(objects, 1):
        positions.append(len(pdf))
        pdf += f"{number} 0 obj\n".encode() + value + b"\nendobj\n"
    offset = len(pdf)
    pdf += b"xref\n0 6\n0000000000 65535 f \n" + b"".join(f"{p:010} 00000 n \n".encode() for p in positions[1:])
    pdf += f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{offset}\n%%EOF\n".encode()
    return {
        "report.docx": zipped({"word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>中文合同 金额12345</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>项目甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>300</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'}),
        "sales.xlsx": data.getvalue(),
        "slides.pptx": zipped({"ppt/slides/slide1.xml": '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>发布计划12345</a:t></a:r></a:p></p:sld>', "ppt/notesSlides/notesSlide1.xml": '<a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>演讲者备注</a:t></a:r></a:p>'}),
        "invoice.pdf": pdf,
        "notes.odt": zipped({"mimetype": "application/vnd.oasis.opendocument.text", "content.xml": '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><text:p>开放文档12345</text:p></office:document-content>'}),
        "bundle.zip": zipped({"notes.txt": "压缩包内正文不能假称已经读取", "../escape.txt": "not extracted"}),
    }


class ExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = fixtures()

    def test_word_body_and_table(self):
        text = reader.extract(self.files["report.docx"], ".docx", "application/msword")["text"]
        self.assertIn("中文合同 金额12345", text)
        self.assertIn("项目甲\t300", text)

    def test_excel_sheets_numbers_formulas_and_sparse_rows(self):
        text = reader.extract(self.files["sales.xlsx"], ".xlsx", "application/vnd.ms-excel")["text"]
        for expected in ("销售数据", "12345", "=SUM(B2:B2)", "空首列仍能读取"):
            self.assertIn(expected, text)

    def test_ppt_slides_and_notes(self):
        text = reader.extract(self.files["slides.pptx"], ".pptx", "application/vnd.ms-powerpoint")["text"]
        self.assertIn("发布计划12345", text)
        self.assertIn("演讲者备注", text)

    def test_pdf_text(self):
        self.assertIn("Quarterly revenue 12345", reader.extract(self.files["invoice.pdf"], ".pdf", "application/pdf")["text"])

    def test_open_document(self):
        self.assertIn("开放文档12345", reader.extract(self.files["notes.odt"], ".odt", "application/vnd.oasis.opendocument.text")["text"])

    def test_archive_only_lists_and_never_extracts(self):
        text = reader.extract(self.files["bundle.zip"], ".zip", "application/zip")["text"]
        self.assertIn("notes.txt", text)
        self.assertIn("尚未读取", text)
        self.assertNotIn("压缩包内正文不能假称已经读取", text)

    def test_xml_entities_are_rejected(self):
        bad = zipped({"word/document.xml": '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>'})
        with self.assertRaises(reader.InvalidFile):
            reader.extract(bad, ".docx", "application/msword")

    def test_renamed_zip_is_not_treated_as_word(self):
        with self.assertRaises(reader.InvalidFile):
            reader.extract(self.files["bundle.zip"], ".docx", "application/msword")

    def test_expansion_limit(self):
        old = reader.MAX_EXPANDED
        reader.MAX_EXPANDED = 8
        try:
            with self.assertRaises(reader.InvalidFile):
                reader.extract(self.files["bundle.zip"], ".zip", "application/zip")
        finally:
            reader.MAX_EXPANDED = old

    def test_truncation_is_explicit(self):
        out = reader.Text()
        out.add("字" * (reader.MAX_TEXT + 10))
        self.assertTrue(out.truncated)
        self.assertIn("不能据此断言全文统计", out.result())

    def test_process_contract_reads_stdin_and_reports_corruption(self):
        run = subprocess.run([sys.executable, str(SCRIPT), ".pdf", "application/pdf"], input=b"%PDF-broken", capture_output=True, timeout=20)
        self.assertEqual(run.returncode, 0)
        self.assertIn("error", json.loads(run.stdout))

    def test_media_is_not_claimed_as_transcribed(self):
        text = reader.extract(b"ID3example", ".mp3", "audio/mpeg")["text"]
        self.assertIn("未提取", text)

    def test_compressed_text_formats(self):
        for extension, compress in [(".gz", gzip.compress), (".bz2", bz2.compress), (".xz", lzma.compress)]:
            result = reader.extract(compress("中文日志12345".encode()), extension, "application/gzip")
            self.assertIn("中文日志12345", result["text"])

    def test_tar_lists_without_writing_members(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            entry = tarfile.TarInfo("../outside.txt")
            entry.size = 6
            archive.addfile(entry, io.BytesIO(b"secret"))
        text = reader.extract(output.getvalue(), ".tgz", "application/gzip")["text"]
        self.assertIn("outside.txt", text)
        self.assertNotIn("secret", text)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--fixtures":
        destination = Path(sys.argv[2])
        destination.mkdir(parents=True, exist_ok=True)
        for name, data in fixtures().items():
            (destination / name).write_bytes(data)
    else:
        unittest.main()
