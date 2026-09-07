import { SignIn } from "@/components/sign-in";
import { demoEnabled } from "@/lib/server/service";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const query = await searchParams;
  const configured =
    demoEnabled() ||
    !!(
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
    );
  if (!configured) return <SignIn setup />;

  let notice: string | undefined;
  let noticeIsError = false;
  if (query.error === "invalid_link") {
    notice =
      "That link is invalid or has expired. Request a new password reset link, or ask Bryan to resend your invitation.";
    noticeIsError = true;
  } else if (query.error === "access_denied") {
    notice =
      "This workspace is invite-only. Use your invited email address or contact Bryan for access.";
    noticeIsError = true;
  } else if (query.password === "updated") {
    notice =
      "Your password is saved. Sign in with your email and new password.";
  }

  return <SignIn notice={notice} noticeIsError={noticeIsError} />;
}
