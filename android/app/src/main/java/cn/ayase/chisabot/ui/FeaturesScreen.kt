package cn.ayase.chisabot.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.ayase.chisabot.AppViewModel
import cn.ayase.chisabot.Screen

/** Use the same server pages for advanced tools so both clients receive feature updates together. */
@Composable
fun FeaturesScreen(vm: AppViewModel) {
    val sky = LocalSky.current
    val groups = listOf(
        "工作" to listOf("机器人管理" to "/agents", "群聊" to "/group/new", "待处理与审批" to "/approvals", "Claude Code" to "/cc"),
        "任务与知识" to listOf("定时任务" to "/routines", "工作流" to "/workflows", "技能" to "/skills", "记忆" to "/memory", "职责" to "/responsibilities"),
        "设置" to listOf("完整设置" to "/settings", "设备管理" to "/settings/devices", "管理后台" to "/admin", "完整工作台" to "/"),
    )
    Column(Modifier.fillMaxSize()) {
        TopBar("全部功能", onBack = { vm.back() })
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            groups.forEach { (section, entries) ->
                item { Text(section, color = sky.ink3, fontSize = 13.sp, modifier = Modifier.padding(top = 12.dp)) }
                entries.forEach { (title, path) -> item {
                    Text(title, color = sky.ink1, fontSize = 16.sp, modifier = Modifier.fillMaxWidth().glass(sky, level = 2)
                        .clickable(role = Role.Button) { vm.push(Screen.Web(path, title)) }.padding(16.dp))
                } }
            }
            item { Spacer(Modifier.navigationBarsPadding()) }
        }
    }
}
