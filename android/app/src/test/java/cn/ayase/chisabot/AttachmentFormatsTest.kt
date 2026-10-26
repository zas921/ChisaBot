package cn.ayase.chisabot

import java.io.ByteArrayInputStream
import org.junit.Assert.*
import org.junit.Test

class AttachmentFormatsTest {
    @Test fun commonFilesAreAcceptedEvenWhenThePickerOnlyReportsGenericBytes() {
        for (name in listOf("合同.doc", "合同.docx", "报表.xlsx", "旧报表.xls", "演示.pptx", "旧演示.ppt", "附件.pdf", "内容.rtf", "包.zip", "包.7z", "日志.log", "数据.yaml")) {
            assertTrue(name, AttachmentFormats.accepts(AttachmentFormats.guess(name, "application/octet-stream")))
        }
        assertEquals("application/msword", AttachmentFormats.guess("合同.DOC", null))
        assertEquals(Long.MAX_VALUE, AttachmentFormats.limit("application/pdf"))
        assertEquals(8L * 1024 * 1024, AttachmentFormats.limit("image/png"))
        assertEquals(1024L * 1024, AttachmentFormats.limit("text/plain"))
        assertFalse(AttachmentFormats.accepts("image/svg+xml"))
    }
    @Test fun unknownSizeStreamsStillHaveABoundedRead() {
        assertArrayEquals(byteArrayOf(1, 2), AttachmentFormats.read(ByteArrayInputStream(byteArrayOf(1, 2)), 2))
        try {
            AttachmentFormats.read(ByteArrayInputStream(byteArrayOf(1, 2, 3)), 2)
            fail("must reject a stream larger than the cap")
        } catch (_: IllegalArgumentException) { }
    }
}
