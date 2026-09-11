CREATE TABLE `project_files` (
	`id` text PRIMARY KEY NOT NULL,
	`revision_id` text NOT NULL,
	`kind` text NOT NULL,
	`r2_key` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`content_type` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `project_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_project_files_kind" CHECK("project_files"."kind" IN ('snapshot3mf','source','thumbnail','asset')),
	CONSTRAINT "chk_project_files_state" CHECK("project_files"."state" IN ('pending','verified'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_files_r2_key_unique` ON `project_files` (`r2_key`);--> statement-breakpoint
CREATE INDEX `idx_project_files_revision` ON `project_files` (`revision_id`);--> statement-breakpoint
CREATE INDEX `idx_project_files_state_created` ON `project_files` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `project_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`revision` integer NOT NULL,
	`parent_revision` integer,
	`schema_version` integer,
	`engine_version` text,
	`content_hash` text NOT NULL,
	`size_bytes` integer,
	`manifest_json` text NOT NULL,
	`snapshot_kind` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`committed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_project_revisions_snapshot_kind" CHECK("project_revisions"."snapshot_kind" IN ('full','source-only')),
	CONSTRAINT "chk_project_revisions_state" CHECK("project_revisions"."state" IN ('pending','committed','abandoned'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_project_revisions_project_revision` ON `project_revisions` (`project_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_project_revisions_state_created` ON `project_revisions` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`thumbnail_key` text,
	`schema_version` integer NOT NULL,
	`head_revision_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_saved_at` text,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_projects_owner_updated` ON `projects` (`owner_id`,`updated_at`);--> statement-breakpoint
-- studio_sessions is hand-adjusted to IF NOT EXISTS (tracked in db/schema.ts):
-- worker/auth/session.ts provisions this exact table idempotently at boot, so
-- a worker that served sign-ins before this migration ran must not fail it.
CREATE TABLE IF NOT EXISTS `studio_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`locale` text DEFAULT 'ar' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`expires_at` text NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_studio_sessions_user` ON `studio_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_studio_sessions_expires` ON `studio_sessions` (`expires_at`);