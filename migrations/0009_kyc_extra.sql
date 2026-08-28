-- Levonis migration 0009 — KYC/approved-address extras building on 0003.
-- NONDESTRUCTIVE: ADD COLUMN / CREATE INDEX only.
--
-- 1) kyc_cases.case_type — §9 models PRO phone changes as a KYC case type
--    ('identity' | 'phone_change') reviewed by the same admin queue.
-- 2) kyc_cases.doc_number_enc — the document number is a sensitive identity
--    field; 0003 only had full_name_enc/dob_enc. Sealbox-encrypted.
-- 3) kyc_cases.payload — JSON for case-type-specific data (e.g. the newly
--    Telegram-proven phone for a phone_change case). Never identity PII.
-- 4) approved_addresses.source_address_id — which saved addresses row was
--    snapshotted, so address CRUD can flag "no longer matches the approved
--    snapshot" without ever treating the snapshot as a live reference.

ALTER TABLE kyc_cases ADD COLUMN case_type TEXT NOT NULL DEFAULT 'identity';
ALTER TABLE kyc_cases ADD COLUMN doc_number_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE kyc_cases ADD COLUMN payload TEXT NOT NULL DEFAULT '{}';

ALTER TABLE approved_addresses ADD COLUMN source_address_id TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_kyc_state ON kyc_cases(state, created_at);
CREATE INDEX idx_policy_documents_key ON policy_documents(key, status, version);
