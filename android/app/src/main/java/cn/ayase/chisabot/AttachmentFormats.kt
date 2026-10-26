package cn.ayase.chisabot

import java.io.ByteArrayOutputStream
import java.io.InputStream

/** Picker hints; the server independently verifies bytes and serves documents as downloads. */
internal object AttachmentFormats {
    private val office = mapOf(
        "pdf" to "application/pdf", "doc" to "application/msword",
        "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docm" to "application/vnd.ms-word.document.macroenabled.12",
        "xls" to "application/vnd.ms-excel", "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" to "application/vnd.ms-powerpoint", "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "xlsm" to "application/vnd.ms-excel.sheet.macroenabled.12", "pptm" to "application/vnd.ms-powerpoint.presentation.macroenabled.12",
        "rtf" to "application/rtf", "odt" to "application/vnd.oasis.opendocument.text",
        "ods" to "application/vnd.oasis.opendocument.spreadsheet", "odp" to "application/vnd.oasis.opendocument.presentation",
        "zip" to "application/zip", "7z" to "application/x-7z-compressed", "rar" to "application/vnd.rar",
        "tar" to "application/x-tar", "gz" to "application/gzip", "tgz" to "application/gzip",
        "bz2" to "application/x-bzip2", "xz" to "application/x-xz",
        "mp3" to "audio/mpeg", "wav" to "audio/wav", "m4a" to "audio/mp4", "ogg" to "audio/ogg", "flac" to "audio/flac",
        "mp4" to "video/mp4", "mov" to "video/quicktime", "webm" to "video/webm",
    )
    private val textExtensions = "txt md markdown csv tsv json jsonl ndjson yaml yml toml xml html htm css scss js mjs cjs jsx ts tsx vue svelte py java kt kts c cpp h hpp cs go rs rb php swift sql sh bash bat cmd ps1 ini conf cfg log tex ipynb".split(" ").toSet()
    val imageMimes = setOf("image/png", "image/jpeg", "image/gif", "image/webp")
    fun isText(mime: String) = mime.startsWith("text/") || mime.endsWith("+json") || mime.endsWith("+xml") || mime in setOf("application/json", "application/xml", "application/yaml", "application/x-yaml", "application/toml", "application/javascript", "application/typescript", "application/sql", "application/x-ndjson")
    fun guess(name: String, given: String?): String {
        val mime = given?.lowercase()?.substringBefore(';')?.trim().orEmpty()
        if (mime in imageMimes) return mime
        val extension = name.substringAfterLast('.', "").lowercase()
        office[extension]?.let { return it }
        if (extension in textExtensions) return "text/plain"
        return mime.ifBlank { "application/octet-stream" }
    }
    fun accepts(mime: String) = if (mime.startsWith("image/")) mime in imageMimes else isText(mime) || mime in office.values || mime.startsWith("audio/") || mime.startsWith("video/") || mime == "application/octet-stream"
    fun limit(mime: String): Long = when { mime in imageMimes -> 8L * 1024 * 1024; isText(mime) -> 1024L * 1024; else -> Long.MAX_VALUE }
    fun read(input: InputStream, maxBytes: Long): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            require(output.size().toLong() + count <= maxBytes) { "文件超过 ${maxBytes / 1024 / 1024} MB" }
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }
}
