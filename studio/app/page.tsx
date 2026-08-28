import { getStudioUser } from "./studio-auth";
import EditorBoot from "./editor-boot";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getStudioUser();
  // Handoff identity is the minimum only (mandate §3): opaque id + display
  // name — no email, no phone. The id keys the client's draft namespace and
  // account project sync; guests stay null and keep editing locally.
  return <EditorBoot user={user ? { id: user.id, displayName: user.displayName } : null} />;
}
