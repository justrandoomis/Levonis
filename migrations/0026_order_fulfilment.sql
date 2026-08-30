-- 0026 — everything the admin needs to PREPARE an order, and a chat scoped to it.
--
-- Two unrelated-looking changes, one reason: the admin order screen showed an
-- id, a customer, a count and a total, and nothing a person could act on. To
-- pack a box you need the address broken into the parts a courier asks for,
-- and to ask the customer "which colour did you mean?" you need a thread
-- attached to THAT order rather than a general DM.
--
-- ------------------------------------------------------------- addresses
--
-- `address` has always been one free-text line ("Province, city, district,
-- street…") plus `landmark`. A courier form asks for the governorate and the
-- area separately, and the admin has to copy each one on its own — which is
-- impossible when they are a single blob the customer typed however they
-- liked.
--
-- NOTHING IS PARSED OUT OF THE OLD COLUMN. Splitting "بغداد الكرادة شارع 62"
-- into fields by guessing would produce confident, wrong data on real orders.
-- The new columns start empty, `address` keeps its full original text, and a
-- customer fills the parts in the next time they edit the address. The admin
-- screen shows whichever fields have a value and says plainly when the
-- structured parts are not filled yet.
ALTER TABLE addresses ADD COLUMN governorate TEXT NOT NULL DEFAULT '';
ALTER TABLE addresses ADD COLUMN area TEXT NOT NULL DEFAULT '';
ALTER TABLE addresses ADD COLUMN notes TEXT NOT NULL DEFAULT '';

-- ------------------------------------------------------------------ chats
--
-- A chat about an order is a different thing from the customer's general DM
-- with support: it has a subject, it belongs in the order screen, and closing
-- the order should not lose it. NULL keeps every existing chat exactly as it
-- is — a general conversation.
ALTER TABLE chats ADD COLUMN order_id TEXT REFERENCES orders(id);

-- One order thread per order. A partial index so the many NULL rows (every
-- existing general chat) do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_order ON chats(order_id) WHERE order_id IS NOT NULL;
