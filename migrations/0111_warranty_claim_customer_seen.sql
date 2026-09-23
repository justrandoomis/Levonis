-- ============================================================================
--  0111 — «رد جديد من الفريق» : A WARRANTY CLAIM REMEMBERS WHEN ITS CUSTOMER
--         LAST LOOKED AT IT.
-- ============================================================================
-- NONDESTRUCTIVE: one nullable ADD COLUMN on `warranty_claims` and one
-- `CREATE INDEX IF NOT EXISTS` on `claim_messages`. Nothing is dropped, no
-- CHECK is added or touched, and NO ROW IS BACKFILLED — every claim filed
-- before this applies reads `customer_seen_at IS NULL`, which is the truth
-- about it: nothing ever recorded that its customer opened the conversation.
--
-- ---------------------------------------------------------------------------
--  WHY
-- ---------------------------------------------------------------------------
-- «المحادثة التي تخص الضمان لا يوجد هنالك توضيح أو زر معين يظهر أن عند الضغط
--  على مطالباتي … تفتح المحادثة ولا يرسل الإشعار إلى المستخدم بأن هناك رسالة
--  جديدة تخص الضمان».
--
-- The notification half is code (worker/lib/engagementNotify.ts). This column
-- is the other half: the claim card under «مطالباتي» shows «رد جديد من
-- الفريق» when the warranty team wrote after the customer last opened the
-- thread, and that sentence needs a moment to compare against. The only
-- unread marker anywhere in the schema is `chat_participants.last_read_at`,
-- and claim threads are not chats.
--
-- ---------------------------------------------------------------------------
--  WHAT READS AND WRITES IT
-- ---------------------------------------------------------------------------
-- Written by GET /api/devices/claims/:id when — and only when — the viewer is
-- the claimant: an admin opening the thread is not the customer reading it.
-- Read by GET /api/devices/claims, where a claim is "unread" when its newest
-- STAFF message is later than both this stamp and the customer's own newest
-- message (answering a message is proof of having read it, so an old thread
-- the customer replied to is not flagged just because this column is new).
--
-- The index is for that comparison: the list asks, per claim, for the newest
-- staff message, and `idx_claim_messages (claim_id, created_at)` from 0003
-- cannot answer "newest WHERE is_staff = 1" without walking the thread.
-- ============================================================================

ALTER TABLE warranty_claims ADD COLUMN customer_seen_at TEXT;

CREATE INDEX IF NOT EXISTS idx_claim_messages_sender
  ON claim_messages (claim_id, is_staff, created_at);
