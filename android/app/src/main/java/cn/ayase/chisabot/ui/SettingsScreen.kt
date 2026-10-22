package cn.ayase.chisabot.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.ayase.chisabot.AppViewModel
import cn.ayase.chisabot.BuildConfig
import cn.ayase.chisabot.Screen

/**
 * 原生设置（基础部分，DESIGN §84.5）：外观（跟随系统 / 浅色 / 深色）、账号与服务器（切换服务器、退出登录）、
 * 设备（只读列表，这台手机标出来）、版本与检查更新；其余设置仍在「更多设置」（网页）。
 */
@Composable
fun SettingsScreen(vm: AppViewModel, onCheckUpdate: () -> Unit, onLogout: () -> Unit) {
    val sky = LocalSky.current
    Column(Modifier.fillMaxSize()) {
        TopBar("设置", subtitle = "偏好设置", onBack = { vm.back() })
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Section("外观") {
                Text("颜色", color = sky.ink2, fontSize = 14.sp, modifier = Modifier.padding(bottom = 8.dp))
                Segmented(listOf("system" to "跟随系统", "light" to "浅色", "dark" to "深色"), vm.themeMode) { vm.setTheme(it) }
            }
            Section("账号") {
                SettingLine("账号", vm.meName ?: vm.username ?: "—", vm.meEmail)
                SettingLine("服务器", vm.origin()?.removePrefix("https://") ?: "—", if (vm.thisDeviceName != null) "已扫码绑定：${vm.thisDeviceName}" else null)
                Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PillButton("切换服务器", Modifier.weight(1f)) { vm.switchServer() }
                    PillButton("退出登录", Modifier.weight(1f), danger = true) { onLogout() }
                }
            }
            Section("设备", trailing = if (vm.devicesLoading && vm.devices.isNotEmpty()) "刷新中…" else null) {
                when {
                    vm.devices.isEmpty() && vm.devicesLoading -> repeat(2) { Box(Modifier.fillMaxWidth().height(52.dp).padding(vertical = 4.dp).clip(RoundedCornerShape(12.dp)).background(sky.glass1)) }
                    vm.devices.isEmpty() && vm.devicesError != null -> Text(vm.devicesError ?: "", color = sky.danger, fontSize = 13.5.sp)
                    vm.devices.isEmpty() -> Text("还没有设备。在电脑上装 ChisaBot 客户端、或在网页「设置 → 设备」绑定手机。", color = sky.ink3, fontSize = 13.5.sp)
                    else -> vm.devices.forEachIndexed { i, d ->
                        if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(sky.ink4.copy(alpha = 0.25f)))
                        Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(vertical = 6.dp).semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(8.dp).clip(CircleShape).background(if (d.paused) sky.warn else if (d.online) sky.success else sky.ink4))
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(d.name, color = sky.ink1, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                                    if (d.thisPhone) {
                                        Spacer(Modifier.width(6.dp))
                                        Text("这台手机", color = sky.accent, fontSize = 11.sp, modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(sky.accentSoft).padding(horizontal = 6.dp, vertical = 2.dp))
                                    }
                                }
                                val status = when { d.paused -> "已紧急停止"; d.online -> "在线"; else -> d.lastSeenAt?.let { "离线 · ${relativeTime(it)}在线" } ?: "离线" }
                                Text(listOfNotNull(platformName(d.platform), status, d.clientVersion?.let { "v$it" }).joinToString(" · "), color = sky.ink3, fontSize = 12.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
                Text("管理设备（权限、解绑）请到 更多设置 → 设备。", color = sky.ink3, fontSize = 12.sp, modifier = Modifier.padding(top = 6.dp))
            }
            Section("更多") {
                LinkLine("云端工作区与项目修复（网页）") { vm.push(Screen.Web("/settings/cloud-workspace", "云端工作区与项目修复")) }
                LinkLine("GitHub 账号连接（网页）") { vm.push(Screen.Web("/settings/connected-accounts", "账号连接")) }
                LinkLine("更多设置（网页）") { vm.push(Screen.Web("/settings", "设置")) }
                LinkLine("审批偏好（网页）") { vm.push(Screen.Web("/settings/approvals", "审批偏好")) }
                LinkLine("检查更新") { onCheckUpdate() }
                SettingLine("版本", "ChisaBot ${BuildConfig.VERSION_NAME}（${BuildConfig.VERSION_CODE}）", null)
                SettingLine("包名", BuildConfig.APPLICATION_ID, null)
            }
            Spacer(Modifier.navigationBarsPadding())
        }
    }
}

private fun platformName(p: String) = when (p.lowercase()) {
    "windows", "win32" -> "Windows"; "darwin", "macos", "mac" -> "macOS"; "linux" -> "Linux"; "android" -> "Android"; "ios" -> "iOS"; "" -> null; else -> p
}

@Composable
private fun Section(title: String, trailing: String? = null, content: @Composable ColumnScope.() -> Unit) {
    val sky = LocalSky.current
    Column {
        Row(Modifier.padding(start = 6.dp, bottom = 6.dp)) {
            Text(title, color = sky.ink3, fontSize = 12.5.sp, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
            if (trailing != null) Text(trailing, color = sky.ink4, fontSize = 12.sp)
        }
        Column(Modifier.fillMaxWidth().glass(sky, level = 2).padding(14.dp), content = content)
    }
}

@Composable
private fun SettingLine(label: String, value: String, sub: String?) {
    val sky = LocalSky.current
    Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = sky.ink2, fontSize = 14.sp, modifier = Modifier.width(72.dp))
        Column(Modifier.weight(1f)) {
            Text(value, color = sky.ink1, fontSize = 14.5.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!sub.isNullOrBlank()) Text(sub, color = sky.ink3, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun LinkLine(label: String, onClick: () -> Unit) {
    val sky = LocalSky.current
    Row(
        Modifier.fillMaxWidth().heightIn(min = 46.dp).clip(RoundedCornerShape(10.dp)).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = sky.ink1, fontSize = 14.5.sp, modifier = Modifier.weight(1f))
        Text("›", color = sky.ink3, fontSize = 18.sp)
    }
}

@Composable
private fun PillButton(label: String, modifier: Modifier = Modifier, danger: Boolean = false, onClick: () -> Unit) {
    val sky = LocalSky.current
    Box(
        modifier.height(42.dp).clip(RoundedCornerShape(21.dp)).background(if (danger) sky.danger.copy(alpha = 0.12f) else sky.glass3)
            .clickable(role = Role.Button, onClick = onClick).semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) { Text(label, color = if (danger) sky.danger else sky.ink1, fontSize = 14.5.sp, fontWeight = FontWeight.Medium) }
}

/** 分段按钮：选中那一格白底（深色下亮一档），切换 200ms 颜色过渡，宽度不变。 */
@Composable
private fun Segmented(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    val sky = LocalSky.current
    Row(Modifier.fillMaxWidth().height(40.dp).clip(RoundedCornerShape(20.dp)).background(sky.codeBg).padding(3.dp)) {
        options.forEach { (key, label) ->
            val on = key == selected
            val bg by animateColorAsState(if (on) (if (sky.dark) sky.glass3 else Color.White) else Color.Transparent, tween(200), label = "seg")
            Box(
                Modifier.weight(1f).fillMaxSize().clip(RoundedCornerShape(17.dp)).background(bg).clickable(role = Role.Tab) { onSelect(key) }
                    .semantics { this.selected = on; contentDescription = label },
                contentAlignment = Alignment.Center,
            ) { Text(label, color = if (on) sky.ink1 else sky.ink3, fontSize = 13.5.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal) }
        }
    }
}
