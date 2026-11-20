import { TokenPasswordPage } from "@/components/auth/TokenPasswordPage";

export default function ActivatePage() {
  return (
    <TokenPasswordPage
      endpoint="/api/auth/activate"
      title="Activate your account"
      intro="Set a password to activate your account."
      submitLabel="Activate account"
      busyLabel="Activating..."
    />
  );
}
