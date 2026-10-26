package cn.ayase.chisabot

import cn.ayase.chisabot.ui.foldablePanelSpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class PanelSectionsTest {
    private fun parse(source: String) = Json.parseToJsonElement(source) as JsonObject
    private fun node(spec: JsonObject, key: String) = (spec["elements"] as JsonObject)[key] as JsonObject
    private fun kids(spec: JsonObject, key: String) = (node(spec, key)["children"] as JsonArray).map { (it as JsonPrimitive).content }

    @Test fun sectionsKeepStableKeysAndRespectNestedHeadingLevels() {
        val spec = parse("""{"root":"r","elements":{
          "r":{"type":"Stack","props":{},"children":["title","h","list","nested","text","other","value"]},
          "title":{"type":"Heading","props":{"text":"新闻面板"}},
          "h":{"type":"Heading","props":{"text":"新闻","level":2}},
          "list":{"type":"List","props":{"items":[{"title":"新闻条目"}]}},
          "nested":{"type":"Heading","props":{"text":"详情","level":3}},
          "text":{"type":"Text","props":{"text":"具体内容"}},
          "other":{"type":"Heading","props":{"text":"天气","level":2}},
          "value":{"type":"Text","props":{"text":"晴"}}
        }}""")
        val result = foldablePanelSpec(spec, "新闻面板")
        assertEquals(listOf("h", "other"), kids(result, "r"))
        assertEquals(listOf("list", "nested"), kids(result, "h"))
        assertEquals(listOf("text"), kids(result, "nested"))
        assertEquals(listOf("value"), kids(result, "other"))
        assertEquals(JsonPrimitive("Accordion"), node(result, "h")["type"])
        assertEquals(JsonPrimitive(true), (node(result, "h")["props"] as JsonObject)["open"])
        assertEquals(node(spec, "list"), node(result, "list"))
        assertEquals(7, kids(spec, "r").size)
    }

    @Test fun horizontalLayoutsAndStandaloneTitlesAreUnchanged() {
        val spec = parse("""{"root":"r","elements":{"r":{"type":"Stack","props":{"direction":"horizontal"},"children":["h","t"]},"h":{"type":"Heading","props":{"text":"标题"}},"t":{"type":"Text","props":{"text":"内容"}}}}""")
        assertEquals(spec, foldablePanelSpec(spec, "另一面板"))
    }

    @Test fun duplicateCardTitleKeepsItsDescriptionAndContents() {
        val spec = parse("""{"root":"r","elements":{"r":{"type":"Card","props":{"title":"新闻面板","description":"概览"},"children":["t"]},"t":{"type":"Text","props":{"text":"内容"}}}}""")
        val result = foldablePanelSpec(spec, "新闻面板")
        val props = node(result, "r")["props"] as JsonObject
        assertNull(props["title"])
        assertEquals(JsonPrimitive("概览"), props["description"])
        assertEquals(listOf("t"), kids(result, "r"))
    }
}
