import { TokenPasswordPage } from "@/components/auth/TokenPasswordPage";

export default function ResetPasswordPage() {
  return (
    <TokenPasswordPage
      endpoint="/api/auth/reset-password"
      title="Choose a new password"
      intro="Enter a new password for your account. You will be signed out on all devices."
      submitLabel="Reset password"
      busyLabel="Resetting..."
    />
  );
}
