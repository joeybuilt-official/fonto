import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/server";
import { ensurePersonalWorkspace } from "@/lib/workspace";
import { AppShell } from "@/components/app-shell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getAuthUser();
  if (!user) redirect("/login");

  await ensurePersonalWorkspace(user.id);

  return <AppShell user={user}>{children}</AppShell>;
}
