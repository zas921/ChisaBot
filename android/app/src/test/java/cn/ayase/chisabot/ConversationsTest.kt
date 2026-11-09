package cn.ayase.chisabot

import cn.ayase.chisabot.chat.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ConversationsTest {
    private fun body(value: String) = Json.parseToJsonElement(value) as JsonObject
    private val direct = body("""{"channel":{"id":"mobile","threadId":"new-thread","agentIds":["bot"],"lastMessageAt":null}}""")

    @Test fun serverSelectionWorksWithoutActivityTimestamp() {
        assertEquals(ConversationRef("mobile", "new-thread"), parseConversation(direct, "bot"))
        assertEquals("new-thread", parseConversation(direct, "bot", "new-thread")?.threadId)
        assertNull(parseConversation(body("""{"channel":null}"""), "bot"))
    }
    @Test fun missingMalformedAndWrongConversationNeverCreateAnEmptyChat() {
        for (value in listOf("{}", """{"channel":{}}""", """{"channel":"bad"}""")) {
            assertThrows(Exception::class.java) { parseConversation(body(value), "bot") }
        }
        assertThrows(Exception::class.java) { parseConversation(direct, "other") }
        assertThrows(Exception::class.java) { parseConversation(direct, "bot", "old-thread") }
        assertThrows(Exception::class.java) { parseConversation(body("""{"channel":null}"""), "bot", "old-thread") }
    }
    @Test fun identicalTitlesRemainSeparateSelectableThreads() {
        val rows = parseConversations(body("""{"threads":[
          {"threadId":"old","title":"制作视频","messages":1,"updatedAt":"2026-11-08T12:05:00Z"},
          {"threadId":"new","title":"制作视频","messages":41,"updatedAt":"2026-11-08T13:17:00Z"}
        ]}"""))
        assertEquals(listOf("new", "old"), rows.map { it.threadId })
        assertEquals(41, rows.first().messages)
        assertThrows(Exception::class.java) { parseConversations(body("{}")) }
    }
}
