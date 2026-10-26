package cn.ayase.chisabot.ui

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/** Match web panel grouping while keeping the stored spec and stable element IDs intact. */
fun foldablePanelSpec(spec: JsonObject, title: String): JsonObject {
    val source = spec["elements"] as? JsonObject ?: return spec
    val original = source.toMutableMap()
    val root = (spec["root"] as? JsonPrimitive)?.contentOrNull ?: return spec
    fun node(key: String) = original[key] as? JsonObject
    fun props(key: String) = node(key)?.get("props") as? JsonObject ?: JsonObject(emptyMap())
    fun value(obj: JsonObject?, key: String) = (obj?.get(key) as? JsonPrimitive)?.contentOrNull
    fun children(key: String) = (node(key)?.get("children") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()
    fun normalized(text: String) = text.lowercase().replace(Regex("[\\s\\p{P}\\p{S}]+"), "")
    fun sameTitle(text: String?): Boolean {
        val a = normalized(text ?: "")
        val b = normalized(title)
        return a.isNotEmpty() && b.isNotEmpty() && (a == b || (minOf(a.length, b.length) >= 2 && (a.contains(b) || b.contains(a))))
    }
    var current: String? = root
    for (depth in 0 until 4) {
        val key = current ?: break
        val el = node(key) ?: break
        val p = props(key)
        if (value(el, "type") == "Card" && sameTitle(value(p, "title"))) {
            original[key] = JsonObject(el + ("props" to JsonObject(p - "title")))
            break
        }
        val kids = children(key)
        val first = kids.firstOrNull()
        if (first != null && value(node(first), "type") == "Heading" && sameTitle(value(props(first), "text"))) {
            original[key] = JsonObject(el + ("children" to JsonArray(kids.drop(1).map(::JsonPrimitive))))
            break
        }
        if (value(el, "type") == "Card" && !value(p, "title").isNullOrEmpty()) break
        current = first
    }
    val elements = original.toMutableMap()
    fun level(key: String) = (props(key)["level"] as? JsonPrimitive)?.intOrNull ?: 2
    fun heading(key: String) = value(node(key), "type") == "Heading" && !value(props(key), "text").isNullOrEmpty() && node(key)?.get("repeat") == null
    fun group(kids: List<String>): List<String> {
        val grouped = mutableListOf<String>()
        var index = 0
        while (index < kids.size) {
            val key = kids[index]
            grouped += key
            if (heading(key)) {
                var end = index + 1
                while (end < kids.size && !(heading(kids[end]) && level(kids[end]) <= level(key))) end++
                if (end > index + 1) {
                    val p = props(key)
                    val acc = mutableMapOf("title" to p.getValue("text"), "open" to JsonPrimitive(true))
                    p["icon"]?.let { acc["icon"] = it }
                    elements[key] = JsonObject(node(key)!! + mapOf(
                        "type" to JsonPrimitive("Accordion"), "props" to JsonObject(acc),
                        "children" to JsonArray(group(kids.subList(index + 1, end)).map(::JsonPrimitive)),
                    ))
                    index = end - 1
                }
            }
            index++
        }
        return grouped
    }
    for ((key, _) in original) {
        val type = value(node(key), "type")
        if (type == "Card" || (type == "Stack" && value(props(key), "direction") != "horizontal")) {
            elements[key] = JsonObject(node(key)!! + ("children" to JsonArray(group(children(key)).map(::JsonPrimitive))))
        }
    }
    return JsonObject(spec + ("elements" to JsonObject(elements)))
}
