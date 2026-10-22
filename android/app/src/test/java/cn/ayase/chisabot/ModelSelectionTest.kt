package cn.ayase.chisabot

import cn.ayase.chisabot.chat.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

class ModelSelectionTest {
    private fun obj(text: String) = Json.parseToJsonElement(text) as JsonObject

    @Test fun readsServerStateAndNullDefault() {
        val state = parseModelState(obj("""{"agentId":"bot:main","model":"provider/deepseek","overrideModel":null,"defaultModel":"provider/deepseek","available":true,"canManage":true}"""))
        assertNull(state.overrideModel)
        assertTrue(state.canManage)
        assertEquals("provider/deepseek", state.model)
    }

    @Test fun readsSearchableCatalogAndIgnoresInvalidRows() {
        val models = parseModelOptions(obj("""{"models":[{"id":"wb/model","label":"DeepSeek","provider":"wb","providerName":"WorkBuddy"},{"id":"wb/model"},{"id":"other/fallback"},{"label":"invalid"}]}"""))
        assertEquals(2, models.size)
        assertTrue(models[0].matches("workbuddy"))
        assertTrue(models[0].matches(" DEEPSEEK "))
        assertTrue(models[0].matches("wb/model"))
        assertFalse(models[0].matches("claude"))
        assertEquals("fallback", models[1].label)
    }

    @Test fun missingModelsBlockOnlyWithKnownCatalogAndLocalBot() {
        val state = BotModelState("bot", "removed", "removed", "default", true, true)
        assertFalse(modelMissing(state, null))
        assertFalse(modelMissing(null, emptyList()))
        assertTrue(modelMissing(state, emptyList()))
        assertFalse(modelMissing(state, listOf(ModelOption("removed", "Current", "provider"))))
        assertFalse(modelMissing(state.copy(available = false), emptyList()))
    }
}
