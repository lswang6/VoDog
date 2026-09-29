package org.vodog

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

private data class SmsPickerChoice(val recipient: SmsRecipient, val label: String?)

@Composable
internal fun SmsRecipientPicker(
    contacts: List<ClientContact>,
    selected: List<SmsRecipient>,
    input: String,
    onChange: (List<SmsRecipient>, String) -> Unit,
    onDismiss: () -> Unit,
    status: String,
    onRetry: () -> Unit,
) {
    var staged by rememberSaveable(stateSaver = listSaver<List<SmsRecipient>, String>(
        save = { list -> list.flatMap { listOf(it.number, it.name.orEmpty()) } },
        restore = { values -> values.chunked(2).map { SmsRecipient(it[0], it[1].ifBlank { null }) } },
    )) { mutableStateOf(SmsRecipientPolicy.resolved(selected, input, contacts)) }
    var search by rememberSaveable { mutableStateOf("") }
    val choices = contacts.filter { contact ->
        contact.displayName.contains(search.trim(), ignoreCase = true) || contact.phones.any {
            it.rawNumber.contains(search.trim()) || it.dialNumber.contains(search.trim()) ||
                (SmsRecipientPolicy.digitKey(search)?.let { query -> SmsRecipientPolicy.digitKey(it.dialNumber)?.contains(query) } == true)
        }
    }.flatMap { contact -> contact.phones.map { SmsPickerChoice(SmsRecipient(it.dialNumber, contact.displayName), it.label) } }
    AlertDialog(
        modifier = Modifier.imePadding().testTag("sms.recipients.picker"),
        onDismissRequest = onDismiss,
        title = { Text("选择收件人") },
        text = {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(search, { search = it }, label = { Text("搜索姓名或号码") },
                    singleLine = true, modifier = Modifier.fillMaxWidth().testTag("sms.recipients.search"))
                Text("已选 ${staged.size} / 100", modifier = Modifier.testTag("sms.recipients.count"))
                if (status.isNotBlank()) {
                    Text(status)
                    TextButton(onClick = onRetry, modifier = Modifier.heightIn(min = 48.dp)) { Text("重试") }
                }
                LazyColumn(Modifier.fillMaxWidth().heightIn(max = 320.dp).weight(1f, fill = false)) {
                    if (choices.isEmpty()) item { Text("暂无匹配号码，可返回手动输入") }
                    items(choices.distinctBy { (it.recipient.name.orEmpty() + "\u0000" + it.recipient.number) }) { choice ->
                        val recipient = choice.recipient
                        val key = SmsRecipientPolicy.key(recipient.number, contacts)
                        val checked = staged.any {
                            SmsRecipientPolicy.key(it.number, contacts) == key
                        }
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 48.dp)
                                .testTag("sms.recipients.choice").toggleable(checked, role = Role.Checkbox) {
                                    val current = staged
                                    val next = if (checked) current.filterNot { SmsRecipientPolicy.key(it.number, contacts) == key }
                                        else SmsRecipientPolicy.unique(current + recipient, contacts)
                                    staged = next
                                }.padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(checked, onCheckedChange = null)
                            Column(Modifier.weight(1f)) {
                                Text(recipient.name.orEmpty(), style = MaterialTheme.typography.bodyLarge)
                                Text(listOfNotNull(choice.label?.takeIf(String::isNotBlank), recipient.number).joinToString(" · "), style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onChange(SmsRecipientPolicy.unique(staged, contacts), ""); onDismiss() },
                enabled = staged.size <= 100,
                modifier = Modifier.heightIn(min = 48.dp).testTag("sms.recipients.done")) { Text("完成") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = 48.dp).testTag("sms.recipients.cancel")) { Text("取消") }
        },
    )
}

@Composable
internal fun SmsRecipientChips(recipients: List<SmsRecipient>, onRemove: (SmsRecipient) -> Unit) {
    // A vertical wrapping label keeps full names/numbers reachable at large font sizes on small screens.
    recipients.forEach { recipient ->
        InputChip(
            selected = true, onClick = { onRemove(recipient) },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("sms.recipient.chip"),
            label = { Text(listOfNotNull(recipient.name?.takeIf(String::isNotBlank), recipient.number).joinToString(" · ")) },
            trailingIcon = { Icon(Icons.Filled.Close, contentDescription = "移除收件人 ${recipient.name.orEmpty()} ${recipient.number}") },
        )
    }
}
