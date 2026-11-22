package expo.modules.ravencatfloatinglayer.model

import org.junit.Assert.*
import org.junit.Test

class RavenCatConversationPreviewTest {
  private fun committed(id: Long, role: RavenCatOverlayMessageRole = RavenCatOverlayMessageRole.ASSISTANT, correlation: String? = null) =
    RavenCatOverlayMessage(role, "消息 $id", correlation, id)

  @Test fun recentWindowRemainsBounded() {
    val snapshot = RavenCatOverlaySnapshot().withConversationPreview("a", (1L..100L).map { committed(it) })
    assertEquals((95L..100L).toList(), snapshot.messages.map { it.messageId })
  }

  @Test fun committedUserReconcilesOptimisticUserAndRetainsPending() {
    val user = RavenCatOverlayMessage(RavenCatOverlayMessageRole.USER, "发送", "request")
    val pending = RavenCatOverlayMessage(RavenCatOverlayMessageRole.PENDING, "等待", "request")
    val snapshot = RavenCatOverlaySnapshot(conversationSessionId = "a", messages = listOf(user, pending))
      .withConversationPreview("a", listOf(committed(1, RavenCatOverlayMessageRole.USER, "request")))
    assertEquals(2, snapshot.messages.size)
    assertEquals(1L, snapshot.messages.first().messageId)
    assertTrue(snapshot.isSending)
  }

  @Test fun replyCallbackAfterProjectionDoesNotDuplicateOrKeepPending() {
    val pending = RavenCatOverlayMessage(RavenCatOverlayMessageRole.PENDING, "等待", "request")
    val snapshot = RavenCatOverlaySnapshot(conversationSessionId = "a", messages = listOf(pending))
      .withConversationPreview("a", listOf(committed(2)))
      .withReplyPreview(committed(2, correlation = "request"))
    assertEquals(listOf(2L), snapshot.messages.map { it.messageId })
    assertFalse(snapshot.isSending)
  }

  @Test fun projectionAfterReplyCallbackDoesNotDuplicate() {
    val snapshot = RavenCatOverlaySnapshot(conversationSessionId = "a")
      .withReplyPreview(committed(2, correlation = "request"))
      .withConversationPreview("a", listOf(committed(2)))
    assertEquals(listOf(2L), snapshot.messages.map { it.messageId })
  }

  @Test fun deletionAndClearRemoveCommittedPreview() {
    val snapshot = RavenCatOverlaySnapshot().withConversationPreview("a", listOf(committed(1), committed(2)))
    val deleted = snapshot.withConversationPreview("a", listOf(committed(1)))
    assertEquals(listOf(1L), deleted.messages.map { it.messageId })
    assertTrue(deleted.withConversationPreview("a", emptyList()).messages.isEmpty())
  }

  @Test fun changingTargetClearsPreviousSendingState() {
    val pending = RavenCatOverlayMessage(RavenCatOverlayMessageRole.PENDING, "等待", "request")
    val snapshot = RavenCatOverlaySnapshot(conversationSessionId = "a", messages = listOf(pending))
      .withConversationPreview("b", listOf(committed(3)))
    assertEquals("b", snapshot.conversationSessionId)
    assertEquals(listOf(3L), snapshot.messages.map { it.messageId })
    assertFalse(snapshot.isSending)
  }

  @Test fun lateReplyCannotResurrectDeletedOrEvictedMessage() {
    val deleted = RavenCatOverlaySnapshot().withConversationPreview("a", listOf(committed(1), committed(2)))
      .withReplyPreview(RavenCatOverlayMessage(RavenCatOverlayMessageRole.PENDING, "等待", "late"))
      .withConversationPreview("a", listOf(committed(1)))
      .withReplyPreview(committed(2, correlation = "late"))
    assertEquals(listOf(1L), deleted.messages.map { it.messageId })
    assertFalse(deleted.isSending)
    val evicted = RavenCatOverlaySnapshot().withConversationPreview("a", (1L..10L).map { committed(it) })
      .withReplyPreview(committed(1, correlation = "late"))
    assertEquals((5L..10L).toList(), evicted.messages.map { it.messageId })
  }

  @Test fun correlatedStatusDoesNotReplaceUserBubble() {
    val user = RavenCatOverlayMessage(RavenCatOverlayMessageRole.USER, "发送", "request")
    val pending = RavenCatOverlayMessage(RavenCatOverlayMessageRole.PENDING, "等待", "request")
    val error = RavenCatOverlayMessage(RavenCatOverlayMessageRole.ERROR, "失败", "request")
    val snapshot = RavenCatOverlaySnapshot(messages = listOf(user)).withReplyPreview(pending).withReplyPreview(error)
    assertEquals(listOf(user, error), snapshot.messages)
    assertFalse(snapshot.isSending)
  }

  @Test fun stableReplyIdentityReplacesOnlyItsRequestPendingAndHandsOverWithoutDuplicate() {
    val user = RavenCatOverlayMessage(RavenCatOverlayMessageRole.USER, "发送", "request")
    val pending = RavenCatOverlayMessage(RavenCatOverlayMessageRole.PENDING, "等待", "request")
    val other = RavenCatOverlayMessage(RavenCatOverlayMessageRole.PENDING, "另一条", "other")
    val reply = RavenCatOverlayMessage(RavenCatOverlayMessageRole.ASSISTANT, "回复", "client-reply")
    val snapshot = RavenCatOverlaySnapshot(conversationSessionId = "a", messages = listOf(user, pending, other))
      .withReplyPreview(reply, "request")
    assertEquals(listOf(user, other, reply), snapshot.messages)
    val canonical = committed(2, correlation = "client-reply")
    val handedOver = snapshot.withConversationPreview("a", listOf(committed(1, RavenCatOverlayMessageRole.USER, "request"), canonical))
    assertEquals(1, handedOver.messages.count { it.correlationId == "client-reply" })
    assertEquals(canonical, handedOver.messages.first { it.correlationId == "client-reply" })
  }

  @Test fun laterSourceMutationDoesNotChangeSnapshot() {
    val source = mutableListOf(committed(1), committed(2))
    val snapshot = RavenCatOverlaySnapshot().withMessages(source)
    source.clear()
    assertEquals(listOf(1L, 2L), snapshot.messages.map { it.messageId })
  }
}
