package cn.ayase.chisabot.chat

import kotlinx.serialization.json.*

data class ConversationRef(val channelId: String, val threadId: String)
data class ConversationEntry(val threadId: String, val title: String, val messages: Int, val updatedAt: String?)

/** A missing or malformed response must never silently become a new conversation. */
fun parseConversation(body: JsonObject, botId: String, expectedThread: String? = null): ConversationRef? {
    require(body.containsKey("channel")) { "无法加载对话，请重试" }
    if (body["channel"] == JsonNull) {
        require(expectedThread == null) { "没有找到这段对话" }
        return null
    }
    val channel = body["channel"] as? JsonObject ?: error("无法加载对话")
    val ids = channel["agentIds"] as? JsonArray
    require(ids?.map { (it as? JsonPrimitive)?.contentOrNull } == listOf(botId)) { "对话与机器人不匹配" }
    val id = (channel["id"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() } ?: error("缺少会话编号")
    val thread = (channel["threadId"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() } ?: error("缺少对话编号")
    require(expectedThread == null || expectedThread == thread) { "对话编号不匹配" }
    return ConversationRef(id, thread)
}

fun parseConversations(body: JsonObject): List<ConversationEntry> {
    val threads = body["threads"] as? JsonArray ?: error("无法加载历史对话")
    return threads.map { value ->
        val row = value as? JsonObject ?: error("历史对话格式有误")
        val id = (row["threadId"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() } ?: error("缺少对话编号")
        ConversationEntry(id, (row["title"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() } ?: "未命名对话",
            (row["messages"] as? JsonPrimitive)?.intOrNull ?: 0, (row["updatedAt"] as? JsonPrimitive)?.contentOrNull)
    }.sortedByDescending { it.updatedAt ?: "" }
}
