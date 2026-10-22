package cn.ayase.chisabot.chat

import kotlinx.serialization.json.JsonObject

/** Public server projections only; credentials never leave the server. */
data class ModelOption(val id: String, val label: String, val provider: String) {
    fun matches(query: String) = query.isBlank() || listOf(id, label, provider).any { it.contains(query.trim(), ignoreCase = true) }
}

data class BotModelState(
    val agentId: String, val model: String, val overrideModel: String?, val defaultModel: String,
    val available: Boolean, val canManage: Boolean,
)

fun parseModelState(o: JsonObject): BotModelState = BotModelState(
    agentId = o.s("agentId") ?: error("模型设置缺少机器人编号"),
    model = o.s("model").orEmpty(), overrideModel = o.s("overrideModel"), defaultModel = o.s("defaultModel").orEmpty(),
    available = o["available"]?.toString() == "true", canManage = o["canManage"]?.toString() == "true",
)

fun parseModelOptions(o: JsonObject): List<ModelOption> = (o.a("models") ?: error("模型列表格式不正确")).mapNotNull { el ->
    val row = el as? JsonObject ?: return@mapNotNull null
    val id = row.s("id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
    ModelOption(id, row.s("label")?.takeIf { it.isNotBlank() } ?: id.substringAfterLast('/'), row.s("providerName") ?: row.s("provider").orEmpty())
}.distinctBy { it.id }

/** Match the desktop rule: a failed catalog request must never lock the composer. */
fun modelMissing(state: BotModelState?, catalog: List<ModelOption>?): Boolean =
    state?.available == true && catalog != null && catalog.none { it.id == state.model }
