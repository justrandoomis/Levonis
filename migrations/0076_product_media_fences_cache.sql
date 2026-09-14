-- A database generation makes all edge POPs stop reading old product/search
-- entries after commit. It is also the deletion collector's write fence.
CREATE TABLE IF NOT EXISTS catalog_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO catalog_revision(id,revision) VALUES(1,0);
-- A durable tombstone/lease prevents a new reference between the shared-media
-- check and R2 DELETE. Upload/import creates new immutable object keys.
CREATE TABLE IF NOT EXISTS media_cleanup_locks (
 object_key TEXT PRIMARY KEY, job_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('deleting','deleted')),
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS media_lock_users_insert BEFORE INSERT ON "users"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."avatar_key") THEN NEW."avatar_key" ELSE json_array(NEW."avatar_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."profile_json") THEN NEW."profile_json" ELSE json_array(NEW."profile_json") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."profile_prompt_at") THEN NEW."profile_prompt_at" ELSE json_array(NEW."profile_prompt_at") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."profile_prompt_count") THEN NEW."profile_prompt_count" ELSE json_array(NEW."profile_prompt_count") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_users_update BEFORE UPDATE OF "avatar_key","profile_json","profile_prompt_at","profile_prompt_count" ON "users"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."avatar_key") THEN NEW."avatar_key" ELSE json_array(NEW."avatar_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."profile_json") THEN NEW."profile_json" ELSE json_array(NEW."profile_json") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."profile_prompt_at") THEN NEW."profile_prompt_at" ELSE json_array(NEW."profile_prompt_at") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."profile_prompt_count") THEN NEW."profile_prompt_count" ELSE json_array(NEW."profile_prompt_count") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_rate_limits_insert BEFORE INSERT ON "rate_limits"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."key") THEN NEW."key" ELSE json_array(NEW."key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_rate_limits_update BEFORE UPDATE OF "key" ON "rate_limits"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."key") THEN NEW."key" ELSE json_array(NEW."key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_products_insert BEFORE INSERT ON "products"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."images") THEN NEW."images" ELSE json_array(NEW."images") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."options") THEN NEW."options" ELSE json_array(NEW."options") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."colors") THEN NEW."colors" ELSE json_array(NEW."colors") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."payment_options") THEN NEW."payment_options" ELSE json_array(NEW."payment_options") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."description_images") THEN NEW."description_images" ELSE json_array(NEW."description_images") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."description_videos") THEN NEW."description_videos" ELSE json_array(NEW."description_videos") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."content_blocks") THEN NEW."content_blocks" ELSE json_array(NEW."content_blocks") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."content_rev") THEN NEW."content_rev" ELSE json_array(NEW."content_rev") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."ops_policy") THEN NEW."ops_policy" ELSE json_array(NEW."ops_policy") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."usage_guide") THEN NEW."usage_guide" ELSE json_array(NEW."usage_guide") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_products_update BEFORE UPDATE OF "images","options","colors","payment_options","description_images","description_videos","content_blocks","content_rev","ops_policy","usage_guide" ON "products"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."images") THEN NEW."images" ELSE json_array(NEW."images") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."options") THEN NEW."options" ELSE json_array(NEW."options") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."colors") THEN NEW."colors" ELSE json_array(NEW."colors") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."payment_options") THEN NEW."payment_options" ELSE json_array(NEW."payment_options") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."description_images") THEN NEW."description_images" ELSE json_array(NEW."description_images") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."description_videos") THEN NEW."description_videos" ELSE json_array(NEW."description_videos") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."content_blocks") THEN NEW."content_blocks" ELSE json_array(NEW."content_blocks") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."content_rev") THEN NEW."content_rev" ELSE json_array(NEW."content_rev") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."ops_policy") THEN NEW."ops_policy" ELSE json_array(NEW."ops_policy") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."usage_guide") THEN NEW."usage_guide" ELSE json_array(NEW."usage_guide") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_orders_insert BEFORE INSERT ON "orders"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."address_snapshot") THEN NEW."address_snapshot" ELSE json_array(NEW."address_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."delivery_method_snapshot") THEN NEW."delivery_method_snapshot" ELSE json_array(NEW."delivery_method_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."membership_tier_snapshot") THEN NEW."membership_tier_snapshot" ELSE json_array(NEW."membership_tier_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."coupon_snapshot") THEN NEW."coupon_snapshot" ELSE json_array(NEW."coupon_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."support_snapshot") THEN NEW."support_snapshot" ELSE json_array(NEW."support_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_orders_update BEFORE UPDATE OF "address_snapshot","delivery_method_snapshot","membership_tier_snapshot","coupon_snapshot","support_snapshot" ON "orders"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."address_snapshot") THEN NEW."address_snapshot" ELSE json_array(NEW."address_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."delivery_method_snapshot") THEN NEW."delivery_method_snapshot" ELSE json_array(NEW."delivery_method_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."membership_tier_snapshot") THEN NEW."membership_tier_snapshot" ELSE json_array(NEW."membership_tier_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."coupon_snapshot") THEN NEW."coupon_snapshot" ELSE json_array(NEW."coupon_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."support_snapshot") THEN NEW."support_snapshot" ELSE json_array(NEW."support_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_order_items_insert BEFORE INSERT ON "order_items"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."name_snapshot") THEN NEW."name_snapshot" ELSE json_array(NEW."name_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image_snapshot") THEN NEW."image_snapshot" ELSE json_array(NEW."image_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."option_snapshot") THEN NEW."option_snapshot" ELSE json_array(NEW."option_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."pricing_snapshot") THEN NEW."pricing_snapshot" ELSE json_array(NEW."pricing_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."warranty_snapshot") THEN NEW."warranty_snapshot" ELSE json_array(NEW."warranty_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."transport_snapshot") THEN NEW."transport_snapshot" ELSE json_array(NEW."transport_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."selection_snapshot") THEN NEW."selection_snapshot" ELSE json_array(NEW."selection_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_order_items_update BEFORE UPDATE OF "name_snapshot","image_snapshot","option_snapshot","pricing_snapshot","warranty_snapshot","transport_snapshot","selection_snapshot" ON "order_items"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."name_snapshot") THEN NEW."name_snapshot" ELSE json_array(NEW."name_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image_snapshot") THEN NEW."image_snapshot" ELSE json_array(NEW."image_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."option_snapshot") THEN NEW."option_snapshot" ELSE json_array(NEW."option_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."pricing_snapshot") THEN NEW."pricing_snapshot" ELSE json_array(NEW."pricing_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."warranty_snapshot") THEN NEW."warranty_snapshot" ELSE json_array(NEW."warranty_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."transport_snapshot") THEN NEW."transport_snapshot" ELSE json_array(NEW."transport_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."selection_snapshot") THEN NEW."selection_snapshot" ELSE json_array(NEW."selection_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_investment_items_insert BEFORE INSERT ON "investment_items"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image") THEN NEW."image" ELSE json_array(NEW."image") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_investment_items_update BEFORE UPDATE OF "image" ON "investment_items"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image") THEN NEW."image" ELSE json_array(NEW."image") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_community_merchants_insert BEFORE INSERT ON "community_merchants"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."avatar_key") THEN NEW."avatar_key" ELSE json_array(NEW."avatar_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_community_merchants_update BEFORE UPDATE OF "avatar_key" ON "community_merchants"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."avatar_key") THEN NEW."avatar_key" ELSE json_array(NEW."avatar_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_community_products_insert BEFORE INSERT ON "community_products"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."images") THEN NEW."images" ELSE json_array(NEW."images") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."options") THEN NEW."options" ELSE json_array(NEW."options") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."colors") THEN NEW."colors" ELSE json_array(NEW."colors") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_community_products_update BEFORE UPDATE OF "images","options","colors" ON "community_products"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."images") THEN NEW."images" ELSE json_array(NEW."images") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."options") THEN NEW."options" ELSE json_array(NEW."options") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."colors") THEN NEW."colors" ELSE json_array(NEW."colors") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_chat_messages_insert BEFORE INSERT ON "chat_messages"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."file_key") THEN NEW."file_key" ELSE json_array(NEW."file_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_chat_messages_update BEFORE UPDATE OF "file_key" ON "chat_messages"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."file_key") THEN NEW."file_key" ELSE json_array(NEW."file_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_admin_settings_insert BEFORE INSERT ON "admin_settings"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."key") THEN NEW."key" ELSE json_array(NEW."key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_admin_settings_update BEFORE UPDATE OF "key" ON "admin_settings"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."key") THEN NEW."key" ELSE json_array(NEW."key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_invoices_insert BEFORE INSERT ON "invoices"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."snapshot") THEN NEW."snapshot" ELSE json_array(NEW."snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_invoices_update BEFORE UPDATE OF "snapshot" ON "invoices"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."snapshot") THEN NEW."snapshot" ELSE json_array(NEW."snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_claim_messages_insert BEFORE INSERT ON "claim_messages"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."file_key") THEN NEW."file_key" ELSE json_array(NEW."file_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_claim_messages_update BEFORE UPDATE OF "file_key" ON "claim_messages"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."file_key") THEN NEW."file_key" ELSE json_array(NEW."file_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_review_rewards_insert BEFORE INSERT ON "review_rewards"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."quality_snapshot") THEN NEW."quality_snapshot" ELSE json_array(NEW."quality_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_review_rewards_update BEFORE UPDATE OF "quality_snapshot" ON "review_rewards"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."quality_snapshot") THEN NEW."quality_snapshot" ELSE json_array(NEW."quality_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_gift_entitlements_insert BEFORE INSERT ON "gift_entitlements"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."chosen_options") THEN NEW."chosen_options" ELSE json_array(NEW."chosen_options") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."contents") THEN NEW."contents" ELSE json_array(NEW."contents") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_gift_entitlements_update BEFORE UPDATE OF "chosen_options","contents" ON "gift_entitlements"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."chosen_options") THEN NEW."chosen_options" ELSE json_array(NEW."chosen_options") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."contents") THEN NEW."contents" ELSE json_array(NEW."contents") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_return_cases_insert BEFORE INSERT ON "return_cases"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."delivered_at_snapshot") THEN NEW."delivered_at_snapshot" ELSE json_array(NEW."delivered_at_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_return_cases_update BEFORE UPDATE OF "delivered_at_snapshot" ON "return_cases"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."delivered_at_snapshot") THEN NEW."delivered_at_snapshot" ELSE json_array(NEW."delivered_at_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_price_protection_claims_insert BEFORE INSERT ON "price_protection_claims"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."policy_snapshot") THEN NEW."policy_snapshot" ELSE json_array(NEW."policy_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_price_protection_claims_update BEFORE UPDATE OF "policy_snapshot" ON "price_protection_claims"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."policy_snapshot") THEN NEW."policy_snapshot" ELSE json_array(NEW."policy_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_policy_documents_insert BEFORE INSERT ON "policy_documents"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."key") THEN NEW."key" ELSE json_array(NEW."key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_policy_documents_update BEFORE UPDATE OF "key" ON "policy_documents"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."key") THEN NEW."key" ELSE json_array(NEW."key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_gift_redemptions_insert BEFORE INSERT ON "gift_redemptions"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."options") THEN NEW."options" ELSE json_array(NEW."options") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."contents") THEN NEW."contents" ELSE json_array(NEW."contents") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_gift_redemptions_update BEFORE UPDATE OF "options","contents" ON "gift_redemptions"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."options") THEN NEW."options" ELSE json_array(NEW."options") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."contents") THEN NEW."contents" ELSE json_array(NEW."contents") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_wallet_deposit_meta_insert BEFORE INSERT ON "wallet_deposit_meta"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."attachment_fingerprint") THEN NEW."attachment_fingerprint" ELSE json_array(NEW."attachment_fingerprint") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_wallet_deposit_meta_update BEFORE UPDATE OF "attachment_fingerprint" ON "wallet_deposit_meta"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."attachment_fingerprint") THEN NEW."attachment_fingerprint" ELSE json_array(NEW."attachment_fingerprint") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_tg_admin_notifications_insert BEFORE INSERT ON "tg_admin_notifications"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."photo_key") THEN NEW."photo_key" ELSE json_array(NEW."photo_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_tg_admin_notifications_update BEFORE UPDATE OF "photo_key" ON "tg_admin_notifications"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."photo_key") THEN NEW."photo_key" ELSE json_array(NEW."photo_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_product_option_values_insert BEFORE INSERT ON "product_option_values"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image") THEN NEW."image" ELSE json_array(NEW."image") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_product_option_values_update BEFORE UPDATE OF "image" ON "product_option_values"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image") THEN NEW."image" ELSE json_array(NEW."image") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_product_colors_insert BEFORE INSERT ON "product_colors"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image") THEN NEW."image" ELSE json_array(NEW."image") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_product_colors_update BEFORE UPDATE OF "image" ON "product_colors"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image") THEN NEW."image" ELSE json_array(NEW."image") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_product_images_insert BEFORE INSERT ON "product_images"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."url") THEN NEW."url" ELSE json_array(NEW."url") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."content_type") THEN NEW."content_type" ELSE json_array(NEW."content_type") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."source_url") THEN NEW."source_url" ELSE json_array(NEW."source_url") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_product_images_update BEFORE UPDATE OF "url","content_type","source_url" ON "product_images"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."url") THEN NEW."url" ELSE json_array(NEW."url") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."content_type") THEN NEW."content_type" ELSE json_array(NEW."content_type") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."source_url") THEN NEW."source_url" ELSE json_array(NEW."source_url") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_merchant_stores_insert BEFORE INSERT ON "merchant_stores"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."logo_key") THEN NEW."logo_key" ELSE json_array(NEW."logo_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."profile_links") THEN NEW."profile_links" ELSE json_array(NEW."profile_links") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."profile_facts") THEN NEW."profile_facts" ELSE json_array(NEW."profile_facts") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_merchant_stores_update BEFORE UPDATE OF "logo_key","profile_links","profile_facts" ON "merchant_stores"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."logo_key") THEN NEW."logo_key" ELSE json_array(NEW."logo_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."profile_links") THEN NEW."profile_links" ELSE json_array(NEW."profile_links") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."profile_facts") THEN NEW."profile_facts" ELSE json_array(NEW."profile_facts") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_cart_items_insert BEFORE INSERT ON "cart_items"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."selection_snapshot") THEN NEW."selection_snapshot" ELSE json_array(NEW."selection_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_cart_items_update BEFORE UPDATE OF "selection_snapshot" ON "cart_items"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."selection_snapshot") THEN NEW."selection_snapshot" ELSE json_array(NEW."selection_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_community_request_files_insert BEFORE INSERT ON "community_request_files"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."file_key") THEN NEW."file_key" ELSE json_array(NEW."file_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."file_name") THEN NEW."file_name" ELSE json_array(NEW."file_name") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."content_type") THEN NEW."content_type" ELSE json_array(NEW."content_type") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_community_request_files_update BEFORE UPDATE OF "file_key","file_name","content_type" ON "community_request_files"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."file_key") THEN NEW."file_key" ELSE json_array(NEW."file_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."file_name") THEN NEW."file_name" ELSE json_array(NEW."file_name") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."content_type") THEN NEW."content_type" ELSE json_array(NEW."content_type") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_community_orders_insert BEFORE INSERT ON "community_orders"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."offer_snapshot") THEN NEW."offer_snapshot" ELSE json_array(NEW."offer_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_community_orders_update BEFORE UPDATE OF "offer_snapshot" ON "community_orders"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."offer_snapshot") THEN NEW."offer_snapshot" ELSE json_array(NEW."offer_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_merchant_reviews_insert BEFORE INSERT ON "merchant_reviews"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."images") THEN NEW."images" ELSE json_array(NEW."images") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_merchant_reviews_update BEFORE UPDATE OF "images" ON "merchant_reviews"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."images") THEN NEW."images" ELSE json_array(NEW."images") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_community_complaint_messages_insert BEFORE INSERT ON "community_complaint_messages"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."file_key") THEN NEW."file_key" ELSE json_array(NEW."file_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_community_complaint_messages_update BEFORE UPDATE OF "file_key" ON "community_complaint_messages"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."file_key") THEN NEW."file_key" ELSE json_array(NEW."file_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_bundles_insert BEFORE INSERT ON "bundles"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image") THEN NEW."image" ELSE json_array(NEW."image") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_bundles_update BEFORE UPDATE OF "image" ON "bundles"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image") THEN NEW."image" ELSE json_array(NEW."image") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_merchant_services_insert BEFORE INSERT ON "merchant_services"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image_key") THEN NEW."image_key" ELSE json_array(NEW."image_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_merchant_services_update BEFORE UPDATE OF "image_key" ON "merchant_services"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image_key") THEN NEW."image_key" ELSE json_array(NEW."image_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_merchant_showcase_insert BEFORE INSERT ON "merchant_showcase"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image_key") THEN NEW."image_key" ELSE json_array(NEW."image_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_merchant_showcase_update BEFORE UPDATE OF "image_key" ON "merchant_showcase"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image_key") THEN NEW."image_key" ELSE json_array(NEW."image_key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_warranty_receipts_insert BEFORE INSERT ON "warranty_receipts"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."coverage_text") THEN NEW."coverage_text" ELSE json_array(NEW."coverage_text") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."coverage_text_en") THEN NEW."coverage_text_en" ELSE json_array(NEW."coverage_text_en") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_warranty_receipts_update BEFORE UPDATE OF "coverage_text","coverage_text_en" ON "warranty_receipts"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."coverage_text") THEN NEW."coverage_text" ELSE json_array(NEW."coverage_text") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."coverage_text_en") THEN NEW."coverage_text_en" ELSE json_array(NEW."coverage_text_en") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_merchant_printers_insert BEFORE INSERT ON "merchant_printers"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."colors") THEN NEW."colors" ELSE json_array(NEW."colors") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_merchant_printers_update BEFORE UPDATE OF "colors" ON "merchant_printers"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."colors") THEN NEW."colors" ELSE json_array(NEW."colors") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_merchant_request_prefs_insert BEFORE INSERT ON "merchant_request_prefs"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."colors") THEN NEW."colors" ELSE json_array(NEW."colors") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_merchant_request_prefs_update BEFORE UPDATE OF "colors" ON "merchant_request_prefs"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."colors") THEN NEW."colors" ELSE json_array(NEW."colors") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_community_print_requests_insert BEFORE INSERT ON "community_print_requests"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."colors_count") THEN NEW."colors_count" ELSE json_array(NEW."colors_count") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."primary_file_id") THEN NEW."primary_file_id" ELSE json_array(NEW."primary_file_id") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."source_url") THEN NEW."source_url" ELSE json_array(NEW."source_url") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_community_print_requests_update BEFORE UPDATE OF "colors_count","primary_file_id","source_url" ON "community_print_requests"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."colors_count") THEN NEW."colors_count" ELSE json_array(NEW."colors_count") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."primary_file_id") THEN NEW."primary_file_id" ELSE json_array(NEW."primary_file_id") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."source_url") THEN NEW."source_url" ELSE json_array(NEW."source_url") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_model_view_tokens_insert BEFORE INSERT ON "model_view_tokens"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."file_id") THEN NEW."file_id" ELSE json_array(NEW."file_id") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_model_view_tokens_update BEFORE UPDATE OF "file_id" ON "model_view_tokens"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."file_id") THEN NEW."file_id" ELSE json_array(NEW."file_id") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_farm_jobs_insert BEFORE INSERT ON "farm_jobs"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."colors_json") THEN NEW."colors_json" ELSE json_array(NEW."colors_json") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_farm_jobs_update BEFORE UPDATE OF "colors_json" ON "farm_jobs"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."colors_json") THEN NEW."colors_json" ELSE json_array(NEW."colors_json") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_farm_achievements_insert BEFORE INSERT ON "farm_achievements"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."key") THEN NEW."key" ELSE json_array(NEW."key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_farm_achievements_update BEFORE UPDATE OF "key" ON "farm_achievements"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."key") THEN NEW."key" ELSE json_array(NEW."key") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_product_option_fulfillment_insert BEFORE INSERT ON "product_option_fulfillment"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image") THEN NEW."image" ELSE json_array(NEW."image") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_product_option_fulfillment_update BEFORE UPDATE OF "image" ON "product_option_fulfillment"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image") THEN NEW."image" ELSE json_array(NEW."image") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_product_option_aliases_insert BEFORE INSERT ON "product_option_aliases"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."legacy_snapshot") THEN NEW."legacy_snapshot" ELSE json_array(NEW."legacy_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_product_option_aliases_update BEFORE UPDATE OF "legacy_snapshot" ON "product_option_aliases"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."legacy_snapshot") THEN NEW."legacy_snapshot" ELSE json_array(NEW."legacy_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_reviews_insert BEFORE INSERT ON "reviews"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."media") THEN NEW."media" ELSE json_array(NEW."media") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_reviews_update BEFORE UPDATE OF "media" ON "reviews"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."media") THEN NEW."media" ELSE json_array(NEW."media") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_mystery_allocations_insert BEFORE INSERT ON "mystery_allocations"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."name_snapshot") THEN NEW."name_snapshot" ELSE json_array(NEW."name_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image_snapshot") THEN NEW."image_snapshot" ELSE json_array(NEW."image_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."variant_snapshot") THEN NEW."variant_snapshot" ELSE json_array(NEW."variant_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."reveal_stage_snapshot") THEN NEW."reveal_stage_snapshot" ELSE json_array(NEW."reveal_stage_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS media_lock_mystery_allocations_update BEFORE UPDATE OF "name_snapshot","image_snapshot","variant_snapshot","reveal_stage_snapshot" ON "mystery_allocations"
WHEN EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."name_snapshot") THEN NEW."name_snapshot" ELSE json_array(NEW."name_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."image_snapshot") THEN NEW."image_snapshot" ELSE json_array(NEW."image_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."variant_snapshot") THEN NEW."variant_snapshot" ELSE json_array(NEW."variant_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text') OR
 EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(NEW."reveal_stage_snapshot") THEN NEW."reveal_stage_snapshot" ELSE json_array(NEW."reveal_stage_snapshot") END) scalar JOIN media_cleanup_locks locked ON scalar.value=locked.object_key OR scalar.value='/files/'||locked.object_key OR substr(scalar.value,1,length('/files/'||locked.object_key)+1)='/files/'||locked.object_key||'?' OR ((scalar.value LIKE 'https://%' OR scalar.value LIKE 'http://%') AND (substr(scalar.value,-length('/files/'||locked.object_key))='/files/'||locked.object_key OR instr(scalar.value,'/files/'||locked.object_key||'?')>0)) WHERE scalar.type='text')
BEGIN SELECT RAISE(ABORT,'MEDIA_KEY_DELETING_OR_DELETED'); END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_bundle_component_choices_insert AFTER INSERT ON "bundle_component_choices"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_bundle_component_choices_update AFTER UPDATE ON "bundle_component_choices"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_bundle_component_choices_delete AFTER DELETE ON "bundle_component_choices"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_bundle_components_insert AFTER INSERT ON "bundle_components"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_bundle_components_update AFTER UPDATE ON "bundle_components"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_bundle_components_delete AFTER DELETE ON "bundle_components"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_bundle_config_insert AFTER INSERT ON "bundle_config"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_bundle_config_update AFTER UPDATE ON "bundle_config"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_bundle_config_delete AFTER DELETE ON "bundle_config"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_bundle_items_insert AFTER INSERT ON "bundle_items"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_bundle_items_update AFTER UPDATE ON "bundle_items"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_bundle_items_delete AFTER DELETE ON "bundle_items"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_cart_bundle_choices_insert AFTER INSERT ON "cart_bundle_choices"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_cart_bundle_choices_update AFTER UPDATE ON "cart_bundle_choices"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_cart_bundle_choices_delete AFTER DELETE ON "cart_bundle_choices"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_favorites_insert AFTER INSERT ON "favorites"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_favorites_update AFTER UPDATE ON "favorites"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_favorites_delete AFTER DELETE ON "favorites"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_media_cleanup_locks_insert AFTER INSERT ON "media_cleanup_locks"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_media_cleanup_locks_update AFTER UPDATE ON "media_cleanup_locks"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_media_cleanup_locks_delete AFTER DELETE ON "media_cleanup_locks"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_mystery_offer_secrets_insert AFTER INSERT ON "mystery_offer_secrets"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_mystery_offer_secrets_update AFTER UPDATE ON "mystery_offer_secrets"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_mystery_offer_secrets_delete AFTER DELETE ON "mystery_offer_secrets"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_mystery_offers_insert AFTER INSERT ON "mystery_offers"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_mystery_offers_update AFTER UPDATE ON "mystery_offers"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_mystery_offers_delete AFTER DELETE ON "mystery_offers"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_mystery_pool_entries_insert AFTER INSERT ON "mystery_pool_entries"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_mystery_pool_entries_update AFTER UPDATE ON "mystery_pool_entries"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_mystery_pool_entries_delete AFTER DELETE ON "mystery_pool_entries"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_offer_limits_insert AFTER INSERT ON "offer_limits"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_offer_limits_update AFTER UPDATE ON "offer_limits"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_offer_limits_delete AFTER DELETE ON "offer_limits"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_offer_windows_insert AFTER INSERT ON "offer_windows"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_offer_windows_update AFTER UPDATE ON "offer_windows"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_offer_windows_delete AFTER DELETE ON "offer_windows"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_catalogs_insert AFTER INSERT ON "product_catalogs"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_catalogs_update AFTER UPDATE ON "product_catalogs"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_catalogs_delete AFTER DELETE ON "product_catalogs"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_color_option_links_insert AFTER INSERT ON "product_color_option_links"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_color_option_links_update AFTER UPDATE ON "product_color_option_links"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_color_option_links_delete AFTER DELETE ON "product_color_option_links"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_colors_insert AFTER INSERT ON "product_colors"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_colors_update AFTER UPDATE ON "product_colors"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_colors_delete AFTER DELETE ON "product_colors"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_facets_insert AFTER INSERT ON "product_facets"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_facets_update AFTER UPDATE ON "product_facets"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_facets_delete AFTER DELETE ON "product_facets"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_images_insert AFTER INSERT ON "product_images"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_images_update AFTER UPDATE ON "product_images"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_images_delete AFTER DELETE ON "product_images"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_option_aliases_insert AFTER INSERT ON "product_option_aliases"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_option_aliases_update AFTER UPDATE ON "product_option_aliases"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_option_aliases_delete AFTER DELETE ON "product_option_aliases"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_option_fulfillment_insert AFTER INSERT ON "product_option_fulfillment"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_option_fulfillment_update AFTER UPDATE ON "product_option_fulfillment"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_option_fulfillment_delete AFTER DELETE ON "product_option_fulfillment"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_option_groups_insert AFTER INSERT ON "product_option_groups"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_option_groups_update AFTER UPDATE ON "product_option_groups"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_option_groups_delete AFTER DELETE ON "product_option_groups"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_option_transports_insert AFTER INSERT ON "product_option_transports"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_option_transports_update AFTER UPDATE ON "product_option_transports"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_option_transports_delete AFTER DELETE ON "product_option_transports"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_option_values_insert AFTER INSERT ON "product_option_values"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_option_values_update AFTER UPDATE ON "product_option_values"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_option_values_delete AFTER DELETE ON "product_option_values"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_translations_insert AFTER INSERT ON "product_translations"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_translations_update AFTER UPDATE ON "product_translations"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_translations_delete AFTER DELETE ON "product_translations"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_variants_insert AFTER INSERT ON "product_variants"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_variants_update AFTER UPDATE ON "product_variants"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_product_variants_delete AFTER DELETE ON "product_variants"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_products_insert AFTER INSERT ON "products"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_products_update AFTER UPDATE ON "products"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;

CREATE TRIGGER IF NOT EXISTS catalog_revision_products_delete AFTER DELETE ON "products"
BEGIN UPDATE catalog_revision SET revision=revision+1 WHERE id=1; END;
