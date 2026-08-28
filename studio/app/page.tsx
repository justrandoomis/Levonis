import SlicerClient from "./slicer-client";
import { getChatGPTUser } from "./chatgpt-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();
  return <SlicerClient user={user ? { displayName: user.displayName, email: user.email } : null} />;
}
