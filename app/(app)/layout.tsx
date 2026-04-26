import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/server";
import { ensurePersonalWorkspace } from "@/lib/workspace";
import { AppSidebar } from "@/components/app-sidebar";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getAuthUser();
  if (!user) redirect("/login");

  await ensurePersonalWorkspace(user.id);

  return (
    <div className="flex h-screen">
      <AppSidebar user={user} />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
